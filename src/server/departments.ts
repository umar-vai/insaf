import { log } from './admin';
import { longText, text, type Result } from './ops-util';

// Departments (বিভাগ) are the offline courses. The ones marked public show on
// the website and take online applications; the rest stay office only. Counts
// and income come from real enrollments and recorded payments, never typed in.

export type PublicDepartment = { id: string; slug: string; title: string; summary: string };

/** Departments shown on the site and offered on the admission form, in the owner's order. */
export async function publicDepartments(db: D1Database): Promise<PublicDepartment[]> {
  const { results } = await db
    .prepare("SELECT id, coalesce(slug, id) AS slug, title, summary FROM offline_courses WHERE is_public = 1 AND status = 'active' ORDER BY sort_order, title")
    .all<PublicDepartment>();
  return results;
}

export type DepartmentRow = {
  id: string;
  title: string;
  summary: string;
  slug: string | null;
  sortOrder: number;
  isPublic: number;
  status: 'active' | 'archived';
  students: number;
  pending: number;
  applications: number;
  incomeMinor: number;
};

/** Every department with its live numbers: active students, applications and money received. */
export async function departmentRows(db: D1Database): Promise<DepartmentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.title, c.summary, c.slug, c.sort_order AS sortOrder, c.is_public AS isPublic, c.status,
        (SELECT count(*) FROM offline_enrollments e WHERE e.course_id = c.id AND e.status = 'active') AS students,
        (SELECT count(*) FROM admission_applications a WHERE a.course_id = c.id AND a.status = 'pending') AS pending,
        (SELECT count(*) FROM admission_applications a WHERE a.course_id = c.id) AS applications,
        (SELECT coalesce(sum(p.amount_minor), 0) FROM offline_payments p JOIN offline_enrollments e ON e.id = p.enrollment_id
           WHERE e.course_id = c.id AND p.voided_at IS NULL) AS incomeMinor
       FROM offline_courses c ORDER BY c.is_public DESC, c.sort_order, c.title`,
    )
    .all<DepartmentRow>();
  return results;
}

export type DepartmentStudent = { enrollmentId: string; studentId: string; studentNo: number | null; name: string; phone: string; roll: string; status: string; paidMinor: number };

export async function departmentStudents(db: D1Database, courseId: string): Promise<DepartmentStudent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS enrollmentId, s.id AS studentId, s.student_no AS studentNo, s.name, s.phone, e.roll, e.status,
        (SELECT coalesce(sum(p.amount_minor), 0) FROM offline_payments p WHERE p.enrollment_id = e.id AND p.voided_at IS NULL) AS paidMinor
       FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
       WHERE e.course_id = ? ORDER BY e.status, s.student_no, s.name`,
    )
    .bind(courseId)
    .all<DepartmentStudent>();
  return results;
}

export type DepartmentApplicant = { id: string; appNo: number; studentName: string; phone: string; status: string; createdAt: string };

export async function departmentApplicants(db: D1Database, courseId: string, limit = 200): Promise<DepartmentApplicant[]> {
  const { results } = await db
    .prepare('SELECT id, app_no AS appNo, student_name AS studentName, phone, status, created_at AS createdAt FROM admission_applications WHERE course_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(courseId, limit)
    .all<DepartmentApplicant>();
  return results;
}

export type PublicSettings = { summary: string; sortOrder: number; isPublic: boolean };

export function parsePublicSettings(form: FormData): Result<PublicSettings> {
  const sort = Number(text(form, 'sortOrder', 4) || '0');
  if (!Number.isInteger(sort) || sort < 0 || sort > 999) return { ok: false, error: 'sortOrder' };
  const summary = longText(form, 'summary', 600);
  if (/[<>]/.test(summary)) return { ok: false, error: 'chars' };
  return { ok: true, value: { summary, sortOrder: sort, isPublic: form.get('isPublic') === 'on' } };
}

/** What the website says about a department, its order, and whether it takes applications. */
export async function savePublicSettings(db: D1Database, actor: string, id: string, v: PublicSettings): Promise<boolean> {
  const r = await db
    .prepare('UPDATE offline_courses SET summary = ?, sort_order = ?, is_public = ? WHERE id = ?')
    .bind(v.summary, v.sortOrder, v.isPublic ? 1 : 0, id)
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'department.public', `offline_course:${id}`, { isPublic: v.isPublic, sortOrder: v.sortOrder });
  return true;
}

/** Every active department, public or not. The office may place an applicant in any of them. */
export async function allDepartments(db: D1Database): Promise<(PublicDepartment)[]> {
  const { results } = await db
    .prepare("SELECT id, coalesce(slug, id) AS slug, title, summary FROM offline_courses WHERE status = 'active' ORDER BY is_public DESC, sort_order, title")
    .all<PublicDepartment>();
  return results;
}
