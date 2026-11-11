import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Money is always stored as integer poisha (1 BDT = 100 minor units).

const timestamp = (name: string) =>
  text(name)
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);


export const students = sqliteTable(
  'students',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    phone: text('phone'),
    googleSub: text('google_sub').unique(),
    legacyWpUserId: integer('legacy_wp_user_id').unique(),
    /**
     * PBKDF2 hash for signing in with a mobile number (or email) and a
     * password the office gives out. Null: this account signs in with Google only.
     */
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at'),
    lastLoginAt: text('last_login_at'),
  },
  (t) => [uniqueIndex('students_email_idx').on(sql`lower(${t.email})`), index('students_created_idx').on(t.createdAt)],
);

// ---- Donations ------------------------------------------------------------------

/**
 * A fund people give to (general, zakat, land purchase...). goal_minor, when
 * set, shows a progress bar; the raised amount always comes from paid donations.
 */
export const funds = sqliteTable('funds', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  /** What the admin typed (simple Markdown) for the fund's page. */
  storyText: text('story_text').notNull().default(''),
  coverKey: text('cover_key'),
  goalMinor: integer('goal_minor'),
  /** For member funds: how many members are wanted (e.g. 200 land donors). */
  memberGoal: integer('member_goal'),
  /** Quick amounts on the form in taka, comma separated ("500,1000,2000"). */
  presetAmounts: text('preset_amounts').notNull().default('500,1000,2000,5000,10000'),
  status: text('status', { enum: ['active', 'hidden'] }).notNull().default('active'),
  position: integer('position').notNull().default(0),
  legacyWpId: integer('legacy_wp_id').unique(),
  createdAt: timestamp('created_at'),
});

/**
 * One gift. Online gifts count only after SSLCommerz's validation API confirms
 * them (status paid). Gifts handed to the office (cash, bank) are recorded by
 * staff with gateway 'manual' and count at once. Never deleted: a wrong manual
 * entry is voided with a reason.
 */
export const donations = sqliteTable(
  'donations',
  {
    id: text('id').primaryKey(),
    /** SSLCommerz tran_id ("DN-..."), the old plugin's "DMP..." or "MN-..." for manual. */
    reference: text('reference').notNull().unique(),
    fundId: text('fund_id')
      .notNull()
      .references(() => funds.id),
    amountMinor: integer('amount_minor').notNull(),
    donorName: text('donor_name').notNull(),
    donorPhone: text('donor_phone').notNull().default(''),
    donorEmail: text('donor_email').notNull().default(''),
    /** "On behalf of": a parent, someone who passed away... */
    onBehalf: text('on_behalf').notNull().default(''),
    /** Hide the name in public lists. */
    anonymous: integer('anonymous', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['pending', 'paid', 'failed', 'cancelled', 'review'] })
      .notNull()
      .default('pending'),
    gateway: text('gateway', { enum: ['sslcommerz', 'manual'] }).notNull().default('sslcommerz'),
    /** For manual gifts: cash, bank, bkash... For online: the card or wallet SSLCommerz reports. */
    method: text('method').notNull().default(''),
    valId: text('val_id'),
    bankTranId: text('bank_tran_id'),
    reviewReason: text('review_reason'),
    /** Where the donor came from (ads): utm_source and utm_campaign of the landing URL. */
    utmSource: text('utm_source').notNull().default(''),
    utmCampaign: text('utm_campaign').notNull().default(''),
    note: text('note').notNull().default(''),
    recordedBy: text('recorded_by'),
    nonce: text('nonce'),
    voidedAt: text('voided_at'),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    paidAt: text('paid_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [
    index('donations_fund_idx').on(t.fundId, t.status, t.paidAt),
    index('donations_status_idx').on(t.status, t.createdAt),
    index('donations_phone_idx').on(t.donorPhone),
    index('donations_paid_idx').on(t.paidAt),
    uniqueIndex('donations_nonce_idx').on(t.nonce),
    check('donations_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/** What the payment gateway told us about a donation, kept for disputes. */
export const donationEvents = sqliteTable(
  'donation_events',
  {
    id: text('id').primaryKey(),
    donationId: text('donation_id').references(() => donations.id),
    kind: text('kind').notNull(),
    detailJson: text('detail_json').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('donation_events_donation_idx').on(t.donationId, t.createdAt)],
);

/** The story of a fund told over time: "land registered", "first wall up"... */
export const fundUpdates = sqliteTable(
  'fund_updates',
  {
    id: text('id').primaryKey(),
    fundId: text('fund_id')
      .notNull()
      .references(() => funds.id),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    imageKey: text('image_key'),
    happenedOn: text('happened_on').notNull(),
    status: text('status', { enum: ['published', 'hidden'] }).notNull().default('published'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('fund_updates_fund_idx').on(t.fundId, t.status, t.happenedOn)],
);



/**
 * One time sign-in codes sent by email. Only a keyed hash of the code is
 * stored; a row is deleted once used.
 */
export const loginCodes = sqliteTable(
  'login_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: text('expires_at').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('login_codes_email_idx').on(t.email, t.createdAt)],
);


/** People besides the owners (ADMIN_EMAILS) who may use /admin. */
export const staff = sqliteTable('staff', {
  email: text('email').primaryKey(),
  addedBy: text('added_by').notNull(),
  /** Which part of the admin they may use: online courses, offline courses, or both. */
  scope: text('scope', { enum: ['all', 'online', 'offline'] }).notNull().default('all'),
  /** "module:level,..." (see MODULES and LEVELS in server/staff.ts). Empty: worked out from scope. */
  modules: text('modules').notNull().default(''),
  name: text('name').notNull().default(''),
  /** The ready made role picked on the team page (admin, manager, accountant, office, content, teacher, viewer, custom). */
  role: text('role').notNull().default('custom'),
  /** online, offline or both: the part the role was given for. */
  area: text('area').notNull().default('both'),
  createdAt: timestamp('created_at'),
});

/** Every change made in the admin: who, what, to which record. */
export const adminEvents = sqliteTable(
  'admin_events',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    detailJson: text('detail_json').notNull().default('{}'),
    /** The address the change came from (CF-Connecting-IP), when known. */
    ip: text('ip').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('admin_events_actor_idx').on(t.actor, t.createdAt), index('admin_events_target_idx').on(t.target, t.createdAt), index('admin_events_created_idx').on(t.createdAt)],
);


/**
 * Blog articles written in the admin. body_html is always sanitized on save
 * (src/lib/blog-html.ts); covers and inline images live under uploads/blog/.
 */
export const blogPosts = sqliteTable(
  'blog_posts',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull().default(''),
    bodyHtml: text('body_html').notNull().default(''),
    coverKey: text('cover_key'),
    category: text('category').notNull().default(''),
    status: text('status', { enum: ['draft', 'published'] })
      .notNull()
      .default('draft'),
    featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
    authorName: text('author_name').notNull().default(''),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    legacyWpId: integer('legacy_wp_id').unique(),
    publishedAt: text('published_at'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('blog_posts_status_idx').on(t.status, t.publishedAt)],
);


// ---- Offline courses (taught in person; the ledger kept on paper before) ----

/** A course taught in person. Nothing about it is shown on the public site. */
export const offlineCourses = sqliteTable('offline_courses', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  feeMinor: integer('fee_minor').notNull(),
  admissionFeeMinor: integer('admission_fee_minor').notNull().default(0),
  /** Length in months (1 = one month, 12 = one year). */
  durationMonths: integer('duration_months').notNull(),
  note: text('note').notNull().default(''),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  createdAt: timestamp('created_at'),
});

/** A teacher or staff member who teaches offline batches. */
export const teachers = sqliteTable('teachers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  /** Gmail for signing in to the teacher panel later. */
  email: text('email').notNull().default(''),
  subject: text('subject').notNull().default(''),
  /** Monthly basic pay in poisha. */
  basicPayMinor: integer('basic_pay_minor').notNull().default(0),
  joinedOn: text('joined_on').notNull().default(''),
  /** teacher: teaches batches. staff: office staff, on the payroll but without classes. */
  role: text('role', { enum: ['teacher', 'staff'] }).notNull().default('teacher'),
  status: text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at'),
});

/**
 * A group of students of one offline course who meet at the same time.
 * days: comma separated weekday numbers, 0 = Sunday ... 6 = Saturday.
 * Times are "HH:MM" in Dhaka time.
 */
export const offlineBatches = sqliteTable(
  'offline_batches',
  {
    id: text('id').primaryKey(),
    courseId: text('course_id')
      .notNull()
      .references(() => offlineCourses.id),
    name: text('name').notNull(),
    kind: text('kind').notNull().default(''),
    days: text('days').notNull().default(''),
    startTime: text('start_time').notNull().default(''),
    endTime: text('end_time').notNull().default(''),
    teacherId: text('teacher_id').references(() => teachers.id),
    room: text('room').notNull().default(''),
    startDate: text('start_date').notNull().default(''),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('offline_batches_course_idx').on(t.courseId), index('offline_batches_teacher_idx').on(t.teacherId)],
);

/** A person enrolled in an offline course. Separate from website students: no email or login. */
export const offlineStudents = sqliteTable(
  'offline_students',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    guardianPhone: text('guardian_phone').notNull().default(''),
    address: text('address').notNull().default(''),
    note: text('note').notNull().default(''),
    /** Gmail for signing in to the student panel later. Empty until given. */
    email: text('email').notNull().default(''),
    /** Running ID number shown as MI-0001, for searching and the ID card. */
    studentNo: integer('student_no'),
    /** blocked: cannot open the student panel; the office keeps the record. */
    status: text('status', { enum: ['active', 'blocked'] }).notNull().default('active'),
    blockedReason: text('blocked_reason').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('offline_students_phone_idx').on(t.phone), uniqueIndex('offline_students_no_idx').on(t.studentNo)],
);

/**
 * One student in one offline course. Fees are copied from the course when
 * enrolling, so later fee changes do not rewrite what was agreed.
 * planMonths: 0 = pay everything at once, else one installment every N months.
 */
export const offlineEnrollments = sqliteTable(
  'offline_enrollments',
  {
    id: text('id').primaryKey(),
    studentId: text('student_id')
      .notNull()
      .references(() => offlineStudents.id),
    courseId: text('course_id')
      .notNull()
      .references(() => offlineCourses.id),
    /** Free text from before batches existed; new enrollments use batchId. */
    batch: text('batch').notNull().default(''),
    batchId: text('batch_id').references(() => offlineBatches.id),
    roll: text('roll').notNull().default(''),
    startDate: text('start_date').notNull(),
    feeMinor: integer('fee_minor').notNull(),
    admissionFeeMinor: integer('admission_fee_minor').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    durationMonths: integer('duration_months').notNull(),
    planMonths: integer('plan_months').notNull(),
    status: text('status', { enum: ['active', 'completed', 'dropped'] }).notNull().default('active'),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [
    index('offline_enrollments_student_idx').on(t.studentId),
    index('offline_enrollments_course_idx').on(t.courseId),
    index('offline_enrollments_batch_idx').on(t.batchId),
  ],
);

/** Money received. Never deleted: a mistaken entry is voided with a reason. */
export const offlinePayments = sqliteTable(
  'offline_payments',
  {
    id: text('id').primaryKey(),
    receiptNo: integer('receipt_no').notNull(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => offlineEnrollments.id),
    amountMinor: integer('amount_minor').notNull(),
    paidOn: text('paid_on').notNull(),
    method: text('method', { enum: ['cash', 'bkash', 'nagad', 'rocket', 'bank', 'other', 'online'] }).notNull(),
    reference: text('reference').notNull().default(''),
    note: text('note').notNull().default(''),
    recordedBy: text('recorded_by').notNull(),
    /** Random value from the form, so a double click or resend saves only once. */
    nonce: text('nonce'),
    voidedAt: text('voided_at'),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at'),
  },
  (t) => [
    uniqueIndex('offline_payments_receipt_idx').on(t.receiptNo),
    uniqueIndex('offline_payments_nonce_idx').on(t.nonce),
    index('offline_payments_enrollment_idx').on(t.enrollmentId),
    index('offline_payments_paid_idx').on(t.paidOn),
    index('offline_payments_created_idx').on(t.createdAt),
  ],
);

/** One student's attendance in one batch on one day. Saving again replaces it. */
export const offlineAttendance = sqliteTable(
  'offline_attendance',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => offlineBatches.id),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => offlineEnrollments.id),
    day: text('day').notNull(),
    status: text('status', { enum: ['present', 'absent', 'late', 'leave'] }).notNull(),
    markedBy: text('marked_by').notNull(),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [uniqueIndex('offline_attendance_one_idx').on(t.enrollmentId, t.day), index('offline_attendance_batch_idx').on(t.batchId, t.day)],
);

/** Money spent by the institute. Never deleted: a wrong entry is voided with a reason. */
export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    spentOn: text('spent_on').notNull(),
    category: text('category').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    description: text('description').notNull().default(''),
    method: text('method').notNull().default('cash'),
    /** Voucher photo in R2 under private/vouchers/, shown only in the admin. */
    voucherKey: text('voucher_key'),
    recordedBy: text('recorded_by').notNull(),
    /** Large expenses wait for the owner; only approved ones count in the accounts. */
    status: text('status', { enum: ['approved', 'pending', 'rejected'] }).notNull().default('approved'),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    nonce: text('nonce'),
    voidedAt: text('voided_at'),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('expenses_spent_idx').on(t.spentOn), index('expenses_status_idx').on(t.status), uniqueIndex('expenses_nonce_idx').on(t.nonce), check('expenses_amount_check', sql`${t.amountMinor} > 0`)],
);

/**
 * A notice. audience says who sees it:
 *  online: every website student; course: students of one online course (targetId)
 *  offline: everyone offline; offline_students; offline_teachers; batch: one offline batch (targetId)
 */
export const notices = sqliteTable(
  'notices',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    audience: text('audience', { enum: ['online', 'course', 'offline', 'offline_students', 'offline_teachers', 'batch', 'offline_student', 'teacher'] }).notNull(),
    targetId: text('target_id').notNull().default(''),
    pinned: integer('pinned').notNull().default(0),
    /** An attached file (PDF or picture) in R2 under private/notices/. */
    fileKey: text('file_key'),
    fileName: text('file_name'),
    contentType: text('content_type'),
    status: text('status', { enum: ['published', 'hidden'] }).notNull().default('published'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('notices_audience_idx').on(t.audience, t.status, t.createdAt)],
);

// ---- Office rules, leave, payroll, materials, online fee payments (0013) ----

/** Rules the owner can change on the settings page (paid leave, salary basis...). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at'),
});

/**
 * A teacher's leave. Days are counted when payroll is made: approved days
 * up to the monthly paid allowance are paid, the rest unpaid. An owner can
 * approve a leave as unpaid from the start (kind = 'unpaid').
 */
export const leaveRequests = sqliteTable(
  'leave_requests',
  {
    id: text('id').primaryKey(),
    teacherId: text('teacher_id')
      .notNull()
      .references(() => teachers.id),
    fromDay: text('from_day').notNull(),
    toDay: text('to_day').notNull(),
    reason: text('reason').notNull().default(''),
    kind: text('kind', { enum: ['normal', 'unpaid'] }).notNull().default('normal'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'cancelled'] }).notNull().default('pending'),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    decisionNote: text('decision_note').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('leave_teacher_idx').on(t.teacherId, t.fromDay), index('leave_status_idx').on(t.status)],
);

/** One teacher's salary for one month ("YYYY-MM"). draft -> approved -> paid. */
export const payroll = sqliteTable(
  'payroll',
  {
    id: text('id').primaryKey(),
    teacherId: text('teacher_id')
      .notNull()
      .references(() => teachers.id),
    month: text('month').notNull(),
    basicMinor: integer('basic_minor').notNull(),
    /** The days the deduction is divided by (class days, 30 or days in the month). */
    workDays: integer('work_days').notNull(),
    leaveDays: integer('leave_days').notNull().default(0),
    paidLeaveDays: integer('paid_leave_days').notNull().default(0),
    unpaidDays: integer('unpaid_days').notNull().default(0),
    deductionMinor: integer('deduction_minor').notNull().default(0),
    bonusMinor: integer('bonus_minor').notNull().default(0),
    otherDeductionMinor: integer('other_deduction_minor').notNull().default(0),
    netMinor: integer('net_minor').notNull(),
    basis: text('basis').notNull(),
    note: text('note').notNull().default(''),
    status: text('status', { enum: ['draft', 'approved', 'paid'] }).notNull().default('draft'),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
    paidOn: text('paid_on'),
    paidMethod: text('paid_method'),
    expenseId: text('expense_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [uniqueIndex('payroll_one_idx').on(t.teacherId, t.month), index('payroll_month_idx').on(t.month)],
);

/** Notes, files and links a teacher or the office shares with one batch. */
export const batchMaterials = sqliteTable(
  'batch_materials',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => offlineBatches.id),
    title: text('title').notNull(),
    /** A web link (Google Drive, YouTube) or a file in R2 under private/materials/. */
    url: text('url'),
    fileKey: text('file_key'),
    fileName: text('file_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    createdBy: text('created_by').notNull(),
    hidden: integer('hidden').notNull().default(0),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('batch_materials_batch_idx').on(t.batchId, t.createdAt)],
);

/**
 * An offline student paying fees online through SSLCommerz. The amount comes
 * from the server; the money counts only after SSLCommerz's validation API
 * confirms it, and then becomes an ordinary offline payment (receipt).
 */
export const offlineOnlinePayments = sqliteTable(
  'offline_online_payments',
  {
    id: text('id').primaryKey(),
    /** SSLCommerz tran_id, starting "TF-". */
    reference: text('reference').notNull().unique(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => offlineEnrollments.id),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id),
    amountMinor: integer('amount_minor').notNull(),
    status: text('status', { enum: ['pending', 'paid', 'failed', 'cancelled', 'review', 'resolved'] }).notNull().default('pending'),
    valId: text('val_id'),
    bankTranId: text('bank_tran_id'),
    cardType: text('card_type'),
    paymentId: text('payment_id'),
    reviewReason: text('review_reason'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [index('ofop_enrollment_idx').on(t.enrollmentId), index('ofop_status_idx').on(t.status), check('ofop_amount_check', sql`${t.amountMinor} > 0`)],
);

/**
 * A student's monthly rating of a teacher (1 to 5 on each question). Only
 * the office sees ratings; teachers never see who gave what.
 */
export const teacherRatings = sqliteTable(
  'teacher_ratings',
  {
    id: text('id').primaryKey(),
    offlineStudentId: text('offline_student_id')
      .notNull()
      .references(() => offlineStudents.id),
    teacherId: text('teacher_id')
      .notNull()
      .references(() => teachers.id),
    batchId: text('batch_id')
      .notNull()
      .references(() => offlineBatches.id),
    month: text('month').notNull(),
    teaching: integer('teaching').notNull(),
    punctuality: integer('punctuality').notNull(),
    behaviour: integer('behaviour').notNull(),
    overall: integer('overall').notNull(),
    comment: text('comment').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [
    uniqueIndex('teacher_ratings_once_idx').on(t.offlineStudentId, t.teacherId, t.month),
    index('teacher_ratings_teacher_idx').on(t.teacherId, t.month),
    check('teacher_ratings_range', sql`${t.teaching} BETWEEN 1 AND 5 AND ${t.punctuality} BETWEEN 1 AND 5 AND ${t.behaviour} BETWEEN 1 AND 5 AND ${t.overall} BETWEEN 1 AND 5`),
  ],
);

// ---- Exams, extra charges, subject teachers, tickets (0016) ----

/** A second (or third) teacher of a batch, for one subject. The batch's own teacher stays its main teacher. */
export const batchTeachers = sqliteTable(
  'batch_teachers',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => offlineBatches.id),
    teacherId: text('teacher_id')
      .notNull()
      .references(() => teachers.id),
    subject: text('subject').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [uniqueIndex('batch_teachers_one_idx').on(t.batchId, t.teacherId), index('batch_teachers_teacher_idx').on(t.teacherId)],
);

/** An exam of one batch. A fee, if any, becomes a charge on each active student of the batch. */
export const offlineExams = sqliteTable(
  'offline_exams',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => offlineBatches.id),
    title: text('title').notNull(),
    subject: text('subject').notNull().default(''),
    examDate: text('exam_date').notNull(),
    startTime: text('start_time').notNull().default(''),
    feeMinor: integer('fee_minor').notNull().default(0),
    note: text('note').notNull().default(''),
    status: text('status', { enum: ['scheduled', 'cancelled'] }).notNull().default('scheduled'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('offline_exams_batch_idx').on(t.batchId, t.examDate), index('offline_exams_date_idx').on(t.examDate)],
);

/**
 * Money owed on top of the course fee: an exam fee, a late fee, or anything
 * else the office adds. Never deleted: a wrong one is voided (waived) with a
 * reason. source_key keeps the automatic ones from being added twice
 * ("exam:<id>", "late:<installment number>").
 */
export const offlineCharges = sqliteTable(
  'offline_charges',
  {
    id: text('id').primaryKey(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => offlineEnrollments.id),
    kind: text('kind', { enum: ['exam', 'late', 'other'] }).notNull(),
    label: text('label').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    dueDate: text('due_date').notNull(),
    sourceKey: text('source_key').notNull(),
    createdBy: text('created_by').notNull(),
    voidedAt: text('voided_at'),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at'),
  },
  (t) => [
    uniqueIndex('offline_charges_source_idx').on(t.enrollmentId, t.sourceKey),
    index('offline_charges_due_idx').on(t.dueDate),
    check('offline_charges_amount_check', sql`${t.amountMinor} > 0`),
  ],
);

/** A question or problem from an offline student or a teacher, answered by the office. */
export const tickets = sqliteTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    /** Running number shown as #12. */
    ticketNo: integer('ticket_no').notNull(),
    fromKind: text('from_kind', { enum: ['student', 'teacher'] }).notNull(),
    offlineStudentId: text('offline_student_id').references(() => offlineStudents.id),
    teacherId: text('teacher_id').references(() => teachers.id),
    subject: text('subject').notNull(),
    category: text('category').notNull().default('other'),
    /** open: waiting for the office. answered: the office replied. closed: done. */
    status: text('status', { enum: ['open', 'answered', 'closed'] }).notNull().default('open'),
    closedBy: text('closed_by'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
  },
  (t) => [
    uniqueIndex('tickets_no_idx').on(t.ticketNo),
    index('tickets_status_idx').on(t.status, t.updatedAt),
    index('tickets_student_idx').on(t.offlineStudentId),
    index('tickets_teacher_idx').on(t.teacherId),
  ],
);

export const ticketMessages = sqliteTable(
  'ticket_messages',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id),
    authorKind: text('author_kind', { enum: ['student', 'teacher', 'staff'] }).notNull(),
    author: text('author').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt)],
);

/**
 * What happened on the site, one row per page view or student action
 * (/admin/visits). day is the Dhaka date. visitor is a hash of the day, the
 * address and the browser, so a visitor counts once a day and no address is
 * stored. Rows older than 15 days are deleted every night.
 */
export const siteActivity = sqliteTable(
  'site_activity',
  {
    id: text('id').primaryKey(),
    day: text('day').notNull(),
    visitor: text('visitor').notNull(),
    studentId: text('student_id'),
    kind: text('kind').notNull(),
    path: text('path').notNull().default(''),
    courseId: text('course_id'),
    lessonId: text('lesson_id'),
    detail: text('detail').notNull().default(''),
    device: text('device').notNull().default(''),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('site_activity_day_idx').on(t.day, t.studentId)],
);


// ---- Academic sessions, promotions and verified guardian access (2026-11) ----
export const academicSessions = sqliteTable('academic_sessions', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  startsOn: text('starts_on').notNull(),
  endsOn: text('ends_on').notNull(),
  status: text('status', { enum: ['planned','active','archived'] }).notNull().default('planned'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at'),
}, (t) => [uniqueIndex('academic_sessions_single_active_idx').on(t.status).where(sql`${t.status} = 'active'`)]);
export const academicBatchSessions = sqliteTable('academic_batch_sessions', {
  batchId: text('batch_id').primaryKey().references(() => offlineBatches.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => academicSessions.id),
  addedBy: text('added_by').notNull(),
  createdAt: timestamp('created_at'),
}, (t) => [index('academic_batch_sessions_session_idx').on(t.sessionId)]);
export const academicPromotions = sqliteTable('academic_promotions', {
  id: text('id').primaryKey(),
  enrollmentId: text('enrollment_id').notNull().references(() => offlineEnrollments.id),
  studentId: text('student_id').notNull().references(() => offlineStudents.id),
  fromBatchId: text('from_batch_id').references(() => offlineBatches.id),
  toBatchId: text('to_batch_id').notNull().references(() => offlineBatches.id),
  toSessionId: text('to_session_id').notNull().references(() => academicSessions.id),
  nextRoll: text('next_roll').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at'),
}, (t) => [
  uniqueIndex('academic_promotions_enrollment_session_unique').on(t.enrollmentId,t.toSessionId),
  index('academic_promotions_student_idx').on(t.studentId,t.toSessionId),
  index('academic_promotions_batch_idx').on(t.toBatchId,t.toSessionId),
]);
export const academicGuardianLinks = sqliteTable('academic_guardian_links', {
  id: text('id').primaryKey(),
  studentId: text('student_id').notNull().references(() => offlineStudents.id, { onDelete: 'cascade' }),
  guardianEmail: text('guardian_email').notNull(),
  guardianName: text('guardian_name').notNull(),
  relation: text('relation', { enum: ['father','mother','guardian','other'] }).notNull(),
  status: text('status', { enum: ['active','revoked'] }).notNull().default('active'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at'),
  revokedBy: text('revoked_by'),
  revokedAt: text('revoked_at'),
}, (t) => [
  uniqueIndex('academic_guardian_student_email_idx').on(t.studentId,sql`lower(${t.guardianEmail})`),
  index('academic_guardian_email_status_idx').on(sql`lower(${t.guardianEmail})`,t.status),
]);

// Phase 3: exam grading and classroom assignments (all financial rows remain independent).
export const assessmentPolicies = sqliteTable('assessment_policies', {
  examId: text('exam_id').primaryKey().references(() => offlineExams.id),
  maxMarks: integer('max_marks').notNull(),
  passMarks: integer('pass_marks').notNull(),
  status: text('status', { enum: ['draft','published'] }).notNull().default('draft'),
  publishedBy: text('published_by'),
  publishedAt: text('published_at'),
  updatedBy: text('updated_by').notNull(),
  createdAt: timestamp('created_at'),
}, t=>[check('assessment_max_positive',sql`${t.maxMarks} BETWEEN 1 AND 1000`),
check('assessment_pass_range',sql`${t.passMarks} >= 0 AND ${t.passMarks} <= ${t.maxMarks}`)]);
export const assessmentExaminees = sqliteTable('assessment_examinees', {
  examId: text('exam_id').notNull().references(()=>offlineExams.id),
  enrollmentId: text('enrollment_id').notNull().references(()=>offlineEnrollments.id),
  capturedBy: text('captured_by').notNull(),
  capturedAt: timestamp('captured_at'),
},t=>[primaryKey({columns:[t.examId,t.enrollmentId]}),index('assessment_examinees_enrollment_idx').on(t.enrollmentId)]);
export const assessmentMarks = sqliteTable('assessment_marks',{
  examId:text('exam_id').notNull(),
  enrollmentId:text('enrollment_id').notNull(),
  obtained:integer('obtained'),
  attendance:text('attendance',{enum:['present','absent']}).notNull(),
  comment:text('comment').notNull().default(''),
  markedBy:text('marked_by').notNull(),
  updatedAt:timestamp('updated_at'),
},t=>[
  primaryKey({columns:[t.examId,t.enrollmentId]}),
  check('assessment_marks_attendance_valid',sql`(${t.attendance} = 'absent' AND ${t.obtained} IS NULL) OR (${t.attendance} = 'present' AND ${t.obtained} IS NOT NULL AND ${t.obtained} >= 0)`)
]);
export const homeworkAssignments=sqliteTable('homework_assignments',{
  id:text('id').primaryKey(),
  batchId:text('batch_id').notNull().references(()=>offlineBatches.id),
  title:text('title').notNull(),
  details:text('details').notNull().default(''),
  kind:text('kind',{enum:['homework','lesson']}).notNull(),
  dueOn:text('due_on').notNull(),
  status:text('status',{enum:['draft','published','closed']}).notNull().default('draft'),
  createdBy:text('created_by').notNull(),
  publishedAt:text('published_at'),
  createdAt:timestamp('created_at'),
},t=>[index('homework_assignments_batch_idx').on(t.batchId,t.status,t.dueOn)]);
export const homeworkSubmissions=sqliteTable('homework_submissions',{
  assignmentId:text('assignment_id').notNull().references(()=>homeworkAssignments.id),
  enrollmentId:text('enrollment_id').notNull().references(()=>offlineEnrollments.id),
  body:text('body').notNull(),
  state:text('state',{enum:['submitted','reviewed']}).notNull().default('submitted'),
  feedback:text('feedback').notNull().default(''),
  score:integer('score'),
  submittedBy:text('submitted_by').notNull(),
  submittedAt:timestamp('submitted_at'),
  reviewedBy:text('reviewed_by'),
  reviewedAt:text('reviewed_at'),
},t=>[primaryKey({columns:[t.assignmentId,t.enrollmentId]}),index('homework_submissions_enrollment_idx').on(t.enrollmentId,t.state)]);
