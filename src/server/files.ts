// Uploaded files in R2.
//   uploads/funds|blog/...       fund and blog pictures, public through /media
// Private files are never served without checking who is asking.

const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Documents, slides, sheets, audio, images and archives a teacher or student
// is likely to share. Anything that could run in a browser (HTML, SVG, JS)
// is refused.
export const DOC_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/plain': 'txt',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type Stored = { key: string; fileName: string; contentType: string; size: number };
export type StoreResult = { ok: true; file: Stored } | { ok: false; reason: 'missing' | 'type' | 'size' };

/** Checks type and size, then stores the file under prefix with a random name. */
export async function storeUpload(
  bucket: R2Bucket,
  file: unknown,
  prefix: string,
  types: Record<string, string>,
  maxBytes: number,
): Promise<StoreResult> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, reason: 'missing' };
  const ext = types[file.type];
  if (!ext) return { ok: false, reason: 'type' };
  if (file.size > maxBytes) return { ok: false, reason: 'size' };
  const key = `${prefix}/${shortId()}.${ext}`;
  await bucket.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  const fileName = (file.name || `file.${ext}`).replace(/[\\/\r\n"]/g, '_').slice(0, 150);
  return { ok: true, file: { key, fileName, contentType: file.type, size: file.size } };
}

/** Streams a private file as a download with its original name. */
export async function downloadResponse(bucket: R2Bucket, key: string, fileName: string): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
