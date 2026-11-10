import { SITE } from '../lib/site';
import { isTestSite } from '../lib/envs';

// Sign-in code emails, sent with Cloudflare Email Sending (the EMAIL binding).
// On local and test sites (no real students) there is no binding: the code is
// printed to the log, and shown on the page when DEV_SHOW_LOGIN_CODE=1.
// Preview and the real site have real students, so there a missing binding
// means sign-in by email code is unavailable, never shown on the page.

export type MailEnv = {
  EMAIL?: SendEmail;
  MAIL_FROM?: string;
  ENVIRONMENT?: string;
};

const bn = (s: string) => s.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);

export function buildCodeEmail(code: string) {
  const subject = `${bn(code)} আপনার মাদরাসাতুল ইনসাফ লগইন কোড`;
  const text = [
    'আসসালামু আলাইকুম,',
    '',
    `মাদরাসাতুল ইনসাফ পোর্টালে লগইন করতে এই কোডটি দিন: ${code}`,
    'কোডটি ১০ মিনিট পর্যন্ত কাজ করবে।',
    '',
    'আপনি লগইন করতে না চাইলে এই ইমেইলটি উপেক্ষা করুন। কাউকে এই কোড দেবেন না।',
    '',
    `${SITE.nameBn} · ${SITE.phone.display}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#fbf9f3;font-family:Arial,sans-serif;color:#13241b">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e2e8dd;border-radius:16px">
<tr><td style="padding:24px;background:#04261a;color:#e3c27a;border-radius:16px 16px 0 0;font-weight:bold">${SITE.nameBn}</td></tr>
<tr><td style="padding:24px;line-height:1.7">
<p style="margin:0 0 12px">আসসালামু আলাইকুম,</p>
<p style="margin:0 0 16px">লগইন করতে এই কোডটি দিন:</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:bold;letter-spacing:8px;color:#0f6b3e">${code}</p>
<p style="margin:0 0 16px;color:#56665c">কোডটি ১০ মিনিট পর্যন্ত কাজ করবে। আপনি লগইন করতে না চাইলে এই ইমেইলটি উপেক্ষা করুন। কাউকে এই কোড দেবেন না।</p>
<p style="margin:0;color:#56665c;font-size:13px">${SITE.nameBn} · ${SITE.phone.display}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export async function sendLoginCode(env: MailEnv, to: string, code: string): Promise<'sent' | 'logged' | 'failed'> {
  const mail = buildCodeEmail(code);
  if (!env.EMAIL) {
    if (isTestSite(env)) {
      console.log(`[login code] ${to}: ${code}`);
      return 'logged';
    }
    return 'failed';
  }
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.MAIL_FROM ?? 'no-reply@madrasatulinsaf.org', name: SITE.nameBn },
      replyTo: SITE.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return 'sent';
  } catch (err) {
    console.error('login code email failed', err);
    return 'failed';
  }
}
