import { log } from './admin';
import { longText, newId, runBatches, text, type Result } from './ops-util';
import { addDays, dayBn, isYmd, METHOD_BN, type PayMethod } from '../lib/offline';
import { bnDigits, taka as takaBn } from '../lib/format';

// The student and guardian CRM (migration 0004): tags for grouping students,
// follow ups with a due date, a log of every call, SMS, WhatsApp or visit,
// message templates, one timeline per student, and the engagement report.
// Students and guardians are the madrasa's "customers"; donors have their
// own CRM on the donation side, which this file never touches.

export const CHANNELS = ['call', 'sms', 'whatsapp', 'visit', 'portal', 'email', 'letter'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_BN: Record<Channel, string> = { call: 'ফোন কল', sms: 'SMS', whatsapp: 'WhatsApp', visit: 'সরাসরি সাক্ষাৎ', portal: 'পোর্টাল বার্তা', email: 'ইমেইল', letter: 'চিঠি' };
export const SUGGESTED_TAGS = ['এতিম', 'যাকাত সহায়তা', 'হিফজ', 'আবাসিক', 'অনাবাসিক', 'ভাই বোন একসাথে', 'বিশেষ যত্ন', 'নিয়মিত বকেয়া'] as const;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

// ---- Tags ----------------------------------------------------------------------

export const cleanTag = (t: string) => t.replace(/[,#<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/** Reads tags from a comma separated box and ticked boxes; at most 12. */
export function parseTags(form: FormData): string[] {
  const raw = [...form.getAll('tag').map(String), ...String(form.get('tags') ?? '').split(/[,،]/)];
  return [...new Set(raw.map(cleanTag).filter((t) => t.length >= 2))].slice(0, 12);
}

/** Replaces a student's tags with these. */
export async function setTags(db: D1Database, actor: string, studentId: string, tags: readonly string[]): Promise<boolean> {
  const exists = await db.prepare('SELECT 1 AS x FROM offline_students WHERE id = ?').bind(studentId).first();
  if (!exists) return false;
  const before = await tagsOf(db, studentId);
  const add = tags.filter((t) => !before.includes(t));
  const remove = before.filter((t) => !tags.includes(t));
  if (!add.length && !remove.length) return true;
  await db.batch([
    ...remove.map((t) => db.prepare('DELETE FROM crm_tags WHERE student_id = ? AND tag = ?').bind(studentId, t)),
    ...add.map((t) => db.prepare('INSERT INTO crm_tags (student_id, tag, created_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(studentId, t, actor)),
  ]);
  await log(db, actor, 'crm.tags', `offline_student:${studentId}`, { add, remove });
  return true;
}

export async function tagsOf(db: D1Database, studentId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT tag FROM crm_tags WHERE student_id = ? ORDER BY tag').bind(studentId).all<{ tag: string }>();
  return results.map((r) => r.tag);
}

/** Every tag in use with how many active students carry it. */
export async function allTags(db: D1Database): Promise<{ tag: string; count: number }[]> {
  const { results } = await db
    .prepare(`SELECT t.tag, count(*) AS count FROM crm_tags t JOIN offline_students s ON s.id = t.student_id WHERE s.status = 'active' GROUP BY t.tag ORDER BY count DESC, t.tag`)
    .all<{ tag: string; count: number }>();
  return results;
}

/** student id -> tags, for list pages. */
export async function tagsByStudent(db: D1Database): Promise<Map<string, string[]>> {
  const { results } = await db.prepare('SELECT student_id AS id, tag FROM crm_tags ORDER BY tag').all<{ id: string; tag: string }>();
  const m = new Map<string, string[]>();
  for (const r of results) m.set(r.id, [...(m.get(r.id) ?? []), r.tag]);
  return m;
}

// ---- Follow ups -------------------------------------------------------------------

export type FollowupInput = { title: string; dueOn: string; assignedTo: string; studentId: string | null; inquiryId: string | null };

export function parseFollowupForm(form: FormData, today: string): Result<FollowupInput> {
  const title = text(form, 'title', 200);
  if (title.length < 2) return fail('title');
  const dueOn = text(form, 'dueOn', 10) || today;
  if (!isYmd(dueOn) || dueOn > addDays(today, 730)) return fail('due');
  const studentId = text(form, 'studentId', 40) || null;
  const inquiryId = text(form, 'inquiryId', 40) || null;
  return ok({ title, dueOn, assignedTo: text(form, 'assignedTo', 120), studentId, inquiryId });
}

export async function addFollowup(db: D1Database, actor: string, v: FollowupInput): Promise<Result<string>> {
  if (v.studentId && !(await db.prepare('SELECT 1 AS x FROM offline_students WHERE id = ?').bind(v.studentId).first())) return fail('student');
  if (v.inquiryId && !(await db.prepare('SELECT 1 AS x FROM admission_inquiries WHERE id = ?').bind(v.inquiryId).first())) return fail('inquiry');
  const id = newId('fu');
  await db
    .prepare('INSERT INTO crm_followups (id, student_id, inquiry_id, title, due_on, assigned_to, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.studentId, v.inquiryId, v.title, v.dueOn, v.assignedTo, actor)
    .run();
  await log(db, actor, 'crm.followup.create', v.studentId ? `offline_student:${v.studentId}` : v.inquiryId ? `inquiry:${v.inquiryId}` : `followup:${id}`, { title: v.title, dueOn: v.dueOn });
  return ok(id);
}

/**
 * Marks a follow up done (or cancelled). With a channel, the outcome is also
 * written to the contact log, so the timeline shows what was said.
 */
export async function closeFollowup(db: D1Database, actor: string, id: string, status: 'done' | 'cancelled', outcome: string, channel: Channel | null = null): Promise<boolean> {
  const note = outcome.trim().slice(0, 500);
  const r = await db
    .prepare(
      `UPDATE crm_followups SET status = ?, outcome = ?, done_by = ?, done_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'open'
       RETURNING student_id AS studentId, inquiry_id AS inquiryId, title`,
    )
    .bind(status, note, actor, id)
    .first<{ studentId: string | null; inquiryId: string | null; title: string }>();
  if (!r) return false;
  if (status === 'done' && channel && (r.studentId || r.inquiryId)) {
    await logContact(db, actor, { studentId: r.studentId, inquiryId: r.inquiryId, channel, direction: 'out', summary: note ? `${r.title}: ${note}` : r.title });
  }
  await log(db, actor, `crm.followup.${status}`, r.studentId ? `offline_student:${r.studentId}` : `followup:${id}`, { title: r.title, outcome: note });
  return true;
}

export type Followup = {
  id: string;
  title: string;
  dueOn: string;
  assignedTo: string;
  status: 'open' | 'done' | 'cancelled';
  outcome: string;
  studentId: string | null;
  studentName: string | null;
  studentNo: number | null;
  phone: string | null;
  inquiryId: string | null;
  inquiryName: string | null;
  createdBy: string;
  doneAt: string | null;
};

const FOLLOWUP_SELECT = `SELECT f.id, f.title, f.due_on AS dueOn, f.assigned_to AS assignedTo, f.status, f.outcome, f.student_id AS studentId, s.name AS studentName,
  s.student_no AS studentNo, coalesce(CASE WHEN s.guardian_phone <> '' THEN s.guardian_phone ELSE s.phone END, i.phone) AS phone,
  f.inquiry_id AS inquiryId, i.student_name AS inquiryName, f.created_by AS createdBy, f.done_at AS doneAt
  FROM crm_followups f LEFT JOIN offline_students s ON s.id = f.student_id LEFT JOIN admission_inquiries i ON i.id = f.inquiry_id`;

export async function listFollowups(db: D1Database, opts: { status?: 'open' | 'closed'; studentId?: string; limit?: number } = {}): Promise<Followup[]> {
  const conds: string[] = [];
  const binds: string[] = [];
  if (opts.status === 'open') conds.push("f.status = 'open'");
  if (opts.status === 'closed') conds.push("f.status <> 'open'");
  if (opts.studentId) {
    conds.push('f.student_id = ?');
    binds.push(opts.studentId);
  }
  const order = opts.status === 'closed' ? 'f.done_at DESC' : "f.status = 'open' DESC, f.due_on, f.created_at";
  const { results } = await db
    .prepare(`${FOLLOWUP_SELECT} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${Math.min(500, opts.limit ?? 200)}`)
    .bind(...binds)
    .all<Followup>();
  return results;
}

export async function followupCounts(db: D1Database, today: string) {
  const r = await db
    .prepare(
      `SELECT sum(CASE WHEN due_on < ?1 THEN 1 ELSE 0 END) AS overdue, sum(CASE WHEN due_on = ?1 THEN 1 ELSE 0 END) AS today,
              sum(CASE WHEN due_on > ?1 THEN 1 ELSE 0 END) AS upcoming FROM crm_followups WHERE status = 'open'`,
    )
    .bind(today)
    .first<{ overdue: number | null; today: number | null; upcoming: number | null }>();
  return { overdue: r?.overdue ?? 0, today: r?.today ?? 0, upcoming: r?.upcoming ?? 0 };
}

// ---- Contact log -----------------------------------------------------------------------

export type ContactInput = { studentId: string | null; inquiryId: string | null; channel: Channel; direction: 'out' | 'in'; summary: string };

export function parseContactForm(form: FormData): Result<ContactInput> {
  const channel = text(form, 'channel') as Channel;
  if (!(CHANNELS as readonly string[]).includes(channel)) return fail('channel');
  const summary = longText(form, 'summary', 1000);
  if (summary.length < 2) return fail('summary');
  const studentId = text(form, 'studentId', 40) || null;
  const inquiryId = text(form, 'inquiryId', 40) || null;
  if (!studentId && !inquiryId) return fail('student');
  return ok({ studentId, inquiryId, channel, direction: form.get('direction') === 'in' ? 'in' : 'out', summary });
}

export async function logContact(db: D1Database, actor: string, v: ContactInput): Promise<string> {
  const id = newId('ct');
  await db
    .prepare('INSERT INTO crm_contacts (id, student_id, inquiry_id, channel, direction, summary, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.studentId, v.inquiryId, v.channel, v.direction, v.summary.slice(0, 1000), actor)
    .run();
  return id;
}

/** One contact row per student (a group message, a reminder run). */
export async function logContactsBulk(db: D1Database, actor: string, studentIds: readonly string[], channel: Channel, summary: string): Promise<number> {
  const ids = [...new Set(studentIds.filter(Boolean))];
  if (!ids.length) return 0;
  const s = summary.trim().slice(0, 1000) || CHANNEL_BN[channel];
  return runBatches(
    db,
    ids.map((sid) => db.prepare("INSERT INTO crm_contacts (id, student_id, channel, direction, summary, created_by) VALUES (?, ?, ?, 'out', ?, ?)").bind(newId('ct'), sid, channel, s, actor)),
  );
}

export type Contact = { id: string; channel: Channel; direction: 'out' | 'in'; summary: string; createdBy: string; createdAt: string; studentId: string | null; studentName: string | null; studentNo: number | null; inquiryName: string | null };

export async function listContacts(db: D1Database, opts: { studentId?: string; channel?: string; limit?: number } = {}): Promise<Contact[]> {
  const conds: string[] = [];
  const binds: string[] = [];
  if (opts.studentId) {
    conds.push('c.student_id = ?');
    binds.push(opts.studentId);
  }
  if (opts.channel && (CHANNELS as readonly string[]).includes(opts.channel)) {
    conds.push('c.channel = ?');
    binds.push(opts.channel);
  }
  const { results } = await db
    .prepare(
      `SELECT c.id, c.channel, c.direction, c.summary, c.created_by AS createdBy, c.created_at AS createdAt, c.student_id AS studentId, s.name AS studentName,
       s.student_no AS studentNo, i.student_name AS inquiryName FROM crm_contacts c LEFT JOIN offline_students s ON s.id = c.student_id
       LEFT JOIN admission_inquiries i ON i.id = c.inquiry_id ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY c.created_at DESC LIMIT ${Math.min(500, opts.limit ?? 100)}`,
    )
    .bind(...binds)
    .all<Contact>();
  return results;
}

// ---- Templates -----------------------------------------------------------------------

export type Template = { id: string; name: string; channel: 'any' | 'sms' | 'whatsapp' | 'portal'; body: string; status: 'active' | 'archived' };
export const TEMPLATE_CHANNEL_BN: Record<Template['channel'], string> = { any: 'যেকোনো', sms: 'SMS', whatsapp: 'WhatsApp', portal: 'পোর্টাল' };
/** The words a template may use; each is replaced for the student it goes to. */
export const TEMPLATE_VARS = ['{name}', '{id}', '{course}', '{class}', '{due}', '{date}'] as const;

export function parseTemplateForm(form: FormData): Result<{ name: string; channel: Template['channel']; body: string }> {
  const name = text(form, 'name', 80);
  if (name.length < 2) return fail('name');
  const body = longText(form, 'body', 1000);
  if (body.length < 5) return fail('body');
  const channel = text(form, 'channel') as Template['channel'];
  return ok({ name, channel: ['any', 'sms', 'whatsapp', 'portal'].includes(channel) ? channel : 'any', body });
}

export async function saveTemplate(db: D1Database, actor: string, id: string | null, v: { name: string; channel: Template['channel']; body: string }): Promise<Result<string>> {
  const tid = id || newId('tpl');
  try {
    if (id) {
      const r = await db
        .prepare(`UPDATE crm_templates SET name = ?, channel = ?, body = ?, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .bind(v.name, v.channel, v.body, id)
        .run();
      if (!r.meta.changes) return fail('missing');
    } else {
      await db.prepare('INSERT INTO crm_templates (id, name, channel, body, created_by) VALUES (?, ?, ?, ?, ?)').bind(tid, v.name, v.channel, v.body, actor).run();
    }
  } catch {
    return fail('name_taken');
  }
  await log(db, actor, id ? 'crm.template.update' : 'crm.template.create', `template:${tid}`, { name: v.name });
  return ok(tid);
}

export async function archiveTemplate(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db.prepare("UPDATE crm_templates SET status = 'archived' WHERE id = ? AND status = 'active'").bind(id).run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'crm.template.archive', `template:${id}`);
  return true;
}

export async function listTemplates(db: D1Database, includeArchived = false): Promise<Template[]> {
  const { results } = await db.prepare(`SELECT id, name, channel, body, status FROM crm_templates ${includeArchived ? '' : "WHERE status = 'active'"} ORDER BY status, name`).all<Template>();
  return results;
}

export type TemplateVars = { name: string; id: string; course: string; class: string; due: string; date: string };

export const renderTemplate = (body: string, v: TemplateVars) =>
  body.replace(/\{(name|id|course|class|due|date)\}/g, (_, k: keyof TemplateVars) => v[k] ?? '');

// ---- One student's timeline ------------------------------------------------------------

export type TimelineItem = { at: string; kind: string; title: string; detail: string; link: string; tone: 'good' | 'bad' | 'info' | 'plain' };

/** Everything that happened with a student, newest first. */
export async function studentTimeline(db: D1Database, studentId: string, limit = 80): Promise<TimelineItem[]> {
  const q = (sql: string) => db.prepare(sql).bind(studentId);
  const res = await db.batch([
    q(`SELECT e.created_at AS at, c.title AS a, e.status AS b FROM offline_enrollments e JOIN offline_courses c ON c.id = e.course_id WHERE e.student_id = ?`),
    q(`SELECT p.created_at AS at, p.receipt_no AS a, p.amount_minor AS b, p.voided_at AS c, p.id AS d, p.method AS e FROM offline_payments p JOIN offline_enrollments e ON e.id = p.enrollment_id WHERE e.student_id = ? ORDER BY p.created_at DESC LIMIT 40`),
    q(`SELECT x.created_at AS at, x.label AS a, x.amount_minor AS b, x.voided_at AS c FROM offline_charges x JOIN offline_enrollments e ON e.id = x.enrollment_id WHERE e.student_id = ? ORDER BY x.created_at DESC LIMIT 40`),
    q(`SELECT created_at AS at, channel AS a, summary AS b, direction AS c, created_by AS d FROM crm_contacts WHERE student_id = ? ORDER BY created_at DESC LIMIT 60`),
    q(`SELECT created_at AS at, title AS a, due_on AS b, status AS c, outcome AS d, done_at AS e FROM crm_followups WHERE student_id = ? ORDER BY created_at DESC LIMIT 30`),
    q(`SELECT created_at AS at, subject AS a, status AS b, ticket_no AS c FROM tickets WHERE offline_student_id = ? ORDER BY created_at DESC LIMIT 20`),
    q(`SELECT created_at AS at, from_day AS a, to_day AS b, status AS c FROM student_leave_requests WHERE student_id = ? ORDER BY created_at DESC LIMIT 20`),
    q(`SELECT created_at AS at, title AS a, status AS b, id AS c FROM certificates WHERE student_id = ? ORDER BY created_at DESC LIMIT 20`),
    q(`SELECT created_at AS at, title AS a, read_at AS b FROM portal_notifications WHERE offline_student_id = ? ORDER BY created_at DESC LIMIT 25`),
    q(`SELECT l.created_at AS at, b.title AS a, l.returned_on AS b FROM library_loans l JOIN library_books b ON b.id = l.book_id WHERE l.student_id = ? ORDER BY l.created_at DESC LIMIT 20`),
    q(`SELECT a.day AS at, b.name AS a FROM offline_attendance a JOIN offline_enrollments e ON e.id = a.enrollment_id JOIN offline_batches b ON b.id = a.batch_id WHERE e.student_id = ? AND a.status = 'absent' ORDER BY a.day DESC LIMIT 20`),
    q(`SELECT created_at AS at, action AS a FROM admin_events WHERE target = 'offline_student:' || ? AND action IN ('offline.student.block', 'offline.student.unblock', 'academic.guardian.link') ORDER BY created_at DESC LIMIT 10`),
  ]);
  type R = { at: string; a: string | number; b: string | number | null; c?: string | number | null; d?: string | null; e?: string | null };
  const rows = (i: number) => (res[i]?.results ?? []) as R[];
  const taka = (minor: number) => takaBn(minor);
  const STATUS: Record<string, string> = { open: 'খোলা', answered: 'উত্তর দেওয়া হয়েছে', closed: 'বন্ধ', pending: 'অপেক্ষায়', approved: 'অনুমোদিত', rejected: 'নামঞ্জুর', cancelled: 'বাতিল' };
  const out: TimelineItem[] = [];
  for (const r of rows(0)) out.push({ at: r.at, kind: 'ভর্তি', title: `ভর্তি: ${r.a}`, detail: r.b === 'active' ? 'চলছে' : String(r.b), link: '', tone: 'info' });
  for (const r of rows(1))
    out.push({ at: r.at, kind: 'পেমেন্ট', title: `${taka(Number(r.b))} জমা, রসিদ ${bnDigits(Number(r.a))}`, detail: r.c ? 'বাতিল করা হয়েছে' : (METHOD_BN[r.e as PayMethod] ?? String(r.e ?? '')), link: `/admin/offline/receipt/${r.d}`, tone: r.c ? 'bad' : 'good' });
  for (const r of rows(2)) out.push({ at: r.at, kind: 'চার্জ', title: `${r.a}: ${taka(Number(r.b))}`, detail: r.c ? 'মাফ করা হয়েছে' : '', link: '', tone: 'plain' });
  for (const r of rows(3))
    out.push({ at: r.at, kind: 'যোগাযোগ', title: `${CHANNEL_BN[r.a as Channel] ?? r.a}${r.c === 'in' ? ' (অভিভাবক থেকে)' : ''}`, detail: `${r.b} · ${r.d ?? ''}`, link: '', tone: 'info' });
  for (const r of rows(4)) {
    out.push({ at: r.at, kind: 'ফলো আপ', title: `ফলো আপ ঠিক হলো: ${r.a}`, detail: `তারিখ ${dayBn(String(r.b))}`, link: '', tone: 'plain' });
    if (r.e) out.push({ at: r.e, kind: 'ফলো আপ', title: `ফলো আপ ${r.c === 'done' ? 'শেষ' : 'বাতিল'}: ${r.a}`, detail: r.d ?? '', link: '', tone: r.c === 'done' ? 'good' : 'plain' });
  }
  for (const r of rows(5)) out.push({ at: r.at, kind: 'টিকেট', title: `টিকেট #${bnDigits(Number(r.c))}: ${r.a}`, detail: STATUS[String(r.b)] ?? String(r.b), link: '/admin/offline/tickets', tone: 'info' });
  for (const r of rows(6)) out.push({ at: r.at, kind: 'ছুটি', title: `ছুটির আবেদন ${dayBn(String(r.a))} থেকে ${dayBn(String(r.b))}`, detail: STATUS[String(r.c)] ?? String(r.c), link: '/admin/offline/student-leave', tone: 'plain' });
  for (const r of rows(7)) out.push({ at: r.at, kind: 'সনদ', title: `সনদ: ${r.a}`, detail: r.b === 'revoked' ? 'বাতিল' : '', link: `/admin/offline/certificates/${r.c}`, tone: 'info' });
  for (const r of rows(8)) out.push({ at: r.at, kind: 'নোটিফিকেশন', title: String(r.a), detail: r.b ? 'পড়েছে' : 'এখনো পড়েনি', link: '', tone: 'plain' });
  for (const r of rows(9)) out.push({ at: r.at, kind: 'লাইব্রেরি', title: `বই নিয়েছে: ${r.a}`, detail: r.b ? `ফেরত ${dayBn(String(r.b))}` : 'এখনো কাছে', link: '', tone: 'plain' });
  for (const r of rows(10)) out.push({ at: `${r.at}T06:00:00.000Z`, kind: 'হাজিরা', title: 'অনুপস্থিত', detail: String(r.a), link: '', tone: 'bad' });
  for (const r of rows(11)) out.push({ at: r.at, kind: 'অফিস', title: String(r.a).includes('unblock') ? 'অ্যাকাউন্ট চালু করা হলো' : String(r.a).includes('block') ? 'অ্যাকাউন্ট বন্ধ করা হলো' : 'অভিভাবক যুক্ত হলো', detail: '', link: '', tone: 'plain' });
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

// ---- Engagement report ---------------------------------------------------------------------

export async function engagementReport(db: D1Database, today: string) {
  const since30 = addDays(today, -30);
  const since60 = addDays(today, -60);
  const [channels, followups, portal, reads, quiet, attendance, inquiries] = await db.batch([
    db.prepare(`SELECT channel, count(*) AS n FROM crm_contacts WHERE created_at >= ? GROUP BY channel ORDER BY n DESC`).bind(`${since30}T00:00:00`),
    db
      .prepare(
        `SELECT sum(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, sum(CASE WHEN status = 'open' AND due_on < ?1 THEN 1 ELSE 0 END) AS overdue,
         sum(CASE WHEN status = 'done' AND done_at >= ?2 THEN 1 ELSE 0 END) AS done30, sum(CASE WHEN status = 'done' AND done_at >= ?2 AND substr(done_at, 1, 10) <= due_on THEN 1 ELSE 0 END) AS onTime30
         FROM crm_followups`,
      )
      .bind(today, `${since30}T00:00:00`),
    db.prepare(
      `SELECT count(*) AS active, sum(CASE WHEN s.email <> '' AND EXISTS (SELECT 1 FROM students u WHERE lower(u.email) = lower(s.email) AND u.password_hash IS NOT NULL) THEN 1 ELSE 0 END) AS withLogin
       FROM offline_students s WHERE s.status = 'active'`,
    ),
    db.prepare(`SELECT count(*) AS total, sum(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read FROM portal_notifications WHERE recipient_kind = 'student' AND created_at >= ?`).bind(`${since30}T00:00:00`),
    db
      .prepare(
        `SELECT s.id, s.name, s.student_no AS studentNo, CASE WHEN s.guardian_phone <> '' THEN s.guardian_phone ELSE s.phone END AS phone,
         (SELECT max(created_at) FROM crm_contacts c WHERE c.student_id = s.id) AS lastContact
         FROM offline_students s WHERE s.status = 'active' AND EXISTS (SELECT 1 FROM offline_enrollments e WHERE e.student_id = s.id AND e.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM crm_contacts c WHERE c.student_id = s.id AND c.created_at >= ?) ORDER BY lastContact, s.student_no LIMIT 30`,
      )
      .bind(`${since60}T00:00:00`),
    db
      .prepare(
        `SELECT b.id, b.name, count(*) AS marked, sum(CASE WHEN a.status IN ('present', 'late') THEN 1 ELSE 0 END) AS present
         FROM offline_attendance a JOIN offline_batches b ON b.id = a.batch_id WHERE a.day BETWEEN ? AND ? GROUP BY b.id ORDER BY b.name`,
      )
      .bind(since30, today),
    db.prepare(`SELECT status, count(*) AS n FROM admission_inquiries WHERE created_at >= ? GROUP BY status`).bind(`${addDays(today, -90)}T00:00:00`),
  ]);
  const f = followups!.results[0] as { open: number | null; overdue: number | null; done30: number | null; onTime30: number | null };
  const p = portal!.results[0] as { active: number; withLogin: number | null };
  const r = reads!.results[0] as { total: number; read: number | null };
  return {
    channels: channels!.results as { channel: Channel; n: number }[],
    followups: { open: f.open ?? 0, overdue: f.overdue ?? 0, done30: f.done30 ?? 0, onTime30: f.onTime30 ?? 0 },
    portal: { active: p.active, withLogin: p.withLogin ?? 0 },
    reads: { total: r.total, read: r.read ?? 0 },
    quiet: quiet!.results as { id: string; name: string; studentNo: number | null; phone: string; lastContact: string | null }[],
    attendance: (attendance!.results as { id: string; name: string; marked: number; present: number }[]).map((a) => ({ ...a, rate: a.marked ? Math.round((a.present / a.marked) * 100) : 0 })),
    inquiries: inquiries!.results as { status: string; n: number }[],
  };
}

/** Students with any of these tags (active only), for group messages. */
export async function studentsWithTag(db: D1Database, tag: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT t.student_id AS id FROM crm_tags t JOIN offline_students s ON s.id = t.student_id WHERE s.status = 'active' AND t.tag = ?`)
    .bind(tag)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}


