import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv, type Env } from './config/env.js';
import { AuthGuard } from './common/auth.js';
import { PrismaModule } from './prisma/prisma.service.js';
import { AuthModule } from './auth/auth.module.js';
import { ListingsModule } from './listings/listings.module.js';
import { StorefrontsModule } from './storefronts/storefronts.module.js';
import { UsersModule } from './users/users.module.js';
import { SearchModule } from './search/search.module.js';
import { MeModule } from './me/me.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { VerificationModule } from './verification/verification.module.js';
import { UploadsModule } from './uploads/uploads.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', { infer: true }) as `${number}d` },
      }),
    }),
    // Generous default; sign-in endpoints tighten it with @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      // The e2e suite signs in several users per minute from one address.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    AuthModule,
    ListingsModule,
    StorefrontsModule,
    UsersModule,
    SearchModule,
    MeModule,
    ConversationsModule,
    VerificationModule,
    UploadsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
