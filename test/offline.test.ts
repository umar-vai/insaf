import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { addMonths, csvCell, ledger, parseTaka, schedule } from '../src/lib/offline';
import {
  createOfflineCourse,
  createOfflineStudent,
  enrollOffline,
  getOfflineStudent,
  listOfflineStudents,
  offlineOverview,
  parsePaymentForm,
  recordPayment,
  updateEnrollment,
  voidPayment,
} from '../src/server/offline';
import { addStaff, setStaffScope } from '../src/server/admin';
import { adminArea, canUse, staffAccess, staffScope } from '../src/server/staff';
import { signSession, SESSION_COOKIE } from '../src/server/session';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-06';

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM offline_payments'),
    db.prepare('DELETE FROM offline_enrollments'),
    db.prepare('DELETE FROM offline_students'),
    db.prepare('DELETE FROM offline_courses'),
    db.prepare('DELETE FROM admin_events'),
    db.prepare('DELETE FROM staff'),
  ]);
});

const terms = { feeMinor: 1_200_000, admissionFeeMinor: 0, discountMinor: 0, durationMonths: 12, planMonths: 3, startDate: '2026-01-15' };

describe('fee schedule', () => {
  it('splits a 12,000 taka year paid every 3 months into four 3,000 taka installments', () => {
    const s = schedule(terms);
    expect(s.map((x) => x.amountMinor)).toEqual([300_000, 300_000, 300_000, 300_000]);
    expect(s.map((x) => x.dueDate)).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  });

  it('puts the admission fee on the first installment and leftovers on the last, in whole taka', () => {
    const s = schedule({ ...terms, feeMinor: 1_000_000, admissionFeeMinor: 50_000, durationMonths: 3, planMonths: 1 });
    expect(s.map((x) => x.amountMinor)).toEqual([383_300, 333_300, 333_400]);
    expect(s.reduce((a, x) => a + x.amountMinor, 0)).toBe(1_050_000);
  });

  it('is one payment when paying all at once or when the plan is longer than the course', () => {
    expect(schedule({ ...terms, planMonths: 0 })).toEqual([{ dueDate: '2026-01-15', amountMinor: 1_200_000 }]);
    expect(schedule({ ...terms, durationMonths: 2, planMonths: 6 })).toHaveLength(1);
  });

  it('subtracts the discount', () => {
    expect(schedule({ ...terms, discountMinor: 200_000, planMonths: 0 })[0]!.amountMinor).toBe(1_000_000);
  });

  it('keeps month ends inside the month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29');
    expect(addMonths('2026-11-06', -1)).toBe('2026-10-06');
  });

  it('marks paid, late and coming installments', () => {
    const l = ledger(terms, 450_000, '2026-08-01');
    expect(l.installments.map((i) => i.state)).toEqual(['paid', 'overdue', 'overdue', 'upcoming']);
    expect(l.paidMinor).toBe(450_000);
    expect(l.dueMinor).toBe(750_000);
    expect(l.overdueMinor).toBe(450_000);
    expect(l.next).toEqual({ dueDate: '2026-04-15', amountMinor: 150_000 });
  });

  it('reads Bangla digits and commas, and refuses junk', () => {
    expect(parseTaka('১২,০০০')).toBe(12000);
    expect(parseTaka('1200.00')).toBe(1200);
    expect(parseTaka('12.5')).toBeNull();
    expect(parseTaka('-5')).toBeNull();
  });

  it('stops Excel formulas in exported cells', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('Amina, Dhaka')).toBe('"Amina, Dhaka"');
  });
});

async function setup() {
  const courseId = await createOfflineCourse(db, ACTOR, { title: 'Hifz', feeTaka: 12000, admissionTaka: 500, durationMonths: 12, note: '', status: 'active' });
  const studentId = await createOfflineStudent(db, ACTOR, { name: 'Rahim', phone: '01711111111', guardianPhone: '', email: '', address: 'Dhaka', note: '' });
  const enrollmentId = await enrollOffline(db, ACTOR, studentId, { courseId, batchId: null, roll: '1', startDate: '2026-09-01', discountTaka: 0, planMonths: 3, note: '' });
  return { courseId, studentId, enrollmentId: enrollmentId! };
}
const payForm = (amount: string, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set('amount', amount);
  f.set('paidOn', today);
  f.set('method', 'cash');
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  const p = parsePaymentForm(f, today);
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

describe('offline ledger in the database', () => {
  it('copies the fee at enrolment, so later fee changes do not change the deal', async () => {
    const { studentId, courseId } = await setup();
    await db.prepare('UPDATE offline_courses SET fee_minor = 9999900 WHERE id = ?').bind(courseId).run();
    const s = await getOfflineStudent(db, studentId, today);
    expect(s!.enrollments[0]!.ledger.totalMinor).toBe(1_250_000);
  });

  it('records payments with running receipt numbers and lowers what is due', async () => {
    const { studentId, enrollmentId } = await setup();
    const a = await recordPayment(db, ACTOR, enrollmentId, payForm('3500'), today);
    const b = await recordPayment(db, ACTOR, enrollmentId, payForm('৩০০০'), today);
    expect(a.ok && b.ok && [a.receiptNo, b.receiptNo]).toEqual([1, 2]);
    const s = await getOfflineStudent(db, studentId, today);
    expect(s!.enrollments[0]!.ledger.paidMinor).toBe(650_000);
    expect(s!.enrollments[0]!.ledger.dueMinor).toBe(600_000);
  });

  it('refuses more than is due', async () => {
    const { enrollmentId } = await setup();
    expect(await recordPayment(db, ACTOR, enrollmentId, payForm('125001'), today)).toEqual({ ok: false, error: 'too_much' });
  });

  it('saves a double clicked form only once', async () => {
    const { enrollmentId } = await setup();
    const nonce = crypto.randomUUID();
    const a = await recordPayment(db, ACTOR, enrollmentId, payForm('3500', { nonce }), today);
    const b = await recordPayment(db, ACTOR, enrollmentId, payForm('3500', { nonce }), today);
    expect(a).toEqual(b);
    const n = await db.prepare('SELECT count(*) AS n FROM offline_payments').first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('refuses a payment date in the future', () => {
    const f = new FormData();
    f.set('amount', '100');
    f.set('paidOn', '2026-12-01');
    f.set('method', 'cash');
    expect(parsePaymentForm(f, today)).toEqual({ ok: false, error: 'paidOn' });
  });

  it('a voided payment stays on record but no longer counts', async () => {
    const { studentId, enrollmentId } = await setup();
    const p = await recordPayment(db, ACTOR, enrollmentId, payForm('3500'), today);
    expect(await voidPayment(db, ACTOR, p.ok ? p.id : '', '')).toBe(false);
    expect(await voidPayment(db, ACTOR, p.ok ? p.id : '', 'typed wrong')).toBe(true);
    const s = await getOfflineStudent(db, studentId, today);
    expect(s!.payments).toHaveLength(1);
    expect(s!.enrollments[0]!.ledger.paidMinor).toBe(0);
  });

  it('lists who is late, and leaves out students who dropped', async () => {
    const { studentId, enrollmentId } = await setup();
    let o = await offlineOverview(db, today);
    expect(o.overdue.map((e) => e.studentId)).toEqual([studentId]);
    expect(o.totalOverdueMinor).toBe(350_000);
    expect((await listOfflineStudents(db, '0171', today, 'overdue')).map((s) => s.id)).toEqual([studentId]);
    await updateEnrollment(db, ACTOR, enrollmentId, { status: 'dropped', planMonths: 3, discountTaka: 0, batchId: null, roll: '', startDate: '2026-09-01', note: '' });
    o = await offlineOverview(db, today);
    expect(o.overdue).toHaveLength(0);
  });

  it('writes every change to the admin log', async () => {
    const { enrollmentId } = await setup();
    await recordPayment(db, ACTOR, enrollmentId, payForm('100'), today);
    const { results } = await db.prepare('SELECT action FROM admin_events ORDER BY created_at').all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(['offline.course.create', 'offline.student.create', 'offline.enroll', 'offline.payment']);
  });
});

describe('online, offline or both', () => {
  const owners = { DB: db, ADMIN_EMAILS: ACTOR, SESSION_SECRET: 'test-only-session-secret-0123456789' };

  it('sorts admin pages into parts', () => {
    expect(adminArea('/admin/offline')).toBe('offline');
    expect(adminArea('/admin/offline/students/x')).toBe('offline');
    expect(adminArea('/admin/offlinex')).toBe('online');
    expect(adminArea('/admin/donations')).toBe('online');
    expect(adminArea('/admin/team')).toBe('shared');
    expect(adminArea('/admin/finance')).toBe('both');
    expect(canUse('offline', 'both')).toBe(false);
    expect(canUse('online', 'both')).toBe(false);
    expect(canUse('all', 'both')).toBe(true);
    expect(canUse('offline', 'online')).toBe(false);
    expect(canUse('online', 'offline')).toBe(false);
    expect(canUse('all', 'offline')).toBe(true);
  });

  it('stores the chosen part and lets owners change it', async () => {
    expect(await addStaff(db, owners, ACTOR, 'cashier@example.org', 'offline')).toBe('added');
    expect(await addStaff(db, owners, ACTOR, 'bad@example.org', 'everything')).toBe('invalid');
    expect(await staffScope(owners, 'cashier@example.org')).toBe('offline');
    expect(await setStaffScope(db, owners, ACTOR, 'cashier@example.org', 'all')).toBe(true);
    expect(await staffScope(owners, 'cashier@example.org')).toBe('all');
    expect(await setStaffScope(db, owners, ACTOR, ACTOR, 'offline')).toBe(false);
    expect(await staffScope(owners, ACTOR)).toBe('all');
  });

  it('team members added before this change keep everything', async () => {
    await db.prepare(`INSERT INTO staff (email, added_by) VALUES ('old@example.org', 'x')`).run();
    expect(await staffScope(owners, 'old@example.org')).toBe('all');
  });

  it('signs in an offline only member with their part', async () => {
    await addStaff(db, owners, ACTOR, 'cashier@example.org', 'offline');
    await db.prepare(`INSERT OR REPLACE INTO students (id, email) VALUES ('stu_cash', 'cashier@example.org')`).run();
    const req = new Request('https://tamrin.test/admin/offline', { headers: { Cookie: `${SESSION_COOKIE}=${await signSession(owners, 'stu_cash')}` } });
    expect(await staffAccess(req, owners)).toEqual({ email: 'cashier@example.org', scope: 'offline', modules: ['office', 'academic', 'hr', 'accounts'], grants: { office: 'edit', academic: 'edit', hr: 'edit', accounts: 'edit' }, owner: false });
  });
});
