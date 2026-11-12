import { log } from './admin';
import { notifyStudents } from './notifications';
import { longText, newId, text, type Result } from './ops-util';
import { dayBn, isYmd, studentCode } from '../lib/offline';

// Certificates the office issues to a student: transfer (TC), character,
// study (currently studying), completion, or any other. Each gets a running
// serial number and a random verification code; anyone holding the paper
// can check it at /verify/<code>, which shows only the certificate's kind,
// the student's name and ID, the date and whether it is still valid. The
// wording starts from a plain template and the office edits it before
// issuing, so the paper always says what the madrasa approves. A wrong
// certificate is revoked with a reason, never deleted.

export const CERT_KINDS = ['transfer', 'character', 'study', 'completion', 'other'] as const;
export type CertKind = (typeof CERT_KINDS)[number];
export const CERT_KIND_BN: Record<CertKind, string> = {
  transfer: 'ছাড়পত্র (ট্রান্সফার সার্টিফিকেট)',
  character: 'চারিত্রিক সনদ',
  study: 'অধ্যয়ন প্রত্যয়নপত্র',
  completion: 'সমাপনী সনদ',
  other: 'অন্যান্য সনদ',
};

export type StudentFacts = { name: string; code: string; course: string; batch: string; since: string };

/** A starting text for each kind, filled with the student's record. The office edits it before issuing. */
export function certificateTemplate(kind: CertKind, f: StudentFacts): { title: string; body: string } {
  const who = `${f.name}${f.code ? ` (আইডি ${f.code})` : ''}`;
  const where = [f.course, f.batch].filter(Boolean).join(', ');
  switch (kind) {
    case 'transfer':
      return {
        title: 'ছাড়পত্র',
        body: `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, ${who} এই মাদরাসায় ${where || '...'} এ অধ্যয়ন করেছে${f.since ? ` (ভর্তি: ${f.since})` : ''}। তার নিকট মাদরাসার কোনো পাওনা নেই। অভিভাবকের আবেদনের প্রেক্ষিতে তাকে ছাড়পত্র দেওয়া হলো।`,
      };
    case 'character':
      return { title: 'চারিত্রিক সনদপত্র', body: `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, ${who} এই মাদরাসার একজন ছাত্র${where ? ` (${where})` : ''}। আমার জানামতে সে রাষ্ট্র বা সমাজবিরোধী কোনো কাজে জড়িত নয়।` };
    case 'study':
      return { title: 'প্রত্যয়নপত্র', body: `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, ${who} বর্তমানে এই মাদরাসায় ${where || '...'} এ অধ্যয়নরত আছে।` };
    case 'completion':
      return { title: 'সমাপনী সনদপত্র', body: `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, ${who} এই মাদরাসা থেকে ${where || '...'} সফলভাবে সমাপ্ত করেছে।` };
    default:
      return { title: 'সনদপত্র', body: `এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, ${who} ` };
  }
}

/** What the office knows about the student, for the template. */
export async function studentFacts(db: D1Database, studentId: string): Promise<StudentFacts | null> {
  const r = await db
    .prepare(
      `SELECT s.name, s.student_no AS no, c.title AS course, coalesce(b.name, e.batch, '') AS batch, e.start_date AS since
       FROM offline_students s LEFT JOIN offline_enrollments e ON e.id = (SELECT id FROM offline_enrollments x WHERE x.student_id = s.id ORDER BY x.status = 'active' DESC, x.start_date DESC LIMIT 1)
       LEFT JOIN offline_courses c ON c.id = e.course_id LEFT JOIN offline_batches b ON b.id = e.batch_id WHERE s.id = ?`,
    )
    .bind(studentId)
    .first<{ name: string; no: number | null; course: string | null; batch: string | null; since: string | null }>();
  if (!r) return null;
  return { name: r.name, code: studentCode(r.no), course: r.course ?? '', batch: r.batch ?? '', since: r.since ? dayBn(r.since) : '' };
}

export type CertInput = { studentId: string; kind: CertKind; title: string; body: string; issuedOn: string };

export function parseCertificateForm(form: FormData, today: string): Result<CertInput> {
  const studentId = text(form, 'studentId', 40);
  if (!studentId) return { ok: false, error: 'student' };
  const kind = text(form, 'kind') as CertKind;
  if (!(CERT_KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'kind' };
  const title = text(form, 'title', 120);
  if (title.length < 2) return { ok: false, error: 'title' };
  const body = longText(form, 'body', 3000);
  if (body.length < 10) return { ok: false, error: 'body' };
  const issuedOn = text(form, 'issuedOn', 10) || today;
  if (!isYmd(issuedOn) || issuedOn > today) return { ok: false, error: 'date' };
  return { ok: true, value: { studentId, kind, title, body, issuedOn } };
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 10 characters without look-alikes (0/O, 1/I): about 50 bits, not guessable. */
export function verifyCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
export const isVerifyCode = (c: string) => /^[A-HJ-NP-Z2-9]{10}$/.test(c);

export async function issueCertificate(db: D1Database, actor: string, v: CertInput): Promise<Result<string>> {
  const s = await db.prepare('SELECT id FROM offline_students WHERE id = ?').bind(v.studentId).first();
  if (!s) return { ok: false, error: 'student' };
  const id = newId('crt');
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = verifyCode();
    try {
      await db
        .prepare(
          `INSERT INTO certificates (id, serial_no, code, student_id, kind, title, body, issued_on, issued_by)
           VALUES (?, (SELECT coalesce(max(serial_no), 0) + 1 FROM certificates), ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, code, v.studentId, v.kind, v.title, v.body, v.issuedOn, actor)
        .run();
      await log(db, actor, 'certificate.issue', `offline_student:${v.studentId}`, { certificateId: id, kind: v.kind });
      await notifyStudents(db, actor, [v.studentId], { title: `${CERT_KIND_BN[v.kind]} তৈরি হয়েছে`, body: 'মূল কপি অফিস থেকে সংগ্রহ করুন।', sourceKey: `certificate:${id}` });
      return { ok: true, value: id };
    } catch {
      // A serial or code clash with another issue at the same moment: try again.
    }
  }
  return { ok: false, error: 'busy' };
}

export type Certificate = {
  id: string;
  serialNo: number;
  code: string;
  studentId: string;
  studentName: string;
  studentNo: number | null;
  kind: CertKind;
  title: string;
  body: string;
  issuedOn: string;
  issuedBy: string;
  status: 'issued' | 'revoked';
  revokeReason: string | null;
  createdAt: string;
};

const CERT_SELECT = `SELECT c.id, c.serial_no AS serialNo, c.code, c.student_id AS studentId, s.name AS studentName, s.student_no AS studentNo, c.kind, c.title, c.body,
  c.issued_on AS issuedOn, c.issued_by AS issuedBy, c.status, c.revoke_reason AS revokeReason, c.created_at AS createdAt
  FROM certificates c JOIN offline_students s ON s.id = c.student_id`;

export async function listCertificates(db: D1Database, limit = 200): Promise<Certificate[]> {
  const { results } = await db.prepare(`${CERT_SELECT} ORDER BY c.serial_no DESC LIMIT ?`).bind(limit).all<Certificate>();
  return results;
}

export async function certificatesOfStudent(db: D1Database, studentId: string): Promise<Certificate[]> {
  const { results } = await db.prepare(`${CERT_SELECT} WHERE c.student_id = ? ORDER BY c.serial_no DESC`).bind(studentId).all<Certificate>();
  return results;
}

export const getCertificate = (db: D1Database, id: string) => db.prepare(`${CERT_SELECT} WHERE c.id = ?`).bind(id).first<Certificate>();

/** The few facts the public verification page shows. Nothing else (no phone, address or body). */
export async function verifyCertificate(db: D1Database, code: string) {
  const c = code.trim().toUpperCase();
  if (!isVerifyCode(c)) return null;
  const r = await db.prepare(`${CERT_SELECT} WHERE c.code = ?`).bind(c).first<Certificate>();
  if (!r) return null;
  return { serialNo: r.serialNo, kind: r.kind, title: r.title, studentName: r.studentName, studentCode: studentCode(r.studentNo), issuedOn: r.issuedOn, valid: r.status === 'issued' };
}

export async function revokeCertificate(db: D1Database, actor: string, id: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE certificates SET status = 'revoked', revoked_by = ?, revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoke_reason = ?
       WHERE id = ? AND status = 'issued' RETURNING student_id AS studentId`,
    )
    .bind(actor, why, id)
    .first<{ studentId: string }>();
  if (!r) return false;
  await log(db, actor, 'certificate.revoke', `offline_student:${r.studentId}`, { certificateId: id, reason: why });
  return true;
}
