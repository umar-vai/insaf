import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { imageResponse } from '../../../../server/files';
import { offlineIdsForEmail } from '../../../../server/panels';
import { currentStudent } from '../../../../server/students';

// A student's photo for the signed-in family only: the student must be one of
// the offline students linked to this account.
export const GET: APIRoute = async ({ params, request }) => {
  const me = await currentStudent(env.DB, env, request.headers.get('Cookie'));
  const id = params.id ?? '';
  if (!me || !(await offlineIdsForEmail(env.DB, me.email)).includes(id)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT photo_key AS k FROM offline_students WHERE id = ?').bind(id).first<{ k: string }>();
  return imageResponse(env.MEDIA, row?.k ?? '');
};
