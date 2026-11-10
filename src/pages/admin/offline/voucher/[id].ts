import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getExpense } from '../../../../server/office';

// A voucher photo, for staff only (the /admin middleware checks who asks).
// Only images are ever stored here, and they are sent as images with nosniff.
export const GET: APIRoute = async ({ params }) => {
  const e = await getExpense(env.DB, params.id ?? '');
  if (!e?.voucherKey) return new Response('Not found', { status: 404 });
  const object = await env.MEDIA.get(e.voucherKey);
  if (!object) return new Response('Not found', { status: 404 });
  const type = object.httpMetadata?.contentType ?? '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" },
  });
};
