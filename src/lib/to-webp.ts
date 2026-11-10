// Runs in the admin's browser, before an image is uploaded: turns JPG and PNG
// into a smaller WebP (at most 1600 px wide) so the public site stays fast and
// R2 holds less. If anything goes wrong the original file is uploaded as is,
// so an upload never fails because of this step.

const MAX_WIDTH = 1600;
const QUALITY = 0.82;

export async function toWebp(file: File): Promise<File> {
  try {
    if (file.type !== 'image/jpeg' && file.type !== 'image/png' && file.type !== 'image/webp') return file;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    // Already a WebP that needs no resizing: keep it.
    if (file.type === 'image/webp' && scale === 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', QUALITY));
    // Some browsers cannot write WebP and hand back a PNG; keep the original then.
    if (!blob || blob.type !== 'image/webp' || (file.type === 'image/webp' && blob.size >= file.size)) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp', lastModified: Date.now() });
  } catch {
    return file;
  }
}
