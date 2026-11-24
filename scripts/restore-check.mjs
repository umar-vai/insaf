#!/usr/bin/env node
// Run a downloaded D1 SQL dump in an isolated SQLite database. Keep the dump
// private. This script never opens the D1 database or an R2 connection.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const managedTable = (name) => /^sqlite_|^_cf_|^d1_migrations$/.test(name);
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';

export function verifyD1Dump(sql) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  try {
    // A native parser keeps multiline DDL, partial indexes and SQL string
    // literals intact. D1 dumps can contain rows before referenced tables.
    db.exec(sql);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
      .map((row) => row.name).filter((name) => !managedTable(name));
    const expected = new Map();
    // D1 exports one INSERT statement per exported row.
    for (const match of sql.matchAll(/^INSERT INTO\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z0-9_]+))\s+(?=VALUES|\()/gmi)) {
      const name = match.slice(1).find(Boolean);
      if (!managedTable(name)) expected.set(name, (expected.get(name) ?? 0) + 1);
    }
    const report = tables.map((table) => ({
      table, inFile: expected.get(table) ?? 0,
      restored: db.prepare(`SELECT count(*) AS n FROM ${identifier(table)}`).get().n,
    }));
    const missing = [...expected.keys()].filter((name) => !tables.includes(name));
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const wrong = missing.length + report.filter((row) => row.inFile !== row.restored).length;
    const total = report.reduce((sum, row) => sum + row.restored, 0);
    const integrityOk = integrity.length === 1 && Object.values(integrity[0])[0] === 'ok';
    return { ok: tables.length > 0 && wrong === 0 && !foreignKeys.length && integrityOk,
      report, total, wrong, foreignKeyErrors: foreignKeys.length, integrityOk };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/restore-check.mjs <backup.sql>');
    process.exitCode = 2;
  } else {
    try {
      const r = verifyD1Dump(readFileSync(input, 'utf8'));
      console.table(r.report.filter((row) => row.inFile || row.restored));
      console.log(r.ok
        ? `Backup restores correctly: ${r.report.length} tables, ${r.total} rows, no foreign key or integrity errors.`
        : `PROBLEM: ${r.wrong} table counts differ, ${r.foreignKeyErrors} foreign key errors, integrity ${r.integrityOk ? 'ok' : 'failed'}.`);
      if (!r.ok) process.exitCode = 1;
    } catch {
      console.error('Backup could not be loaded. Verify that the file is a complete D1 SQL export.');
      process.exitCode = 1;
    }
  }
}
