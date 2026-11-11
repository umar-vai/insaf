import { log } from './admin';
import { DOC_TYPES, storeUpload } from './files';
import { getBatch, NOTICE_SELECT, teaches, type Batch, type Notice } from './office';
import { getOfflineStudent } from './offline';
import { parseDays, weekday } from '../lib/offline';
import { currentStudent, type Student } from './students';
import type { SessionEnv } from './session';

/** The signed-in account and, if it is a working teacher, the teacher. */
export async function teacherSession(db: D1Database, env: SessionEnv, cookie: string | null): Promise<{ me: Student | null; teacher: TeacherMe | null }> {
  const me = await currentStudent(db, env, cookie);
  return { me, teacher: me ? await teacherForEmail(db, me.email) : null };
}

// Who a signed-in website account is in the office: a teacher (teachers.email)
// and/or one or more offline students (offline_students.email). The office
// types the Gmail; signing in with Google proves the person owns it.

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

export type TeacherMe = { id: string; name: string; phone: string; email: string; subject: string };

export async function teacherForEmail(db: D1Database, email: string): Promise<TeacherMe | null> {
  if (!email) return null;
  return db
    .prepare(`SELECT id, name, phone, email, subject FROM teachers WHERE lower(email) = lower(?) AND status = 'active' LIMIT 1`)
    .bind(email)
    .first<TeacherMe>();
}

/** Offline student records with this email (brothers and sisters may share one). */
export async function offlineIdsForEmail(db: D1Database, email: string): Promise<string[]> {
  if (!email) return [];
  const { results } = await db
    .prepare(`SELECT s.id FROM offline_students s WHERE s.status='active' AND (
      lower(s.email) = lower(?1) OR EXISTS (
        SELECT 1 FROM academic_guardian_links g JOIN students a ON lower(a.email)=lower(g.guardian_email)
        WHERE g.student_id=s.id AND g.status='active' AND lower(g.guardian_email)=lower(?1) AND a.google_sub IS NOT NULL
      )
    ) ORDER BY s.student_no`)
    .bind(email)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function teacherBatchIds(db: D1Database, teacherId: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT b.id FROM offline_batches b WHERE ${teaches('?1')} AND b.status = 'active'`).bind(teacherId).all<{ id: string }>();
  return results.map((r) => r.id);
}

/** The batch, only if this teacher teaches it now. */
export async function batchForTeacher(db: D1Database, teacherId: string, batchId: string): Promise<Batch | null> {
  const b = await getBatch(db, batchId);
  if (!b || b.status !== 'active') return null;
  if (b.teacherId === teacherId) return b;
  const extra = await db.prepare('SELECT 1 AS ok FROM batch_teachers WHERE batch_id = ? AND teacher_id = ?').bind(batchId, teacherId).first();
  return extra ? b : null;
}

// ---- The offline student's own view ----------------------------------------------

export async function studentPanel(db: D1Database, email: string, today: string) {
  const ids = await offlineIdsForEmail(db, email);
  const people = (await Promise.all(ids.map((id) => getOfflineStudent(db, id, today)))).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const raw = people.flatMap((p) => p.enrollments.map((e) => ({ ...e, studentName: p.student.name })));
  // Promotions override only academic placement in the active session;
  // every original enrollment and its financial ledger remain unchanged.
  const placementRows: {enrollmentId:string;batchId:string;nextRoll:string;batchName:string}[] = [];
  // Read only this signed-in family's placements, not every student in the school.
  for(let i=0;i<raw.length;i+=90){
    const ids=raw.slice(i,i+90).map(e=>e.id);
    if(!ids.length)continue;
    const placeholders=ids.map(()=>'?').join(',');
    const {results}=await db.prepare(`SELECT p.enrollment_id AS enrollmentId, p.to_batch_id AS batchId,
      p.next_roll AS nextRoll, b.name AS batchName
      FROM academic_promotions p JOIN academic_sessions s ON s.id=p.to_session_id AND s.status='active'
      JOIN offline_batches b ON b.id=p.to_batch_id WHERE p.enrollment_id IN (${placeholders})`)
      .bind(...ids).all<{enrollmentId:string;batchId:string;nextRoll:string;batchName:string}>();
    placementRows.push(...results);
  }
  const overrides = new Map(placementRows.map(p => [p.enrollmentId,p]));
  const enrollments = raw.map(e => { const p=overrides.get(e.id);return p?{...e,batchId:p.batchId,batch:p.batchName,roll:p.nextRoll||e.roll}:e; });
  const batchIds = [...new Set(enrollments.filter((e) => e.status === 'active' && e.batchId).map((e) => e.batchId!))];
  const batches = (await Promise.all(batchIds.map((id) => getBatch(db, id)))).filter((b): b is Batch => Boolean(b));
  return {
    people,
    enrollments,
    batches,
    payments: people.flatMap((p) => p.payments.map((x) => ({ ...x, courseTitle: p.enrollments.find((e) => e.id === x.enrollmentId)?.courseTitle ?? '' }))),
  };
}

/** The next time one of these batches meets, from today (inclusive). */
export function nextClass(batches: Batch[], today: string, nowHHMM: string): { batch: Batch; day: string } | null {
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const todays = batches
      .filter((b) => b.status === 'active' && parseDays(b.days).includes(weekday(day)) && (i > 0 || !b.endTime || b.endTime > nowHHMM))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    if (todays[0]) return { batch: todays[0], day };
  }
  return null;
}

/**
 * Published offline notices for a student or a teacher: for everyone, for
 * all students or all teachers, for their batches, or for them alone
 * (offlineIds: the student's records; teacherId: the teacher).
 */
export async function officeNotices(
  db: D1Database,
  who: 'student' | 'teacher',
  batchIds: string[],
  limit = 8,
  offlineIds: string[] = [],
  teacherId: string | null = null,
): Promise<Notice[]> {
  const audience = who === 'student' ? 'offline_students' : 'offline_teachers';
  const list = (ids: string[]) => ids.map(() => '?').join(',');
  const own = who === 'student' ? offlineIds : teacherId ? [teacherId] : [];
  const { results } = await db
    .prepare(
      `${NOTICE_SELECT}
       WHERE n.status = 'published' AND (n.audience IN ('offline', ?)
         ${batchIds.length ? `OR (n.audience = 'batch' AND n.target_id IN (${list(batchIds)}))` : ''}
         ${own.length ? `OR (n.audience = '${who === 'student' ? 'offline_student' : 'teacher'}' AND n.target_id IN (${list(own)}))` : ''})
       ORDER BY n.pinned DESC, n.created_at DESC LIMIT ?`,
    )
    .bind(audience, ...batchIds, ...own, limit)
    .all<Notice>();
  return results;
}

// ---- Batch materials -----------------------------------------------------------------

export type Material = {
  id: string;
  batchId: string;
  batchName: string;
  title: string;
  url: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  createdBy: string;
  hidden: number;
  createdAt: string;
};

export async function listMaterials(db: D1Database, batchIds: string[], includeHidden = false): Promise<Material[]> {
  if (!batchIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT m.id, m.batch_id AS batchId, b.name AS batchName, m.title, m.url, m.file_name AS fileName, m.size_bytes AS sizeBytes, m.created_by AS createdBy,
         m.hidden, m.created_at AS createdAt
       FROM batch_materials m JOIN offline_batches b ON b.id = m.batch_id
       WHERE m.batch_id IN (${batchIds.map(() => '?').join(',')}) ${includeHidden ? '' : 'AND m.hidden = 0'} ORDER BY m.created_at DESC LIMIT 200`,
    )
    .bind(...batchIds)
    .all<Material>();
  return results;
}

const isWebLink = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
};

/** A link (https only) or a file (documents, audio, images; nothing that runs in a browser). */
export async function addMaterial(
  db: D1Database,
  bucket: R2Bucket,
  actor: string,
  batchId: string,
  form: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const title = String(form.get('title') ?? '').trim().slice(0, 160);
  if (title.length < 2) return { ok: false, error: 'title' };
  const url = String(form.get('url') ?? '').trim().slice(0, 1000);
  const file = form.get('file');
  const hasFile = file instanceof File && file.size > 0;
  if (!hasFile && !url) return { ok: false, error: 'file' };
  if (url && !isWebLink(url)) return { ok: false, error: 'url' };
  let stored: { key: string; fileName: string; contentType: string; size: number } | null = null;
  if (hasFile) {
    const r = await storeUpload(bucket, file, 'private/materials', DOC_TYPES, 25 * 1024 * 1024);
    if (!r.ok) return { ok: false, error: `file_${r.reason}` };
    stored = r.file;
  }
  const id = newId('mat');
  await db
    .prepare('INSERT INTO batch_materials (id, batch_id, title, url, file_key, file_name, content_type, size_bytes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, batchId, title, stored ? null : url, stored?.key ?? null, stored?.fileName ?? null, stored?.contentType ?? null, stored?.size ?? null, actor)
    .run();
  await log(db, actor, 'material.add', `batch:${batchId}`, { materialId: id, title });
  return { ok: true };
}

export async function hideMaterial(db: D1Database, actor: string, id: string, batchIds: string[]): Promise<boolean> {
  if (!batchIds.length) return false;
  const r = await db
    .prepare(`UPDATE batch_materials SET hidden = 1 WHERE id = ? AND batch_id IN (${batchIds.map(() => '?').join(',')})`)
    .bind(id, ...batchIds)
    .run();
  if (r.meta.changes) await log(db, actor, 'material.hide', `material:${id}`, {});
  return r.meta.changes > 0;
}

/** A material file, if the asker may have it: staff, its batch's teacher, or an active student of the batch. */
export async function materialFile(db: D1Database, id: string, who: { staff: boolean; email: string | null }) {
  const m = await db
    .prepare(`SELECT m.batch_id AS batchId, m.file_key AS fileKey, m.file_name AS fileName, m.hidden FROM batch_materials m WHERE m.id = ?`)
    .bind(id)
    .first<{ batchId: string; fileKey: string | null; fileName: string | null; hidden: number }>();
  if (!m?.fileKey) return null;
  if (who.staff) return m;
  if (!who.email || m.hidden) return null;
  const allowed = await db
    .prepare(
      `SELECT 1 AS ok FROM offline_batches b
       WHERE b.id = ?1 AND (EXISTS (SELECT 1 FROM teachers t WHERE ${teaches('t.id')} AND lower(t.email) = lower(?2) AND t.status = 'active') OR EXISTS (
         SELECT 1 FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
         WHERE e.batch_id = ?1 AND e.status = 'active' AND s.status = 'active' AND lower(s.email) = lower(?2)))`,
    )
    .bind(m.batchId, who.email)
    .first();
  return allowed ? m : null;
}

/**
 * Where someone lands after signing in when they did not ask for a page:
 * a teacher goes to the teacher panel and an offline student to their
 * panel. Everyone
 * else gets the usual account page.
 */
export async function landingFor(db: D1Database, studentId: string, returnTo: string): Promise<string> {
  if (returnTo !== '/account') return returnTo;
  const r = await db.prepare('SELECT email FROM students WHERE id = ?').bind(studentId).first<{ email: string | null }>();
  if (!r?.email) return returnTo;
  if (await teacherForEmail(db, r.email)) return '/teacher';
  if ((await offlineIdsForEmail(db, r.email)).length) return '/account/offline';
  return returnTo;
}
