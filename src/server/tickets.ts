import { log } from './admin';

// Tickets: an offline student or a teacher writes to the office, the office
// replies, and either side can close it. A reply from the office marks it
// "answered"; a reply from the student or teacher opens it again.

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

export const TICKET_CATEGORIES = ['fee', 'class', 'material', 'profile', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_CATEGORY_BN: Record<TicketCategory, string> = {
  fee: 'ফি ও পেমেন্ট',
  class: 'ক্লাস ও রুটিন',
  material: 'পড়ার উপকরণ',
  profile: 'আমার তথ্য',
  other: 'অন্যান্য',
};
export type TicketStatus = 'open' | 'answered' | 'closed';
export const TICKET_STATUS_BN: Record<TicketStatus, string> = { open: 'উত্তরের অপেক্ষায়', answered: 'উত্তর দেওয়া হয়েছে', closed: 'বন্ধ' };

export type Ticket = {
  id: string;
  ticketNo: number;
  fromKind: 'student' | 'teacher';
  offlineStudentId: string | null;
  teacherId: string | null;
  fromName: string;
  fromPhone: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  closedBy: string | null;
  createdAt: string;
  updatedAt: string;
  messages: number;
};
export type TicketMessage = { id: string; authorKind: 'student' | 'teacher' | 'staff'; author: string; body: string; createdAt: string };

export type TicketOwner = { kind: 'student'; offlineStudentId: string } | { kind: 'teacher'; teacherId: string };

const SELECT = `SELECT k.id, k.ticket_no AS ticketNo, k.from_kind AS fromKind, k.offline_student_id AS offlineStudentId, k.teacher_id AS teacherId,
  coalesce(s.name, t.name, '') AS fromName, coalesce(s.phone, t.phone, '') AS fromPhone, k.subject, k.category, k.status, k.closed_by AS closedBy,
  k.created_at AS createdAt, k.updated_at AS updatedAt, (SELECT count(*) FROM ticket_messages m WHERE m.ticket_id = k.id) AS messages
  FROM tickets k LEFT JOIN offline_students s ON s.id = k.offline_student_id LEFT JOIN teachers t ON t.id = k.teacher_id`;

type Input = { subject: string; category: TicketCategory; body: string };

export function parseTicketForm(form: FormData): { ok: true; value: Input } | { ok: false; error: string } {
  const subject = String(form.get('subject') ?? '').trim().slice(0, 160);
  if (subject.length < 3) return { ok: false, error: 'subject' };
  const category = String(form.get('category') ?? 'other') as TicketCategory;
  const body = String(form.get('body') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (body.length < 3) return { ok: false, error: 'body' };
  return { ok: true, value: { subject, category: TICKET_CATEGORIES.includes(category) ? category : 'other', body } };
}

export const parseReply = (form: FormData) => String(form.get('body') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);

export async function openTicket(db: D1Database, actor: string, owner: TicketOwner, v: Input): Promise<string> {
  const id = newId('tkt');
  for (let attempt = 0; ; attempt++) {
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO tickets (id, ticket_no, from_kind, offline_student_id, teacher_id, subject, category)
             VALUES (?, (SELECT coalesce(max(ticket_no), 0) + 1 FROM tickets), ?, ?, ?, ?, ?)`,
          )
          .bind(id, owner.kind, owner.kind === 'student' ? owner.offlineStudentId : null, owner.kind === 'teacher' ? owner.teacherId : null, v.subject, v.category),
        db.prepare('INSERT INTO ticket_messages (id, ticket_id, author_kind, author, body) VALUES (?, ?, ?, ?, ?)').bind(newId('tkm'), id, owner.kind, actor, v.body),
      ]);
      break;
    } catch (e) {
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  await log(db, actor, 'ticket.open', `ticket:${id}`, { subject: v.subject, from: owner.kind });
  return id;
}

/** Tickets, open ones first. Filter by owner for a panel, or by status for the office. */
export async function listTickets(
  db: D1Database,
  opts: { offlineStudentIds?: string[]; teacherId?: string; status?: TicketStatus | 'active'; limit?: number } = {},
): Promise<Ticket[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.offlineStudentIds) {
    if (!opts.offlineStudentIds.length) return [];
    where.push(`k.offline_student_id IN (${opts.offlineStudentIds.map(() => '?').join(',')})`);
    args.push(...opts.offlineStudentIds);
  }
  if (opts.teacherId) {
    where.push('k.teacher_id = ?');
    args.push(opts.teacherId);
  }
  if (opts.status === 'active') where.push(`k.status != 'closed'`);
  else if (opts.status) {
    where.push('k.status = ?');
    args.push(opts.status);
  }
  const { results } = await db
    .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY k.status = 'open' DESC, k.status = 'closed', k.updated_at DESC LIMIT ?`)
    .bind(...args, opts.limit ?? 200)
    .all<Ticket>();
  return results;
}

export async function getTicket(db: D1Database, id: string): Promise<{ ticket: Ticket; messages: TicketMessage[] } | null> {
  const ticket = await db.prepare(`${SELECT} WHERE k.id = ?`).bind(id).first<Ticket>();
  if (!ticket) return null;
  const { results } = await db
    .prepare('SELECT id, author_kind AS authorKind, author, body, created_at AS createdAt FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at')
    .bind(id)
    .all<TicketMessage>();
  return { ticket, messages: results };
}

export const ownsTicket = (t: Ticket, owner: { offlineStudentIds?: string[]; teacherId?: string }) =>
  (t.fromKind === 'student' && Boolean(t.offlineStudentId && owner.offlineStudentIds?.includes(t.offlineStudentId))) ||
  (t.fromKind === 'teacher' && Boolean(owner.teacherId && t.teacherId === owner.teacherId));

/** Adds a reply. The office's reply marks it answered; the asker's reply opens it again (also after it was closed). */
export async function replyTicket(db: D1Database, actor: string, id: string, by: 'student' | 'teacher' | 'staff', body: string): Promise<boolean> {
  if (body.length < 1) return false;
  const status: TicketStatus = by === 'staff' ? 'answered' : 'open';
  const out = await db.batch([
    db
      .prepare(`UPDATE tickets SET status = ?, closed_by = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .bind(status, id),
    db.prepare('INSERT INTO ticket_messages (id, ticket_id, author_kind, author, body) SELECT ?, id, ?, ?, ? FROM tickets WHERE id = ?').bind(newId('tkm'), by, actor, body, id),
  ]);
  if (!out[1]?.meta.changes) return false;
  await log(db, actor, 'ticket.reply', `ticket:${id}`, { by });
  return true;
}

export async function closeTicket(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE tickets SET status = 'closed', closed_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status != 'closed'`)
    .bind(actor, id)
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'ticket.close', `ticket:${id}`, {});
  return true;
}

export async function openTicketCount(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT count(*) AS n FROM tickets WHERE status = 'open'`).first<{ n: number }>();
  return r?.n ?? 0;
}
