import { log } from './admin';
import { COUNTED, donationByReference, donorHistory, listDonors, type Donor } from './donations';
import { longText, newId, text, type Result } from './ops-util';
import { addDays, dayBn, isYmd } from '../lib/offline';
import { bnDigits, receiptLabel, taka } from '../lib/format';

// The donor CRM (migration 0009): notes, tags and segments, a contact log,
// follow ups, support tickets, message templates, receipt delivery, one
// timeline per donor and the engagement report. It only reads the donations
// table: what counts as a gift is decided in donations.ts and nowhere else.

export const DONOR_CHANNELS = ['whatsapp', 'call', 'sms', 'email', 'visit', 'letter'] as const;
export type DonorChannel = (typeof DONOR_CHANNELS)[number];
export const DONOR_CHANNEL_BN: Record<DonorChannel, string> = { whatsapp: 'WhatsApp', call: 'ফোন কল', sms: 'SMS', email: 'ইমেইল', visit: 'সরাসরি সাক্ষাৎ', letter: 'চিঠি' };
export const SUGGESTED_DONOR_TAGS = ['যাকাত দাতা', 'জমি প্রকল্প', 'মাসিক দাতা', 'প্রবাসী', 'প্রতিষ্ঠান', 'বিশেষ সম্মানিত'] as const;

export const TICKET_CATEGORIES = ['receipt', 'payment', 'information', 'complaint', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_CATEGORY_BN: Record<TicketCategory, string> = { receipt: 'রসিদ', payment: 'পেমেন্ট সমস্যা', information: 'তথ্য জানতে চান', complaint: 'অভিযোগ', other: 'অন্যান্য' };

export const SEGMENTS = ['new', 'regular', 'once', 'active', 'lapsed'] as const;
export type Segment = (typeof SEGMENTS)[number];
export const SEGMENT_BN: Record<Segment, string> = { new: 'নতুন দাতা', regular: 'নিয়মিত দাতা', once: 'একবার দিয়েছেন', active: 'সক্রিয়', lapsed: 'অনেক দিন দেননি' };
export const SEGMENT_HINT: Record<Segment, string> = {
  new: 'প্রথম দান শেষ ৩০ দিনে',
  regular: '৩ বা তার বেশি দান, শেষ দান ১৮০ দিনের মধ্যে',
  once: 'একটি দান, ৩০ থেকে ১৮০ দিন আগে',
  active: '২টি দান, শেষ দান ১৮০ দিনের মধ্যে',
  lapsed: 'শেষ দান ১৮০ দিনের বেশি আগে',
};

/** The same key listDonors groups by. Use with a donation aliased as d. */
const KEY_SQL = `CASE WHEN d.donor_phone <> '' THEN d.donor_phone WHEN d.donor_email <> '' THEN d.donor_email ELSE lower(d.donor_name) END`;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });
const asChannel = (v: unknown): DonorChannel | null => ((DONOR_CHANNELS as readonly string[]).includes(String(v)) ? (v as DonorChannel) : null);
const target = (key: string) => `donor:${key}`;

export function segmentOf(d: Pick<Donor, 'gifts' | 'firstAt' | 'lastAt'>, today: string): Segment {
  const day = (iso: string) => String(iso ?? '').slice(0, 10);
  if (day(d.firstAt) >= addDays(today, -30)) return 'new';
  if (day(d.lastAt) < addDays(today, -180)) return 'lapsed';
  if (d.gifts >= 3) return 'regular';
  return d.gifts === 1 ? 'once' : 'active';
}

/** True when at least one gift (of any status) belongs to this key. */
const donorExists = async (db: D1Database, key: string) => (await donorHistory(db, key)).length > 0;

/** Name and phone of every donor in one scan, so lists do not search the gifts row by row. */
async function donorNames(db: D1Database): Promise<Map<string, { name: string; phone: string }>> {
  const { results } = await db.prepare(`SELECT ${KEY_SQL} AS k, max(d.donor_name) AS name, max(d.donor_phone) AS phone FROM donations d GROUP BY k`).all<{ k: string; name: string; phone: string }>();
  return new Map(results.map((r) => [r.k, { name: r.name, phone: r.phone }]));
}

// ---- Profile and tags --------------------------------------------------------------

export type DonorProfile = { note: string; preferredChannel: DonorChannel; doNotContact: boolean };

export async function getProfile(db: D1Database, key: string): Promise<DonorProfile> {
  const r = await db.prepare('SELECT note, preferred_channel AS preferredChannel, do_not_contact AS dnc FROM donor_profiles WHERE donor_key = ?').bind(key).first<{ note: string; preferredChannel: DonorChannel; dnc: number }>();
  return { note: r?.note ?? '', preferredChannel: r?.preferredChannel ?? 'whatsapp', doNotContact: Boolean(r?.dnc) };
}

export async function saveProfile(db: D1Database, actor: string, key: string, form: FormData): Promise<boolean> {
  if (!(await donorExists(db, key))) return false;
  const note = longText(form, 'note', 1000);
  const channel = asChannel(form.get('preferredChannel')) ?? 'whatsapp';
  const dnc = form.get('doNotContact') === 'on' ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO donor_profiles (donor_key, note, preferred_channel, do_not_contact, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (donor_key) DO UPDATE SET note = excluded.note, preferred_channel = excluded.preferred_channel, do_not_contact = excluded.do_not_contact,
       updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(key, note, channel, dnc, actor)
    .run();
  await log(db, actor, 'donor.profile', target(key), { channel, doNotContact: Boolean(dnc) });
  return true;
}

export const cleanDonorTag = (t: string) => t.replace(/[,#<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

export function parseDonorTags(form: FormData): string[] {
  const raw = [...form.getAll('tag').map(String), ...String(form.get('tags') ?? '').split(/[,،]/)];
  return [...new Set(raw.map(cleanDonorTag).filter((t) => t.length >= 2))].slice(0, 12);
}

export async function donorTags(db: D1Database, key: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT tag FROM donor_tags WHERE donor_key = ? ORDER BY tag').bind(key).all<{ tag: string }>();
  return results.map((r) => r.tag);
}

export async function setDonorTags(db: D1Database, actor: string, key: string, tags: readonly string[]): Promise<boolean> {
  if (!(await donorExists(db, key))) return false;
  const before = await donorTags(db, key);
  const add = tags.filter((t) => !before.includes(t));
  const remove = before.filter((t) => !tags.includes(t));
  if (!add.length && !remove.length) return true;
  await db.batch([
    ...remove.map((t) => db.prepare('DELETE FROM donor_tags WHERE donor_key = ? AND tag = ?').bind(key, t)),
    ...add.map((t) => db.prepare('INSERT INTO donor_tags (donor_key, tag, created_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(key, t, actor)),
  ]);
  await log(db, actor, 'donor.tags', target(key), { add, remove });
  return true;
}

export async function allDonorTags(db: D1Database): Promise<{ tag: string; count: number }[]> {
  const { results } = await db.prepare('SELECT tag, count(*) AS count FROM donor_tags GROUP BY tag ORDER BY count DESC, tag').all<{ tag: string; count: number }>();
  return results;
}

// ---- Directory with segments -----------------------------------------------------------

export type DonorRow = Donor & { segment: Segment; tags: string[]; lastContact: string | null; doNotContact: boolean };
export type DirectoryFilter = { q?: string; segment?: string; tag?: string; minTaka?: number };

export async function donorDirectory(db: D1Database, today: string, f: DirectoryFilter = {}, limit = 500): Promise<{ rows: DonorRow[]; matched: number; totalMinor: number; bySegment: Record<Segment, number> }> {
  const [donors, tags, contacts, dnc] = await Promise.all([
    listDonors(db, f.q ?? '', 2000),
    db.prepare('SELECT donor_key AS k, tag FROM donor_tags ORDER BY tag').all<{ k: string; tag: string }>(),
    db.prepare('SELECT donor_key AS k, max(created_at) AS at FROM donor_contacts GROUP BY donor_key').all<{ k: string; at: string }>(),
    db.prepare('SELECT donor_key AS k FROM donor_profiles WHERE do_not_contact = 1').all<{ k: string }>(),
  ]);
  const tagMap = new Map<string, string[]>();
  for (const t of tags.results) tagMap.set(t.k, [...(tagMap.get(t.k) ?? []), t.tag]);
  const last = new Map(contacts.results.map((c) => [c.k, c.at]));
  const blocked = new Set(dnc.results.map((d) => d.k));
  const all: DonorRow[] = donors.map((d) => ({ ...d, segment: segmentOf(d, today), tags: tagMap.get(d.key) ?? [], lastContact: last.get(d.key) ?? null, doNotContact: blocked.has(d.key) }));
  const bySegment = Object.fromEntries(SEGMENTS.map((s) => [s, all.filter((d) => d.segment === s).length])) as Record<Segment, number>;
  const min = (f.minTaka ?? 0) * 100;
  const picked = all.filter((d) => (!f.segment || d.segment === f.segment) && (!f.tag || d.tags.includes(f.tag)) && d.totalMinor >= min);
  return { rows: picked.slice(0, limit), matched: picked.length, totalMinor: picked.reduce((a, d) => a + d.totalMinor, 0), bySegment };
}

// ---- Contact log -----------------------------------------------------------------------

export function parseDonorContact(form: FormData): Result<{ channel: DonorChannel; direction: 'out' | 'in'; summary: string }> {
  const channel = asChannel(form.get('channel'));
  if (!channel) return fail('channel');
  const summary = longText(form, 'summary', 1000);
  if (summary.length < 2) return fail('summary');
  return ok({ channel, direction: form.get('direction') === 'in' ? 'in' : 'out', summary });
}

export async function logDonorContact(db: D1Database, actor: string, key: string, v: { channel: DonorChannel; direction: 'out' | 'in'; summary: string }): Promise<boolean> {
  if (!(await donorExists(db, key))) return false;
  await db
    .prepare('INSERT INTO donor_contacts (id, donor_key, channel, direction, summary, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId('dct'), key, v.channel, v.direction, v.summary.slice(0, 1000), actor)
    .run();
  await log(db, actor, 'donor.contact', target(key), { channel: v.channel, direction: v.direction });
  return true;
}

export type DonorContact = { id: string; donorKey: string; donorName: string | null; channel: DonorChannel; direction: 'out' | 'in'; summary: string; donationRef: string | null; createdBy: string; createdAt: string };

export async function listDonorContacts(db: D1Database, opts: { key?: string; limit?: number } = {}): Promise<DonorContact[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.donor_key AS donorKey, c.channel, c.direction, c.summary,
       c.donation_ref AS donationRef, c.created_by AS createdBy, c.created_at AS createdAt FROM donor_contacts c ${opts.key ? 'WHERE c.donor_key = ?' : ''} ORDER BY c.created_at DESC LIMIT ${Math.min(500, opts.limit ?? 100)}`,
    )
    .bind(...(opts.key ? [opts.key] : []))
    .all<Omit<DonorContact, 'donorName'>>();
  const names = await donorNames(db);
  return results.map((c) => ({ ...c, donorName: names.get(c.donorKey)?.name ?? null }));
}

// ---- Receipts ---------------------------------------------------------------------------

export const DEFAULT_RECEIPT_TEXT = 'আসসালামু আলাইকুম {name}। মাদরাসাতুল ইনসাফের {fund} তহবিলে আপনার {amount} দান আমরা পেয়েছি। রসিদ নং {receipt}। রসিদ দেখুন: {link} জাযাকাল্লাহু খাইরান।';
export const DONOR_TEMPLATE_VARS = ['{name}', '{amount}', '{fund}', '{receipt}', '{link}', '{date}', '{total}'] as const;
export type DonorVars = { name: string; amount: string; fund: string; receipt: string; link: string; date: string; total: string };

export const renderDonorTemplate = (body: string, v: Partial<DonorVars>) => body.replace(/\{(name|amount|fund|receipt|link|date|total)\}/g, (_, k: keyof DonorVars) => v[k] ?? '');

/** The receipt message for one counted gift, or null when it does not count. */
export async function receiptMessage(db: D1Database, reference: string, origin: string, today: string): Promise<{ key: string; phone: string; email: string; message: string; reference: string } | null> {
  const d = await donationByReference(db, reference);
  if (!d || d.status !== 'paid' || d.voidedAt) return null;
  const tpl = await db.prepare(`SELECT body FROM donor_templates WHERE purpose = 'receipt' AND status = 'active' ORDER BY updated_at DESC LIMIT 1`).first<{ body: string }>();
  const message = renderDonorTemplate(tpl?.body ?? DEFAULT_RECEIPT_TEXT, {
    name: d.donorName,
    amount: taka(d.amountMinor),
    fund: d.fundTitle,
    receipt: receiptLabel(d.receiptNo) || d.reference,
    link: `${origin}/donate/done?ref=${encodeURIComponent(d.reference)}`,
    date: dayBn(today),
  });
  return { key: d.donorPhone || d.donorEmail || d.donorName.toLowerCase(), phone: d.donorPhone, email: d.donorEmail, message, reference: d.reference };
}

/** Writes that this gift's receipt reached the donor. A second time changes nothing. */
export async function markReceiptSent(db: D1Database, actor: string, reference: string, channel: DonorChannel, origin: string, today: string): Promise<boolean> {
  const m = await receiptMessage(db, reference, origin, today);
  if (!m) return false;
  const r = await db
    .prepare(`INSERT INTO donor_contacts (id, donor_key, channel, direction, summary, donation_ref, created_by) VALUES (?, ?, ?, 'out', ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(newId('dct'), m.key, channel, `রসিদ পাঠানো হয়েছে (${reference})`, reference, actor)
    .run();
  if (r.meta.changes) await log(db, actor, 'donor.receipt', target(m.key), { reference, channel });
  return true;
}

export type ThanksItem = { reference: string; receiptNo: number | null; amountMinor: number; donorName: string; phone: string; email: string; fundTitle: string; paidAt: string; donorKey: string };

const THANKS_WHERE = `${COUNTED} AND d.paid_at >= ?1 AND (d.donor_phone <> '' OR d.donor_email <> '')
  AND NOT EXISTS (SELECT 1 FROM donor_contacts c WHERE c.donation_ref = d.reference)
  AND NOT EXISTS (SELECT 1 FROM donor_profiles p WHERE p.donor_key = ${KEY_SQL} AND p.do_not_contact = 1)`;

/** Counted gifts of the last 30 days whose receipt has not been sent yet. */
export async function thanksQueue(db: D1Database, today: string, limit = 60): Promise<ThanksItem[]> {
  const { results } = await db
    .prepare(
      `SELECT d.reference, d.receipt_no AS receiptNo, d.amount_minor AS amountMinor, d.donor_name AS donorName, d.donor_phone AS phone, d.donor_email AS email,
       f.title AS fundTitle, d.paid_at AS paidAt, ${KEY_SQL} AS donorKey FROM donations d JOIN funds f ON f.id = d.fund_id WHERE ${THANKS_WHERE} ORDER BY d.paid_at DESC LIMIT ${Math.min(200, limit)}`,
    )
    .bind(addDays(today, -30))
    .all<ThanksItem>();
  return results;
}

/** For the sidebar badge. */
export const thanksCountStatement = (db: D1Database, today: string) => db.prepare(`SELECT count(*) AS n FROM donations d WHERE ${THANKS_WHERE}`).bind(addDays(today, -30));

// ---- Follow ups ---------------------------------------------------------------------------

export function parseDonorFollowup(form: FormData, today: string): Result<{ title: string; dueOn: string; assignedTo: string }> {
  const title = text(form, 'title', 200);
  if (title.length < 2) return fail('title');
  const dueOn = text(form, 'dueOn', 10) || today;
  if (!isYmd(dueOn) || dueOn > addDays(today, 730)) return fail('due');
  return ok({ title, dueOn, assignedTo: text(form, 'assignedTo', 120) });
}

export async function addDonorFollowup(db: D1Database, actor: string, key: string, v: { title: string; dueOn: string; assignedTo: string }): Promise<boolean> {
  if (!(await donorExists(db, key))) return false;
  await db.prepare('INSERT INTO donor_followups (id, donor_key, title, due_on, assigned_to, created_by) VALUES (?, ?, ?, ?, ?, ?)').bind(newId('dfu'), key, v.title, v.dueOn, v.assignedTo, actor).run();
  await log(db, actor, 'donor.followup.create', target(key), { title: v.title, dueOn: v.dueOn });
  return true;
}

/** Closes a follow up. When done with a channel, the outcome also goes in the contact log. */
export async function closeDonorFollowup(db: D1Database, actor: string, id: string, status: 'done' | 'cancelled', outcome: string, channel: unknown = null): Promise<boolean> {
  const note = outcome.trim().slice(0, 500);
  const r = await db
    .prepare(`UPDATE donor_followups SET status = ?, outcome = ?, done_by = ?, done_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'open' RETURNING donor_key AS k, title`)
    .bind(status, note, actor, id)
    .first<{ k: string; title: string }>();
  if (!r) return false;
  const ch = asChannel(channel);
  if (status === 'done' && ch) {
    await db.prepare(`INSERT INTO donor_contacts (id, donor_key, channel, direction, summary, created_by) VALUES (?, ?, ?, 'out', ?, ?)`).bind(newId('dct'), r.k, ch, note ? `${r.title}: ${note}` : r.title, actor).run();
  }
  await log(db, actor, `donor.followup.${status}`, target(r.k), { title: r.title, outcome: note });
  return true;
}

export type DonorFollowup = { id: string; donorKey: string; donorName: string | null; phone: string | null; title: string; dueOn: string; assignedTo: string; status: 'open' | 'done' | 'cancelled'; outcome: string; doneAt: string | null };

export async function listDonorFollowups(db: D1Database, opts: { status?: 'open' | 'closed'; key?: string; limit?: number } = {}): Promise<DonorFollowup[]> {
  const conds: string[] = [];
  const binds: string[] = [];
  if (opts.status === 'open') conds.push(`x.status = 'open'`);
  if (opts.status === 'closed') conds.push(`x.status <> 'open'`);
  if (opts.key) {
    conds.push('x.donor_key = ?');
    binds.push(opts.key);
  }
  const { results } = await db
    .prepare(
      `SELECT x.id, x.donor_key AS donorKey, x.title, x.due_on AS dueOn, x.assigned_to AS assignedTo, x.status, x.outcome, x.done_at AS doneAt
       FROM donor_followups x ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${opts.status === 'closed' ? 'x.done_at DESC' : `x.status = 'open' DESC, x.due_on`} LIMIT ${Math.min(500, opts.limit ?? 200)}`,
    )
    .bind(...binds)
    .all<Omit<DonorFollowup, 'donorName' | 'phone'>>();
  const names = await donorNames(db);
  return results.map((f) => ({ ...f, donorName: names.get(f.donorKey)?.name ?? null, phone: names.get(f.donorKey)?.phone || null }));
}

// ---- Support tickets ---------------------------------------------------------------------

export function parseDonorTicket(form: FormData): Result<{ subject: string; category: TicketCategory; body: string; assignedTo: string }> {
  const subject = text(form, 'subject', 160);
  if (subject.length < 2) return fail('subject');
  const body = longText(form, 'body', 2000);
  if (body.length < 2) return fail('body');
  const c = text(form, 'category') as TicketCategory;
  return ok({ subject, body, category: TICKET_CATEGORIES.includes(c) ? c : 'other', assignedTo: text(form, 'assignedTo', 120) });
}

export async function openDonorTicket(db: D1Database, actor: string, key: string, v: { subject: string; category: TicketCategory; body: string; assignedTo: string }): Promise<Result<string>> {
  if (!(await donorExists(db, key))) return fail('donor');
  const id = newId('dtk');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.batch([
        db
          .prepare(`INSERT INTO donor_tickets (id, ticket_no, donor_key, subject, category, assigned_to, created_by) VALUES (?1, (SELECT coalesce(max(ticket_no), 0) + 1 FROM donor_tickets), ?2, ?3, ?4, ?5, ?6)`)
          .bind(id, key, v.subject, v.category, v.assignedTo, actor),
        db.prepare('INSERT INTO donor_ticket_messages (id, ticket_id, author, body) VALUES (?, ?, ?, ?)').bind(newId('dtm'), id, actor, v.body),
      ]);
      await log(db, actor, 'donor.ticket.open', target(key), { ticketId: id, subject: v.subject });
      return ok(id);
    } catch (e) {
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  return fail('ticket');
}

export async function replyDonorTicket(db: D1Database, actor: string, id: string, body: string, close: boolean): Promise<boolean> {
  const msg = body.trim().slice(0, 2000);
  if (msg.length < 2) return false;
  const t = await db.prepare(`SELECT donor_key AS k FROM donor_tickets WHERE id = ? AND status = 'open'`).bind(id).first<{ k: string }>();
  if (!t) return false;
  await db.batch([
    db.prepare('INSERT INTO donor_ticket_messages (id, ticket_id, author, body) VALUES (?, ?, ?, ?)').bind(newId('dtm'), id, actor, msg),
    close
      ? db.prepare(`UPDATE donor_tickets SET status = 'closed', closed_by = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(actor, id)
      : db.prepare(`UPDATE donor_tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(id),
  ]);
  await log(db, actor, close ? 'donor.ticket.close' : 'donor.ticket.reply', target(t.k), { ticketId: id });
  return true;
}

export type DonorTicket = { id: string; ticketNo: number; donorKey: string; donorName: string | null; subject: string; category: TicketCategory; status: 'open' | 'closed'; assignedTo: string; createdAt: string; updatedAt: string; messages: { author: string; body: string; createdAt: string }[] };

export async function listDonorTickets(db: D1Database, opts: { status?: 'open' | 'closed'; key?: string; limit?: number } = {}): Promise<DonorTicket[]> {
  const conds: string[] = [];
  const binds: string[] = [];
  if (opts.status) {
    conds.push('t.status = ?');
    binds.push(opts.status);
  }
  if (opts.key) {
    conds.push('t.donor_key = ?');
    binds.push(opts.key);
  }
  const { results } = await db
    .prepare(
      `SELECT t.id, t.ticket_no AS ticketNo, t.donor_key AS donorKey, t.subject, t.category, t.status,
       t.assigned_to AS assignedTo, t.created_at AS createdAt, t.updated_at AS updatedAt FROM donor_tickets t ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY t.status = 'open' DESC, t.updated_at DESC LIMIT ${Math.min(200, opts.limit ?? 60)}`,
    )
    .bind(...binds)
    .all<Omit<DonorTicket, 'messages' | 'donorName'>>();
  if (!results.length) return [];
  const { results: msgs } = await db
    .prepare(`SELECT ticket_id AS ticketId, author, body, created_at AS createdAt FROM donor_ticket_messages WHERE ticket_id IN (${results.map(() => '?').join(',')}) ORDER BY created_at`)
    .bind(...results.map((r) => r.id))
    .all<{ ticketId: string; author: string; body: string; createdAt: string }>();
  const names = await donorNames(db);
  return results.map((t) => ({ ...t, donorName: names.get(t.donorKey)?.name ?? null, messages: msgs.filter((m) => m.ticketId === t.id) }));
}

// ---- Templates ------------------------------------------------------------------------------

export type DonorTemplate = { id: string; name: string; purpose: 'general' | 'receipt'; body: string };

export function parseDonorTemplate(form: FormData): Result<{ name: string; purpose: 'general' | 'receipt'; body: string }> {
  const name = text(form, 'name', 80);
  if (name.length < 2) return fail('name');
  const body = longText(form, 'body', 1000);
  if (body.length < 5) return fail('body');
  return ok({ name, body, purpose: form.get('purpose') === 'receipt' ? 'receipt' : 'general' });
}

export async function saveDonorTemplate(db: D1Database, actor: string, id: string | null, v: { name: string; purpose: 'general' | 'receipt'; body: string }): Promise<Result<string>> {
  const tid = id || newId('dtp');
  try {
    if (id) {
      const r = await db.prepare(`UPDATE donor_templates SET name = ?, purpose = ?, body = ?, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(v.name, v.purpose, v.body, id).run();
      if (!r.meta.changes) return fail('missing');
    } else {
      await db.prepare('INSERT INTO donor_templates (id, name, purpose, body, created_by) VALUES (?, ?, ?, ?, ?)').bind(tid, v.name, v.purpose, v.body, actor).run();
    }
  } catch {
    return fail('name_taken');
  }
  await log(db, actor, id ? 'donor.template.update' : 'donor.template.create', `donor_template:${tid}`, { name: v.name, purpose: v.purpose });
  return ok(tid);
}

export async function archiveDonorTemplate(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE donor_templates SET status = 'archived' WHERE id = ? AND status = 'active'`).bind(id).run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'donor.template.archive', `donor_template:${id}`);
  return true;
}

export async function listDonorTemplates(db: D1Database): Promise<DonorTemplate[]> {
  const { results } = await db.prepare(`SELECT id, name, purpose, body FROM donor_templates WHERE status = 'active' ORDER BY purpose DESC, name`).all<DonorTemplate>();
  return results;
}

// ---- Timeline --------------------------------------------------------------------------------

export type DonorTimelineItem = { at: string; kind: string; title: string; detail: string; link: string; tone: 'good' | 'bad' | 'info' | 'plain' };

export async function donorTimeline(db: D1Database, key: string, limit = 120): Promise<DonorTimelineItem[]> {
  const [gifts, contacts, followups, tickets] = await Promise.all([donorHistory(db, key), listDonorContacts(db, { key, limit: 150 }), listDonorFollowups(db, { key, limit: 100 }), listDonorTickets(db, { key, limit: 50 })]);
  const out: DonorTimelineItem[] = [];
  for (const d of gifts) {
    const counted = d.status === 'paid' && !d.voidedAt;
    out.push({ at: d.paidAt ?? d.createdAt, kind: 'দান', title: `${taka(d.amountMinor)}, ${d.fundTitle}`, detail: d.voidedAt ? `বাতিল: ${d.voidReason ?? ''}` : counted ? receiptLabel(d.receiptNo) || d.reference : 'গণনায় ধরা হয়নি', link: counted ? `/donate/done?ref=${encodeURIComponent(d.reference)}` : '', tone: counted ? 'good' : 'bad' });
  }
  for (const c of contacts) out.push({ at: c.createdAt, kind: c.donationRef ? 'রসিদ' : 'যোগাযোগ', title: `${DONOR_CHANNEL_BN[c.channel]}${c.direction === 'in' ? ' (দাতা থেকে)' : ''}`, detail: `${c.summary} · ${c.createdBy}`, link: '', tone: 'info' });
  for (const f of followups) {
    out.push({ at: `${f.dueOn}T06:00:00.000Z`, kind: 'ফলো আপ', title: f.title, detail: f.status === 'open' ? `তারিখ ${dayBn(f.dueOn)}` : `${f.status === 'done' ? 'শেষ' : 'বাতিল'}${f.outcome ? `: ${f.outcome}` : ''}`, link: '', tone: f.status === 'done' ? 'good' : 'plain' });
  }
  for (const t of tickets) out.push({ at: t.createdAt, kind: 'টিকেট', title: `টিকেট #${bnDigits(t.ticketNo)}: ${t.subject}`, detail: `${TICKET_CATEGORY_BN[t.category]} · ${t.status === 'open' ? 'খোলা' : 'বন্ধ'}`, link: '/admin/donors/desk?tab=tickets', tone: t.status === 'open' ? 'bad' : 'plain' });
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

// ---- Engagement report -----------------------------------------------------------------------

export async function donorEngagement(db: D1Database, today: string) {
  const year = Number(today.slice(0, 4));
  const since30 = `${addDays(today, -30)}T00:00:00`;
  const dhakaYear = `substr(datetime(d.paid_at, '+6 hours'), 1, 4)`;
  const [dir, retention, channels, fu, tickets, receipts] = await Promise.all([
    donorDirectory(db, today, {}, 2000),
    db
      .prepare(
        `WITH y AS (SELECT DISTINCT ${KEY_SQL} AS k, ${dhakaYear} AS yr FROM donations d WHERE ${COUNTED})
         SELECT (SELECT count(*) FROM y WHERE yr = ?1) AS lastYear, (SELECT count(*) FROM y a WHERE a.yr = ?1 AND EXISTS (SELECT 1 FROM y b WHERE b.k = a.k AND b.yr = ?2)) AS kept`,
      )
      .bind(String(year - 1), String(year))
      .first<{ lastYear: number; kept: number }>(),
    db.prepare('SELECT channel, count(*) AS n FROM donor_contacts WHERE created_at >= ? GROUP BY channel ORDER BY n DESC').bind(since30).all<{ channel: DonorChannel; n: number }>(),
    db
      .prepare(
        `SELECT sum(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, sum(CASE WHEN status = 'open' AND due_on < ?1 THEN 1 ELSE 0 END) AS overdue,
         sum(CASE WHEN status = 'done' AND done_at >= ?2 THEN 1 ELSE 0 END) AS done30 FROM donor_followups`,
      )
      .bind(today, since30)
      .first<{ open: number | null; overdue: number | null; done30: number | null }>(),
    db.prepare(`SELECT sum(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, count(*) AS total FROM donor_tickets`).first<{ open: number | null; total: number }>(),
    db
      .prepare(`SELECT count(*) AS gifts, sum(CASE WHEN EXISTS (SELECT 1 FROM donor_contacts c WHERE c.donation_ref = d.reference) THEN 1 ELSE 0 END) AS sent FROM donations d WHERE ${COUNTED} AND d.paid_at >= ?`)
      .bind(since30)
      .first<{ gifts: number; sent: number | null }>(),
  ]);
  const lapsedTop = dir.rows.filter((d) => d.segment === 'lapsed' && !d.doNotContact).sort((a, b) => b.totalMinor - a.totalMinor).slice(0, 20);
  return {
    donors: dir.matched,
    totalMinor: dir.totalMinor,
    bySegment: dir.bySegment,
    retention: { lastYear: retention?.lastYear ?? 0, kept: retention?.kept ?? 0, percent: retention?.lastYear ? Math.round(((retention.kept ?? 0) / retention.lastYear) * 100) : null },
    channels: channels.results,
    followups: { open: fu?.open ?? 0, overdue: fu?.overdue ?? 0, done30: fu?.done30 ?? 0 },
    tickets: { open: tickets?.open ?? 0, total: tickets?.total ?? 0 },
    receipts: { gifts: receipts?.gifts ?? 0, sent: receipts?.sent ?? 0 },
    lapsedTop,
  };
}
