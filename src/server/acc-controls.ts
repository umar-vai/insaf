import { log } from './admin';
import { balancesAsOf, fundSummary, listFunds, projectSummary, transactions, type Txn } from './accounts';
import { COUNTED } from './donations';

// Controls on top of the books (migration 0007): the balance check on
// restricted funds, line by line clearing against a bank statement, and the
// consolidated report. The report only reads: donations stay on their side
// and are never written into the books from here.

/** Income moved over from the donation side by hand. Counted once in the consolidated report. */
export const MOVED_FROM_DONATIONS = 'দান তহবিল থেকে স্থানান্তর';

export type FundShort = { fundName: string; balanceMinor: number; shortMinor: number };

/** For a restricted fund (zakat, grants): how much this spending would go past its balance. Null when it fits. */
export async function restrictedFundShort(db: D1Database, fundId: string | null | undefined, amountMinor: number, today: string): Promise<FundShort | null> {
  if (!fundId) return null;
  const fund = (await listFunds(db, true)).find((f) => f.id === fundId);
  if (!fund?.restricted) return null;
  const row = (await fundSummary(db, today, today)).find((f) => f.id === fundId);
  const balanceMinor = row?.balanceMinor ?? 0;
  return amountMinor > balanceMinor ? { fundName: fund.name, balanceMinor, shortMinor: amountMinor - balanceMinor } : null;
}

// ---- Line by line clearing ----------------------------------------------------------

export type ClearingLine = Txn & { cleared: boolean };

export async function clearingView(db: D1Database, accountId: string, asOf: string) {
  const [txns, marks, balances] = await Promise.all([
    transactions(db, '0000-01-01', asOf, 20_000),
    db.prepare('SELECT source, txn_id AS id FROM acc_cleared_items WHERE account_id = ?').bind(accountId).all<{ source: string; id: string }>(),
    balancesAsOf(db, asOf),
  ]);
  const done = new Set(marks.results.map((m) => `${m.source}:${m.id}`));
  const lines: ClearingLine[] = txns.filter((t) => t.accountId === accountId).map((t) => ({ ...t, cleared: done.has(`${t.source}:${t.id}`) }));
  const open = lines.filter((l) => !l.cleared);
  const unclearedIn = open.reduce((a, l) => a + l.inMinor, 0);
  const unclearedOut = open.reduce((a, l) => a + l.outMinor, 0);
  const bookMinor = balances.find((b) => b.id === accountId)?.balanceMinor ?? 0;
  // What the statement should show if every uncleared line is only waiting to reach the bank.
  return { lines, unclearedIn, unclearedOut, bookMinor, expectedStatementMinor: bookMinor - unclearedIn + unclearedOut };
}

/** Saves which of the shown lines are on the statement. Lines not shown stay as they were. */
export async function saveClearing(db: D1Database, actor: string, accountId: string, shown: readonly string[], ticked: readonly string[], asOf: string): Promise<number> {
  const valid = /^(fee|income|expense|transfer):[\w-]{1,60}$/;
  const want = new Set(ticked.filter((t) => valid.test(t)));
  const lines = [...new Set(shown.filter((s) => valid.test(s)))];
  if (!lines.length) return 0;
  const split = (s: string) => [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)] as const;
  const stmts = lines.map((l) => {
    const [source, id] = split(l);
    return want.has(l)
      ? db.prepare('INSERT INTO acc_cleared_items (account_id, source, txn_id, cleared_on, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(accountId, source, id, asOf, actor)
      : db.prepare('DELETE FROM acc_cleared_items WHERE account_id = ? AND source = ? AND txn_id = ?').bind(accountId, source, id);
  });
  let changed = 0;
  for (let i = 0; i < stmts.length; i += 50) changed += (await db.batch(stmts.slice(i, i + 50))).reduce((a, r) => a + (r.meta.changes ?? 0), 0);
  if (changed) await log(db, actor, 'accounts.clear', `account:${accountId}`, { asOf, lines: lines.length, ticked: want.size, changed });
  return changed;
}

// ---- Consolidated report ---------------------------------------------------------------

export async function consolidatedReport(db: D1Database, from: string, to: string) {
  const dhakaDay = `substr(datetime(d.paid_at, '+6 hours'), 1, 10)`;
  const [gifts, txns, funds, projects] = await Promise.all([
    db
      .prepare(`SELECT f.title AS head, count(*) AS n, sum(d.amount_minor) AS minor FROM donations d JOIN funds f ON f.id = d.fund_id WHERE ${COUNTED} AND ${dhakaDay} BETWEEN ? AND ? GROUP BY f.id ORDER BY minor DESC`)
      .bind(from, to)
      .all<{ head: string; n: number; minor: number }>(),
    transactions(db, from, to, 100_000),
    fundSummary(db, from, to),
    projectSummary(db, from, to),
  ]);
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const feeHeads = new Map<string, number>();
  const otherHeads = new Map<string, number>();
  const spendHeads = new Map<string, number>();
  let movedMinor = 0;
  for (const t of txns) {
    if (t.source === 'fee') add(feeHeads, t.head, t.inMinor);
    else if (t.source === 'income') {
      if (t.head === MOVED_FROM_DONATIONS) movedMinor += t.inMinor;
      else add(otherHeads, t.head, t.inMinor);
    } else if (t.source === 'expense') add(spendHeads, t.head, t.outMinor);
  }
  const list = (m: Map<string, number>) => [...m.entries()].map(([head, minor]) => ({ head, minor })).sort((a, b) => b.minor - a.minor);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, v) => a + v, 0);
  const donationsMinor = gifts.results.reduce((a, g) => a + g.minor, 0);
  const feesMinor = sum(feeHeads);
  const otherMinor = sum(otherHeads);
  const expenseMinor = sum(spendHeads);
  // Money moved over from donations is already in donationsMinor, so it is not added again.
  const incomeMinor = donationsMinor + feesMinor + otherMinor;
  return {
    from,
    to,
    donations: gifts.results,
    fees: list(feeHeads),
    other: list(otherHeads),
    expenses: list(spendHeads),
    donationsMinor,
    feesMinor,
    otherMinor,
    movedMinor,
    expenseMinor,
    incomeMinor,
    netMinor: incomeMinor - expenseMinor,
    funds,
    projects,
  };
}
