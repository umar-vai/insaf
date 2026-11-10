// SSLCommerz hosted checkout (bKash, Nagad, Rocket, cards and net banking in
// one page). We start a session, send the student there, and when they come
// back, or SSLCommerz calls our IPN, we ask SSLCommerz's validation API
// whether the payment is real. What the browser posts back is never trusted.

export type SslEnv = {
  SSLCZ_STORE_ID?: string;
  SSLCZ_STORE_PASSWORD?: string;
  /** '0' for the live gateway; anything else uses the sandbox. */
  SSLCZ_SANDBOX?: string;
};

export const sslConfigured = (env: SslEnv) => Boolean(env.SSLCZ_STORE_ID && env.SSLCZ_STORE_PASSWORD);

const host = (env: SslEnv) => (env.SSLCZ_SANDBOX === '0' ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com');

/** 99900 poisha -> "999.00", the format SSLCommerz expects. */
export const toTaka = (minor: number) => (minor / 100).toFixed(2);

export type SessionInput = {
  reference: string;
  amountMinor: number;
  productName: string;
  customer: { name: string; email: string; phone: string };
  origin: string;
};

export type SessionResult = { ok: true; url: string } | { ok: false; reason: string };

export async function startPaymentSession(env: SslEnv, input: SessionInput, fetcher: typeof fetch = fetch): Promise<SessionResult> {
  const back = (kind: string) => `${input.origin}/api/pay/sslcommerz/${kind}`;
  const body = new URLSearchParams({
    store_id: env.SSLCZ_STORE_ID!,
    store_passwd: env.SSLCZ_STORE_PASSWORD!,
    total_amount: toTaka(input.amountMinor),
    currency: 'BDT',
    tran_id: input.reference,
    success_url: back('success'),
    fail_url: back('fail'),
    cancel_url: back('cancel'),
    ipn_url: back('ipn'),
    cus_name: input.customer.name,
    cus_email: input.customer.email,
    cus_phone: input.customer.phone,
    // An online course has no delivery address; SSLCommerz still asks for one.
    cus_add1: 'Online',
    cus_city: 'Dhaka',
    cus_country: 'Bangladesh',
    shipping_method: 'NO',
    num_of_item: '1',
    product_name: input.productName.slice(0, 250),
    product_category: 'Education',
    product_profile: 'non-physical-goods',
  });
  let res: Response;
  try {
    res = await fetcher(`${host(env)}/gwprocess/v4/api.php`, { method: 'POST', body });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };
  const data = (await res.json().catch(() => ({}))) as { status?: string; GatewayPageURL?: string; failedreason?: string };
  if (data.status !== 'SUCCESS' || !data.GatewayPageURL?.startsWith('https://')) {
    return { ok: false, reason: data.failedreason ?? 'rejected' };
  }
  return { ok: true, url: data.GatewayPageURL };
}

export type Validation = {
  status: string;
  tran_id?: string;
  val_id?: string;
  amount?: string;
  currency?: string;
  bank_tran_id?: string;
  card_type?: string;
  risk_level?: string;
  risk_title?: string;
};

/** Asks SSLCommerz about one payment. Returns null if it cannot be reached. */
export async function validatePayment(env: SslEnv, valId: string, fetcher: typeof fetch = fetch): Promise<Validation | null> {
  const url = new URL(`${host(env)}/validator/api/validationserverAPI.php`);
  url.search = new URLSearchParams({
    val_id: valId,
    store_id: env.SSLCZ_STORE_ID!,
    store_passwd: env.SSLCZ_STORE_PASSWORD!,
    format: 'json',
  }).toString();
  try {
    const res = await fetcher(url.href);
    if (!res.ok) return null;
    return (await res.json()) as Validation;
  } catch {
    return null;
  }
}

const attr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page sent after checkout instead of a 303. Browsers check form-action
 * against every redirect that follows a form post, and the live gateway may
 * hop through hosts we cannot list; a page that moves on by itself is not a
 * form redirect, so nothing blocks it. The link works without JavaScript.
 */
export function gatewayHandoffPage(url: string): string {
  const href = attr(url);
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}"><title>পেমেন্ট পেজ খোলা হচ্ছে</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f3f8f4;color:#0f2e1f;text-align:center}a{color:#126b43;font-weight:600}</style></head>
<body><main><p>SSLCommerz এর পেমেন্ট পেজ খোলা হচ্ছে…</p><p><a href="${href}">না খুললে এখানে চাপুন</a></p></main>
<script>location.replace(${JSON.stringify(url).replace(/</g, '\\u003c')})</script></body></html>`;
}
