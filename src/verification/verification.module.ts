import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags, type ApiBodyOptions } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, RequireAuth, RequireRoles, type AuthUser } from '../common/auth.js';
import { toPublicUser } from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OtpService } from '../auth/otp.service.js';
import { FileStore } from '../uploads/file-store.js';
import { singleFile } from '../uploads/uploads.module.js';

export class ConfirmPhoneDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code: string;
}

export class ReviewVerificationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note?: string;
}

export class VerificationQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING';
}

enum DocumentKind {
  id = 'id',
  selfie = 'selfie',
}

const FILE_FIELD = { id: 'idDocumentKey', selfie: 'selfieKey' } as const;

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly files: FileStore,
  ) {}

  async status(user: AuthUser) {
    const [u, v] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { verified: true, phoneVerified: true } }),
      this.prisma.verification.findUnique({ where: { userId: user.id } }),
    ]);
    return {
      verified: u.verified,
      phoneVerified: u.phoneVerified,
      status: v?.status ?? 'NOT_STARTED',
      hasIdDocument: Boolean(v?.idDocumentKey),
      hasSelfie: Boolean(v?.selfieKey),
      submittedAt: v?.submittedAt?.toISOString(),
      reviewNote: v?.reviewNote ?? undefined,
    };
  }

  async requestPhoneCode(user: AuthUser) {
    const { phone } = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { phone: true } });
    const result = await this.otp.issue(phone, 'VERIFY_PHONE');
    return { sent: true, ...result };
  }

  async confirmPhone(user: AuthUser, code: string) {
    const { phone } = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { phone: true } });
    await this.otp.consume(phone, 'VERIFY_PHONE', code);
    await this.prisma.user.update({ where: { id: user.id }, data: { phoneVerified: true } });
    return this.status(user);
  }

  /** Only while there's something to change: not once verified, not while a moderator is looking. */
  private async assertEditable(userId: string) {
    const [u, v] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { verified: true } }),
      this.prisma.verification.findUnique({ where: { userId }, select: { status: true } }),
    ]);
    if (u.verified) throw new ConflictException('You are already verified');
    if (v?.status === 'PENDING') throw new ConflictException('Your documents are being reviewed');
  }

  /** Stores the ID document or selfie privately; it's only ever shown to moderators. */
  async saveDocument(user: AuthUser, kind: DocumentKind, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach the file as multipart field "file"');
    await this.assertEditable(user.id);
    const key = await this.files.savePrivateDocument(file.buffer, kind === DocumentKind.id);
    const field = FILE_FIELD[kind];
    await this.prisma.verification.upsert({
      where: { userId: user.id },
      create: { userId: user.id, [field]: key },
      update: { [field]: key },
    });
    return this.status(user);
  }

  async submit(user: AuthUser) {
    await this.assertEditable(user.id);
    const [u, v] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { phoneVerified: true } }),
      this.prisma.verification.findUnique({ where: { userId: user.id } }),
    ]);
    if (!u.phoneVerified) throw new BadRequestException('Confirm your phone number first');
    if (!v?.idDocumentKey || !v.selfieKey) throw new BadRequestException('Upload your ID and a selfie first');
    await this.prisma.verification.update({
      where: { userId: user.id },
      data: { status: 'PENDING', submittedAt: new Date(), reviewNote: null, reviewedAt: null },
    });
    return this.status(user);
  }

  // ---- moderation

  async queue(status: VerificationQueryDto['status']) {
    const rows = await this.prisma.verification.findMany({
      where: { status },
      include: { user: true },
      orderBy: { submittedAt: 'asc' },
    });
    const file = (userId: string, kind: DocumentKind) => `/api/admin/verifications/${encodeURIComponent(userId)}/files/${kind}`;
    return rows.map((v) => ({
      userId: v.userId,
      // Moderators see the phone they're checking the documents against.
      user: toPublicUser(v.user, true),
      status: v.status,
      idDocument: v.idDocumentKey ? file(v.userId, DocumentKind.id) : undefined,
      selfie: v.selfieKey ? file(v.userId, DocumentKind.selfie) : undefined,
      submittedAt: v.submittedAt?.toISOString(),
      reviewedAt: v.reviewedAt?.toISOString(),
      reviewNote: v.reviewNote ?? undefined,
    }));
  }

  async document(userId: string, kind: DocumentKind) {
    const v = await this.prisma.verification.findUnique({ where: { userId }, select: { idDocumentKey: true, selfieKey: true } });
    const key = v?.[FILE_FIELD[kind]];
    if (!key) throw new NotFoundException('No such document');
    return this.files.readPrivate(key);
  }

  async decide(userId: string, approve: boolean, note?: string) {
    const v = await this.prisma.verification.findUnique({ where: { userId } });
    if (!v || v.status !== 'PENDING') throw new NotFoundException('No pending verification for this user');
    await this.prisma.$transaction([
      this.prisma.verification.update({
        where: { userId },
        data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedAt: new Date(), reviewNote: note },
      }),
      this.prisma.user.update({ where: { id: userId }, data: { verified: approve } }),
      // A verified owner's shop shows the verified badge too.
      this.prisma.storefront.updateMany({ where: { ownerId: userId }, data: { isVerified: approve } }),
    ]);
    return { userId, status: approve ? 'APPROVED' : 'REJECTED' };
  }
}

const fileBody: ApiBodyOptions = {
  schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
};

@ApiTags('verification')
@ApiBearerAuth()
@RequireAuth()
@Controller('me/verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.verification.status(user);
  }

  /** Step 1: text a code to the account's phone. */
  @Post('phone/request')
  @HttpCode(200)
  requestPhone(@CurrentUser() user: AuthUser) {
    return this.verification.requestPhoneCode(user);
  }

  @Post('phone/confirm')
  @HttpCode(200)
  confirmPhone(@CurrentUser() user: AuthUser, @Body() dto: ConfirmPhoneDto) {
    return this.verification.confirmPhone(user, dto.code);
  }

  /** Step 2: a government ID (JPEG, PNG, WebP or PDF, max 5 MB), multipart field "file". Stored privately. */
  @Post('id-document')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody)
  @UseInterceptors(singleFile)
  idDocument(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    return this.verification.saveDocument(user, DocumentKind.id, file);
  }

  /** Step 3: a selfie (JPEG, PNG or WebP), multipart field "file". Stored privately. */
  @Post('selfie')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody)
  @UseInterceptors(singleFile)
  selfie(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    return this.verification.saveDocument(user, DocumentKind.selfie, file);
  }

  /** Puts the request in front of a moderator. Needs a confirmed phone, the ID and the selfie. */
  @Post('submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser) {
    return this.verification.submit(user);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@RequireRoles('ADMIN', 'MODERATOR')
@Controller('admin/verifications')
export class AdminVerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  queue(@Query() q: VerificationQueryDto) {
    return this.verification.queue(q.status);
  }

  /** Streams a submitted document to a moderator. Never cached, never framed, never run. */
  @Get(':userId/files/:kind')
  async file(
    @Param('userId') userId: string,
    @Param('kind', new ParseEnumPipe(DocumentKind)) kind: DocumentKind,
    @Res() res: Response,
  ) {
    const { data, mimeType } = await this.verification.document(userId, kind);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.send(data);
  }

  @Post(':userId/approve')
  @HttpCode(200)
  approve(@Param('userId') userId: string, @Body() dto: ReviewVerificationDto) {
    return this.verification.decide(userId, true, dto.note);
  }

  @Post(':userId/reject')
  @HttpCode(200)
  reject(@Param('userId') userId: string, @Body() dto: ReviewVerificationDto) {
    return this.verification.decide(userId, false, dto.note);
  }
}

@Module({
  controllers: [VerificationController, AdminVerificationController],
  providers: [VerificationService],
})
export class VerificationModule {}
