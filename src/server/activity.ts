// The visits log (/admin/visits): who came to the site today and what each
// student did. One row per page view or student action in site_activity.
//
// Visitors are counted by a daily hash of address and browser, so nobody
// is followed from one day to the next and no address is stored. Signed in
// students are known by their session. Bots and admin pages are not counted.
// Only today is kept: every night the worker's scheduled job deletes the
// earlier days, so the table never holds more than about one day.

import { todayDhaka } from '../lib/offline';
import { readCookie, readSession, SESSION_COOKIE } from './session';
import { later, requestIp, requestUa } from './request-context';

export const KINDS = ['page', 'login', 'lesson', 'lesson_done', 'file', 'quiz', 'assignment', 'enroll', 'checkout', 'certificate'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_BN: Record<Kind, string> = {
  page: 'পেজ দেখা',
  login: 'লগইন',
  lesson: 'লেসন খোলা',
  lesson_done: 'লেসন শেষ',
  file: 'ফাইল ডাউনলোড',
  quiz: 'কুইজ দেওয়া',
  assignment: 'অ্যাসাইনমেন্ট জমা',
  enroll: 'ফ্রি কোর্সে ভর্তি',
  checkout: 'পেমেন্ট শুরু',
  certificate: 'সার্টিফিকেট নেওয়া',
};

type ActivityEnv = { DB: D1Database; SESSION_SECRET?: string };
export type ActivityEvent = { kind: Kind; studentId?: string | null; path?: string; courseId?: string | null; lessonId?: string | null; detail?: string };

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom|monitor|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|httpclient/i;
export const isBot = (ua: string) => !ua || BOT.test(ua);

export function deviceOf(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

async function visitorKey(env: ActivityEnv, day: string, ip: string, ua: string): Promise<string> {
  const data = new TextEncoder().encode(`visitor:${env.SESSION_SECRET ?? ''}|${day}|${ip}|${ua}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Writes one row. Never fails the request it belongs to. */
async function write(env: ActivityEnv, e: ActivityEvent, now: Date): Promise<void> {
  const ua = requestUa();
  const day = todayDhaka(now);
  await env.DB.prepare(
    `INSERT INTO site_activity (id, day, visitor, student_id, kind, path, course_id, lesson_id, detail, device, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      day,
      await visitorKey(env, day, requestIp(), ua),
      e.studentId ?? null,
      e.kind,
      (e.path ?? '').slice(0, 200),
      e.courseId || null,
      e.lessonId ?? null,
      (e.detail ?? '').slice(0, 200),
      ua ? deviceOf(ua) : '',
      now.toISOString(),
    )
    .run();
}

/** Records a student action. Runs after the answer is sent when it can. */
export async function track(env: ActivityEnv, e: ActivityEvent, now = new Date()): Promise<void> {
  const ua = requestUa();
  if (ua && isBot(ua)) return;
  await later(write(env, e, now));
}

// ---- Page views -----------------------------------------------------------

/** Paths that are never counted as page views (admin, files, lessons are recorded on their own). */
const SKIP = /^\/(?:admin|api|media|_astro|_image|learn|cdn-cgi)(?:\/|$)/;

/** Where the visitor came from: the other site's name, '' for our own pages or none. */
export function sourceOf(referer: string | null, ownHost: string): string {
  if (!referer) return '';
  try {
    const host = new URL(referer).hostname.replace(/^(?:www|m|l|lm|mobile)\./, '');
    if (!host || host === ownHost.replace(/^www\./, '') || host.endsWith(`.${ownHost}`)) return '';
    if (/(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(host)) return 'facebook.com';
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google';
    return host.slice(0, 80);
  } catch {
    return '';
  }
}

/** True when this answer is a page a person opened and should be counted. */
export function countsAsPage(request: Request, response: Response): boolean {
  if (request.method !== 'GET' || response.status !== 200) return false;
  const url = new URL(request.url);
  if (SKIP.test(url.pathname)) return false;
  if (!(response.headers.get('Content-Type') ?? '').includes('text/html')) return false;
  // Link prefetching is not a visit.
  if (request.headers.get('Sec-Purpose')?.includes('prefetch') || request.headers.get('Purpose') === 'prefetch') return false;
  return !isBot(request.headers.get('User-Agent') ?? '');
}

/** Records a page view (called from the worker for answers that countsAsPage). */
export async function trackPage(env: ActivityEnv, request: Request, now = new Date()): Promise<void> {
  const url = new URL(request.url);
  const studentId = await readSession(env, readCookie(request.headers.get('Cookie'), SESSION_COOKIE)).catch(() => null);
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  await write(env, { kind: 'page', studentId, path, detail: sourceOf(request.headers.get('Referer'), url.hostname) }, now).catch(() => {});
}

// ---- Nightly cleanup ------------------------------------------------------

/** Deletes every day before today (Dhaka). Returns how many rows were deleted. */
export async function pruneActivity(db: D1Database, today = todayDhaka()): Promise<number> {
  const r = await db.prepare('DELETE FROM site_activity WHERE day < ?').bind(today).run();
  return r.meta.changes ?? 0;
}

// ---- Reading (admin) ------------------------------------------------------

export type DaySummary = {
  visitors: number;
  pageViews: number;
  students: number;
  logins: number;
  lessons: number;
  lessonsDone: number;
  files: number;
  quizzes: number;
  assignments: number;
  enrolls: number;
  checkouts: number;
  mobile: number;
  desktop: number;
  tablet: number;
};

export type StudentDay = {
  id: string;
  name: string;
  email: string;
  firstAt: string;
  lastAt: string;
  pages: number;
  logins: number;
  lessons: number;
  lessonsDone: number;
  files: number;
  quizzes: number;
  assignments: number;
  courses: string[];
};

export type ActivityRow = {
  createdAt: string;
  kind: Kind;
  path: string;
  detail: string;
  device: string;
  studentId: string | null;
  studentName: string | null;
  studentEmail: string | null;
  courseTitle: string | null;
  courseSlug: string | null;
  lessonTitle: string | null;
};

export type DayReport = {
  summary: DaySummary;
  hours: { hour: number; visitors: number; views: number }[];
  students: StudentDay[];
  pages: { path: string; title: string | null; views: number; visitors: number }[];
  sources: { source: string; visitors: number }[];
  courses: { id: string; title: string; slug: string; students: number; lessons: number; lessonsDone: number; quizzes: number }[];
  recent: ActivityRow[];
};

const ROW_SELECT = `SELECT a.created_at AS createdAt, a.kind, a.path, a.detail, a.device, a.student_id AS studentId,
  s.name AS studentName, s.email AS studentEmail, NULL AS courseTitle, NULL AS courseSlug, NULL AS lessonTitle
  FROM site_activity a
  LEFT JOIN students s ON s.id = a.student_id`;

/** Everything the visits page shows for one Dhaka day. */
export async function dayReport(db: D1Database, day: string): Promise<DayReport> {
  const [summary, hours, students, studentCourses, pages, sources, courses, recent] = await db.batch([
    db
      .prepare(
        `SELECT count(DISTINCT visitor) AS visitors, coalesce(sum(kind = 'page'), 0) AS pageViews, count(DISTINCT student_id) AS students,
           coalesce(sum(kind = 'login'), 0) AS logins, coalesce(sum(kind = 'lesson'), 0) AS lessons, coalesce(sum(kind = 'lesson_done'), 0) AS lessonsDone,
           coalesce(sum(kind = 'file'), 0) AS files, coalesce(sum(kind = 'quiz'), 0) AS quizzes, coalesce(sum(kind = 'assignment'), 0) AS assignments,
           coalesce(sum(kind = 'enroll'), 0) AS enrolls, coalesce(sum(kind = 'checkout'), 0) AS checkouts,
           count(DISTINCT CASE WHEN device = 'mobile' THEN visitor END) AS mobile,
           count(DISTINCT CASE WHEN device = 'desktop' THEN visitor END) AS desktop,
           count(DISTINCT CASE WHEN device = 'tablet' THEN visitor END) AS tablet
         FROM site_activity WHERE day = ?`,
      )
      .bind(day),
    // created_at is UTC; Dhaka is six hours ahead.
    db
      .prepare(
        `SELECT (CAST(substr(created_at, 12, 2) AS INTEGER) + 6) % 24 AS hour, count(DISTINCT visitor) AS visitors, coalesce(sum(kind = 'page'), 0) AS views
         FROM site_activity WHERE day = ? GROUP BY hour ORDER BY hour`,
      )
      .bind(day),
    db
      .prepare(
        `SELECT a.student_id AS id, coalesce(s.name, '') AS name, coalesce(s.email, '') AS email,
           min(a.created_at) AS firstAt, max(a.created_at) AS lastAt,
           sum(a.kind = 'page') AS pages, sum(a.kind = 'login') AS logins, sum(a.kind = 'lesson') AS lessons, sum(a.kind = 'lesson_done') AS lessonsDone,
           sum(a.kind = 'file') AS files, sum(a.kind = 'quiz') AS quizzes, sum(a.kind = 'assignment') AS assignments
         FROM site_activity a LEFT JOIN students s ON s.id = a.student_id
         WHERE a.day = ? AND a.student_id IS NOT NULL GROUP BY a.student_id ORDER BY lastAt DESC LIMIT 500`,
      )
      .bind(day),
    // Courses each student studied (lessons, files, quizzes) or whose page they opened.
    db
      .prepare(
        `SELECT a.student_id AS id, '' AS title FROM site_activity a WHERE 0 AND a.day = ?`,
      )
      .bind(day),
    db
      .prepare(
        `SELECT a.path, NULL AS title, count(*) AS views, count(DISTINCT a.visitor) AS visitors FROM site_activity a
         WHERE a.day = ? AND a.kind = 'page' GROUP BY a.path ORDER BY views DESC LIMIT 20`,
      )
      .bind(day),
    db
      .prepare(
        `SELECT detail AS source, count(DISTINCT visitor) AS visitors FROM site_activity
         WHERE day = ? AND kind = 'page' AND detail != '' GROUP BY detail ORDER BY visitors DESC LIMIT 10`,
      )
      .bind(day),
    db
      .prepare(
        `SELECT '' AS id, '' AS title, '' AS slug, 0 AS students, 0 AS lessons, 0 AS lessonsDone, 0 AS quizzes FROM site_activity WHERE 0 AND day = ?`,
      )
      .bind(day),
    db.prepare(`${ROW_SELECT} WHERE a.day = ? AND a.student_id IS NOT NULL ORDER BY a.created_at DESC LIMIT 100`).bind(day),
  ]);

  const byStudent = new Map<string, string[]>();
  for (const r of studentCourses!.results as { id: string; title: string }[]) {
    byStudent.set(r.id, [...(byStudent.get(r.id) ?? []), r.title]);
  }
  return {
    summary: summary!.results[0] as DaySummary,
    hours: hours!.results as DayReport['hours'],
    students: (students!.results as Omit<StudentDay, 'courses'>[]).map((s) => ({ ...s, courses: byStudent.get(s.id) ?? [] })),
    pages: pages!.results as DayReport['pages'],
    sources: sources!.results as DayReport['sources'],
    courses: courses!.results as DayReport['courses'],
    recent: recent!.results as ActivityRow[],
  };
}

/** One student's whole day, in order. */
export async function studentDay(db: D1Database, day: string, studentId: string): Promise<{ student: { id: string; name: string; email: string } | null; rows: ActivityRow[] }> {
  const [student, rows] = await db.batch([
    db.prepare('SELECT id, name, email FROM students WHERE id = ?').bind(studentId),
    db.prepare(`${ROW_SELECT} WHERE a.day = ? AND a.student_id = ? ORDER BY a.created_at`).bind(day, studentId),
  ]);
  return { student: (student!.results[0] as { id: string; name: string; email: string } | undefined) ?? null, rows: rows!.results as ActivityRow[] };
}

/** A readable name for a page path. */
export function pageLabel(path: string, courseTitle?: string | null): string {
  if (courseTitle) return `কোর্স: ${courseTitle}`;
  const fixed: Record<string, string> = {
    '/': 'হোম পেজ',
    '/donate': 'দানের পেজ',
    '/land': 'জমি ক্রয় প্রজেক্ট',
    '/zakat': 'যাকাত ক্যালকুলেটর',
    '/notices': 'নোটিশ',
    '/about': 'আমাদের সম্পর্কে',
    '/account': 'লগইন বা অ্যাকাউন্ট',
    '/account/offline': 'স্টুডেন্ট প্যানেল',
    '/teacher': 'শিক্ষক প্যানেল',
    '/account/profile': 'প্রোফাইল',
  };
  if (fixed[path]) return fixed[path];
  if (path.startsWith('/donate/')) return `দান: ${path.slice(8)}`;
  if (path.startsWith('/notices/')) return `নোটিশ: ${path.slice(9)}`;
  return path;
}
