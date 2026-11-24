import { log } from './admin';
import { offlineStudentInsert, prepareOfflineEnrollment, type EnrollInput } from './offline';
import { cleanPhone, longText, newId, PHONE, text, type Result } from './ops-util';
import { isYmd, parseTaka } from '../lib/offline';
import { PLEDGE_VERSION } from '../lib/pledges';

// The full online admission form (/admission/apply). A family fills the
// student's details, reads and signs both pledges (the student's and the
// guardian's, by typing their names and ticking agreement), and sends it.
// Nothing becomes a student until the office accepts the application: only then
// is a student record (with its ID number) made, and only then does the family
// see an ID card in the student panel. Rejections keep a reason the family can
// read on /admission/status.

export const RESIDENCES = ['resident', 'non_resident', 'day_care'] as const;
export type Residence = (typeof RESIDENCES)[number];
export const RESIDENCE_BN: Record<Residence, string> = { resident: 'আবাসিক', non_resident: 'অনাবাসিক', day_care: 'ডে-কেয়ার' };
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

export const APPLICATION_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const APPLICATION_STATUS_BN: Record<ApplicationStatus, string> = { pending: 'অপেক্ষায়', accepted: 'গৃহীত', rejected: 'প্রত্যাখ্যাত' };

export const applicationCode = (no: number) => `AP-${String(no).padStart(4, '0')}`;

/** Everything the family writes about the child and themselves (no signatures, no photo). */
export type ApplicationDetails = {
  studentName: string;
  birthDate: string;
  fatherName: string;
  fatherOccupation: string;
  permVillage: string;
  permPost: string;
  permThana: string;
  permDistrict: string;
  curVillage: string;
  curPost: string;
  curThana: string;
  curDistrict: string;
  prevClass: string;
  department: string;
  /** The department (offline course) picked on the form. */
  courseId: string;
  desiredClass: string;
  prevInstitute: string;
  bloodGroup: string;
  residence: Residence;
  pickupName: string;
  pickupAddress: string;
  pickupPhone: string;
  guardianName: string;
  guardianOccupation: string;
  guardianNid: string;
  phone: string;
};

export type Signatures = { studentSignName: string; guardianSignName: string };
const bad = (s: string) => /[<>]/.test(s);

/** Reads and checks the details. `today` (YYYY-MM-DD) bounds the birth date. */
export type DepartmentChoice = { id: string; title: string };

export function parseApplicationDetails(form: FormData, today: string, departments: readonly DepartmentChoice[]): Result<ApplicationDetails> {
  const t = (k: string, max = 200) => text(form, k, max);
  const studentName = t('studentName', 120);
  if (studentName.length < 2) return { ok: false, error: 'studentName' };
  const birthDate = t('birthDate', 10);
  if (!isYmd(birthDate) || birthDate > today || birthDate < `${Number(today.slice(0, 4)) - 40}-01-01`) return { ok: false, error: 'birthDate' };
  const guardianName = t('guardianName', 120);
  if (guardianName.length < 2) return { ok: false, error: 'guardianName' };
  const phone = cleanPhone(t('phone', 25));
  if (!PHONE.test(phone)) return { ok: false, error: 'phone' };
  const pickupPhone = cleanPhone(t('pickupPhone', 25));
  if (pickupPhone && !PHONE.test(pickupPhone)) return { ok: false, error: 'pickupPhone' };
  const permDistrict = t('permDistrict', 80);
  if (!permDistrict) return { ok: false, error: 'permDistrict' };
  const picked = departments.find((d) => d.id === t('courseId', 60));
  if (!picked) return { ok: false, error: 'department' };
  const department = picked.title;
  const desiredClass = t('desiredClass', 120);
  if (!desiredClass) return { ok: false, error: 'desiredClass' };
  const residence = t('residence', 20);
  if (!(RESIDENCES as readonly string[]).includes(residence)) return { ok: false, error: 'residence' };
  const bloodGroup = t('bloodGroup', 5);
  if (bloodGroup && !(BLOOD_GROUPS as readonly string[]).includes(bloodGroup)) return { ok: false, error: 'bloodGroup' };
  const nid = cleanPhone(t('guardianNid', 25));
  if (nid && !/^[0-9]{8,20}$/.test(nid)) return { ok: false, error: 'guardianNid' };
  // "Same as permanent" copies the permanent address into the present one.
  const same = form.get('curSame') === 'on';
  const cur = (k: string) => (same ? t(`perm${k}`, 80) : t(`cur${k}`, 80));
  const value: ApplicationDetails = {
    studentName,
    birthDate,
    fatherName: t('fatherName', 120),
    fatherOccupation: t('fatherOccupation', 80),
    permVillage: t('permVillage', 80),
    permPost: t('permPost', 80),
    permThana: t('permThana', 80),
    permDistrict,
    curVillage: cur('Village'),
    curPost: cur('Post'),
    curThana: cur('Thana'),
    curDistrict: cur('District'),
    prevClass: t('prevClass', 80),
    department,
    courseId: picked.id,
    desiredClass,
    prevInstitute: t('prevInstitute', 200),
    bloodGroup,
    residence: residence as Residence,
    pickupName: t('pickupName', 120),
    pickupAddress: t('pickupAddress', 200),
    pickupPhone,
    guardianName,
    guardianOccupation: t('guardianOccupation', 80),
    guardianNid: nid,
    phone,
  };
  if (Object.values(value).some((v) => typeof v === 'string' && bad(v))) return { ok: false, error: 'chars' };
  return { ok: true, value };
}

/** Both pledges must be ticked and signed with a typed name. */
export function parseSignatures(form: FormData): Result<Signatures> {
  const studentSignName = text(form, 'studentSignName', 120);
  const guardianSignName = text(form, 'guardianSignName', 120);
  if (form.get('studentAgree') !== 'on' || studentSignName.length < 2 || bad(studentSignName)) return { ok: false, error: 'studentSign' };
  if (form.get('guardianAgree') !== 'on' || guardianSignName.length < 2 || bad(guardianSignName)) return { ok: false, error: 'guardianSign' };
  return { ok: true, value: { studentSignName, guardianSignName } };
}

const COLS: [keyof ApplicationDetails, string][] = [
  ['studentName', 'student_name'], ['birthDate', 'birth_date'], ['fatherName', 'father_name'], ['fatherOccupation', 'father_occupation'],
  ['permVillage', 'perm_village'], ['permPost', 'perm_post'], ['permThana', 'perm_thana'], ['permDistrict', 'perm_district'],
  ['curVillage', 'cur_village'], ['curPost', 'cur_post'], ['curThana', 'cur_thana'], ['curDistrict', 'cur_district'],
  ['prevClass', 'prev_class'], ['department', 'department'], ['courseId', 'course_id'], ['desiredClass', 'desired_class'], ['prevInstitute', 'prev_institute'],
  ['bloodGroup', 'blood_group'], ['residence', 'residence'], ['pickupName', 'pickup_name'], ['pickupAddress', 'pickup_address'],
  ['pickupPhone', 'pickup_phone'], ['guardianName', 'guardian_name'], ['guardianOccupation', 'guardian_occupation'], ['guardianNid', 'guardian_nid'], ['phone', 'phone'],
];

/** Saves a signed application. Returns its id and the number the family keeps. */
export async function applicationBySubmission(db: D1Database, key: string | null) {
  return key ? db.prepare('SELECT id, app_no AS appNo FROM admission_applications WHERE submit_key = ?').bind(key).first<{ id: string; appNo: number }>() : null;
}

export async function createApplication(db: D1Database, d: ApplicationDetails, s: Signatures, photoKey: string, submitKey: string | null = null): Promise<{ id: string; appNo: number }> {
  const id = newId('adm');
  const cols = COLS.map(([, c]) => c);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await db
        .prepare(
          `INSERT INTO admission_applications (id, app_no, ${cols.join(', ')}, photo_key, pledge_version, student_sign_name, student_signed_at, guardian_sign_name, guardian_signed_at, submit_key)
           VALUES (?1, (SELECT coalesce(max(app_no), 0) + 1 FROM admission_applications), ${cols.map((_, i) => `?${i + 2}`).join(', ')},
             ?${cols.length + 2}, ?${cols.length + 3}, ?${cols.length + 4}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?${cols.length + 5}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?${cols.length + 6})
           RETURNING app_no AS appNo`,
        )
        .bind(id, ...COLS.map(([k]) => d[k]), photoKey, PLEDGE_VERSION, s.studentSignName, s.guardianSignName, submitKey)
        .first<{ appNo: number }>();
      return { id, appNo: r!.appNo };
    } catch (e) {
      const seen = await applicationBySubmission(db, submitKey);
      if (seen) return seen;
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
}

export type Application = ApplicationDetails & {
  id: string;
  appNo: number;
  status: ApplicationStatus;
  photoKey: string;
  pledgeVersion: number;
  studentSignName: string;
  studentSignedAt: string | null;
  guardianSignName: string;
  guardianSignedAt: string | null;
  examMarks: string;
  examinerName: string;
  feeMinor: number;
  officeNote: string;
  decisionNote: string;
  decidedBy: string | null;
  decidedAt: string | null;
  studentId: string | null;
  createdAt: string;
  updatedAt: string;
};

const SELECT = `SELECT id, app_no AS appNo, status, ${COLS.map(([k, c]) => (k === c ? k : `${c} AS ${k}`)).join(', ')}, photo_key AS photoKey, pledge_version AS pledgeVersion,
  student_sign_name AS studentSignName, student_signed_at AS studentSignedAt, guardian_sign_name AS guardianSignName, guardian_signed_at AS guardianSignedAt,
  exam_marks AS examMarks, examiner_name AS examinerName, fee_minor AS feeMinor, office_note AS officeNote, decision_note AS decisionNote,
  decided_by AS decidedBy, decided_at AS decidedAt, student_id AS studentId, created_at AS createdAt, updated_at AS updatedAt FROM admission_applications`;

export const getApplication = (db: D1Database, id: string) => db.prepare(`${SELECT} WHERE id = ?`).bind(id).first<Application>();

export async function listApplications(db: D1Database, status: ApplicationStatus | '' = '', q = '', limit = 300): Promise<Application[]> {
  const term = q.trim();
  const no = /^(?:ap-?)?0*(\d{1,6})$/i.exec(term);
  const where: string[] = [];
  const bind: unknown[] = [];
  if (status) { where.push('status = ?'); bind.push(status); }
  if (term) {
    where.push('(student_name LIKE ? ESCAPE \'\\\' OR guardian_name LIKE ? ESCAPE \'\\\' OR phone LIKE ? ESCAPE \'\\\'' + (no ? ' OR app_no = ?' : '') + ')');
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    bind.push(like, like, like);
    if (no) bind.push(Number(no[1]));
  }
  const { results } = await db
    .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY status = 'pending' DESC, created_at DESC LIMIT ?`)
    .bind(...bind, limit)
    .all<Application>();
  return results;
}

export async function applicationCounts(db: D1Database): Promise<Record<ApplicationStatus, number>> {
  const { results } = await db.prepare('SELECT status, count(*) AS n FROM admission_applications GROUP BY status').all<{ status: ApplicationStatus; n: number }>();
  const out: Record<ApplicationStatus, number> = { pending: 0, accepted: 0, rejected: 0 };
  for (const r of results) out[r.status] = r.n;
  return out;
}

export type OfficeFields = { examMarks: string; examinerName: string; feeMinor: number; officeNote: string };

export function parseOfficeFields(form: FormData): Result<OfficeFields> {
  const feeRaw = text(form, 'feeTaka', 12);
  const fee = feeRaw === '' ? 0 : parseTaka(feeRaw);
  if (fee === null) return { ok: false, error: 'fee' };
  return { ok: true, value: { examMarks: text(form, 'examMarks', 40), examinerName: text(form, 'examinerName', 120), feeMinor: fee * 100, officeNote: longText(form, 'officeNote', 1000) } };
}

/** Staff fix the family's details and fill the office part. Accepted ones keep their details (the student record is edited instead). */
export async function updateApplication(db: D1Database, actor: string, id: string, d: ApplicationDetails | null, o: OfficeFields): Promise<boolean> {
  const cur = await db.prepare('SELECT status FROM admission_applications WHERE id = ?').bind(id).first<{ status: ApplicationStatus }>();
  if (!cur) return false;
  const stamp = `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const office = db
    .prepare(`UPDATE admission_applications SET exam_marks = ?, examiner_name = ?, fee_minor = ?, office_note = ?, ${stamp} WHERE id = ?`)
    .bind(o.examMarks, o.examinerName, o.feeMinor, o.officeNote, id);
  const statements = [office];
  if (d && cur.status !== 'accepted') {
    statements.push(db.prepare(`UPDATE admission_applications SET ${COLS.map(([, c]) => `${c} = ?`).join(', ')} WHERE id = ?`).bind(...COLS.map(([k]) => d[k]), id));
  }
  await db.batch(statements);
  await log(db, actor, 'admission.update', `application:${id}`, {});
  return true;
}

const addressLine = (p: { village: string; post: string; thana: string; district: string }) =>
  [p.village && `গ্রাম: ${p.village}`, p.post && `পোস্ট: ${p.post}`, p.thana && `থানা: ${p.thana}`, p.district && `জেলা: ${p.district}`].filter(Boolean).join(', ');
export const permAddress = (a: Application) => addressLine({ village: a.permVillage, post: a.permPost, thana: a.permThana, district: a.permDistrict });
export const curAddress = (a: Application) => addressLine({ village: a.curVillage, post: a.curPost, thana: a.curThana, district: a.curDistrict });

/** Age in whole years on `today`. */
export function ageOn(birthDate: string, today: string): number | null {
  if (!isYmd(birthDate) || !isYmd(today)) return null;
  let age = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (today.slice(5) < birthDate.slice(5)) age--;
  return age;
}

/** Commit the decision, student and enrollment together. A changed application must be reviewed again. */
export async function acceptApplication(
  db: D1Database,
  actor: string,
  id: string,
  placement?: { enrollment: EnrollInput; admissionMinor?: number; updatedAt: string; confirmFree: boolean },
): Promise<{ studentId: string } | null> {
  const a = await getApplication(db, id);
  if (!a || a.status !== 'pending' || (placement && (a.updatedAt !== placement.updatedAt || !placement.enrollment.batchId))) return null;
  const studentId = newId('ofs');
  const terms = placement ? await prepareOfflineEnrollment(db, studentId, placement.enrollment, placement.admissionMinor) : null;
  if (placement && (!terms || (terms.admissionMinor + terms.tuitionMinor === terms.discountMinor && !placement.confirmFree))) return null;
  const student = offlineStudentInsert(db, studentId, {
    name: a.studentName,
    phone: a.phone,
    guardianPhone: a.pickupPhone && a.pickupPhone !== a.phone ? a.pickupPhone : '',
    email: '',
    address: curAddress(a) || permAddress(a),
    note: `ভর্তির আবেদন ${applicationCode(a.appNo)}। অভিভাবক: ${a.guardianName}${a.fatherName ? `। পিতা: ${a.fatherName}` : ''}`,
  }, { id, updatedAt: a.updatedAt, photoKey: a.photoKey });
  const decision = db.prepare(
    `UPDATE admission_applications SET status = 'accepted', student_id = ?1, fee_minor = ?2,
       decided_by = ?3, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note = '',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?4 AND status = 'pending' AND EXISTS (SELECT 1 FROM offline_students WHERE id = ?1)`,
  ).bind(studentId, terms?.admissionMinor ?? a.feeMinor, actor, id);
  const [inserted] = await db.batch(terms ? [student, terms.statement, decision] : [student, decision]);
  if (!inserted?.meta.changes) return null;
  await log(db, actor, 'admission.accept', `application:${id}`, { studentId, enrollmentId: terms?.id });
  return { studentId };
}

/** Rejects a pending application. The reason is required and is shown to the family. */
export async function rejectApplication(db: D1Database, actor: string, id: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 500);
  if (why.length < 3) return false;
  const r = await db
    .prepare(`UPDATE admission_applications SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'`)
    .bind(why, actor, id)
    .run();
  if (r.meta.changes) await log(db, actor, 'admission.reject', `application:${id}`, { reason: why });
  return r.meta.changes > 0;
}

/** Puts a rejected application back to pending (a changed mind or a mistake). */
export async function reopenApplication(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE admission_applications SET status = 'pending', decision_note = '', decided_by = NULL, decided_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'rejected'`)
    .bind(id)
    .run();
  if (r.meta.changes) await log(db, actor, 'admission.reopen', `application:${id}`, {});
  return r.meta.changes > 0;
}

export type PublicStatus = { appNo: number; studentName: string; status: ApplicationStatus; decisionNote: string; createdAt: string };

/** What a family may see: the number and the phone given on the form must both match. */
export async function statusFor(db: D1Database, rawNo: string, rawPhone: string): Promise<PublicStatus | null> {
  const m = /^(?:ap-?)?0*(\d{1,6})$/i.exec(rawNo.trim());
  const phone = cleanPhone(rawPhone);
  if (!m || !PHONE.test(phone)) return null;
  return db
    .prepare('SELECT app_no AS appNo, student_name AS studentName, status, decision_note AS decisionNote, created_at AS createdAt FROM admission_applications WHERE app_no = ? AND phone = ?')
    .bind(Number(m[1]), phone)
    .first<PublicStatus>();
}

export async function newApplicationCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT count(*) AS n FROM admission_applications WHERE status = 'pending'").first<{ n: number }>())?.n ?? 0;
}
