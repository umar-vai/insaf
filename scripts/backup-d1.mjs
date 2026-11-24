#!/usr/bin/env node
// Copies a Cloudflare D1 database to a file off Cloudflare, then proves the
// copy can be restored: it is loaded into a throwaway local database and its
// row counts are compared with the live ones. Reads only; never writes to D1.
//
//   node scripts/backup-d1.mjs --env production --out ../backup
//
// The file holds student data: keep it somewhere private (never in a public
// place). To restore for real, ask first; see README "Backups".

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { verifyD1Dump } from './restore-check.mjs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const env = arg('env', 'production');
const out = path.resolve(arg('out', '../backup'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(out, `d1-${env}-${stamp}.sql`);
mkdirSync(out, { recursive: true });

// On Windows npx is npx.cmd, which needs a shell, so quote any argument with spaces.
const win = process.platform === 'win32';
const quote = (a) => (win && /[\s()*,]/.test(a) ? `"${a}"` : a);
const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, '--config', 'wrangler.jsonc'].map(quote), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: win });
const TABLES = ['students', 'teachers', 'staff', 'offline_students', 'offline_courses', 'offline_batches', 'offline_enrollments', 'offline_payments', 'donations', 'funds', 'expenses', 'payroll'];
const countSql = `SELECT ${TABLES.map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(', ')}`;
const counts = (text) => JSON.parse(text.slice(text.indexOf('[')))[0].results[0];

console.log(`Exporting ${env} to ${file}`);
wrangler(['d1', 'export', 'DB', '--env', env, '--remote', '--output', file]);

const result = verifyD1Dump(readFileSync(file, 'utf8'));
const restored = Object.fromEntries(result.report.map((row) => [row.table, row.restored]));
const live = counts(wrangler(['d1', 'execute', 'DB', '--env', env, '--remote', '--json', '--command', countSql]));
console.table(TABLES.map((table) => ({ table, live: live[table], restored: restored[table] })));
const same = TABLES.every((table) => live[table] === restored[table]);
console.log(same && result.ok ? 'Backup restores correctly.' : 'PROBLEM: counts or integrity differ (the live data may have changed during the copy).');
process.exitCode = same && result.ok ? 0 : 1;
