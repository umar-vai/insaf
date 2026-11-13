import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ledgerView } from '../../../../server/accounts-ledger';
import { todayDhaka, toCsv } from '../../../../lib/offline';

// The ledger page as a spreadsheet (amounts in taka).
export const GET: APIRoute = async ({ url }) => {
  const v = await ledgerView(env.DB, url.searchParams, todayDhaka());
  const rows: unknown[][] = [[v.title], [`${v.from} to ${v.to}`], [], ['Date', 'Number', 'Type', 'Head', 'Details', 'Account', 'In', 'Out', 'Balance']];
  if (v.opening !== null) rows.push(['', '', '', 'Opening balance', '', '', '', '', v.opening / 100]);
  for (const r of v.rows) rows.push([r.day, r.ref, r.source, r.head, r.party, r.accountName, r.inMinor / 100 || '', r.outMinor / 100 || '', v.opening !== null ? r.balance / 100 : '']);
  rows.push(['', '', '', 'Total', '', '', v.inMinor / 100, v.outMinor / 100, v.opening !== null ? (v.opening + v.inMinor - v.outMinor) / 100 : '']);
  return new Response(toCsv(rows), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ledger-${v.from}-${v.to}.csv"`, 'Cache-Control': 'private, no-store' },
  });
};
