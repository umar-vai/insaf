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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// The export lists data before some of the tables it points to, so a restore
// creates every table first and loads the data second.
const lines = readFileSync(file, 'utf8').split('\n');
const schema = [];
const indexes = [];
const data = [];
let open = null;
for (const l of lines) {
  if (open) {
    open.push(l);
    if (l.trimEnd().endsWith(');')) (schema.push(open.join('\n')), (open = null));
  } else if (l.startsWith('CREATE TABLE')) l.trimEnd().endsWith(');') ? schema.push(l) : (open = [l]);
  else if (l.startsWith('CREATE')) indexes.push(l);
  else if (l.startsWith('INSERT')) data.push(l);
}
writeFileSync(`${file}.1-schema.sql`, `${[...schema, ...indexes].join('\n')}\n`);
writeFileSync(`${file}.2-data.sql`, `PRAGMA defer_foreign_keys=TRUE;\n${data.join('\n')}\n`);

const scratch = mkdtempSync(path.join(tmpdir(), 'd1-restore-'));
try {
  for (const part of ['1-schema', '2-data']) wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', scratch, '--file', `${file}.${part}.sql`]);
  const restored = counts(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', scratch, '--json', '--command', countSql]));
  const live = counts(wrangler(['d1', 'execute', 'DB', '--env', env, '--remote', '--json', '--command', countSql]));
  const fk = JSON.parse(((t) => t.slice(t.indexOf('[')))(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', scratch, '--json', '--command', 'PRAGMA foreign_key_check'])))[0].results;
  console.table(TABLES.map((t) => ({ table: t, live: live[t], restored: restored[t] })));
  const same = TABLES.every((t) => live[t] === restored[t]);
  console.log(same && fk.length === 0 ? 'Backup restores correctly.' : `PROBLEM: counts differ or ${fk.length} foreign key errors (the live data may have changed during the copy; run again).`);
  process.exitCode = same && fk.length === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
