import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  // A new value on every build. The edge cache key includes it, so a deploy
  // never serves cached pages that point at files the new build removed.
  vite: { define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) } },
  devToolbar: { enabled: false },
  site: 'https://madrasatulinsaf.org',
  trailingSlash: 'ignore',
  // Old WordPress addresses are in src/lib/legacy-redirects.ts.
  redirects: { '/contact-us': '/contact', '/about-us': '/about' },
});
