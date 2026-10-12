import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 with the same body shape as Nest's built-in exceptions. */
export class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message, error: 'Too Many Requests' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Prisma's unique-constraint violation (P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}
