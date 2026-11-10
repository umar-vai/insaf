// Gives an owner (or anyone) a password for signing in with their email,
// for when Google sign-in is not set up yet. Writes a new random password
// to a file you choose (never to the screen or Git) and stores only its hash.
//
//   node scripts/set-password.mjs --email you@gmail.com --out ../owner-password.txt                     # local
//   node scripts/set-password.mjs --email you@gmail.com --out ../owner-password.txt --env production --remote
import { execFileSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email')?.trim().toLowerCase();
const out = arg('out');
if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) || !out) {
  console.error('Usage: node scripts/set-password.mjs --email <email> --out <file> [--env production --remote]');
  process.exit(1);
}

// Same format as src/server/password.ts: pbkdf2$rounds$salt$hash (SHA-256, base64).
const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
const password = Array.from(randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
const stored = `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;

const q = (s) => `'${s.replace(/'/g, "''")}'`;
const sql = `INSERT INTO students (id, email, password_hash) VALUES (${q(`stu_${randomUUID()}`)}, ${q(email)}, ${q(stored)})
  ON CONFLICT (lower(email)) DO UPDATE SET password_hash = excluded.password_hash;`;
const file = path.join(os.tmpdir(), `insaf-pw-${Date.now()}.sql`);
fs.writeFileSync(file, sql);
const env = arg('env');
const remote = process.argv.includes('--remote');
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--file', file, '--yes', remote ? '--remote' : '--local', ...(env ? ['--env', env] : [])], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
} finally {
  fs.rmSync(file, { force: true });
}
fs.writeFileSync(out, `Madrasatul Insaf sign in\nLogin: ${email}\nPassword: ${password}\nChange it after signing in (Profile).\n`, { mode: 0o600 });
console.log(`Password saved to ${path.resolve(out)}. Open it, sign in, then delete the file.`);
