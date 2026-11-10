import { Hono } from 'hono';
import { isTestSite } from '../lib/envs';
import { finishGoogleSignIn, googleConfigured, startGoogleSignIn, STATE_COOKIE } from '../server/google';
import { issueLoginCode, normalizeEmail, verifyLoginCode } from '../server/login-code';
import { sendLoginCode } from '../server/mail';
import { currentStudent, studentForEmail, studentForGoogle } from '../server/students';
import { downloadResponse } from '../server/files';
import { inArea, staffAccess } from '../server/staff';
import { track } from '../server/activity';
import { gatewayHandoffPage, sslConfigured, startPaymentSession, validatePayment } from '../server/sslcommerz';
import { applyFeeValidation, createFeePayment, isFeeReference, markFeeUnpaid } from '../server/fee-pay';
import { applyDonationValidation, createDonation, isDonationReference, markDonationUnpaid, parseDonationForm } from '../server/donations';
import { changePassword, signInWithPassword } from '../server/password';
import { landingFor, materialFile, studentPanel } from '../server/panels';
import { masterRoutine, mayReadRoutine } from '../server/academic';
import { noticeFile } from '../server/office';
import { gatewayEnv } from '../server/config';
import { getSettings } from '../server/settings';
import { todayDhaka } from '../lib/offline';
import { updateProfile } from '../server/account';
import { clearCookie, readCookie, safeReturnTo, sameOrigin, SESSION_COOKIE, sessionCookie, signSession } from '../server/session';

export const api = new Hono<{ Bindings: Env }>();

// Holds the email (and where to go after) between the two sign-in steps.
const LOGIN_COOKIE = 'tm_login';
const DEV_CODE_COOKIE = 'tm_dev_code';
const isSecure = (url: string) => new URL(url).protocol === 'https:';
// Only sites without real students may show the sign-in code on the page.
const devShowCode = (env: Env) => isTestSite(env) && env.DEV_SHOW_LOGIN_CODE === '1';
const me = (c: { env: Env; req: { header(n: string): string | undefined } }) => currentStudent(c.env.DB, c.env, c.req.header('Cookie') ?? null);

api.get('/api/health', (c) => c.json({ ok: true }));

// Public images: fund covers and story pictures, blog and brand images
// uploaded in the admin, and the pictures imported from the old site
// (site/<name>.webp). Nothing under private/ ever matches.
const PUBLIC_MEDIA = /^(?:site\/[A-Za-z0-9_-]+\.webp|uploads\/(?:funds|blog|brand)\/[a-f0-9]{16}\.(?:webp|jpg|png))$/;
api.get('/media/*', async (c) => {
  const key = c.req.path.slice('/media/'.length);
  if (!PUBLIC_MEDIA.test(key)) return c.notFound();
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: object.httpEtag,
    },
  });
});

// Every POST below changes something, so it must come from our own pages.
// The exception is SSLCommerz posting back to /api/pay/sslcommerz/*; nothing
// it sends is trusted until its validation API confirms the payment.
api.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const fromGateway = c.req.path.startsWith('/api/pay/sslcommerz/');
  if (c.req.method === 'POST' && !fromGateway && !sameOrigin(c.req.raw)) return c.json({ error: 'forbidden' }, 403);
  await next();
});

// ---- Mobile number (or email) and password -------------------------------------

api.post('/api/auth/password', async (c) => {
  const form = await c.req.formData();
  const returnTo = safeReturnTo(String(form.get('return') ?? ''));
  const back = (error: string) => c.redirect(`/account?return=${encodeURIComponent(returnTo)}&error=${error}`, 303);
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  if (c.env.LOGIN_LIMITER && !(await c.env.LOGIN_LIMITER.limit({ key: ip })).success) return back('too_many');
  const id = await signInWithPassword(c.env.DB, String(form.get('login') ?? '').slice(0, 120), String(form.get('password') ?? '').slice(0, 100));
  if (!id) return back('password');
  await track(c.env, { kind: 'login', studentId: id, detail: 'password' });
  c.header('Set-Cookie', sessionCookie(await signSession(c.env, id), isSecure(c.req.url)), { append: true });
  return c.redirect(await landingFor(c.env.DB, id, returnTo), 303);
});

api.post('/api/account/password', async (c) => {
  const account = await me(c);
  if (!account) return c.redirect('/account?return=%2Faccount%2Fprofile', 303);
  const form = await c.req.formData();
  const next = String(form.get('new') ?? '');
  if (next !== String(form.get('again') ?? '')) return c.redirect('/account/profile?pw=mismatch', 303);
  const result = await changePassword(c.env.DB, account.id, String(form.get('current') ?? ''), next);
  return c.redirect(`/account/profile?pw=${result}`, 303);
});

// ---- Email code sign-in (test sites only) ----------------------------------------

api.post('/api/auth/code', async (c) => {
  if (!isTestSite(c.env)) return c.redirect('/account', 303);
  const form = await c.req.formData();
  const email = normalizeEmail(form.get('email'));
  const returnTo = safeReturnTo(String(form.get('return') ?? ''));
  const back = `/account?return=${encodeURIComponent(returnTo)}`;
  if (!email) return c.redirect(`${back}&error=email`, 303);

  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  if (c.env.LOGIN_LIMITER && !(await c.env.LOGIN_LIMITER.limit({ key: ip })).success) {
    return c.redirect(`${back}&error=too_many`, 303);
  }
  const issued = await issueLoginCode(c.env.DB, c.env, email);
  if (!issued.ok) return c.redirect(`${back}&error=too_many`, 303);
  const sent = await sendLoginCode(c.env, email, issued.code);
  if (sent === 'failed') return c.redirect(`${back}&error=mail`, 303);

  const secure = isSecure(c.req.url);
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure ? '; Secure' : ''}`;
  c.header('Set-Cookie', `${LOGIN_COOKIE}=${encodeURIComponent(`${email}|${returnTo}`)}; ${flags}`, { append: true });
  if (devShowCode(c.env)) c.header('Set-Cookie', `${DEV_CODE_COOKIE}=${issued.code}; ${flags}`, { append: true });
  return c.redirect('/account/code', 303);
});

api.post('/api/auth/verify', async (c) => {
  if (!isTestSite(c.env)) return c.redirect('/account', 303);
  const form = await c.req.formData();
  const [email, returnTo] = decodeURIComponent(readCookie(c.req.header('Cookie'), LOGIN_COOKIE) ?? '').split('|');
  if (!email) return c.redirect('/account?error=expired', 303);
  const code = String(form.get('code') ?? '').replace(/[^\d০-৯]/g, '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
  const result = await verifyLoginCode(c.env.DB, c.env, email, code);
  if (!result.ok) return c.redirect(`/account/code?error=${result.reason}`, 303);

  const id = await studentForEmail(c.env.DB, email);
  await track(c.env, { kind: 'login', studentId: id, detail: 'email' });
  const secure = isSecure(c.req.url);
  c.header('Set-Cookie', sessionCookie(await signSession(c.env, id), secure), { append: true });
  c.header('Set-Cookie', clearCookie(LOGIN_COOKIE, secure), { append: true });
  c.header('Set-Cookie', clearCookie(DEV_CODE_COOKIE, secure), { append: true });
  return c.redirect(await landingFor(c.env.DB, id, safeReturnTo(returnTo)), 303);
});

// ---- Google sign-in ------------------------------------------------------

api.get('/api/auth/google', async (c) => {
  if (!googleConfigured(c.env)) return c.redirect('/account?error=google_off', 302);
  const url = new URL(c.req.url);
  const start = await startGoogleSignIn(c.env, url.origin, safeReturnTo(c.req.query('return')), isSecure(c.req.url));
  c.header('Set-Cookie', start.cookie);
  return c.redirect(start.url, 302);
});

api.get('/api/auth/google/callback', async (c) => {
  const url = new URL(c.req.url);
  const secure = isSecure(c.req.url);
  c.header('Set-Cookie', clearCookie(STATE_COOKIE, secure, '/api/auth'), { append: true });
  if (!googleConfigured(c.env) || c.req.query('error')) return c.redirect('/account?error=cancelled', 302);
  const done = await finishGoogleSignIn(c.env, url.origin, c.req.query(), readCookie(c.req.header('Cookie'), STATE_COOKIE));
  if (!done.ok) return c.redirect('/account?error=failed', 302);
  const id = await studentForGoogle(c.env.DB, done.profile);
  await track(c.env, { kind: 'login', studentId: id, detail: 'google' });
  c.header('Set-Cookie', sessionCookie(await signSession(c.env, id), secure), { append: true });
  return c.redirect(await landingFor(c.env.DB, id, done.returnTo), 302);
});

api.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', clearCookie(SESSION_COOKIE, isSecure(c.req.url)));
  return c.redirect('/', 303);
});

// ---- Donations -------------------------------------------------------------
// Anyone may give without an account. The amount is kept on our side when the
// payment starts; it counts only after SSLCommerz's validation API agrees.

api.post('/api/donate', async (c) => {
  const form = await c.req.formData();
  const fund = String(form.get('fund') ?? '').replace(/[^a-z0-9-]/g, '').slice(0, 60);
  const from = String(form.get('from') ?? '');
  const backTo = from.startsWith('/') && !from.startsWith('//') && from.length < 200 ? from : fund ? `/donate/${fund}` : '/donate';
  const back = (error: string) => c.redirect(`${backTo}${backTo.includes('?') ? '&' : '?'}error=${error}#donate-form`, 303);
  const parsed = parseDonationForm(form);
  if (!parsed.ok) return back(parsed.error);
  const gw = await gatewayEnv(c.env.DB, c.env);
  if (!sslConfigured(gw)) return back('off');
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  if (c.env.CHECKOUT_LIMITER && !(await c.env.CHECKOUT_LIMITER.limit({ key: `donate:${ip}` })).success) return back('too_many');
  const created = await createDonation(c.env.DB, parsed.value);
  if (!created.ok) return back('fund');
  const d = created.donation;
  const session = await startPaymentSession(gw, {
    reference: d.reference,
    amountMinor: d.amountMinor,
    productName: `${d.fundTitle} - দান`,
    customer: {
      name: d.donorName,
      email: d.donorEmail || 'donor@madrasatulinsaf.org',
      phone: d.donorPhone || '01700000000',
    },
    origin: new URL(c.req.url).origin,
  });
  if (!session.ok) {
    await markDonationUnpaid(c.env.DB, d.reference, 'failed', { stage: 'session', reason: session.reason });
    return back('gateway');
  }
  return c.html(gatewayHandoffPage(session.url));
});

// An offline student pays a fee online. Only their own enrollments (matched by
// the account's email) can be paid, and only an amount the server works out.
api.post('/api/offline-fee', async (c) => {
  const form = await c.req.formData();
  const back = (error: string) => c.redirect(`/account/offline/fees?error=${error}`, 303);
  const account = await me(c);
  if (!account) return c.redirect('/account?return=%2Faccount%2Foffline%2Ffees', 303);
  const gw = await gatewayEnv(c.env.DB, c.env);
  if (!sslConfigured(gw) || !(await getSettings(c.env.DB)).onlineFees) return back('off');
  if (c.env.CHECKOUT_LIMITER && !(await c.env.CHECKOUT_LIMITER.limit({ key: account.id })).success) return back('too_many');
  const panel = await studentPanel(c.env.DB, account.email, todayDhaka());
  const created = await createFeePayment(c.env.DB, account, panel.enrollments, String(form.get('enrollmentId') ?? ''), String(form.get('choice') ?? ''));
  if (!created.ok) return back(created.reason);
  const session = await startPaymentSession(gw, {
    reference: created.payment.reference,
    amountMinor: created.payment.amountMinor,
    productName: created.title,
    customer: { name: created.name, email: account.email.includes('@phone.') ? 'student@madrasatulinsaf.org' : account.email, phone: created.phone },
    origin: new URL(c.req.url).origin,
  });
  if (!session.ok) {
    await markFeeUnpaid(c.env.DB, created.payment.reference, 'failed', { stage: 'session', reason: session.reason });
    return back('gateway');
  }
  return c.html(gatewayHandoffPage(session.url));
});

/** Reads tran_id and val_id from SSLCommerz's form post. */
async function gatewayPost(c: { req: { formData(): Promise<FormData> } }) {
  const form = await c.req.formData().catch(() => new FormData());
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && /^[\w.-]{1,80}$/.test(v) ? v : undefined;
  };
  return { reference: get('tran_id'), valId: get('val_id'), status: get('status') };
}

// Fees use references starting "TF-", donations "DN-".
const feeDone = (reference: string) => `/account/offline/fees?pay=${reference}`;
const donationDone = (reference: string) => `/donate/done?ref=${reference}`;

async function validateAndApply(env: Env, reference: string | undefined, valId: string | undefined) {
  if (!reference || !valId) return;
  const gw = await gatewayEnv(env.DB, env);
  if (!sslConfigured(gw)) return;
  const v = await validatePayment(gw, valId);
  if (isFeeReference(reference)) await applyFeeValidation(env.DB, v, reference);
  else if (isDonationReference(reference)) await applyDonationValidation(env.DB, v, reference);
}

api.post('/api/pay/sslcommerz/success', async (c) => {
  const { reference, valId } = await gatewayPost(c);
  await validateAndApply(c.env, reference, valId);
  if (isFeeReference(reference)) return c.redirect(feeDone(reference!), 303);
  return c.redirect(reference ? donationDone(reference) : '/donate', 303);
});

for (const kind of ['fail', 'cancel'] as const) {
  api.post(`/api/pay/sslcommerz/${kind}`, async (c) => {
    const { reference, status } = await gatewayPost(c);
    const to = kind === 'fail' ? 'failed' : 'cancelled';
    if (isFeeReference(reference)) {
      await markFeeUnpaid(c.env.DB, reference!, to, { status });
      return c.redirect(feeDone(reference!), 303);
    }
    if (reference && isDonationReference(reference)) await markDonationUnpaid(c.env.DB, reference, to, { status });
    return c.redirect(reference ? donationDone(reference) : '/donate', 303);
  });
}

// Server to server notice from SSLCommerz. It may arrive before or after the
// donor's browser comes back; applying it twice is harmless.
api.post('/api/pay/sslcommerz/ipn', async (c) => {
  const { reference, valId } = await gatewayPost(c);
  await validateAndApply(c.env, reference, valId);
  return c.text('OK');
});

// ---- Private files ---------------------------------------------------------

// Class materials: office staff, the class's teacher, or its active students.
api.get('/api/material/:id', async (c) => {
  const [account, staff] = await Promise.all([me(c), staffAccess(c.req.raw, c.env)]);
  const file = await materialFile(c.env.DB, c.req.param('id'), { staff: Boolean(staff && inArea(staff, 'offline')), email: account?.email ?? null });
  if (!file?.fileKey) return c.text(account || staff ? 'এই ফাইলটি দেখার অনুমতি নেই।' : 'আগে লগইন করুন।', account || staff ? 403 : 401);
  return downloadResponse(c.env.MEDIA, file.fileKey, file.fileName ?? 'file');
});

// A notice's attached file: staff, or the people the notice is for.
api.get('/api/notice-file/:id', async (c) => {
  const [account, staff] = await Promise.all([me(c), staffAccess(c.req.raw, c.env)]);
  const file = await noticeFile(c.env.DB, c.req.param('id'), {
    onlineStaff: Boolean(staff && inArea(staff, 'online')),
    offlineStaff: Boolean(staff && inArea(staff, 'offline')),
    email: account?.email ?? null,
    studentId: account?.id ?? null,
  });
  if (!file) return c.text(account || staff ? 'এই ফাইলটি দেখার অনুমতি নেই।' : 'আগে লগইন করুন।', account || staff ? 403 : 401);
  return downloadResponse(c.env.MEDIA, file.fileKey, file.fileName);
});

// The master routine file: office staff, active teachers and active students.
api.get('/api/routine', async (c) => {
  const [account, staff] = await Promise.all([me(c), staffAccess(c.req.raw, c.env)]);
  const file = await masterRoutine(c.env.DB);
  if (!file) return c.text('রুটিন এখনো আপলোড হয়নি।', 404);
  if (!(await mayReadRoutine(c.env.DB, { staff: Boolean(staff && inArea(staff, 'offline')), email: account?.email ?? null }))) {
    return c.text(account || staff ? 'এই ফাইলটি দেখার অনুমতি নেই।' : 'আগে লগইন করুন।', account || staff ? 403 : 401);
  }
  return downloadResponse(c.env.MEDIA, file.key, file.fileName);
});

// ---- Account -------------------------------------------------------------

api.post('/api/account/profile', async (c) => {
  const account = await me(c);
  if (!account) return c.redirect('/account?return=%2Faccount%2Fprofile', 303);
  const form = await c.req.formData();
  const result = await updateProfile(c.env.DB, account.id, { name: String(form.get('name') ?? ''), phone: String(form.get('phone') ?? '') });
  return c.redirect(result.ok ? '/account/profile?saved=1' : `/account/profile?error=${result.reason}`, 303);
});
