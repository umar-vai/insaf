import { log } from './admin';
import { savedConfig, type ConfigEnv } from './config';
import { sendSms, smsNumber } from './reminders';
import { EFFECTIVE_BATCH, marks, newId, runBatches, type Result } from './ops-util';

// Notifications inside the student (and guardian) portal and the teacher
// panel: a bell with an unread count. The site writes them when something
// happens for that person (a fee bill, a published result, homework, a leave
// decision, an overdue library book, a salary paid), and the office can send
// a message to a group. source_key keeps the same event from being written
// twice for one person. Optional SMS goes through the SMS service the owner
// set up on the system page (paid per message), only when the office asks.

export type PortalNotification = { id: string; title: string; body: string; link: string; createdAt: string; readAt: string | null; studentName: string };
type NoticeInput = { title: string; body?: string; link?: string; sourceKey: string };

const clean = (n: NoticeInput) => ({
  title: n.title.trim().slice(0, 160),
  body: (n.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000),
  // Only links inside this site, so a message cannot send someone elsewhere.
  link: n.link && /^\/[a-z0-9/_?=&.%-]*$/i.test(n.link) && !n.link.startsWith('//') ? n.link.slice(0, 300) : '',
  sourceKey: n.sourceKey.slice(0, 120),
});

/** Adds a notification for each student once (per source key). Returns how many were new. */
export async function notifyStudents(db: D1Database, actor: string, studentIds: readonly string[], n: NoticeInput): Promise<number> {
  const ids = [...new Set(studentIds.filter(Boolean))];
  if (!ids.length || !n.title.trim()) return 0;
  const v = clean(n);
  return runBatches(
    db,
    ids.map((sid) =>
      db
        .prepare(
          `INSERT INTO portal_notifications (id, recipient_kind, offline_student_id, title, body, link, source_key, created_by)
           VALUES (?, 'student', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(newId('ntf'), sid, v.title, v.body, v.link, v.sourceKey, actor),
    ),
  );
}

export async function notifyTeachers(db: D1Database, actor: string, teacherIds: readonly string[], n: NoticeInput): Promise<number> {
  const ids = [...new Set(teacherIds.filter(Boolean))];
  if (!ids.length || !n.title.trim()) return 0;
  const v = clean(n);
  return runBatches(
    db,
    ids.map((tid) =>
      db
        .prepare(
          `INSERT INTO portal_notifications (id, recipient_kind, teacher_id, title, body, link, source_key, created_by)
           VALUES (?, 'teacher', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(newId('ntf'), tid, v.title, v.body, v.link, v.sourceKey, actor),
    ),
  );
}

/** Students currently placed in a batch (active session placement first). */
export async function studentsOfBatch(db: D1Database, batchId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT e.student_id AS id FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
       WHERE e.status = 'active' AND s.status = 'active' AND ${EFFECTIVE_BATCH} = ?`,
    )
    .bind(batchId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Who a recipient is: one or more offline student records, or a teacher. */
export type Owner = { studentIds: string[] } | { teacherId: string };
const where = (o: Owner): [string, string[]] =>
  'teacherId' in o ? ['n.teacher_id = ?', [o.teacherId]] : [`n.offline_student_id IN (${marks(o.studentIds.length)})`, o.studentIds];
const empty = (o: Owner) => !('teacherId' in o) && o.studentIds.length === 0;

export async function listNotifications(db: D1Database, o: Owner, limit = 60): Promise<PortalNotification[]> {
  if (empty(o)) return [];
  const [w, binds] = where(o);
  const { results } = await db
    .prepare(
      `SELECT n.id, n.title, n.body, n.link, n.created_at AS createdAt, n.read_at AS readAt, coalesce(s.name, '') AS studentName
       FROM portal_notifications n LEFT JOIN offline_students s ON s.id = n.offline_student_id
       WHERE ${w} ORDER BY n.created_at DESC LIMIT ?`,
    )
    .bind(...binds, Math.min(200, Math.max(1, limit)))
    .all<PortalNotification>();
  return results;
}

export async function unreadCount(db: D1Database, o: Owner): Promise<number> {
  if (empty(o)) return 0;
  const [w, binds] = where(o);
  const r = await db.prepare(`SELECT count(*) AS n FROM portal_notifications n WHERE ${w} AND n.read_at IS NULL`).bind(...binds).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Marks one (or, without an id, every) notification of this owner as read. Never touches anyone else's. */
export async function markRead(db: D1Database, o: Owner, id?: string): Promise<number> {
  if (empty(o)) return 0;
  const [w, binds] = where(o);
  const r = await db
    .prepare(`UPDATE portal_notifications AS n SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${w} AND n.read_at IS NULL ${id ? 'AND n.id = ?' : ''}`)
    .bind(...binds, ...(id ? [id] : []))
    .run();
  return r.meta.changes ?? 0;
}

// ---- Messages the office sends to a group -------------------------------------

export const AUDIENCES = ['all_students', 'batch', 'course', 'all_teachers'] as const;
export type MessageAudience = (typeof AUDIENCES)[number];
export const MESSAGE_AUDIENCE_BN: Record<MessageAudience, string> = {
  all_students: 'সব ছাত্র ও অভিভাবক',
  course: 'একটি বিভাগের ছাত্র',
  batch: 'একটি ক্লাসের ছাত্র',
  all_teachers: 'সব শিক্ষক ও কর্মী',
};
export const MAX_SMS = 300;

export type MessageInput = { audience: MessageAudience; targetId: string; title: string; body: string; sms: boolean };

export function parseMessageForm(form: FormData): Result<MessageInput> {
  const audience = String(form.get('audience') ?? '') as MessageAudience;
  if (!(AUDIENCES as readonly string[]).includes(audience)) return { ok: false, error: 'audience' };
  const targetId = String(form.get(audience === 'batch' ? 'batchId' : 'courseId') ?? '').trim().slice(0, 40);
  if ((audience === 'batch' || audience === 'course') && !targetId) return { ok: false, error: 'target' };
  const title = String(form.get('title') ?? '').trim().slice(0, 160);
  const body = String(form.get('body') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  if (title.length < 2) return { ok: false, error: 'title' };
  return { ok: true, value: { audience, targetId: audience === 'batch' || audience === 'course' ? targetId : '', title, body, sms: form.get('sms') === 'on' } };
}

type Person = { id: string; phone: string };

async function audiencePeople(db: D1Database, a: MessageAudience, targetId: string): Promise<{ kind: 'student' | 'teacher'; people: Person[] }> {
  if (a === 'all_teachers') {
    const { results } = await db.prepare("SELECT id, phone FROM teachers WHERE status = 'active'").all<Person>();
    return { kind: 'teacher', people: results };
  }
  const filter = a === 'batch' ? `AND ${EFFECTIVE_BATCH} = ?` : a === 'course' ? 'AND e.course_id = ?' : '';
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.id, CASE WHEN s.guardian_phone <> '' THEN s.guardian_phone ELSE s.phone END AS phone
       FROM offline_students s JOIN offline_enrollments e ON e.student_id = s.id
       WHERE s.status = 'active' AND e.status = 'active' ${filter}`,
    )
    .bind(...(filter ? [targetId] : []))
    .all<Person>();
  return { kind: 'student', people: results };
}

/** How many people a message would reach, and how many SMS numbers. */
export async function messageReach(db: D1Database, a: MessageAudience, targetId: string) {
  const { people } = await audiencePeople(db, a, targetId);
  return { people: people.length, smsNumbers: new Set(people.map((p) => smsNumber(p.phone)).filter(Boolean)).size };
}

export type MessageResult = { notified: number; people: number; smsSent: number; smsFailed: number; smsSkipped: number };

/**
 * Sends a message to a group: always as a portal notification; also by SMS
 * when asked and the SMS service is set up (each number once, at most MAX_SMS).
 */
export async function sendMessage(
  db: D1Database,
  env: ConfigEnv,
  actor: string,
  v: MessageInput,
  fetcher: typeof fetch = fetch,
): Promise<Result<MessageResult>> {
  const { kind, people } = await audiencePeople(db, v.audience, v.targetId);
  if (!people.length) return { ok: false, error: 'nobody' };
  const sourceKey = `msg:${newId('m')}`;
  const n = { title: v.title, body: v.body, link: kind === 'student' ? '/account/offline/notifications' : '/teacher/notifications', sourceKey };
  const ids = people.map((p) => p.id);
  const notified = kind === 'student' ? await notifyStudents(db, actor, ids, n) : await notifyTeachers(db, actor, ids, n);
  const out: MessageResult = { notified, people: people.length, smsSent: 0, smsFailed: 0, smsSkipped: 0 };
  if (v.sms) {
    const cfg = await savedConfig(db, env);
    if (!(cfg.smsApiKey && cfg.smsSenderId)) return { ok: false, error: 'sms_off' };
    const numbers = [...new Set(people.map((p) => smsNumber(p.phone)).filter((x): x is string => Boolean(x)))];
    if (numbers.length > MAX_SMS) return { ok: false, error: 'too_many' };
    out.smsSkipped = people.length - numbers.length;
    const message = `${v.title}\n${v.body}`.trim().slice(0, 900);
    for (const to of numbers) {
      if (await sendSms(cfg.smsApiKey, cfg.smsSenderId, to, message, fetcher)) out.smsSent++;
      else out.smsFailed++;
    }
  }
  await log(db, actor, 'notify.broadcast', `audience:${v.audience}${v.targetId ? `:${v.targetId}` : ''}`, { title: v.title, ...out });
  return { ok: true, value: out };
}

export type SentMessage = { createdAt: string; actor: string; target: string; title: string; people: number; smsSent: number };

export async function recentMessages(db: D1Database, limit = 20): Promise<SentMessage[]> {
  const { results } = await db
    .prepare(`SELECT created_at AS createdAt, actor, target, detail_json AS d FROM admin_events WHERE action = 'notify.broadcast' ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<{ createdAt: string; actor: string; target: string; d: string }>();
  return results.map((r) => {
    let d: { title?: string; people?: number; smsSent?: number } = {};
    try {
      d = JSON.parse(r.d);
    } catch {
      /* keep empty */
    }
    return { createdAt: r.createdAt, actor: r.actor, target: r.target, title: d.title ?? '', people: d.people ?? 0, smsSent: d.smsSent ?? 0 };
  });
}
