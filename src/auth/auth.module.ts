import { Body, Controller, Global, HttpCode, Injectable, Module, Post, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { normalizePhone } from '../common/phone.js';
import { toMe, type MeUser } from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OtpService } from './otp.service.js';

export class RequestCodeDto {
  /** Phone number with country code, e.g. "+234 802 314 8890". */
  @IsString()
  @Matches(/^\+?[\d\s()-]{9,20}$/, { message: 'Enter the full number with country code' })
  phone: string;
}

export class VerifyCodeDto extends RequestCodeDto {
  /** The 6-digit code. */
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code: string;

  /** Required the first time a phone number signs in (creates the account). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;
}

export interface AuthResult {
  accessToken: string;
  tokenType: 'Bearer';
  isNewUser: boolean;
  user: MeUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly jwt: JwtService,
  ) {}

  requestCode(phone: string) {
    return this.otp.issue(normalizePhone(phone), 'LOGIN');
  }

  async verify(dto: VerifyCodeDto): Promise<AuthResult> {
    const phone = normalizePhone(dto.phone);
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (!existing && !dto.name) {
      // Check the code first (answering "name required" to any code would reveal which numbers
      // have accounts), but don't use it up: the person retries with the same code and a name.
      await this.otp.check(phone, 'LOGIN', dto.code);
      throw new UnprocessableEntityException({ code: 'NAME_REQUIRED', message: 'New here? Tell us your name to create your account.' });
    }
    await this.otp.consume(phone, 'LOGIN', dto.code);

    const user = existing
      ? await this.prisma.user.update({ where: { id: existing.id }, data: { phoneVerified: true } })
      : await this.prisma.user.create({ data: { phone, name: dto.name!.trim(), phoneVerified: true } });

    return {
      accessToken: await this.jwt.signAsync({ sub: user.id, role: user.role }),
      tokenType: 'Bearer',
      isNewUser: !existing,
      user: toMe(user),
    };
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Text a 6-digit sign-in code to this phone. */
  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async request(@Body() dto: RequestCodeDto) {
    const result = await this.auth.requestCode(dto.phone);
    return { sent: true, ...result };
  }

  /** Exchange the code for an access token. Creates the account on first sign-in. */
  @Post('otp/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@Body() dto: VerifyCodeDto): Promise<AuthResult> {
    return this.auth.verify(dto);
  }
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, OtpService],
  exports: [OtpService],
})
export class AuthModule {}
