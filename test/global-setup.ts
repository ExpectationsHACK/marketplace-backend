// Fresh, seeded SQLite database for every e2e run (never touches dev.db).
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export default function setup() {
  const env = { ...process.env, DATABASE_URL: 'file:./test.db' };
  for (const f of ['test.db', 'test.db-journal']) rmSync(f, { force: true });
  for (const dir of ['test-uploads', 'test-private-uploads']) rmSync(dir, { recursive: true, force: true });
  execSync('npx prisma migrate deploy', { env, stdio: 'ignore' });
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'ignore' });
}
