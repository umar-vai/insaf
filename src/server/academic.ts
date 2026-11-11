import { log } from './admin';
import { DOC_TYPES, IMAGE_TYPES, storeUpload } from './files';
import { teaches } from './office';
import { bnDigits } from '../lib/format';
import { isTime, isYmd, parseTaka } from '../lib/offline';

// Academic setup for offline courses: subject teachers of a batch, exams
// (with an optional fee that becomes a charge on each active student of the
// batch) and the master routine file the office uploads.

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const text = (form: FormData, k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);

// ---- Subject teachers -------------------------------------------------------

export type BatchTeacher = { id: string; batchId: string; teacherId: string; teacherName: string; teacherPhone: string; subject: string };

const BT_SELECT = `SELECT bt.id, bt.batch_id AS batchId, bt.teacher_id AS teacherId, t.name AS teacherName, t.phone AS teacherPhone, bt.subject
  FROM batch_teachers bt JOIN teachers t ON t.id = bt.teacher_id`;

export async function batchTeachers(db: D1Database, batchIds: string[]): Promise<BatchTeacher[]> {
  if (!batchIds.length) return [];
  const { results } = await db
    .prepare(`${BT_SELECT} WHERE bt.batch_id IN (${batchIds.map(() => '?').join(',')}) AND t.status = 'active' ORDER BY bt.subject, t.name`)
    .bind(...batchIds)
    .all<BatchTeacher>();
  return results;
}

/** Adds a teacher to a batch for one subject; adding the same teacher again changes the subject. */
export async function addBatchTeacher(db: D1Database, actor: string, batchId: string, teacherId: string, subject: string): Promise<boolean> {
  const ok = await db
    .prepare(`SELECT (SELECT 1 FROM offline_batches WHERE id = ?) AS b, (SELECT 1 FROM teachers WHERE id = ? AND status = 'active' AND role = 'teacher') AS t`)
    .bind(batchId, teacherId)
    .first<{ b: number | null; t: number | null }>();
  if (!ok?.b || !ok.t) return false;
  const subj = subject.trim().slice(0, 80);
  await db
    .prepare(
      `INSERT INTO batch_teachers (id, batch_id, teacher_id, subject) VALUES (?, ?, ?, ?)
       ON CONFLICT (batch_id, teacher_id) DO UPDATE SET subject = excluded.subject`,
    )
    .bind(newId('bt'), batchId, teacherId, subj)
    .run();
  await log(db, actor, 'batch.teacher.add', `batch:${batchId}`, { teacherId, subject: subj });
  return true;
}

export async function removeBatchTeacher(db: D1Database, actor: string, batchId: string, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM batch_teachers WHERE id = ? AND batch_id = ? RETURNING teacher_id AS teacherId').bind(id, batchId).first<{ teacherId: string }>();
  if (!r) return false;
  await log(db, actor, 'batch.teacher.remove', `batch:${batchId}`, { teacherId: r.teacherId });
  return true;
}

// ---- Exams -------------------------------------------------------------------

export type Exam = {
  id: string;
  batchId: string;
  batchName: string;
  courseTitle: string;
  title: string;
  subject: string;
  examDate: string;
  startTime: string;
  feeMinor: number;
  note: string;
  status: 'scheduled' | 'cancelled';
  createdBy: string;
  createdAt: string;
};
type ExamInput = { batchId: string; title: string; subject: string; examDate: string; startTime: string; feeTaka: number; note: string };

export function parseExamForm(form: FormData): Result<ExamInput> {
  const batchId = text(form, 'batchId', 40);
  if (!batchId) return { ok: false, error: 'batch' };
  const title = text(form, 'title', 120);
  if (title.length < 2) return { ok: false, error: 'title' };
  const examDate = text(form, 'examDate', 10);
  if (!isYmd(examDate)) return { ok: false, error: 'examDate' };
  const startTime = text(form, 'startTime', 5);
  if (startTime && !isTime(startTime)) return { ok: false, error: 'time' };
  const fee = text(form, 'fee') === '' ? 0 : parseTaka(form.get('fee'));
  if (fee === null || fee > 1_000_000) return { ok: false, error: 'fee' };
  return {
    ok: true,
    value: { batchId, title, subject: text(form, 'subject', 80), examDate, startTime, feeTaka: fee, note: String(form.get('note') ?? '').trim().slice(0, 1000) },
  };
}

const EXAM_SELECT = `SELECT x.id, x.batch_id AS batchId, b.name AS batchName, c.title AS courseTitle, x.title, x.subject, x.exam_date AS examDate,
  x.start_time AS startTime, x.fee_minor AS feeMinor, x.note, x.status, x.created_by AS createdBy, x.created_at AS createdAt
  FROM offline_exams x JOIN offline_batches b ON b.id = x.batch_id JOIN offline_courses c ON c.id = b.course_id`;

/**
 * Exams of these batches (all batches when batchIds is null), from a date on.
 * Cancelled ones are left out unless asked for.
 */
export async function listExams(db: D1Database, opts: { batchIds?: string[] | null; from?: string; includeCancelled?: boolean; limit?: number } = {}): Promise<Exam[]> {
  if (opts.batchIds && !opts.batchIds.length) return [];
  const where = [
    opts.batchIds ? `x.batch_id IN (${opts.batchIds.map(() => '?').join(',')})` : '',
    opts.from ? 'x.exam_date >= ?' : '',
    opts.includeCancelled ? '' : "x.status = 'scheduled'",
  ].filter(Boolean);
  const { results } = await db
    .prepare(`${EXAM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.exam_date, x.start_time LIMIT ?`)
    .bind(...(opts.batchIds ?? []), ...(opts.from ? [opts.from] : []), opts.limit ?? 200)
    .all<Exam>();
  return results;
}

/** Exams of the batches a teacher teaches. */
export async function teacherExams(db: D1Database, teacherId: string, from: string): Promise<Exam[]> {
  const { results } = await db
    .prepare(`${EXAM_SELECT} WHERE ${teaches('?1')} AND x.status = 'scheduled' AND x.exam_date >= ?2 ORDER BY x.exam_date, x.start_time LIMIT 50`)
    .bind(teacherId, from)
    .all<Exam>();
  return results;
}

/**
 * Sets an exam. A fee becomes a charge ("exam:<id>") on every active
 * student of the batch, due on the exam date. Students who join the batch
 * later are not charged automatically; the office adds it by hand if needed.
 */
export async function createExam(db: D1Database, actor: string, v: ExamInput): Promise<{ id: string; charged: number } | null> {
  const batch = await db.prepare(`SELECT name FROM offline_batches WHERE id = ?`).bind(v.batchId).first<{ name: string }>();
  if (!batch) return null;
  const id = newId('exm');
  const statements = [
    db
      .prepare('INSERT INTO offline_exams (id, batch_id, title, subject, exam_date, start_time, fee_minor, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, v.batchId, v.title, v.subject, v.examDate, v.startTime, v.feeTaka * 100, v.note, actor),
  ];
  if (v.feeTaka > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
           SELECT 'chg_' || lower(hex(randomblob(8))), e.id, 'exam', ?, ?, ?, ?, ? FROM offline_enrollments e
           WHERE e.batch_id = ? AND e.status = 'active' ON CONFLICT (enrollment_id, source_key) DO NOTHING`,
        )
        .bind(`পরীক্ষার ফি: ${v.title}`, v.feeTaka * 100, v.examDate, `exam:${id}`, actor, v.batchId),
    );
  }
  const out = await db.batch(statements);
  const charged = v.feeTaka > 0 ? (out[1]?.meta.changes ?? 0) : 0;
  await log(db, actor, 'exam.create', `batch:${v.batchId}`, { examId: id, title: v.title, date: v.examDate, fee: v.feeTaka, charged });
  return { id, charged };
}

/** Cancels an exam and waives its fee where it is still on record (money already taken stays with the student's account). */
export async function cancelExam(db: D1Database, actor: string, id: string): Promise<boolean> {
  // A published report is immutable; cancelling the exam would hide issued results.
  const r = await db.prepare(`UPDATE offline_exams SET status = 'cancelled'
   WHERE id = ? AND status = 'scheduled'
   AND NOT EXISTS(SELECT 1 FROM assessment_policies p WHERE p.exam_id=offline_exams.id AND p.status='published')
   RETURNING batch_id AS batchId, title`).bind(id).first<{ batchId: string; title: string }>();
  if (!r) return false;
  const waived = await db
    .prepare(
      `UPDATE offline_charges SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = 'পরীক্ষা বাতিল'
       WHERE source_key = ? AND voided_at IS NULL`,
    )
    .bind(actor, `exam:${id}`)
    .run();
  await log(db, actor, 'exam.cancel', `batch:${r.batchId}`, { examId: id, title: r.title, waived: waived.meta.changes });
  return true;
}

export const examLine = (x: Pick<Exam, 'title' | 'subject' | 'startTime'>) =>
  [x.title, x.subject, x.startTime ? `সময় ${bnDigits(x.startTime)}` : ''].filter(Boolean).join(' · ');

// ---- Master routine -------------------------------------------------------------

export type RoutineFile = { key: string; fileName: string; contentType: string; uploadedAt: string };

export async function masterRoutine(db: D1Database): Promise<RoutineFile | null> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'masterRoutine'`).first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as RoutineFile;
    return v.key ? v : null;
  } catch {
    return null;
  }
}

/** Replaces the master routine (PDF, Word, Excel or a picture). The old file is removed from storage. */
export async function setMasterRoutine(db: D1Database, bucket: R2Bucket, actor: string, file: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await storeUpload(bucket, file, 'private/routine', { ...DOC_TYPES, ...IMAGE_TYPES }, 15 * 1024 * 1024);
  if (!r.ok) return { ok: false, error: `file_${r.reason}` };
  const before = await masterRoutine(db);
  const value: RoutineFile = { key: r.file.key, fileName: r.file.fileName, contentType: r.file.contentType, uploadedAt: new Date().toISOString() };
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_by) VALUES ('masterRoutine', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(JSON.stringify(value), actor)
    .run();
  if (before && before.key !== value.key) await bucket.delete(before.key);
  await log(db, actor, 'routine.upload', 'settings:masterRoutine', { fileName: value.fileName });
  return { ok: true };
}

/** Who may download the master routine: office staff, active teachers, and active offline students. */
export async function mayReadRoutine(db: D1Database, who: { staff: boolean; email: string | null }): Promise<boolean> {
  if (who.staff) return true;
  if (!who.email) return false;
  const ok = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM teachers WHERE lower(email) = lower(?1) AND status = 'active')
           OR EXISTS (SELECT 1 FROM offline_students s JOIN offline_enrollments e ON e.student_id = s.id
                      WHERE lower(s.email) = lower(?1) AND s.status = 'active' AND e.status = 'active') AS ok`,
    )
    .bind(who.email)
    .first<{ ok: number }>();
  return Boolean(ok?.ok);
}
