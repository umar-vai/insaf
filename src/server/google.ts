import { b64url, randomToken, sameText } from './crypto';
import { safeReturnTo } from './session';

// "Sign in with Google" (OpenID Connect, code flow with PKCE), as in Ring Hut.

export type GoogleEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; SESSION_SECRET?: string };

export const STATE_COOKIE = 'tm_oauth';

export const googleConfigured = (env: GoogleEnv) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);

/** Builds the Google sign-in URL and the short lived cookie that guards the return trip. */
export async function startGoogleSignIn(env: GoogleEnv, origin: string, returnTo: string, secure: boolean) {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const cookieValue = [state, verifier, encodeURIComponent(returnTo)].join('.');
  const cookie = `${STATE_COOKIE}=${cookieValue}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
  return { url: url.href, cookie };
}

export type GoogleProfile = { sub: string; email: string; name: string };

/**
 * Checks the state, swaps the code for tokens and reads the profile from
 * Google's userinfo endpoint over TLS. Only verified email addresses pass.
 */
export async function finishGoogleSignIn(
  env: GoogleEnv,
  origin: string,
  query: { code?: string; state?: string },
  stateCookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; profile: GoogleProfile; returnTo: string } | { ok: false; reason: string }> {
  const [state, verifier, returnTo] = (stateCookie ?? '').split('.');
  if (!query.code || !query.state || !state || !verifier || !sameText(query.state, state)) return { ok: false, reason: 'state' };
  const tokenRes = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: query.code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${origin}/api/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return { ok: false, reason: 'token' };
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return { ok: false, reason: 'token' };
  const infoRes = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) return { ok: false, reason: 'profile' };
  const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (!info.sub || !info.email || info.email_verified !== true) return { ok: false, reason: 'email' };
  return {
    ok: true,
    profile: { sub: info.sub, email: info.email.toLowerCase(), name: (info.name ?? '').slice(0, 120) },
    returnTo: safeReturnTo(decodeURIComponent(returnTo ?? '')),
  };
}
