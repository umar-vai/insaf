import { readCookie, readSession, SESSION_COOKIE } from './session';

// Who may use /admin.
//
// Two ways to prove who someone is:
//  1. Cloudflare Access in front of /admin, whose signed token we verify here.
//  2. The site's own sign-in (Google, or a password the owner set), the same
//     one students use. Both prove the person controls that email address.
// Whether they are staff is then decided here:
// the owners in ADMIN_EMAILS (a secret, cannot be removed in the admin) plus
// the staff table that owners manage on /admin/team. With neither, nobody
// gets in. ADMIN_DEV_BYPASS=1 works only on localhost, for development.

export type StaffEnv = {
  DB?: D1Database;
  SESSION_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
  ADMIN_DEV_BYPASS?: string;
};

type Jwk = JsonWebKey & { kid: string };
let jwksCache: { domain: string; keys: Jwk[]; at: number } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function accessKeys(domain: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('access_certs_unavailable');
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { domain, keys, at: Date.now() };
  return keys;
}

/** The email Cloudflare Access signed in, staff or not. Null without a valid token. */
export async function accessEmail(request: Request, env: StaffEnv): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid: string; alg: string };
    if (header.alg !== 'RS256') return null;
    const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { aud: string | string[]; exp: number; iss: string; email?: string };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const accepted = env.ACCESS_AUD.split(',').map((a) => a.trim()).filter(Boolean);
    if (!aud.some((a) => accepted.includes(a)) || claims.exp * 1000 < Date.now() || claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    return claims.email?.toLowerCase() || null;
  } catch {
    return null;
  }
}

export const ownerEmails = (env: StaffEnv) =>
  (env.ADMIN_EMAILS ?? '')
    .toLowerCase()
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

export const isOwner = (env: StaffEnv, email: string) => email === 'dev@localhost' || ownerEmails(env).includes(email.toLowerCase());

export async function isStaffEmail(env: StaffEnv, email: string): Promise<boolean> {
  const e = email.toLowerCase();
  if (ownerEmails(env).includes(e)) return true;
  if (!env.DB) return false;
  return Boolean(await env.DB.prepare('SELECT 1 AS ok FROM staff WHERE email = ?').bind(e).first());
}

/** The email of the student session in this request, if any. */
export async function sessionEmail(request: Request, env: StaffEnv): Promise<string | null> {
  if (!env.DB) return null;
  const id = await readSession(env, readCookie(request.headers.get('Cookie'), SESSION_COOKIE));
  if (!id) return null;
  const row = await env.DB.prepare('SELECT email FROM students WHERE id = ?').bind(id).first<{ email: string }>();
  return row?.email.toLowerCase() ?? null;
}

/** Returns the signed-in staff email, or null when the request is not allowed. */
export async function staffEmail(request: Request, env: StaffEnv): Promise<string | null> {
  return (await staffAccess(request, env))?.email ?? null;
}

// ---- Which part of the admin --------------------------------------------
// Owners see everything. Each team member is given online courses (the
// website: orders, students, courses, blog, reviews), offline courses (the
// in-person ledger), or both.

export const STAFF_SCOPES = ['all', 'online', 'offline'] as const;
export type StaffScope = (typeof STAFF_SCOPES)[number];
/** shared: anyone on the team. both: only people with both parts (the owner's money pages). */
export type AdminArea = 'online' | 'offline' | 'shared' | 'both';

export const canUse = (scope: StaffScope, area: AdminArea) => area === 'shared' || scope === 'all' || (area !== 'both' && scope === area);

/** Which part of the admin a path belongs to. */
export function adminArea(pathname: string): AdminArea {
  if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/team')) return 'shared';
  if (pathname === '/admin/offline' || pathname.startsWith('/admin/offline/')) return 'offline';
  if (pathname === '/admin/finance' || pathname.startsWith('/admin/finance/')) return 'both';
  return 'online';
}

/** Where someone lands on /admin. */
export const adminHome = (scope: StaffScope) => (scope === 'offline' ? '/admin/offline' : '/admin/dashboard');

/** Null when the email is not staff at all. */
export async function staffScope(env: StaffEnv, email: string): Promise<StaffScope | null> {
  const e = email.toLowerCase();
  if (e === 'dev@localhost' || ownerEmails(env).includes(e)) return 'all';
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT scope FROM staff WHERE email = ?').bind(e).first<{ scope: string }>();
  if (!row) return null;
  return (STAFF_SCOPES as readonly string[]).includes(row.scope) ? (row.scope as StaffScope) : 'online';
}

// ---- Modules ---------------------------------------------------------------
// Finer than online/offline: an owner gives each team member the modules they
// need (for example "accounts only"). A member saved before modules existed
// gets the modules of their part. Owners have every module, plus the owner
// pages (system settings, audit log).

export const MODULES = ['online_sales', 'online_content', 'office', 'academic', 'hr', 'accounts', 'finance'] as const;
export type Module = (typeof MODULES)[number];
export const MODULE_BN: Record<Module, { label: string; hint: string; area: 'online' | 'offline' | 'both' }> = {
  online_sales: { label: 'দান ও দাতা', hint: 'ড্যাশবোর্ড, দানের তালিকা, দাতা (CRM), তহবিল, অফিসে পাওয়া দান', area: 'online' },
  online_content: { label: 'ওয়েবসাইট কনটেন্ট', hint: 'পাবলিক নোটিশ ও খবর', area: 'online' },
  office: { label: 'অফিস', hint: 'মাদরাসা ড্যাশবোর্ড, ছাত্র ও ভর্তি, ভর্তির আবেদন, ফি আদায়, একসাথে ফি বিল, বকেয়া, সনদ, বার্তা, পোর্টাল লগইন, টিকেট', area: 'offline' },
  academic: { label: 'একাডেমিক', hint: 'বিভাগ ও ক্লাস, রুটিন, পরীক্ষা, হাজিরা, ছাত্রের ছুটি, লাইব্রেরি, নোটিশ', area: 'offline' },
  hr: { label: 'শিক্ষক ও বেতন', hint: 'শিক্ষক ও কর্মী, কর্মীর হাজিরা, ছুটি, বেতন শিট, পে স্লিপ', area: 'offline' },
  accounts: { label: 'হিসাব', hint: 'খরচ ও ভাউচার, আয় ব্যয় রিপোর্ট, অনলাইনে আসা ফি, Excel', area: 'offline' },
  finance: { label: 'মোট আয় ব্যয়', hint: 'দান ও ফি মিলিয়ে আয়, খরচ, উদ্বৃত্ত', area: 'both' },
};

export function scopeModules(scope: StaffScope): Module[] {
  if (scope === 'online') return ['online_sales', 'online_content'];
  if (scope === 'offline') return ['office', 'academic', 'hr', 'accounts'];
  return [...MODULES];
}

// ---- Levels ----------------------------------------------------------------
// Each module is given at a level. view: open the pages, change nothing.
// edit: the daily work (take fees, write expenses, mark attendance). full:
// also the decisions that used to be the owner's alone in that module
// (approve expenses, leave and salary; void receipts and expenses; pay
// salary). Stored in staff.modules as "module:level,..."; a bare module name
// (saved before levels existed) means edit.

export const LEVELS = ['view', 'edit', 'full'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_BN: Record<Level | 'none', string> = { none: 'নেই', view: 'শুধু দেখতে পারবে', edit: 'দেখা ও কাজ করা', full: 'সম্পূর্ণ (অনুমোদন ও বাতিলসহ)' };
const RANK: Record<Level, number> = { view: 1, edit: 2, full: 3 };
export type Grants = Partial<Record<Module, Level>>;

export function parseGrants(raw: string | null | undefined): Grants {
  const out: Grants = {};
  for (const part of String(raw ?? '').split(',')) {
    const [m, l] = part.trim().split(':') as [string, string | undefined];
    if (!(MODULES as readonly string[]).includes(m)) continue;
    const level = l === undefined ? 'edit' : l;
    if ((LEVELS as readonly string[]).includes(level)) out[m as Module] = level as Level;
  }
  return out;
}

export const grantsText = (g: Grants) =>
  MODULES.filter((m) => g[m])
    .map((m) => `${m}:${g[m]}`)
    .join(',');

export function parseModules(raw: string | null | undefined): Module[] {
  return Object.keys(parseGrants(raw)) as Module[];
}

// ---- Ready made roles ----------------------------------------------------------
// Picking a role on the team page fills in the levels below (limited to the
// online part, the offline part or both); each can still be changed.

export const ROLES = ['admin', 'manager', 'accountant', 'office', 'content', 'teacher', 'viewer', 'custom'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_BN: Record<Role, { label: string; hint: string }> = {
  admin: { label: 'অ্যাডমিন', hint: 'বাছাই করা অংশে সব ক্ষমতা, অনুমোদন ও বাতিলসহ' },
  manager: { label: 'ম্যানেজার', hint: 'সব কাজ করতে পারবে, অনুমোদন ও বাতিল ছাড়া' },
  accountant: { label: 'হিসাবরক্ষক', hint: 'হিসাব ও বেতনে সম্পূর্ণ, বাকিগুলো শুধু দেখা' },
  office: { label: 'অফিস সহকারী', hint: 'ভর্তি, ফি আদায়, বকেয়া, হাজিরা, নোটিশ, অফিসে পাওয়া দান' },
  content: { label: 'কনটেন্ট এডিটর', hint: 'ওয়েবসাইটের নোটিশ ও খবর' },
  teacher: { label: 'শিক্ষক', hint: 'শিক্ষক প্যানেল পাবেন, অ্যাডমিনে ক্লাস ও রুটিন শুধু দেখা' },
  viewer: { label: 'শুধু দেখবে', hint: 'বাছাই করা অংশ দেখতে পারবে, কিছু বদলাতে পারবে না' },
  custom: { label: 'নিজে বাছাই', hint: 'প্রতিটি অংশের ক্ষমতা নিচে হাতে বাছুন' },
};
export type AreaChoice = 'online' | 'offline' | 'both';

const ROLE_GRANTS: Record<Exclude<Role, 'custom'>, Grants> = {
  admin: { online_sales: 'full', online_content: 'full', office: 'full', academic: 'full', hr: 'full', accounts: 'full', finance: 'full' },
  manager: { online_sales: 'edit', online_content: 'edit', office: 'edit', academic: 'edit', hr: 'edit', accounts: 'edit', finance: 'view' },
  accountant: { online_sales: 'view', office: 'view', hr: 'full', accounts: 'full', finance: 'view' },
  office: { online_sales: 'edit', office: 'edit', academic: 'edit' },
  content: { online_content: 'edit' },
  teacher: { academic: 'view' },
  viewer: { online_sales: 'view', online_content: 'view', office: 'view', academic: 'view', hr: 'view', accounts: 'view', finance: 'view' },
};

/** The levels a role gives within the chosen part. "Totals" (finance) needs both parts. */
export function roleGrants(role: Role, area: AreaChoice): Grants {
  if (role === 'custom') return {};
  const out: Grants = {};
  for (const [m, l] of Object.entries(ROLE_GRANTS[role]) as [Module, Level][]) {
    const a = MODULE_BN[m].area;
    if (area === 'both' || a === area) out[m] = l;
  }
  return out;
}

/** Reads the level selects of the team form ("level_<module>"). */
export function grantsFromForm(form: FormData): Grants {
  const out: Grants = {};
  for (const m of MODULES) {
    const l = String(form.get(`level_${m}`) ?? '');
    if ((LEVELS as readonly string[]).includes(l)) out[m] = l as Level;
  }
  return out;
}

/** The scope that matches a set of modules (kept so older checks still work). */
export function scopeOf(modules: readonly Module[]): StaffScope {
  const online = modules.some((m) => MODULE_BN[m].area === 'online');
  const offline = modules.some((m) => MODULE_BN[m].area === 'offline');
  return online && !offline ? 'online' : offline && !online ? 'offline' : 'all';
}

/** Which module a page belongs to. shared: any team member. owner: owners only. */
export function adminModule(pathname: string): Module | 'shared' | 'owner' {
  const p = pathname.replace(/\/$/, '') || '/admin';
  const under = (...bases: string[]) => bases.some((b) => p === b || p.startsWith(`${b}/`));
  if (p === '/admin' || under('/admin/team')) return 'shared';
  if (under('/admin/system', '/admin/audit')) return 'owner';
  if (under('/admin/finance')) return 'finance';
  if (under('/admin/offline/sessions', '/admin/offline/results', '/admin/offline/gradebook', '/admin/offline/homework', '/admin/offline/batches', '/admin/offline/attendance', '/admin/offline/courses', '/admin/offline/notices', '/admin/offline/library', '/admin/offline/student-leave')) return 'academic';
  if (under('/admin/offline/teachers', '/admin/offline/leave', '/admin/offline/payroll', '/admin/offline/payslip', '/admin/offline/staff-attendance')) return 'hr';
  if (under('/admin/offline/expenses', '/admin/offline/voucher', '/admin/offline/reports', '/admin/offline/online-payments', '/admin/offline/export')) return 'accounts';
  if (under('/admin/offline')) return 'office';
  if (under('/admin/notices', '/admin/blog')) return 'online_content';
  return 'online_sales';
}

/** Pages only for owners and those with the full level in the module (the admin role): the visits log. */
const FULL_ONLY = ['/admin/visits'];
export const needsFull = (pathname: string) => FULL_ONLY.some((b) => pathname === b || pathname.startsWith(`${b}/`));

export type StaffAccessInfo = { email: string; scope: StaffScope; modules: Module[]; grants: Grants; owner: boolean };

export const mayOpen = (a: Pick<StaffAccessInfo, 'modules' | 'owner'>, m: Module | 'shared' | 'owner') =>
  m === 'shared' ? true : m === 'owner' ? a.owner : a.owner || a.modules.includes(m);

/** True when the person may do something needing this level in the module. Owners may do everything. */
export function mayDo(a: { owner?: boolean; grants?: Grants }, m: Module, need: Level): boolean {
  if (a.owner) return true;
  const have = a.grants?.[m];
  return Boolean(have && RANK[have] >= RANK[need]);
}

/** mayOpen for a whole path, including pages that need the full level. */
export function mayOpenPath(a: { modules: Module[]; owner: boolean; grants?: Grants }, pathname: string): boolean {
  const m = adminModule(pathname);
  if (!mayOpen(a, m)) return false;
  return !needsFull(pathname) || m === 'shared' || m === 'owner' || mayDo(a, m, 'full');
}

/** The same check from an admin page's locals. */
export const localsMayDo = (l: { staffOwner?: boolean; staffGrants?: Grants }, m: Module, need: Level) => mayDo({ owner: l.staffOwner, grants: l.staffGrants }, m, need);

const ALL_FULL: Grants = Object.fromEntries(MODULES.map((m) => [m, 'full'])) as Grants;

/** True when the person has any module of that part (online courses or offline courses). */
export const inArea = (a: Pick<StaffAccessInfo, 'modules' | 'owner'>, area: 'online' | 'offline') =>
  a.owner || a.modules.some((m) => MODULE_BN[m].area === area);

/** Where someone lands on /admin: the first page they may open. */
export function homeFor(a: Pick<StaffAccessInfo, 'modules' | 'owner'>): string {
  if (a.owner || a.modules.includes('online_sales')) return '/admin/dashboard';
  if (a.modules.includes('office')) return '/admin/offline';
  const first: Record<Module, string> = {
    online_sales: '/admin/dashboard',
    online_content: '/admin/blog',
    office: '/admin/offline',
    academic: '/admin/offline/batches',
    hr: '/admin/offline/teachers',
    accounts: '/admin/offline/expenses',
    finance: '/admin/finance',
  };
  // A teacher on the team with no admin part goes to the teacher panel.
  return a.modules[0] ? first[a.modules[0]] : '/teacher';
}

/** The modules of a staff email, or null when not staff. */
export async function staffModules(env: StaffEnv, email: string): Promise<{ scope: StaffScope; modules: Module[]; grants: Grants; owner: boolean } | null> {
  const e = email.toLowerCase();
  if (e === 'dev@localhost' || ownerEmails(env).includes(e)) return { scope: 'all', modules: [...MODULES], grants: ALL_FULL, owner: true };
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT scope, modules, role FROM staff WHERE email = ?').bind(e).first<{ scope: string; modules: string; role: string }>();
  if (!row) return null;
  const scope = (STAFF_SCOPES as readonly string[]).includes(row.scope) ? (row.scope as StaffScope) : 'online';
  // Members saved before modules existed: their part, at the daily work level.
  // (Those rows have no modules and no role; a teacher may have no modules on purpose.)
  const legacy = !row.modules && (!row.role || row.role === 'custom');
  const grants: Grants = legacy ? Object.fromEntries(scopeModules(scope).map((m) => [m, 'edit'])) : parseGrants(row.modules);
  const modules = Object.keys(grants) as Module[];
  return { scope: legacy ? scope : scopeOf(modules), modules, grants, owner: false };
}

/** The signed-in staff member and what they may use, or null. */
export async function staffAccess(request: Request, env: StaffEnv): Promise<StaffAccessInfo | null> {
  const host = new URL(request.url).hostname;
  if (env.ADMIN_DEV_BYPASS === '1' && (host === 'localhost' || host === '127.0.0.1')) return { email: 'dev@localhost', scope: 'all', modules: [...MODULES], grants: ALL_FULL, owner: true };
  for (const email of [await accessEmail(request, env), await sessionEmail(request, env)]) {
    if (!email) continue;
    const m = await staffModules(env, email);
    if (m) return { email, ...m };
  }
  return null;
}

export function noAccessResponse(home: string): Response {
  const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>অনুমতি নেই</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#04261a;color:#e9f3ec;font-family:system-ui,sans-serif">
<main style="max-width:28rem;padding:24px"><h1 style="font-size:22px">এই অংশে আপনার অনুমতি নেই</h1>
<p style="color:#a9c3b2;line-height:1.7">মালিক আপনাকে অ্যাডমিন প্যানেলের অন্য অংশের জন্য অনুমতি দিয়েছেন। দরকার হলে মালিককে টিম পেজ থেকে অনুমতি বদলাতে বলুন।</p>
<p><a href="${home}" style="color:#dcbb6e">আমার অংশে যান</a></p></main></body></html>`;
  return new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
}

export function viewOnlyResponse(back: string): Response {
  const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>শুধু দেখার অনুমতি</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#04261a;color:#e9f3ec;font-family:system-ui,sans-serif">
<main style="max-width:28rem;padding:24px"><h1 style="font-size:22px">এই অংশে আপনি শুধু দেখতে পারবেন</h1>
<p style="color:#a9c3b2;line-height:1.7">কিছু বদলানো বা সংরক্ষণ করার অনুমতি নেই, তাই কিছুই বদলায়নি। দরকার হলে মালিককে টিম পেজ থেকে ক্ষমতা বাড়াতে বলুন।</p>
<p><a href="${back.replace(/[^\w/.-]/g, '')}" style="color:#dcbb6e">ফিরে যান</a></p></main></body></html>`;
  return new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function notStaffResponse(email: string | null): Response {
  const who = email ? `<p>আপনি <strong>${escapeHtml(email)}</strong> দিয়ে লগইন করেছেন, যেটি মাদরাসাতুল ইনসাফের টিমের তালিকায় নেই।</p>` : '';
  const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>শুধু মাদরাসাতুল ইনসাফ টিমের জন্য</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#04261a;color:#e9f3ec;font-family:system-ui,sans-serif">
<main style="max-width:28rem;padding:24px"><h1 style="font-size:22px">শুধু মাদরাসাতুল ইনসাফ টিমের জন্য</h1>${who}
<p style="color:#a9c3b2;line-height:1.7">অ্যাডমিনকে বলুন টিম পেজে আপনার ইমেইল যোগ করতে, তারপর আবার লগইন করুন।</p>
<p><a href="/account" style="color:#dcbb6e">আমার অ্যাকাউন্টে যান</a> (সেখান থেকে লগআউট করে অন্য ইমেইল দিয়ে ঢুকতে পারবেন)</p></main></body></html>`;
  return new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
}

export const isEmail = (v: string) => /^[^\s@<>"',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(v);
