import { log } from './admin';
import { EFFECTIVE_BATCH, type Result } from './ops-util';

type Criteria = { examId: string; batchId: string; sessionId: string };
type Row = {
  enrollmentId: string; studentId: string; studentName: string; studentNo: number; fromBatchId: string;
  obtained: number | null; passMarks: number; attendance: 'present' | 'absent'; already: number;
};

const compatible = `FROM offline_exams x
  JOIN assessment_policies q ON q.exam_id = x.id AND q.status = 'published'
  JOIN offline_batches source ON source.id = x.batch_id
  JOIN offline_batches target ON target.id = ?2 AND target.course_id = source.course_id AND target.status = 'active' AND target.id <> source.id
  JOIN academic_batch_sessions bs ON bs.batch_id = target.id AND bs.session_id = ?3
  JOIN academic_sessions ss ON ss.id = bs.session_id AND ss.status = 'planned' AND ss.starts_on > x.exam_date
  WHERE x.id = ?1 AND x.status = 'scheduled'`;
const candidates = `SELECT m.enrollment_id AS enrollmentId, s.id AS studentId, s.name AS studentName,
  s.student_no AS studentNo, x.batch_id AS fromBatchId, m.obtained, x.passMarks, m.attendance,
  EXISTS (SELECT 1 FROM academic_promotions p WHERE p.enrollment_id = e.id AND p.to_session_id = ?3) AS already
  FROM (SELECT x.id, x.batch_id, x.exam_date, q.pass_marks AS passMarks ${compatible}) x
  JOIN assessment_marks m ON m.exam_id = x.id
  JOIN offline_enrollments e ON e.id = m.enrollment_id AND e.status = 'active'
  JOIN offline_students s ON s.id = e.student_id AND s.status = 'active'
  WHERE ${EFFECTIVE_BATCH} = x.batch_id`;

export const eligibleForResultPromotion = (r: Row) => !r.already && r.attendance === 'present' && r.obtained !== null && r.obtained >= r.passMarks;

export async function resultPromotionPreview(db: D1Database, v: Criteria): Promise<Result<Row[]>> {
  const target = await db.prepare(`SELECT 1 ${compatible}`).bind(v.examId, v.batchId, v.sessionId).first();
  if (!target) return { ok: false, error: 'target' };
  const { results } = await db.prepare(`${candidates} ORDER BY s.student_no, s.name`).bind(v.examId, v.batchId, v.sessionId).all<Row>();
  return { ok: true, value: results };
}

export async function approveResultPromotions(db: D1Database, actor: string, v: Criteria, ids: string[]): Promise<Result<number>> {
  const selected = [...new Set(ids)];
  if (!selected.length || selected.length > 100 || selected.some((id) => !/^[\w-]{1,40}$/.test(id))) return { ok: false, error: 'choose' };
  // Validate the published marks, current placement and planned session in the same write.
  const { meta } = await db.prepare(`WITH ready AS (
    SELECT c.* FROM (${candidates}) c JOIN json_each(?4) j ON c.enrollmentId = j.value
    WHERE c.already = 0 AND c.attendance = 'present' AND c.obtained >= c.passMarks
  )
  INSERT INTO academic_promotions (id, enrollment_id, student_id, from_batch_id, to_batch_id, to_session_id, next_roll, created_by, qualifying_exam_id, reviewed_application)
  SELECT 'acp_' || lower(hex(randomblob(8))), enrollmentId, studentId, fromBatchId, ?2, ?3, '', ?5, ?1, 1
  FROM ready WHERE (SELECT count(*) FROM ready) = ?6`).bind(v.examId, v.batchId, v.sessionId, JSON.stringify(selected), actor, selected.length).run();
  if (meta.changes !== selected.length) return { ok: false, error: 'changed' };
  await log(db, actor, 'academic.promotion.by_result', `academic_session:${v.sessionId}`, { examId: v.examId, target: v.batchId, count: selected.length });
  return { ok: true, value: selected.length };
}
