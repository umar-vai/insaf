# Madrasatul Insaf

The madrasa's website (madrasatulinsaf.org), donations CRM and office ERP, rebuilt from the old WordPress site. Built from the Tamrin Institute codebase, without its online course selling.

Astro on Cloudflare Workers, D1 (SQLite) for data, R2 for uploaded pictures and files, Hono for `/api` and `/media`.

## What is in it

**Public site:** home, about, admission, contact, FAQ, notices (`/blog`), policy pages, and donations:
- `/land` the land purchase landing page for ads: goal (2 crore, set in Admin, Funds), progress bar, monthly graph, story timeline, recent donors, the form always one tap away. It counts both land funds (`land-buy` and the 200 member `land-giver` fund).
- `/donate` all funds, `/donate/<fund>` each fund's story, progress, graph, updates and form, `/donate/done?ref=` the receipt.
- `/zakat` the zakat worksheet from the old site, worked out in the browser (nothing is sent).
- Where a donor came from is kept (utm_source, utm_campaign, or facebook for fbclid) and shown in Admin. The Meta Pixel (`META_PIXEL_ID` in `wrangler.jsonc`) gets PageView, InitiateCheckout and Donate/Purchase with the amount.

**Donations CRM (Admin, "দান"):** dashboard (totals, 12 month graph, by source, by fund), every donation with filters and CSV, gifts handed to the office (cash, bank, bKash: count at once, receipt `MN-...`, voided with a reason, never deleted), payments held for review (accept or reject with a note), donors grouped by phone with their full history, and funds (goal, member goal, quick amounts, story, cover, progress updates).

**Madrasa ERP (Admin, "মাদরাসা"):** from Tamrin's office: students and admission, departments and fees (offline courses), classes and routine (batches), attendance, fee collection, dues and WhatsApp reminders, exams and extra charges, teachers, leave, payroll and pay slips, expenses with vouchers, reports, portal notices, tickets, team roles and permissions, audit log.

**Portal:** students (or their guardians) at `/account/offline`: dashboard, fees and receipts (pay online if switched on in office settings), attendance, ID card, teacher rating, tickets. Teachers at `/teacher`: classes, attendance, materials, leave, salary, tickets.

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

D1 keeps 30 days of Time Travel (`wrangler d1 time-travel info insaf --env production`). `node scripts/backup-d1.mjs --env production --out ../backup` exports the live database and proves it restores.

## Layout

| Path | What |
|---|---|
| `src/db/schema.ts` | Tables. After a change run `npm run db:generate`. |
| `src/server/donations.ts` | Funds, donations, SSLCommerz validation, office gifts, donors, reports. |
| `src/server/password.ts` | Mobile number and password sign in. |
| `src/server/offline.ts`, `office.ts`, `hr.ts`, `academic.ts`, `panels.ts` | The madrasa office (ERP) and the portals. |
| `src/server/sslcommerz.ts`, `fee-pay.ts` | The gateway; fees paid online. |
| `src/pages/land.astro`, `src/pages/donate/` | Donation pages. |
| `src/pages/admin/` | Admin: `dashboard`, `donations`, `donors`, `funds` (CRM); `offline/` (ERP). |
| `scripts/import-wordpress.mjs` | WordPress importer (data only). |
| `test/` | Tests. |
