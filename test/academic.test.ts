import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createOfflineCourse, createOfflineStudent, enrollOffline, getOfflineStudent, setStudentBlocked } from '../src/server/offline';
import { createNotice, listBatches, noticeFile, parseBatchForm, saveBatch, saveTeacher } from '../src/server/office';
import { addBatchTeacher, cancelExam, createExam, listExams, mayReadRoutine, removeBatchTeacher, teacherExams } from '../src/server/academic';
import { batchForTeacher, landingFor, materialFile, offlineIdsForEmail, officeNotices, teacherBatchIds } from '../src/server/panels';
import { closeTicket, getTicket, listTickets, openTicket, ownsTicket, replyTicket } from '../src/server/tickets';
import { teacherWeekdays, workDays } from '../src/server/hr';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-08';

beforeEach(async () => {
  await db.batch(
    [
      'ticket_messages',
      'tickets',
      'notices',
      'offline_charges',
      'offline_exams',
      'batch_teachers',
      'batch_materials',
      'offline_attendance',
      'offline_payments',
      'offline_enrollments',
      'offline_batches',
      'teachers',
      'offline_students',
      'offline_courses',
      'admin_events',
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

const form = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};
const teacher = (name: string, email: string, role: 'teacher' | 'staff' = 'teacher') =>
  saveTeacher(db, ACTOR, null, { name, phone: '01811111111', email, subject: '', basicPayMinor: 1_000_000, joinedOn: '', role, status: 'active', note: '' });

async function school() {
  const courseId = await createOfflineCourse(db, ACTOR, { title: 'Nazera', feeTaka: 6000, admissionTaka: 0, durationMonths: 6, note: '', status: 'active' });
  const mainId = (await teacher('Main', 'main@gmail.com'))!;
  const arabicId = (await teacher('Arabic', 'arabic@gmail.com'))!;
  const b = parseBatchForm(form({ courseId, name: 'B1', days: ['0', '2'], startTime: '16:00', endTime: '17:00', teacherId: mainId }));
  if (!b.ok) throw new Error(b.error);
  const batchId = (await saveBatch(db, ACTOR, null, b.value))!;
  const sid = await createOfflineStudent(db, ACTOR, { name: 'Amina', phone: '01711111111', guardianPhone: '', email: 'amina@gmail.com', address: '', note: '' });
  const eid = (await enrollOffline(db, ACTOR, sid, { courseId, batchId, roll: '1', startDate: '2026-09-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  const sid2 = await createOfflineStudent(db, ACTOR, { name: 'Left', phone: '01722222222', guardianPhone: '', email: 'left@gmail.com', address: '', note: '' });
  const eid2 = (await enrollOffline(db, ACTOR, sid2, { courseId, batchId, roll: '2', startDate: '2026-09-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  await db.prepare(`UPDATE offline_enrollments SET status = 'dropped' WHERE id = ?`).bind(eid2).run();
  return { courseId, mainId, arabicId, batchId, sid, eid, sid2 };
}

describe('subject teachers', () => {
  it('a subject teacher sees the batch, may open its files, and its days count for pay', async () => {
    const { arabicId, batchId } = await school();
    expect(await teacherBatchIds(db, arabicId)).toEqual([]);
    expect(await addBatchTeacher(db, ACTOR, batchId, arabicId, 'Arabic grammar')).toBe(true);
    expect(await teacherBatchIds(db, arabicId)).toEqual([batchId]);
    expect(await batchForTeacher(db, arabicId, batchId)).not.toBeNull();
    expect((await listBatches(db, { teacherId: arabicId })).map((b) => b.id)).toEqual([batchId]);
    expect([...(await teacherWeekdays(db, arabicId))].sort()).toEqual([0, 2]);
    await db.prepare(`INSERT INTO batch_materials (id, batch_id, title, file_key, file_name, created_by) VALUES ('m1', ?, 'Notes', 'private/materials/x.pdf', 'x.pdf', 'a')`).bind(batchId).run();
    expect(await materialFile(db, 'm1', { staff: false, email: 'arabic@gmail.com' })).not.toBeNull();
  });

  it('removing a subject teacher takes the batch away', async () => {
    const { arabicId, batchId } = await school();
    await addBatchTeacher(db, ACTOR, batchId, arabicId, 'Arabic');
    const [row] = (await db.prepare('SELECT id FROM batch_teachers').all<{ id: string }>()).results;
    expect(await removeBatchTeacher(db, ACTOR, batchId, row!.id)).toBe(true);
    expect(await batchForTeacher(db, arabicId, batchId)).toBeNull();
  });

  it('office staff are not offered as subject teachers, and their pay days are the month', async () => {
    const { batchId } = await school();
    const staffId = (await teacher('Clerk', 'clerk@gmail.com', 'staff'))!;
    expect(await addBatchTeacher(db, ACTOR, batchId, staffId, 'x')).toBe(false);
    expect(workDays('class_days', '2026-11', await teacherWeekdays(db, staffId))).toBe(30);
  });
});

describe('exams', () => {
  it('charges the fee to active students of the batch only, once', async () => {
    const { batchId, sid, sid2 } = await school();
    const r = await createExam(db, ACTOR, { batchId, title: 'Half yearly', subject: '', examDate: '2026-12-01', startTime: '10:00', feeTaka: 200, note: '' });
    expect(r?.charged).toBe(1);
    const a = await getOfflineStudent(db, sid, today);
    expect(a!.enrollments[0]!.ledger.byKind.exam.totalMinor).toBe(20_000);
    const b = await getOfflineStudent(db, sid2, today);
    expect(b!.enrollments[0]!.ledger.byKind.exam.totalMinor).toBe(0);
  });

  it('cancelling waives the fee and hides the exam from panels', async () => {
    const { batchId, sid, mainId } = await school();
    const r = await createExam(db, ACTOR, { batchId, title: 'Final', subject: '', examDate: '2026-12-01', startTime: '', feeTaka: 300, note: '' });
    expect(await teacherExams(db, mainId, today)).toHaveLength(1);
    expect(await cancelExam(db, ACTOR, r!.id)).toBe(true);
    expect(await cancelExam(db, ACTOR, r!.id)).toBe(false);
    expect(await listExams(db, { batchIds: [batchId] })).toHaveLength(0);
    expect((await getOfflineStudent(db, sid, today))!.enrollments[0]!.ledger.byKind.exam.totalMinor).toBe(0);
  });
});

describe('master routine access', () => {
  it('is for staff, active teachers and active students only', async () => {
    const { sid } = await school();
    expect(await mayReadRoutine(db, { staff: true, email: null })).toBe(true);
    expect(await mayReadRoutine(db, { staff: false, email: 'main@gmail.com' })).toBe(true);
    expect(await mayReadRoutine(db, { staff: false, email: 'amina@gmail.com' })).toBe(true);
    expect(await mayReadRoutine(db, { staff: false, email: 'left@gmail.com' })).toBe(false);
    expect(await mayReadRoutine(db, { staff: false, email: 'stranger@gmail.com' })).toBe(false);
    await setStudentBlocked(db, ACTOR, sid, true, 'unpaid');
    expect(await mayReadRoutine(db, { staff: false, email: 'amina@gmail.com' })).toBe(false);
  });
});

describe('blocked students', () => {
  it('cannot use the panel until unblocked, and blocking needs a reason', async () => {
    const { sid } = await school();
    expect(await setStudentBlocked(db, ACTOR, sid, true, '')).toBe(false);
    expect(await setStudentBlocked(db, ACTOR, sid, true, 'left without notice')).toBe(true);
    expect(await offlineIdsForEmail(db, 'amina@gmail.com')).toEqual([]);
    expect(await setStudentBlocked(db, ACTOR, sid, false, '')).toBe(true);
    expect(await offlineIdsForEmail(db, 'amina@gmail.com')).toEqual([sid]);
  });
});

describe('notices for one person, with files', () => {
  it('a notice to one student reaches only that student, and so does its file', async () => {
    const { sid, sid2, batchId } = await school();
    const id = (await createNotice(db, ACTOR, { title: 'Your fee', body: '', audience: 'offline_student', targetId: sid, pinned: false }))!;
    await db.prepare(`UPDATE notices SET file_key = 'private/notices/a.pdf', file_name = 'a.pdf' WHERE id = ?`).bind(id).run();
    expect((await officeNotices(db, 'student', [batchId], 8, [sid])).map((n) => n.id)).toEqual([id]);
    expect(await officeNotices(db, 'student', [batchId], 8, [sid2])).toEqual([]);
    const who = (email: string | null) => ({ onlineStaff: false, offlineStaff: false, email, studentId: null });
    expect(await noticeFile(db, id, who('amina@gmail.com'))).toEqual({ fileKey: 'private/notices/a.pdf', fileName: 'a.pdf' });
    expect(await noticeFile(db, id, who('left@gmail.com'))).toBeNull();
    expect(await noticeFile(db, id, who(null))).toBeNull();
    expect(await noticeFile(db, id, { ...who(null), offlineStaff: true })).not.toBeNull();
    expect(await noticeFile(db, id, { ...who(null), onlineStaff: true })).toBeNull();
  });

  it('a notice to one teacher reaches that teacher; a missing target is refused', async () => {
    const { mainId, arabicId } = await school();
    const id = (await createNotice(db, ACTOR, { title: 'Meeting', body: '', audience: 'teacher', targetId: mainId, pinned: false }))!;
    expect((await officeNotices(db, 'teacher', [], 8, [], mainId)).map((n) => n.id)).toEqual([id]);
    expect(await officeNotices(db, 'teacher', [], 8, [], arabicId)).toEqual([]);
    expect(await createNotice(db, ACTOR, { title: 'X', body: '', audience: 'teacher', targetId: 'nope', pinned: false })).toBeNull();
  });

  it('a batch notice file is open to its subject teachers and active students', async () => {
    const { batchId, arabicId } = await school();
    await addBatchTeacher(db, ACTOR, batchId, arabicId, 'Arabic');
    const id = (await createNotice(db, ACTOR, { title: 'Exam', body: '', audience: 'batch', targetId: batchId, pinned: false }))!;
    await db.prepare(`UPDATE notices SET file_key = 'k', file_name = 'f.pdf' WHERE id = ?`).bind(id).run();
    const who = (email: string) => ({ onlineStaff: false, offlineStaff: false, email, studentId: null });
    expect(await noticeFile(db, id, who('arabic@gmail.com'))).not.toBeNull();
    expect(await noticeFile(db, id, who('amina@gmail.com'))).not.toBeNull();
    expect(await noticeFile(db, id, who('left@gmail.com'))).toBeNull();
  });
});

describe('tickets', () => {
  it('goes open, answered, open again, closed, with numbers and owners', async () => {
    const { sid, sid2, mainId } = await school();
    const a = await openTicket(db, 'amina@gmail.com', { kind: 'student', offlineStudentId: sid }, { subject: 'Fee question', category: 'fee', body: 'Why?' });
    const b = await openTicket(db, 'main@gmail.com', { kind: 'teacher', teacherId: mainId }, { subject: 'Room', category: 'class', body: 'Fan broken' });
    const ta = (await getTicket(db, a))!;
    expect(ta.ticket.ticketNo).toBe(1);
    expect((await getTicket(db, b))!.ticket.ticketNo).toBe(2);
    expect(ownsTicket(ta.ticket, { offlineStudentIds: [sid] })).toBe(true);
    expect(ownsTicket(ta.ticket, { offlineStudentIds: [sid2] })).toBe(false);
    expect(ownsTicket(ta.ticket, { teacherId: mainId })).toBe(false);

    await replyTicket(db, ACTOR, a, 'staff', 'Because');
    expect((await getTicket(db, a))!.ticket.status).toBe('answered');
    await replyTicket(db, 'amina@gmail.com', a, 'student', 'Thanks, one more');
    expect((await getTicket(db, a))!.ticket.status).toBe('open');
    expect(await closeTicket(db, ACTOR, a)).toBe(true);
    expect(await closeTicket(db, ACTOR, a)).toBe(false);
    const done = (await getTicket(db, a))!;
    expect(done.ticket.status).toBe('closed');
    expect(done.messages.map((m) => m.authorKind)).toEqual(['student', 'staff', 'student']);

    expect((await listTickets(db, { status: 'active' })).map((t) => t.id)).toEqual([b]);
    expect((await listTickets(db, { offlineStudentIds: [sid] })).map((t) => t.id)).toEqual([a]);
    expect(await listTickets(db, { offlineStudentIds: [] })).toEqual([]);
  });

  it('a reply to a missing ticket does nothing', async () => {
    expect(await replyTicket(db, ACTOR, 'tkt_none', 'staff', 'hi')).toBe(false);
  });
});

describe('landing after sign in', () => {
  it('teachers go to the teacher panel, offline students to theirs, others stay on the account page', async () => {
    await school();
    await db.batch([db.prepare('DELETE FROM students')]);
    await db.prepare(`INSERT INTO students (id, email) VALUES ('s_t', 'main@gmail.com'), ('s_o', 'amina@gmail.com'), ('s_w', 'web@gmail.com')`).run();
    expect(await landingFor(db, 's_t', '/account')).toBe('/teacher');
    expect(await landingFor(db, 's_o', '/account')).toBe('/account/offline');
    expect(await landingFor(db, 's_w', '/account')).toBe('/account');
    expect(await landingFor(db, 's_o', '/courses/x')).toBe('/courses/x');
  });
});
