import { log } from './admin';
import { roster } from './office';
import { isYmd } from '../lib/offline';
import { offlineIdsForEmail } from './panels';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): Result<never> => ({ ok: false, error });
const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g,'').slice(0,16)}`;
const trim = (x: unknown, n = 150) => String(x ?? '').trim().slice(0,n);
const int = (v: unknown): number | null => {
  const normalized=String(v??'').replace(/[০-৯]/g,c=>String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
  return /^\d{1,4}$/.test(normalized) ? Number(normalized) : null;
};
const currentBatchSQL = `coalesce((SELECT p.to_batch_id FROM academic_promotions p
 JOIN academic_sessions s ON s.id=p.to_session_id AND s.status='active'
 WHERE p.enrollment_id=e.id LIMIT 1),e.batch_id)`;
export type ExamAssessment = { examId:string; batchId:string; batchName:string; title:string; subject:string; examDate:string;
 examStatus:string; maxMarks:number|null; passMarks:number|null; status:'draft'|'published'|null; examinees:number; completed:number; publishedAt:string|null };
export type ExamMarkRow = { examId:string; enrollmentId:string; studentId:string; studentName:string; studentNo:number|null; roll:string; attendance:'present'|'absent'|null; obtained:number|null; comment:string|null };
export type PublishedResult = { examId:string; title:string; subject:string; examDate:string; batchName:string; studentName:string; studentNo:number|null; obtained:number|null; attendance:'present'|'absent'; maxMarks:number; passMarks:number; comment:string; publishedAt:string };
export const percentScore=(score:number,max:number)=>max?Math.round(score*100/max):0;
export const resultLabel=(score:number|null,pass:number,attendance:string)=>attendance==='absent'?'অনুপস্থিত':score===null?'অপ্রকাশিত':score>=pass?'উত্তীর্ণ':'অনুত্তীর্ণ';

export async function examAssessment(db:D1Database,examId:string):Promise<ExamAssessment|null>{
 return db.prepare(`SELECT x.id AS examId,x.batch_id AS batchId,b.name AS batchName,x.title,x.subject,x.exam_date AS examDate,
 x.status AS examStatus,p.max_marks AS maxMarks,p.pass_marks AS passMarks,p.status,p.published_at AS publishedAt,
 (SELECT count(*) FROM assessment_examinees ee WHERE ee.exam_id=x.id) AS examinees,
 (SELECT count(*) FROM assessment_marks m WHERE m.exam_id=x.id) AS completed
 FROM offline_exams x JOIN offline_batches b ON b.id=x.batch_id LEFT JOIN assessment_policies p ON p.exam_id=x.id WHERE x.id=?`)
 .bind(examId).first<ExamAssessment>();
}
export async function listBatchAssessments(db:D1Database,batchId:string):Promise<ExamAssessment[]>{
 const {results}=await db.prepare(`SELECT x.id AS examId,x.batch_id AS batchId,b.name AS batchName,x.title,x.subject,x.exam_date AS examDate,
 x.status AS examStatus,p.max_marks AS maxMarks,p.pass_marks AS passMarks,p.status,p.published_at AS publishedAt,
 (SELECT count(*) FROM assessment_examinees ee WHERE ee.exam_id=x.id) AS examinees,
 (SELECT count(*) FROM assessment_marks m WHERE m.exam_id=x.id) AS completed
 FROM offline_exams x JOIN offline_batches b ON b.id=x.batch_id
 LEFT JOIN assessment_policies p ON p.exam_id=x.id WHERE x.batch_id=? ORDER BY x.exam_date DESC LIMIT 100`)
 .bind(batchId).all<ExamAssessment>();return results;
}
export async function configureAssessment(db:D1Database,actor:string,examId:string,maxInput:unknown,passInput:unknown,confirm:boolean):Promise<Result<number>>{
 const max=int(maxInput),pass=int(passInput);
 if(!max||max>1000||pass===null||pass>max)return fail('marks');
 if(!confirm)return fail('confirm');
 const x=await examAssessment(db,examId);
 if(!x||x.examStatus!=='scheduled'||x.status==='published')return fail('exam');
 if(x.status)return fail('already_configured');
 // Save the list at configuration time, explicitly shown to staff for review before marks.
 const rows=await roster(db,x.batchId,x.examDate);
 const ids=[...new Set(rows.filter(r=>r.studentId).map(r=>r.enrollmentId))];
 if(!ids.length)return fail('empty_roster');
 if(ids.length>1000)return fail('roster_too_large');
 const statements=[
   db.prepare(`INSERT INTO assessment_policies(exam_id,max_marks,pass_marks,status,updated_by) VALUES(?,?,?,'draft',?)
    ON CONFLICT(exam_id) DO UPDATE SET max_marks=excluded.max_marks,pass_marks=excluded.pass_marks,updated_by=excluded.updated_by
    WHERE assessment_policies.status='draft'`).bind(examId,max,pass,actor),
   ...ids.map(id=>db.prepare(`INSERT INTO assessment_examinees(exam_id,enrollment_id,captured_by) VALUES(?,?,?)
      ON CONFLICT(exam_id,enrollment_id) DO NOTHING`).bind(examId,id,actor)),
 ];
 await db.batch(statements);
 await log(db,actor,'assessment.configure',`exam:${examId}`,{max,pass,participants:ids.length});
 return {ok:true,value:ids.length};
}
export async function examMarks(db:D1Database,examId:string):Promise<ExamMarkRow[]>{
 const {results}=await db.prepare(`SELECT ee.exam_id AS examId,ee.enrollment_id AS enrollmentId,
 e.student_id AS studentId,s.name AS studentName,s.student_no AS studentNo,
 coalesce(nullif(p.next_roll,''),e.roll) AS roll,m.attendance,m.obtained,m.comment
 FROM assessment_examinees ee JOIN offline_enrollments e ON e.id=ee.enrollment_id
 JOIN offline_students s ON s.id=e.student_id
 LEFT JOIN academic_promotions p ON p.enrollment_id=e.id AND p.to_session_id=
  (SELECT id FROM academic_sessions WHERE status='active' LIMIT 1)
 LEFT JOIN assessment_marks m ON m.exam_id=ee.exam_id AND m.enrollment_id=ee.enrollment_id
 WHERE ee.exam_id=? ORDER BY s.student_no,s.name LIMIT 1000`)
 .bind(examId).all<ExamMarkRow>();return results;
}
export async function recordExamMark(db:D1Database,actor:string,examId:string,enrollmentId:string,obtainedInput:unknown,absent:boolean,commentInput:unknown):Promise<Result<boolean>>{
 const grade=absent?null:int(obtainedInput);
 const note=trim(commentInput,500);
 const exam=await examAssessment(db,examId);
 if(!exam||exam.examStatus!=='scheduled'||exam.status!=='draft'||!exam.maxMarks)return fail('locked');
 if((!absent&&(grade===null||grade>exam.maxMarks))||(!enrollmentId))return fail('marks');
 // One conditional statement avoids an edit sneaking in after results have been published.
 const updated=await db.prepare(`INSERT INTO assessment_marks(exam_id,enrollment_id,obtained,attendance,comment,marked_by)
 SELECT ee.exam_id,ee.enrollment_id,?, ?, ?, ? FROM assessment_examinees ee
 JOIN assessment_policies p ON p.exam_id=ee.exam_id
 JOIN offline_exams x ON x.id=ee.exam_id AND x.status='scheduled'
 WHERE ee.exam_id=? AND ee.enrollment_id=? AND p.status='draft'
 ON CONFLICT(exam_id,enrollment_id) DO UPDATE SET obtained=excluded.obtained,
 attendance=excluded.attendance,comment=excluded.comment,marked_by=excluded.marked_by,
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE EXISTS(SELECT 1 FROM assessment_policies p WHERE p.exam_id=excluded.exam_id AND p.status='draft')`)
 .bind(grade,absent?'absent':'present',note,actor,examId,enrollmentId).run();
 if(!updated.meta.changes)return fail('not_eligible');
 await log(db,actor,'assessment.mark',`exam:${examId}`,{enrollmentId,absent,obtained:grade});
 return {ok:true,value:true};
}
export async function publishAssessment(db:D1Database,actor:string,examId:string):Promise<Result<boolean>>{
 const out=await db.prepare(`UPDATE assessment_policies SET status='published',published_by=?,
 published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=?
 WHERE exam_id=? AND status='draft'
 AND EXISTS(SELECT 1 FROM assessment_examinees e WHERE e.exam_id=assessment_policies.exam_id)
 AND NOT EXISTS(SELECT 1 FROM assessment_examinees e LEFT JOIN assessment_marks m ON m.exam_id=e.exam_id AND m.enrollment_id=e.enrollment_id
  WHERE e.exam_id=assessment_policies.exam_id AND m.enrollment_id IS NULL)
 AND EXISTS(SELECT 1 FROM offline_exams x WHERE x.id=assessment_policies.exam_id AND x.status='scheduled')`)
 .bind(actor,actor,examId).run();
 if(!out.meta.changes)return fail('incomplete');
 await log(db,actor,'assessment.publish',`exam:${examId}`,{published:true});
 return {ok:true,value:true};
}
export async function publishedResultsForEmail(db:D1Database,email:string):Promise<PublishedResult[]>{
 const ids=await offlineIdsForEmail(db,email);
 if(!ids.length)return [];
 const out:PublishedResult[]=[];
 for(let i=0;i<ids.length;i+=80){
  const chunk=ids.slice(i,i+80);
  const {results}=await db.prepare(`SELECT x.id AS examId,x.title,x.subject,x.exam_date AS examDate,
    b.name AS batchName,s.name AS studentName,s.student_no AS studentNo,
    m.obtained,m.attendance,p.max_marks AS maxMarks,p.pass_marks AS passMarks,
    m.comment,p.published_at AS publishedAt FROM assessment_marks m
    JOIN assessment_policies p ON p.exam_id=m.exam_id AND p.status='published'
    JOIN offline_exams x ON x.id=p.exam_id AND x.status='scheduled'
    JOIN offline_batches b ON b.id=x.batch_id
    JOIN offline_enrollments e ON e.id=m.enrollment_id
    JOIN offline_students s ON s.id=e.student_id
    WHERE s.status='active' AND s.id IN (${chunk.map(()=>'?').join(',')})
    ORDER BY x.exam_date DESC,x.title LIMIT 200`).bind(...chunk).all<PublishedResult>();
  out.push(...results);
 }
 return out.slice(0,500);
}
export async function teacherOwnsBatch(db:D1Database,teacherId:string,batchId:string):Promise<boolean>{
 return Boolean(await db.prepare(`SELECT 1 FROM offline_batches b WHERE b.id=? AND b.status='active' AND
 (b.teacher_id=? OR EXISTS(SELECT 1 FROM batch_teachers bt WHERE bt.batch_id=b.id AND bt.teacher_id=?))`)
 .bind(batchId,teacherId,teacherId).first());
}
export type Assignment={id:string;batchId:string;batchName:string;title:string;details:string;kind:'homework'|'lesson';
 dueOn:string;status:'draft'|'published'|'closed';createdBy:string;createdAt:string; submissions:number;reviewed:number};
export type HomeworkSubmission={assignmentId:string;enrollmentId:string;studentId:string;studentName:string;studentNo:number|null;
 body:string;state:'submitted'|'reviewed';score:number|null;feedback:string;submittedAt:string;reviewedAt:string|null};
export type MyHomework=Assignment & {enrollmentId:string;studentName:string;studentId:string;body:string|null;
 submissionState:'submitted'|'reviewed'|null;score:number|null;feedback:string|null;submittedAt:string|null};
const ASSIGNMENT_SELECT=`SELECT a.id,a.batch_id AS batchId,b.name AS batchName,a.title,a.details,a.kind,a.due_on AS dueOn,a.status,
 a.created_by AS createdBy,a.created_at AS createdAt,
 (SELECT count(*) FROM homework_submissions z WHERE z.assignment_id=a.id) AS submissions,
 (SELECT count(*) FROM homework_submissions z WHERE z.assignment_id=a.id AND z.state='reviewed') AS reviewed
 FROM homework_assignments a JOIN offline_batches b ON b.id=a.batch_id`;
export async function assignmentsForBatch(db:D1Database,batchId:string,all:boolean):Promise<Assignment[]>{
 const {results}=await db.prepare(`${ASSIGNMENT_SELECT} WHERE a.batch_id=? ${all?'':"AND a.status='published'"} ORDER BY a.due_on DESC,a.created_at DESC LIMIT 100`)
 .bind(batchId).all<Assignment>();return results;
}
export const homeworkKindBn=(kind:Assignment['kind'])=>kind==='lesson'?'পাঠ পরিকল্পনা':'হোমওয়ার্ক';
export async function createAssignment(db:D1Database,actor:string,batchId:string,input:{title:string;details:string;dueOn:string;kind:'homework'|'lesson'}):Promise<Result<string>>{
 const title=trim(input.title,160),details=trim(input.details,4000);
 if(title.length<2||!isYmd(input.dueOn)||!['homework','lesson'].includes(input.kind)||!batchId)return fail('invalid');
 const b=await db.prepare("SELECT 1 FROM offline_batches WHERE id=? AND status='active'").bind(batchId).first();
 if(!b)return fail('batch');
 const id=newId('hwa');
 await db.prepare(`INSERT INTO homework_assignments(id,batch_id,title,details,kind,due_on,status,created_by) VALUES(?,?,?,?,?,?,'draft',?)`)
 .bind(id,batchId,title,details,input.kind,input.dueOn,actor).run();
 await log(db,actor,'homework.create',`assignment:${id}`,{batchId,kind:input.kind,dueOn:input.dueOn});
 return {ok:true,value:id};
}
export async function publishAssignment(db:D1Database,actor:string,id:string,batchId:string):Promise<Result<boolean>>{
 const r=await db.prepare(`UPDATE homework_assignments SET status='published',published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id=? AND batch_id=? AND status='draft'`).bind(id,batchId).run();
 if(!r.meta.changes)return fail('locked');
 await log(db,actor,'homework.publish',`assignment:${id}`,{batchId});return{ok:true,value:true};
}
export async function closeAssignment(db:D1Database,actor:string,id:string,batchId:string):Promise<Result<boolean>>{
 const r=await db.prepare("UPDATE homework_assignments SET status='closed' WHERE id=? AND batch_id=? AND status='published'").bind(id,batchId).run();
 if(!r.meta.changes)return fail('locked');
 await log(db,actor,'homework.close',`assignment:${id}`,{batchId});return{ok:true,value:true};
}
export async function assignmentSubmissions(db:D1Database,id:string,batchId:string):Promise<HomeworkSubmission[]>{
 const {results}=await db.prepare(`SELECT z.assignment_id AS assignmentId,z.enrollment_id AS enrollmentId,e.student_id AS studentId,
 s.name AS studentName,s.student_no AS studentNo,z.body,z.state,z.score,z.feedback,z.submitted_at AS submittedAt,
 z.reviewed_at AS reviewedAt FROM homework_submissions z JOIN homework_assignments a ON a.id=z.assignment_id
 JOIN offline_enrollments e ON e.id=z.enrollment_id JOIN offline_students s ON s.id=e.student_id
 WHERE z.assignment_id=? AND a.batch_id=? ORDER BY z.submitted_at DESC LIMIT 400`).bind(id,batchId).all<HomeworkSubmission>();
 return results;
}
export async function homeworkForEmail(db:D1Database,email:string):Promise<MyHomework[]>{
 const ids=await offlineIdsForEmail(db,email);if(!ids.length)return [];
 const rows:MyHomework[]=[];
 for(let i=0;i<ids.length;i+=80){
  const chunk=ids.slice(i,i+80);
  const {results}=await db.prepare(`SELECT a.id,a.batch_id AS batchId,b.name AS batchName,a.title,a.details,a.kind,a.due_on AS dueOn,
    a.status,a.created_by AS createdBy,a.created_at AS createdAt,0 AS submissions,0 AS reviewed,
    e.id AS enrollmentId,e.student_id AS studentId,s.name AS studentName,
    z.body,z.state AS submissionState,z.score,z.feedback,z.submitted_at AS submittedAt
   FROM homework_assignments a JOIN offline_batches b ON b.id=a.batch_id
   JOIN offline_enrollments e ON ${currentBatchSQL}=a.batch_id AND e.status='active'
   JOIN offline_students s ON s.id=e.student_id AND s.status='active'
   LEFT JOIN homework_submissions z ON z.assignment_id=a.id AND z.enrollment_id=e.id
   WHERE s.id IN (${chunk.map(()=>'?').join(',')}) AND a.status IN ('published','closed')
   ORDER BY a.due_on DESC,a.created_at DESC LIMIT 250`).bind(...chunk).all<MyHomework>();
  rows.push(...results);
 }
 return rows.slice(0,500);
}
export async function submitHomework(db:D1Database,actorEmail:string,assignmentId:string,enrollmentId:string,answer:unknown,today:string):Promise<Result<boolean>>{
 const body=trim(answer,5000);
 if(body.length<2||!isYmd(today))return fail('answer');
 const email=actorEmail.trim().toLowerCase();
 const r=await db.prepare(`INSERT INTO homework_submissions(assignment_id,enrollment_id,body,submitted_by)
 SELECT a.id,e.id,?,? FROM homework_assignments a JOIN offline_enrollments e ON ${currentBatchSQL}=a.batch_id
 JOIN offline_students s ON s.id=e.student_id
 WHERE a.id=? AND e.id=? AND a.status='published' AND a.kind='homework'
 AND a.due_on>=? AND s.status='active' AND e.status='active' AND lower(s.email)=?
 ON CONFLICT(assignment_id,enrollment_id) DO UPDATE SET body=excluded.body,
 submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),submitted_by=excluded.submitted_by
 WHERE homework_submissions.state='submitted'
 AND EXISTS(SELECT 1 FROM homework_assignments a WHERE a.id=excluded.assignment_id AND a.status='published' AND a.due_on>=?)`)
 .bind(body,email,assignmentId,enrollmentId,today,email,today).run();
 if(!r.meta.changes)return fail('not_allowed');
 await log(db,email,'homework.submit',`assignment:${assignmentId}`,{enrollmentId});
 return{ok:true,value:true};
}
export async function reviewHomework(db:D1Database,actor:string,assignmentId:string,enrollmentId:string,feedbackInput:unknown,scoreInput:unknown):Promise<Result<boolean>>{
 const feedback=trim(feedbackInput,1200);
 const score=String(scoreInput??'').trim()===''?null:int(scoreInput);
 if(score!==null&&score>100)return fail('score');
 if(!feedback&&score===null)return fail('feedback');
 const r=await db.prepare(`UPDATE homework_submissions SET state='reviewed',feedback=?,score=?,reviewed_by=?,
 reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE assignment_id=? AND enrollment_id=? AND state='submitted'
 AND EXISTS(SELECT 1 FROM homework_assignments a WHERE a.id=? AND a.status IN ('published','closed'))`)
 .bind(feedback,score,actor,assignmentId,enrollmentId,assignmentId).run();
 if(!r.meta.changes)return fail('locked');
 await log(db,actor,'homework.review',`assignment:${assignmentId}`,{enrollmentId,score});
 return{ok:true,value:true};
}
