import { IMAGE_TYPES, storeUpload } from './files';
import { blogText, bodyImageKeys, sanitizeBlogHtml } from '../lib/blog-html';

/** English words of a title as a URL; Bangla titles give '' and get an id. */
const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');

// Blog articles. Visitors only ever see published posts; drafts and every
// change go through the admin, and each change is logged in admin_events.

/** Published and already due: a scheduled post stays hidden until its time. */
const LIVE = `status = 'published' AND coalesce(published_at, '') <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export type PostCard = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverKey: string | null;
  category: string;
  authorName: string;
  featured: boolean;
  publishedAt: string;
  minutes: number;
};

export type Post = PostCard & { bodyHtml: string; seoTitle: string | null; seoDescription: string | null; updatedAt: string };

const CARD_COLUMNS = `id, slug, title, excerpt, cover_key AS coverKey, category, author_name AS authorName, featured,
  published_at AS publishedAt, length(body_html) AS bodyLength`;

type CardRow = Omit<PostCard, 'featured' | 'minutes'> & { featured: number; bodyLength: number };
// Listing rows skip the body; HTML is roughly 6 characters per word read.
const toCard = ({ bodyLength, featured, ...r }: CardRow): PostCard => ({
  ...r,
  featured: Boolean(featured),
  minutes: Math.max(1, Math.round(bodyLength / 6 / 180)),
});

export async function publishedPosts(db: D1Database, opts: { category?: string | null; limit?: number} = {}): Promise<PostCard[]> {
  const where = opts.category ? `AND category = ?` : '';
  const stmt = db.prepare(
    `SELECT ${CARD_COLUMNS} FROM blog_posts WHERE ${LIVE} ${where}
     ORDER BY featured DESC, published_at DESC LIMIT ${Math.min(opts.limit ?? 60, 100)}`,
  );
  const { results } = await (opts.category ? stmt.bind(opts.category) : stmt).all<CardRow>();
  return results.map(toCard);
}

export async function blogCategories(db: D1Database): Promise<{ name: string; count: number }[]> {
  const { results } = await db
    .prepare(`SELECT category AS name, count(*) AS count FROM blog_posts WHERE ${LIVE} AND category != '' GROUP BY category ORDER BY count DESC, name`)
    .all<{ name: string; count: number }>();
  return results;
}

export async function publishedPost(db: D1Database, slug: string): Promise<Post | null> {
  const row = await db
    .prepare(
      `SELECT ${CARD_COLUMNS}, body_html AS bodyHtml, seo_title AS seoTitle, seo_description AS seoDescription, updated_at AS updatedAt
       FROM blog_posts WHERE slug = ? AND ${LIVE}`,
    )
    .bind(slug)
    .first<CardRow & { bodyHtml: string; seoTitle: string | null; seoDescription: string | null; updatedAt: string }>();
  if (!row) return null;
  const { bodyHtml, seoTitle, seoDescription, updatedAt, ...card } = row;
  return { ...toCard(card), minutes: Math.max(1, Math.round(blogText(bodyHtml).split(' ').length / 180)), bodyHtml, seoTitle, seoDescription, updatedAt };
}

/** Same category first, then the newest others. */
export async function relatedPosts(db: D1Database, post: Pick<PostCard, 'id' | 'category'>, limit = 3): Promise<PostCard[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM blog_posts WHERE ${LIVE} AND id != ?
       ORDER BY (category = ? AND category != '') DESC, published_at DESC LIMIT ?`,
    )
    .bind(post.id, post.category, limit)
    .all<CardRow>();
  return results.map(toCard);
}

// ---- Admin ---------------------------------------------------------------

export type AdminPost = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  bodyHtml: string;
  coverKey: string | null;
  category: string;
  status: 'draft' | 'published';
  featured: boolean;
  authorName: string;
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

/** "HH:MM" in Dhaka for a stored UTC time, or the morning when there is none. */
export const dhakaTime = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 6 * 3_600_000).toISOString().slice(11, 16) : '09:00');
export const dhakaDate = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 6 * 3_600_000).toISOString().slice(0, 10) : '');

const log = (db: D1Database, actor: string, action: string, id: string, detail: unknown = {}) =>
  db
    .prepare('INSERT INTO admin_events (id, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .bind(`ae_${crypto.randomUUID()}`, actor, action, `blog:${id}`, JSON.stringify(detail))
    .run();

export async function adminPosts(db: D1Database): Promise<(Omit<AdminPost, 'bodyHtml'> & { minutes: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug, title, excerpt, cover_key AS coverKey, category, status, featured, author_name AS authorName,
              seo_title AS seoTitle, seo_description AS seoDescription, published_at AS publishedAt, updated_at AS updatedAt,
              length(body_html) AS bodyLength
       FROM blog_posts ORDER BY (status = 'draft') DESC, coalesce(published_at, updated_at) DESC`,
    )
    .all<Omit<AdminPost, 'bodyHtml' | 'featured'> & { featured: number; bodyLength: number }>();
  return results.map(({ bodyLength, featured, ...r }) => ({ ...r, featured: Boolean(featured), minutes: Math.max(1, Math.round(bodyLength / 6 / 180)) }));
}

export async function adminPost(db: D1Database, id: string): Promise<AdminPost | null> {
  const row = await db
    .prepare(
      `SELECT id, slug, title, excerpt, body_html AS bodyHtml, cover_key AS coverKey, category, status, featured,
              author_name AS authorName, seo_title AS seoTitle, seo_description AS seoDescription,
              published_at AS publishedAt, updated_at AS updatedAt
       FROM blog_posts WHERE id = ?`,
    )
    .bind(id)
    .first<Omit<AdminPost, 'featured'> & { featured: number }>();
  return row && { ...row, featured: Boolean(row.featured) };
}

async function uniqueSlug(db: D1Database, base: string, exceptId = ''): Promise<string> {
  const root = base || 'post';
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? root : `${root}-${i}`;
    const taken = await db.prepare('SELECT 1 FROM blog_posts WHERE slug = ? AND id != ?').bind(slug, exceptId).first();
    if (!taken) return slug;
  }
  return `${root}-${crypto.randomUUID().slice(0, 6)}`;
}

/** A new draft with just a title; the editor fills in the rest. */
export async function createPost(db: D1Database, actor: string, title: string): Promise<{ ok: true; id: string } | { ok: false }> {
  const clean = title.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (clean.length < 2) return { ok: false };
  const id = `post_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const ascii = slugOf(clean);
  const slug = await uniqueSlug(db, ascii.length >= 3 ? ascii : `post-${id.slice(5, 11)}`);
  await db.prepare('INSERT INTO blog_posts (id, slug, title) VALUES (?, ?, ?)').bind(id, slug, clean).run();
  await log(db, actor, 'blog.create', id, { title: clean });
  return { ok: true, id };
}

export type PostInput = {
  title: string;
  slug: string;
  excerpt: string;
  bodyHtml: string;
  category: string;
  status: 'draft' | 'published';
  featured: boolean;
  authorName: string;
  seoTitle: string;
  seoDescription: string;
  /** "YYYY-MM-DD"; empty keeps the existing date (or today on first publish). */
  publishedDate: string;
  /** "HH:MM" Dhaka time; with a future date and status published the post is scheduled. */
  publishedTime: string;
};

export type PostFormResult = { ok: true; value: PostInput } | { ok: false; error: 'title' | 'slug' | 'status' | 'date' | 'time' };

export function parsePostForm(form: FormData): PostFormResult {
  const s = (k: string, max: number) => String(form.get(k) ?? '').trim().slice(0, max);
  const title = s('title', 200).replace(/\s+/g, ' ');
  if (title.length < 2) return { ok: false, error: 'title' };
  const slug = s('slug', 120).toLowerCase();
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, error: 'slug' };
  const status = form.get('status');
  if (status !== 'draft' && status !== 'published') return { ok: false, error: 'status' };
  const publishedDate = s('publishedDate', 10);
  if (publishedDate && !/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) return { ok: false, error: 'date' };
  const publishedTime = s('publishedTime', 5);
  if (publishedTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(publishedTime)) return { ok: false, error: 'time' };
  return {
    ok: true,
    value: {
      title,
      slug,
      excerpt: s('excerpt', 400),
      // Up to about 200 KB of article; the cleaner runs on save.
      bodyHtml: String(form.get('body') ?? '').slice(0, 200_000),
      category: s('category', 60),
      status,
      featured: form.get('featured') === 'on',
      authorName: s('authorName', 80),
      seoTitle: s('seoTitle', 120),
      seoDescription: s('seoDescription', 300),
      publishedDate,
      publishedTime,
    },
  };
}

export async function updatePost(db: D1Database, bucket: R2Bucket, actor: string, id: string, v: PostInput): Promise<true | 'missing' | 'slug'> {
  const before = await adminPost(db, id);
  if (!before) return 'missing';
  const slug = v.slug || before.slug;
  if (slug !== before.slug && (await db.prepare('SELECT 1 FROM blog_posts WHERE slug = ? AND id != ?').bind(slug, id).first())) return 'slug';
  const body = sanitizeBlogHtml(v.bodyHtml);
  const excerpt = v.excerpt || blogText(body).slice(0, 220);
  // The date and time the editor sees are Dhaka time (UTC+6); stored as UTC.
  const publishedAt = v.publishedDate
    ? new Date(`${v.publishedDate}T${v.publishedTime || dhakaTime(before.publishedAt)}:00+06:00`).toISOString()
    : before.publishedAt ?? (v.status === 'published' ? new Date().toISOString() : null);
  await db
    .prepare(
      `UPDATE blog_posts SET slug = ?, title = ?, excerpt = ?, body_html = ?, category = ?, status = ?, featured = ?, author_name = ?,
         seo_title = ?, seo_description = ?, published_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    )
    .bind(slug, v.title, excerpt, body, v.category, v.status, v.featured ? 1 : 0, v.authorName, v.seoTitle || null, v.seoDescription || null, publishedAt, id)
    .run();
  // Images taken out of the article are removed from storage too.
  const kept = new Set(bodyImageKeys(body));
  const gone = bodyImageKeys(before.bodyHtml).filter((k) => !kept.has(k));
  if (gone.length) await bucket.delete(gone);
  await log(db, actor, 'blog.update', id, { status: v.status, slug });
  return true;
}

export async function setPostCover(db: D1Database, bucket: R2Bucket, actor: string, id: string, file: unknown) {
  const post = await db.prepare('SELECT cover_key AS old FROM blog_posts WHERE id = ?').bind(id).first<{ old: string | null }>();
  if (!post) return { ok: false as const, reason: 'missing' as const };
  const stored = await storeUpload(bucket, file, 'uploads/blog', IMAGE_TYPES, 5 * 1024 * 1024);
  if (!stored.ok) return stored;
  await db.prepare(`UPDATE blog_posts SET cover_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(stored.file.key, id).run();
  if (post.old) await bucket.delete(post.old);
  await log(db, actor, 'blog.cover', id, { key: stored.file.key });
  return { ok: true as const };
}

export async function removePostCover(db: D1Database, bucket: R2Bucket, actor: string, id: string) {
  const post = await db.prepare('SELECT cover_key AS old FROM blog_posts WHERE id = ?').bind(id).first<{ old: string | null }>();
  if (!post?.old) return;
  await db.prepare('UPDATE blog_posts SET cover_key = NULL WHERE id = ?').bind(id).run();
  await bucket.delete(post.old);
  await log(db, actor, 'blog.cover_remove', id);
}

/** An image for inside an article; returns the URL to put in the body. */
export async function uploadPostImage(db: D1Database, bucket: R2Bucket, id: string, file: unknown) {
  if (!(await db.prepare('SELECT 1 FROM blog_posts WHERE id = ?').bind(id).first())) return { ok: false as const, reason: 'missing' as const };
  const stored = await storeUpload(bucket, file, 'uploads/blog', IMAGE_TYPES, 5 * 1024 * 1024);
  if (!stored.ok) return stored;
  return { ok: true as const, url: `/media/${stored.file.key}` };
}

export async function deletePost(db: D1Database, bucket: R2Bucket, actor: string, id: string): Promise<boolean> {
  const post = await adminPost(db, id);
  if (!post) return false;
  await db.prepare('DELETE FROM blog_posts WHERE id = ?').bind(id).run();
  const keys = [...bodyImageKeys(post.bodyHtml), ...(post.coverKey ? [post.coverKey] : [])];
  if (keys.length) await bucket.delete(keys);
  await log(db, actor, 'blog.delete', id, { title: post.title, slug: post.slug });
  return true;
}
