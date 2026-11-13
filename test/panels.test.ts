import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createOfflineCourse, createOfflineStudent, enrollOffline, getOfflineStudent } from '../src/server/offline';
import { parseBatchForm, saveBatch, saveTeacher } from '../src/server/office';
import {
  approvePayroll,
  datesBetween,
  decideLeave,
  generatePayroll,
  listPayroll,
  payPayroll,
  requestLeave,
  salary,
  splitLeave,
  workDays,
} from '../src/server/hr';
import { DEFAULTS, getSettings, parseSettingsForm, saveSettings } from '../src/server/settings';
import { applyFeeValidation, createFeePayment, feeChoices, markFeeUnpaid } from '../src/server/fee-pay';
import { batchForTeacher, materialFile, offlineIdsForEmail, studentPanel, teacherForEmail } from '../src/server/panels';
import { decideExpense, profitAndLoss, recordExpense } from '../src/server/office';
import { ratingTargets, submitRating, teacherRatings } from '../src/server/ratings';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-08';

beforeEach(async () => {
  await db.batch(
    [
      'teacher_ratings',
      'offline_online_payments',
      'batch_materials',
      'payroll',
      'leave_requests',
      'expenses',
      'settings',
      'offline_attendance',
      'offline_payments',
      'offline_enrollments',
      'offline_batches',
      'teachers',
      'offline_students',
      'offline_courses',
      'donation_events',
      'admin_events',
      'students',
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

const form = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

async function school() {
  const courseId = await createOfflineCourse(db, ACTOR, { title: 'Nazera', feeTaka: 6000, admissionTaka: 0, durationMonths: 6, note: '', status: 'active' });
  const teacherId = (await saveTeacher(db, ACTOR, null, {
    name: 'Ustaz', phone: '01811111111', email: 'Ustaz@Gmail.com', subject: '', basicPayMinor: 1_200_000, joinedOn: '', status: 'active', note: '',
  }))!;
  // Sunday and Tuesday: 9 class days in November 2026.
  const b = parseBatchForm(form({ courseId, name: 'B1', days: ['0', '2'], startTime: '16:00', endTime: '17:00', teacherId }));
  if (!b.ok) throw new Error(b.error);
  const batchId = (await saveBatch(db, ACTOR, null, b.value))!;
  const sid = await createOfflineStudent(db, ACTOR, { name: 'Amina', phone: '01711111111', guardianPhone: '', email: 'amina@gmail.com', address: '', note: '' });
  const eid = (await enrollOffline(db, ACTOR, sid, { courseId, batchId, roll: '1', startDate: '2026-09-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  await db.prepare(`INSERT INTO students (id, email, name) VALUES ('stu_a', 'amina@gmail.com', 'Amina'), ('stu_x', 'other@gmail.com', 'X')`).run();
  return { courseId, teacherId, batchId, sid, eid };
}

describe('settings', () => {
  it('uses defaults until changed and reads the form safely', async () => {
    expect(await getSettings(db)).toEqual(DEFAULTS);
    const s = parseSettingsForm(form({ paidLeaveDays: '৩', salaryBasis: 'thirty', onlineFees: 'on', dueTemplate: 'x' }));
    expect(s).toMatchObject({ paidLeaveDays: 3, salaryBasis: 'thirty', onlineFees: true, teacherSeesPhones: false });
    expect(parseSettingsForm(form({ paidLeaveDays: '99', salaryBasis: 'hack' }))).toMatchObject({ paidLeaveDays: 2, salaryBasis: 'class_days' });
    await saveSettings(db, ACTOR, s);
    expect(await getSettings(db)).toEqual(s);
  });
});

describe('leave and salary', () => {
  it('counts class days and splits leave into paid and unpaid', () => {
    const sunTue = new Set([0, 2]);
    expect(workDays('class_days', '2026-11', sunTue)).toBe(9);
    expect(workDays('class_days', '2026-11', new Set())).toBe(30);
    expect(workDays('thirty', '2026-02', sunTue)).toBe(30);
    expect(workDays('month_days', '2026-02', sunTue)).toBe(28);
    expect(datesBetween('2026-11-29', '2026-12-02')).toHaveLength(4);
    const classOnly = (d: string) => sunTue.has(new Date(`${d}T00:00:00Z`).getUTCDay());
    // 1-10 Nov: Sundays 1 and 8, Tuesdays 3 and 10 are class days.
    expect(splitLeave([{ fromDay: '2026-11-01', toDay: '2026-11-10', kind: 'normal' }], '2026-11', 2, classOnly)).toEqual({ leaveDays: 4, paidLeaveDays: 2, unpaidDays: 2 });
    expect(splitLeave([{ fromDay: '2026-11-01', toDay: '2026-11-03', kind: 'unpaid' }], '2026-11', 2, classOnly)).toEqual({ leaveDays: 2, paidLeaveDays: 0, unpaidDays: 2 });
    // Only the part inside the month counts.
    expect(splitLeave([{ fromDay: '2026-10-25', toDay: '2026-11-01', kind: 'normal' }], '2026-11', 0, () => true).leaveDays).toBe(1);
  });

  it('takes a day of pay per unpaid day, in whole taka, never below zero', () => {
    expect(salary({ basicMinor: 1_200_000, workDays: 9, unpaidDays: 2, bonusMinor: 50_000, otherDeductionMinor: 0, basis: 'class_days' })).toEqual({ deductionMinor: 266_700, netMinor: 983_300 });
    expect(salary({ basicMinor: 1_200_000, workDays: 9, unpaidDays: 2, bonusMinor: 0, otherDeductionMinor: 0, basis: 'none' }).deductionMinor).toBe(0);
    expect(salary({ basicMinor: 100_000, workDays: 1, unpaidDays: 5, bonusMinor: 0, otherDeductionMinor: 999_999, basis: 'thirty' }).netMinor).toBe(0);
  });

  it('makes the sheet from approved leave, and paying it adds one expense', async () => {
    const { teacherId } = await school();
    const pending = await requestLeave(db, 'ustaz@gmail.com', teacherId, { fromDay: '2026-11-15', toDay: '2026-11-15', reason: 'sick' });
    const leave = await requestLeave(db, 'ustaz@gmail.com', teacherId, { fromDay: '2026-11-01', toDay: '2026-11-10', reason: 'travel' });
    expect(await decideLeave(db, ACTOR, leave, 'approved', 'normal', '')).toBe(true);
    expect(await decideLeave(db, ACTOR, leave, 'rejected', 'normal', '')).toBe(false);
    await generatePayroll(db, ACTOR, '2026-11', DEFAULTS);
    let [row] = await listPayroll(db, '2026-11');
    expect(row).toMatchObject({ workDays: 9, leaveDays: 4, paidLeaveDays: 2, unpaidDays: 2, deductionMinor: 266_700, netMinor: 933_300, status: 'draft' });
    expect(pending).toBeTruthy(); // pending leave is not counted
    expect(await payPayroll(db, ACTOR, row!.id, today, 'cash', today)).toBe(false); // not approved yet
    expect(await approvePayroll(db, ACTOR, '2026-11')).toBe(1);
    // Making the sheet again leaves approved rows alone.
    await generatePayroll(db, ACTOR, '2026-11', { ...DEFAULTS, paidLeaveDays: 10 });
    [row] = await listPayroll(db, '2026-11');
    expect(row!.netMinor).toBe(933_300);
    expect(await payPayroll(db, ACTOR, row!.id, today, 'bkash', today)).toBe(true);
    expect(await payPayroll(db, ACTOR, row!.id, today, 'bkash', today)).toBe(false);
    const exp = await db.prepare('SELECT category, amount_minor AS a, method FROM expenses').all<{ category: string; a: number; method: string }>();
    expect(exp.results).toEqual([{ category: 'শিক্ষক বেতন', a: 933_300, method: 'bkash' }]);
  });
});

describe('who is who', () => {
  it('finds the teacher and the offline student by email, any case', async () => {
    const { teacherId, sid, batchId } = await school();
    expect((await teacherForEmail(db, 'USTAZ@gmail.com'))?.id).toBe(teacherId);
    expect(await teacherForEmail(db, '')).toBeNull();
    expect(await offlineIdsForEmail(db, 'Amina@Gmail.com')).toEqual([sid]);
    expect(await offlineIdsForEmail(db, '')).toEqual([]);
    expect(await batchForTeacher(db, teacherId, batchId)).toBeTruthy();
    expect(await batchForTeacher(db, 'tch_other', batchId)).toBeNull();
  });

  it('gives material files only to staff, the teacher and active students of the batch', async () => {
    const { batchId } = await school();
    await db.prepare(`INSERT INTO batch_materials (id, batch_id, title, file_key, file_name, created_by) VALUES ('mat_1', ?, 'Notes', 'private/materials/x.pdf', 'x.pdf', 'a')`).bind(batchId).run();
    expect(await materialFile(db, 'mat_1', { staff: true, email: null })).toBeTruthy();
    expect(await materialFile(db, 'mat_1', { staff: false, email: 'ustaz@gmail.com' })).toBeTruthy();
    expect(await materialFile(db, 'mat_1', { staff: false, email: 'AMINA@gmail.com' })).toBeTruthy();
    expect(await materialFile(db, 'mat_1', { staff: false, email: 'other@gmail.com' })).toBeNull();
    expect(await materialFile(db, 'mat_1', { staff: false, email: null })).toBeNull();
    await db.prepare(`UPDATE offline_enrollments SET status = 'dropped'`).run();
    expect(await materialFile(db, 'mat_1', { staff: false, email: 'amina@gmail.com' })).toBeNull();
  });
});

describe('paying offline fees online', () => {
  const valid = (reference: string, amountTaka: string, extra: Record<string, string> = {}) => ({
    status: 'VALID',
    tran_id: reference,
    val_id: 'v1',
    amount: amountTaka,
    currency: 'BDT',
    bank_tran_id: 'B1',
    risk_level: '0',
    ...extra,
  });

  it('offers only server worked out amounts', async () => {
    const { sid } = await school();
    const e = (await getOfflineStudent(db, sid, today))!.enrollments[0]!;
    // Sep, Oct, Nov installments of 1,000 are late.
    expect(feeChoices(e).map((c) => [c.key, c.amountMinor])).toEqual([['overdue', 300_000], ['all', 600_000]]);
    expect(feeChoices({ ...e, status: 'dropped' })).toEqual([]);
  });

  it('only lets the account pay its own enrollments', async () => {
    const { eid } = await school();
    const mine = await studentPanel(db, 'amina@gmail.com', today);
    const theirs = await studentPanel(db, 'other@gmail.com', today);
    expect((await createFeePayment(db, { id: 'stu_x', email: 'other@gmail.com' }, theirs.enrollments, eid, 'all')).ok).toBe(false);
    expect((await createFeePayment(db, { id: 'stu_a', email: 'amina@gmail.com' }, mine.enrollments, eid, 'made_up')).ok).toBe(false);
    const ok = await createFeePayment(db, { id: 'stu_a', email: 'amina@gmail.com' }, mine.enrollments, eid, 'overdue');
    expect(ok.ok && ok.payment.amountMinor).toBe(300_000);
  });

  it('records a valid payment once, as a receipt, from browser return and IPN', async () => {
    const { eid, sid } = await school();
    const p = await createFeePayment(db, { id: 'stu_a', email: 'amina@gmail.com' }, (await studentPanel(db, 'amina@gmail.com', today)).enrollments, eid, 'overdue');
    if (!p.ok) throw new Error('no payment');
    const ref = p.payment.reference;
    expect(await applyFeeValidation(db, null, ref, today)).toBe('pending');
    expect(await applyFeeValidation(db, { status: 'FAILED', tran_id: ref }, ref, today)).toBe('pending');
    expect(await applyFeeValidation(db, valid(ref, '3000.00'), ref, today)).toBe('paid');
    expect(await applyFeeValidation(db, valid(ref, '3000.00'), ref, today)).toBe('paid');
    const pays = await db.prepare('SELECT amount_minor AS a, method, nonce FROM offline_payments').all();
    expect(pays.results).toEqual([{ a: 300_000, method: 'online', nonce: ref }]);
    expect((await getOfflineStudent(db, sid, today))!.enrollments[0]!.ledger.overdueMinor).toBe(0);
  });

  it('holds anything that does not match for staff, without recording money', async () => {
    const { eid } = await school();
    const start = async () => {
      const p = await createFeePayment(db, { id: 'stu_a', email: 'amina@gmail.com' }, (await studentPanel(db, 'amina@gmail.com', today)).enrollments, eid, 'overdue');
      if (!p.ok) throw new Error('no payment');
      return p.payment.reference;
    };
    const a = await start();
    expect(await applyFeeValidation(db, valid(a, '30.00'), a, today)).toBe('review'); // wrong amount
    const b = await start();
    expect(await applyFeeValidation(db, valid(b, '3000.00', { currency: 'USD' }), b, today)).toBe('review');
    const c = await start();
    expect(await applyFeeValidation(db, valid(c, '3000.00', { risk_level: '1' }), c, today)).toBe('review');
    const d = await start();
    expect(await applyFeeValidation(db, valid(a, '3000.00'), d, today)).toBe('review'); // someone else's tran_id
    expect((await db.prepare('SELECT count(*) AS n FROM offline_payments').first<{ n: number }>())!.n).toBe(0);
    // Paid at the office meanwhile: more than is due now.
    const e = await start();
    await db.prepare(`INSERT INTO offline_payments (id, receipt_no, enrollment_id, amount_minor, paid_on, method, recorded_by) VALUES ('ofp_x', 1, ?, 600000, ?, 'cash', 'x')`).bind(eid, today).run();
    expect(await applyFeeValidation(db, valid(e, '3000.00'), e, today)).toBe('review');
    expect((await db.prepare('SELECT count(*) AS n FROM offline_payments').first<{ n: number }>())!.n).toBe(1);
  });

  it('marks a cancelled payment and never turns it back into money without validation', async () => {
    const { eid } = await school();
    const p = await createFeePayment(db, { id: 'stu_a', email: 'amina@gmail.com' }, (await studentPanel(db, 'amina@gmail.com', today)).enrollments, eid, 'all');
    if (!p.ok) throw new Error('no payment');
    await markFeeUnpaid(db, p.payment.reference, 'cancelled', {});
    const row = await db.prepare('SELECT status FROM offline_online_payments').first<{ status: string }>();
    expect(row!.status).toBe('cancelled');
    expect((await db.prepare('SELECT count(*) AS n FROM offline_payments').first<{ n: number }>())!.n).toBe(0);
  });
});

describe('paying a salary twice at the same moment (audit 2026-11-08)', () => {
  it('marks it paid and adds the expense once, together', async () => {
    await school();
    await generatePayroll(db, ACTOR, '2026-11', DEFAULTS);
    await approvePayroll(db, ACTOR, '2026-11');
    const [row] = await listPayroll(db, '2026-11');
    const r = await Promise.all([payPayroll(db, ACTOR, row!.id, today, 'cash', today), payPayroll(db, ACTOR, row!.id, today, 'cash', today)]);
    expect(r.filter(Boolean)).toHaveLength(1);
    const exp = await db.prepare('SELECT id, amount_minor AS a FROM expenses').all<{ id: string; a: number }>();
    expect(exp.results).toHaveLength(1);
    const [after] = await listPayroll(db, '2026-11');
    expect(after!.expenseId).toBe(exp.results[0]!.id);
  });
});

describe('large expenses wait for the owner', () => {
  const spend = (taka: number, needsApproval: boolean) =>
    recordExpense(db, 'cashier@example.org', { spentOn: today, category: 'Repair', amountTaka: taka, description: '', method: 'cash', nonce: null }, null, needsApproval);

  it('counts a waiting expense only once approved, never if turned down', async () => {
    const small = await spend(500, false);
    const big = await spend(5000, true);
    const other = await spend(3000, true);
    let r = await profitAndLoss(db, today, today);
    expect(r.expenseMinor).toBe(50_000);
    expect(await decideExpense(db, ACTOR, big, 'approved')).toBe('approved');
    expect(await decideExpense(db, ACTOR, big, 'rejected')).toBe('missing'); // already decided
    expect(await decideExpense(db, ACTOR, other, 'rejected')).toBe('rejected');
    expect(await decideExpense(db, ACTOR, small, 'approved')).toBe('missing'); // was never waiting
    r = await profitAndLoss(db, today, today);
    expect(r.expenseMinor).toBe(550_000);
  });

  it('reads the limit from the settings form', () => {
    expect(parseSettingsForm(form({ expenseApprovalOver: '২,০০০' })).expenseApprovalOver).toBe(2000);
    expect(parseSettingsForm(form({ expenseApprovalOver: '-1' })).expenseApprovalOver).toBe(DEFAULTS.expenseApprovalOver);
  });
});

describe('students rate their teachers', () => {
  const rate = (o: Record<string, string>) => form({ teaching: '5', punctuality: '4', behaviour: '5', overall: '4', comment: 'ভালো', ...o });

  it('once a month, only for a teacher they really have, values 1 to 5', async () => {
    const { sid, teacherId } = await school();
    const targets = await ratingTargets(db, [sid], '2026-11');
    expect(targets.map((t) => [t.teacherId, t.done])).toEqual([[teacherId, false]]);
    expect(await submitRating(db, 'amina@gmail.com', [sid], rate({ offlineStudentId: sid, teacherId: 'tch_other' }), '2026-11')).toBe('invalid');
    expect(await submitRating(db, 'x@gmail.com', ['ofs_someone_else'], rate({ offlineStudentId: sid, teacherId }), '2026-11')).toBe('invalid');
    expect(await submitRating(db, 'amina@gmail.com', [sid], rate({ offlineStudentId: sid, teacherId, teaching: '9' }), '2026-11')).toBe('invalid');
    expect(await submitRating(db, 'amina@gmail.com', [sid], rate({ offlineStudentId: sid, teacherId }), '2026-11')).toBe('saved');
    expect(await submitRating(db, 'amina@gmail.com', [sid], rate({ offlineStudentId: sid, teacherId }), '2026-11')).toBe('already');
    expect(await submitRating(db, 'amina@gmail.com', [sid], rate({ offlineStudentId: sid, teacherId, overall: '2' }), '2026-12')).toBe('saved');
    const r = await teacherRatings(db, teacherId, '2026-01');
    expect(r.summary).toMatchObject({ count: 2, teaching: 5, overall: 3 });
    expect(r.comments).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain(sid); // no names or ids of who rated
  });
});
