// Small counts of work waiting in each admin section. The sidebar shows them
// as badges (like a cart count) and the office dashboard turns them into
// clickable alerts. All plain count queries in one D1 batch, cheap enough to
// run on every admin page.

export type WorkCounts = {
  followupsOverdue: number;
  followupsToday: number;
  newInquiries: number;
  newApplications: number;
  openTickets: number;
  feeReviews: number;
  pendingExpenses: number;
  pendingLeave: number;
  pendingStudentLeave: number;
  lateBooks: number;
  homeworkToCheck: number;
  donationReviews: number;
};

/** 'bad' is red (something is late or money needs checking), 'warn' is gold. */
export type Badge = { n: number; tone: 'bad' | 'warn'; hint: string };

export async function workCounts(db: D1Database, today: string): Promise<WorkCounts> {
  const one = (sql: string, ...bind: unknown[]) => db.prepare(`SELECT (${sql}) AS n`).bind(...bind);
  const rows = await db.batch<{ n: number | null }>([
    one(`SELECT count(*) FROM crm_followups WHERE status = 'open' AND due_on < ?1`, today),
    one(`SELECT count(*) FROM crm_followups WHERE status = 'open' AND due_on = ?1`, today),
    one(`SELECT count(*) FROM admission_inquiries WHERE status = 'new'`),
    one(`SELECT count(*) FROM tickets WHERE status = 'open'`),
    one(`SELECT count(*) FROM offline_online_payments WHERE status = 'review'`),
    one(`SELECT count(*) FROM expenses WHERE status = 'pending' AND voided_at IS NULL`),
    one(`SELECT count(*) FROM leave_requests WHERE status = 'pending'`),
    one(`SELECT count(*) FROM student_leave_requests WHERE status = 'pending'`),
    one(`SELECT count(*) FROM library_loans WHERE returned_on IS NULL AND due_on < ?1`, today),
    one(`SELECT count(*) FROM homework_submissions WHERE state = 'submitted'`),
    one(`SELECT count(*) FROM donations WHERE status = 'review'`),
    one(`SELECT count(*) FROM admission_applications WHERE status = 'pending'`),
  ]);
  const n = (i: number) => rows[i]?.results[0]?.n ?? 0;
  return {
    followupsOverdue: n(0),
    followupsToday: n(1),
    newInquiries: n(2),
    openTickets: n(3),
    feeReviews: n(4),
    pendingExpenses: n(5),
    pendingLeave: n(6),
    pendingStudentLeave: n(7),
    lateBooks: n(8),
    homeworkToCheck: n(9),
    donationReviews: n(10),
    newApplications: n(11),
  };
}

/** Counts once per request, shared by the page and the layout. */
export function workCountsFor(locals: App.Locals, db: D1Database, today: string): Promise<WorkCounts> {
  locals.workCounts ??= workCounts(db, today);
  return locals.workCounts;
}

/** Badge per sidebar link. Only links with something waiting appear. */
export function badgesFor(c: WorkCounts): Record<string, Badge> {
  const list: [string, number, Badge['tone'], string][] = [
    ['/admin/offline/crm', c.followupsOverdue + c.followupsToday, c.followupsOverdue ? 'bad' : 'warn', 'আজকের ও তারিখ পার হওয়া ফলো আপ'],
    ['/admin/offline/applications', c.newApplications, 'warn', 'নতুন ভর্তির আবেদন'],
    ['/admin/offline/inquiries', c.newInquiries, 'warn', 'নতুন যোগাযোগের আবেদন'],
    ['/admin/offline/tickets', c.openTickets, 'warn', 'উত্তরের অপেক্ষায় টিকেট'],
    ['/admin/offline/online-payments', c.feeReviews, 'bad', 'যাচাই করা দরকার এমন অনলাইন ফি'],
    ['/admin/offline/expenses', c.pendingExpenses, 'warn', 'অনুমোদনের অপেক্ষায় খরচ'],
    ['/admin/offline/leave', c.pendingLeave, 'warn', 'অনুমোদনের অপেক্ষায় ছুটির আবেদন'],
    ['/admin/offline/student-leave', c.pendingStudentLeave, 'warn', 'অনুমোদনের অপেক্ষায় ছাত্রের ছুটি'],
    ['/admin/offline/library', c.lateBooks, 'bad', 'তারিখ পার হয়েছে, বই ফেরত আসেনি'],
    ['/admin/offline/homework', c.homeworkToCheck, 'warn', 'দেখা বাকি হোমওয়ার্ক'],
    ['/admin/donations', c.donationReviews, 'bad', 'যাচাই করা দরকার এমন দান'],
  ];
  return Object.fromEntries(list.filter(([, n]) => n > 0).map(([href, n, tone, hint]) => [href, { n, tone, hint }]));
}
