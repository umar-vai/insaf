import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createOfflineCourse, createOfflineStudent, enrollOffline, listOfflineStudents, parseStudentNo, recordPayment } from '../src/server/offline';
import {
  attendanceMonth,
  classesOn,
  createNotice,
  monthlyFigures,
  noticesForStudent,
  parseBatchForm,
  parseExpenseForm,
  profitAndLoss,
  recordExpense,
  roster,
  saveAttendance,
  saveBatch,
  saveTeacher,
  setNoticeStatus,
  voidExpense,
  OFFLINE_AUDIENCES,
  ONLINE_AUDIENCES,
} from '../src/server/office';
import { fillTemplate, studentCode, timeBn, waNumber } from '../src/lib/offline';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-08'; // a Sunday

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM offline_attendance'),
    db.prepare('DELETE FROM offline_payments'),
    db.prepare('DELETE FROM offline_enrollments'),
    db.prepare('DELETE FROM offline_batches'),
    db.prepare('DELETE FROM teachers'),
    db.prepare('DELETE FROM offline_students'),
    db.prepare('DELETE FROM offline_courses'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM notices'),
    db.prepare('DELETE FROM admin_events'),
  ]);
});

const form = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

async function school() {
  const courseId = await createOfflineCourse(db, ACTOR, { title: 'Nazera', feeTaka: 6000, admissionTaka: 0, durationMonths: 6, note: '', status: 'active' });
  const teacherId = (await saveTeacher(db, ACTOR, null, {
    name: 'Ustaz Karim',
    phone: '01811111111',
    email: '',
    subject: 'Tajweed',
    basicPayMinor: 1_500_000,
    joinedOn: '',
    status: 'active',
    note: '',
  }))!;
  const b = parseBatchForm(form({ courseId, name: 'Batch 1', days: ['0', '2'], startTime: '16:30', endTime: '18:00', teacherId }));
  if (!b.ok) throw new Error(b.error);
  const batchId = (await saveBatch(db, ACTOR, null, b.value))!;
  const s1 = await createOfflineStudent(db, ACTOR, { name: 'Amina', phone: '01711111111', guardianPhone: '', email: 'amina@gmail.com', address: '', note: '' });
  const s2 = await createOfflineStudent(db, ACTOR, { name: 'Bilal', phone: '01722222222', guardianPhone: '', email: '', address: '', note: '' });
  const e1 = (await enrollOffline(db, ACTOR, s1, { courseId, batchId, roll: '2', startDate: '2026-11-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  const e2 = (await enrollOffline(db, ACTOR, s2, { courseId, batchId, roll: '1', startDate: '2026-11-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  return { courseId, teacherId, batchId, s1, s2, e1, e2 };
}

describe('student ID numbers', () => {
  it('gives each new student the next number and finds them by it', async () => {
    const { s1, s2 } = await school();
    const rows = await db.prepare('SELECT id, student_no AS no FROM offline_students ORDER BY student_no').all<{ id: string; no: number }>();
    expect(rows.results).toEqual([{ id: s1, no: 1 }, { id: s2, no: 2 }]);
    expect(studentCode(2)).toBe('MI-0002');
    expect(parseStudentNo('TI-0002')).toBe(2);
    expect(parseStudentNo('ti২')).toBe(2);
    expect(parseStudentNo('01711111111')).toBeNull();
    expect((await listOfflineStudents(db, 'MI-0002', today)).map((s) => s.id)).toEqual([s2]);
    expect((await listOfflineStudents(db, 'amina@gmail', today)).map((s) => s.id)).toEqual([s1]);
  });

  it('refuses a batch from another course', async () => {
    const { s1, batchId } = await school();
    const other = await createOfflineCourse(db, ACTOR, { title: 'Hifz', feeTaka: 1000, admissionTaka: 0, durationMonths: 1, note: '', status: 'active' });
    expect(await enrollOffline(db, ACTOR, s1, { courseId: other, batchId, roll: '', startDate: today, discountTaka: 0, planMonths: 0, note: '' })).toBeNull();
  });
});

describe('batches and attendance', () => {
  it('keeps only real weekdays and checks times', () => {
    const ok = parseBatchForm(form({ courseId: 'c', name: 'B', days: ['6', '6', '9', 'x', '1'], startTime: '08:00', endTime: '09:00' }));
    expect(ok.ok && ok.value.days).toBe('6,1');
    expect(parseBatchForm(form({ courseId: 'c', name: 'B', startTime: '10:00', endTime: '09:00' })).ok).toBe(false);
    expect(timeBn('16:30')).toBe('বিকাল ৪:৩০');
  });

  it("shows today's classes from the routine", async () => {
    const { batchId } = await school();
    expect((await classesOn(db, today)).map((b) => b.id)).toEqual([batchId]);
    expect(await classesOn(db, '2026-11-09')).toHaveLength(0); // Monday
  });

  it('saves a day once per student, by roll, and counts the month', async () => {
    const { batchId, e1, e2 } = await school();
    expect((await roster(db, batchId, today)).map((r) => r.roll)).toEqual(['1', '2']);
    expect(await saveAttendance(db, ACTOR, batchId, today, { [e1]: 'present', [e2]: 'absent', ofe_unknown: 'present' }, today)).toBe(2);
    expect(await saveAttendance(db, ACTOR, batchId, today, { [e2]: 'late' }, today)).toBe(1);
    expect(await saveAttendance(db, ACTOR, batchId, '2026-11-09', { [e1]: 'present' }, today)).toBe(0); // future
    expect(await saveAttendance(db, ACTOR, batchId, today, { [e1]: 'sleeping' }, today)).toBe(0);
    const m = await attendanceMonth(db, batchId, '2026-11');
    expect(m.days).toEqual([today]);
    expect(m.rows.map((r) => [r.name, r.present, r.late, r.absent])).toEqual([
      ['Bilal', 0, 1, 0],
      ['Amina', 1, 0, 0],
    ]);
  });
});

describe('expenses and the income statement', () => {
  it('reads the form and saves a double click once', async () => {
    const nonce = crypto.randomUUID();
    const v = parseExpenseForm(form({ amount: '১,৫০০', category: 'বাড়ি ভাড়া', spentOn: today, nonce }), today);
    if (!v.ok) throw new Error(v.error);
    expect(v.value.amountTaka).toBe(1500);
    expect(parseExpenseForm(form({ amount: '100', category: 'x y', spentOn: '2026-12-01' }), today).ok).toBe(false);
    const a = await recordExpense(db, ACTOR, v.value, null);
    expect(await recordExpense(db, ACTOR, v.value, null)).toBe(a);
    expect((await db.prepare('SELECT count(*) AS n FROM expenses').first<{ n: number }>())!.n).toBe(1);
  });

  it('adds online and offline income, takes off expenses, and leaves voided ones out', async () => {
    const { e1 } = await school();
    const pay = await recordPayment(db, ACTOR, e1, { amountTaka: 1000, paidOn: today, method: 'cash', reference: '', note: '', nonce: null }, today);
    expect(pay.ok).toBe(true);
    const rent = await recordExpense(db, ACTOR, { spentOn: today, category: 'Rent', amountTaka: 300, description: '', method: 'cash', nonce: null }, null);
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Tea', amountTaka: 50, description: '', method: 'cash', nonce: null }, null);
    expect(await voidExpense(db, ACTOR, rent, '')).toBe(false);
    expect(await voidExpense(db, ACTOR, rent, 'typed twice')).toBe(true);
    // A donation late on 31 Oct UTC is 1 Nov in Dhaka. Unpaid and voided gifts do not count.
    await db.batch([
      db.prepare(`INSERT INTO funds (id, slug, title) VALUES ('fund_x', 'x', 'General')`),
      db.prepare(
        `INSERT INTO donations (id, reference, fund_id, amount_minor, donor_name, status, paid_at) VALUES
           ('d1', 'DN-AAAAAAAAAAAA', 'fund_x', 50000, 'X', 'paid', '2026-10-31T19:00:00.000Z'),
           ('d2', 'DN-BBBBBBBBBBBB', 'fund_x', 70000, 'Y', 'pending', NULL)`,
      ),
      db.prepare(
        `INSERT INTO donations (id, reference, fund_id, amount_minor, donor_name, status, gateway, paid_at, voided_at) VALUES
           ('d3', 'MN-CCCCCCCCCCCC', 'fund_x', 9000, 'Z', 'paid', 'manual', '2026-11-02T06:00:00.000Z', '2026-11-03T00:00:00.000Z')`,
      ),
    ]);
    const r = await profitAndLoss(db, '2026-11-01', '2026-11-30');
    expect([r.onlineMinor, r.offlineMinor, r.expenseMinor]).toEqual([50_000, 100_000, 5_000]);
    expect(r.expensesByCategory).toEqual([{ label: 'Tea', totalMinor: 5_000 }]);
    const months = await monthlyFigures(db, '2026-10', '2026-11', { online: true, offline: true });
    expect(months).toEqual([
      { month: '2026-10', onlineMinor: 0, offlineMinor: 0, expenseMinor: 0 },
      { month: '2026-11', onlineMinor: 50_000, offlineMinor: 100_000, expenseMinor: 5_000 },
    ]);
    await db.batch([db.prepare('DELETE FROM donations'), db.prepare('DELETE FROM funds')]);
  });
});

describe('notices', () => {
  it('shows website accounts the notices for everyone; course notices no longer exist', async () => {
    await db.batch([db.prepare(`INSERT INTO students (id, email, name) VALUES ('stu_n', 'n@example.org', 'N')`)]);
    await createNotice(db, ACTOR, { title: 'Eid break', body: '', audience: 'online', targetId: '', pinned: false });
    expect(await createNotice(db, ACTOR, { title: 'A class moved', body: '', audience: 'course', targetId: 'crs_a', pinned: false })).toBeNull();
    const offline = await createNotice(db, ACTOR, { title: 'Office closed', body: '', audience: 'offline', targetId: '', pinned: false });
    expect(await createNotice(db, ACTOR, { title: 'x', body: '', audience: 'course', targetId: 'crs_none', pinned: false })).toBeNull();
    expect((await noticesForStudent(db, 'stu_n')).map((n) => n.title).sort()).toEqual(['Eid break']);
    // The online part cannot hide an offline notice.
    expect(await setNoticeStatus(db, ACTOR, offline!, 'hidden', ONLINE_AUDIENCES)).toBe(false);
    expect(await setNoticeStatus(db, ACTOR, offline!, 'hidden', OFFLINE_AUDIENCES)).toBe(true);
    await db.batch([db.prepare('DELETE FROM students')]);
  });
});

describe('WhatsApp reminders', () => {
  it('turns local numbers into wa.me numbers and fills the message', () => {
    expect(waNumber('01711-111111')).toBe('8801711111111');
    expect(waNumber('০১৭১১১১১১১১')).toBe('8801711111111');
    expect(waNumber('+8801711111111')).toBe('8801711111111');
    expect(waNumber('029999999')).toBeNull();
    expect(fillTemplate('{name}: {amount} {x}', { name: 'Amina', amount: '500 Tk' })).toBe('Amina: 500 Tk {x}');
  });
});

describe('two cashiers at the same moment (audit 2026-11-08)', () => {
  it('never takes more than is due, even when both see the same balance', async () => {
    const { e1 } = await school(); // 6,000 due in total
    const pay = (taka: number) => recordPayment(db, ACTOR, e1, { amountTaka: taka, paidOn: today, method: 'cash', reference: '', note: '', nonce: null }, today);
    const results = await Promise.all([pay(4000), pay(4000), pay(4000)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error)).toEqual(['too_much', 'too_much']);
    const sum = await db.prepare('SELECT sum(amount_minor) AS s FROM offline_payments WHERE enrollment_id = ?').bind(e1).first<{ s: number }>();
    expect(sum!.s).toBe(400_000);
    expect((await pay(2000)).ok).toBe(true);
    expect((await pay(1)).ok).toBe(false);
  });
});
