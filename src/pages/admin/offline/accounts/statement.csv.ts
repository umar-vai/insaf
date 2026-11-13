import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fundSummary, projectSummary, receiptsAndPayments } from '../../../../server/accounts';
import { statementRange } from '../../../../server/accounts-ledger';
import { todayDhaka, toCsv } from '../../../../lib/offline';

// The receipts and payments statement as a spreadsheet (amounts in taka).
export const GET: APIRoute = async ({ url }) => {
  const { from, to } = statementRange(url.searchParams, todayDhaka());
  const [s, funds, projects] = await Promise.all([receiptsAndPayments(env.DB, from, to), fundSummary(env.DB, from, to), projectSummary(env.DB, from, to)]);
  const t = (m: number) => m / 100;
  const rows: unknown[][] = [['Receipts and payments', from, to], [], ['RECEIPTS', 'Taka'], ['Opening balance', t(s.openingMinor)]];
  for (const b of s.openingByAccount) rows.push([`  ${b.name}`, t(b.balanceMinor)]);
  if (s.newOpeningMinor) rows.push(['Opening balance of new accounts', t(s.newOpeningMinor)]);
  for (const r of s.receipts) rows.push([r.head, t(r.minor)]);
  rows.push(['Total receipts with opening', t(s.openingMinor + s.newOpeningMinor + s.receiptsMinor)], [], ['PAYMENTS', 'Taka']);
  for (const r of s.payments) rows.push([r.head, t(r.minor)]);
  rows.push(['Closing balance', t(s.closingMinor)]);
  for (const b of s.closingByAccount) rows.push([`  ${b.name}`, t(b.balanceMinor)]);
  rows.push(['Total payments with closing', t(s.paymentsMinor + s.closingMinor)], [], ['FUND', 'In', 'Out', 'Balance to date']);
  for (const f of funds) rows.push([f.name, t(f.inMinor), t(f.outMinor), t(f.balanceMinor)]);
  rows.push([], ['PROJECT', 'In', 'Out', 'Surplus']);
  for (const p of projects) rows.push([p.name, t(p.inMinor), t(p.outMinor), t(p.inMinor - p.outMinor)]);
  return new Response(toCsv(rows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="receipts-payments-${from}-${to}.csv"`, 'Cache-Control': 'private, no-store' },
  });
};
