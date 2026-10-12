import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';

/**
 * One PrismaClient per process. SQLite via the better-sqlite3 driver adapter
 * in development; for PostgreSQL swap in @prisma/adapter-pg here and change
 * the datasource provider in prisma/schema.prisma.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({ adapter: new PrismaBetterSqlite3({ url: config.get('DATABASE_URL', { infer: true }) }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
