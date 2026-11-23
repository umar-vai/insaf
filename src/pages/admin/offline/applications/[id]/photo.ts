import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getApplication } from '../../../../../server/admission';
import { imageResponse } from '../../../../../server/files';

// The applicant's photo, for staff only (the /admin middleware checks who asks).
export const GET: APIRoute = async ({ params }) => {
  const a = await getApplication(env.DB, params.id ?? '');
  return imageResponse(env.MEDIA, a?.photoKey ?? '');
};
