import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQueryDto {
  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Items per page (max 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}

export function pageArgs(q: PageQueryDto) {
  return { skip: (q.page - 1) * q.limit, take: q.limit };
}

/**
 * A photo uploaded to Sokoni: the `path` POST /uploads returned. Nothing
 * else: third-party URLs would let listings carry tracking pixels or
 * mixed content, and PDFs are never public.
 */
export const IMAGE_URL_PATTERN = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
