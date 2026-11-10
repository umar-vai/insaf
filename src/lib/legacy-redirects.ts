// Addresses from the old WordPress site (madrasatulinsaf.org), sent to their
// new home with a 301 so bookmarks, Google results and links shared on
// Facebook and in ads keep working.

// Old notices (posts) lived at the site root under their slug.
const POSTS = ['kitab-department', 'iftar-project', 'zakat-fund', 'permanent-campus-land-buing', 'admission-for-nazera-hifz'];

const EXACT: Record<string, string> = {
  // Fund pages.
  '/land-buying': '/land',
  '/land-giving': '/donate/land-giver',
  '/sadakh-zaria': '/donate/sadkah-zaria',
  '/iftar-fund-donation': '/donate/iftar',
  '/regular-donation': '/donate/regular-donation',
  '/donation': '/donate',
  '/donation-confirmation': '/donate',
  '/donation-failed': '/donate',
  '/donor-dashboard': '/donate',
  '/fundraising-campaign': '/donate',
  '/zakat-calculator': '/zakat',
  // Bangla menu pages.
  '/আমাদের-সম্পর্কে': '/about',
  '/যোগাযোগ': '/contact',
  '/ভর্তি': '/admission',
  '/একাডেমিক': '/admission',
  '/ক্যাম্পাস': '/about',
  // Account pages (Ultimate Member, WooCommerce).
  '/wp-login.php': '/account',
  '/login': '/account',
  '/register': '/account',
  '/user': '/account',
  '/account/edit': '/account/profile',
  '/members': '/account',
  '/logout': '/account',
  '/password-reset': '/account',
  '/my-account': '/account',
  '/shop': '/donate',
  '/cart': '/donate',
  '/checkout': '/donate',
  '/refund_returns': '/terms-and-conditions',
  '/notices': '/blog',
};

const PREFIX: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^\/wp-admin(?:\/.*)?$/, () => '/account'],
  [/^\/my-account(?:\/.*)?$/, () => '/account'],
  [/^\/product(?:\/.*)?$/, () => '/donate'],
  [/^\/category\/.*$/, () => '/blog'],
];

/** The new address for an old one, or null when it is not an old address. */
export function legacyRedirect(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  path = path.normalize('NFC').replace(/\/+$/, '') || '/';
  const exact = EXACT[path];
  if (exact) return exact;
  if (POSTS.includes(path.slice(1))) return `/blog/${path.slice(1)}`;
  for (const [re, to] of PREFIX) {
    const m = re.exec(path);
    if (m) return to(m);
  }
  return null;
}
