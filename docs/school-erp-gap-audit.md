# Madrasatul Insaf — School ERP gap audit and phased implementation

Date: 2026-11-12. Repository: `umar-vai/insaf` (Astro/Cloudflare Workers, D1, R2, Hono). Scope: the active Madrasa ERP plus staff, teacher and student/guardian panels.

## Source and confidence
- Current features verified against source routes and service/database code on this date, not just screenshots.
- Comparison: public feature catalogue of Weblizar's *The School Management – Education & Learning ERP* / Pro: https://wordpress.org/plugins/school-management-system/ . **The exact previously purchased "SM School Management" product and licensed version have not been confirmed.** This is an indicative feature-gap audit, not a claim of exact paid-plugin parity.
- Do **not** copy proprietary WordPress plugin PHP/CSS/JS or bundled commercial assets into the new app. Implement independently from authorised functional requirements.
- No existing WordPress plugin-specific data migration has been established. Obtain a user-approved export and mapping before touching real student records.

## Verified existing capability
| Area | Current implementation |
| --- | --- |
| Admission & people | Admin student create/edit, enrollments, course/batch assignments, guardian phone, duplicate-phone handling, ID cards; teacher/staff profiles |
| Academic | Course/department setup, batches, timetable, subject-teacher mapping, attendance, exam schedule and exam charge, study-material distribution, notices |
| Finance | Fee collection, installments, late fees, dues, receipts, online-fee review, expenses, vouchers, payroll/payslips, financial reports and CSV exports |
| Portals | Student/guardian dashboard via linked phone/account, fees, attendance, notices, course materials, ID, teacher rating, tickets; teachers' classes, roster, materials, attendance, leave, payroll, tickets |
| Controls | Owner/staff modules and view/edit/full grants, admin audit log, secure sessions and authenticated portal routes, Cloudflare D1/R2, API rate limits |

## Partial or unverified versus advanced paid school-management systems
| Candidate module | Gap observed in current repo | Integration to design |
| --- | --- | --- |
| Academic sessions and promotions | Enrollments and batches exist; no explicit academic-year rollover + promotion workflow found | Admin session wizard; teacher current-session rosters; historic student results and dues |
| Exam results/gradebook | Exam schedules and charges exist; no marks/grade calculation/report cards found | Admin exam policy, teacher marks entry only for their batches, student/guardian result view after approval |
| Homework and lesson plans | Study-material upload exists; no dated homework assignment/submission/review workflow found | Teacher assignments and review, student submission, guardian progress, admin completion report |
| Guardian management | Guardian phone/shared login exists; no dedicated relationship records and per-student permissions found | Explicit guardian-student links, least-privilege guardian portal, sibling mapping |
| Admissions & transfers | Direct student admission exists; no evidence of inquiry workflow, approvals, transfer certificate generation | Public inquiry -> admin review -> enrollment; authorised certificates |
| Fee automation | Installments and receipts exist; no documented school-year bulk fee invoice or concessions system | Admin templates, preview/dry-run, idempotent invoices, distinct General/Zakat/donation accounting |
| Library | No library catalogue, borrowing, fines, library cards found | Staff librarian module, student book search and due dates |
| Student leave / late attendance | Teacher leave exists, student attendance exists; no dedicated student leave approval/late reason found | Student/guardian application, teacher/admin approval, audit log |
| Staff clock-in/HR shifts | Teacher leave/payroll exists; no dedicated time-clock or duty shift tracking found | Employee portal, HR approvals, payroll data bridge |
| Certificates, assets, hostel, transport | Not established in current repo | Later optional modules only if Madrasa operations need them |
| Multi-campus/network | Single institutional scope evident; multi-school tenant separation not established | Defer pending real need and tenant boundary design |

## Priorities and implementation gates

**Phase 1 — Navigation and discovery (safe, no migration).** Add role-filtered admin task search over already-authorised menu entries with Bengali descriptions, accessible keyboard shortcut, mobile drawer support and an empty-results message. Verify it never exposes links outside `mayOpenPath`. This changes only UI navigation, not the backend.

**Phase 2 — Academic foundation.** Design additive academic-session, class/section, guardian relationship, and enrollment history tables. Prepare local D1 migration + rollback procedure, validate against backups, draft owner-approved data mapping. Implement promotion preview and dry-run before any writes. Test per-batch per-student access rules and duplicate promotion protection.

**Phase 3 — Learning and assessment.** Implement assignment/lesson-plan workflow and exam gradebook/report cards with teacher scope, approvals and student/guardian publication. Tests must cover IDOR, student privacy, unpublished results, concurrency and invalid marks.

**Phase 4 — School operations and financial enhancements.** Invoice templates/concessions and bulk generation with idempotency, library and books, student leave, certificates, staff timesheets, and selective notifications. Hostel/transport/multi-school only after requirements confirmation.

### Strict release/security requirements
1. Treat student/guardian/teacher data as sensitive. Do not fetch real PII for a UI inventory. No live-data exports without explicit permission.
2. Every new API action needs server-side authentication, module permissions, per-record ownership checks and validated inputs. Hidden buttons are never access control.
3. Keep fees, payroll, donations, invoices, attendance and student records separated; audit before/after changes; do not overwrite financial history.
4. Maintain immutable transaction receipts, separate view/edit/full roles, pagination, CSV sanitisation, upload restrictions, rate limiting, and minimal PII exposure.
5. Backup, migrate and restore on isolated staging. Never run production D1 migrations automatically without schema approval and deployment/rollback readiness.
6. Every release passes TypeScript/Astro, worker Vitest integration, role-boundary tests, mobile/desktop UX checks and an independent review. Deploy incrementally after checks and measure live error logs.

### Clarifying evidence to collect before later phases
Confirm the exact old paid plugin name/version (purchase receipt, module screenshots or licensed export), the school's preferred academic-year and grading policy, who can approve results and promotions, and which staff roles actually need library/transport/hostel functions.

### Implementation status
- [x] 2026-11-12: inspected repo modules, portals, permission mapping, D1 schema and tests; made provisional public reference comparison.
- [x] Phase 1 navigation search: tested and deployed in PR #19.
- [x] Phase 2: additive academic session/batch placement, preview/confirm same-course promotions, audited verified guardian links (see the Phase 2 operations section below).
- [ ] Phase 3: code complete and checked locally (Astro/TypeScript 0 errors, 153 Vitest tests, production build), PR #21. **Not released**: not merged, migration 0002 not applied to production, GitHub Actions runs for the PR have stayed queued since 2026-11-11.
- [ ] Later phases: library, cross-course fee renewal, bulk invoices, formal grading scale approval, certificates; each requires separate scoped PR and test gate.


## Phase 2 operations, privacy and release (2026-11-12)

The new admin menu entry is **মাদরাসা → একাডেমিক → সেশন ও প্রমোশন** (`/admin/offline/sessions`).

- Create a session with a name and start/end dates. Only one session can be active.
- Create a new batch in **ক্লাস ও রুটিন** and associate it with a planned session.
- Preview an active student's current enrollment, select an active target batch of the same course, then confirm the promotion. The record is in `academic_promotions`. Only when the planned session is activated does the teacher roster and student dashboard use that new placement.
- Original `offline_enrollments`, fee terms, payment records, receipts, and historic attendance are never rewritten by a promotion. Attendance in a previous batch remains accessible in historic reporting.
- A promotion between different fee-bearing courses is **not** automatic because it requires a fresh enrollment and signed fee policy.
- Student/guardian integration: the guardian signs in to the site once via Google, then Office Full staff verifies their relationship, explicitly confirms approval and links the verified Gmail on that student's admin page. The student portal only reads active linked students; links can be revoked. There is no blind access by phone alone.
- Only Academic Full may create/activate sessions or promote students; only Office Full may link/revoke guardians. These operations are logged in `admin_events`.
- Four additive tables with a new D1 migration `0001_academic_sessions.sql`: academic_sessions, academic_batch_sessions, academic_promotions and academic_guardian_links. Existing fee and student records are untouched.
- The production GitHub Actions workflow applies the migration only on a merge commit explicitly marked `[approve-insaf-academic-0001]`; Wrangler backs up D1 when applying. Before the release, inspect `d1_migrations` and preserve a Time Travel bookmark. Do not restore D1 automatically.
- Authenticated smoke tests must be carried out by an authorised school admin; do not pull live pupil PII into the coding context.
- For the first release the promotion preview lists up to 300 active enrollments, and supports same-course batch changes only. Paginated search, cross-course fee renewals, and bulk promotions are later iterations.

## Phase 3: exam assessments + assignment workflow (2026-11-12)

### Exam workflow
- Existing `offline_exams` remain the exam schedule and fee source. New `assessment_policies`, `assessment_examinees`, and `assessment_marks` store marks independently. Payments/fees/receipts are never updated by grades.
- Staff with Academic Full role configures a gradebook (total marks and *institution-approved* pass marks), explicitly confirms the current exam roster snapshot, and publishes only after **every** enrolled examinee has marks or is marked absent. Publishing locks the gradebook; already published exams cannot be cancelled. Teachers assigned to the exam's batch can record or correct draft marks only. Marks are entered for the whole class on one mark sheet and saved together (Bangla or English digits); if any mark is above the full marks nothing is saved, blank rows stay blank, and unchanged rows are not rewritten. Each save is one audit entry.
- No letter grades are automatically assumed. Reports show obtained/maximum, percent, and pass/fail based on admin-selected passing marks. If an A+/A grade policy is required, approve a separate grading-policy configuration before using official grade labels.
- Student and explicitly authorized guardian accounts can see only their own **published** results at `/account/offline/results`; browser print/PDF is supported. Unpublished exam marks never appear in the student portal. The admin result index and individual gradebook live under `/admin/offline/results` and `/admin/offline/gradebook/:examId`.
- Staff must confirm the roster snapshot carefully, particularly for exams created before academic-session promotions. A first-release gradebook locks that roster and pass-mark policy at configuration time rather than dynamically adding later enrollees. Up to 1,000 examinees can be configured in one exam; larger cohorts need a pagination/bulk design.
- Cancelled or already published exams reject edit/publish operations.

### Homework and lesson plan workflow
- Teachers work from `/teacher/batch/:id`, create dated homework or lesson plan as **draft**, then publish, close, and review submitted responses under `/teacher/homework/:id`. Server-side teacher/batch authorization is required for every action.
- Admin Academic Edit staff can oversee assignments and review submissions at `/admin/offline/homework` and `/admin/offline/homework/:batchId`. The admin nav and task search include these modules.
- Students see only published or closed assignments for their *current active enrollment* at `/account/offline/homework`. Only the direct student-linked email account can submit text answers; a separately linked guardian can view but cannot impersonate the student to submit. Submissions are limited to one editable text answer per enrollment/assignment before the due day, and lock upon review or closure. Homework score (optional) uses 0–100 plus teacher feedback.
- A lesson plan is read-only and does not accept submissions. No external file uploads are introduced in this release; students may continue to access existing course material downloads separately.
- Teachers can see submitted answers for only a batch they teach. School-admin roles are enforced by existing no-cache/same-origin middleware.
- New tables: `homework_assignments`, `homework_submissions`, and the three `assessment_*` tables. Migration `0002_assessments_homework.sql` is additive.
- First-release limits: up to 1,000 exam participants per gradebook and 400 newest submission rows per assignment; future cohorts require pagination. Scores after publication and reviewed homework are immutable without separately audited correction workflows.

### Release and safety
- Migration step is conditional on release marker `[approve-insaf-academic-0002]`; checks/tests/build run first; Wrangler applies only the approved pending migration before deploying Worker.
- Preserve D1 Time Travel bookmark before migration, verify applied migration history and five table names after, and validate zero cross-user visibility in integration tests. Never copy any purchased WordPress plugin source code.
- Do not copy live child/guardian PII into test fixtures; test with synthetic records only.

### Review fixes before release (2026-11-12)
Found in PR #21 and fixed on the same branch: the admin homework index imported from the wrong folder (type check and build failed), one gradebook test failed (roster ordering, now by roll number), several pages were missing the portal `ui` wrapper and used a colour token that does not exist, numbers and dates showed in English digits, marks had to be saved one student at a time, the admin results and homework index ran one query per batch, the teacher dashboard lost the exam fee line, and the gradebook setup could leave a policy without examinees if interrupted (now one batch). The mark and attendance sheet counters clashed with the public site's animated `data-count` numbers.
