// Demo (test) data for the madrasa ERP and CRM, and its removal.
//
//   node scripts/demo-data.mjs seed   --out demo-seed.sql
//   node scripts/demo-data.mjs remove --out demo-remove.sql
//   npx wrangler d1 execute DB --local --file demo-seed.sql
//   npx wrangler d1 execute DB --env production --remote --file demo-seed.sql
//
// Every demo row has an id starting with "demo_" and every name ends in
// "(টেস্ট)", so the owner sees it is test data and "remove" deletes exactly
// these rows and nothing else. Donations are never touched. The seed is
// deterministic (same output every time) and refuses to run twice (the
// first insert would fail on the existing id).

import { writeFileSync } from 'node:fs';

const [mode, , outArg] = process.argv.slice(2);
const out = outArg ?? (mode === 'remove' ? 'demo-remove.sql' : 'demo-seed.sql');
const BY = 'demo-seed';
const TODAY = process.env.DEMO_TODAY ?? '2026-11-13';
const T = ' (টেস্ট)';

// Tables in the order rows must be deleted (children first).
const REMOVE = [
  ["DELETE FROM portal_notifications WHERE offline_student_id LIKE 'demo_%' OR teacher_id LIKE 'demo_%'"],
  ["DELETE FROM crm_contacts WHERE id LIKE 'demo_%' OR student_id LIKE 'demo_%'"],
  ["DELETE FROM crm_followups WHERE id LIKE 'demo_%' OR student_id LIKE 'demo_%'"],
  ["DELETE FROM crm_tags WHERE student_id LIKE 'demo_%'"],
  ["DELETE FROM crm_templates WHERE id LIKE 'demo_%'"],
  ["DELETE FROM ticket_messages WHERE ticket_id LIKE 'demo_%'"],
  ["DELETE FROM tickets WHERE id LIKE 'demo_%'"],
  ["DELETE FROM student_leave_requests WHERE id LIKE 'demo_%' OR student_id LIKE 'demo_%'"],
  ["DELETE FROM leave_requests WHERE id LIKE 'demo_%' OR teacher_id LIKE 'demo_%'"],
  ["DELETE FROM staff_attendance WHERE teacher_id LIKE 'demo_%'"],
  ["DELETE FROM offline_attendance WHERE enrollment_id LIKE 'demo_%'"],
  ["DELETE FROM offline_charges WHERE enrollment_id LIKE 'demo_%'"],
  ["DELETE FROM offline_payments WHERE enrollment_id LIKE 'demo_%'"],
  ["DELETE FROM offline_enrollments WHERE id LIKE 'demo_%'"],
  ["DELETE FROM offline_exams WHERE id LIKE 'demo_%'"],
  ["DELETE FROM batch_teachers WHERE id LIKE 'demo_%'"],
  ["DELETE FROM offline_batches WHERE id LIKE 'demo_%'"],
  ["DELETE FROM payroll WHERE id LIKE 'demo_%'"],
  ["DELETE FROM teachers WHERE id LIKE 'demo_%'"],
  ["DELETE FROM offline_students WHERE id LIKE 'demo_%'"],
  ["UPDATE offline_courses SET project_id = NULL WHERE project_id LIKE 'demo_%'"],
  ["DELETE FROM offline_courses WHERE id LIKE 'demo_%'"],
  ["DELETE FROM expenses WHERE id LIKE 'demo_%'"],
  ["DELETE FROM acc_reconciliations WHERE id LIKE 'demo_%'"],
  ["DELETE FROM acc_entries WHERE id LIKE 'demo_%'"],
  ["DELETE FROM acc_budgets WHERE id LIKE 'demo_%'"],
  ["DELETE FROM acc_projects WHERE id LIKE 'demo_%'"],
  ["DELETE FROM acc_funds WHERE id LIKE 'demo_%'"],
];

if (mode === 'remove') {
  writeFileSync(out, `${REMOVE.map(([s]) => `${s};`).join('\n')}\n`);
  console.log(`Wrote ${out}`);
  process.exit(0);
}
if (mode !== 'seed') {
  console.error('Usage: node scripts/demo-data.mjs seed|remove [--out file.sql]');
  process.exit(1);
}

// ---- helpers ---------------------------------------------------------------------
let seed = 20261113;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const q = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const rows = [];
const ins = (table, obj) => rows.push(`INSERT INTO ${table} (${Object.keys(obj).join(', ')}) VALUES (${Object.values(obj).map(q).join(', ')});`);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const addMonths = (d, n) => {
  const [y, m, day] = d.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};
const at = (day, hour = 10) => `${day}T${String(hour - 6 < 0 ? 0 : hour - 6).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00.000Z`;
const tk = (taka) => Math.round(taka * 100);

// Running balances per default account, to keep the demo books sensible.
const METHOD_ACCOUNT = { cash: 'acct_cash', other: 'acct_cash', bank: 'acct_bank', bkash: 'acct_mobile', nagad: 'acct_mobile', rocket: 'acct_mobile', online: 'acct_online' };
const bal = { acct_cash: 0, acct_bank: 0, acct_mobile: 0, acct_online: 0 };
const balAt = {}; // day -> snapshot after that day's rows (filled at the end)
const moves = []; // [day, account, minor]
const move = (day, account, minor) => moves.push([day, account, minor]);

// ---- projects, funds -------------------------------------------------------------
ins('acc_projects', { id: 'demo_prj_hifz', name: `হিফজ বিভাগ${T}`, note: 'হিফজ বিভাগের ফি, খাবার ও শিক্ষক খরচ আলাদা দেখার জন্য', created_by: BY });
ins('acc_projects', { id: 'demo_prj_build', name: `ভবন মেরামত প্রকল্প${T}`, note: 'ছাদ ও শ্রেণিকক্ষ মেরামত', created_by: BY });
ins('acc_funds', { id: 'demo_fund_zakat', name: `যাকাত তহবিল${T}`, kind: 'zakat', restricted: 1, note: 'শুধু গরিব ও এতিম ছাত্রদের খাবার ও খরচে', created_by: BY });
ins('acc_funds', { id: 'demo_fund_lillah', name: `লিল্লাহ বোর্ডিং তহবিল${T}`, kind: 'lillah', restricted: 1, note: 'বোর্ডিংয়ের খাবার', created_by: BY });

// ---- departments, teachers, staff, classes -------------------------------------------
const COURSES = [
  { id: 'demo_crs_hifz', title: `হিফজুল কুরআন বিভাগ${T}`, fee: 18000, adm: 2000, project: 'demo_prj_hifz' },
  { id: 'demo_crs_nazera', title: `নাজেরা বিভাগ${T}`, fee: 12000, adm: 1500, project: null },
  { id: 'demo_crs_kitab', title: `কিতাব বিভাগ${T}`, fee: 24000, adm: 3000, project: null },
];
for (const c of COURSES) ins('offline_courses', { id: c.id, title: c.title, fee_minor: tk(c.fee), admission_fee_minor: tk(c.adm), duration_months: 12, note: 'ডেমো বিভাগ, পরে মুছে ফেলা হবে', status: 'active', project_id: c.project, created_at: '2026-06-20T04:00:00.000Z' });

const TEACHERS = [
  { id: 'demo_tch_1', name: `হাফেজ মাওলানা আব্দুর রহমান${T}`, subject: 'হিফজ', pay: 18000, role: 'teacher' },
  { id: 'demo_tch_2', name: `মাওলানা ইউসুফ আলী${T}`, subject: 'আরবি ও ফিকহ', pay: 16000, role: 'teacher' },
  { id: 'demo_tch_3', name: `হাফেজা উম্মে কুলসুম${T}`, subject: 'নাজেরা (বালিকা)', pay: 12000, role: 'teacher' },
  { id: 'demo_tch_4', name: `মুফতি সাইফুল ইসলাম${T}`, subject: 'হাদিস ও তাফসির', pay: 17000, role: 'teacher' },
  { id: 'demo_tch_5', name: `উস্তাযা ফাতেমা খাতুন${T}`, subject: 'বাংলা ও গণিত', pay: 11000, role: 'teacher' },
  { id: 'demo_stf_1', name: `মোঃ কামরুল হাসান${T}`, subject: 'অফিস সহকারী ও হিসাব', pay: 9000, role: 'staff' },
  { id: 'demo_stf_2', name: `আব্দুল মালেক${T}`, subject: 'বাবুর্চি ও দারোয়ান', pay: 7500, role: 'staff' },
];
TEACHERS.forEach((t, i) =>
  ins('teachers', { id: t.id, name: t.name, phone: `0190000020${i}`, email: '', subject: t.subject, basic_pay_minor: tk(t.pay), joined_on: '2026-06-15', role: t.role, status: 'active', note: 'ডেমো', created_at: '2026-06-15T04:00:00.000Z' }),
);

const BATCHES = [
  { id: 'demo_bat_hifz', course: 'demo_crs_hifz', name: `হিফজ সকাল${T}`, teacher: 'demo_tch_1', start: '06:00', end: '11:00', room: 'হিফজখানা' },
  { id: 'demo_bat_nazera_g', course: 'demo_crs_nazera', name: `নাজেরা বালিকা${T}`, teacher: 'demo_tch_3', start: '08:00', end: '11:00', room: '২০২' },
  { id: 'demo_bat_nazera_b', course: 'demo_crs_nazera', name: `নাজেরা বালক${T}`, teacher: 'demo_tch_5', start: '14:00', end: '17:00', room: '১০৩' },
  { id: 'demo_bat_kitab', course: 'demo_crs_kitab', name: `কিতাব জামাত ১${T}`, teacher: 'demo_tch_2', start: '08:00', end: '13:00', room: '১০১' },
];
const DAYS = '6,0,1,2,3,4'; // Saturday to Thursday
for (const b of BATCHES) ins('offline_batches', { id: b.id, course_id: b.course, name: b.name, kind: 'নিয়মিত', days: DAYS, start_time: b.start, end_time: b.end, teacher_id: b.teacher, room: b.room, start_date: '2026-07-01', status: 'active', note: '', created_at: '2026-06-25T04:00:00.000Z' });
[['demo_bat_kitab', 'demo_tch_4', 'হাদিস'], ['demo_bat_hifz', 'demo_tch_2', 'তাজবিদ'], ['demo_bat_nazera_b', 'demo_tch_3', 'মাখরাজ']].forEach(([b, t, s], i) => ins('batch_teachers', { id: `demo_bt_${i}`, batch_id: b, teacher_id: t, subject: s }));

// ---- students ------------------------------------------------------------------------
const STUDENTS = [
  ['মুহাম্মাদ আব্দুল্লাহ', 'demo_bat_hifz'], ['আয়েশা সিদ্দিকা', 'demo_bat_nazera_g'], ['আব্দুর রহিম', 'demo_bat_kitab'], ['ফাতেমা জান্নাত', 'demo_bat_nazera_g'],
  ['উমর ফারুক', 'demo_bat_hifz'], ['মারইয়াম আক্তার', 'demo_bat_nazera_g'], ['তানভীর আহমদ', 'demo_bat_nazera_b'], ['খাদিজা খাতুন', 'demo_bat_nazera_g'],
  ['ইব্রাহীম খলিল', 'demo_bat_kitab'], ['সুমাইয়া ইসলাম', 'demo_bat_nazera_g'], ['হাসান মাহমুদ', 'demo_bat_hifz'], ['হুসাইন আহমাদ', 'demo_bat_hifz'],
  ['রুকাইয়া বিনতে হাসান', 'demo_bat_nazera_g'], ['সাকিব হাসান', 'demo_bat_nazera_b'], ['নুসরাত জাহান', 'demo_bat_nazera_g'], ['আরিফুল ইসলাম', 'demo_bat_kitab'],
  ['জয়নাব বেগম', 'demo_bat_nazera_g'], ['ইয়াসিন আরাফাত', 'demo_bat_nazera_b'], ['তাহমিদ হাসান', 'demo_bat_hifz'], ['হাফসা আক্তার', 'demo_bat_nazera_g'],
];
const ADDR = ['মিরপুর, ঢাকা', 'উত্তরা, ঢাকা', 'সাভার, ঢাকা', 'টঙ্গী, গাজীপুর', 'নারায়ণগঞ্জ', 'কেরানীগঞ্জ, ঢাকা', 'মোহাম্মদপুর, ঢাকা'];
const batchOf = Object.fromEntries(BATCHES.map((b) => [b.id, b]));
const courseOf = Object.fromEntries(COURSES.map((c) => [c.id, c]));
// How far each student has paid: months of fees paid out of Jul..Nov (5), admission always paid.
const PAID_MONTHS = [5, 4, 4, 3, 5, 4, 2, 4, 5, 4, 3, 4, 1, 4, 5, 3, 4, 2, 4, 5];
const METHODS = ['cash', 'cash', 'cash', 'bkash', 'bkash', 'nagad', 'bank'];
let receiptNo = 0;
const students = [];
STUDENTS.forEach(([name, batchId], i) => {
  const id = `demo_stu_${String(i + 1).padStart(2, '0')}`;
  const enr = `demo_enr_${String(i + 1).padStart(2, '0')}`;
  const b = batchOf[batchId];
  const c = courseOf[b.course];
  const created = addDays('2026-06-20', i);
  const discount = i === 12 || i === 6 ? tk(c.fee * 0.5) : 0; // two orphans with half fees
  students.push({ id, enr, name, batchId, course: c, discount, i });
  ins('offline_students', { id, student_no: { raw: '(SELECT coalesce(max(student_no), 0) + 1 FROM offline_students)' }, name: `${name}${T}`, phone: `019000001${String(i).padStart(2, '0')}`, guardian_phone: `019000002${String(i).padStart(2, '0')}`, address: pick(ADDR), note: 'ডেমো ছাত্র, পরে মুছে ফেলা হবে', email: '', status: 'active', created_at: at(created) });
  ins('offline_enrollments', { id: enr, student_id: id, course_id: c.id, batch: '', batch_id: batchId, roll: String((i % 6) + 1), start_date: '2026-07-01', fee_minor: tk(c.fee), admission_fee_minor: tk(c.adm), discount_minor: discount, duration_months: 12, plan_months: 1, status: 'active', note: discount ? 'এতিম, অর্ধেক বেতন' : '', created_at: at(created, 11) });

  // Payments: admission at the start, then each month's fee within the first 10 days.
  const monthly = (tk(c.fee) - discount) / 12;
  const method = pick(METHODS);
  const pay = (day, minor, note) => {
    receiptNo += 1;
    const pid = `demo_pay_${String(receiptNo).padStart(3, '0')}`;
    ins('offline_payments', { id: pid, receipt_no: { raw: '(SELECT coalesce(max(receipt_no), 0) + 1 FROM offline_payments)' }, enrollment_id: enr, amount_minor: Math.round(minor), paid_on: day, method, reference: method === 'cash' ? '' : `TRX${100000 + receiptNo}`, note, recorded_by: BY, created_at: at(day, 12) });
    move(day, METHOD_ACCOUNT[method], Math.round(minor));
  };
  pay(addDays('2026-07-01', i % 5), tk(c.adm), 'ভর্তি ফি');
  for (let m = 0; m < PAID_MONTHS[i]; m++) {
    const day = addDays(addMonths('2026-07-01', m), 2 + ((i * 3 + m) % 8));
    if (day > TODAY) break;
    pay(day, monthly, `${['জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর'][m]} মাসের বেতন`);
  }
});

// Half yearly exam with a fee, charged to everyone; most paid it with October's fee.
for (const b of BATCHES) ins('offline_exams', { id: `demo_exam_${b.id.slice(9)}`, batch_id: b.id, title: `অর্ধবার্ষিক পরীক্ষা${T}`, subject: 'সব বিষয়', exam_date: '2026-10-20', start_time: '09:00', fee_minor: tk(300), note: '', status: 'held', created_by: BY, created_at: '2026-10-01T04:00:00.000Z' });
for (const s of students) {
  ins('offline_charges', { id: `demo_chg_${s.enr.slice(9)}`, enrollment_id: s.enr, kind: 'exam', label: `অর্ধবার্ষিক পরীক্ষার ফি${T}`, amount_minor: tk(300), due_date: '2026-10-15', source_key: `exam:demo_exam_${s.batchId.slice(9)}`, created_by: BY, created_at: '2026-10-01T04:00:00.000Z' });
  if (PAID_MONTHS[s.i] >= 4) {
    receiptNo += 1;
    const pid = `demo_pay_${String(receiptNo).padStart(3, '0')}`;
    const day = addDays('2026-10-12', s.i % 4);
    ins('offline_payments', { id: pid, receipt_no: { raw: '(SELECT coalesce(max(receipt_no), 0) + 1 FROM offline_payments)' }, enrollment_id: s.enr, amount_minor: tk(300), paid_on: day, method: 'cash', reference: '', note: 'পরীক্ষার ফি', recorded_by: BY, created_at: at(day, 13) });
    move(day, 'acct_cash', tk(300));
  }
}

// Attendance for the last four weeks of class days.
let attN = 0;
for (let d = addDays(TODAY, -28); d <= TODAY; d = addDays(d, 1)) {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  if (wd === 5) continue; // Friday off
  for (const s of students) {
    const r = rand();
    const status = r < 0.86 ? 'present' : r < 0.93 ? 'late' : r < 0.98 ? 'absent' : 'leave';
    attN += 1;
    ins('offline_attendance', { id: `demo_att_${attN}`, batch_id: s.batchId, enrollment_id: s.enr, day: d, status, marked_by: BY, updated_at: at(d, 9) });
  }
}

// Staff attendance this month.
for (let d = '2026-11-01'; d <= TODAY; d = addDays(d, 1)) {
  if (new Date(`${d}T00:00:00Z`).getUTCDay() === 5) continue;
  TEACHERS.forEach((t, i) => {
    const r = rand();
    const status = r < 0.85 ? 'present' : r < 0.95 ? 'late' : 'absent';
    ins('staff_attendance', { id: `demo_sat_${d}_${i}`, teacher_id: t.id, day: d, status, in_time: status === 'absent' ? '' : status === 'late' ? '08:25' : '07:50', out_time: status === 'absent' ? '' : '14:00', note: '', source: 'office', marked_by: BY, updated_at: at(d, 15) });
  });
}

// ---- money out: expenses, payroll ------------------------------------------------------
let dv = 0;
const expense = (day, category, taka, method, opts = {}) => {
  dv += 1;
  const id = `demo_exp_${String(dv).padStart(3, '0')}`;
  const status = opts.status ?? 'approved';
  ins('expenses', {
    id, spent_on: day, category, amount_minor: tk(taka), description: opts.description ?? '', method, voucher_key: null, recorded_by: opts.by ?? BY,
    status, decided_by: status === 'approved' ? BY : null, decided_at: status === 'approved' ? at(day, 16) : null, voucher_no: { raw: '(SELECT coalesce(max(voucher_no), 0) + 1 FROM expenses)' }, project_id: opts.project ?? null,
    fund_id: opts.fund ?? null, party: opts.party ?? '', checked_by: opts.checked ?? (status === 'approved' && taka > 2000 ? BY : null), voided_at: opts.voided ? at(day, 17) : null,
    voided_by: opts.voided ? BY : null, void_reason: opts.voided ?? null, created_at: at(day, 15),
  });
  if (status === 'approved' && !opts.voided) move(day, METHOD_ACCOUNT[method], -tk(taka));
  return id;
};
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
for (const m of MONTHS) {
  const d = (n) => `${m}-${String(n).padStart(2, '0')}`;
  if (d(5) <= TODAY) expense(d(5), 'বাড়ি ভাড়া', 25000, 'bank', { party: `জনাব নুরুল আমিন (বাড়িওয়ালা)${T}`, description: 'মাদরাসা ভবনের মাসিক ভাড়া' });
  if (d(9) <= TODAY) expense(d(9), 'বিদ্যুৎ বিল', 3000 + Math.round(rand() * 900), 'bkash', { party: 'ডেসকো', description: 'প্রিপেইড মিটার রিচার্জ' });
  if (d(10) <= TODAY) expense(d(10), 'ইন্টারনেট', 1200, 'bkash', { party: 'লোকাল ব্রডব্যান্ড' });
  if (d(3) <= TODAY) expense(d(3), 'ছাত্রদের খাবার', 9000 + Math.round(rand() * 2000), 'cash', { project: 'demo_prj_hifz', fund: 'demo_fund_lillah', party: 'কাঁচাবাজার ও চাল ডাল', description: 'বোর্ডিংয়ের প্রথম পনেরো দিনের বাজার' });
  if (d(18) <= TODAY) expense(d(18), 'ছাত্রদের খাবার', 9000 + Math.round(rand() * 2000), 'cash', { project: 'demo_prj_hifz', fund: 'demo_fund_zakat', party: 'কাঁচাবাজার ও চাল ডাল', description: 'এতিম ছাত্রদের খাবার, পরের পনেরো দিন' });
  if (d(14) <= TODAY) expense(d(14), 'বই ও স্টেশনারি', 1500 + Math.round(rand() * 2500), 'cash', { party: 'ইসলামিয়া লাইব্রেরি, বাংলাবাজার' });
  if (d(21) <= TODAY) expense(d(21), 'আপ্যায়ন', 400 + Math.round(rand() * 600), 'cash', { description: 'অভিভাবক সভা ও মেহমান' });
}
expense('2026-09-12', 'মেরামত', 18500, 'bank', { project: 'demo_prj_build', party: `মেসার্স রহমান কনস্ট্রাকশন${T}`, description: 'ছাদের পানি পড়া বন্ধের কাজ, প্রথম কিস্তি' });
expense('2026-10-08', 'মেরামত', 12000, 'bank', { project: 'demo_prj_build', party: `মেসার্স রহমান কনস্ট্রাকশন${T}`, description: 'শ্রেণিকক্ষের রং ও দরজা' });
expense('2026-10-25', 'আসবাবপত্র', 6400, 'cash', { party: 'হাতিল ফার্নিচার', description: 'শিক্ষকদের জন্য ৪টি চেয়ার' });
expense('2026-11-02', 'যাতায়াত', 850, 'cash', { description: 'বোর্ড অফিসে কাগজ জমা দিতে যাওয়া', voided: 'একই খরচ দুবার লেখা হয়েছিল' });
// Waiting for approval: one for the accountant, one checked and waiting for the owner.
expense('2026-11-11', 'মেরামত', 4800, 'cash', { status: 'pending', by: 'office.demo@test', party: 'ইলেকট্রিশিয়ান', description: 'হিফজখানার ফ্যান ও লাইট', checked: null });
expense('2026-11-12', 'মেরামত', 38000, 'bank', { status: 'pending', by: 'office.demo@test', project: 'demo_prj_build', party: `মেসার্স রহমান কনস্ট্রাকশন${T}`, description: 'টয়লেট ও ওযুখানা মেরামত, শেষ কিস্তি', checked: 'accountant.demo@test' });

// Salaries: July to October paid in the first week of the next month by bank; November still a draft.
let pr = 0;
for (const m of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
  for (const t of TEACHERS) {
    pr += 1;
    const id = `demo_pr_${String(pr).padStart(3, '0')}`;
    const paid = m !== '2026-11';
    const paidOn = paid ? addDays(`${addMonths(`${m}-01`, 1)}`, 4) : null;
    const leave = t.id === 'demo_tch_3' && m === '2026-09' ? 3 : 0;
    const deduction = leave ? tk(Math.round(t.pay / 26)) : 0;
    const net = tk(t.pay) - deduction;
    let expenseId = null;
    if (paid) {
      expenseId = expense(paidOn, t.role === 'staff' ? 'স্টাফ বেতন' : 'শিক্ষক বেতন', net / 100, 'bank', { party: t.name, description: `${m} মাসের বেতন`, project: t.id === 'demo_tch_1' ? 'demo_prj_hifz' : null });
    }
    ins('payroll', {
      id, teacher_id: t.id, month: m, basic_minor: tk(t.pay), work_days: 26, leave_days: leave, paid_leave_days: Math.min(leave, 2), unpaid_days: Math.max(0, leave - 2), deduction_minor: deduction, bonus_minor: 0, other_deduction_minor: 0,
      net_minor: net, basis: 'class_days', note: leave ? '৩ দিন ছুটি, ১ দিন বিনা বেতনে' : '', status: paid ? 'paid' : 'draft', approved_by: paid ? BY : null, approved_at: paid ? at(paidOn, 9) : null,
      paid_on: paidOn, paid_method: paid ? 'bank' : null, expense_id: expenseId, created_by: BY, created_at: at(paid ? addDays(paidOn, -2) : TODAY, 9), updated_at: at(paid ? paidOn : TODAY, 10),
    });
  }
}

// ---- money in that is not fees, and transfers ----------------------------------------------
let cv = 0;
let jv = 0;
const entry = (kind, day, taka, account, opts = {}) => {
  const n = kind === 'income' ? ++cv : ++jv;
  ins('acc_entries', {
    id: `demo_ace_${kind}_${n}`, kind, voucher_no: { raw: `(SELECT coalesce(max(voucher_no), 0) + 1 FROM acc_entries WHERE kind = '${kind}')` }, day, amount_minor: tk(taka), account_id: account, from_account_id: opts.from ?? null, project_id: opts.project ?? null,
    fund_id: kind === 'income' ? (opts.fund ?? 'fund_general') : null, category: opts.category ?? 'স্থানান্তর', party: opts.party ?? '', description: opts.description ?? '', reference: opts.reference ?? '',
    recorded_by: BY, created_at: at(day, 14),
  });
  if (kind === 'income') move(day, account, tk(taka));
  else {
    move(day, opts.from, -tk(taka));
    move(day, account, tk(taka));
  }
};
for (const m of MONTHS) {
  if (`${m}-01` <= TODAY) entry('income', `${m}-01`, 120000, 'acct_bank', { category: 'দান তহবিল থেকে স্থানান্তর', party: 'মাদরাসাতুল ইনসাফ দান তহবিল', description: 'কমিটির সিদ্ধান্তে মাসিক পরিচালনা ব্যয়ের জন্য', reference: `MC-${m}` });
  if (`${m}-02` <= TODAY) entry('transfer', `${m}-02`, 25000, 'acct_cash', { from: 'acct_bank', description: 'মাসের খরচের জন্য ব্যাংক থেকে ক্যাশ তোলা', reference: `CHQ-W-${m}` });
}
entry('income', '2026-08-15', 90000, 'acct_bank', { category: 'অনুদান বা গ্রান্ট', fund: 'demo_fund_zakat', party: `আল খায়ের যাকাত ফাউন্ডেশন${T}`, description: 'এতিম ছাত্রদের খাবার ও বই বাবদ যাকাত অনুদান', reference: 'CHQ-458821' });
entry('income', '2026-07-10', 65000, 'acct_bank', { category: 'অনুদান বা গ্রান্ট', fund: 'demo_fund_lillah', project: 'demo_prj_hifz', party: `স্থানীয় ব্যবসায়ী সমিতি${T}`, description: 'বোর্ডিংয়ের লিল্লাহ অনুদান', reference: 'CHQ-120394' });
entry('income', '2026-09-05', 60000, 'acct_bank', { category: 'অনুদান বা গ্রান্ট', project: 'demo_prj_build', party: `জনাব হাজী সিরাজুল হক${T}`, description: 'ভবন মেরামতের জন্য বিশেষ অনুদান', reference: 'CHQ-771105' });
entry('income', '2026-10-30', 3500, 'acct_cash', { category: 'বই ও পোশাক বিক্রি', party: 'ছাত্রদের কাছে', description: 'ইউনিফর্ম টুপি ও কায়দা বিক্রি' });
entry('income', '2026-09-30', 1840, 'acct_bank', { category: 'ব্যাংক মুনাফা', party: 'ব্যাংক', description: 'সঞ্চয়ী হিসাবের মুনাফা' });
entry('transfer', '2026-11-06', 8000, 'acct_bank', { from: 'acct_mobile', description: 'বিকাশ থেকে ব্যাংকে' });
entry('transfer', '2026-10-06', 10000, 'acct_bank', { from: 'acct_mobile', description: 'বিকাশ থেকে ব্যাংকে' });

// ---- budgets 2026 ---------------------------------------------------------------------------
[
  ['demo_bud_1', 'demo_prj_hifz', '', 320000, 'হিফজ বিভাগের বছরের সব খরচ'],
  ['demo_bud_2', 'demo_prj_build', '', 60000, 'মেরামতের অনুমোদিত বাজেট'],
  ['demo_bud_3', '', 'বাড়ি ভাড়া', 300000, ''],
  ['demo_bud_4', '', 'বিদ্যুৎ বিল', 36000, ''],
  ['demo_bud_5', '', 'বই ও স্টেশনারি', 20000, ''],
  ['demo_bud_6', '', 'শিক্ষক বেতন', 900000, ''],
].forEach(([id, project, category, taka, note]) => ins('acc_budgets', { id, year: '2026', project_id: project, category, amount_minor: tk(taka), note, created_by: BY }));

// Reconciliations from the computed books.
const balanceOn = (day, account) => moves.filter(([d, a]) => d <= day && a === account).reduce((s, [, , m]) => s + m, 0);
const bankOct = balanceOn('2026-10-31', 'acct_bank');
const cashOct = balanceOn('2026-10-31', 'acct_cash');
ins('acc_reconciliations', { id: 'demo_rec_1', account_id: 'acct_bank', as_of: '2026-10-31', statement_minor: bankOct, book_minor: bankOct, note: `ব্যাংক স্টেটমেন্ট অক্টোবর${T}`, created_by: BY, created_at: '2026-11-02T05:00:00.000Z' });
ins('acc_reconciliations', { id: 'demo_rec_2', account_id: 'acct_cash', as_of: '2026-10-31', statement_minor: cashOct - tk(150), book_minor: cashOct, note: `ক্যাশ গোনা হয়েছে, ১৫০ টাকা কম, খোঁজা হচ্ছে${T}`, created_by: BY, created_at: '2026-11-01T11:00:00.000Z' });

// ---- CRM ----------------------------------------------------------------------------------------
const TAGS = { 1: ['হিফজ', 'আবাসিক'], 5: ['হিফজ', 'আবাসিক'], 7: ['এতিম', 'যাকাত সহায়তা'], 11: ['হিফজ', 'আবাসিক'], 12: ['হিফজ'], 13: ['এতিম', 'যাকাত সহায়তা', 'আবাসিক'], 3: ['ভাই বোন একসাথে'], 4: ['ভাই বোন একসাথে'], 18: ['নিয়মিত বকেয়া'] };
for (const [k, tags] of Object.entries(TAGS)) for (const tag of tags) ins('crm_tags', { student_id: `demo_stu_${String(Math.floor(Number(k))).padStart(2, '0')}`, tag, created_by: BY });
ins('crm_tags', { student_id: 'demo_stu_19', tag: 'হিফজ', created_by: BY });
ins('crm_tags', { student_id: 'demo_stu_07', tag: 'নিয়মিত বকেয়া', created_by: BY });

const FOLLOW = [
  ['demo_fu_1', 'demo_stu_13', 'বকেয়া নিয়ে অভিভাবকের সাথে কথা বলা', addDays(TODAY, -3), 'open', ''],
  ['demo_fu_2', 'demo_stu_07', 'বাবাকে ফোন: দুই মাসের বেতন বাকি', addDays(TODAY, -1), 'open', ''],
  ['demo_fu_3', 'demo_stu_18', 'অভিভাবক সভার দাওয়াত দেওয়া', TODAY, 'open', ''],
  ['demo_fu_4', 'demo_stu_11', 'হিফজের অগ্রগতি জানানো (১০ পারা শেষ)', addDays(TODAY, 4), 'open', ''],
  ['demo_fu_5', 'demo_stu_04', 'ভর্তির কাগজ (জন্মসনদ) নেওয়া', addDays(TODAY, 7), 'open', ''],
  ['demo_fu_6', 'demo_stu_02', 'অনুপস্থিতির কারণ জানা', '2026-11-04', 'done', 'জ্বর ছিল, এখন সুস্থ, কাল থেকে আসবে'],
  ['demo_fu_7', 'demo_stu_16', 'বকেয়া বেতন', '2026-11-06', 'done', 'বৃহস্পতিবার বিকাশে দেবেন বলেছেন'],
];
for (const [id, sid, title, due, status, outcome] of FOLLOW)
  ins('crm_followups', { id, student_id: sid, title: `${title}${T}`, due_on: due, assigned_to: status === 'open' ? 'অফিস সহকারী' : '', status, outcome, created_by: BY, created_at: at(addDays(due, -5), 11), done_by: status === 'done' ? BY : null, done_at: status === 'done' ? at(due, 12) : null });

const CONTACTS = [
  ['demo_stu_02', 'call', 'out', 'অনুপস্থিতির কারণ জানা: জ্বর ছিল, এখন সুস্থ, কাল থেকে আসবে', '2026-11-04'],
  ['demo_stu_16', 'call', 'out', 'বকেয়া বেতন: বৃহস্পতিবার বিকাশে দেবেন বলেছেন', '2026-11-06'],
  ['demo_stu_13', 'whatsapp', 'out', 'বকেয়া ফির রিমাইন্ডার পাঠানো হয়েছে', '2026-11-05'],
  ['demo_stu_13', 'visit', 'in', 'মা অফিসে এসেছিলেন, যাকাত সহায়তার আবেদন জমা দিয়েছেন', '2026-11-08'],
  ['demo_stu_07', 'sms', 'out', 'বকেয়া ফির রিমাইন্ডার পাঠানো হয়েছে', '2026-11-02'],
  ['demo_stu_11', 'call', 'in', 'বাবা হিফজের অগ্রগতি জানতে চেয়েছেন', '2026-10-28'],
  ['demo_stu_01', 'portal', 'out', 'অর্ধবার্ষিক পরীক্ষার রুটিন পাঠানো হয়েছে', '2026-10-05'],
  ['demo_stu_05', 'portal', 'out', 'অর্ধবার্ষিক পরীক্ষার রুটিন পাঠানো হয়েছে', '2026-10-05'],
  ['demo_stu_09', 'visit', 'in', 'অভিভাবক সভায় উপস্থিত ছিলেন', '2026-09-26'],
  ['demo_stu_03', 'whatsapp', 'out', 'ছুটির নোটিশ পাঠানো হয়েছে', '2026-10-15'],
  ['demo_stu_18', 'call', 'out', 'ফোন ধরেননি, পরে আবার করতে হবে', '2026-11-10'],
  ['demo_stu_20', 'letter', 'out', 'ভর্তি নিশ্চিত করার চিঠি দেওয়া হয়েছে', '2026-07-02'],
];
CONTACTS.forEach(([sid, channel, direction, summary, day], i) => ins('crm_contacts', { id: `demo_ct_${i + 1}`, student_id: sid, channel, direction, summary: `${summary}${T}`, created_by: BY, created_at: at(day, 11 + (i % 5)) }));

ins('crm_templates', { id: 'demo_tpl_1', name: `বকেয়া মনে করানো${T}`, channel: 'whatsapp', body: 'আসসালামু আলাইকুম। {name} ({id}) এর {course} এর {due} বকেয়া আছে। অনুগ্রহ করে এই সপ্তাহের মধ্যে পরিশোধ করুন। জাযাকাল্লাহু খাইরান। মাদরাসাতুল ইনসাফ', created_by: BY });
ins('crm_templates', { id: 'demo_tpl_2', name: `অভিভাবক সভার দাওয়াত${T}`, channel: 'any', body: 'আসসালামু আলাইকুম। আগামী শনিবার সকাল ১০টায় মাদরাসায় অভিভাবক সভা। {name} এর অভিভাবককে উপস্থিত থাকার অনুরোধ করছি।', created_by: BY });
ins('crm_templates', { id: 'demo_tpl_3', name: `অনুপস্থিতির খোঁজ${T}`, channel: 'sms', body: '{name} আজ ({date}) মাদরাসায় আসেনি। কোনো সমস্যা হলে অফিসে জানান।', created_by: BY });

// A ticket and a student leave request, so those pages are not empty.
ins('tickets', { id: 'demo_tkt_1', ticket_no: { raw: '(SELECT coalesce(max(ticket_no), 0) + 1 FROM tickets)' }, from_kind: 'student', offline_student_id: 'demo_stu_03', subject: `কিতাবের নতুন কপি পাওয়া যাবে কি?${T}`, category: 'other', status: 'open', created_at: at('2026-11-09', 18), updated_at: at('2026-11-09', 18) });
ins('ticket_messages', { id: 'demo_tkm_1', ticket_id: 'demo_tkt_1', author_kind: 'student', author: 'demo', body: 'মিশকাত শরীফের প্রথম খণ্ড ছিঁড়ে গেছে, নতুন কপি লাইব্রেরি থেকে পাওয়া যাবে কি? (টেস্ট)', created_at: at('2026-11-09', 18) });
ins('student_leave_requests', { id: 'demo_slr_1', student_id: 'demo_stu_10', from_day: addDays(TODAY, 2), to_day: addDays(TODAY, 4), reason: `খালার বিয়েতে গ্রামের বাড়ি যাবে${T}`, status: 'pending', requested_by: 'guardian', created_at: at(TODAY, 9) });

// Check the demo books never go below zero in any account on any day.
const days = [...new Set(moves.map(([d]) => d))].sort();
for (const a of Object.keys(bal)) {
  let run = 0;
  for (const d of days) {
    run += moves.filter(([x, acc]) => x === d && acc === a).reduce((s, [, , m]) => s + m, 0);
    if (run < 0) {
      console.error(`Demo ${a} would go below zero on ${d} (${run / 100})`);
      process.exit(1);
    }
  }
  bal[a] = run;
}
void balAt;
writeFileSync(out, `${rows.join('\n')}\n`);
console.log(`Wrote ${out}: ${rows.length} rows. Closing balances (taka):`, Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, v / 100])));
