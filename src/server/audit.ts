// Reading the audit log (admin_events): who did what, to which record,
// when, and from which address. Only owners see it (/admin/audit).

export type AuditRow = { id: string; actor: string; action: string; target: string; detailJson: string; ip: string; createdAt: string };

/** Bangla names for the actions; anything else is shown as it is stored. */
export const ACTION_BN: Record<string, string> = {
  'accounts.income': 'অন্যান্য আয় লেখা',
  'accounts.transfer': 'হিসাবের মধ্যে স্থানান্তর',
  'accounts.entry.void': 'আয় বা স্থানান্তর বাতিল',
  'accounts.project.create': 'নতুন প্রকল্প',
  'accounts.project.update': 'প্রকল্প বদল',
  'accounts.fund.create': 'নতুন তহবিল',
  'accounts.fund.update': 'তহবিল বদল',
  'accounts.fund.override': 'তহবিলের ব্যালেন্সের বেশি খরচের অনুমতি',
  'accounts.account.create': 'নতুন হিসাব',
  'accounts.account.update': 'হিসাব বদল',
  'accounts.course.project': 'বিভাগ প্রকল্পে বসানো',
  'accounts.budget.save': 'বাজেট সংরক্ষণ',
  'accounts.budget.remove': 'বাজেট সরানো',
  'accounts.reconcile': 'ব্যাংক বা ক্যাশ মেলানো',
  'accounts.clear': 'স্টেটমেন্টের সাথে লাইন মেলানো',
  'accounts.period.close': 'হিসাবের সময় বন্ধ',
  'accounts.period.reopen': 'বন্ধ হিসাব আবার খোলা',
  'crm.tags': 'ছাত্রের ট্যাগ বদল',
  'crm.followup.create': 'ছাত্রের ফলো আপ',
  'crm.followup.done': 'ছাত্রের ফলো আপ শেষ',
  'crm.followup.cancelled': 'ছাত্রের ফলো আপ বাতিল',
  'crm.template.create': 'নতুন টেমপ্লেট',
  'crm.template.update': 'টেমপ্লেট বদল',
  'crm.template.archive': 'টেমপ্লেট সরানো',
  'donation.manual': 'অফিসে পাওয়া দান লেখা',
  'donation.void': 'দান বাতিল',
  'donation.accept': 'যাচাইয়ের দান গ্রহণ',
  'donation.reject': 'যাচাইয়ের দান বাদ',
  'donor.profile': 'দাতার তথ্য বদল',
  'donor.tags': 'দাতার ট্যাগ বদল',
  'donor.contact': 'দাতার সাথে যোগাযোগ',
  'donor.receipt': 'দাতাকে রসিদ পাঠানো',
  'donor.followup.create': 'দাতার ফলো আপ',
  'donor.followup.done': 'দাতার ফলো আপ শেষ',
  'donor.followup.cancelled': 'দাতার ফলো আপ বাতিল',
  'donor.ticket.open': 'দাতার টিকেট খোলা',
  'donor.ticket.reply': 'দাতার টিকেটে উত্তর',
  'donor.ticket.close': 'দাতার টিকেট বন্ধ',
  'donor.template.create': 'দাতার নতুন টেমপ্লেট',
  'donor.template.update': 'দাতার টেমপ্লেট বদল',
  'donor.template.archive': 'দাতার টেমপ্লেট সরানো',
  'expense.checked': 'খরচ যাচাই (১ম ধাপ)',
  'attendance.save': 'হাজিরা সংরক্ষণ',
  'batch.create': 'নতুন ব্যাচ',
  'batch.update': 'ব্যাচ বদল',
  'batch.teacher.add': 'ব্যাচে বিষয়ের শিক্ষক যোগ',
  'batch.teacher.remove': 'ব্যাচ থেকে শিক্ষক সরানো',
  'blog.create': 'ব্লগ লেখা',
  'blog.update': 'ব্লগ বদল',
  'blog.delete': 'ব্লগ মুছে ফেলা',
  'config.update': 'সিস্টেম সেটিংস বদল',
  'config.logo': 'লোগো বদল',
  'course.create': 'নতুন কোর্স',
  'course.update': 'কোর্স বদল',
  'enrollment.grant': 'কোর্স খুলে দেওয়া',
  'enrollment.revoke': 'কোর্স বন্ধ করা',
  'exam.create': 'পরীক্ষা যোগ',
  'exam.cancel': 'পরীক্ষা বাতিল',
  'expense.create': 'খরচ লেখা',
  'expense.void': 'খরচ বাতিল',
  'expense.approved': 'খরচ অনুমোদন',
  'expense.rejected': 'খরচ নামঞ্জুর',
  'fee_online.start': 'অনলাইনে ফি দেওয়া শুরু',
  'fee_online.resolve': 'অনলাইন ফি মিটমাট',
  'leave.request': 'ছুটির আবেদন',
  'leave.approved': 'ছুটি অনুমোদন',
  'leave.rejected': 'ছুটি নামঞ্জুর',
  'leave.cancel': 'ছুটির আবেদন ফেরত',
  'material.add': 'উপকরণ দেওয়া',
  'material.hide': 'উপকরণ লুকানো',
  'notice.create': 'নোটিশ দেওয়া',
  'notice.hidden': 'নোটিশ লুকানো',
  'notice.published': 'নোটিশ আবার দেখানো',
  'offline.charge.add': 'বাড়তি ফি যোগ',
  'offline.charge.void': 'বাড়তি ফি মাফ',
  'offline.course.create': 'নতুন বিভাগ',
  'offline.course.update': 'বিভাগ বদল',
  'offline.enroll': 'ভর্তি',
  'offline.enrollment.update': 'ভর্তির তথ্য বদল',
  'offline.late_fees': 'লেট ফি যোগ (নিজে থেকে)',
  'offline.payment': 'ফি জমা',
  'offline.payment.void': 'রসিদ বাতিল',
  'offline.student.create': 'নতুন ছাত্র',
  'offline.student.update': 'ছাত্রের তথ্য বদল',
  'offline.student.block': 'ছাত্রের অ্যাকাউন্ট বন্ধ',
  'offline.student.unblock': 'ছাত্রের অ্যাকাউন্ট চালু',
  'order.approve': 'অর্ডার অনুমোদন',
  'order.reject': 'অর্ডার বাতিল',
  'payroll.generate': 'বেতন শিট তৈরি',
  'payroll.edit': 'বেতন শিট বদল',
  'payroll.approve': 'বেতন শিট অনুমোদন',
  'payroll.paid': 'বেতন দেওয়া',
  'payroll.reopen': 'বেতন শিট আবার খোলা',
  'rating.submit': 'শিক্ষক মূল্যায়ন',
  'reminder.email': 'বকেয়ার ইমেইল পাঠানো',
  'reminder.sms': 'বকেয়ার SMS পাঠানো',
  'routine.upload': 'রুটিন ফাইল আপলোড',
  'settings.update': 'অফিসের নিয়ম বদল',
  'staff.add': 'টিমে যোগ',
  'staff.remove': 'টিম থেকে বাদ',
  'staff.scope': 'টিমের অনুমতি বদল',
  'staff.modules': 'টিমের অনুমতি বদল',
  'staff.access': 'টিমের পদ ও ক্ষমতা বদল',
  'teacher.create': 'নতুন শিক্ষক বা কর্মী',
  'teacher.update': 'শিক্ষকের তথ্য বদল',
  'ticket.open': 'টিকেট খোলা',
  'ticket.reply': 'টিকেটে উত্তর',
  'ticket.close': 'টিকেট বন্ধ',
};

export type AuditFilter = { actor?: string; action?: string; from?: string; to?: string; q?: string; before?: string };

/** Newest first, 100 at a time; `before` (a created_at) continues the list. */
export async function auditLog(db: D1Database, f: AuditFilter, limit = 100): Promise<AuditRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    where.push(sql);
    args.push(v);
  };
  if (f.actor) add('lower(actor) = lower(?)', f.actor);
  if (f.action) add('action LIKE ?', `${f.action.replace(/[%_]/g, '')}%`);
  // Dates are Dhaka days; created_at is UTC, Dhaka is UTC+6.
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) add('created_at >= ?', new Date(Date.parse(`${f.from}T00:00:00+06:00`)).toISOString());
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) add('created_at < ?', new Date(Date.parse(`${f.to}T00:00:00+06:00`) + 86_400_000).toISOString());
  if (f.q) {
    const q = `%${f.q.replace(/[%_]/g, '').slice(0, 80)}%`;
    where.push('(target LIKE ? OR detail_json LIKE ? OR ip LIKE ?)');
    args.push(q, q, q);
  }
  if (f.before) add('created_at < ?', f.before);
  const { results } = await db
    .prepare(
      `SELECT id, actor, action, target, detail_json AS detailJson, ip, created_at AS createdAt FROM admin_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<AuditRow>();
  return results;
}

export async function auditActors(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT actor FROM admin_events GROUP BY actor ORDER BY max(created_at) DESC LIMIT 100').all<{ actor: string }>();
  return results.map((r) => r.actor);
}

/** A short readable form of the stored details (keys and values, no braces). */
export function detailText(json: string): string {
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(d)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(', ')
      .slice(0, 300);
  } catch {
    return '';
  }
}
