import { log } from './admin';
import { cleanPhone, longText, newId, PHONE, text, type Result } from './ops-util';

// Admission inquiries from the public site (/admission/apply): a parent
// leaves the child's name, a phone number and the class wanted; the office
// calls back and marks what happened. Nothing is admitted automatically:
// admission itself stays on the students page, where fees are agreed.

export const INQUIRY_STATUSES = ['new', 'contacted', 'admitted', 'closed'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
export const INQUIRY_STATUS_BN: Record<InquiryStatus, string> = { new: 'নতুন', contacted: 'যোগাযোগ হয়েছে', admitted: 'ভর্তি হয়েছে', closed: 'বন্ধ' };

export type InquiryInput = { studentName: string; guardianName: string; phone: string; desiredClass: string; message: string };

export function parseInquiryForm(form: FormData): Result<InquiryInput> {
  // A hidden field people never see; bots fill it.
  if (String(form.get('website') ?? '') !== '') return { ok: false, error: 'spam' };
  const studentName = text(form, 'studentName', 120);
  if (studentName.length < 2 || /[<>]/.test(studentName)) return { ok: false, error: 'name' };
  const phone = cleanPhone(text(form, 'phone', 25));
  if (!PHONE.test(phone)) return { ok: false, error: 'phone' };
  const guardianName = text(form, 'guardianName', 120);
  const desiredClass = text(form, 'desiredClass', 120);
  if (/[<>]/.test(guardianName + desiredClass)) return { ok: false, error: 'name' };
  return { ok: true, value: { studentName, guardianName, phone, desiredClass, message: longText(form, 'message', 1000) } };
}

export async function createInquiry(db: D1Database, v: InquiryInput): Promise<string> {
  const id = newId('inq');
  await db
    .prepare('INSERT INTO admission_inquiries (id, student_name, guardian_name, phone, desired_class, message) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, v.studentName, v.guardianName, v.phone, v.desiredClass, v.message)
    .run();
  return id;
}

export type Inquiry = InquiryInput & { id: string; status: InquiryStatus; staffNote: string; handledBy: string | null; createdAt: string; updatedAt: string };

export async function listInquiries(db: D1Database, status: InquiryStatus | '' = '', limit = 200): Promise<Inquiry[]> {
  const { results } = await db
    .prepare(
      `SELECT id, student_name AS studentName, guardian_name AS guardianName, phone, desired_class AS desiredClass, message, status, staff_note AS staffNote,
         handled_by AS handledBy, created_at AS createdAt, updated_at AS updatedAt FROM admission_inquiries ${status ? 'WHERE status = ?' : ''}
       ORDER BY status = 'new' DESC, created_at DESC LIMIT ?`,
    )
    .bind(...(status ? [status] : []), limit)
    .all<Inquiry>();
  return results;
}

export async function updateInquiry(db: D1Database, actor: string, id: string, status: string, note: string): Promise<boolean> {
  if (!(INQUIRY_STATUSES as readonly string[]).includes(status)) return false;
  const r = await db
    .prepare(`UPDATE admission_inquiries SET status = ?, staff_note = ?, handled_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .bind(status, note.trim().slice(0, 1000), actor, id)
    .run();
  if (r.meta.changes) await log(db, actor, 'inquiry.update', `inquiry:${id}`, { status });
  return r.meta.changes > 0;
}

export async function newInquiryCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM admission_inquiries WHERE status = 'new'").first<{ n: number }>())?.n ?? 0;
}

export async function getInquiry(db: D1Database, id: string) {
  return db.prepare(`SELECT id, student_name AS studentName, phone, status, staff_note AS staffNote
    FROM admission_inquiries WHERE id = ?`).bind(id).first<Pick<Inquiry, 'id' | 'studentName' | 'phone' | 'status' | 'staffNote'>>();
}
