import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { clearAdmissionDraft, saveAdmissionDraft } from '../../server/admission-draft';
import { sameOrigin } from '../../server/session';

export const POST: APIRoute = async ({ request }) => {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers });
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) return new Response(null, { status: 503, headers });
  const len = Number(request.headers.get('Content-Length'));
  if (len > 24_000) return new Response(null, { status: 413, headers });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: `apply-draft:${ip}` })).success) return new Response(null, { status: 429, headers });
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return new Response(null, { status: 415, headers });
  const form = await request.formData();
  const action = form.get('action');
  if (action !== 'clear' && action !== 'save') return new Response(null, { status: 400, headers });
  headers.append('Set-Cookie', action === 'clear' ? await clearAdmissionDraft(env.DB, env.SESSION_SECRET, request)
    : await saveAdmissionDraft(env.DB, env.SESSION_SECRET, request, form));
  return new Response(null, { status: 204, headers });
};
