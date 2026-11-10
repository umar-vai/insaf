import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { allEnrollments, monthReport } from '../../../../server/offline';
import { expensesBetween } from '../../../../server/office';
import { METHOD_BN, OFFLINE_ENROLL_STATUS_BN, planBn, studentCode, todayDhaka, toCsv, type PayMethod } from '../../../../lib/offline';

// Excel friendly CSV (UTF-8 with BOM so Bangla shows correctly).
// /admin/offline/export/students.csv  one row per enrollment with balance
// /admin/offline/export/payments.csv  payments, optionally ?m=YYYY-MM
// /admin/offline/export/pnl.csv       one month's income and expenses, ?m=YYYY-MM

const tk = (minor: number) => minor / 100;

export const GET: APIRoute = async ({ params, url }) => {
  const today = todayDhaka();
  let rows: unknown[][];
  let name: string;
  if (params.kind === 'students.csv') {
    const list = await allEnrollments(env.DB, today);
    rows = [
      ['ID', 'Name', 'Phone', 'Course', 'Batch', 'Roll', 'Start', 'Plan', 'Status', 'Total (Tk)', 'Paid (Tk)', 'Due (Tk)', 'Overdue (Tk)', 'Next due date', 'Next due (Tk)'],
      ...list.map((e) => [
        studentCode(e.studentNo),
        e.studentName,
        e.studentPhone,
        e.courseTitle,
        e.batch,
        e.roll,
        e.startDate,
        planBn(e.planMonths),
        OFFLINE_ENROLL_STATUS_BN[e.status],
        tk(e.ledger.totalMinor),
        tk(e.ledger.paidMinor),
        tk(e.ledger.dueMinor),
        tk(e.ledger.overdueMinor),
        e.ledger.next?.dueDate ?? '',
        e.ledger.next ? tk(e.ledger.next.amountMinor) : '',
      ]),
    ];
    name = `offline-students-${today}.csv`;
  } else if (params.kind === 'payments.csv') {
    const m = url.searchParams.get('m') ?? '';
    const month = /^\d{4}-\d{2}$/.test(m) ? m : '';
    const r = await monthReport(env.DB, month || '____-__');
    rows = [
      ['Receipt', 'Date', 'Student', 'Phone', 'Course', 'Amount (Tk)', 'Method', 'Reference', 'Note', 'Recorded by', 'Voided', 'Void reason'],
      ...r.payments.map((p) => [
        p.receiptNo,
        p.paidOn,
        p.studentName,
        p.studentPhone,
        p.courseTitle,
        tk(p.amountMinor),
        METHOD_BN[p.method],
        p.reference,
        p.note,
        p.recordedBy,
        p.voidedAt ? 'yes' : '',
        p.voidReason ?? '',
      ]),
    ];
    name = `offline-payments-${month || 'all'}.csv`;
  } else if (params.kind === 'pnl.csv') {
    const m = url.searchParams.get('m') ?? '';
    const month = /^\d{4}-\d{2}$/.test(m) ? m : today.slice(0, 7);
    const [income, spent] = await Promise.all([monthReport(env.DB, month), expensesBetween(env.DB, `${month}-01`, `${month}-31`)]);
    rows = [
      ['Type', 'Date', 'Head', 'Detail', 'Method', 'Amount (Tk)'],
      ...income.payments.filter((p) => !p.voidedAt).map((p) => ['Income', p.paidOn, p.courseTitle, `${p.studentName} (receipt ${p.receiptNo})`, METHOD_BN[p.method], tk(p.amountMinor)]),
      ...spent.expenses.filter((e) => !e.voidedAt && e.status === 'approved').map((e) => ['Expense', e.spentOn, e.category, e.description, METHOD_BN[e.method as PayMethod] ?? e.method, -tk(e.amountMinor)]),
      [],
      ['Total income', '', '', '', '', tk(income.totalMinor)],
      ['Total expense', '', '', '', '', -tk(spent.totalMinor)],
      ['Net', '', '', '', '', tk(income.totalMinor - spent.totalMinor)],
    ];
    name = `offline-income-expense-${month}.csv`;
  } else {
    return new Response('Not found', { status: 404 });
  }
  return new Response(toCsv(rows), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` },
  });
};
