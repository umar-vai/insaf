import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { consolidatedReport } from '../../../server/acc-controls';
import { statementRange } from '../../../server/accounts-ledger';
import { todayDhaka, toCsv } from '../../../lib/offline';

// The consolidated report as a spreadsheet (amounts in taka).
export const GET: APIRoute = async ({ url }) => {
  const { from, to } = statementRange(url.searchParams, todayDhaka());
  const r = await consolidatedReport(env.DB, from, to);
  const t = (m: number) => m / 100;
  const rows: unknown[][] = [['Consolidated report', from, to], [], ['INCOME', 'Taka'], ['Donations', t(r.donationsMinor)]];
  for (const d of r.donations) rows.push([`  ${d.head}`, t(d.minor)]);
  rows.push(['Student fees', t(r.feesMinor)]);
  for (const d of r.fees) rows.push([`  ${d.head}`, t(d.minor)]);
  rows.push(['Other income', t(r.otherMinor)]);
  for (const d of r.other) rows.push([`  ${d.head}`, t(d.minor)]);
  rows.push(['Total income', t(r.incomeMinor)], ['Memo: moved from donations to the books (not added again)', t(r.movedMinor)], [], ['EXPENSES', 'Taka']);
  for (const d of r.expenses) rows.push([d.head, t(d.minor)]);
  rows.push(['Total expenses', t(r.expenseMinor)], ['Surplus or deficit', t(r.netMinor)], [], ['FUND (books)', 'In', 'Out', 'Balance to date']);
  for (const f of r.funds) rows.push([f.name, t(f.inMinor), t(f.outMinor), t(f.balanceMinor)]);
  rows.push([], ['PROJECT', 'In', 'Out', 'Surplus']);
  for (const x of r.projects) rows.push([x.name, t(x.inMinor), t(x.outMinor), t(x.inMinor - x.outMinor)]);
  return new Response(toCsv(rows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="consolidated-${from}-${to}.csv"`, 'Cache-Control': 'private, no-store' },
  });
};
