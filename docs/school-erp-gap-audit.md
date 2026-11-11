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
- [ ] Navigation search improvement: tracked as a companion source change in this branch pending CI.
- [ ] Later phases: not yet implemented; each requires separate scoped PR and test gate.
