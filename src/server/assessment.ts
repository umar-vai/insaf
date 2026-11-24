import { log } from './admin';
import { examEligibleEnrollmentIds } from './academic';
import { isYmd } from '../lib/offline';
import { teaches } from './office';
import { offlineIdsForEmail } from './panels';
import { notifyStudents, studentsOfBatch } from './notifications';

// Exam gradebooks and homework.
//
// Gradebook: an Academic Full officer fixes the full and pass marks for an
// exam, which also freezes the list of examinees at that moment. Teachers of
// the batch (or academic staff) then enter a mark or "absent" for each
// examinee. Only when every examinee has one can the result be published, and
// a published result is never changed or hidden by cancelling the exam.
// Students and verified guardians see published results only.
//
// Homework: teachers write homework or lesson plans for their batch as drafts,
// publish them, and close them. Only the student themself (signed in with the
// student's own email) can submit an answer; a reviewed answer is locked.

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const clip = (x: unknown, max = 150) => String(x ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/** A whole number of up to four digits, Bangla digits allowed. */
export function wholeNumber(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  return /^\d{1,4}$/.test(s) ? Number(s) : null;
}

/** The batch an enrollment sits in now: its promotion in the active session, else where it was admitted. */
const CURRENT_BATCH = `coalesce((SELECT p.to_batch_id FROM academic_promotions p
  JOIN academic_sessions s ON s.id = p.to_session_id AND s.status = 'active'
  WHERE p.enrollment_id = e.id LIMIT 1), e.batch_id)`;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

// ---- Gradebook --------------------------------------------------------------

export type ExamAssessment = {
  examId: string;
  batchId: string;
  batchName: string;
  title: string;
  subject: string;
  examDate: string;
  examStatus: 'scheduled' | 'cancelled';
  rosterFrozen: number;
  maxMarks: number | null;
  passMarks: number | null;
  /** null: the gradebook is not set up yet. */
  status: 'draft' | 'published' | null;
  examinees: number;
  completed: number;
  publishedAt: string | null;
  assessorId: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string;
};

export type ExamMarkRow = {
  examId: string;
  enrollmentId: string;
  studentId: string;
  studentName: string;
  studentNo: number | null;
  roll: string;
  attendance: 'present' | 'absent' | null;
  obtained: number | null;
  comment: string | null;
};

export type PublishedResult = {
  examId: string;
  title: string;
  subject: string;
  examDate: string;
  batchName: string;
  studentId: string;
  studentName: string;
  studentNo: number | null;
  obtained: number | null;
  attendance: 'present' | 'absent';
  maxMarks: number;
  passMarks: number;
  comment: string;
  publishedAt: string;
};

export const percentScore = (score: number, max: number) => (max ? Math.round((score * 100) / max) : 0);

/** Pass or fail against the institution's own pass mark. No letter grades until the madrasa approves a scale. */
export const resultLabel = (score: number | null, pass: number, attendance: string) =>
  attendance === 'absent' ? 'অনুপস্থিত' : score === null ? 'অপ্রকাশিত' : score >= pass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ';

/** The pill colour for the same result. */
export const resultTone = (score: number | null, pass: number, attendance: string) =>
  attendance === 'absent' ? 'absent' : score === null ? 'draft' : score >= pass ? 'present' : 'failed';

const ASSESSMENT_SELECT = `SELECT x.id AS examId, x.batch_id AS batchId, b.name AS batchName, x.title, x.subject,
    x.exam_date AS examDate, x.status AS examStatus, x.roster_frozen AS rosterFrozen, p.max_marks AS maxMarks, p.pass_marks AS passMarks,
    p.status, p.published_at AS publishedAt, x.assessor_id AS assessorId,
    p.submitted_at AS submittedAt, p.submitted_by AS submittedBy, p.reviewed_at AS reviewedAt, p.reviewed_by AS reviewedBy, coalesce(p.review_note, '') AS reviewNote,
    (SELECT count(*) FROM assessment_examinees ee WHERE ee.exam_id = x.id) AS examinees,
    (SELECT count(*) FROM assessment_marks m WHERE m.exam_id = x.id) AS completed
  FROM offline_exams x JOIN offline_batches b ON b.id = x.batch_id
  LEFT JOIN assessment_policies p ON p.exam_id = x.id`;

export async function examAssessment(db: D1Database, examId: string): Promise<ExamAssessment | null> {
  return db.prepare(`${ASSESSMENT_SELECT} WHERE x.id = ?`).bind(examId).first<ExamAssessment>();
}

export async function listBatchAssessments(db: D1Database, batchId: string): Promise<ExamAssessment[]> {
  const { results } = await db
    .prepare(`${ASSESSMENT_SELECT} WHERE x.batch_id = ? ORDER BY x.exam_date DESC LIMIT 100`)
    .bind(batchId)
    .all<ExamAssessment>();
  return results;
}

/** Every batch's exams for the admin results page, newest first, optionally only those still needing work. */
export async function listAssessments(db: D1Database, opts: { pending?: boolean; limit?: number } = {}): Promise<ExamAssessment[]> {
  const where = opts.pending ? `WHERE x.status = 'scheduled' AND (p.status IS NULL OR p.status = 'draft')` : '';
  const { results } = await db
    .prepare(`${ASSESSMENT_SELECT} ${where} ORDER BY x.exam_date DESC, x.title LIMIT ?`)
    .bind(Math.min(opts.limit ?? 200, 500))
    .all<ExamAssessment>();
  return results;
}

/** Fixes full and pass marks and freezes the examinee list. Done once per exam. */
export async function configureAssessment(
  db: D1Database,
  actor: string,
  examId: string,
  maxInput: unknown,
  passInput: unknown,
  confirm: boolean,
): Promise<Result<number>> {
  const max = wholeNumber(maxInput);
  const pass = wholeNumber(passInput);
  if (!max || max > 1000 || pass === null || pass > max) return fail('marks');
  if (!confirm) return fail('confirm');
  const exam = await examAssessment(db, examId);
  if (!exam || exam.examStatus !== 'scheduled') return fail('exam');
  if (exam.status) return fail('already_configured');
  const ids = exam.rosterFrozen
    ? (await db.prepare('SELECT enrollment_id AS id FROM assessment_examinees WHERE exam_id = ?').bind(examId).all<{ id: string }>()).results.map((r) => r.id)
    : (await db.prepare(examEligibleEnrollmentIds).bind(exam.batchId, exam.examDate).all<{ id: string }>()).results.map((r) => r.id);
  if (!ids.length) return fail('empty_roster');
  if (ids.length > 1000) return fail('roster_too_large');
  const [policy] = await db.batch([
    db.prepare(`INSERT INTO assessment_policies (exam_id, max_marks, pass_marks, status, updated_by)
      SELECT ?1, ?2, ?3, 'draft', ?4 FROM offline_exams x WHERE x.id = ?1 AND x.status = 'scheduled'
      ON CONFLICT (exam_id) DO NOTHING`).bind(examId, max, pass, actor),
    db.prepare(`INSERT INTO assessment_examinees (exam_id, enrollment_id, captured_by)
      SELECT ?1, value, ?2 FROM json_each(?3)
      WHERE EXISTS (SELECT 1 FROM offline_exams x JOIN assessment_policies p ON p.exam_id = x.id
        WHERE x.id = ?1 AND x.status = 'scheduled' AND x.roster_frozen = 0 AND p.status = 'draft')
      ON CONFLICT (exam_id, enrollment_id) DO NOTHING`).bind(examId, actor, JSON.stringify(ids)),
    db.prepare("UPDATE offline_exams SET roster_frozen = 1 WHERE id = ? AND status = 'scheduled' AND EXISTS (SELECT 1 FROM assessment_policies WHERE exam_id = offline_exams.id)").bind(examId),
  ]);
  if (!policy?.meta.changes) return fail('already_configured');
  await log(db, actor, 'assessment.configure', `exam:${examId}`, { max, pass, examinees: ids.length });
  return { ok: true, value: ids.length };
}

export async function examRosterCandidates(db: D1Database, exam: ExamAssessment) {
  return (await db.prepare(`SELECT e.id, s.name, e.roll FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
    WHERE e.id IN (${examEligibleEnrollmentIds})
      AND NOT EXISTS (SELECT 1 FROM assessment_examinees ee WHERE ee.exam_id = ?3 AND ee.enrollment_id = e.id)
    ORDER BY s.student_no, s.name LIMIT 1000`).bind(exam.batchId, exam.examDate, exam.examId).all<{ id: string; name: string; roll: string }>()).results;
}

/** A late enrollment may join the frozen list before the exam, with the same exam fee. */
export async function addExamCandidate(db: D1Database, actor: string, examId: string, enrollmentId: string, today: string): Promise<Result<boolean>> {
  const exam = await examAssessment(db, examId);
  if (!exam?.rosterFrozen || exam.examStatus !== 'scheduled' || exam.status === 'published' || exam.submittedAt || exam.examDate < today) return fail('locked');
  const [added] = await db.batch([
    db.prepare(`INSERT INTO assessment_examinees (exam_id, enrollment_id, captured_by)
      SELECT ?3, e.id, ?4 FROM (${examEligibleEnrollmentIds}) e
      JOIN offline_exams x ON x.id = ?3 AND x.status = 'scheduled' AND x.roster_frozen = 1 AND x.exam_date >= ?6
      WHERE e.id = ?5 AND NOT EXISTS (SELECT 1 FROM assessment_policies WHERE exam_id = ?3 AND (status = 'published' OR submitted_at IS NOT NULL))
      AND (SELECT count(*) FROM assessment_examinees WHERE exam_id = ?3) < 1000
      ON CONFLICT (exam_id, enrollment_id) DO NOTHING`).bind(exam.batchId, exam.examDate, examId, actor, enrollmentId, today),
    db.prepare(`INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
      SELECT ?1, ee.enrollment_id, 'exam', 'পরীক্ষার ফি: ' || x.title, x.fee_minor, x.exam_date, 'exam:' || x.id, ?2
      FROM assessment_examinees ee JOIN offline_exams x ON x.id = ee.exam_id
      WHERE x.id = ?3 AND ee.enrollment_id = ?4 AND x.status = 'scheduled' AND x.fee_minor > 0 AND x.exam_date >= ?5
        AND NOT EXISTS (SELECT 1 FROM enrollment_assistance a WHERE a.enrollment_id = ee.enrollment_id AND a.kind = 'zakat' AND a.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM assessment_policies WHERE exam_id = ?3 AND (status = 'published' OR submitted_at IS NOT NULL))
        AND changes() = 1
      ON CONFLICT (enrollment_id, source_key) DO NOTHING`).bind(newId('chg'), actor, examId, enrollmentId, today),
  ]);
  if (!added?.meta.changes) return fail('not_eligible');
  await log(db, actor, 'assessment.roster.add', `exam:${examId}`, { enrollmentId });
  return { ok: true, value: true };
}

export async function correctPublishedMark(db: D1Database, actor: string, examId: string, input: MarkInput, reason: string): Promise<Result<boolean>> {
  const why = clip(reason, 300);
  if (why.length < 3) return fail('reason');
  const exam = await examAssessment(db, examId);
  if (!exam || exam.examStatus !== 'scheduled' || exam.status !== 'published' || !exam.maxMarks) return fail('locked');
  const mark = readMark(input, exam.maxMarks);
  if (mark === 'skip' || mark === 'invalid') return fail('marks');
  const revision = newId('rev');
  const [stored, changed] = await db.batch([
    db.prepare(`INSERT INTO assessment_mark_revisions (id, exam_id, enrollment_id, before_mark, after_mark, before_comment, after_comment, reason, revised_by)
      SELECT ?1, m.exam_id, m.enrollment_id, m.obtained, ?2, m.comment, ?3, ?4, ?5
      FROM assessment_marks m JOIN assessment_policies p ON p.exam_id = m.exam_id AND p.status = 'published'
      WHERE m.exam_id = ?6 AND m.enrollment_id = ?7 AND (m.obtained IS NOT ?2 OR m.comment <> ?3)`)
      .bind(revision, mark.obtained, mark.comment, why, actor, examId, input.enrollmentId),
    db.prepare(`UPDATE assessment_marks SET obtained = ?1, attendance = ?2, comment = ?3, marked_by = ?4, updated_at = ${NOW}
      WHERE exam_id = ?5 AND enrollment_id = ?6 AND EXISTS (SELECT 1 FROM assessment_mark_revisions WHERE id = ?7)`)
      .bind(mark.obtained, mark.obtained === null ? 'absent' : 'present', mark.comment, actor, examId, input.enrollmentId, revision),
  ]);
  if (!stored?.meta.changes || !changed?.meta.changes) return fail('no_change');
  await log(db, actor, 'assessment.result.correct', `exam:${examId}`, { enrollmentId: input.enrollmentId, revision, reason: why });
  const student = await db.prepare('SELECT student_id AS id FROM offline_enrollments WHERE id = ?').bind(input.enrollmentId).first<{ id: string }>();
  if (student) await notifyStudents(db, actor, [student.id], { title: 'পরীক্ষার ফল সংশোধন হয়েছে', link: '/account/offline/results', sourceKey: `result:${revision}` });
  return { ok: true, value: true };
}

/** The examinees with whatever has been entered for them, in roll order. */
export async function examMarks(db: D1Database, examId: string): Promise<ExamMarkRow[]> {
  const roll = `coalesce(nullif(p.next_roll,''), e.roll)`;
  const { results } = await db
    .prepare(
      `SELECT ee.exam_id AS examId, ee.enrollment_id AS enrollmentId, e.student_id AS studentId,
          s.name AS studentName, s.student_no AS studentNo, ${roll} AS roll,
          m.attendance, m.obtained, m.comment
        FROM assessment_examinees ee
        JOIN offline_enrollments e ON e.id = ee.enrollment_id
        JOIN offline_students s ON s.id = e.student_id
        LEFT JOIN academic_promotions p ON p.enrollment_id = e.id
          AND p.to_session_id = (SELECT id FROM academic_sessions WHERE status = 'active' LIMIT 1)
        LEFT JOIN assessment_marks m ON m.exam_id = ee.exam_id AND m.enrollment_id = ee.enrollment_id
        WHERE ee.exam_id = ?
        ORDER BY CASE WHEN ${roll} GLOB '[0-9]*' THEN CAST(${roll} AS INTEGER) ELSE 99999 END, ${roll}, s.name
        LIMIT 1000`,
    )
    .bind(examId)
    .all<ExamMarkRow>();
  return results;
}

export type MarkInput = { enrollmentId: string; obtained: unknown; absent: boolean; comment: unknown };

/**
 * The one statement that writes a mark. It only lands for a frozen examinee of
 * a scheduled exam whose gradebook is still a draft, so nothing can slip in
 * after publishing even if two people press save at the same time.
 */
// A named assessor takes precedence. Otherwise use matching subject teachers,
 // or the main class teacher when nobody has been assigned that subject.
const allowedExamTeacher = (id: string) => `EXISTS (
  SELECT 1 FROM offline_batches b JOIN teachers t ON t.id = ${id} AND t.status = 'active' AND t.role = 'teacher'
  WHERE b.id = x.batch_id AND ${teaches('t.id')} AND (
    x.assessor_id = t.id OR (x.assessor_id IS NULL AND (
      EXISTS (SELECT 1 FROM batch_teachers a WHERE a.batch_id = b.id AND a.teacher_id = t.id
        AND trim(x.subject) <> '' AND lower(trim(a.subject)) = lower(trim(x.subject))) OR
      (b.teacher_id = t.id AND NOT EXISTS (SELECT 1 FROM batch_teachers a JOIN teachers at ON at.id = a.teacher_id AND at.status = 'active' AND at.role = 'teacher'
        WHERE a.batch_id = b.id AND trim(x.subject) <> '' AND lower(trim(a.subject)) = lower(trim(x.subject))))
    ))
  ))`;

export async function teacherCanGrade(db: D1Database, examId: string, teacherId: string) {
  return Boolean(await db.prepare(`SELECT 1 FROM offline_exams x WHERE x.id = ?1 AND ${allowedExamTeacher('?2')}`).bind(examId, teacherId).first());
}

export async function assignedExamIds(db: D1Database, teacherId: string, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  const { results } = await db.prepare(`SELECT x.id FROM offline_exams x JOIN json_each(?1) j ON j.value = x.id
    WHERE ${allowedExamTeacher('?2')}`).bind(JSON.stringify(ids), teacherId).all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

export async function examAssessorChoices(db: D1Database, examId: string) {
  return (await db.prepare(`SELECT t.id, t.name, coalesce(bt.subject, t.subject) AS subject FROM offline_exams x
    JOIN offline_batches b ON b.id = x.batch_id JOIN teachers t ON ${teaches('t.id')}
    LEFT JOIN batch_teachers bt ON bt.batch_id = b.id AND bt.teacher_id = t.id
    WHERE x.id = ?1 AND t.status = 'active' AND t.role = 'teacher' ORDER BY t.name`).bind(examId).all<{ id: string; name: string; subject: string }>()).results;
}

export async function assignExamAssessor(db: D1Database, actor: string, examId: string, teacherId: string): Promise<Result<boolean>> {
  const r = await db.prepare(`UPDATE offline_exams SET assessor_id = ?1 WHERE id = ?2 AND status = 'scheduled'
    AND NOT EXISTS (SELECT 1 FROM assessment_policies p WHERE p.exam_id = ?2 AND (p.status = 'published' OR p.submitted_at IS NOT NULL))
    AND (?1 IS NULL OR EXISTS (
      SELECT 1 FROM offline_batches b JOIN teachers t ON t.id = ?1 AND t.status = 'active' AND t.role = 'teacher'
      WHERE b.id = offline_exams.batch_id AND ${teaches('t.id')}
    ))`).bind(teacherId || null, examId).run();
  if (!r.meta.changes) return fail('assessor');
  await log(db, actor, 'assessment.assessor', `exam:${examId}`, { teacherId });
  return { ok: true, value: true };
}

const allMarksEntered = `EXISTS (SELECT 1 FROM assessment_examinees e WHERE e.exam_id = assessment_policies.exam_id)
  AND NOT EXISTS (SELECT 1 FROM assessment_examinees e LEFT JOIN assessment_marks m ON m.exam_id = e.exam_id AND m.enrollment_id = e.enrollment_id
    WHERE e.exam_id = assessment_policies.exam_id AND m.enrollment_id IS NULL)`;

export async function submitAssessment(db: D1Database, actor: string, examId: string, teacherId: string | null = null): Promise<Result<boolean>> {
  const r = await db.prepare(`UPDATE assessment_policies SET submitted_at = ${NOW}, submitted_by = ?1, review_note = ''
    WHERE exam_id = ?2 AND status = 'draft' AND submitted_at IS NULL AND ${allMarksEntered}
    AND EXISTS (SELECT 1 FROM offline_exams x WHERE x.id = ?2 AND x.status = 'scheduled'
      AND (?3 IS NULL OR ${allowedExamTeacher('?3')}))`).bind(actor, examId, teacherId).run();
  if (!r.meta.changes) return fail('incomplete');
  await log(db, actor, 'assessment.submit', `exam:${examId}`);
  return { ok: true, value: true };
}

export async function reviewAssessment(db: D1Database, actor: string, examId: string, approve: boolean, noteInput: unknown): Promise<Result<boolean>> {
  const note = clip(noteInput, 300);
  if (!approve && note.length < 3) return fail('reason');
  const review = approve ? `reviewed_at = ${NOW}, reviewed_by = ?1` : 'submitted_at = NULL, submitted_by = NULL, reviewed_at = NULL, reviewed_by = NULL';
  const r = await db.prepare(`UPDATE assessment_policies SET ${review}, updated_by = ?1, review_note = ?2
    WHERE exam_id = ?3 AND status = 'draft' AND submitted_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM offline_exams x WHERE x.id = ?3 AND x.status = 'scheduled')`).bind(actor, note, examId).run();
  if (!r.meta.changes) return fail('locked');
  await log(db, actor, approve ? 'assessment.review.approve' : 'assessment.review.return', `exam:${examId}`, { note });
  return { ok: true, value: true };
}

const markStatement = (db: D1Database, actor: string, examId: string, enrollmentId: string, obtained: number | null, comment: string, teacherId: string | null = null) =>
  db
    .prepare(
      `INSERT INTO assessment_marks (exam_id, enrollment_id, obtained, attendance, comment, marked_by)
        SELECT ee.exam_id, ee.enrollment_id, ?, ?, ?, ?
        FROM assessment_examinees ee
        JOIN assessment_policies p ON p.exam_id = ee.exam_id AND p.status = 'draft' AND p.submitted_at IS NULL
        JOIN offline_exams x ON x.id = ee.exam_id AND x.status = 'scheduled'
        WHERE ee.exam_id = ?5 AND ee.enrollment_id = ?6 AND (?7 IS NULL OR ${allowedExamTeacher('?7')})
        ON CONFLICT (exam_id, enrollment_id) DO UPDATE SET obtained = excluded.obtained,
          attendance = excluded.attendance, comment = excluded.comment, marked_by = excluded.marked_by,
          updated_at = ${NOW}
        WHERE EXISTS (SELECT 1 FROM assessment_policies p WHERE p.exam_id = excluded.exam_id AND p.status = 'draft' AND p.submitted_at IS NULL)`,
    )
    .bind(obtained, obtained === null ? 'absent' : 'present', comment, actor, examId, enrollmentId, teacherId);

/** Checks one row of input against the exam's full marks. "skip" means the row was left blank. */
function readMark(input: MarkInput, maxMarks: number): { obtained: number | null; comment: string } | 'skip' | 'invalid' {
  const comment = clip(input.comment, 500);
  if (input.absent) return { obtained: null, comment };
  if (String(input.obtained ?? '').trim() === '') return 'skip';
  const obtained = wholeNumber(input.obtained);
  if (obtained === null || obtained > maxMarks) return 'invalid';
  return { obtained, comment };
}

/** One student's mark. */
export async function recordExamMark(
  db: D1Database,
  actor: string,
  examId: string,
  enrollmentId: string,
  obtainedInput: unknown,
  absent: boolean,
  commentInput: unknown,
): Promise<Result<boolean>> {
  const exam = await examAssessment(db, examId);
  if (!exam || exam.examStatus !== 'scheduled' || exam.status !== 'draft' || exam.submittedAt || !exam.maxMarks) return fail('locked');
  const mark = readMark({ enrollmentId, obtained: obtainedInput, absent, comment: commentInput }, exam.maxMarks);
  if (!enrollmentId || mark === 'skip' || mark === 'invalid') return fail('marks');
  const r = await markStatement(db, actor, examId, enrollmentId, mark.obtained, mark.comment).run();
  if (!r.meta.changes) return fail('not_eligible');
  await log(db, actor, 'assessment.mark', `exam:${examId}`, { enrollmentId, absent, obtained: mark.obtained });
  return { ok: true, value: true };
}

/**
 * The whole mark sheet in one save. Blank rows stay blank, unchanged rows are
 * not rewritten, and if any row is out of range nothing is saved so the
 * teacher can correct it without losing track of what went in.
 */
export async function saveExamMarks(
  db: D1Database,
  actor: string,
  examId: string,
  inputs: MarkInput[],
  teacherId: string | null = null,
): Promise<Result<number>> {
  const exam = await examAssessment(db, examId);
  if (!exam || exam.examStatus !== 'scheduled' || exam.status !== 'draft' || exam.submittedAt || !exam.maxMarks) return fail('locked');
  if (teacherId && !(await teacherCanGrade(db, examId, teacherId))) return fail('permission');
  const current = new Map((await examMarks(db, examId)).map((r) => [r.enrollmentId, r]));
  const changes: { enrollmentId: string; obtained: number | null; comment: string }[] = [];
  for (const input of inputs.slice(0, 1000)) {
    const before = current.get(input.enrollmentId);
    if (!before) continue;
    const mark = readMark(input, exam.maxMarks);
    if (mark === 'skip') continue;
    if (mark === 'invalid') return fail('marks');
    const attendance = mark.obtained === null ? 'absent' : 'present';
    if (before.attendance === attendance && before.obtained === mark.obtained && (before.comment ?? '') === mark.comment) continue;
    changes.push({ enrollmentId: input.enrollmentId, ...mark });
  }
  if (changes.length) {
    const writes = await db.batch(changes.map((c) => markStatement(db, actor, examId, c.enrollmentId, c.obtained, c.comment, teacherId)));
    if (writes.some((r) => !r.meta.changes)) return fail('locked');
    await log(db, actor, 'assessment.marks', `exam:${examId}`, {
      saved: changes.length,
      marks: changes.slice(0, 60).map((c) => [c.enrollmentId, c.obtained ?? 'absent']),
    });
  }
  return { ok: true, value: changes.length };
}

/** Reads the mark sheet form: obtained_<id>, absent_<id>, comment_<id> for each examinee. */
export function markInputsFromForm(form: FormData): MarkInput[] {
  const ids = form.getAll('enrollmentId').map(String);
  return ids.map((id) => ({
    enrollmentId: id,
    obtained: form.get(`obtained_${id}`),
    absent: form.get(`absent_${id}`) === 'yes',
    comment: form.get(`comment_${id}`),
  }));
}

/** Publishes only when every frozen examinee has a mark or is marked absent. */
export async function publishAssessment(db: D1Database, actor: string, examId: string, requireReview = false): Promise<Result<boolean>> {
  const out = await db
    .prepare(
      `UPDATE assessment_policies SET status = 'published', published_by = ?, published_at = ${NOW}, updated_by = ?
        WHERE exam_id = ? AND status = 'draft'
        AND (? = 0 OR (submitted_at IS NOT NULL AND reviewed_at IS NOT NULL))
        AND ${allMarksEntered}
        AND EXISTS (SELECT 1 FROM offline_exams x WHERE x.id = assessment_policies.exam_id AND x.status = 'scheduled')`,
    )
    .bind(actor, actor, examId, Number(requireReview))
    .run();
  if (!out.meta.changes) return fail('incomplete');
  await log(db, actor, 'assessment.publish', `exam:${examId}`);
  const { results: who } = await db
    .prepare('SELECT DISTINCT e.student_id AS id FROM assessment_examinees x JOIN offline_enrollments e ON e.id = x.enrollment_id WHERE x.exam_id = ?')
    .bind(examId)
    .all<{ id: string }>();
  await notifyStudents(db, actor, who.map((w) => w.id), { title: 'পরীক্ষার ফল প্রকাশিত হয়েছে', link: '/account/offline/results', sourceKey: `result:${examId}` });
  return { ok: true, value: true };
}

/** Published results for the signed-in student, or the children a verified guardian may see. */
export async function publishedResultsForEmail(db: D1Database, email: string, range?: { from: string; to: string }): Promise<PublishedResult[]> {
  const ids = await offlineIdsForEmail(db, email);
  const out: PublishedResult[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { results } = await db
      .prepare(
        `SELECT x.id AS examId, x.title, x.subject, x.exam_date AS examDate, b.name AS batchName,
            s.id AS studentId, s.name AS studentName, s.student_no AS studentNo, m.obtained, m.attendance,
            p.max_marks AS maxMarks, p.pass_marks AS passMarks, m.comment, p.published_at AS publishedAt
          FROM assessment_marks m
          JOIN assessment_policies p ON p.exam_id = m.exam_id AND p.status = 'published'
          JOIN offline_exams x ON x.id = p.exam_id AND x.status = 'scheduled'
          JOIN offline_batches b ON b.id = x.batch_id
          JOIN offline_enrollments e ON e.id = m.enrollment_id
          JOIN offline_students s ON s.id = e.student_id
          WHERE s.status = 'active' AND s.id IN (${placeholders(chunk.length)})
          AND x.exam_date BETWEEN ? AND ? ORDER BY x.exam_date DESC, x.title, x.id LIMIT 501`,
      )
      .bind(...chunk, range?.from ?? '0000-01-01', range?.to ?? '9999-12-31')
      .all<PublishedResult>();
    out.push(...results);
  }
  return out.sort((a, b) => b.examDate.localeCompare(a.examDate)).slice(0, range ? 501 : 500);
}

// ---- Homework and lesson plans ----------------------------------------------

export type Assignment = {
  id: string;
  batchId: string;
  batchName: string;
  title: string;
  details: string;
  kind: 'homework' | 'lesson';
  dueOn: string;
  status: 'draft' | 'published' | 'closed';
  createdBy: string;
  createdAt: string;
  submissions: number;
  reviewed: number;
};

export type HomeworkSubmission = {
  assignmentId: string;
  enrollmentId: string;
  studentId: string;
  studentName: string;
  studentNo: number | null;
  body: string;
  state: 'submitted' | 'reviewed';
  score: number | null;
  feedback: string;
  submittedAt: string;
  reviewedAt: string | null;
};

export type MyHomework = Assignment & {
  enrollmentId: string;
  studentName: string;
  studentId: string;
  body: string | null;
  submissionState: 'submitted' | 'reviewed' | null;
  score: number | null;
  feedback: string | null;
  submittedAt: string | null;
};

export const homeworkKindBn = (kind: Assignment['kind']) => (kind === 'lesson' ? 'পাঠ পরিকল্পনা' : 'হোমওয়ার্ক');
export const assignmentStatusBn = (status: Assignment['status']) =>
  status === 'draft' ? 'খসড়া' : status === 'published' ? 'প্রকাশিত' : 'বন্ধ';

const ASSIGNMENT_SELECT = `SELECT a.id, a.batch_id AS batchId, b.name AS batchName, a.title, a.details, a.kind,
    a.due_on AS dueOn, a.status, a.created_by AS createdBy, a.created_at AS createdAt,
    (SELECT count(*) FROM homework_submissions z WHERE z.assignment_id = a.id) AS submissions,
    (SELECT count(*) FROM homework_submissions z WHERE z.assignment_id = a.id AND z.state = 'reviewed') AS reviewed
  FROM homework_assignments a JOIN offline_batches b ON b.id = a.batch_id`;

/** A batch's homework; all states for staff and teachers, published only otherwise. */
export async function assignmentsForBatch(db: D1Database, batchId: string, all: boolean): Promise<Assignment[]> {
  const { results } = await db
    .prepare(`${ASSIGNMENT_SELECT} WHERE a.batch_id = ? ${all ? '' : "AND a.status = 'published'"}
      ORDER BY a.due_on DESC, a.created_at DESC LIMIT 100`)
    .bind(batchId)
    .all<Assignment>();
  return results;
}

export async function getAssignment(db: D1Database, id: string): Promise<Assignment | null> {
  return db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).bind(id).first<Assignment>();
}

/** Per batch counts for the admin overview, in one query. */
export async function assignmentCountsByBatch(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT a.batch_id AS batchId, count(*) AS total,
          sum(a.status = 'published') AS published,
          (SELECT count(*) FROM homework_submissions z JOIN homework_assignments y ON y.id = z.assignment_id
            WHERE y.batch_id = a.batch_id AND z.state = 'submitted') AS waiting
        FROM homework_assignments a GROUP BY a.batch_id`,
    )
    .all<{ batchId: string; total: number; published: number; waiting: number }>();
  return new Map(results.map((r) => [r.batchId, r]));
}

export async function createAssignment(
  db: D1Database,
  actor: string,
  batchId: string,
  input: { title: string; details: string; dueOn: string; kind: 'homework' | 'lesson' },
): Promise<Result<string>> {
  const title = clip(input.title, 160);
  const details = clip(input.details, 4000);
  if (title.length < 2 || !isYmd(input.dueOn) || !['homework', 'lesson'].includes(input.kind) || !batchId) return fail('invalid');
  const batch = await db.prepare("SELECT 1 FROM offline_batches WHERE id = ? AND status = 'active'").bind(batchId).first();
  if (!batch) return fail('batch');
  const id = newId('hwa');
  await db
    .prepare(`INSERT INTO homework_assignments (id, batch_id, title, details, kind, due_on, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`)
    .bind(id, batchId, title, details, input.kind, input.dueOn, actor)
    .run();
  await log(db, actor, 'homework.create', `assignment:${id}`, { batchId, kind: input.kind, dueOn: input.dueOn });
  return { ok: true, value: id };
}

export async function publishAssignment(db: D1Database, actor: string, id: string, batchId: string): Promise<Result<boolean>> {
  const r = await db
    .prepare(`UPDATE homework_assignments SET status = 'published', published_at = ${NOW}
      WHERE id = ? AND batch_id = ? AND status = 'draft'`)
    .bind(id, batchId)
    .run();
  if (!r.meta.changes) return fail('locked');
  await log(db, actor, 'homework.publish', `assignment:${id}`, { batchId });
  const a = await db.prepare('SELECT title, kind FROM homework_assignments WHERE id = ?').bind(id).first<{ title: string; kind: string }>();
  await notifyStudents(db, actor, await studentsOfBatch(db, batchId), {
    title: `${a?.kind === 'lesson' ? 'নতুন পাঠ' : 'নতুন হোমওয়ার্ক'}: ${a?.title ?? ''}`,
    link: '/account/offline/homework',
    sourceKey: `homework:${id}`,
  });
  return { ok: true, value: true };
}

export async function closeAssignment(db: D1Database, actor: string, id: string, batchId: string): Promise<Result<boolean>> {
  const r = await db
    .prepare("UPDATE homework_assignments SET status = 'closed' WHERE id = ? AND batch_id = ? AND status = 'published'")
    .bind(id, batchId)
    .run();
  if (!r.meta.changes) return fail('locked');
  await log(db, actor, 'homework.close', `assignment:${id}`, { batchId });
  return { ok: true, value: true };
}

export async function assignmentSubmissions(db: D1Database, id: string, batchId: string): Promise<HomeworkSubmission[]> {
  const { results } = await db
    .prepare(
      `SELECT z.assignment_id AS assignmentId, z.enrollment_id AS enrollmentId, e.student_id AS studentId,
          s.name AS studentName, s.student_no AS studentNo, z.body, z.state, z.score, z.feedback,
          z.submitted_at AS submittedAt, z.reviewed_at AS reviewedAt
        FROM homework_submissions z JOIN homework_assignments a ON a.id = z.assignment_id
        JOIN offline_enrollments e ON e.id = z.enrollment_id JOIN offline_students s ON s.id = e.student_id
        WHERE z.assignment_id = ? AND a.batch_id = ?
        ORDER BY z.state = 'reviewed', z.submitted_at DESC LIMIT 400`,
    )
    .bind(id, batchId)
    .all<HomeworkSubmission>();
  return results;
}

/** Published and closed work for the signed-in student's (or verified guardian's children's) current batches. */
export async function homeworkForEmail(db: D1Database, email: string): Promise<MyHomework[]> {
  const ids = await offlineIdsForEmail(db, email);
  const rows: MyHomework[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { results } = await db
      .prepare(
        `SELECT a.id, a.batch_id AS batchId, b.name AS batchName, a.title, a.details, a.kind, a.due_on AS dueOn,
            a.status, a.created_by AS createdBy, a.created_at AS createdAt, 0 AS submissions, 0 AS reviewed,
            e.id AS enrollmentId, e.student_id AS studentId, s.name AS studentName,
            z.body, z.state AS submissionState, z.score, z.feedback, z.submitted_at AS submittedAt
          FROM homework_assignments a JOIN offline_batches b ON b.id = a.batch_id
          JOIN offline_enrollments e ON ${CURRENT_BATCH} = a.batch_id AND e.status = 'active'
          JOIN offline_students s ON s.id = e.student_id AND s.status = 'active'
          LEFT JOIN homework_submissions z ON z.assignment_id = a.id AND z.enrollment_id = e.id
          WHERE s.id IN (${placeholders(chunk.length)}) AND a.status IN ('published','closed')
          ORDER BY a.due_on DESC, a.created_at DESC LIMIT 250`,
      )
      .bind(...chunk)
      .all<MyHomework>();
    rows.push(...results);
  }
  return rows.sort((a, b) => b.dueOn.localeCompare(a.dueOn)).slice(0, 500);
}

/** The student's own answer. A guardian's account cannot submit: the student's own email must be signed in. */
export async function submitHomework(
  db: D1Database,
  actorEmail: string,
  assignmentId: string,
  enrollmentId: string,
  answer: unknown,
  today: string,
): Promise<Result<boolean>> {
  const body = clip(answer, 5000);
  if (body.length < 2 || !isYmd(today)) return fail('answer');
  const email = actorEmail.trim().toLowerCase();
  const r = await db
    .prepare(
      `INSERT INTO homework_submissions (assignment_id, enrollment_id, body, submitted_by)
        SELECT a.id, e.id, ?, ? FROM homework_assignments a
        JOIN offline_enrollments e ON ${CURRENT_BATCH} = a.batch_id
        JOIN offline_students s ON s.id = e.student_id
        WHERE a.id = ? AND e.id = ? AND a.status = 'published' AND a.kind = 'homework'
          AND a.due_on >= ? AND s.status = 'active' AND e.status = 'active' AND lower(s.email) = ?
        ON CONFLICT (assignment_id, enrollment_id) DO UPDATE SET body = excluded.body,
          submitted_at = ${NOW}, submitted_by = excluded.submitted_by
        WHERE homework_submissions.state = 'submitted'
          AND EXISTS (SELECT 1 FROM homework_assignments a WHERE a.id = excluded.assignment_id AND a.status = 'published' AND a.due_on >= ?)`,
    )
    .bind(body, email, assignmentId, enrollmentId, today, email, today)
    .run();
  if (!r.meta.changes) return fail('not_allowed');
  await log(db, email, 'homework.submit', `assignment:${assignmentId}`, { enrollmentId });
  return { ok: true, value: true };
}

/** Feedback and an optional score out of 100. Once reviewed, the answer and review are locked. */
export async function reviewHomework(
  db: D1Database,
  actor: string,
  assignmentId: string,
  enrollmentId: string,
  feedbackInput: unknown,
  scoreInput: unknown,
): Promise<Result<boolean>> {
  const feedback = clip(feedbackInput, 1200);
  const blank = String(scoreInput ?? '').trim() === '';
  const score = blank ? null : wholeNumber(scoreInput);
  if (!blank && (score === null || score > 100)) return fail('score');
  if (!feedback && score === null) return fail('feedback');
  const r = await db
    .prepare(
      `UPDATE homework_submissions SET state = 'reviewed', feedback = ?, score = ?, reviewed_by = ?, reviewed_at = ${NOW}
        WHERE assignment_id = ? AND enrollment_id = ? AND state = 'submitted'
        AND EXISTS (SELECT 1 FROM homework_assignments a WHERE a.id = ? AND a.status IN ('published','closed'))`,
    )
    .bind(feedback, score, actor, assignmentId, enrollmentId, assignmentId)
    .run();
  if (!r.meta.changes) return fail('locked');
  await log(db, actor, 'homework.review', `assignment:${assignmentId}`, { enrollmentId, score });
  return { ok: true, value: true };
}
