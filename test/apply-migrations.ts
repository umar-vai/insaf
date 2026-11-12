import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// TEST_MIGRATIONS is injected by vitest.config.ts, not part of the app's Env.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(env.DB, TEST_MIGRATIONS);

// Notifications point at students and teachers, which many test files delete
// between tests. Clear them first (setup file hooks run before each file's own).
import { beforeEach } from 'vitest';
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM portal_notifications').run();
});
