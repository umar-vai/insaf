import { log } from './admin';
import { listAccounts, transactions, type Txn } from './accounts';
import { addDays, isYmd } from '../lib/offline';
import type { Result } from './ops-util';

const MAX_ROWS = 100;
type Line = { day: string; reference: string; amountMinor: number };
type Match = Line & { state: 'match' | 'duplicate' | 'missing' | 'ambiguous' | 'cleared'; txn?: Txn };

function amountMinor(value: string): number | null {
  const normalized = value.trim().replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(normalized);
  return normalized === '' ? 0 : match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}

export function parseBankStatement(raw: string, today: string): Result<Line[]> {
  if (raw.length > 16_000) return { ok: false, error: 'size' };
  const [header, ...rows] = raw.replace(/^\uFEFF/, '').split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const cells = (row: string) => row.split(',').map((cell) => cell.trim().replace(/^"([^"]*)"$/, '$1'));
  if (!header || cells(header.toLowerCase()).join(',') !== 'date,reference,credit,debit') return { ok: false, error: 'header' };
  if (!rows.length || rows.length > MAX_ROWS) return { ok: false, error: 'size' };
  const lines: Line[] = [];
  for (const row of rows) {
    const fields = cells(row);
    const [day, reference, credit, debit] = fields;
    if (fields.length !== 4 || !day || !reference || !isYmd(day) || day > today || day < '2000-01-01' ||
        new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || !/^[\p{L}\p{N}._:/ -]{1,80}$/u.test(reference)) return { ok: false, error: 'row' };
    const incoming = amountMinor(credit!);
    const outgoing = amountMinor(debit!);
    if (incoming === null || outgoing === null || Boolean(incoming) === Boolean(outgoing)) return { ok: false, error: 'row' };
    lines.push({ day, reference: reference.toUpperCase(), amountMinor: incoming - outgoing });
  }
  const days = lines.map((l) => l.day).sort();
  if (days.at(-1)! > addDays(days[0]!, 92)) return { ok: false, error: 'range' };
  return { ok: true, value: lines };
}

const code = (t: Txn) => `${t.source}:${t.id}`;
export const statementLineKey = (l: Match) => JSON.stringify([l.day, l.reference, l.amountMinor, l.txn ? code(l.txn) : '']);

export async function matchBankStatement(db: D1Database, accountId: string, lines: readonly Line[]): Promise<Result<Match[]>> {
  if (!(await listAccounts(db)).some((a) => a.id === accountId && (a.kind === 'bank' || a.kind === 'mobile'))) return { ok: false, error: 'account' };
  const days = lines.map((l) => l.day).sort();
  const [txns, cleared] = await Promise.all([
    transactions(db, addDays(days[0]!, -15), days.at(-1)!, 20_000),
    db.prepare('SELECT source, txn_id AS id FROM acc_cleared_items WHERE account_id = ?').bind(accountId).all<{ source: Txn['source']; id: string }>(),
  ]);
  const already = new Set(cleared.results.map((l) => `${l.source}:${l.id}`));
  const byReference = new Map<string, Txn[]>();
  for (const t of txns) {
    if (t.accountId !== accountId) continue;
    const refs = new Set([t.statementReference?.trim().toUpperCase(), t.source === 'fee' ? '' : t.ref.toUpperCase()]);
    for (const ref of refs) {
      if (!ref) continue;
      const same = byReference.get(ref) ?? [];
      same.push(t);
      byReference.set(ref, same);
    }
  }
  const used = new Map<string, number>();
  const matches = lines.map((l): Match => {
    const options = (byReference.get(l.reference) ?? []).filter((t) => t.inMinor - t.outMinor === l.amountMinor && t.day <= l.day && t.day >= addDays(l.day, -15));
    if (!options.length) return { ...l, state: 'missing' };
    if (options.length > 1) return { ...l, state: 'ambiguous' };
    const txn = options[0]!;
    if (already.has(code(txn))) return { ...l, state: 'cleared', txn };
    used.set(code(txn), (used.get(code(txn)) ?? 0) + 1);
    return { ...l, state: 'match', txn };
  });
  return { ok: true, value: matches.map((m) => m.state === 'match' && used.get(code(m.txn!))! > 1 ? { ...m, state: 'duplicate' } : m) };
}

export async function saveBankStatement(db: D1Database, actor: string, accountId: string, lines: readonly Line[], selected: readonly string[]): Promise<Result<number>> {
  const matched = await matchBankStatement(db, accountId, lines);
  if (!matched.ok) return matched;
  const wanted = new Set(selected);
  const ready = matched.value.filter((line) => line.state === 'match' && wanted.has(statementLineKey(line)));
  if (!ready.length || ready.length !== wanted.size) return { ok: false, error: 'changed' };
  const statements = ready.map((line) => db.prepare(`INSERT INTO acc_cleared_items (account_id, source, txn_id, cleared_on, created_by, statement_reference, statement_amount_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(accountId, line.txn!.source, line.txn!.id, line.day, actor, line.reference, line.amountMinor));
  const changed = (await db.batch(statements)).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (changed) await log(db, actor, 'accounts.statement.clear', `account:${accountId}`, { changed, lines: ready.map((line) => ({ txn: code(line.txn!), day: line.day, reference: line.reference })) });
  return { ok: true, value: changed };
}
