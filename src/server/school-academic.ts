import { log } from './admin';
import { isYmd } from '../lib/offline';

const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type AcademicSession = { id: string; name: string; startsOn: string; endsOn: string; status: 'planned'|'active'|'archived'; createdAt: string };
export type AcademicPlacement = { id: string; studentId: string; studentName: string; studentNo: number|null; courseTitle: string; fromBatchName: string; toBatchName: string; sessionName: string; nextRoll: string; createdAt: string };
export type GuardianLink = { id: string; studentId: string; guardianEmail: string; guardianName: string; relation: 'father'|'mother'|'guardian'|'other'; status: 'active'|'revoked'; createdAt: string };
const safeEmail = (x: string) => x.trim().toLowerCase();
export const relationBn: Record<GuardianLink['relation'], string> = { father: 'বাবা', mother: 'মা', guardian: 'অভিভাবক', other: 'অন্যান্য' };
const nameOk = (s: string, max: number) => s.length >= 2 && s.length <= max && !/[<>]/.test(s);

export function parseAcademicSession(form: FormData): Result<{ name: string; startsOn: string; endsOn: string }> {
  const name = String(form.get('name') ?? '').trim();
  const startsOn = String(form.get('startsOn') ?? '');
  const endsOn = String(form.get('endsOn') ?? '');
  if (!nameOk(name, 80)) return { ok: false, error: 'name' };
  if (!isYmd(startsOn) || !isYmd(endsOn) || startsOn > endsOn) return { ok: false, error: 'dates' };
  return { ok: true, value: { name, startsOn, endsOn } };
}

export async function listAcademicSessions(db: D1Database): Promise<AcademicSession[]> {
  const { results } = await db.prepare('SELECT id, name, starts_on AS startsOn, ends_on AS endsOn, status, created_at AS createdAt FROM academic_sessions ORDER BY starts_on DESC, name').all<AcademicSession>();
  return results;
}
export async function createAcademicSession(db: D1Database, actor: string, v: { name: string; startsOn: string; endsOn: string }): Promise<Result<string>> {
  if (!nameOk(v.name, 80) || !isYmd(v.startsOn) || !isYmd(v.endsOn) || v.startsOn > v.endsOn) return { ok: false, error: 'invalid' };
  const existing = await db.prepare('SELECT 1 FROM academic_sessions WHERE lower(name) = lower(?)').bind(v.name).first();
  if (existing) return { ok: false, error: 'duplicate' };
  const id = newId('acs');
  await db.prepare('INSERT INTO academic_sessions (id,name,starts_on,ends_on,status,created_by) VALUES (?,?,?,?,?,?)').bind(id,v.name,v.startsOn,v.endsOn,'planned',actor).run();
  await log(db,actor,'academic.session.create',`academic_session:${id}`,{ name:v.name, startsOn:v.startsOn, endsOn:v.endsOn });
  return { ok: true, value: id };
}
export async function activateAcademicSession(db: D1Database, actor: string, id: string): Promise<boolean> {
  const target = await db.prepare('SELECT id, status FROM academic_sessions WHERE id = ?').bind(id).first<{id:string;status:string}>();
  if (!target || target.status === 'archived') return false;
  if (target.status === 'active') return true;
  await db.batch([
    db.prepare("UPDATE academic_sessions SET status = 'archived' WHERE status = 'active'"),
    db.prepare("UPDATE academic_sessions SET status = 'active' WHERE id = ? AND status = 'planned'").bind(id),
  ]);
  await log(db, actor, 'academic.session.activate',`academic_session:${id}`,{ priorActiveArchived:true });
  return true;
}
export type SessionBatch = { batchId: string; sessionId: string; batchName: string; courseTitle: string; status: string };
export async function listSessionBatches(db:D1Database): Promise<SessionBatch[]> {
  const {results}=await db.prepare(`SELECT bs.batch_id AS batchId, bs.session_id AS sessionId, b.name AS batchName, c.title AS courseTitle, b.status
   FROM academic_batch_sessions bs JOIN offline_batches b ON b.id=bs.batch_id JOIN offline_courses c ON c.id=b.course_id ORDER BY c.title,b.name`).all<SessionBatch>();
  return results;
}
export async function assignBatchToSession(db:D1Database,actor:string,batchId:string,sessionId:string):Promise<Result<boolean>> {
  const info=await db.prepare(`SELECT b.id, b.status, s.status AS sessionStatus,
    (SELECT count(*) FROM academic_promotions p WHERE p.to_batch_id=b.id) AS promotions,
    (SELECT session_id FROM academic_batch_sessions x WHERE x.batch_id=b.id) AS previous
    FROM offline_batches b CROSS JOIN academic_sessions s WHERE b.id=? AND s.id=?`)
    .bind(batchId,sessionId).first<{id:string;status:string;sessionStatus:string;promotions:number;previous:string|null}>();
  if(!info||info.status!=='active'||info.sessionStatus==='archived')return{ok:false,error:'invalid'};
  if(info.previous===sessionId)return{ok:true,value:true};
  if(info.previous&&info.promotions)return{ok:false,error:'used'};
  await db.prepare(`INSERT INTO academic_batch_sessions(batch_id,session_id,added_by) VALUES(?,?,?)
    ON CONFLICT(batch_id) DO UPDATE SET session_id=excluded.session_id,added_by=excluded.added_by`).bind(batchId,sessionId,actor).run();
  await log(db,actor,'academic.batch.assign',`batch:${batchId}`,{from:info.previous,to:sessionId});
  return{ok:true,value:true};
}
export type PromotionCandidate = { enrollmentId:string; studentId:string; studentName:string; studentNo:number|null; sourceBatchId:string|null; sourceBatchName:string; courseId:string; courseTitle:string; status:string; alreadyPromoted:number };
export async function promotionCandidates(db:D1Database,toSessionId:string,limit=300):Promise<PromotionCandidate[]> {
 const {results}=await db.prepare(`SELECT e.id AS enrollmentId, e.student_id AS studentId,s.name AS studentName,s.student_no AS studentNo,
 coalesce(currentPlace.to_batch_id,e.batch_id) AS sourceBatchId,
 coalesce(bCurrent.name,b.name,'ব্যাচ নেই') AS sourceBatchName,e.course_id AS courseId,
 c.title AS courseTitle,e.status,EXISTS(SELECT 1 FROM academic_promotions p WHERE p.enrollment_id=e.id AND p.to_session_id=?1) AS alreadyPromoted
 FROM offline_enrollments e JOIN offline_students s ON s.id=e.student_id JOIN offline_courses c ON c.id=e.course_id
 LEFT JOIN offline_batches b ON b.id=e.batch_id
 LEFT JOIN academic_promotions currentPlace ON currentPlace.enrollment_id=e.id AND currentPlace.to_session_id =
   (SELECT id FROM academic_sessions WHERE status='active' LIMIT 1)
 LEFT JOIN offline_batches bCurrent ON bCurrent.id=currentPlace.to_batch_id
 WHERE e.status='active' AND s.status='active' ORDER BY s.student_no,e.start_date DESC LIMIT ?2`)
 .bind(toSessionId,Math.max(1,Math.min(1000,limit))).all<PromotionCandidate>();
 return results;
}
export async function listPromotions(db:D1Database,sessionId:string):Promise<AcademicPlacement[]> {
 const {results}=await db.prepare(`SELECT p.id,p.student_id AS studentId,s.name AS studentName,s.student_no AS studentNo,
 c.title AS courseTitle,coalesce(bf.name,'ব্যাচ নেই') AS fromBatchName,bt.name AS toBatchName,
 se.name AS sessionName,p.next_roll AS nextRoll,p.created_at AS createdAt
 FROM academic_promotions p JOIN offline_students s ON s.id=p.student_id
 JOIN offline_enrollments e ON e.id=p.enrollment_id JOIN offline_courses c ON c.id=e.course_id
 LEFT JOIN offline_batches bf ON bf.id=p.from_batch_id JOIN offline_batches bt ON bt.id=p.to_batch_id
 JOIN academic_sessions se ON se.id=p.to_session_id WHERE p.to_session_id=? ORDER BY p.created_at DESC LIMIT 300`)
 .bind(sessionId).all<AcademicPlacement>();return results;
}
/** Promotion writes only an academic placement. The original enrollment, fees, payments,
 * discounts, installments and historic attendance remain unchanged.
 */
export async function promoteEnrollment(db:D1Database,actor:string,enrollmentId:string,toBatchId:string,toSessionId:string,nextRoll:string):Promise<Result<string>> {
 const roll=nextRoll.trim();
 if(roll.length>20||!/^[-\w\u0980-\u09ff ]*$/.test(roll))return{ok:false,error:'roll'};
 const row=await db.prepare(`SELECT e.student_id AS studentId,e.course_id AS courseId,
 coalesce(currentPlace.to_batch_id,e.batch_id) AS fromBatchId,e.status AS enrollmentStatus,
 s.status AS studentStatus,b.course_id AS targetCourse,b.status AS targetStatus,
 bs.session_id AS targetSession,ss.status AS sessionStatus,
 (SELECT count(*) FROM academic_promotions p WHERE p.enrollment_id=e.id AND p.to_session_id=?3) AS duplicate
 FROM offline_enrollments e JOIN offline_students s ON s.id=e.student_id
 LEFT JOIN academic_promotions currentPlace ON currentPlace.enrollment_id=e.id AND currentPlace.to_session_id=
   (SELECT id FROM academic_sessions WHERE status='active' LIMIT 1)
 JOIN offline_batches b ON b.id=?2 LEFT JOIN academic_batch_sessions bs ON bs.batch_id=b.id
 LEFT JOIN academic_sessions ss ON ss.id=bs.session_id WHERE e.id=?1`)
 .bind(enrollmentId,toBatchId,toSessionId).first<{studentId:string;courseId:string;fromBatchId:string|null;enrollmentStatus:string;studentStatus:string;targetCourse:string;targetStatus:string;targetSession:string|null;sessionStatus:string|null;duplicate:number}>();
 if(!row||row.enrollmentStatus!=='active'||row.studentStatus!=='active'||row.courseId!==row.targetCourse||row.targetStatus!=='active'||row.targetSession!==toSessionId||row.sessionStatus!=='planned'||row.fromBatchId===toBatchId) return{ok:false,error:'ineligible'};
 if(row.duplicate) return{ok:false,error:'already'};
 const id=newId('acp');
 // The unique(enrollment_id,to_session_id) constraint also prevents duplicate concurrent promotions.
 try {await db.prepare(`INSERT INTO academic_promotions(id,enrollment_id,student_id,from_batch_id,to_batch_id,to_session_id,next_roll,created_by)
 VALUES(?,?,?,?,?,?,?,?)`).bind(id,enrollmentId,row.studentId,row.fromBatchId,toBatchId,toSessionId,roll,actor).run();}
 catch{return{ok:false,error:'already'};}
 await log(db,actor,'academic.promotion.create',`offline_student:${row.studentId}`,{ enrollmentId,from:row.fromBatchId,to:toBatchId,session:toSessionId,roll });
 return{ok:true,value:id};
}
export function parseGuardianForm(form:FormData):Result<{ email:string;name:string;relation:GuardianLink['relation'] }> {
 const email=safeEmail(String(form.get('email')??''));
 const name=String(form.get('guardianName')??'').trim();
 const relation=String(form.get('relation')??'');
 if(!/^[^\s@<>"',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(email))return{ok:false,error:'email'};
 if(!nameOk(name,120))return{ok:false,error:'name'};
 if(!['father','mother','guardian','other'].includes(relation))return{ok:false,error:'relation'};
 if(form.get('verifiedRelationship')!=='yes')return{ok:false,error:'consent'};
 return{ok:true,value:{email,name,relation:relation as GuardianLink['relation']}};
}
export async function guardianLinks(db:D1Database,studentId:string):Promise<GuardianLink[]>{
 const {results}=await db.prepare(`SELECT id,student_id AS studentId,guardian_email AS guardianEmail,guardian_name AS guardianName,relation,status,created_at AS createdAt
 FROM academic_guardian_links WHERE student_id=? ORDER BY created_at DESC`).bind(studentId).all<GuardianLink>();return results;
}
export async function linkGuardian(db:D1Database,actor:string,studentId:string,input:{email:string;name:string;relation:GuardianLink['relation']}):Promise<Result<string>>{
 const email=safeEmail(input.email);
 if(!/^[^\s@<>"',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(email)||!nameOk(input.name,120)||!Object.hasOwn(relationBn,input.relation))return{ok:false,error:'invalid'};
 const student=await db.prepare("SELECT 1 FROM offline_students WHERE id=? AND status='active'").bind(studentId).first();
 // Only a signed-in, Google-verified account can be given a new guardian relationship.
 const verified=await db.prepare("SELECT 1 FROM students WHERE lower(email)=? AND google_sub IS NOT NULL").bind(email).first();
 if(!student||!verified)return{ok:false,error:'not_verified'};
 const current=await db.prepare('SELECT id,status FROM academic_guardian_links WHERE student_id=? AND lower(guardian_email)=?')
 .bind(studentId,email).first<{id:string;status:string}>();
 if(current?.status==='active')return{ok:false,error:'duplicate'};
 const id=current?.id??newId('acg');
 if(current)await db.prepare("UPDATE academic_guardian_links SET status='active', guardian_name=?,relation=?,revoked_by=NULL,revoked_at=NULL WHERE id=?").bind(input.name,input.relation,id).run();
 else await db.prepare("INSERT INTO academic_guardian_links (id,student_id,guardian_email,guardian_name,relation,status,created_by) VALUES(?,?,?,?,?,'active',?)")
 .bind(id,studentId,email,input.name,input.relation,actor).run();
 await log(db,actor,'academic.guardian.link',`offline_student:${studentId}`,{guardianEmail:email,relation:input.relation});
 return{ok:true,value:id};
}
export async function revokeGuardian(db:D1Database,actor:string,studentId:string,id:string):Promise<boolean>{
 const r=await db.prepare("UPDATE academic_guardian_links SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoked_by=? WHERE id=? AND student_id=? AND status='active'")
 .bind(actor,id,studentId).run();
 if(!r.meta.changes)return false;
 await log(db,actor,'academic.guardian.revoke',`offline_student:${studentId}`,{guardianLinkId:id});
 return true;
}
