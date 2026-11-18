import { runBackup, type BackupEnv } from './server/backup';
import { handle } from '@astrojs/cloudflare/handler';
import { api } from './api';
import { isPrelaunch } from './lib/envs';
import { legacyRedirect } from './lib/legacy-redirects';
import { todayDhaka } from './lib/offline';
import { applyLateFees } from './server/offline';
import { remindOverdueBooks } from './server/library';
import { getSettings } from './server/settings';
import { withRequest } from './server/request-context';
import { countsAsPage, pruneActivity, trackPage } from './server/activity';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Videos are embedded from YouTube only. The Meta (Facebook) Pixel measures
  // donations from ads: its script, its image beacon and its event calls.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://static.cloudflareinsights.com https://www.googletagmanager.com https://www.clarity.ms https://scripts.clarity.ms",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.ytimg.com https://www.facebook.com https://www.google-analytics.com https://www.googletagmanager.com https://*.clarity.ms https://c.bing.com",
    "font-src 'self' data:",
    "connect-src 'self' https://cloudflareinsights.com https://www.facebook.com https://connect.facebook.net https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://*.clarity.ms https://c.bing.com",
    'frame-src https://www.youtube-nocookie.com https://www.google.com',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    // The donation form posts to us and we hand over to SSLCommerz; browsers apply
    // form-action to that redirect too, so the gateway must be listed.
    "form-action 'self' https://securepay.sslcommerz.com https://sandbox.sslcommerz.com",
  ].join('; '),
};

function withHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

declare const __BUILD_ID__: string;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/**
 * Public pages say how long they may be shared (Cache-Control with s-maxage).
 * Workers do not keep such answers by themselves, so they are kept here in
 * Cloudflare's edge cache, keyed by address and the build, so a new deploy starts with an empty cache. A page is stored only when
 * it asks for it, is a plain GET and sets no cookie; anything personal says
 * no-store and is never kept. Images under /media (cached for a year) are kept
 * too. Not used on localhost.
 */
async function edgeCached(request: Request, ctx: ExecutionContext, render: () => Response | Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const url = new URL(request.url);
  if (!cache || request.method !== 'GET' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' || request.headers.has('Range')) return render();
  const key = new Request(`${url.origin}/__edge/${BUILD_ID}${url.pathname}${url.search}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await render();
  const cc = response.headers.get('Cache-Control') ?? '';
  if (response.status === 200 && /s-maxage=\d+|max-age=31536000/.test(cc) && !/no-store|private/.test(cc) && !response.headers.has('Set-Cookie')) {
    ctx.waitUntil(cache.put(key, response.clone()));
  }
  return response;
}

// /api/* and /media/* go to Hono; everything else is rendered by Astro.
export default {
  /** Nightly jobs (wrangler.jsonc triggers): late fees on installments past the grace days, old visit rows, overdue library book notices. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const s = await getSettings(env.DB);
        await applyLateFees(env.DB, todayDhaka(), s.lateFeeTaka, s.lateGraceDays);
      })(),
    );
    ctx.waitUntil(pruneActivity(env.DB, todayDhaka()));
    ctx.waitUntil(remindOverdueBooks(env.DB, todayDhaka()));
    // Nightly database copy to the backup bucket; the result is always written to the audit log.
    ctx.waitUntil(runBackup(env as unknown as BackupEnv));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.href, 301);
    }

    // Old WordPress addresses (bookmarks, Google, Facebook links).
    const moved = request.method === 'GET' || request.method === 'HEAD' ? legacyRedirect(url.pathname) : null;
    if (moved) return Response.redirect(new URL(moved, url).href, 301);

    const render = () =>
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')
        ? api.fetch(request, env, ctx)
        : handle(request, env, ctx);
    const response = await withRequest(request, () => edgeCached(request, ctx, render), ctx);
    // The visits log (/admin/visits); written after the answer is sent.
    if (countsAsPage(request, response)) ctx.waitUntil(withRequest(request, () => trackPage(env, request)));

    const hidden = isPrelaunch(env);
    return withHeaders(response, hidden ? { ...SECURITY_HEADERS, 'X-Robots-Tag': 'noindex' } : SECURITY_HEADERS);
  },
} satisfies ExportedHandler<Env>;
