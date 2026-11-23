import { dayIsClosed } from './acc-period';
import { log } from './admin';
import { teaches } from './office';
import { notifyTeachers } from './notifications';
import type { SalaryBasis, Settings } from './settings';
import { isYmd, parseDays, PAY_METHODS, parseTaka, weekday } from '../lib/offline';

// Teachers' leave and monthly salary sheets.
//
// Salary for a month: basic pay, minus a day's pay for each unpaid leave day,
// plus bonus, minus any other deduction. "A day" depends on the owner's
// setting: the teacher's class days in that month (from the routine), 30, or
// the days in the month. Approved leave up to the monthly allowance is paid;
// the rest, and leave approved as unpaid, is not. Money is whole taka.

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ---- Days ---------------------------------------------------------------------

export const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Every date from..to (inclusive), "YYYY-MM-DD". */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const monthDates = (month: string) => datesBetween(`${month}-01`, `${month}-${String(daysInMonth(month)).padStart(2, '0')}`);

/** Weekdays (0 = Sunday) on which the teacher has an active batch. */
export async function teacherWeekdays(db: D1Database, teacherId: string): Promise<Set<number>> {
  const { results } = await db
    .prepare(`SELECT b.days FROM offline_batches b WHERE ${teaches('?1')} AND b.status = 'active'`)
    .bind(teacherId)
    .all<{ days: string }>();
  return new Set(results.flatMap((r) => parseDays(r.days)));
}

/** The days a month's pay is divided by. With no routine, class days fall back to the month's days. */
export function workDays(basis: SalaryBasis, month: string, weekdays: Set<number>): number {
  if (basis === 'thirty') return 30;
  if (basis === 'class_days') {
    const n = monthDates(month).filter((d) => weekdays.has(weekday(d))).length;
    if (n > 0) return n;
  }
  return daysInMonth(month);
}

/** Which leave dates count: class days only for the class day basis (if there is a routine). */
const counts = (basis: SalaryBasis, weekdays: Set<number>) => (d: string) => basis !== 'class_days' || weekdays.size === 0 || weekdays.has(weekday(d));

// ---- Leave ---------------------------------------------------------------------

export type Leave = {
  id: string;
  teacherId: string;
  teacherName: string;
  fromDay: string;
  toDay: string;
  reason: string;
  kind: 'normal' | 'unpaid';
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  createdBy: string;
  createdAt: string;
};
type LeaveInput = { fromDay: string; toDay: string; reason: string };

export function parseLeaveForm(form: FormData): Result<LeaveInput> {
  const fromDay = String(form.get('fromDay') ?? '').trim();
  const toDay = String(form.get('toDay') ?? '').trim() || fromDay;
  if (!isYmd(fromDay) || !isYmd(toDay) || toDay < fromDay) return { ok: false, error: 'dates' };
  if (datesBetween(fromDay, toDay).length > 60) return { ok: false, error: 'too_long' };
  const reason = String(form.get('reason') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  if (reason.length < 2) return { ok: false, error: 'reason' };
  return { ok: true, value: { fromDay, toDay, reason } };
}

export async function requestLeave(db: D1Database, actor: string, teacherId: string, v: LeaveInput): Promise<string> {
  const id = newId('lv');
  await db.prepare('INSERT INTO leave_requests (id, teacher_id, from_day, to_day, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, teacherId, v.fromDay, v.toDay, v.reason, actor).run();
  await log(db, actor, 'leave.request', `teacher:${teacherId}`, { leaveId: id, from: v.fromDay, to: v.toDay });
  return id;
}

/** Approve (as paid within the allowance, or unpaid) or reject. Only pending leave can be decided. */
export async function decideLeave(
  db: D1Database,
  actor: string,
  id: string,
  decision: 'approved' | 'rejected',
  kind: 'normal' | 'unpaid',
  note: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE leave_requests SET status = ?, kind = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note = ?
       WHERE id = ? AND status = 'pending' RETURNING teacher_id AS teacherId`,
    )
    .bind(decision, kind, actor, note.trim().slice(0, 500), id)
    .first<{ teacherId: string }>();
  if (!r) return false;
  await log(db, actor, `leave.${decision}`, `teacher:${r.teacherId}`, { leaveId: id, kind });
  await notifyTeachers(db, actor, [r.teacherId], {
    title: decision === 'approved' ? 'ছুটির আবেদন অনুমোদিত হয়েছে' : 'ছুটির আবেদন মঞ্জুর হয়নি',
    body: note.trim().slice(0, 300),
    link: '/teacher/leave',
    sourceKey: `leave:${id}`,
  });
  return true;
}

/** A teacher takes back a request that has not been decided yet. */
export async function cancelLeave(db: D1Database, actor: string, id: string, teacherId: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND teacher_id = ? AND status = 'pending'`).bind(id, teacherId).run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'leave.cancel', `teacher:${teacherId}`, { leaveId: id });
  return true;
}

const LEAVE_SELECT = `SELECT l.id, l.teacher_id AS teacherId, t.name AS teacherName, l.from_day AS fromDay, l.to_day AS toDay, l.reason, l.kind, l.status,
  l.decided_by AS decidedBy, l.decided_at AS decidedAt, l.decision_note AS decisionNote, l.created_by AS createdBy, l.created_at AS createdAt
  FROM leave_requests l JOIN teachers t ON t.id = l.teacher_id`;

export async function listLeave(db: D1Database, opts: { teacherId?: string; status?: Leave['status']; limit?: number } = {}): Promise<Leave[]> {
  const where = [opts.teacherId ? 'l.teacher_id = ?' : '', opts.status ? 'l.status = ?' : ''].filter(Boolean);
  const { results } = await db
    .prepare(`${LEAVE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.status = 'pending' DESC, l.from_day DESC LIMIT ?`)
    .bind(...[opts.teacherId, opts.status].filter(Boolean), opts.limit ?? 200)
    .all<Leave>();
  return results;
}

export type LeaveCount = { leaveDays: number; paidLeaveDays: number; unpaidDays: number };

/** Pure: approved leave in a month split into paid and unpaid days. */
export function splitLeave(
  leaves: Pick<Leave, 'fromDay' | 'toDay' | 'kind'>[],
  month: string,
  allowance: number,
  include: (d: string) => boolean,
): LeaveCount {
  let paidLeft = allowance;
  const seen = new Set<string>();
  const out: LeaveCount = { leaveDays: 0, paidLeaveDays: 0, unpaidDays: 0 };
  for (const l of [...leaves].sort((a, b) => a.fromDay.localeCompare(b.fromDay))) {
    for (const d of datesBetween(l.fromDay, l.toDay)) {
      if (!d.startsWith(month) || seen.has(d) || !include(d)) continue;
      seen.add(d);
      out.leaveDays += 1;
      if (l.kind === 'normal' && paidLeft > 0) {
        paidLeft -= 1;
        out.paidLeaveDays += 1;
      } else out.unpaidDays += 1;
    }
  }
  return out;
}

// ---- Payroll -------------------------------------------------------------------

export type PayrollRow = {
  id: string;
  teacherId: string;
  teacherName: string;
  teacherPhone: string;
  month: string;
  basicMinor: number;
  workDays: number;
  leaveDays: number;
  paidLeaveDays: number;
  unpaidDays: number;
  deductionMinor: number;
  bonusMinor: number;
  otherDeductionMinor: number;
  netMinor: number;
  basis: SalaryBasis;
  note: string;
  status: 'draft' | 'approved' | 'paid';
  approvedBy: string | null;
  approvedAt: string | null;
  paidOn: string | null;
  paidMethod: string | null;
  expenseId: string | null;
};

/** Pure: a day's pay for each unpaid day, in whole taka, never below zero. */
export function salary(p: { basicMinor: number; workDays: number; unpaidDays: number; bonusMinor: number; otherDeductionMinor: number; basis: SalaryBasis }) {
  const deductionMinor = p.basis === 'none' || p.workDays <= 0 ? 0 : Math.min(p.basicMinor, Math.round((p.basicMinor * p.unpaidDays) / p.workDays / 100) * 100);
  return { deductionMinor, netMinor: Math.max(0, p.basicMinor - deductionMinor + p.bonusMinor - p.otherDeductionMinor) };
}

const PAYROLL_SELECT = `SELECT p.id, p.teacher_id AS teacherId, t.name AS teacherName, t.phone AS teacherPhone, p.month, p.basic_minor AS basicMinor,
  p.work_days AS workDays, p.leave_days AS leaveDays, p.paid_leave_days AS paidLeaveDays, p.unpaid_days AS unpaidDays, p.deduction_minor AS deductionMinor,
  p.bonus_minor AS bonusMinor, p.other_deduction_minor AS otherDeductionMinor, p.net_minor AS netMinor, p.basis, p.note, p.status,
  p.approved_by AS approvedBy, p.approved_at AS approvedAt, p.paid_on AS paidOn, p.paid_method AS paidMethod, p.expense_id AS expenseId
  FROM payroll p JOIN teachers t ON t.id = p.teacher_id`;

export async function listPayroll(db: D1Database, month: string): Promise<PayrollRow[]> {
  const { results } = await db.prepare(`${PAYROLL_SELECT} WHERE p.month = ? ORDER BY t.name`).bind(month).all<PayrollRow>();
  return results;
}

export async function payrollForTeacher(db: D1Database, teacherId: string): Promise<PayrollRow[]> {
  const { results } = await db.prepare(`${PAYROLL_SELECT} WHERE p.teacher_id = ? ORDER BY p.month DESC LIMIT 36`).bind(teacherId).all<PayrollRow>();
  return results;
}

export const getPayroll = (db: D1Database, id: string) => db.prepare(`${PAYROLL_SELECT} WHERE p.id = ?`).bind(id).first<PayrollRow>();

/** Days and deduction for one teacher and month from the routine, leave and settings. */
async function figuresFor(db: D1Database, teacherId: string, month: string, s: Settings) {
  const days = await teacherWeekdays(db, teacherId);
  const { results: leaves } = await db
    .prepare(`SELECT from_day AS fromDay, to_day AS toDay, kind FROM leave_requests WHERE teacher_id = ? AND status = 'approved' AND from_day <= ? AND to_day >= ?`)
    .bind(teacherId, `${month}-31`, `${month}-01`)
    .all<Pick<Leave, 'fromDay' | 'toDay' | 'kind'>>();
  return { workDays: workDays(s.salaryBasis, month, days), ...splitLeave(leaves, month, s.paidLeaveDays, counts(s.salaryBasis, days)) };
}

/**
 * Makes or refreshes the month's sheet: a row for every working teacher.
 * Draft rows are worked out again (keeping bonus, other deduction and note);
 * approved and paid rows are left as they are.
 */
export async function generatePayroll(db: D1Database, actor: string, month: string, s: Settings): Promise<number> {
  const { results: teachers } = await db.prepare(`SELECT id, basic_pay_minor AS basic FROM teachers WHERE status = 'active'`).all<{ id: string; basic: number }>();
  const existing = new Map((await listPayroll(db, month)).map((r) => [r.teacherId, r]));
  let n = 0;
  for (const t of teachers) {
    const before = existing.get(t.id);
    if (before && before.status !== 'draft') continue;
    const f = await figuresFor(db, t.id, month, s);
    const bonusMinor = before?.bonusMinor ?? 0;
    const otherDeductionMinor = before?.otherDeductionMinor ?? 0;
    const pay = salary({ basicMinor: t.basic, workDays: f.workDays, unpaidDays: f.unpaidDays, bonusMinor, otherDeductionMinor, basis: s.salaryBasis });
    await db
      .prepare(
        `INSERT INTO payroll (id, teacher_id, month, basic_minor, work_days, leave_days, paid_leave_days, unpaid_days, deduction_minor, bonus_minor,
           other_deduction_minor, net_minor, basis, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (teacher_id, month) DO UPDATE SET basic_minor = excluded.basic_minor, work_days = excluded.work_days, leave_days = excluded.leave_days,
           paid_leave_days = excluded.paid_leave_days, unpaid_days = excluded.unpaid_days, deduction_minor = excluded.deduction_minor,
           net_minor = excluded.net_minor, basis = excluded.basis, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE payroll.status = 'draft'`,
      )
      .bind(newId('pay'), t.id, month, t.basic, f.workDays, f.leaveDays, f.paidLeaveDays, f.unpaidDays, pay.deductionMinor, bonusMinor, otherDeductionMinor, pay.netMinor, s.salaryBasis, actor)
      .run();
    n += 1;
  }
  await log(db, actor, 'payroll.generate', `payroll:${month}`, { rows: n });
  return n;
}

/** Bonus, other deduction and note on a draft row; the total is worked out again. */
export async function editPayroll(db: D1Database, actor: string, id: string, form: FormData): Promise<boolean> {
  const row = await getPayroll(db, id);
  if (!row || row.status !== 'draft') return false;
  const bonus = String(form.get('bonus') ?? '').trim() === '' ? 0 : parseTaka(form.get('bonus'));
  const other = String(form.get('other') ?? '').trim() === '' ? 0 : parseTaka(form.get('other'));
  if (bonus === null || other === null) return false;
  const note = String(form.get('note') ?? '').trim().slice(0, 300);
  const pay = salary({ ...row, bonusMinor: bonus * 100, otherDeductionMinor: other * 100 });
  await db
    .prepare(
      `UPDATE payroll SET bonus_minor = ?, other_deduction_minor = ?, net_minor = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(bonus * 100, other * 100, pay.netMinor, note, id)
    .run();
  await log(db, actor, 'payroll.edit', `teacher:${row.teacherId}`, { payrollId: id, month: row.month, bonus, other });
  return true;
}

/** The owner approves draft rows of a month (all, or the ids given). */
export async function approvePayroll(db: D1Database, actor: string, month: string, ids?: string[]): Promise<number> {
  const only = ids?.length ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
  const r = await db
    .prepare(`UPDATE payroll SET status = 'approved', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE month = ? AND status = 'draft'${only}`)
    .bind(actor, month, ...(ids ?? []))
    .run();
  if (r.meta.changes) await log(db, actor, 'payroll.approve', `payroll:${month}`, { rows: r.meta.changes });
  return r.meta.changes;
}

/** Back to draft, before it is paid (to correct something). */
export async function reopenPayroll(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE payroll SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = ? AND status = 'approved'`).bind(id).run();
  if (r.meta.changes) await log(db, actor, 'payroll.reopen', `payroll:${id}`, {});
  return r.meta.changes > 0;
}

/**
 * Marks an approved row paid and writes the salary into the expenses, once.
 * Both happen in one transaction; the expense is added only if this step
 * moved the row to paid (its updated_at token), so two clicks add one expense.
 */
export async function payPayroll(db: D1Database, actor: string, id: string, paidOn: string, method: string, today: string): Promise<boolean> {
  if (!isYmd(paidOn) || paidOn > today || (await dayIsClosed(db, paidOn))) return false;
  const m = (PAY_METHODS as readonly string[]).includes(method) ? method : 'cash';
  const row = await getPayroll(db, id);
  if (!row || row.status !== 'approved') return false;
  const token = `${new Date().toISOString()}#${crypto.randomUUID().slice(0, 8)}`;
  const expenseId = row.netMinor > 0 ? newId('exp') : null;
  const [moved] = await db.batch([
    db
      .prepare(`UPDATE payroll SET status = 'paid', paid_on = ?, paid_method = ?, expense_id = ?, updated_at = ? WHERE id = ? AND status = 'approved'`)
      .bind(paidOn, m, expenseId, token, id),
    db
      .prepare(
        `INSERT INTO expenses (id, spent_on, category, amount_minor, description, method, recorded_by, status, decided_by, voucher_no, party)
         SELECT ?, ?, 'শিক্ষক বেতন', net_minor, ?, ?, ?, 'approved', ?, (SELECT coalesce(max(voucher_no), 0) + 1 FROM expenses),
                (SELECT name FROM teachers WHERE id = payroll.teacher_id) FROM payroll WHERE id = ? AND status = 'paid' AND updated_at = ? AND net_minor > 0`,
      )
      .bind(expenseId ?? newId('exp'), paidOn, `${row.teacherName}, ${row.month} মাসের বেতন`, m, actor, actor, id, token),
  ]);
  if (!moved?.meta.changes) return false;
  await log(db, actor, 'payroll.paid', `teacher:${row.teacherId}`, { payrollId: id, month: row.month, net: row.netMinor / 100, expenseId });
  await notifyTeachers(db, actor, [row.teacherId], { title: `${row.month} মাসের বেতন দেওয়া হয়েছে`, link: '/teacher/salary', sourceKey: `salary:${id}` });
  return true;
}
