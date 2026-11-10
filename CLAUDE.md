# Working on Madrasatul Insaf

Talk to the owner in simple Bangla. Code, commit messages and technical names in English. Do not use dash characters in text written for the owner.

## Hard rules
1. Never touch the old WordPress on Hostinger, DNS or the payment store settings without explicit permission.
2. No passwords or API tokens in Git: `.dev.vars` locally, Cloudflare secrets remotely, and the SSLCommerz store keys in Admin, System settings (encrypted in D1). The WordPress dump (`u148519723_bTIlC.sql`) and `uploads/` hold donor phone numbers and the old store password: they stay on the owner's computer and are in `.gitignore`.
3. The old WordPress had suspicious accounts and a remote control plugin. Bring only data from it, never PHP, plugin or theme code, and clean imported HTML with `scripts/lib/sanitize.mjs`.
4. Money is integer poisha. A donation counts only when SSLCommerz's validation API confirms it for that reference, amount and currency (or staff record it as an office gift). Never trust what the browser posts back. Keep `test/donations.test.ts` passing.
5. Real text from the madrasa only: no made up numbers, donors, reviews or fees. Progress bars show counted gifts against the goal set in the admin.
6. Ask first before: deleting or big changes to the production database, anything that costs money.
7. Never report something as done when it is not.

## How we work
- Small steps; after each, tell the owner in 2 to 4 lines what changed.
- Same stack and patterns as Tamrin (`umar-vai/Tamrin-2.0`), which this was built from. Read it before inventing something new.
- One design system: tokens in `src/styles/tokens.css` (the logo's green and gold). Change tokens and components, never add an override layer.
- Docs are only this file and README.md.
