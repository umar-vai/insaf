import { balancesAsOf, listAccounts, listFunds, listProjects, transactions, UNASSIGNED, type Txn } from './accounts';
import { addDays, addMonths, isYmd } from '../lib/offline';

// The cash book / fund ledger / project ledger view shared by the page and its CSV.

export const LEDGER_LIMIT = 3000;

export async function ledgerView(db: D1Database, p: URLSearchParams, today: string) {
  const from = isYmd(p.get('from') ?? '') ? p.get('from')! : `${today.slice(0, 7)}-01`;
  const toRaw = isYmd(p.get('to') ?? '') ? p.get('to')! : today;
  const to = toRaw < from ? from : toRaw;
  const filter = { account: (p.get('account') ?? '').slice(0, 40), fund: (p.get('fund') ?? '').slice(0, 40), project: (p.get('project') ?? '').slice(0, 40) };
  const [accounts, funds, projects, all] = await Promise.all([listAccounts(db), listFunds(db, true), listProjects(db, true), transactions(db, from, to, 50_000)]);
  const keep = (t: Txn) =>
    (!filter.account || t.accountId === filter.account) &&
    (!filter.fund || (t.source !== 'transfer' && t.fundId === filter.fund)) &&
    (!filter.project || (t.source !== 'transfer' && t.projectId === (filter.project === 'none' ? '' : filter.project)));
  const picked = all.filter(keep);
  // A running balance makes sense for one account (a cash book), or for all accounts together.
  const oneAccount = filter.account && !filter.fund && !filter.project;
  const everything = !filter.account && !filter.fund && !filter.project;
  let opening: number | null = null;
  if (oneAccount || everything) {
    const bal = await balancesAsOf(db, addDays(from, -1));
    opening = oneAccount ? (bal.find((b) => b.id === filter.account)?.balanceMinor ?? 0) : bal.reduce((a, b) => a + b.balanceMinor, 0);
    // Transfers move money inside the madrasa: they do not change the total.
  }
  const rowsAll = everything ? picked.filter((t) => t.source !== 'transfer') : picked;
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  names.set(UNASSIGNED, 'কোনো হিসাবে নয়');
  let running = opening ?? 0;
  const rows = rowsAll.slice(0, LEDGER_LIMIT).map((t) => {
    running += t.inMinor - t.outMinor;
    return { ...t, balance: running, accountName: names.get(t.accountId) ?? '' };
  });
  const inMinor = rowsAll.reduce((a, t) => a + t.inMinor, 0);
  const outMinor = rowsAll.reduce((a, t) => a + t.outMinor, 0);
  const title = oneAccount
    ? `ক্যাশবুক: ${names.get(filter.account) ?? ''}`
    : filter.fund
      ? `তহবিল লেজার: ${funds.find((f) => f.id === filter.fund)?.name ?? ''}`
      : filter.project
        ? `প্রকল্প লেজার: ${filter.project === 'none' ? 'কোনো প্রকল্পে নয়' : (projects.find((x) => x.id === filter.project)?.name ?? '')}`
        : 'ক্যাশবুক ও লেজার: সব হিসাব';
  return { from, to, filter, accounts, funds, projects, rows, opening, inMinor, outMinor, title, truncated: rowsAll.length > LEDGER_LIMIT };
}

/** The period of the statement: a preset (this month, last month, this year, last year) or two dates. */
export function statementRange(p: URLSearchParams, today: string): { from: string; to: string; preset: string } {
  const y = Number(today.slice(0, 4));
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastStart = addMonths(monthStart, -1);
  const presets: Record<string, [string, string]> = {
    month: [monthStart, today],
    last: [lastStart, addDays(monthStart, -1)],
    year: [`${y}-01-01`, today],
    lastyear: [`${y - 1}-01-01`, `${y - 1}-12-31`],
  };
  const preset = p.get('p') ?? '';
  if (presets[preset]) return { from: presets[preset]![0], to: presets[preset]![1], preset };
  const from = isYmd(p.get('from') ?? '') ? p.get('from')! : `${y}-01-01`;
  const toRaw = isYmd(p.get('to') ?? '') ? p.get('to')! : today;
  return { from, to: toRaw < from ? from : toRaw > today ? today : toRaw, preset: p.has('from') ? '' : 'year' };
}
