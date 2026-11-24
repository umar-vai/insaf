import { log } from './admin';

type MediaEntry = { key: string; archiveKey: string; size: number; sha256: string };
export type MediaManifest = { version: 1; createdAt: string; files: MediaEntry[] };

const digest = async (value: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)),
  (b) => b.toString(16).padStart(2, '0')).join('');
const MAX_SIZE = 30 * 1024 * 1024;
const MEDIA_PREFIXES = ['private/', 'uploads/'];

export async function archiveMedia(source: R2Bucket, archive: R2Bucket, now = new Date()): Promise<MediaManifest> {
  const files: MediaEntry[] = [];
  for (const prefix of MEDIA_PREFIXES) {
    let cursor: string | undefined;
    do {
      const page = await source.list({ prefix, limit: 200, cursor });
      for (const listed of page.objects) {
        if (listed.size > MAX_SIZE) throw new Error('Media exceeds backup size limit');
        const itemKey = await digest(new TextEncoder().encode(`${listed.key}\n${listed.version || listed.etag}`).buffer);
        const archiveKey = `media/objects/${itemKey}`;
        const previous = await archive.head(archiveKey);
        let sha256 = previous?.size === listed.size ? previous.customMetadata?.sha256 : undefined;
        if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
          const item = await source.get(listed.key);
          if (!item || item.version !== listed.version || item.etag !== listed.etag || item.size !== listed.size) throw new Error('Media changed during backup');
          const bytes = await item.arrayBuffer();
          sha256 = await digest(bytes);
          const saved = await archive.put(archiveKey, bytes, { httpMetadata: item.httpMetadata, customMetadata: { ...item.customMetadata, sha256 }, sha256 });
          if (!saved || saved.size !== listed.size) throw new Error('Media archive verification failed');
        }
        files.push({ key: listed.key, archiveKey, size: listed.size, sha256 });
        if (files.length > 1500) throw new Error('Media backup reached the snapshot limit');
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const manifest: MediaManifest = { version: 1, createdAt: now.toISOString(), files };
  await archive.put(`media/manifests/${manifest.createdAt.slice(0, 10)}.json`, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
  return manifest;
}

/** Reads every archived byte during a restore and refuses to restore a corrupt copy. */
export async function restoreArchivedObject(archive: R2Bucket, destination: R2Bucket, item: MediaEntry, targetKey: string): Promise<boolean> {
  if (!MEDIA_PREFIXES.some((p) => item.key.startsWith(p)) || !/^media\/objects\/[a-f0-9]{64}$/.test(item.archiveKey)) return false;
  const stored = await archive.get(item.archiveKey);
  if (!stored || stored.size !== item.size || stored.size > MAX_SIZE) return false;
  const bytes = await stored.arrayBuffer();
  if (await digest(bytes) !== item.sha256) return false;
  const { sha256: _, ...customMetadata } = stored.customMetadata ?? {};
  const restored = await destination.put(targetKey, bytes, { httpMetadata: stored.httpMetadata, customMetadata, sha256: item.sha256,
    onlyIf: { etagDoesNotMatch: '*' } });
  return restored?.size === item.size;
}

export async function runMediaBackup(db: D1Database, source: R2Bucket, archive?: R2Bucket, actor = 'system') {
  if (!archive) return { ok: false as const, count: 0 };
  try {
    const manifest = await archiveMedia(source, archive);
    await log(db, actor, 'backup.media.ok', 'backup', { count: manifest.files.length, day: manifest.createdAt.slice(0, 10) });
    return { ok: true as const, count: manifest.files.length };
  } catch (e) {
    await log(db, actor, 'backup.media.failed', 'backup', { reason: String(e).slice(0, 300) }).catch(() => {});
    return { ok: false as const, count: 0 };
  }
}
