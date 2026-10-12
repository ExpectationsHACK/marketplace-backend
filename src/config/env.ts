import { isAbsolute, relative, resolve } from 'node:path';

// Validated environment. Fails fast at boot with every problem listed,
// rather than at the first request that happens to need a missing value.

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  FRONTEND_ORIGIN: string;
  PUBLIC_BASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  OTP_DEV_ECHO: boolean;
  UPLOAD_DIR: string;
  /** ID documents and selfies: never served statically, only streamed to moderators. */
  PRIVATE_UPLOAD_DIR: string;
  /** Serve Swagger UI at /api/docs. Defaults to on, except in production. */
  SWAGGER_ENABLED: boolean;
  /** Express "trust proxy" setting: which hops may set X-Forwarded-For (the rate limiter keys on the client IP). */
  TRUST_PROXY: boolean | number | string;
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const errors: string[] = [];
  const str = (key: string, fallback?: string): string => {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (fallback !== undefined) return fallback;
    errors.push(`${key} is required`);
    return '';
  };

  const nodeEnv = str('NODE_ENV', 'development') as Env['NODE_ENV'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) errors.push('NODE_ENV must be development, test or production');

  const port = Number(str('PORT', '4000'));
  if (!Number.isInteger(port) || port <= 0) errors.push('PORT must be a positive integer');

  const jwtSecret = str('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) errors.push('JWT_SECRET must be at least 32 characters');

  const otpDevEcho = str('OTP_DEV_ECHO', 'false') === 'true';
  if (otpDevEcho && nodeEnv === 'production') errors.push('OTP_DEV_ECHO must be false in production');

  const env: Env = {
    NODE_ENV: nodeEnv,
    PORT: port,
    DATABASE_URL: str('DATABASE_URL'),
    FRONTEND_ORIGIN: str('FRONTEND_ORIGIN', 'http://localhost:3000'),
    PUBLIC_BASE_URL: str('PUBLIC_BASE_URL', `http://localhost:${port}`),
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: str('JWT_EXPIRES_IN', '7d'),
    OTP_DEV_ECHO: otpDevEcho,
    UPLOAD_DIR: str('UPLOAD_DIR', './uploads'),
    PRIVATE_UPLOAD_DIR: str('PRIVATE_UPLOAD_DIR', './private-uploads'),
    SWAGGER_ENABLED: str('SWAGGER_ENABLED', nodeEnv === 'production' ? 'false' : 'true') === 'true',
    TRUST_PROXY: parseTrustProxy(str('TRUST_PROXY', 'loopback')),
  };

  // Documents inside the public folder would be served to anyone.
  const inside = relative(resolve(env.UPLOAD_DIR), resolve(env.PRIVATE_UPLOAD_DIR));
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) {
    errors.push('PRIVATE_UPLOAD_DIR must not be UPLOAD_DIR or inside it');
  }

  if (errors.length) throw new Error(`Invalid environment:\n- ${errors.join('\n- ')}`);
  return env;
}

/** "true"/"false", a hop count, or Express's named ranges/IP list ("loopback", "10.0.0.0/8, loopback"). */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^d+$/.test(value)) return Number(value);
  return value;
}
