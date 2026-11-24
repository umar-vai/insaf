import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { todayDhaka } from '../../lib/offline';
import { receiveBankDelivery } from '../../server/bank-feed';

type BankFeedEnv = { BANK_FEED_SECRET?: string; BANK_FEED_ACCOUNTS?: string };

export const POST: APIRoute = async ({ request }) => {
  const variables = env as typeof env & BankFeedEnv;
  const headers = { 'Cache-Control': 'no-store' };
  if (!variables.BANK_FEED_SECRET || !variables.BANK_FEED_ACCOUNTS) return new Response(null, { status: 404, headers });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: `bank-feed:${ip}` })).success) return new Response(null, { status: 429, headers });
  if (Number(request.headers.get('Content-Length')) > 20_000) return new Response(null, { status: 413, headers });
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return new Response(null, { status: 415, headers });
  const result = await receiveBankDelivery(env.DB, { secret: variables.BANK_FEED_SECRET, accounts: variables.BANK_FEED_ACCOUNTS }, request, todayDhaka());
  return new Response(null, { status: result.status, headers });
};
