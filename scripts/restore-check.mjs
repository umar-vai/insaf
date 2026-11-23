#!/usr/bin/env node
// Proves a downloaded nightly backup (a .sql file from the insaf-backups bucket)
// restores: it is loaded into a throwaway LOCAL database, then every table's row
// count is read back and foreign keys are checked. Touches nothing on Cloudflare.
//
//   node scripts/restore-check.mjs ../backup/2026-12-01.sql
//
// The file holds student and donor data: keep it private. A real restore into the
// live database is a separate step that needs the owner's approval (README, Backups).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/restore-check.mjs <backup.sql>');
  process.exit(2);
}
const wrangler = (args) => execFileSync('npx', ['wrangler', ...args, '--config', 'wrangler.jsonc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rows = (text) => JSON.parse(text.slice(text.indexOf('[')))[0].results;

// The export can list data before the tables it points to, so create every table
// first and load the data second (same split as scripts/backup-d1.mjs).
const lines = readFileSync(input, 'utf8').split('\n');
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
const scratch = mkdtempSync(path.join(tmpdir(), 'd1-restore-'));
try {
  writeFileSync(path.join(scratch, '1-schema.sql'), `${[...schema, ...indexes].join('\n')}\n`);
  writeFileSync(path.join(scratch, '2-data.sql'), `PRAGMA defer_foreign_keys=TRUE;\n${data.join('\n')}\n`);
  const db = path.join(scratch, 'db');
  for (const part of ['1-schema', '2-data']) wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', db, '--file', path.join(scratch, `${part}.sql`)]);
  const tables = rows(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', db, '--json', '--command', "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'"])).map((r) => r.name);
  const countSql = `SELECT ${tables.map((t) => `(SELECT count(*) FROM "${t}") AS "${t}"`).join(', ')}`;
  const counts = rows(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', db, '--json', '--command', countSql]))[0];
  const fk = rows(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', db, '--json', '--command', 'PRAGMA foreign_key_check']));
  // Each table's restored row count must equal the INSERT lines the file holds for it
  // (d1_migrations and sqlite_sequence are bookkeeping and not counted).
  const expected = {};
  for (const l of data) {
    const t = /^INSERT INTO "?([A-Za-z0-9_]+)"?/.exec(l)?.[1];
    if (t) expected[t] = (expected[t] ?? 0) + 1;
  }
  const report = tables.map((t) => ({ table: t, in_file: expected[t] ?? 0, restored: counts[t] }));
  const total = report.reduce((a, r) => a + r.restored, 0);
  const wrong = report.filter((r) => r.in_file !== r.restored);
  console.table(report.filter((r) => r.in_file || r.restored));
  const ok = fk.length === 0 && wrong.length === 0 && tables.length > 0;
  console.log(ok ? `Backup restores correctly: ${tables.length} tables, ${total} rows, every table matches the file, no foreign key errors.` : `PROBLEM: ${wrong.length} tables differ from the file, ${fk.length} foreign key errors.`);
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
