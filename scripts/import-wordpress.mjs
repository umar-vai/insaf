// Brings the old WordPress site's data into D1: the donation funds, every
// donation the custom "Donation Manager Pro" plugin recorded, and the public
// notices (posts). Data only: nothing in the dump is executed, and post HTML
// is cleaned by scripts/lib/sanitize.mjs (the old sites were attacked).
//
//   node scripts/import-wordpress.mjs --dump u148519723_bTIlC.sql            # local D1
//   node scripts/import-wordpress.mjs --dump u148519723_bTIlC.sql --env production --remote
//   ... --dry   prints counts and writes the SQL file, applies nothing
//
// Safe to run again: rows are inserted with INSERT OR IGNORE by their old ids,
// so nothing already there is changed or doubled. Fund texts are from the old
// fund pages (madrasatulinsaf.org/land-buying/ etc.).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTables } from './lib/wp-dump.mjs';
import { sanitizeHtml } from './lib/sanitize.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const dump = arg('dump');
if (!dump || !fs.existsSync(dump)) {
  console.error('Usage: node scripts/import-wordpress.mjs --dump <file.sql> [--env production --remote] [--dry]');
  process.exit(1);
}

// Old category id -> the fund on the new site. Titles and texts as on the old fund pages.
const FUNDS = {
  6: {
    slug: 'land-buy',
    title: 'জমি ক্রয় তহবিল',
    position: 1,
    goalTaka: 2_00_00_000,
    summary: 'মাদরাসার স্থায়ী ক্যাম্পাস নির্মাণের লক্ষ্যে জমি ক্রয়ের বিশেষ প্রজেক্ট।',
    story: `মাদরাসার স্থায়ী ক্যাম্পাস নির্মাণের লক্ষ্যে জমি ক্রয়ের এই বিশেষ প্রজেক্ট। দীনি প্রতিষ্ঠান গড়ার এই মৌলিক কাজে অংশ নিয়ে মাটির প্রতিটি ধূলিকণার বিনিময়ে আল্লাহর ঘর জান্নাতে আপনার জন্য একটি স্থায়ী ঠিকানা নিশ্চিত করুন।

এই তহবিলের অর্থ শুধু মাদরাসার স্থায়ী ক্যাম্পাস নির্মাণের লক্ষ্যে সংরক্ষিত ও ব্যয় হয়।`,
  },
  7: {
    slug: 'land-giver',
    title: 'জমি দাতা সদস্য তহবিল',
    position: 2,
    memberGoal: 200,
    summary: 'বিশেষ ২০০ জন শেয়ারহোল্ডার বা সদস্যের তালিকায় আপনার নাম অন্তর্ভুক্ত করুন।',
    story: `> যখন মানুষ মৃত্যুবরণ করে তখন তার সমস্ত আমল বন্ধ হয়ে যায়। শুধু তিন প্রকার আমল অব্যাহত থাকে: সদাকাহ জারিয়াহ; এমন জ্ঞান যার দ্বারা অন্যের উপকার হয়; যে সুসন্তান তার জন্যে দু‘আ করতে থাকে। (সহীহ মুসলিম, হাদীস ১৬৩১)

বিশেষ ২০০ জন শেয়ারহোল্ডার বা সদস্যের তালিকায় আপনার নাম অন্তর্ভুক্ত করুন। জমি ক্রয়ের লক্ষ্যমাত্রা অর্জনে বড় অংশীদার হিসেবে স্থায়ী সদস্য পদ লাভ করুন এবং মাদরাসার ইতিহাসে নিজের নাম লিখে রাখুন।

## ব্যয়ের খাত
মাদরাসার জমি ক্রয়ের জন্য ব্যয় করা হবে ইন শা আল্লাহ।`,
  },
  8: {
    slug: 'regular-donation',
    title: 'নিয়মিত দান তহবিল',
    position: 3,
    summary: 'মাদরাসার দৈনন্দিন পরিচালনা, শিক্ষক-শিক্ষার্থীদের আবাসন ও সাধারণ ব্যয় নির্বাহে আপনার ছোট ছোট নিয়মিত দান আমাদের বড় শক্তি।',
    story: `> আল্লাহর কাছে সর্বাধিক প্রিয় আমল হলো, যা সদাসর্বদা নিয়মিত করা হয়, যদিও তা অল্প হয়। (সহীহ বুখারী, হাদীস ৬৪৬৪)

মাদরাসার দৈনন্দিন পরিচালনা, শিক্ষক-শিক্ষার্থীদের আবাসন ও সাধারণ ব্যয় নির্বাহে আপনার ছোট ছোট নিয়মিত দান আমাদের বড় শক্তি। মাসিক বা নির্দিষ্ট সময় অন্তর অংশীদার হয়ে এই মহৎ যাত্রাকে সচল রাখুন।

## ব্যয়ের খাত
মাদরাসার সচলতা ও প্রাণচাঞ্চল্য বজায় রাখতে এই খাতের অবদান অপরিসীম। আপনার নিয়মিত দান নিম্নোক্ত উপায়ে ব্যয় হবে:
- দরিদ্র তহবিল: এতিম অসহায়দের ব্যয় নির্বাহ।
- পরিচালনা ও ব্যবস্থাপনা: মাদরাসার প্রাত্যহিক দাফতরিক ও প্রশাসনিক ব্যয় নির্বাহ।
- আবাসন ও রক্ষণাবেক্ষণ: ভাড়া পরিশোধ এবং শিক্ষার্থীদের থাকার জায়গার মান উন্নয়ন।
- ইউটিলিটি সেবা: নিয়মিত বিদ্যুৎ, পানি ও ইন্টারনেট বিল পরিশোধ।
- শিক্ষা ও গবেষণা: শিক্ষকদের সম্মানি প্রদান এবং ইলমি প্রসারে নতুন নতুন দীনি উদ্যোগ বাস্তবায়ন।`,
  },
  2: {
    slug: 'sadkah-zaria',
    title: 'সাদকায়ে জারিয়া তহবিল',
    position: 4,
    summary: 'এমন এক বিনিয়োগ যা আপনার মৃত্যুর পরেও সওয়াবের ধারা অব্যাহত রাখবে।',
    story: `> যখন মানুষ মৃত্যুবরণ করে তখন তার সমস্ত আমল বন্ধ হয়ে যায়। শুধু তিন প্রকার আমল অব্যাহত থাকে: সদাকাহ জারিয়াহ; এমন জ্ঞান যার দ্বারা অন্যের উপকার হয়; যে সুসন্তান তার জন্যে দু‘আ করতে থাকে। (সহীহ মুসলিম, হাদীস ১৬৩১)

এমন এক বিনিয়োগ যা আপনার মৃত্যুর পরেও সওয়াবের ধারা অব্যাহত রাখবে। এই তহবিলের অর্থ স্থায়ী সম্পদ ও দীনি প্রচারণায় ব্যয় করা হয়, যা কিয়ামত পর্যন্ত আপনার জন্য জান্নাতের পাথেয় হয়ে থাকবে ইন শা আল্লাহ।

## ব্যয়ের খাত
এটি আপনার পরকালীন স্থায়ী বিনিয়োগ। এই তহবিলের অর্থ সকল সদকায়ে জারিয়ামূলক কাজে এবং দীর্ঘস্থায়ী সম্পদে ব্যয় করা হয়।`,
  },
  5: {
    slug: 'zakat',
    title: 'যাকাত তহবিল',
    position: 5,
    summary: 'আপনার জাকাত হোক গরিব ও মেধাবী শিক্ষার্থীদের শিক্ষার আলো।',
    story: `> তোমরা নামায প্রতিষ্ঠা কর এবং যাকাত দাও। তোমরা নিজের জন্য পূর্বে যে সৎকর্ম প্রেরণ করবে, তা আল্লাহর কাছে পাবে। তোমরা যা কিছু কর, নিশ্চয় আল্লাহ তা প্রত্যক্ষ করেন। (সূরা বাকারা, ১১০)

আপনার জাকাত হোক গরিব ও মেধাবী শিক্ষার্থীদের শিক্ষার আলো। শরীয়তসম্মত উপায়ে সংগৃহীত এই তহবিল থেকে অসহায় ছাত্রদের পড়াশোনা, কিতাব ও জীবনযাত্রার ব্যয়ভার বহন করা হয়।

## ব্যয়ের খাত
আপনার জাকাতের অর্থ শরীয়তসম্মত উপায়ে সম্পূর্ণভাবে অসহায় ছাত্রদের কল্যাণে ব্যয়িত হয়:
- অসহায় ছাত্রদের খোরাকি: এতিম ও দরিদ্র শিক্ষার্থীদের দৈনিক তিনবেলার খাবার খরচ।
- শিক্ষা সহায়তা: মেধাবী ছাত্রদের ভর্তি ফি, কিতাব ও শিক্ষা সরঞ্জামের ব্যয়ভার বহন।
- চিকিৎসা ও পোশাক: অসুস্থ ছাত্রদের চিকিৎসা এবং দরিদ্র ছাত্রদের বস্ত্র ও শীতবস্ত্র সরবরাহ।

যাকাতের হিসাব করতে [যাকাত ক্যালকুলেটর](/zakat) ব্যবহার করুন।`,
  },
  3: {
    slug: 'iftar',
    title: 'ইফতার তহবিল',
    position: 6,
    summary: 'রমজানে রোজাদার হাফেজ ও আলেমদের ইফতার করানো এক বিশাল সাওয়াবের কাজ।',
    story: `> যে ব্যক্তি কোনো সিয়াম পালনকারীকে ইফতার করাবে, তাকে সিয়াম পালনকারীর সমপরিমাণ সাওয়াব দেওয়া হবে। তাতে সিয়াম পালনকারীর সাওয়াব থেকে বিন্দুমাত্র কমানো হবে না। (সুনান তিরমিযী, হাদীস ৮০৭; ইবনু মাজাহ, হাদীস ১৭৪৬)

রমজানে রোজাদার হাফেজ ও আলেমদের ইফতার করানো এক বিশাল সাওয়াবের কাজ। আপনার দানে সিয়াম পালনকারী আলেম ও তালিবে ইলমদের মুখে হাসি ফুটুক এবং তাদের ইবাদতের সাওয়াবে আপনিও অংশীদার হোন।

## ব্যয়ের খাত
রমজানে কুরআনের পাখি, হাফেজ, রোজাদার আলেম ও মাদরাসার তালিবে ইলমদের সেবায় ইফতার ও সাহরিতে এই খাতের অর্থ ব্যয়।`,
  },
  1: {
    slug: 'general-donation',
    title: 'সাধারণ দান',
    position: 7,
    summary: 'মাদরাসার প্রয়োজন অনুযায়ী যেকোনো খাতে ব্যয়ের জন্য।',
    story: '',
  },
};

const t = readTables(dump, ['wp_dmp_categories', 'wp_dmp_transactions', 'wp_donations', 'wp_posts']);
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const iso = (mysql) => (mysql ? `${mysql.replace(' ', 'T')}.000Z` : null);
const sql = [];

// Funds.
for (const c of t.wp_dmp_categories) {
  const f = FUNDS[Number(c.id)];
  if (!f) {
    console.warn(`Unknown category ${c.id} ${c.name}: skipped`);
    continue;
  }
  sql.push(
    `INSERT OR IGNORE INTO funds (id, slug, title, summary, story_text, goal_minor, member_goal, preset_amounts, status, position, legacy_wp_id) VALUES (${[
      q(`fund_wp${c.id}`),
      q(f.slug),
      q(f.title),
      q(f.summary),
      q(f.story),
      f.goalTaka ? f.goalTaka * 100 : 'NULL',
      f.memberGoal ?? 'NULL',
      q(f.slug === 'land-giver' ? '5000,10000,25000,50000,100000' : '500,1000,2000,5000,10000'),
      q(Number(c.is_active) ? 'active' : 'hidden'),
      f.position,
      Number(c.id),
    ].join(', ')})`,
  );
}

// Donations from the custom plugin. Status: success -> paid; the others keep
// their meaning and are never counted.
const STATUS = { success: 'paid', pending: 'pending', cancelled: 'cancelled', failed: 'failed' };
const BD_PHONE = /^(?:\+?88)?(01[3-9]\d{8})$/;
const BN = '০১২৩৪৫৬৭৮৯';
const phoneOf = (raw) => {
  const s = String(raw ?? '').replace(/[০-৯]/g, (d) => String(BN.indexOf(d))).replace(/[\s-]/g, '');
  return BD_PHONE.exec(s)?.[1] ?? (/^\+\d{8,15}$/.test(s) ? s : '');
};
let paid = 0;
let paidMinor = 0;
for (const d of t.wp_dmp_transactions) {
  const status = STATUS[d.payment_status] ?? 'failed';
  const amount = Math.round(Number(d.amount) * 100);
  if (!(amount > 0) || !FUNDS[Number(d.category_id)]) continue;
  if (status === 'paid') {
    paid++;
    paidMinor += amount;
  }
  sql.push(
    `INSERT OR IGNORE INTO donations (id, reference, fund_id, amount_minor, donor_name, donor_phone, donor_email, on_behalf, status, gateway, method, val_id, bank_tran_id, review_reason, note, paid_at, created_at, updated_at) VALUES (${[
      q(`don_wp${d.id}`),
      q(d.tran_id),
      q(`fund_wp${d.category_id}`),
      amount,
      q(String(d.donor_name || 'নাম নেই').slice(0, 80)),
      q(phoneOf(d.donor_phone)),
      q(String(d.donor_email ?? '').toLowerCase()),
      q(String(d.donation_on_behalf ?? '').slice(0, 120)),
      q(status),
      q('sslcommerz'),
      q(d.card_type ?? ''),
      q(d.val_id),
      q(d.bank_tran_id),
      q(d.error_message),
      q('পুরনো ওয়েবসাইট থেকে আনা'),
      q(status === 'paid' ? iso(d.created_at) : null),
      q(iso(d.created_at)),
      q(iso(d.created_at)),
    ].join(', ')})`,
  );
}
// The plugin before it (wp_donations): general gifts, "completed" = paid.
for (const d of t.wp_donations) {
  const status = d.status === 'completed' ? 'paid' : d.status === 'pending' ? 'pending' : 'failed';
  const amount = Math.round(Number(d.amount) * 100);
  if (!(amount > 0)) continue;
  if (status === 'paid') {
    paid++;
    paidMinor += amount;
  }
  sql.push(
    `INSERT OR IGNORE INTO donations (id, reference, fund_id, amount_minor, donor_name, donor_phone, status, gateway, note, paid_at, created_at, updated_at) VALUES (${[
      q(`don_wpold${d.id}`),
      q(d.transaction_id),
      q('fund_wp1'),
      amount,
      q('নাম নেই'),
      q(phoneOf(d.contact)),
      q(status),
      q('sslcommerz'),
      q('পুরনো ওয়েবসাইট থেকে আনা (প্রথম দানের ফর্ম)'),
      q(status === 'paid' ? iso(d.created_at) : null),
      q(iso(d.created_at)),
      q(iso(d.created_at)),
    ].join(', ')})`,
  );
}

// Public notices (posts), cleaned.
let notices = 0;
for (const p of t.wp_posts) {
  if (p.post_type !== 'post' || p.post_status !== 'publish') continue;
  notices++;
  const body = sanitizeHtml(p.post_content).replace(/<p>\s*<\/p>/g, '').trim();
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  sql.push(
    `INSERT OR IGNORE INTO blog_posts (id, slug, title, excerpt, body_html, category, status, author_name, legacy_wp_id, published_at, created_at, updated_at) VALUES (${[
      q(`post_wp${p.ID}`),
      q(decodeURIComponent(p.post_name)),
      q(p.post_title),
      q(text.slice(0, 220)),
      q(body),
      q('নোটিশ'),
      q('published'),
      q('মাদরাসাতুল ইনসাফ'),
      Number(p.ID),
      q(iso(p.post_date_gmt)),
      q(iso(p.post_date_gmt)),
      q(iso(p.post_modified_gmt ?? p.post_date_gmt)),
    ].join(', ')})`,
  );
}

const out = path.join(os.tmpdir(), `insaf-import-${Date.now()}.sql`);
fs.writeFileSync(out, `${sql.join(';\n')};\n`);
console.log(`Funds ${t.wp_dmp_categories.length}, donations ${t.wp_dmp_transactions.length + t.wp_donations.length} (${paid} paid, ${paidMinor / 100} Tk), notices ${notices}`);
console.log(`SQL: ${out}`);
if (flag('dry')) process.exit(0);

const env = arg('env');
const args = ['wrangler', 'd1', 'execute', 'DB', '--file', out, '--yes', ...(flag('remote') ? ['--remote'] : ['--local']), ...(env ? ['--env', env] : [])];
execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
fs.rmSync(out);
