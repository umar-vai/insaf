// Wipes the local D1 database and re-applies migrations.
// Then run `npm run import:wp -- --dump ... --uploads ...` to load the catalog.
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

rmSync('.wrangler/state/v3/d1', { recursive: true, force: true });
execSync('npx wrangler d1 migrations apply DB --local', { stdio: 'inherit' });
