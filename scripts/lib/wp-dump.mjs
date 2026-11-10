// Reads rows out of a phpMyAdmin SQL dump without running any of it.
import fs from 'node:fs';

function parseValues(s, i) {
  const rows = [];
  let row = null;
  let cur = '';
  let inStr = false;
  let quoted = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        const n = s[++i];
        cur += { n: '\n', r: '\r', t: '\t', 0: '\0' }[n] ?? n;
      } else if (c === "'") {
        if (s[i + 1] === "'") {
          cur += "'";
          i++;
        } else inStr = false;
      } else cur += c;
      continue;
    }
    if (c === "'") {
      inStr = true;
      quoted = true;
      cur = '';
    } else if (c === '(' && row === null) {
      row = [];
      cur = '';
      quoted = false;
    } else if ((c === ',' || c === ')') && row !== null) {
      const v = cur.trim();
      row.push(quoted ? cur : v === 'NULL' ? null : v);
      cur = '';
      quoted = false;
      if (c === ')') {
        rows.push(row);
        row = null;
      }
    } else if (c === ';' && row === null) return [rows, i];
    else if (row !== null) cur += c;
  }
  return [rows, i];
}

/** Returns { tableName: [rowObject, ...] } for the requested tables only. */
export function readTables(file, tables) {
  const sql = fs.readFileSync(file, 'utf8');
  const wanted = new Set(tables);
  const out = Object.fromEntries(tables.map((t) => [t, []]));
  const re = /INSERT INTO `([^`]+)` \(([^)]*)\) VALUES\s*/g;
  let m;
  while ((m = re.exec(sql))) {
    const [rows, end] = parseValues(sql, re.lastIndex);
    re.lastIndex = end;
    if (!wanted.has(m[1])) continue;
    const cols = m[2].split(',').map((c) => c.trim().replace(/`/g, ''));
    for (const r of rows) out[m[1]].push(Object.fromEntries(cols.map((c, k) => [c, r[k]])));
  }
  return out;
}
