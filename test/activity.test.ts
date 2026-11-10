import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { countsAsPage, dayReport, deviceOf, isBot, pruneActivity, sourceOf, studentDay, track, trackPage } from '../src/server/activity';
import { withRequest } from '../src/server/request-context';
import { SESSION_COOKIE, signSession } from '../src/server/session';
import { mayOpenPath, roleGrants, parseGrants } from '../src/server/staff';

const db = env.DB;
const aEnv = { DB: db, SESSION_SECRET: 'test-session-secret-0123456789' };
// 10:00 in Dhaka on 9 Nov 2026.
const AT = new Date('2026-11-09T04:00:00Z');
const DAY = '2026-11-09';
const PHONE = 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36';
const PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';

const req = (path: string, ua: string, extra: Record<string, string> = {}) =>
  new Request(`https://madrasatulinsaf.org${path}`, { headers: { 'User-Agent': ua, 'CF-Connecting-IP': extra.ip ?? '1.1.1.1', ...extra } });

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM site_activity'),
    db.prepare('DELETE FROM students'),
    db.prepare(`INSERT INTO students (id, email, name) VALUES ('stu_a', 'a@example.org', 'Amina'), ('stu_b', 'b@example.org', 'Bilal')`),
  ]);
});

describe('what counts as a visit', () => {
  it('skips bots, admin pages, lessons, files and non pages', () => {
    const html = () => new Response('<p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    expect(countsAsPage(req('/', PHONE), html())).toBe(true);
    expect(countsAsPage(req('/', 'Googlebot/2.1'), html())).toBe(false);
    expect(countsAsPage(req('/', ''), html())).toBe(false);
    expect(countsAsPage(req('/admin/visits', PC), html())).toBe(false);
    expect(countsAsPage(req('/api/health', PC), new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toBe(false);
    expect(countsAsPage(req('/', PC, { 'Sec-Purpose': 'prefetch' }), html())).toBe(false);
    expect(countsAsPage(req('/nope', PC), new Response('x', { status: 404, headers: { 'Content-Type': 'text/html' } }))).toBe(false);
  });

  it('names the site a visitor came from, never our own', () => {
    expect(sourceOf('https://l.facebook.com/l.php?u=x', 'madrasatulinsaf.org')).toBe('facebook.com');
    expect(sourceOf('https://www.google.com.bd/', 'madrasatulinsaf.org')).toBe('google');
    expect(sourceOf('https://madrasatulinsaf.org/courses', 'madrasatulinsaf.org')).toBe('');
    expect(sourceOf(null, 'madrasatulinsaf.org')).toBe('');
    expect(isBot(PHONE)).toBe(false);
    expect(deviceOf(PHONE)).toBe('mobile');
    expect(deviceOf(PC)).toBe('desktop');
  });
});

describe('the day report', () => {
  it('counts visitors once a day and shows what each student did', async () => {
    const cookie = `${SESSION_COOKIE}=${await signSession(aEnv, 'stu_a')}`;
    // A guest from Facebook opens two pages; Amina opens the course page on her phone.
    await withRequest(req('/', PC), () => trackPage(aEnv, req('/', PC, { Referer: 'https://m.facebook.com/' }), AT));
    await withRequest(req('/courses', PC), () => trackPage(aEnv, req('/courses', PC), AT));
    await withRequest(req('/courses/arabic', PHONE, { ip: '2.2.2.2' }), () => trackPage(aEnv, req('/courses/arabic', PHONE, { ip: '2.2.2.2', Cookie: cookie }), AT));
    // Then she signs in, studies and takes a quiz.
    await withRequest(req('/', PHONE, { ip: '2.2.2.2' }), async () => {
      await track(aEnv, { kind: 'login', studentId: 'stu_a', detail: 'google' }, AT);
      await track(aEnv, { kind: 'lesson', studentId: 'stu_a', courseId: 'c1', lessonId: 'les_1' }, AT);
      await track(aEnv, { kind: 'lesson_done', studentId: 'stu_a', lessonId: 'les_1' }, AT);
      await track(aEnv, { kind: 'quiz', studentId: 'stu_a', courseId: 'c1', lessonId: 'les_1', detail: '8/10 (80%) পাস' }, AT);
    });
    // Bots are never written.
    await withRequest(req('/', 'Googlebot/2.1'), () => track(aEnv, { kind: 'login', studentId: 'stu_b' }, AT));

    const r = await dayReport(db, DAY);
    expect(r.summary).toMatchObject({ visitors: 2, pageViews: 3, students: 1, logins: 1, lessons: 1, lessonsDone: 1, quizzes: 1, mobile: 1, desktop: 1 });
    expect(r.students).toHaveLength(1);
    expect(r.students[0]).toMatchObject({ id: 'stu_a', name: 'Amina', lessons: 1, lessonsDone: 1, quizzes: 1, pages: 1, courses: [] });
    expect(r.courses).toEqual([]);
    expect(r.sources).toEqual([{ source: 'facebook.com', visitors: 1 }]);
    expect(r.hours).toEqual([{ hour: 10, visitors: 2, views: 3 }]);

    const day = await studentDay(db, DAY, 'stu_a');
    expect(day.student?.name).toBe('Amina');
    expect(day.rows.map((x) => x.kind)).toEqual(['page', 'login', 'lesson', 'lesson_done', 'quiz']);
    // No address is stored.
    const raw = await db.prepare('SELECT * FROM site_activity').all();
    expect(JSON.stringify(raw.results)).not.toContain('2.2.2.2');
  });

  it('is empty on a day with nothing', async () => {
    const r = await dayReport(db, '2026-11-01');
    expect(r.summary.visitors).toBe(0);
    expect(r.students).toEqual([]);
  });
});

describe('keeping only today', () => {
  it('deletes every earlier day at night', async () => {
    await track(aEnv, { kind: 'login', studentId: 'stu_a' }, new Date('2026-11-04T10:00:00Z'));
    // 11:30 PM in Dhaka on the 19th is still the 19th.
    await track(aEnv, { kind: 'login', studentId: 'stu_a' }, new Date('2026-11-19T17:30:00Z'));
    // 00:30 AM in Dhaka on the 20th.
    await track(aEnv, { kind: 'login', studentId: 'stu_a' }, new Date('2026-11-19T18:30:00Z'));
    expect(await pruneActivity(db, '2026-11-20')).toBe(2);
    const left = await db.prepare('SELECT day FROM site_activity ORDER BY day').all<{ day: string }>();
    expect(left.results.map((r) => r.day)).toEqual(['2026-11-20']);
  });
});

describe('who may open the visits page', () => {
  it('owners and the admin role only', () => {
    expect(mayOpenPath({ owner: true, modules: [] }, '/admin/visits')).toBe(true);
    const admin = roleGrants('admin', 'online');
    expect(mayOpenPath({ owner: false, modules: Object.keys(admin) as never, grants: admin }, '/admin/visits')).toBe(true);
    const manager = roleGrants('manager', 'online');
    expect(mayOpenPath({ owner: false, modules: Object.keys(manager) as never, grants: manager }, '/admin/visits')).toBe(false);
    // The manager still opens the rest of the dashboard.
    expect(mayOpenPath({ owner: false, modules: Object.keys(manager) as never, grants: manager }, '/admin/dashboard')).toBe(true);
    const viewer = parseGrants('online_sales:view');
    expect(mayOpenPath({ owner: false, modules: ['online_sales'], grants: viewer }, '/admin/visits')).toBe(false);
  });
});
