import { logContactsBulk } from './crm';
import { log } from './admin';
import { savedConfig, type ConfigEnv } from './config';
import { allEnrollments, type EnrollmentWithLedger } from './offline';
import { taka } from '../lib/format';
import { dayBn, studentCode } from '../lib/offline';
import { SITE } from '../lib/site';

// Due reminders sent by the site to many students at once: by email (free,
// through Cloudflare Email Sending) or by SMS (paid per message, through
// BulkSMSBD, only once the owner saves an SMS key on the system page).
// Who gets what is worked out here from the ledger; the browser only says
// which enrollments were ticked and the message text.

export type ReminderEnv = ConfigEnv & { EMAIL?: SendEmail; MAIL_FROM?: string };
export type Channel = 'email' | 'sms';
export type DueKind = 'overdue' | 'month' | 'all';

export const MAX_PER_SEND = 200;

/** The amount a reminder talks about: what is late, else the next payment, else everything due. */
export function reminderAmount(e: EnrollmentWithLedger, kind: DueKind): number {
  return kind === 'overdue' ? e.ledger.overdueMinor : (e.ledger.next?.amountMinor ?? e.ledger.dueMinor);
}

/** Fills {name}, {course}, {amount}, {date}, {id}. Unknown words stay as they are. */
export function fillTemplate(template: string, e: EnrollmentWithLedger, kind: DueKind): string {
  const vars: Record<string, string> = {
    name: e.studentName,
    course: e.courseTitle,
    amount: taka(reminderAmount(e, kind)),
    date: dayBn(e.ledger.next?.dueDate),
    id: studentCode(e.studentNo),
  };
  return template.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);
}

/** Bangladeshi mobile number as 8801XXXXXXXXX, or null. */
export function smsNumber(phone: string): string | null {
  const d = phone.replace(/\D/g, '');
  const local = d.startsWith('880') ? d.slice(2) : d.startsWith('88') ? d.slice(2) : d;
  return /^01[3-9]\d{8}$/.test(local) ? `88${local}` : null;
}

export async function smsReady(db: D1Database, env: ConfigEnv): Promise<boolean> {
  const c = await savedConfig(db, env);
  return Boolean(c.smsApiKey && c.smsSenderId);
}

/** One SMS through BulkSMSBD. True when the service accepted it (response code 202). */
export async function sendSms(apiKey: string, senderId: string, to: string, message: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const url = new URL('https://bulksmsbd.net/api/smsapi');
  url.search = new URLSearchParams({ api_key: apiKey, type: 'text', number: to, senderid: senderId, message }).toString();
  try {
    const res = await fetcher(url.toString(), { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { response_code?: number } | null;
    return body?.response_code === 202;
  } catch {
    return false;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function sendEmail(env: ReminderEnv, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.EMAIL) return false;
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.MAIL_FROM ?? 'no-reply@madrasatulinsaf.org', name: SITE.nameBn },
      replyTo: SITE.email,
      subject,
      text,
      html: `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.7;color:#13241b"><p style="white-space:pre-line">${escapeHtml(text)}</p></body></html>`,
    });
    return true;
  } catch (err) {
    console.error('reminder email failed', err);
    return false;
  }
}

export type SendResult = { sent: number; skipped: number; failed: number };

/**
 * Sends the reminder to the ticked enrollments that still owe money. Email
 * goes only to students with a Gmail on record; SMS only to valid mobile
 * numbers. At most MAX_PER_SEND at a time.
 */
export async function sendReminders(
  db: D1Database,
  env: ReminderEnv,
  actor: string,
  opts: { enrollmentIds: string[]; template: string; channel: Channel; kind: DueKind; today: string },
  fetcher: typeof fetch = fetch,
): Promise<SendResult | { error: 'none' | 'too_many' | 'sms_off' | 'email_off' | 'template' }> {
  const ids = [...new Set(opts.enrollmentIds)];
  if (!ids.length) return { error: 'none' };
  if (ids.length > MAX_PER_SEND) return { error: 'too_many' };
  const template = opts.template.replace(/\r\n/g, '\n').trim().slice(0, 1000);
  if (template.length < 5) return { error: 'template' };
  const cfg = await savedConfig(db, env);
  if (opts.channel === 'sms' && !(cfg.smsApiKey && cfg.smsSenderId)) return { error: 'sms_off' };
  if (opts.channel === 'email' && !env.EMAIL) return { error: 'email_off' };

  const wanted = new Set(ids);
  const all = (await allEnrollments(db, opts.today)).filter((e) => wanted.has(e.id) && e.status === 'active' && e.ledger.dueMinor > 0);
  const emails = new Map<string, string>();
  if (opts.channel === 'email' && all.length) {
    const sids = [...new Set(all.map((e) => e.studentId))];
    const { results } = await db
      .prepare(`SELECT id, email FROM offline_students WHERE id IN (${sids.map(() => '?').join(',')})`)
      .bind(...sids)
      .all<{ id: string; email: string }>();
    for (const r of results) if (r.email) emails.set(r.id, r.email);
  }
  const out: SendResult = { sent: 0, skipped: ids.length - all.length, failed: 0 };
  const reached: string[] = [];
  for (const e of all) {
    const text = fillTemplate(template, e, opts.kind);
    let ok: boolean;
    if (opts.channel === 'sms') {
      const to = smsNumber(e.studentPhone);
      if (!to) {
        out.skipped++;
        continue;
      }
      ok = await sendSms(cfg.smsApiKey, cfg.smsSenderId, to, text, fetcher);
    } else {
      const to = emails.get(e.studentId);
      if (!to) {
        out.skipped++;
        continue;
      }
      ok = await sendEmail(env, to, `${SITE.nameBn}: ফি পরিশোধের অনুরোধ`, text);
    }
    if (ok) {
      out.sent++;
      reached.push(e.studentId);
    } else out.failed++;
  }
  await logContactsBulk(db, actor, reached, opts.channel === 'sms' ? 'sms' : 'email', 'বকেয়া ফির রিমাইন্ডার পাঠানো হয়েছে');
  await log(db, actor, `reminder.${opts.channel}`, 'offline_dues', { ...out, kind: opts.kind });
  return out;
}
