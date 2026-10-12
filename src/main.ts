import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

/** Shared by main() and the e2e tests so both run the same pipeline. */
export function configureApp(app: NestExpressApplication) {
  const config = app.get(ConfigService<Env, true>);
  // The web app's server calls this API on behalf of browsers and forwards their IP in
  // X-Forwarded-For; trusting only those hops keeps per-client rate limits honest.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  // Uploaded files: plain static files at /uploads (outside the /api prefix), never directory listings.
  const uploadDir = resolve(config.get('UPLOAD_DIR', { infer: true }));
  mkdirSync(uploadDir, { recursive: true });
  app.useStaticAssets(uploadDir, {
    prefix: '/uploads',
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
    // Photos only ever render as images: never sniffed into HTML, never able to run anything if opened directly.
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.get('FRONTEND_ORIGIN', { infer: true }).split(','), credentials: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const config = app.get(ConfigService<Env, true>);

  // Interactive docs are for development; production keeps the API surface unadvertised.
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const doc = new DocumentBuilder()
      .setTitle('Sokoni API')
      .setDescription('Marketplace API for classifieds and WhatsApp shops. See API.md for request and response examples.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc));
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`Sokoni API on http://localhost:${port}/api (docs: /api/docs)`, 'Bootstrap');
}

if (process.env.NODE_ENV !== 'test') await bootstrap();
