import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { lateInstallments, ledger } from '../src/lib/offline';
import {
  addOtherCharge,
  applyLateFees,
  chargesOfStudent,
  createOfflineCourse,
  createOfflineStudent,
  enrollOffline,
  getOfflineStudent,
  parsePaymentForm,
  recordPayment,
  voidCharge,
} from '../src/server/offline';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-06';

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM offline_charges'),
    db.prepare('DELETE FROM offline_payments'),
    db.prepare('DELETE FROM offline_enrollments'),
    db.prepare('DELETE FROM offline_students'),
    db.prepare('DELETE FROM offline_courses'),
    db.prepare('DELETE FROM admin_events'),
  ]);
});

// 12,000 taka a year plus 500 admission, every 3 months from 1 September:
// 3,500 on 1 Sep, then 3,000 on 1 Dec, 1 Mar, 1 Jun.
async function setup() {
  const courseId = await createOfflineCourse(db, ACTOR, { title: 'Hifz', feeTaka: 12000, admissionTaka: 500, durationMonths: 12, note: '', status: 'active' });
  const studentId = await createOfflineStudent(db, ACTOR, { name: 'Rahim', phone: '01711111111', guardianPhone: '', email: '', address: '', note: '' });
  const enrollmentId = (await enrollOffline(db, ACTOR, studentId, { courseId, batchId: null, roll: '1', startDate: '2026-09-01', discountTaka: 0, planMonths: 3, note: '' }))!;
  return { studentId, enrollmentId };
}
const pay = (amount: string, paidOn = today) => {
  const f = new FormData();
  f.set('amount', amount);
  f.set('paidOn', paidOn);
  f.set('method', 'cash');
  const p = parsePaymentForm(f, today);
  if (!p.ok) throw new Error(p.error);
  return p.value;
};
const ledgerOfStudent = async (id: string) => (await getOfflineStudent(db, id, today))!.enrollments[0]!.ledger;

describe('charges in the ledger', () => {
  const terms = { feeMinor: 600_000, admissionFeeMinor: 0, discountMinor: 0, durationMonths: 2, planMonths: 1, startDate: '2026-10-01' };

  it('adds charges to what is owed and splits the total by kind', () => {
    const l = ledger(terms, 0, today, [{ id: 'c1', kind: 'exam', label: 'Exam', amountMinor: 20_000, dueDate: '2026-10-20' }]);
    expect(l.totalMinor).toBe(620_000);
    expect(l.byKind.fee.totalMinor).toBe(600_000);
    expect(l.byKind.exam.totalMinor).toBe(20_000);
    expect(l.installments.map((i) => i.kind)).toEqual(['fee', 'exam', 'fee']);
  });

  it('pays items in date order, an installment before a charge on the same day', () => {
    const l = ledger(terms, 300_000, today, [{ id: 'c1', kind: 'late', label: 'Late', amountMinor: 10_000, dueDate: '2026-10-01' }]);
    expect(l.installments[0]).toMatchObject({ kind: 'fee', state: 'paid' });
    expect(l.installments[1]).toMatchObject({ kind: 'late', paidMinor: 0, state: 'overdue' });
  });

  it('finds installments past the grace days, once each', () => {
    const l = ledger(terms, 0, '2026-10-09', []);
    expect(lateInstallments(l, '2026-10-09', 7, new Set()).map((i) => i.n)).toEqual([1]);
    expect(lateInstallments(l, '2026-10-08', 7, new Set())).toEqual([]);
    expect(lateInstallments(l, '2026-10-09', 7, new Set([1]))).toEqual([]);
  });
});

describe('late fees', () => {
  it('adds one late fee to an installment unpaid after the grace days, and never twice', async () => {
    const { studentId } = await setup();
    expect(await applyLateFees(db, today, 100, 7)).toBe(1);
    expect(await applyLateFees(db, today, 100, 7)).toBe(0);
    const l = await ledgerOfStudent(studentId);
    expect(l.byKind.late.totalMinor).toBe(10_000);
    expect(l.totalMinor).toBe(1_260_000);
  });

  it('does nothing when the late fee is 0 or the installment was paid', async () => {
    const { enrollmentId } = await setup();
    expect(await applyLateFees(db, today, 0, 7)).toBe(0);
    await recordPayment(db, ACTOR, enrollmentId, pay('3500'), today);
    expect(await applyLateFees(db, today, 100, 7)).toBe(0);
  });

  it('a waived late fee stops counting and does not come back', async () => {
    const { studentId } = await setup();
    await applyLateFees(db, today, 100, 7);
    const [c] = await chargesOfStudent(db, studentId);
    expect(await voidCharge(db, ACTOR, c!.id, '')).toBe(false);
    expect(await voidCharge(db, ACTOR, c!.id, 'first time')).toBe(true);
    expect(await applyLateFees(db, today, 100, 7)).toBe(0);
    expect((await ledgerOfStudent(studentId)).byKind.late.totalMinor).toBe(0);
  });
});

describe('paying charges', () => {
  it('lets the office take money for charges, but not more than everything owed', async () => {
    const { enrollmentId } = await setup();
    expect(await addOtherCharge(db, ACTOR, enrollmentId, { label: 'Books', amountTaka: 300, dueDate: today })).toBe(true);
    expect(await recordPayment(db, ACTOR, enrollmentId, pay('12801'), today)).toEqual({ ok: false, error: 'too_much' });
    const r = await recordPayment(db, ACTOR, enrollmentId, pay('12800'), today);
    expect(r.ok).toBe(true);
  });

  it('logs added and waived charges', async () => {
    const { studentId, enrollmentId } = await setup();
    await addOtherCharge(db, ACTOR, enrollmentId, { label: 'Books', amountTaka: 300, dueDate: today });
    const [c] = await chargesOfStudent(db, studentId);
    await voidCharge(db, ACTOR, c!.id, 'gift');
    const { results } = await db.prepare(`SELECT action FROM admin_events WHERE action LIKE 'offline.charge.%' ORDER BY created_at`).all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(['offline.charge.add', 'offline.charge.void']);
  });
});
