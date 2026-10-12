import { BadRequestException, Controller, Get, Global, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import { RequireAuth } from '../common/auth.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FileStore, MAX_UPLOAD_BYTES } from './file-store.js';

/** Multer settings shared by every upload route: one file, in memory, size-capped. */
export const singleFile = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly files: FileStore) {}

  /**
   * Upload one public photo (JPEG, PNG or WebP, max 5 MB) as multipart field
   * "file". Put the returned `path` in images[], logoUrl, coverUrl or avatarUrl.
   * ID documents don't come here: they go to /me/verification/*, privately.
   */
  @Post()
  @RequireAuth()
  @ApiBearerAuth()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @UseInterceptors(singleFile)
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Attach the file as multipart field "file"');
    return this.files.savePublicImage(file.buffer);
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness plus a database round-trip. */
  @Get()
  async health() {
    await this.prisma.$queryRawUnsafe('SELECT 1');
    return { status: 'ok', database: 'up', time: new Date().toISOString() };
  }
}

@Global()
@Module({
  controllers: [UploadsController, HealthController],
  providers: [FileStore],
  exports: [FileStore],
})
export class UploadsModule {}
