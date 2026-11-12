import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
 examAssessment, configureAssessment, examMarks, recordExamMark, publishAssessment,
 publishedResultsForEmail, saveExamMarks, markInputsFromForm, listAssessments,
 assignmentsForBatch, createAssignment, publishAssignment, closeAssignment,
 homeworkForEmail, submitHomework, assignmentSubmissions, reviewHomework, percentScore, resultLabel,
} from '../src/server/assessment';
import { cancelExam } from '../src/server/academic';
import { adminModule } from '../src/server/staff';
import { linkGuardian } from '../src/server/school-academic';
import { batchForTeacher } from '../src/server/panels';

const db=env.DB;
const actor='staff@example.org';
beforeEach(async()=>{
 for(const name of ['assessment_marks','assessment_examinees','assessment_policies',
   'homework_submissions','homework_assignments','academic_guardian_links',
   'academic_promotions','academic_batch_sessions','offline_charges','offline_payments',
   'offline_attendance','offline_exams','offline_enrollments','offline_batches',
   'offline_students','teachers','offline_courses','academic_sessions','students','admin_events']) {
   await db.prepare(`DELETE FROM ${name}`).run();
 }
});
async function seed(){
 await db.batch([
  db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('c1','Hifz',120000,12)"),
  db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('c2','Arabic',120000,12)"),
  db.prepare("INSERT INTO teachers(id,name,phone,email) VALUES('t1','Ustad','01711111111','teacher@example.org')"),
  db.prepare("INSERT INTO teachers(id,name,phone,email) VALUES('t2','Other','01722222222','other@example.org')"),
  db.prepare("INSERT INTO offline_batches(id,course_id,name,teacher_id) VALUES('b1','c1','First Batch','t1')"),
  db.prepare("INSERT INTO offline_batches(id,course_id,name,teacher_id) VALUES('b2','c2','Other Batch','t2')"),
  db.prepare("INSERT INTO offline_students(id,name,phone,email) VALUES('s1','Rahim','01711111111','rahim@example.org')"),
  db.prepare("INSERT INTO offline_students(id,name,phone,email) VALUES('s2','Karim','01722222222','karim@example.org')"),
  db.prepare("INSERT INTO offline_students(id,name,phone,email) VALUES('s3','Other','01733333333','otherchild@example.org')"),
  db.prepare("INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,roll,start_date,fee_minor,duration_months,plan_months) VALUES('e1','s1','c1','b1','1','2026-01-01',120000,12,3)"),
  db.prepare("INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,roll,start_date,fee_minor,duration_months,plan_months) VALUES('e2','s2','c1','b1','2','2026-01-01',120000,12,3)"),
  db.prepare("INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,roll,start_date,fee_minor,duration_months,plan_months) VALUES('e3','s3','c2','b2','3','2026-01-01',120000,12,3)"),
  db.prepare("INSERT INTO offline_exams(id,batch_id,title,subject,exam_date,created_by) VALUES('ex1','b1','Year Exam','Quran','2026-11-13','admin@example.org')"),
 ]);
}
describe('secure exam gradebook',()=>{
 it('prevents unconfigured/public reads and freezes roster + publishing until every mark',async()=>{
  await seed();
  expect((await examAssessment(db,'ex1'))?.status).toBeNull();
  expect(await publishedResultsForEmail(db,'rahim@example.org')).toEqual([]);
  expect((await configureAssessment(db,actor,'ex1','100','40',false)).ok).toBe(false);
  expect((await configureAssessment(db,actor,'ex1','10','80',true)).ok).toBe(false);
  expect((await configureAssessment(db,actor,'ex1','100','40',true)).ok).toBe(true);
  expect((await examMarks(db,'ex1')).map(r=>r.enrollmentId)).toEqual(['e1','e2']);
  expect((await recordExamMark(db,actor,'ex1','e3','88',false,'')).ok).toBe(false);
  expect((await recordExamMark(db,actor,'ex1','e1','101',false,'')).ok).toBe(false);
  expect((await recordExamMark(db,actor,'ex1','e1','92',false,'Excellent')).ok).toBe(true);
  expect((await publishAssessment(db,actor,'ex1')).ok).toBe(false);
  expect((await recordExamMark(db,actor,'ex1','e2','',true,'Absent')).ok).toBe(true);
  expect((await publishAssessment(db,actor,'ex1')).ok).toBe(true);
  expect((await recordExamMark(db,actor,'ex1','e1','12',false,'changed')).ok).toBe(false);
  expect((await configureAssessment(db,actor,'ex1','200','50',true)).ok).toBe(false);
  expect(await cancelExam(db,actor,'ex1')).toBe(false);
  const results=await publishedResultsForEmail(db,'rahim@example.org');
  expect(results).toHaveLength(1);
  expect(results[0]?.obtained).toBe(92);
  expect(results[0]?.maxMarks).toBe(100);
  expect((await publishedResultsForEmail(db,'karim@example.org'))[0]?.attendance).toBe('absent');
  expect(await publishedResultsForEmail(db,'otherchild@example.org')).toEqual([]);
  expect(percentScore(92,100)).toBe(92);
  expect(resultLabel(92,40,'present')).toBe('উত্তীর্ণ');
  expect(adminModule('/admin/offline/gradebook/ex1')).toBe('academic');
  expect(adminModule('/admin/offline/results')).toBe('academic');
 });
 it('teacher scope follows assignment, not arbitrary exam ID',async()=>{
   await seed();
   expect(await batchForTeacher(db,'t1','b1')).not.toBeNull();
   expect(await batchForTeacher(db,'t1','b2')).toBeNull();
   expect(await batchForTeacher(db,'t2','b1')).toBeNull();
 });
 it('saves a whole mark sheet at once, all or nothing, and skips blanks',async()=>{
   await seed();
   expect((await saveExamMarks(db,actor,'ex1',[])).ok).toBe(false); // not configured yet
   await configureAssessment(db,actor,'ex1','50','20',true);
   expect((await listAssessments(db,{pending:true})).map(x=>x.examId)).toEqual(['ex1']);
   const form=new FormData();
   form.append('enrollmentId','e1');form.append('obtained_e1','৪৫');form.append('comment_e1','ভালো');
   form.append('enrollmentId','e2');form.append('obtained_e2','');
   form.append('enrollmentId','e3');form.append('obtained_e3','10'); // other batch, not an examinee
   const saved=await saveExamMarks(db,actor,'ex1',markInputsFromForm(form));
   expect(saved).toEqual({ok:true,value:1});
   let rows=await examMarks(db,'ex1');
   expect(rows.map(r=>[r.enrollmentId,r.obtained,r.attendance])).toEqual([['e1',45,'present'],['e2',null,null]]);
   // One bad row means nothing is written.
   expect((await saveExamMarks(db,actor,'ex1',[
     {enrollmentId:'e1',obtained:'30',absent:false,comment:''},
     {enrollmentId:'e2',obtained:'51',absent:false,comment:''},
   ])).ok).toBe(false);
   rows=await examMarks(db,'ex1');
   expect(rows[0]?.obtained).toBe(45);
   // Unchanged rows are not rewritten; absent wins over a typed number.
   expect(await saveExamMarks(db,actor,'ex1',[
     {enrollmentId:'e1',obtained:'45',absent:false,comment:'ভালো'},
     {enrollmentId:'e2',obtained:'12',absent:true,comment:''},
   ])).toEqual({ok:true,value:1});
   expect((await examMarks(db,'ex1'))[1]?.attendance).toBe('absent');
   expect((await publishAssessment(db,actor,'ex1')).ok).toBe(true);
   expect((await listAssessments(db,{pending:true}))).toEqual([]);
   expect((await saveExamMarks(db,actor,'ex1',[{enrollmentId:'e1',obtained:'1',absent:false,comment:''}])).ok).toBe(false);
   const log=await db.prepare("SELECT count(*) AS n FROM admin_events WHERE action='assessment.marks'").first<{n:number}>();
   expect(log?.n).toBe(2);
 });
 it('a cancelled exam cannot be set up and draft marks never reach students',async()=>{
   await seed();
   await configureAssessment(db,actor,'ex1','100','33',true);
   await recordExamMark(db,actor,'ex1','e1','70',false,'');
   expect(await publishedResultsForEmail(db,'rahim@example.org')).toEqual([]);
   expect(await cancelExam(db,actor,'ex1')).toBe(true);
   expect((await recordExamMark(db,actor,'ex1','e2','10',false,'')).ok).toBe(false);
   expect((await publishAssessment(db,actor,'ex1')).ok).toBe(false);
   await db.prepare("INSERT INTO offline_exams(id,batch_id,title,subject,exam_date,status,created_by) VALUES('ex2','b1','Old','Quran','2026-10-01','cancelled','a')").run();
   expect((await configureAssessment(db,actor,'ex2','100','33',true)).ok).toBe(false);
 });
});
describe('homework and guardian separation',()=>{
 it('prevents unlinked, unverified, cross-batch and late submissions; allows teacher feedback',async()=>{
   await seed();
   const newHw=await createAssignment(db,actor,'b1',{title:'Recite Surah',details:'Read and explain',dueOn:'2026-11-30',kind:'homework'});
   expect(newHw.ok).toBe(true);
   if(!newHw.ok)return;
   const h=newHw.value;
   expect((await homeworkForEmail(db,'rahim@example.org')).length).toBe(0);
   expect((await submitHomework(db,'rahim@example.org',h,'e1','My answer','2026-11-12')).ok).toBe(false);
   expect((await publishAssignment(db,actor,h,'b1')).ok).toBe(true);
   expect((await homeworkForEmail(db,'rahim@example.org')).map(a=>a.title)).toEqual(['Recite Surah']);
   expect((await submitHomework(db,'karim@example.org',h,'e1','Stolen','2026-11-12')).ok).toBe(false);
   expect((await submitHomework(db,'rahim@example.org',h,'e3','Stolen','2026-11-12')).ok).toBe(false);
   expect((await submitHomework(db,'rahim@example.org',h,'e1','Too late','2026-12-01')).ok).toBe(false);
   expect((await submitHomework(db,'rahim@example.org',h,'e1','My answer','2026-11-12')).ok).toBe(true);
   expect((await submitHomework(db,'rahim@example.org',h,'e1','Edited answer','2026-11-12')).ok).toBe(true);
   expect((await assignmentSubmissions(db,h,'b1')).map(s=>s.body)).toEqual(['Edited answer']);
   expect((await reviewHomework(db,actor,h,'e1','Good job',89)).ok).toBe(true);
   expect((await reviewHomework(db,actor,h,'e1','Revised',90)).ok).toBe(false);
   expect((await homeworkForEmail(db,'rahim@example.org'))[0]?.score).toBe(89);
   expect((await submitHomework(db,'rahim@example.org',h,'e1','Overwrite feedback','2026-11-12')).ok).toBe(false);
   expect((await closeAssignment(db,actor,h,'b1')).ok).toBe(true);
   expect((await submitHomework(db,'karim@example.org',h,'e2','closed','2026-11-12')).ok).toBe(false);
   await db.prepare("INSERT INTO students(id,email,google_sub) VALUES('parent','parent@example.org','google-verified')").run();
   const linked=await linkGuardian(db,actor,'s1',{email:'parent@example.org',name:'Amina',relation:'mother'});
   expect(linked.ok).toBe(true);
   expect((await homeworkForEmail(db,'parent@example.org')).map(r=>r.body)).toEqual(['Edited answer']);
   expect((await submitHomework(db,'parent@example.org',h,'e1','Parent impersonation','2026-11-12')).ok).toBe(false);
   expect(adminModule('/admin/offline/homework/b1')).toBe('academic');
 });
 it('lesson plan never accepts a homework submission',async()=>{
   await seed();
   const lesson=await createAssignment(db,actor,'b1',{title:'Lesson 1',details:'Tajweed reading',dueOn:'2026-11-20',kind:'lesson'});
   if(!lesson.ok)throw Error('create');
   await publishAssignment(db,actor,lesson.value,'b1');
   expect((await submitHomework(db,'rahim@example.org',lesson.value,'e1','Submit lesson','2026-11-12')).ok).toBe(false);
   expect((await assignmentsForBatch(db,'b1',false)).map(a=>a.kind)).toEqual(['lesson']);
 });
});
