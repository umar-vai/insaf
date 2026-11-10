import { describe, expect, it } from 'vitest';
import { legacyRedirect } from '../src/lib/legacy-redirects';

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

describe('old WordPress addresses', () => {
  it('sends the old fund pages to the new ones', () => {
    expect(legacyRedirect('/land-buying/')).toBe('/land');
    expect(legacyRedirect('/land-giving/')).toBe('/donate/land-giver');
    expect(legacyRedirect('/sadakh-zaria/')).toBe('/donate/sadkah-zaria');
    expect(legacyRedirect('/iftar-fund-donation/')).toBe('/donate/iftar');
    expect(legacyRedirect('/zakat-calculator/')).toBe('/zakat');
    expect(legacyRedirect('/donation/')).toBe('/donate');
  });

  it('sends Bangla menu pages and old notices to their new homes', () => {
    expect(legacyRedirect(enc('/আমাদের-সম্পর্কে/'))).toBe('/about');
    expect(legacyRedirect(enc('/যোগাযোগ/'))).toBe('/contact');
    expect(legacyRedirect(enc('/ভর্তি/'))).toBe('/admission');
    expect(legacyRedirect('/kitab-department/')).toBe('/blog/kitab-department');
    expect(legacyRedirect('/admission-for-nazera-hifz')).toBe('/blog/admission-for-nazera-hifz');
  });

  it('sends account and shop pages to the account or donations', () => {
    expect(legacyRedirect('/wp-login.php')).toBe('/account');
    expect(legacyRedirect('/wp-admin/edit.php')).toBe('/account');
    expect(legacyRedirect('/login/')).toBe('/account');
    expect(legacyRedirect('/product/test/')).toBe('/donate');
    expect(legacyRedirect('/cart/')).toBe('/donate');
  });

  it('leaves every page of the new site alone', () => {
    for (const p of ['/', '/land', '/donate', '/donate/zakat', '/donate/done', '/zakat', '/admission', '/account', '/account/offline', '/teacher', '/blog', '/blog/x', '/privacy-policy', '/api/health']) {
      expect(legacyRedirect(p)).toBeNull();
    }
  });

  it('ignores broken encodings', () => {
    expect(legacyRedirect('/%E0%A4')).toBeNull();
  });
});
