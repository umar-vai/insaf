// Blog article HTML. What the admin editor sends is cleaned on every save:
// only simple formatting tags survive, links must be http(s), mail, phone or
// on-site, and images must be ones uploaded to our own blog folder. Anything
// else (scripts, styles, event handlers, iframes, classes) is dropped.

const ALLOWED = new Set(['p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'img']);
const DROP_WITH_CONTENT = /<(script|style|iframe|noscript|svg|math|object|embed|form|template|textarea|select|button)\b[\s\S]*?<\/\1\s*>/gi;
const BLOG_IMAGE = /^\/media\/uploads\/blog\/[a-f0-9]{16}\.(?:webp|jpg|png)$/;

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attrs)?.[2]?.trim() ?? '';
const escapeAttr = (s: string) => s.replace(/&(?!(?:amp|lt|gt|quot|#\d+);)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function sanitizeBlogHtml(html: string): string {
  if (!html) return '';
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    // WordPress shortcodes like [caption] carry no meaning here.
    .replace(/\[\/?[a-z_][\w-]*(?:\s[^\]]*)?\]/gi, '');

  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase();
    const mapped = name === 'h1' ? 'h2' : name === 'h5' || name === 'h6' ? 'h4' : name === 'div' ? 'p' : name === 'strike' || name === 'del' ? 's' : name;
    if (!ALLOWED.has(mapped)) return '';
    const closing = tag.startsWith('</');
    if (closing) return mapped === 'br' || mapped === 'hr' || mapped === 'img' ? '' : `</${mapped}>`;
    if (mapped === 'a') {
      const href = attr(attrs, 'href');
      if (!/^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(href)) return '<a>';
      const external = /^https?:\/\//i.test(href) && !/^https?:\/\/(?:www\.)?madrasatulinsaf\.org(?:\/|$)/i.test(href);
      return external ? `<a href="${escapeAttr(href)}" rel="noopener nofollow" target="_blank">` : `<a href="${escapeAttr(href)}">`;
    }
    if (mapped === 'img') {
      const src = attr(attrs, 'src');
      if (!BLOG_IMAGE.test(src)) return '';
      return `<img src="${src}" alt="${escapeAttr(attr(attrs, 'alt').slice(0, 200))}" loading="lazy">`;
    }
    return `<${mapped}>`;
  });

  return s
    .replace(/<(?![a-z/])/gi, '&lt;')
    .replace(/<a>([\s\S]*?)<\/a>/g, '$1')
    .replace(/<p>\s*(?:&nbsp;|\s|<br>)*\s*<\/p>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const YOUTUBE = /^(?:<a [^>]*>)?\s*https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})[^\s<]*\s*(?:<\/a>)?$/;

/**
 * For display: a paragraph holding nothing but a YouTube link becomes an
 * embedded video. Runs on already sanitized HTML.
 */
export function renderBlogHtml(clean: string): string {
  return clean.replace(/<p>([\s\S]*?)<\/p>/g, (whole, inner: string) => {
    const id = YOUTUBE.exec(inner.trim())?.[1];
    return id
      ? `<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0" title="ভিডিও" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
      : whole;
  });
}

/** Plain text of an article, for excerpts and reading time. */
export const blogText = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

/** Minutes to read, at about 180 words a minute; at least one. */
export const readingMinutes = (html: string) => Math.max(1, Math.round(blogText(html).split(' ').filter(Boolean).length / 180));

/** Blog image keys (uploads/blog/...) used inside an article body. */
export const bodyImageKeys = (html: string) => [...html.matchAll(/src="\/media\/(uploads\/blog\/[a-f0-9]{16}\.(?:webp|jpg|png))"/g)].map((m) => m[1]!);
