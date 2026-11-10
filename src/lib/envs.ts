// Which kind of site this is. Only sites without real students may take
// shortcuts like showing the sign-in code on the page.
//   local       a developer's computer
//   staging     the course-only test site (no students)
//   preview     the new site with real students, before launch
//   production  the real site
export type SiteEnv = { ENVIRONMENT?: string };

/** No real student data here, so test shortcuts are allowed. */
export const isTestSite = (env: SiteEnv) => env.ENVIRONMENT === 'local' || env.ENVIRONMENT === 'staging';

/** Not the real site yet: keep it out of search engines and say so on the page. */
export const isPrelaunch = (env: SiteEnv) => env.ENVIRONMENT !== 'production';
