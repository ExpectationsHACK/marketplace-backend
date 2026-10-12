import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TooManyRequestsException } from '../common/errors.js';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { OtpPurpose } from '../generated/prisma/enums.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

const CODE_TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_CODES_PER_HOUR = 5;

/**
 * One-time codes for login and phone verification. Codes are HMAC'd with
 * the JWT secret before storage, expire after 5 minutes, allow 5 attempts,
 * and are single-use. Delivery is pluggable: with no SMS provider configured
 * the code is written to the server log (and, in development only, echoed
 * back in the API response when OTP_DEV_ECHO=true).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('OTP');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private hash(code: string) {
    return createHmac('sha256', this.config.get('JWT_SECRET', { infer: true })).update(code).digest('hex');
  }

  async issue(phone: string, purpose: OtpPurpose): Promise<{ expiresInSeconds: number; devCode?: string }> {
    const recent = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000) } },
    });
    if (recent) throw new TooManyRequestsException(`Wait ${RESEND_COOLDOWN_SECONDS} seconds before asking for another code`);
    // Per number, not per IP: caps guessing (5 tries a code) and texts to someone else's phone,
    // however many addresses a caller rotates through.
    const lastHour = await this.prisma.otpCode.count({
      where: { phone, purpose, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (lastHour >= MAX_CODES_PER_HOUR) throw new TooManyRequestsException('Too many codes for this number. Try again in an hour.');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.otpCode.create({
      data: { phone, purpose, codeHash: this.hash(code), expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000) },
    });

    // No SMS provider is wired up yet; the log is the delivery channel.
    this.logger.log(`${purpose} code for ${phone}: ${code}`);
    return {
      expiresInSeconds: CODE_TTL_SECONDS,
      devCode: this.config.get('OTP_DEV_ECHO', { infer: true }) ? code : undefined,
    };
  }

  /** Consumes a valid code or throws. */
  async consume(phone: string, purpose: OtpPurpose, code: string): Promise<void> {
    const id = await this.check(phone, purpose, code);
    await this.prisma.otpCode.update({ where: { id }, data: { consumedAt: new Date() } });
  }

  /** Throws unless `code` is the live code for this phone, without using it up. A wrong guess still costs an attempt. */
  async check(phone: string, purpose: OtpPurpose, code: string): Promise<string> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('Code expired or not requested. Ask for a new one.');
    if (otp.attempts >= MAX_ATTEMPTS) throw new TooManyRequestsException('Too many wrong codes. Ask for a new one.');

    const expected = Buffer.from(otp.codeHash, 'hex');
    const actual = Buffer.from(this.hash(code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException('That code is not right');
    }
    return otp.id;
  }
}
