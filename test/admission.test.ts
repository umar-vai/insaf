import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptApplication,
  ageOn,
  applicationCode,
  applicationCounts,
  createApplication,
  getApplication,
  parseApplicationDetails,
  parseOfficeFields,
  parseSignatures,
  rejectApplication,
  reopenApplication,
  statusFor,
  updateApplication,
} from '../src/server/admission';
import { grantPasswordLogin, phoneEmail } from '../src/server/password';
import { studentPanel } from '../src/server/panels';
import { GUARDIAN_PLEDGE, STUDENT_PLEDGE } from '../src/lib/pledges';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-23';

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM admission_applications'),
    db.prepare('DELETE FROM offline_students'),
    db.prepare('DELETE FROM students'),
    db.prepare('DELETE FROM admin_events'),
  ]);
});

const base: Record<string, string> = {
  studentName: 'আব্দুল্লাহ',
  birthDate: '2016-05-10',
  fatherName: 'আব্দুর রহমান',
  permVillage: 'রামপুর',
  permDistrict: 'কুমিল্লা',
  curSame: 'on',
  courseId: 'dept_nazera',
  desiredClass: 'নাজেরা',
  residence: 'resident',
  guardianName: 'আব্দুর রহমান',
  phone: '01712-345678',
};
const DEPTS = [{ id: 'dept_nazera', title: 'আদর্শ নাজেরা শাখা' }, { id: 'dept_hifz', title: 'হিফজুল কুরআন শাখা' }];
const formOf = (extra: Record<string, string> = {}, drop: string[] = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...extra })) if (!drop.includes(k)) f.set(k, v);
  return f;
};
const signed = { studentSignName: 'আব্দুল্লাহ', guardianSignName: 'আব্দুর রহমান' };

async function submit(extra: Record<string, string> = {}) {
  const d = parseApplicationDetails(formOf(extra), today, DEPTS);
  if (!d.ok) throw new Error(d.error);
  return createApplication(db, d.value, signed, 'private/admission/abc.webp');
}

describe('admission form checks', () => {
  it('accepts the full form and cleans the phone number', () => {
    const d = parseApplicationDetails(formOf(), today, DEPTS);
    expect(d.ok && d.value.phone).toBe('01712345678');
    // "same as permanent" copies the address
    expect(d.ok && d.value.curDistrict).toBe('কুমিল্লা');
  });

  it('rejects missing or wrong required fields', () => {
    expect(parseApplicationDetails(formOf({}, ['studentName']), today, DEPTS)).toEqual({ ok: false, error: 'studentName' });
    expect(parseApplicationDetails(formOf({ birthDate: '2030-01-01' }), today, DEPTS)).toEqual({ ok: false, error: 'birthDate' });
    expect(parseApplicationDetails(formOf({ phone: '12' }), today, DEPTS)).toEqual({ ok: false, error: 'phone' });
    expect(parseApplicationDetails(formOf({ courseId: 'something_else' }), today, DEPTS)).toEqual({ ok: false, error: 'department' });
    expect(parseApplicationDetails(formOf({ residence: 'hotel' }), today, DEPTS)).toEqual({ ok: false, error: 'residence' });
    expect(parseApplicationDetails(formOf({ fatherName: '<b>x</b>' }), today, DEPTS)).toEqual({ ok: false, error: 'chars' });
  });

  it('needs both pledges ticked and signed with a name', () => {
    const f = (o: Record<string, string>) => { const x = new FormData(); Object.entries(o).forEach(([k, v]) => x.set(k, v)); return x; };
    expect(parseSignatures(f({ studentAgree: 'on', studentSignName: 'ক', guardianAgree: 'on', guardianSignName: 'খ গ' })).ok).toBe(false);
    expect(parseSignatures(f({ studentSignName: 'ক খ', guardianAgree: 'on', guardianSignName: 'খ গ' }))).toEqual({ ok: false, error: 'studentSign' });
    expect(parseSignatures(f({ studentAgree: 'on', studentSignName: 'ক খ', guardianSignName: 'খ গ' }))).toEqual({ ok: false, error: 'guardianSign' });
    expect(parseSignatures(f({ studentAgree: 'on', studentSignName: 'ক খ', guardianAgree: 'on', guardianSignName: 'খ গ' })).ok).toBe(true);
  });

  it('keeps every pledge point from the printed papers', () => {
    expect(STUDENT_PLEDGE.points).toHaveLength(16);
    expect(GUARDIAN_PLEDGE.points).toHaveLength(12);
  });

  it('works out age', () => {
    expect(ageOn('2016-05-10', '2026-11-23')).toBe(10);
    expect(ageOn('2016-12-10', '2026-11-23')).toBe(9);
  });
});

describe('application and decision', () => {
  it('numbers applications one after another and starts pending with no student', async () => {
    const a = await submit();
    const b = await submit({ studentName: 'ফাতেমা' });
    expect([a.appNo, b.appNo]).toEqual([1, 2]);
    expect(applicationCode(a.appNo)).toBe('AP-0001');
    const row = await getApplication(db, a.id);
    expect(row?.status).toBe('pending');
    expect(row?.studentSignName).toBe('আব্দুল্লাহ');
    expect(row?.studentSignedAt).toBeTruthy();
    expect(row?.guardianSignedAt).toBeTruthy();
    expect((await db.prepare('SELECT count(*) AS n FROM offline_students').first<{ n: number }>())?.n).toBe(0);
  });

  it('shows the status only when number and phone both match', async () => {
    const a = await submit();
    expect((await statusFor(db, 'AP-0001', '01712345678'))?.status).toBe('pending');
    expect((await statusFor(db, '1', '০১৭১২-৩৪৫৬৭৮'))?.appNo).toBe(a.appNo);
    expect(await statusFor(db, 'AP-0001', '01999999999')).toBeNull();
    expect(await statusFor(db, 'AP-0002', '01712345678')).toBeNull();
  });

  it('accepting makes one student with an ID number, the photo and a link back; a second accept does nothing', async () => {
    const a = await submit();
    const r = await acceptApplication(db, ACTOR, a.id);
    expect(r?.studentId).toBeTruthy();
    expect(await acceptApplication(db, ACTOR, a.id)).toBeNull();
    const s = await db.prepare('SELECT student_no AS no, name, phone, photo_key AS photo, application_id AS app FROM offline_students').all<{ no: number; name: string; phone: string; photo: string; app: string }>();
    expect(s.results).toEqual([{ no: 1, name: 'আব্দুল্লাহ', phone: '01712345678', photo: 'private/admission/abc.webp', app: a.id }]);
    const row = await getApplication(db, a.id);
    expect(row?.status).toBe('accepted');
    expect(row?.studentId).toBe(r!.studentId);
  });

  it('the ID card (student panel) opens only after acceptance', async () => {
    const a = await submit();
    expect((await studentPanel(db, phoneEmail('01712345678'), today)).people).toHaveLength(0);
    const r = (await acceptApplication(db, ACTOR, a.id))!;
    const g = await grantPasswordLogin(db, ACTOR, 'student', r.studentId);
    expect(g.ok).toBe(true);
    const panel = await studentPanel(db, phoneEmail('01712345678'), today);
    expect(panel.people).toHaveLength(1);
    expect(panel.people[0]!.student.photoKey).toBe('private/admission/abc.webp');
  });

  it('rejecting needs a reason, shows it to the family, and can be reopened; accepted ones cannot be rejected', async () => {
    const a = await submit();
    expect(await rejectApplication(db, ACTOR, a.id, '  ')).toBe(false);
    expect(await rejectApplication(db, ACTOR, a.id, 'বয়স কম')).toBe(true);
    const seen = await statusFor(db, 'AP-0001', '01712345678');
    expect(seen).toMatchObject({ status: 'rejected', decisionNote: 'বয়স কম' });
    expect(await acceptApplication(db, ACTOR, a.id)).toBeNull();
    expect(await reopenApplication(db, ACTOR, a.id)).toBe(true);
    expect((await getApplication(db, a.id))?.status).toBe('pending');
    await acceptApplication(db, ACTOR, a.id);
    expect(await rejectApplication(db, ACTOR, a.id, 'ভুল')).toBe(false);
    expect(await applicationCounts(db)).toEqual({ pending: 0, accepted: 1, rejected: 0 });
  });

  it('the office part keeps money as whole poisha and edits do not touch accepted details', async () => {
    const a = await submit();
    const f = new FormData();
    f.set('feeTaka', '1,500');
    f.set('examMarks', '৭৫');
    f.set('examinerName', 'উস্তাদ');
    const o = parseOfficeFields(f);
    expect(o.ok && o.value.feeMinor).toBe(150_000);
    const bad = new FormData(); bad.set('feeTaka', '12.5x');
    expect(parseOfficeFields(bad)).toEqual({ ok: false, error: 'fee' });
    await updateApplication(db, ACTOR, a.id, null, (o as { ok: true; value: any }).value);
    expect((await getApplication(db, a.id))?.feeMinor).toBe(150_000);
    await acceptApplication(db, ACTOR, a.id);
    const d = parseApplicationDetails(formOf({ studentName: 'অন্য নাম' }), today, DEPTS);
    await updateApplication(db, ACTOR, a.id, d.ok ? d.value : null, (o as { ok: true; value: any }).value);
    expect((await getApplication(db, a.id))?.studentName).toBe('আব্দুল্লাহ');
  });
});
