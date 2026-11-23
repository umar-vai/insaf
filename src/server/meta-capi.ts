// Meta Conversions API: tells Meta about a confirmed gift from our server, so ad
// results are not lost to ad blockers or a donor who never opens the receipt page.
//
// Off until META_CAPI_TOKEN (a secret) is set. The event id equals the one the
// browser Pixel sends on the receipt page (`purchase-<reference>`), so Meta counts
// a gift once even when both arrive. Only a gift our own validation marked paid is
// ever sent. Phone and email are sent SHA-256 hashed, as Meta requires; nothing
// else about the donor leaves the site. A failure here never touches the payment.

export type CapiEnv = { META_PIXEL_ID?: string; META_CAPI_TOKEN?: string; ENVIRONMENT?: string; META_CAPI_TEST_CODE?: string };

export type CapiGift = { reference: string; amountMinor: number; phone: string; email: string; paidAt?: string | null };

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 01712345678 and +8801712345678 both become 8801712345678, the form Meta matches on. */
export function metaPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (/^01\d{9}$/.test(digits)) return `88${digits}`;
  if (/^8801\d{9}$/.test(digits)) return digits;
  return '';
}

export async function buildPurchaseEvent(gift: CapiGift, origin: string) {
  const phone = metaPhone(gift.phone);
  const email = gift.email.trim().toLowerCase();
  const userData: Record<string, string[]> = {};
  if (phone) userData.ph = [await sha256(phone)];
  if (email.includes('@')) userData.em = [await sha256(email)];
  const when = gift.paidAt ? Math.floor(new Date(gift.paidAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return {
    event_name: 'Purchase',
    event_time: Number.isFinite(when) ? when : Math.floor(Date.now() / 1000),
    event_id: `purchase-${gift.reference}`,
    action_source: 'website',
    event_source_url: `${origin}/donate/done?ref=${gift.reference}`,
    user_data: userData,
    custom_data: { value: gift.amountMinor / 100, currency: 'BDT' },
  };
}

/** True only when the Pixel id and the secret token are both set, on the live site. */
export function capiConfigured(env: CapiEnv): boolean {
  return env.ENVIRONMENT === 'production' && /^\d{10,20}$/.test(env.META_PIXEL_ID ?? '') && Boolean(env.META_CAPI_TOKEN);
}

export async function sendPurchase(env: CapiEnv, gift: CapiGift, origin: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!capiConfigured(env)) return false;
  try {
    const body: Record<string, unknown> = { data: [await buildPurchaseEvent(gift, origin)] };
    if (env.META_CAPI_TEST_CODE) body.test_event_code = env.META_CAPI_TEST_CODE;
    const res = await fetcher(`https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN!)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
