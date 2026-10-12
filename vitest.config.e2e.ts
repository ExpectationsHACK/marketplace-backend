import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // One database file: run the suite serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./test.db',
      UPLOAD_DIR: './test-uploads',
      PRIVATE_UPLOAD_DIR: './test-private-uploads',
      OTP_DEV_ECHO: 'true',
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    },
  },
});
