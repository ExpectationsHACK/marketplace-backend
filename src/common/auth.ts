import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuthUser {
  id: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  role: Role;
}

type AuthedRequest = Request & { user?: AuthUser };

const AUTH_KEY = 'sokoni:auth';
const ROLES_KEY = 'sokoni:roles';

/** The route needs a signed-in user. */
export const RequireAuth = () => SetMetadata(AUTH_KEY, true);

/** The route needs a signed-in user with one of these roles (implies RequireAuth). */
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** The signed-in user, or undefined on a public route visited anonymously. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

/**
 * Global guard. Reads are public by default; a bearer token, when sent,
 * is always verified (a bad token is a 401, never silently anonymous) and
 * the user is re-read so deleted accounts and role changes take effect
 * immediately. Routes opt into requiring auth with @RequireAuth / @RequireRoles.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const required = Boolean(roles?.length) || Boolean(this.reflector.getAllAndOverride<boolean>(AUTH_KEY, targets));

    const header = req.headers.authorization;
    if (header) {
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Use "Authorization: Bearer <token>"');
      let payload: JwtPayload;
      try {
        payload = await this.jwt.verifyAsync<JwtPayload>(token);
      } catch {
        throw new UnauthorizedException('Invalid or expired token');
      }
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true } });
      if (!user) throw new UnauthorizedException('Account no longer exists');
      req.user = user;
    }

    if (required && !req.user) throw new UnauthorizedException('Sign in to do this');
    if (roles?.length && !roles.includes(req.user!.role)) throw new ForbiddenException('Not allowed');
    return true;
  }
}
