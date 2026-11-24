import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { afterConcession, billPreview, cancelBillRun, dueStatements, endConcession, listConcessions, parseBillForm, postBillRun, setConcession } from '../src/server/fee-bills';
import { getOfflineStudent } from '../src/server/offline';
import { issueBook, lateFine, listBooks, parseIssueForm, removeBook, returnBook, saveBook } from '../src/server/library';
import { certificateTemplate, issueCertificate, isVerifyCode, revokeCertificate, studentFacts, verifyCertificate } from '../src/server/certificates';
import { saveStaffDay, selfAttendance, staffDay, staffMonth } from '../src/server/staff-attendance';
import { cancelStudentLeave, decideStudentLeave, listStudentLeave, parseStudentLeaveForm, requestStudentLeave } from '../src/server/student-leave';
import { createInquiry, listInquiries, parseInquiryForm, updateInquiry } from '../src/server/inquiries';
import { listNotifications, markRead, notifyStudents, parseMessageForm, sendMessage, unreadCount } from '../src/server/notifications';
import { adminModule } from '../src/server/staff';
import { getSettings, parseSettingsForm } from '../src/server/settings';

const db = env.DB;
const actor = 'office@example.org';
const today = '2026-11-12';

const TABLES = [
  'portal_notifications', 'admission_inquiries', 'student_leave_requests', 'staff_attendance', 'leave_requests', 'certificates', 'library_loans', 'library_books',
  'fee_concessions', 'fee_bill_runs', 'academic_promotions', 'academic_batch_sessions', 'academic_sessions', 'offline_attendance', 'offline_payments',
  'offline_charges', 'offline_enrollments', 'offline_students', 'offline_batches', 'offline_courses', 'teachers', 'admin_events', 'settings',
];
beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function seed() {
  await db.batch([
    db.prepare("INSERT INTO offline_courses (id, title, fee_minor, duration_months) VALUES ('c1', 'Hifz', 120000, 12), ('c2', 'Kitab', 100000, 12)"),
    // Batch b1 meets Sunday (0) and Tuesday (2).
    db.prepare("INSERT INTO offline_batches (id, course_id, name, days) VALUES ('b1', 'c1', 'Hifz A', '0,2'), ('b2', 'c2', 'Kitab A', '')"),
    db.prepare(
      `INSERT INTO offline_students (id, name, phone, guardian_phone, email, student_no) VALUES
       ('s1', 'Rahim', '01711111111', '', 'rahim@example.org', 1), ('s2', 'Karim', '01722222222', '01733333333', 'karim@example.org', 2), ('s3', 'Salim', '01744444444', '', '', 3)`,
    ),
    db.prepare(
      `INSERT INTO offline_enrollments (id, student_id, course_id, batch_id, start_date, fee_minor, duration_months, plan_months) VALUES
       ('e1', 's1', 'c1', 'b1', '2026-01-01', 120000, 12, 0), ('e2', 's2', 'c1', 'b1', '2026-01-01', 120000, 12, 0), ('e3', 's3', 'c2', 'b2', '2026-01-01', 100000, 12, 0)`,
    ),
    db.prepare("INSERT INTO teachers (id, name, phone, email) VALUES ('t1', 'Ustad', '01755555555', 'ustad@example.org'), ('t2', 'Clerk', '01766666666', '')"),
  ]);
}

describe('fee bills and concessions', () => {
  it('validates the form and rounds concessions down to whole taka', () => {
    expect(parseBillForm(form({ title: 'x', amount: '100', dueDate: today, targetKind: 'all' })).ok).toBe(false);
    expect(parseBillForm(form({ title: 'December fee', amount: '৫০০', dueDate: today, targetKind: 'batch' })).ok).toBe(false);
    const ok = parseBillForm(form({ title: 'December fee', amount: '৫০০', dueDate: today, targetKind: 'batch', batchId: 'b1' }));
    expect(ok.ok && ok.value.amountMinor).toBe(50000);
    expect(afterConcession(50000, 50)).toBe(25000);
    expect(afterConcession(33300, 50)).toBe(16600);
    expect(afterConcession(50000, 100)).toBe(0);
  });

  it('blocks a second bill for the same head and month across overlapping targets', async () => {
    await seed();
    const input = { title: 'Books December', feeHead: 'books' as const, billingPeriod: '2026-12', amountMinor: 50000, dueDate: '2026-12-10', target: { kind: 'batch' as const, id: 'b1' }, useConcessions: false };
    expect((await postBillRun(db, actor, input, 'first00000000001', today)).ok).toBe(true);
    const other = { ...input, title: 'New title', dueDate: '2026-12-20', target: { kind: 'all' as const, id: '' } };
    expect((await billPreview(db, other, today)).map((l) => l.skip)).toEqual(['already', 'already', '']);
    expect((await postBillRun(db, actor, other, 'second0000000001', today))).toMatchObject({ ok: true, value: { created: 1 } });
    expect((await postBillRun(db, actor, input, 'third00000000001', today))).toEqual({ ok: false, error: 'already' });
    const tuition = { ...input, title: 'Tuition', feeHead: 'tuition' as const };
    expect((await billPreview(db, tuition, today)).map((l) => l.skip)).toEqual(['tuition', 'tuition']);
  });

  it('posts once per run key, applies concessions, and cancelling voids the charges', async () => {
    await seed();
    expect(await setConcession(db, actor, { studentId: 's2', percent: 50, reason: 'orphan' })).toBe(true);
    expect(await setConcession(db, actor, { studentId: 's2', percent: 100, reason: 'orphan, full' })).toBe(true);
    expect((await listConcessions(db)).map((c) => [c.studentId, c.percent])).toEqual([['s2', 100]]);
    const input = { title: 'Book fee', amountMinor: 50000, dueDate: '2026-12-10', target: { kind: 'batch' as const, id: 'b1' }, useConcessions: true };
    const lines = await billPreview(db, input, today);
    expect(lines.map((l) => [l.studentId, l.amountMinor, l.skip])).toEqual([['s1', 50000, ''], ['s2', 0, 'free']]);
    const key = 'a1b2c3d4e5f6a7b8';
    const r1 = await postBillRun(db, actor, input, key, today);
    const r2 = await postBillRun(db, actor, input, key, today);
    expect(r1.ok && r1.value.created).toBe(1);
    expect(r2.ok && r2.value.runId).toBe(r1.ok && r1.value.runId);
    expect((await db.prepare("SELECT count(*) AS n FROM offline_charges WHERE source_key LIKE 'bill:%'").first<{ n: number }>())?.n).toBe(1);
    expect(await postBillRun(db, actor, input, 'bad key!', today)).toEqual({ ok: false, error: 'key' });
    // The bill shows in the student's ledger, and the student is told.
    const s1 = await getOfflineStudent(db, 's1', today);
    expect(s1?.enrollments[0]?.ledger.byKind.other.totalMinor).toBe(50000);
    expect(await unreadCount(db, { studentIds: ['s1'] })).toBe(1);
    expect(await unreadCount(db, { studentIds: ['s2'] })).toBe(0);
    // Printed due statements include the bill.
    const st = await dueStatements(db, today, { kind: 'batch', id: 'b1' });
    expect(st.find((x) => x.studentId === 's1')?.enrollments[0]?.ledger.installments.some((i) => i.label === 'Book fee')).toBe(true);
    // Cancel needs a reason; then the charge is voided, not deleted.
    const runId = r1.ok ? r1.value.runId : '';
    expect(await cancelBillRun(db, actor, runId, '')).toBe(false);
    expect(await cancelBillRun(db, actor, runId, 'wrong amount')).toBe(true);
    expect(await cancelBillRun(db, actor, runId, 'again')).toBe(false);
    const c = await db.prepare("SELECT voided_at AS v FROM offline_charges WHERE source_key = ?").bind(`bill:${runId}`).first<{ v: string | null }>();
    expect(c?.v).toBeTruthy();
    const cid = (await listConcessions(db))[0]!.id;
    expect(await endConcession(db, actor, cid)).toBe(true);
    expect(await listConcessions(db)).toHaveLength(0);
  });
});

describe('library', () => {
  it('lends only available copies, charges a late student fine once, and keeps removal safe', async () => {
    await seed();
    const added = await saveBook(db, actor, null, { accessionNo: null, title: 'Riyadus Salihin', author: 'Nawawi', category: 'Hadith', shelf: 'A1', isbn: '', copies: 1 });
    expect(added.ok).toBe(true);
    const bookId = added.ok ? added.value : '';
    expect((await saveBook(db, actor, null, { accessionNo: 1, title: 'Other', author: '', category: '', shelf: '', isbn: '', copies: 1 })).ok).toBe(false);
    const issue = parseIssueForm(form({ bookId, borrowerKind: 'student', studentId: 's1' }), '2026-11-01', 14);
    expect(issue.ok && issue.value.dueOn).toBe('2026-11-15');
    if (!issue.ok) return;
    expect((await issueBook(db, actor, issue.value, '2026-11-01')).ok).toBe(true);
    expect((await issueBook(db, actor, { ...issue.value, borrowerId: 's2' }, '2026-11-01')).ok).toBe(false);
    expect((await listBooks(db, 'riyad'))[0]?.available).toBe(0);
    expect(await removeBook(db, actor, bookId)).toBe(false);
    expect(lateFine('2026-11-15', '2026-11-18', 5)).toBe(1500);
    const loanId = (await db.prepare('SELECT id FROM library_loans').first<{ id: string }>())!.id;
    const r = await returnBook(db, actor, loanId, '2026-11-18', 5, false);
    expect(r.ok && r.value.fineMinor).toBe(1500);
    expect((await returnBook(db, actor, loanId, '2026-11-18', 5, false)).ok).toBe(false);
    const fine = await db.prepare("SELECT amount_minor AS a, enrollment_id AS e FROM offline_charges WHERE source_key = ?").bind(`library:${loanId}`).first<{ a: number; e: string }>();
    expect(fine).toEqual({ a: 1500, e: 'e1' });
    expect(await removeBook(db, actor, bookId)).toBe(true);
  });
});

describe('certificates', () => {
  it('issues numbered certificates with a verification code and shows only safe facts publicly', async () => {
    await seed();
    const facts = await studentFacts(db, 's1');
    expect(facts?.code).toBe('MI-0001');
    const t = certificateTemplate('transfer', facts!);
    expect(t.body).toContain('Rahim');
    const a = await issueCertificate(db, actor, { studentId: 's1', kind: 'transfer', title: t.title, body: t.body, issuedOn: today });
    const b = await issueCertificate(db, actor, { studentId: 's2', kind: 'character', title: 'Character', body: 'A long enough body text', issuedOn: today });
    expect(a.ok && b.ok).toBe(true);
    const rows = await db.prepare('SELECT serial_no AS n, code FROM certificates ORDER BY serial_no').all<{ n: number; code: string }>();
    expect(rows.results.map((r) => r.n)).toEqual([1, 2]);
    expect(rows.results.every((r) => isVerifyCode(r.code))).toBe(true);
    const v = await verifyCertificate(db, rows.results[0]!.code.toLowerCase());
    expect(v).toMatchObject({ serialNo: 1, studentName: 'Rahim', studentCode: 'MI-0001', valid: true });
    expect(Object.keys(v!)).not.toContain('body');
    expect(await verifyCertificate(db, 'NOTACODE00')).toBeNull();
    expect(await revokeCertificate(db, actor, a.ok ? a.value : '', 'issued by mistake')).toBe(true);
    expect((await verifyCertificate(db, rows.results[0]!.code))?.valid).toBe(false);
  });
});

describe('staff attendance', () => {
  it('saves the office sheet, refuses future days, and handles self arrival and leaving', async () => {
    await seed();
    expect(await saveStaffDay(db, actor, '2026-12-01', { t1: { status: 'present', inTime: '', outTime: '', note: '' } }, today)).toBe(0);
    expect(await saveStaffDay(db, actor, today, { t1: { status: 'present', inTime: '08:00', outTime: '', note: '' }, ghost: { status: 'absent', inTime: '', outTime: '', note: '' } }, today)).toBe(1);
    expect((await staffDay(db, today)).find((r) => r.teacherId === 't1')?.status).toBe('present');
    const at = (time: string) => ({ day: today, time });
    expect((await selfAttendance(db, 'ustad@example.org', 't1', 'in', '08:30', at('08:40'))).ok).toBe(false);
    const late = await selfAttendance(db, 'clerk', 't2', 'in', '08:30', at('08:40'));
    expect(late.ok && late.value).toBe('late');
    expect((await selfAttendance(db, 'clerk', 't2', 'in', '08:30', at('08:50'))).ok).toBe(false);
    expect((await selfAttendance(db, 'clerk', 't2', 'out', '08:30', at('15:00'))).ok).toBe(true);
    expect((await selfAttendance(db, 'x', 't1', 'out', '', { day: '2026-11-13', time: '15:00' })).ok).toBe(false);
    await db.prepare("INSERT INTO leave_requests (id, teacher_id, from_day, to_day, status, created_by) VALUES ('lv1', 't1', '2026-11-20', '2026-11-22', 'approved', 'x')").run();
    const month = await staffMonth(db, '2026-11');
    expect(month.find((r) => r.teacherId === 't1')).toMatchObject({ present: 1, leaveApproved: 3 });
    expect(month.find((r) => r.teacherId === 't2')).toMatchObject({ late: 1 });
  });
});

describe('student leave', () => {
  it('lets only the family ask, and approval marks leave without overwriting teacher marks', async () => {
    await seed();
    expect(parseStudentLeaveForm(form({ studentId: 's1', fromDay: '2026-10-01', reason: 'ill' }), today).ok).toBe(false);
    expect(parseStudentLeaveForm(form({ studentId: 's1', fromDay: '2026-11-15', toDay: '2026-12-31', reason: 'travel' }), today).ok).toBe(false);
    const v = parseStudentLeaveForm(form({ studentId: 's1', fromDay: '2026-11-15', toDay: '2026-11-18', reason: 'ill' }), today);
    if (!v.ok) throw new Error('parse');
    expect((await requestStudentLeave(db, 'stranger@example.org', ['s2'], v.value)).ok).toBe(false);
    const r = await requestStudentLeave(db, 'rahim@example.org', ['s1'], v.value);
    if (!r.ok) throw new Error('request');
    expect(await cancelStudentLeave(db, 'karim@example.org', ['s2'], r.value)).toBe(false);
    // 2026-11-15 is Sunday, 2026-11-17 Tuesday: the class days. A teacher already marked the 15th.
    await db.prepare("INSERT INTO offline_attendance (id, batch_id, enrollment_id, day, status, marked_by) VALUES ('a0', 'b1', 'e1', '2026-11-15', 'present', 't')").run();
    const d = await decideStudentLeave(db, actor, r.value, 'approved', 'get well');
    expect(d.ok && d.value.marked).toBe(1);
    const marks = await db.prepare("SELECT day, status FROM offline_attendance WHERE enrollment_id = 'e1' ORDER BY day").all<{ day: string; status: string }>();
    expect(marks.results).toEqual([{ day: '2026-11-15', status: 'present' }, { day: '2026-11-17', status: 'leave' }]);
    expect((await decideStudentLeave(db, actor, r.value, 'rejected', '')).ok).toBe(false);
    expect((await listStudentLeave(db, { studentIds: ['s1'] }))[0]?.status).toBe('approved');
    expect(await listStudentLeave(db, { studentIds: [] })).toEqual([]);
  });
});

describe('admission inquiries', () => {
  it('validates, drops bot posts, and records office follow up', async () => {
    expect(parseInquiryForm(form({ studentName: 'A', phone: '01711111111' })).ok).toBe(false);
    expect(parseInquiryForm(form({ studentName: 'Abdullah', phone: 'abc' })).ok).toBe(false);
    expect(parseInquiryForm(form({ studentName: 'Abdullah', phone: '01711111111', website: 'spam' }))).toEqual({ ok: false, error: 'spam' });
    const v = parseInquiryForm(form({ studentName: 'Abdullah', phone: '০১৭১১-১১১১১১', desiredClass: 'Hifz' }));
    if (!v.ok) throw new Error('parse');
    expect(v.value.phone).toBe('01711111111');
    const id = await createInquiry(db, v.value);
    expect(await updateInquiry(db, actor, id, 'bogus', '')).toBe(false);
    expect(await updateInquiry(db, actor, id, 'contacted', 'called, visiting Sunday')).toBe(true);
    expect((await listInquiries(db, 'contacted'))[0]).toMatchObject({ studentName: 'Abdullah', staffNote: 'called, visiting Sunday' });
  });
});

describe('notifications', () => {
  it('writes each event once per person and never marks or shows another family’s rows', async () => {
    await seed();
    const n = { title: 'Result published', sourceKey: 'result:x', link: '//evil.example/x' };
    expect(await notifyStudents(db, actor, ['s1', 's2', 's1'], n)).toBe(2);
    expect(await notifyStudents(db, actor, ['s1'], n)).toBe(0);
    const mine = await listNotifications(db, { studentIds: ['s1'] });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.link).toBe('');
    expect(await markRead(db, { studentIds: ['s1'] }, 'not-mine')).toBe(0);
    expect(await markRead(db, { studentIds: ['s1'] })).toBe(1);
    expect(await unreadCount(db, { studentIds: ['s2'] })).toBe(1);
    expect(await listNotifications(db, { studentIds: [] })).toEqual([]);
  });

  it('sends a group message to the portal, and by SMS only when the service is set up', async () => {
    await seed();
    expect(parseMessageForm(form({ audience: 'batch', title: 'Holiday' })).ok).toBe(false);
    const v = parseMessageForm(form({ audience: 'batch', batchId: 'b1', title: 'Holiday', body: 'Closed tomorrow' }));
    if (!v.ok) throw new Error('parse');
    const r = await sendMessage(db, env, actor, v.value);
    expect(r.ok && r.value.people).toBe(2);
    expect(await unreadCount(db, { studentIds: ['s3'] })).toBe(0);
    const sms = await sendMessage(db, env, actor, { ...v.value, sms: true });
    expect(sms).toEqual({ ok: false, error: 'sms_off' });
    const t = parseMessageForm(form({ audience: 'all_teachers', title: 'Meeting' }));
    if (!t.ok) throw new Error('parse');
    expect((await sendMessage(db, env, actor, t.value)).ok).toBe(true);
    expect(await unreadCount(db, { teacherId: 't1' })).toBe(1);
  });
});

describe('permissions and settings', () => {
  it('maps the new admin pages to modules', () => {
    expect(adminModule('/admin/offline/bills')).toBe('office');
    expect(adminModule('/admin/offline/certificates/x')).toBe('office');
    expect(adminModule('/admin/offline/inquiries')).toBe('office');
    expect(adminModule('/admin/offline/messages')).toBe('office');
    expect(adminModule('/admin/offline/library')).toBe('academic');
    expect(adminModule('/admin/offline/student-leave')).toBe('academic');
    expect(adminModule('/admin/offline/staff-attendance')).toBe('hr');
  });

  it('keeps safe defaults and validates the new office rules', async () => {
    const s = await getSettings(db);
    expect(s).toMatchObject({ libraryLoanDays: 14, libraryFinePerDayTaka: 0, staffSelfAttendance: false, staffStartTime: '' });
    const p = parseSettingsForm(form({ libraryLoanDays: '৭', libraryFinePerDayTaka: '5', staffSelfAttendance: 'on', staffStartTime: '25:00' }));
    expect(p).toMatchObject({ libraryLoanDays: 7, libraryFinePerDayTaka: 5, staffSelfAttendance: true, staffStartTime: '' });
  });
});
