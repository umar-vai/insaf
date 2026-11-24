import { parseStudentNo } from './offline';

type QueueRow = {
  id: string; no: number | null; source: 'application' | 'inquiry' | 'desk'; studentName: string; phone: string;
  groupName: string; createdAt: string; status: string; studentId: string | null; duplicate: number;
};

export async function admissionQueue(db: D1Database, source: string, query: string): Promise<QueueRow[]> {
  const term = query.trim().slice(0, 100).toLowerCase();
  const appNo = /^(?:ap-?)?0*(\d{1,6})$/i.exec(term);
  const studentNo = parseStudentNo(term);
  const { results } = await db.prepare(`WITH intake AS (
    SELECT a.id, a.app_no AS no, 'application' AS source, a.student_name AS studentName, a.phone, a.desired_class AS groupName,
      a.created_at AS createdAt, a.status, a.student_id AS studentId,
      EXISTS (SELECT 1 FROM admission_applications dupe
        WHERE dupe.id <> a.id AND dupe.phone = a.phone AND dupe.birth_date = a.birth_date
        AND lower(trim(dupe.student_name)) = lower(trim(a.student_name)) AND dupe.status <> 'rejected') AS duplicate
    FROM admission_applications a
    UNION ALL
    SELECT q.id, s.student_no, 'inquiry', q.student_name, q.phone, q.desired_class, q.created_at, q.status, q.student_id, 0
      FROM admission_inquiries q LEFT JOIN offline_students s ON s.id = q.student_id
    UNION ALL
    SELECT s.id, s.student_no, 'desk', s.name, s.phone,
      coalesce((SELECT c.title FROM offline_enrollments e JOIN offline_courses c ON c.id = e.course_id
        WHERE e.student_id = s.id AND e.status = 'active' ORDER BY e.start_date DESC, e.id LIMIT 1), ''),
      s.created_at,
      CASE WHEN s.status = 'blocked' THEN 'blocked' WHEN EXISTS (SELECT 1 FROM offline_enrollments e WHERE e.student_id = s.id AND e.status = 'active' AND e.batch_id IS NOT NULL)
        THEN 'accepted' ELSE 'placement' END, s.id, 0
    FROM offline_students s WHERE s.application_id IS NULL AND NOT EXISTS (SELECT 1 FROM admission_inquiries q WHERE q.student_id = s.id)
    )
    SELECT * FROM intake WHERE (?1 = '' OR source = ?1)
    AND (?2 = '' OR instr(lower(studentName), ?2) > 0 OR instr(phone, ?2) > 0 OR (source = 'application' AND no = ?3)
      OR (source <> 'application' AND no = ?4))
    ORDER BY (status IN ('pending','new','contacted','placement')) DESC, createdAt DESC, id LIMIT 200`)
    .bind(source, term, appNo ? Number(appNo[1]) : null, studentNo).all<QueueRow>();
  return results;
}
