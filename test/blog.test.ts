import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { bodyImageKeys, readingMinutes, renderBlogHtml, sanitizeBlogHtml } from '../src/lib/blog-html';
import {
  adminPost,
  blogCategories,
  createPost,
  deletePost,
  parsePostForm,
  publishedPost,
  publishedPosts,
  relatedPosts,
  updatePost,
  uploadPostImage,
  type PostInput,
} from '../src/server/blog';

const db = env.DB;
const bucket = env.MEDIA;

const input = (over: Partial<PostInput> = {}): PostInput => ({
  title: 'Surah Kahf',
  slug: '',
  excerpt: '',
  bodyHtml: '<p>Hello</p>',
  category: 'কুরআন ও জীবন',
  status: 'published',
  featured: false,
  authorName: 'Tamrin',
  seoTitle: '',
  seoDescription: '',
  publishedDate: '',
  publishedTime: '',
  ...over,
});

beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM blog_posts'), db.prepare('DELETE FROM admin_events')]);
});

describe('cleaning article HTML', () => {
  it('keeps simple formatting and drops scripts, styles and handlers', () => {
    const out = sanitizeBlogHtml(
      '<h1 class="x">Title</h1><p style="color:red" onclick="alert(1)">Hi <strong>there</strong></p><script>alert(1)</script><iframe src="https://evil"></iframe><span>ok</span>',
    );
    expect(out).toBe('<h2>Title</h2><p>Hi <strong>there</strong></p>ok');
  });

  it('allows only safe links and marks outside links', () => {
    expect(sanitizeBlogHtml('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(sanitizeBlogHtml('<a href="//evil.com">x</a>')).toBe('x');
    expect(sanitizeBlogHtml('<a href="/courses">x</a>')).toBe('<a href="/courses">x</a>');
    expect(sanitizeBlogHtml('<a href="https://example.com/a?b=1&c=2">x</a>')).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener nofollow" target="_blank">x</a>',
    );
  });

  it('allows only images uploaded to our blog folder', () => {
    expect(sanitizeBlogHtml('<img src="https://evil.com/x.png" onerror="alert(1)">')).toBe('');
    expect(sanitizeBlogHtml('<img src="/media/uploads/blog/0123456789abcdef.webp" alt="A &quot;b&quot;">')).toBe(
      '<img src="/media/uploads/blog/0123456789abcdef.webp" alt="A &quot;b&quot;" loading="lazy">',
    );
  });

  it('turns a paragraph with only a YouTube link into a video', () => {
    const html = renderBlogHtml('<p>https://www.youtube.com/watch?v=MF8gh4xxyZg</p><p>See https://youtu.be/MF8gh4xxyZg here</p>');
    expect(html).toContain('<iframe src="https://www.youtube-nocookie.com/embed/MF8gh4xxyZg?rel=0"');
    expect(html).toContain('<p>See https://youtu.be/MF8gh4xxyZg here</p>');
  });

  it('finds image keys and estimates reading time', () => {
    expect(bodyImageKeys('<img src="/media/uploads/blog/0123456789abcdef.png" alt="">')).toEqual(['uploads/blog/0123456789abcdef.png']);
    expect(readingMinutes(`<p>${'word '.repeat(540)}</p>`)).toBe(3);
  });
});

describe('writing posts in the admin', () => {
  it('creates a draft that visitors cannot see', async () => {
    const r = await createPost(db, 'admin@x', 'Why read Surah Kahf');
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    const post = await adminPost(db, id);
    expect(post).toMatchObject({ status: 'draft', slug: 'why-read-surah-kahf' });
    expect(await publishedPost(db, 'why-read-surah-kahf')).toBeNull();
    expect(await publishedPosts(db)).toEqual([]);
  });

  it('gives Bangla titles a safe slug and keeps slugs unique', async () => {
    const a = await createPost(db, 'admin@x', 'সুরা কাহফ');
    expect((await adminPost(db, (a as { id: string }).id))?.slug).toMatch(/^post-[a-f0-9]{6}$/);
    await createPost(db, 'admin@x', 'Same title');
    const b = await createPost(db, 'admin@x', 'Same title');
    expect((await adminPost(db, (b as { id: string }).id))?.slug).toBe('same-title-2');
  });

  it('publishes with a cleaned body, an automatic excerpt and a date', async () => {
    const { id } = (await createPost(db, 'admin@x', 'Kahf')) as { id: string };
    expect(await updatePost(db, bucket, 'admin@x', id, input({ bodyHtml: '<p onclick="x()">Read it on Friday.</p><script>bad()</script>' }))).toBe(true);
    const post = await publishedPost(db, 'kahf');
    expect(post).toMatchObject({ title: 'Surah Kahf', excerpt: 'Read it on Friday.', bodyHtml: '<p>Read it on Friday.</p>' });
    expect(post?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const log = await db.prepare(`SELECT action FROM admin_events WHERE target = ?`).bind(`blog:${id}`).all<{ action: string }>();
    expect(log.results.map((r) => r.action)).toEqual(expect.arrayContaining(['blog.create', 'blog.update']));
  });

  it('refuses a slug another post already uses', async () => {
    await createPost(db, 'admin@x', 'First post');
    const { id } = (await createPost(db, 'admin@x', 'Second post')) as { id: string };
    expect(await updatePost(db, bucket, 'admin@x', id, input({ slug: 'first-post' }))).toBe('slug');
  });

  it('keeps a chosen publish date', async () => {
    const { id } = (await createPost(db, 'admin@x', 'Dated')) as { id: string };
    await updatePost(db, bucket, 'admin@x', id, input({ publishedDate: '2025-09-28' }));
    expect((await adminPost(db, id))?.publishedAt?.slice(0, 10)).toBe('2025-09-28');
  });

  it('validates the form', () => {
    const f = new FormData();
    f.set('title', 'x');
    expect(parsePostForm(f)).toEqual({ ok: false, error: 'title' });
    f.set('title', 'Good title');
    f.set('status', 'published');
    f.set('slug', 'Bad Slug');
    expect(parsePostForm(f)).toEqual({ ok: false, error: 'slug' });
    f.set('slug', 'good-slug');
    expect(parsePostForm(f).ok).toBe(true);
  });

  it('removes images taken out of the article, and all of them on delete', async () => {
    const { id } = (await createPost(db, 'admin@x', 'Pictures')) as { id: string };
    const file = () => new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    const one = await uploadPostImage(db, bucket, id, file());
    const two = await uploadPostImage(db, bucket, id, file());
    if (!one.ok || !two.ok) throw new Error('upload failed');
    await updatePost(db, bucket, 'admin@x', id, input({ bodyHtml: `<img src="${one.url}" alt=""><img src="${two.url}" alt="">` }));
    await updatePost(db, bucket, 'admin@x', id, input({ bodyHtml: `<img src="${one.url}" alt="">` }));
    expect(await bucket.get(two.url.slice('/media/'.length))).toBeNull();
    expect(await bucket.get(one.url.slice('/media/'.length))).not.toBeNull();
    expect(await deletePost(db, bucket, 'admin@x', id)).toBe(true);
    expect(await bucket.get(one.url.slice('/media/'.length))).toBeNull();
    expect(await adminPost(db, id)).toBeNull();
  });

  it('refuses files that are not pictures', async () => {
    const { id } = (await createPost(db, 'admin@x', 'Files')) as { id: string };
    const r = await uploadPostImage(db, bucket, id, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    expect(r).toEqual({ ok: false, reason: 'type' });
  });
});

describe('the public blog', () => {
  it('lists featured first, then newest, with categories and related posts', async () => {
    const make = async (title: string, over: Partial<PostInput>) => {
      const { id } = (await createPost(db, 'admin@x', title)) as { id: string };
      await updatePost(db, bucket, 'admin@x', id, input({ title, ...over }));
      return id;
    };
    const old = await make('Old one', { publishedDate: '2025-01-01', category: 'A' });
    await make('New one', { publishedDate: '2025-06-01', category: 'B' });
    await make('Pinned', { publishedDate: '2024-01-01', featured: true, category: 'A' });
    await make('Hidden', { status: 'draft' });
    expect((await publishedPosts(db)).map((p) => p.title)).toEqual(['Pinned', 'New one', 'Old one']);
    expect((await publishedPosts(db, { category: 'A' })).map((p) => p.title)).toEqual(['Pinned', 'Old one']);
    expect(await blogCategories(db)).toEqual([
      { name: 'A', count: 2 },
      { name: 'B', count: 1 },
    ]);
    expect((await relatedPosts(db, { id: old, category: 'A' })).map((p) => p.title)).toEqual(['Pinned', 'New one']);
  });
});

describe('scheduling', () => {
  it('hides a scheduled notice until its time, then shows it', async () => {
    const n = await createPost(db, 'a@x.org', 'Later');
    if (!n.ok) throw new Error('create');
    await updatePost(db, bucket, 'a@x.org', n.id, input({ title: 'Later', publishedDate: '2999-01-01', publishedTime: '10:30' }));
    expect(await publishedPosts(db)).toEqual([]);
    const row = await db.prepare('SELECT published_at AS at FROM blog_posts WHERE id = ?').bind(n.id).first<{ at: string }>();
    // 10:30 in Dhaka is 04:30 UTC.
    expect(row?.at).toBe('2999-01-01T04:30:00.000Z');
    await db.prepare("UPDATE blog_posts SET published_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(n.id).run();
    expect((await publishedPosts(db)).map((p) => p.title)).toEqual(['Later']);
  });
});
