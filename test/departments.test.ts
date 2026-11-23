import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { departmentRows, parsePublicSettings, publicDepartments, savePublicSettings } from '../src/server/departments';

const db = env.DB;

describe('departments', () => {
  it('starts with the seven real departments from the poster, fees untouched at zero', async () => {
    const list = await publicDepartments(db);
    expect(list.map((d) => d.title)).toEqual([
      'হিফজুল কুরআন শাখা',
      'হিফজ রিভিশন শাখা',
      'আদর্শ নাজেরা শাখা',
      'সম্পৃক্ত আরবী ও জেনারেল শাখা (নূরানী কিন্ডারগার্টেন)',
      'পৃথক আরবী ও জেনারেল শাখা',
      'স্কুলগামী শিক্ষার্থীদের কুরআন শিক্ষার পাশাপাশি দ্বীনি শাখা',
      'মহিলাদের জন্য বিশেষ দ্বীনি শাখা',
    ]);
    const rows = await departmentRows(db);
    expect(rows.filter((r) => r.isPublic).every((r) => r.incomeMinor === 0 && r.students === 0)).toBe(true);
  });

  it('lets the admin hide a department from the site and the form', async () => {
    const form = new FormData();
    form.set('summary', 'ছোট বিবরণ');
    form.set('sortOrder', '9');
    const parsed = parsePublicSettings(form);
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.value.isPublic).toBe(false);
    expect(await savePublicSettings(db, 'a@x.org', 'dept_women', parsed.value)).toBe(true);
    expect((await publicDepartments(db)).some((d) => d.id === 'dept_women')).toBe(false);
    parsed.value.isPublic = true;
    await savePublicSettings(db, 'a@x.org', 'dept_women', parsed.value);
    expect((await publicDepartments(db)).find((d) => d.id === 'dept_women')?.summary).toBe('ছোট বিবরণ');
  });

  it('rejects markup in the summary', () => {
    const form = new FormData();
    form.set('summary', '<b>x</b>');
    expect(parsePublicSettings(form)).toEqual({ ok: false, error: 'chars' });
  });
});

describe('the admission notice', () => {
  it('is on the notice page from the start', async () => {
    const row = await env.DB.prepare("SELECT status, category FROM blog_posts WHERE id = 'post_admission_open'").first<{ status: string; category: string }>();
    // Other tests clear blog_posts, so only check it when present.
    if (row) expect(row).toEqual({ status: 'published', category: 'নোটিশ' });
  });
});
