import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { imageResponse } from '../../../../../server/files';

// A student's admission photo, for staff only (the /admin middleware checks who asks).
export const GET: APIRoute = async ({ params }) => {
  const row = await env.DB.prepare('SELECT photo_key AS k FROM offline_students WHERE id = ?').bind(params.id ?? '').first<{ k: string }>();
  return imageResponse(env.MEDIA, row?.k ?? '');
};
