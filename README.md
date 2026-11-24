# Madrasatul Insaf

The madrasa's website (madrasatulinsaf.org), donations CRM and office ERP, rebuilt from the old WordPress site. Built from the Tamrin Institute codebase, without its online course selling.

Astro on Cloudflare Workers, D1 (SQLite) for data, R2 for uploaded pictures and files, Hono for `/api` and `/media`.

## What is in it

**Public site:** home, about, admission, contact, FAQ, notices (`/blog`), policy pages, and donations:
- `/land` the land purchase landing page for ads: goal (2.5 crore, approved foundation campaign target; keep Admin Funds synchronized), progress bar, monthly graph, story timeline, recent donors, the form always one tap away. It counts both land funds (`land-buy` and the 200 member `land-giver` fund). The landing page uses the supplied Tamrin Education Network Foundation branding, and an optional `PUBLIC_FOUNDER_VIDEO_EMBED_URL` (a YouTube/Vimeo embed URL) for the founder's video. No video is embedded until its approved URL is supplied.
- Every counted gift gets a serial receipt number (`RCP-000001`, migration `0005`) when it first counts as paid, online or at the office; voided gifts keep theirs. `/donate/done?ref=` shows it with a print / save as PDF button (the browser's print dialog makes the PDF), and the admin donations list links each receipt and shows the number; the CSV has a Receipt no column. Gifts paid before the migration stay unnumbered until the owner approves a numbering run.
- `/donate` all funds, `/donate/<fund>` each fund's story, progress, graph, updates and form, `/donate/done?ref=` the receipt.
- `/zakat` the zakat worksheet from the old site, worked out in the browser (nothing is sent).
- Where a donor came from is kept (utm_source, utm_campaign, or facebook for fbclid) and shown in Admin. The Meta Pixel (`META_PIXEL_ID` in `wrangler.jsonc`) gets PageView, InitiateCheckout and Donate/Purchase with the amount.

**Donations CRM (Admin, "দান"):** dashboard (totals, 12 month graph, by source, by fund), every donation with filters and CSV, gifts handed to the office (cash, bank, bKash: count at once, receipt `MN-...`, voided with a reason, never deleted), payments held for review (accept or reject with a note), donors grouped by phone with their full history, and funds (goal, member goal, quick amounts, story, cover, progress updates).

**Madrasa ERP (Admin, "মাদরাসা"):** from Tamrin's office: students and admission, departments and fees (offline courses), classes and routine (batches), attendance, fee collection, dues and WhatsApp reminders, exams and extra charges, teachers, leave, payroll and pay slips, expenses with vouchers, reports, portal notices, tickets, team roles and permissions, audit log.

**School operations (Admin, "মাদরাসা"):**
- Fee bills for many students at once (`/admin/offline/bills`): pick everyone, one department or one class, preview, then post. Each bill is an ordinary charge (`offline_charges`, source `bill:<run>`), so dues, collection, receipts and reports need nothing new. Posting is idempotent; a wrong run is cancelled with a reason (charges voided, never deleted). Concessions: one active percentage per student with a reason, used only by these bills. Printable due statements per student.
- Library (`/admin/offline/library`): books with copies, lending to students and teachers, returns. Loan days and a daily late fine are office rules; a student's fine becomes a charge on their fees.
- Certificates (`/admin/offline/certificates`): transfer, character, study, completion. Serial number, editable wording, print page, and a public check at `/verify/<code>` that shows only kind, name, ID, date and validity. Revoked with a reason.
- Staff attendance (`/admin/offline/staff-attendance`): daily sheet for teachers and staff, monthly totals with approved leave. Teachers can mark their own arrival and leaving in `/teacher/attendance` when the owner turns it on (server time, late after the office start time).
- Student leave (`/admin/offline/student-leave`): asked in the portal by the student or a verified guardian; approval writes "leave" on class days without overwriting a teacher's mark.
- Admission applications (migration `0006`): the public page `/admission/apply` is the madrasa's full printed form (student and guardian details, required photo), then the student's and the guardian's pledges (`src/lib/pledges.ts`, word for word) each signed by typed name and a tick. Rate limited. Applications go to `/admin/offline/applications`: staff correct details, fill the office part (exam marks, examiner, fee agreed), print the form with both signed pledges, then accept or reject (a reason is required and shown to the family). Accepting is what creates the student (ID number, photo) and the mobile number login; only then does the student panel show the ID card with the photo. Families check progress at `/admission/status` with the application number and phone. Photos are private in R2 (`private/admission/`) and served only to staff or the signed in family. The older short inquiries stay at `/admin/offline/inquiries`.
- Departments and notices (migrations `0007`, `0008`): the seven departments from the admission poster are offline courses marked public. Admin, Madrasa, Departments shows each one's live students, applications and income, lists its students and applicants, and lets staff set the website text, order and whether it takes applications. The admission form lists these departments and remembers the choice (`course_id`); accepting an application preselects that department for enrolment. Poster features are in `src/lib/madrasa.ts` and shown by `FeatureList.astro` on home, about and admission. The notice page is `/blog` (Admin, Website, notices): it has the poster banner on top, and a notice with a future date and time is scheduled and stays hidden until then (no cron needed). Fees of the new departments are 0 until the office sets them.
- Notifications in the portal and teacher panel with an unread count: fee bills, published results, homework, leave decisions, salary paid, overdue library books (nightly), certificates. The office can message all students, a department, a class or all teachers (`/admin/offline/messages`), by SMS too when the SMS key is set (paid per SMS, at most 300 at once).

**Accounts book (Admin, "মাদরাসা", হিসাব খাতা, migration `0004`):** `/admin/offline/accounts`.
- Projects (a department or a piece of work such as a building repair), funds (general, zakat, lillah, grants; restricted or not) and the places money is kept (cash box, bank, mobile banking, gateway). Each payment method belongs to one account, so fees and expenses land in the right account without extra typing. A department can be put under a project; its fees then count as that project's income (fees always go to the general fund).
- Other income (grants, rent, sales, money moved over from the donation side by decision) and transfers between accounts, with voucher numbers CV and JV. Expenses get DV numbers, a payee, a fund and a project. Every voucher prints with prepared, checked and approved by. Nothing is deleted: wrong entries are voided with a reason.
- Two step approval for large expenses (office settings): above the first limit someone with full accounts power approves; above the second the owner gives the final approval after that check. Nobody but an owner approves their own expense.
- Cash book and fund and project ledgers with running balance (print and Excel), the receipts and payments statement with fund and project tables (print and Excel), yearly budget against approved spending, and bank and cash reconciliation (counted or statement amount against the books, kept with the difference).
- Donations are not counted here; the owner's combined view stays at `/admin/finance`.

**Student CRM (যোগাযোগ ও ফলো আপ):** `/admin/offline/crm` and the CRM card on each student's page: tags (orphan, residential, hifz...), follow ups with a date and who does them (due ones show on the dashboard), the contact log (calls, visits, WhatsApp, SMS; group messages and due reminders are logged on their own), message templates with `{name} {id} {course} {class} {due} {date}`, one timeline per student (admission, payments, charges, contacts, follow ups, tickets, leave, certificates, notifications, library, absences) and the engagement report. Group messages can go to a tag. Every fee payment sends the digital receipt to the student's portal at once.

**Donor CRM and accounting controls (migration `0009`):** the CRM only reads `donations`; what counts as a gift stays in `src/server/donations.ts`.
- `/admin/donors`: segments (new, regular, once, active, lapsed), tags, minimum amount filter. `/admin/donors/<key>`: profile note, preferred channel, do not contact, full timeline, contact log, follow ups, tickets, receipt by WhatsApp.
- `/admin/donors/desk`: the daily desk: receipts still to send (last 30 days), follow ups, tickets, contact log, templates, engagement report with year on year retention. Receipts are one tap; nothing is sent without a staff click, because SMS costs money.
- `/admin/offline/accounts/close`: close the books through a past day. Nothing dated inside can be added, approved or voided until an owner reopens with a reason. Verified online fee payments are never refused.
- Restricted funds: spending past the balance is refused; only an owner can override, and the override is in the audit log. A large approved expense can be voided only by an owner.
- `/admin/offline/accounts/reconcile`: tick lines against the statement to see what the statement should show.
- `/admin/finance/consolidated`: donations, fees, other income and spending on one page (print and Excel). Income entered as "দান তহবিল থেকে স্থানান্তর" is not counted twice. Donations are still not written into the books.
- `/admin/audit`: every accounts, CRM and donation action has a Bangla name and filter, and the log downloads as Excel.

**Demo data:** `node scripts/demo-data.mjs seed` writes an SQL file of test students, teachers, staff, classes, fees, expenses, income and CRM rows (ids start with `demo_`, names end in "(টেস্ট)"); `node scripts/demo-data.mjs remove` writes the SQL that deletes exactly those rows. Run either with `npx wrangler d1 execute DB --env production --remote --file <file>`.

Not built, waiting for the madrasa's own rules: hostel and transport, letter grades (A+ and so on), multi campus.

**Portal:** students (or their guardians) at `/account/offline`: dashboard, notifications, fees and receipts (pay online if switched on in office settings), attendance, results, homework, leave requests, library books, ID card, teacher rating, tickets. Teachers at `/teacher`: classes, attendance, materials, notifications, own attendance, leave, salary, tickets.

## Signing in

- Mobile number and password: on a student's or teacher's admin page, "মোবাইল দিয়ে লগইন চালু করুন" makes a password and shows it once (with WhatsApp and SMS buttons to send it). The login is the student's number (or the guardian's); brothers and sisters with the same number share one login that shows all of them. People change their password on their profile.
- Google: works when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. A record with a Gmail opens for that Google account.
- Admin: owners are in the `ADMIN_EMAILS` secret; others are added on Admin, Team with a role. Owners sign in with Google or with a password set by `node scripts/set-password.mjs`.
- Email codes only on test sites.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # fill SESSION_SECRET
npm run db:reset:local
npm run import:wp                # funds, donations and notices from the WordPress dump
npm run dev                      # http://localhost:4321, /admin opens without sign in on localhost
npm test
npm run check
```

## Production

Worker `insaf`, env `production` in `wrangler.jsonc`, D1 `insaf`, R2 `insaf-media`. The site answers on madrasatulinsaf.org through Worker routes on the proxied DNS records; WordPress on Hostinger stays untouched behind them.

```bash
CLOUDFLARE_ENV=production npm run build && npx wrangler deploy
npm run build   # afterwards, so local wrangler commands point at local data again
npx wrangler d1 migrations apply DB --env production --remote
```

Secrets: `SESSION_SECRET`, `ADMIN_EMAILS` (and optionally `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`): `npx wrangler secret put <NAME> --env production`. The SSLCommerz store id and password are entered by an owner on Admin, System settings (stored encrypted); without them the donation form says online payment is off.

Rollback: delete the two madrasatulinsaf.org routes under Workers Routes in the Cloudflare dashboard (or remove them from `wrangler.jsonc` and deploy). WordPress answers again within a minute. Donations made on the new site meanwhile stay in D1.

Old WordPress addresses redirect (`src/lib/legacy-redirects.ts`): fund pages, Bangla menu pages, notices, account pages.

## Backups

Where the data lives: the database (donations, students, fees, accounts, staff) is D1 `insaf`; uploaded pictures, vouchers and files are R2 `insaf-media`.

Three layers:
1. **D1 Time Travel**, 30 days, any minute. For a mistake noticed soon: `npx wrangler d1 time-travel info insaf --env production`, and `restore` to a timestamp or bookmark. This rewinds the whole database, so ask the owner first and take a bookmark before.
2. **Nightly copy** (`src/server/backup.ts`, cron 18:15 UTC, 00:15 in Dhaka). Cloudflare's D1 export API makes a full SQL dump; the Worker checks it and stores it in R2 bucket `insaf-backups` as `daily/YYYY-MM-DD.sql`, plus `monthly/YYYY-MM.sql` on the 1st. Daily copies are kept 30 days, monthly 12 months. Every run is in the audit log as `backup.ok` or `backup.failed` (that is the history). If there is no good copy for 26 hours the owner sees a red warning at the top of every admin page. The export briefly holds the database, so it runs at night.
3. **A copy on the owner's computer**: `node scripts/backup-d1.mjs --env production --out ../backup` exports, restores into a throwaway local database and compares counts.

One time setup (needs the owner): create the bucket (`npx wrangler r2 bucket create insaf-backups`), make an API token with only D1 read and export for this database, then `npx wrangler secret put CF_BACKUP_TOKEN --env production` and `npx wrangler secret put CF_ACCOUNT_ID --env production`. Until then each night is recorded as failed and the warning shows. Not covered yet: the R2 media files (vouchers, pictures) are not copied, and a Google Sheet of daily totals is not built.

Check a copy restores (touches nothing online): download a file from the bucket, then `node scripts/restore-check.mjs <file.sql>`. It loads the file into a throwaway local database and compares every table with the file.

Restore after a mistake or loss (always ask the owner first, it replaces data):
- Deleted or changed something recently: Time Travel as above.
- Database lost or damaged beyond 30 days: create a new D1 database, apply the migrations (`wrangler d1 migrations apply`), load the newest good `daily/` file in two parts as `restore-check.mjs` does (all `CREATE` lines first, then the `INSERT` lines after `PRAGMA defer_foreign_keys=TRUE;`) with `wrangler d1 execute --remote --file`, run `restore-check.mjs` on the same file first, point `database_id` in `wrangler.jsonc` at the new database and deploy. The old WordPress site is not involved.

## Layout

| Path | What |
|---|---|
| `src/db/schema.ts` | Tables. After a change run `npm run db:generate`. |
| `src/server/donations.ts` | Funds, donations, SSLCommerz validation, office gifts, donors, reports. |
| `src/server/password.ts` | Mobile number and password sign in. |
| `src/server/offline.ts`, `office.ts`, `hr.ts`, `academic.ts`, `panels.ts` | The madrasa office (ERP) and the portals. |
| `src/server/fee-bills.ts`, `library.ts`, `certificates.ts`, `staff-attendance.ts`, `student-leave.ts`, `inquiries.ts`, `notifications.ts` | School operations (migration `0003`). |
| `src/server/accounts.ts`, `accounts-ledger.ts`, `crm.ts` | Accounts book and student CRM (migration `0004`). |
| `src/server/donor-crm.ts`, `acc-period.ts`, `acc-controls.ts` | Donor CRM, closed periods, restricted funds, clearing, consolidated report (migration `0009`). |
| `src/server/sslcommerz.ts`, `fee-pay.ts` | The gateway; fees paid online. |
| `src/pages/land.astro`, `src/pages/donate/` | Donation pages. |
| `src/pages/admin/` | Admin: `dashboard`, `donations`, `donors`, `funds` (CRM); `offline/` (ERP). |
| `src/server/backup.ts`, `scripts/restore-check.mjs` | Nightly database copy and the restore check. |
| `scripts/import-wordpress.mjs` | WordPress importer (data only). |
| `test/` | Tests. |
