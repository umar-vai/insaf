import { log } from './admin';
import { IMAGE_TYPES, storeUpload } from './files';
import type { SslEnv } from './sslcommerz';
import { SITE } from '../lib/site';

// System configuration the owner changes on /admin/system: institute
// details (name, phone, address, email, logo) and the keys for the payment
// gateway and the SMS service.
//
// Stored in the settings table under "cfg.<name>". Secret values (the
// gateway password, the SMS key) are encrypted with AES-GCM using a key
// derived from SESSION_SECRET, so a copy of the database alone does not
// reveal them. They are never shown again after saving: the page only says
// whether one is set. Anything not set here falls back to the Cloudflare
// secrets and the built-in site details, so nothing changes until the owner
// saves something.

export type ConfigEnv = SslEnv & { SESSION_SECRET?: string };

export const SECRET_FIELDS = ['sslczStorePassword', 'smsApiKey'] as const;
export const PLAIN_FIELDS = ['instituteName', 'institutePhone', 'instituteEmail', 'instituteAddress', 'sslczStoreId', 'sslczSandbox', 'smsSenderId', 'logoKey'] as const;
type SecretField = (typeof SECRET_FIELDS)[number];
type PlainField = (typeof PLAIN_FIELDS)[number];
export type Config = Record<PlainField | SecretField, string>;

const PREFIX = 'cfg.';

// ---- Encryption -----------------------------------------------------------

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('insaf-config'), info: enc.encode('settings-secrets-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealSecret(secret: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), enc.encode(value)));
  return `enc:v1:${b64(iv)}:${b64(ct)}`;
}

export async function openSecret(secret: string, sealed: string): Promise<string | null> {
  const [tag, v, iv, ct] = sealed.split(':');
  if (tag !== 'enc' || v !== 'v1' || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(secret), unb64(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ---- Reading ----------------------------------------------------------------

async function rows(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'cfg.%'`).all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key.slice(PREFIX.length), r.value]));
}

/** What is saved here (secrets decrypted). Empty strings for anything not set. */
export async function savedConfig(db: D1Database, env: ConfigEnv): Promise<Config> {
  const m = await rows(db);
  const out = Object.fromEntries([...PLAIN_FIELDS, ...SECRET_FIELDS].map((k) => [k, ''])) as Config;
  for (const k of PLAIN_FIELDS) out[k] = m.get(k) ?? '';
  for (const k of SECRET_FIELDS) {
    const sealed = m.get(k);
    out[k] = sealed && env.SESSION_SECRET ? ((await openSecret(env.SESSION_SECRET, sealed)) ?? '') : '';
  }
  return out;
}

/** The gateway settings to use: saved here first, else the Cloudflare secrets. */
export async function gatewayEnv(db: D1Database, env: ConfigEnv): Promise<SslEnv> {
  const c = await savedConfig(db, env);
  return {
    SSLCZ_STORE_ID: c.sslczStoreId || env.SSLCZ_STORE_ID,
    SSLCZ_STORE_PASSWORD: c.sslczStorePassword || env.SSLCZ_STORE_PASSWORD,
    SSLCZ_SANDBOX: c.sslczSandbox || env.SSLCZ_SANDBOX,
  };
}

export type Institute = { name: string; phone: string; email: string; address: string; logo: string };

/** Institute details for printed papers (receipts, payslips, ID cards): saved here, else the built-in ones. */
export async function institute(db: D1Database): Promise<Institute> {
  const m = await rows(db);
  const logoKey = m.get('logoKey');
  return {
    name: m.get('instituteName') || SITE.nameBn,
    phone: m.get('institutePhone') || SITE.phone.display,
    email: m.get('instituteEmail') || SITE.email,
    address: m.get('instituteAddress') || SITE.address,
    logo: logoKey ? `/media/${logoKey}` : '/logo-wide.png',
  };
}

// ---- Saving -------------------------------------------------------------------

/**
 * Saves the system form. Plain fields are replaced (empty clears them).
 * A secret field is replaced only when something is typed; the box
 * "clear_<field>" removes it. Returns the names that changed (never values).
 */
export async function saveConfig(db: D1Database, env: ConfigEnv, actor: string, form: FormData): Promise<{ ok: true; changed: string[] } | { ok: false; error: string }> {
  if (!env.SESSION_SECRET) return { ok: false, error: 'no_secret' };
  const before = await savedConfig(db, env);
  const put: [string, string][] = [];
  const drop: string[] = [];
  const val = (k: string, max = 300) => String(form.get(k) ?? '').trim().slice(0, max);

  for (const k of ['instituteName', 'institutePhone', 'instituteEmail', 'instituteAddress', 'sslczStoreId', 'smsSenderId'] as const) {
    const v = val(k);
    if (v !== before[k]) (v ? put.push([k, v]) : drop.push(k));
  }
  const sandbox = form.get('sslczSandbox') === 'live' ? '0' : form.get('sslczSandbox') === 'sandbox' ? '1' : '';
  if (sandbox !== before.sslczSandbox) (sandbox ? put.push(['sslczSandbox', sandbox]) : drop.push('sslczSandbox'));

  for (const k of SECRET_FIELDS) {
    if (form.get(`clear_${k}`) === 'on') {
      if (before[k]) drop.push(k);
      continue;
    }
    const v = val(k, 500);
    if (v && v !== before[k]) put.push([k, await sealSecret(env.SESSION_SECRET, v)]);
  }
  const changed = [...put.map(([k]) => k), ...drop];
  if (!changed.length) return { ok: true, changed };
  await db.batch([
    ...put.map(([k, v]) =>
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(PREFIX + k, v, actor),
    ),
    ...drop.map((k) => db.prepare('DELETE FROM settings WHERE key = ?').bind(PREFIX + k)),
  ]);
  await log(db, actor, 'config.update', 'settings:config', { changed });
  return { ok: true, changed };
}

/** Replaces the logo (JPG, PNG or WebP, up to 2 MB), public under /media/brand/. */
export async function saveLogo(db: D1Database, bucket: R2Bucket, actor: string, file: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await storeUpload(bucket, file, 'uploads/brand', IMAGE_TYPES, 2 * 1024 * 1024);
  if (!r.ok) return { ok: false, error: `file_${r.reason}` };
  const before = (await rows(db)).get('logoKey');
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_by) VALUES ('cfg.logoKey', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(r.file.key, actor)
    .run();
  if (before && before !== r.file.key) await bucket.delete(before);
  await log(db, actor, 'config.logo', 'settings:config', { fileName: r.file.fileName });
  return { ok: true };
}
