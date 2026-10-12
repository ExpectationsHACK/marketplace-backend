import { Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Env } from '../config/env.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type Kind = { ext: 'jpg' | 'png' | 'webp' | 'pdf'; mime: string };

/** Detect the real type from the file's first bytes; the client's Content-Type is not trusted. */
export function sniff(buf: Buffer): Kind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

const MIME_BY_EXT: Record<Kind['ext'], string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

/** A stored file's name: a random UUID and its sniffed extension. Nothing a client chose. */
export const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

/**
 * Two kinds of file, kept apart on disk:
 * - Public photos (listings, products, avatars): JPEG, PNG or WebP, served
 *   to anyone at /uploads/<name>.
 * - Private documents (ID cards, selfies): also PDF, stored outside the
 *   public folder and only ever streamed to moderators through the API.
 * PDFs are never public, so Sokoni's domain can't be used to host one.
 */
@Injectable()
export class FileStore {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private dir(which: 'public' | 'private') {
    return resolve(this.config.get(which === 'public' ? 'UPLOAD_DIR' : 'PRIVATE_UPLOAD_DIR', { infer: true }));
  }

  private async save(which: 'public' | 'private', buf: Buffer, allowed: Kind['ext'][], refusal: string) {
    const kind = sniff(buf);
    if (!kind || !allowed.includes(kind.ext)) throw new UnsupportedMediaTypeException(refusal);
    const dir = this.dir(which);
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}.${kind.ext}`;
    await writeFile(join(dir, name), buf);
    return { name, mimeType: kind.mime, size: buf.length };
  }

  /** A listing, product or profile photo. Returns its public path. */
  async savePublicImage(buf: Buffer) {
    const saved = await this.save('public', buf, ['jpg', 'png', 'webp'], 'Upload a JPEG, PNG or WebP photo');
    return { path: `/uploads/${saved.name}`, mimeType: saved.mimeType, size: saved.size };
  }

  /** An identity document (photo or PDF) or a selfie (photo). Returns a private storage key. */
  async savePrivateDocument(buf: Buffer, allowPdf: boolean) {
    const allowed: Kind['ext'][] = allowPdf ? ['jpg', 'png', 'webp', 'pdf'] : ['jpg', 'png', 'webp'];
    const saved = await this.save('private', buf, allowed, allowPdf ? 'Upload a JPEG, PNG or WebP photo, or a PDF' : 'Upload a JPEG, PNG or WebP photo');
    return saved.name;
  }

  async readPrivate(key: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!STORED_NAME.test(key)) throw new NotFoundException('File not found');
    try {
      const data = await readFile(join(this.dir('private'), key));
      return { data, mimeType: MIME_BY_EXT[key.split('.').pop() as Kind['ext']] };
    } catch {
      throw new NotFoundException('File not found');
    }
  }
}
