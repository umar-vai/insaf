import { log } from './admin';
import { notifyStudents } from './notifications';
import { daysBetween, EFFECTIVE_BATCH, longText, marks, newId, runBatches, text, type Result } from './ops-util';
import { addDays, isYmd, parseDays, weekday } from '../lib/offline';

// A student's leave: the student or a verified guardian asks in the portal,
// the academic office approves or refuses. Approving marks "leave" on the
// student's class attendance for those days on which the class meets, but
// never overwrites a mark a teacher has already made.

export type StudentLeave = {
  id: string;
  studentId: string;
  studentName: string;
  studentNo: number | null;
  fromDay: string;
  toDay: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string;
  createdAt: string;
};
export const STUDENT_LEAVE_STATUS_BN: Record<StudentLeave['status'], string> = { pending: 'অপেক্ষায়', approved: 'অনুমোদিত', rejected: 'নামঞ্জুর', cancelled: 'ফিরিয়ে নেওয়া' };
export const MAX_LEAVE_DAYS = 31;

export function parseStudentLeaveForm(form: FormData, today: string): Result<{ studentId: string; fromDay: string; toDay: string; reason: string }> {
  const studentId = text(form, 'studentId', 40);
  const fromDay = text(form, 'fromDay', 10);
  const toDay = text(form, 'toDay', 10) || fromDay;
  const reason = longText(form, 'reason', 1000);
  if (!studentId) return { ok: false, error: 'student' };
  // A few days back is allowed (sudden illness), not older.
  if (!isYmd(fromDay) || !isYmd(toDay) || toDay < fromDay || fromDay < addDays(today, -7)) return { ok: false, error: 'dates' };
  if (daysBetween(fromDay, toDay) + 1 > MAX_LEAVE_DAYS) return { ok: false, error: 'too_long' };
  if (reason.length < 2) return { ok: false, error: 'reason' };
  return { ok: true, value: { studentId, fromDay, toDay, reason } };
}

/** allowedIds: the student records this signed-in account may act for (own or verified guardian). */
export async function requestStudentLeave(
  db: D1Database,
  actor: string,
  allowedIds: readonly string[],
  v: { studentId: string; fromDay: string; toDay: string; reason: string },
): Promise<Result<string>> {
  if (!allowedIds.includes(v.studentId)) return { ok: false, error: 'student' };
  const id = newId('slv');
  await db.prepare('INSERT INTO student_leave_requests (id, student_id, from_day, to_day, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, v.studentId, v.fromDay, v.toDay, v.reason, actor).run();
  await log(db, actor, 'student_leave.request', `offline_student:${v.studentId}`, { leaveId: id, from: v.fromDay, to: v.toDay });
  return { ok: true, value: id };
}

export async function cancelStudentLeave(db: D1Database, actor: string, allowedIds: readonly string[], id: string): Promise<boolean> {
  if (!allowedIds.length) return false;
  const r = await db
    .prepare(`UPDATE student_leave_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND student_id IN (${marks(allowedIds.length)}) RETURNING student_id AS studentId`)
    .bind(id, ...allowedIds)
    .first<{ studentId: string }>();
  if (!r) return false;
  await log(db, actor, 'student_leave.cancel', `offline_student:${r.studentId}`, { leaveId: id });
  return true;
}

const SELECT = `SELECT l.id, l.student_id AS studentId, s.name AS studentName, s.student_no AS studentNo, l.from_day AS fromDay, l.to_day AS toDay, l.reason, l.status,
  l.requested_by AS requestedBy, l.decided_by AS decidedBy, l.decision_note AS decisionNote, l.created_at AS createdAt
  FROM student_leave_requests l JOIN offline_students s ON s.id = l.student_id`;

export async function listStudentLeave(db: D1Database, opts: { status?: StudentLeave['status']; studentIds?: string[]; limit?: number } = {}): Promise<StudentLeave[]> {
  if (opts.studentIds && !opts.studentIds.length) return [];
  const conds = [opts.status ? 'l.status = ?' : '', opts.studentIds ? `l.student_id IN (${marks(opts.studentIds.length)})` : ''].filter(Boolean).join(' AND ');
  const { results } = await db
    .prepare(`${SELECT} ${conds ? `WHERE ${conds}` : ''} ORDER BY l.status = 'pending' DESC, l.from_day DESC LIMIT ?`)
    .bind(...(opts.status ? [opts.status] : []), ...(opts.studentIds ?? []), Math.min(500, opts.limit ?? 200))
    .all<StudentLeave>();
  return results;
}

/** Approve or refuse a pending request. Approval writes "leave" attendance where nothing is marked yet. */
export async function decideStudentLeave(db: D1Database, actor: string, id: string, decision: 'approved' | 'rejected', note: string): Promise<Result<{ marked: number }>> {
  const r = await db
    .prepare(
      `UPDATE student_leave_requests SET status = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note = ?
       WHERE id = ? AND status = 'pending' RETURNING student_id AS studentId, from_day AS fromDay, to_day AS toDay`,
    )
    .bind(decision, actor, note.trim().slice(0, 500), id)
    .first<{ studentId: string; fromDay: string; toDay: string }>();
  if (!r) return { ok: false, error: 'decided' };
  let marked = 0;
  if (decision === 'approved') {
    const { results } = await db
      .prepare(
        `SELECT e.id AS enrollmentId, b.id AS batchId, b.days FROM offline_enrollments e JOIN offline_batches b ON b.id = ${EFFECTIVE_BATCH}
         WHERE e.student_id = ? AND e.status = 'active'`,
      )
      .bind(r.studentId)
      .all<{ enrollmentId: string; batchId: string; days: string }>();
    const statements: D1PreparedStatement[] = [];
    for (let d = r.fromDay; d <= r.toDay; d = addDays(d, 1)) {
      for (const e of results) {
        const days = parseDays(e.days);
        if (days.length && !days.includes(weekday(d))) continue;
        statements.push(
          db
            .prepare(`INSERT INTO offline_attendance (id, batch_id, enrollment_id, day, status, marked_by) VALUES (?, ?, ?, ?, 'leave', ?) ON CONFLICT (enrollment_id, day) DO NOTHING`)
            .bind(newId('att'), e.batchId, e.enrollmentId, d, actor),
        );
      }
    }
    marked = await runBatches(db, statements);
  }
  await notifyStudents(db, actor, [r.studentId], {
    title: decision === 'approved' ? 'ছুটির আবেদন অনুমোদিত হয়েছে' : 'ছুটির আবেদন মঞ্জুর হয়নি',
    body: note.trim().slice(0, 300),
    link: '/account/offline/leave',
    sourceKey: `student-leave:${id}`,
  });
  await log(db, actor, `student_leave.${decision}`, `offline_student:${r.studentId}`, { leaveId: id, marked });
  return { ok: true, value: { marked } };
}

export async function pendingStudentLeaveCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM student_leave_requests WHERE status = 'pending'").first<{ n: number }>())?.n ?? 0;
}
