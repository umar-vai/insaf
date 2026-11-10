import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { profitAndLoss } from '../../../server/office';
import { isYmd, todayDhaka, toCsv } from '../../../lib/offline';

// Income and expense statement for a date range (?from=&to=), for Excel.
export const GET: APIRoute = async ({ url }) => {
  const today = todayDhaka();
  const from = isYmd(url.searchParams.get('from') ?? '') ? url.searchParams.get('from')! : `${today.slice(0, 7)}-01`;
  const to = isYmd(url.searchParams.get('to') ?? '') ? url.searchParams.get('to')! : today;
  const r = await profitAndLoss(env.DB, from, to);
  const tk = (minor: number) => minor / 100;
  const income = r.onlineMinor + r.offlineMinor;
  const rows: unknown[][] = [
    ['Madrasatul Insaf income and expense statement', `${from} to ${to}`],
    [],
    ['INCOME', 'Amount (Tk)'],
    ['Online course sales', tk(r.onlineMinor)],
    ...r.onlineByCourse.map((c) => [`  ${c.label}`, tk(c.totalMinor)]),
    ['Offline course fees', tk(r.offlineMinor)],
    ...r.offlineByCourse.map((c) => [`  ${c.label}`, tk(c.totalMinor)]),
    ['Total income', tk(income)],
    [],
    ['EXPENSES', ''],
    ...r.expensesByCategory.map((c) => [`  ${c.label}`, tk(c.totalMinor)]),
    ['Total expenses', tk(r.expenseMinor)],
    [],
    ['NET PROFIT', tk(income - r.expenseMinor)],
  ];
  return new Response(toCsv(rows), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="income-expense-${from}-to-${to}.csv"` },
  });
};
