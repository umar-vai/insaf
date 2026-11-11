import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateAcademicSession, assignBatchToSession, createAcademicSession, guardianLinks,
  linkGuardian, listAcademicSessions, listPromotions, parseAcademicSession,
  parseGuardianForm, promoteEnrollment, promotionCandidates, revokeGuardian,
} from '../src/server/school-academic';
import { offlineIdsForEmail, studentPanel } from '../src/server/panels';
import { roster } from '../src/server/office';
import { adminModule } from '../src/server/staff';

const db=env.DB;
const actor='owner@example.org';
const session=(name:string)=>({name,startsOn:'2027-01-01',endsOn:'2027-12-31'});
beforeEach(async()=>{
  for(const name of ['academic_promotions','academic_guardian_links','academic_batch_sessions','offline_attendance','offline_payments','offline_charges','offline_enrollments','offline_students','offline_batches','offline_courses','academic_sessions','students','admin_events']) {
    await db.prepare(`DELETE FROM ${name}`).run();
  }
});
const seed=async()=>{
  await db.batch([
    db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('co1','Hifz',120000,12)"),
    db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('co2','Arabic',100000,12)"),
    db.prepare("INSERT INTO offline_students(id,name,phone,email) VALUES('s1','Rahim','01712345678','student@example.org')"),
    db.prepare("INSERT INTO offline_batches(id,course_id,name) VALUES('old','co1','Old Class')"),
    db.prepare("INSERT INTO offline_batches(id,course_id,name) VALUES('next','co1','New Class')"),
    db.prepare("INSERT INTO offline_batches(id,course_id,name) VALUES('wrong','co2','Other Course')"),
    db.prepare("INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,roll,start_date,fee_minor,duration_months,plan_months) VALUES('e1','s1','co1','old','7','2026-01-01',120000,12,3)"),
  ]);
};
describe('academic session validation and permission mapping',()=>{
  it('validates dates and names and keeps only one active session',async()=>{
    expect(parseAcademicSession(new FormData()).ok).toBe(false);
    const f=new FormData();f.set('name','২০২৭ শিক্ষাবর্ষ');f.set('startsOn','2027-01-01');f.set('endsOn','2027-12-31');
    expect(parseAcademicSession(f).ok).toBe(true);
    const first=await createAcademicSession(db,actor,session('Year One'));
    const second=await createAcademicSession(db,actor,session('Year Two'));
    expect(first.ok&&second.ok).toBe(true);
    if(!first.ok||!second.ok)return;
    expect((await createAcademicSession(db,actor,session('year one'))).ok).toBe(false);
    expect(await activateAcademicSession(db,actor,first.value)).toBe(true);
    expect(await activateAcademicSession(db,actor,second.value)).toBe(true);
    const all=await listAcademicSessions(db);
    expect(all.filter(s=>s.status==='active')).toHaveLength(1);
    expect(all.find(s=>s.id===first.value)?.status).toBe('archived');
    expect(all.find(s=>s.id===second.value)?.status).toBe('active');
    expect(adminModule('/admin/offline/sessions')).toBe('academic');
  });
});

describe('academic promotion does not alter fee/attendance history',()=>{
  it('checks target session, matching course, idempotency and effective panel placements',async()=>{
    await seed();
    const s=await createAcademicSession(db,actor,session('2027'));
    if(!s.ok)throw Error('no session');
    expect((await assignBatchToSession(db,actor,'next',s.value)).ok).toBe(true);
    expect((await promoteEnrollment(db,actor,'e1','wrong',s.value,'3')).ok).toBe(false);
    expect((await promoteEnrollment(db,actor,'e1','old',s.value,'3')).ok).toBe(false);
    expect((await promoteEnrollment(db,actor,'e1','next',s.value,'3')).ok).toBe(true);
    expect((await promoteEnrollment(db,actor,'e1','next',s.value,'3')).ok).toBe(false);
    expect((await listPromotions(db,s.value)).map(x=>x.toBatchName)).toEqual(['New Class']);
    expect((await promotionCandidates(db,s.value))[0]?.alreadyPromoted).toBe(1);
    // Before activation, the old batch continues to appear.
    expect((await roster(db,'old','2026-11-11')).map(r=>r.studentId)).toEqual(['s1']);
    expect((await studentPanel(db,'student@example.org','2026-11-11')).batches.map(b=>b.id)).toEqual(['old']);
    await activateAcademicSession(db,actor,s.value);
    expect((await roster(db,'old','2027-01-10')).length).toBe(0);
    expect((await roster(db,'next','2027-01-10')).map(r=>[r.studentId,r.roll])).toEqual([['s1','3']]);
    expect((await studentPanel(db,'student@example.org','2027-01-10')).batches.map(b=>b.id)).toEqual(['next']);
    const finance=await db.prepare('SELECT fee_minor AS fee,batch_id AS batchId,roll FROM offline_enrollments WHERE id=?').bind('e1').first<{fee:number;batchId:string;roll:string}>();
    expect(finance).toEqual({fee:120000,batchId:'old',roll:'7'});
    expect((await db.prepare('SELECT count(*) AS n FROM offline_payments').first<{n:number}>())!.n).toBe(0);
  });
});

describe('verified guardian account',()=>{
 it('requires explicit consent and verified Google identity; revocation is immediate',async()=>{
   await seed();
   const f=new FormData();f.set('guardianName','Amina');f.set('email','parent@example.org');f.set('relation','mother');
   expect(parseGuardianForm(f).ok).toBe(false);
   f.set('verifiedRelationship','yes');
   expect(parseGuardianForm(f).ok).toBe(true);
   const input={name:'Amina',email:'parent@example.org',relation:'mother' as const};
   expect((await linkGuardian(db,actor,'s1',input)).ok).toBe(false);
   await db.prepare("INSERT INTO students(id,email,name,google_sub) VALUES('guardian','parent@example.org','Amina','google_verified_sub')").run();
   const link=await linkGuardian(db,actor,'s1',input);
   expect(link.ok).toBe(true);
   if(!link.ok) return;
   expect((await guardianLinks(db,'s1')).filter(x=>x.status==='active')).toHaveLength(1);
   expect(await offlineIdsForEmail(db,'PARENT@EXAMPLE.ORG')).toEqual(['s1']);
   expect((await studentPanel(db,'parent@example.org','2026-11-11')).people.map(p=>p.student.id)).toEqual(['s1']);
   expect(await revokeGuardian(db,actor,'s1',link.value)).toBe(true);
   expect(await offlineIdsForEmail(db,'parent@example.org')).toEqual([]);
   expect((await guardianLinks(db,'s1'))[0]?.status).toBe('revoked');
   expect(await offlineIdsForEmail(db,'student@example.org')).toEqual(['s1']);
 });
});
