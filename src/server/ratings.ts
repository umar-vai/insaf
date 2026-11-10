import { log } from './admin';

// Students rate each of their teachers once a month on four questions, 1 to 5.
// The office sees averages and comments; teachers never see who gave what.

export const QUESTIONS = [
  { key: 'teaching', label: 'পড়ানো কতটা বুঝতে পারি' },
  { key: 'punctuality', label: 'সময়মতো ক্লাসে আসেন ও শেষ করেন' },
  { key: 'behaviour', label: 'আচরণ ও যত্ন' },
  { key: 'overall', label: 'সব মিলিয়ে' },
] as const;
type Key = (typeof QUESTIONS)[number]['key'];

export type RatingTarget = { offlineStudentId: string; studentName: string; batchId: string; batchName: string; courseTitle: string; teacherId: string; teacherName: string; done: boolean };

/** Teachers this account's offline students can rate this month, and whether they already did. */
export async function ratingTargets(db: D1Database, offlineIds: string[], month: string): Promise<RatingTarget[]> {
  if (!offlineIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.id AS offlineStudentId, s.name AS studentName, b.id AS batchId, b.name AS batchName, c.title AS courseTitle, t.id AS teacherId, t.name AS teacherName,
         EXISTS (SELECT 1 FROM teacher_ratings r WHERE r.offline_student_id = s.id AND r.teacher_id = t.id AND r.month = ?) AS done
       FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id JOIN offline_batches b ON b.id = e.batch_id
       JOIN offline_courses c ON c.id = e.course_id
       JOIN teachers t ON (t.id = b.teacher_id OR t.id IN (SELECT bt.teacher_id FROM batch_teachers bt WHERE bt.batch_id = b.id))
       WHERE e.status = 'active' AND b.status = 'active' AND t.status = 'active' AND s.id IN (${offlineIds.map(() => '?').join(',')})
       ORDER BY s.name, t.name`,
    )
    .bind(month, ...offlineIds)
    .all<Omit<RatingTarget, 'done'> & { done: number }>();
  return results.map((r) => ({ ...r, done: Boolean(r.done) }));
}

/** Saves one rating, only for a teacher the student really has now. Once per month. */
export async function submitRating(
  db: D1Database,
  actor: string,
  offlineIds: string[],
  form: FormData,
  month: string,
): Promise<'saved' | 'already' | 'invalid'> {
  const studentId = String(form.get('offlineStudentId') ?? '');
  const teacherId = String(form.get('teacherId') ?? '');
  const target = (await ratingTargets(db, offlineIds, month)).find((t) => t.offlineStudentId === studentId && t.teacherId === teacherId);
  if (!target) return 'invalid';
  if (target.done) return 'already';
  const marks = {} as Record<Key, number>;
  for (const q of QUESTIONS) {
    const n = Number(form.get(q.key));
    if (!Number.isInteger(n) || n < 1 || n > 5) return 'invalid';
    marks[q.key] = n;
  }
  const comment = String(form.get('comment') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  const r = await db
    .prepare(
      `INSERT INTO teacher_ratings (id, offline_student_id, teacher_id, batch_id, month, teaching, punctuality, behaviour, overall, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (offline_student_id, teacher_id, month) DO NOTHING`,
    )
    .bind(`rat_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, studentId, teacherId, target.batchId, month, marks.teaching, marks.punctuality, marks.behaviour, marks.overall, comment)
    .run();
  if (!r.meta.changes) return 'already';
  // The log names the teacher only, so the office's history does not show who rated whom.
  await log(db, actor, 'rating.submit', `teacher:${teacherId}`, { month });
  return 'saved';
}

export type RatingSummary = { count: number; teaching: number | null; punctuality: number | null; behaviour: number | null; overall: number | null };

/** Averages for a teacher since a month ("YYYY-MM"), and the latest comments without names. */
export async function teacherRatings(db: D1Database, teacherId: string, sinceMonth: string) {
  const [avg, comments, byMonth] = await db.batch([
    db
      .prepare(
        `SELECT count(*) AS count, avg(teaching) AS teaching, avg(punctuality) AS punctuality, avg(behaviour) AS behaviour, avg(overall) AS overall
         FROM teacher_ratings WHERE teacher_id = ? AND month >= ?`,
      )
      .bind(teacherId, sinceMonth),
    db.prepare(`SELECT month, overall, comment FROM teacher_ratings WHERE teacher_id = ? AND comment != '' ORDER BY created_at DESC LIMIT 20`).bind(teacherId),
    db.prepare(`SELECT month, count(*) AS count, avg(overall) AS overall FROM teacher_ratings WHERE teacher_id = ? AND month >= ? GROUP BY month ORDER BY month`).bind(teacherId, sinceMonth),
  ]);
  return {
    summary: avg!.results[0] as RatingSummary,
    comments: comments!.results as { month: string; overall: number; comment: string }[],
    byMonth: byMonth!.results as { month: string; count: number; overall: number }[],
  };
}

/** Average overall rating per teacher since a month, for the teacher list. */
export async function ratingOverview(db: D1Database, sinceMonth: string): Promise<Map<string, { count: number; overall: number }>> {
  const { results } = await db
    .prepare(`SELECT teacher_id AS teacherId, count(*) AS count, avg(overall) AS overall FROM teacher_ratings WHERE month >= ? GROUP BY teacher_id`)
    .bind(sinceMonth)
    .all<{ teacherId: string; count: number; overall: number }>();
  return new Map(results.map((r) => [r.teacherId, { count: r.count, overall: r.overall }]));
}

/** 4.25 -> "৪.৩". */
export const stars = (n: number | null | undefined) => (n == null ? '' : n.toFixed(1).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!));
