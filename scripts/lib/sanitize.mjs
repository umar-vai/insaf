// The old site was hacked, so imported HTML keeps only simple formatting tags
// and safe links. Everything else (scripts, iframes, styles, attributes,
// shortcodes) is dropped.
const ALLOWED = new Set(['p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a']);
const DROP_WITH_CONTENT = /<(script|style|iframe|noscript|svg|object|embed|form|template)\b[\s\S]*?<\/\1\s*>/gi;

export function sanitizeHtml(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_WITH_CONTENT, '')
    .replace(/\[\/?[a-z_][\w-]*(?:\s[^\]]*)?\]/gi, '');

  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, rawName, attrs) => {
    const name = rawName.toLowerCase();
    // Headings from page builders become h2..h4 so the page outline stays sane.
    const mapped = name === 'h1' ? 'h2' : name === 'h5' || name === 'h6' ? 'h4' : name === 'div' ? 'p' : name;
    if (!ALLOWED.has(mapped)) return '';
    const closing = tag.startsWith('</');
    if (closing) return mapped === 'br' || mapped === 'hr' ? '' : `</${mapped}>`;
    if (mapped === 'a') {
      const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim() ?? '';
      if (!/^(https?:\/\/|mailto:|tel:|\/)/i.test(href)) return '<a>';
      return `<a href="${href.replace(/"/g, '&quot;')}" rel="noopener nofollow">`;
    }
    return `<${mapped}>`;
  });

  return s
    .replace(/<(?![a-z/])/gi, '&lt;')
    .replace(/<a>([\s\S]*?)<\/a>/g, '$1')
    .replace(/<p>\s*(&nbsp;|\s|<br>)*\s*<\/p>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MARKDOWN = /(^|\n|>)[ \t]*(\*\*|<strong>|<b>)?(#{2,4} |[*-] |---)/;

const inline = (s) =>
  s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\*\*/g, '');

/**
 * Course descriptions were often typed as Markdown into WordPress, so the old
 * site showed "###" and "*" literally. Turn that into real headings and lists.
 */
export function sanitizeDescription(html) {
  const s = sanitizeHtml(html);
  if (!MARKDOWN.test(s)) return s;
  const lines = s
    .replace(/<br>/g, '\n')
    .replace(/<\/?p>/g, '\n')
    .split('\n')
    .map((l) => l.trim());
  const out = [];
  let para = [];
  let list = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const line of lines) {
    const heading = /^(?:\*\*|<strong>|<b>)?(#{2,4})\s+(.*?)(?:\*\*|<\/strong>|<\/b>)?$/.exec(line);
    const item = /^[*-]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (/^(-{3,}|\*{3,})$/.test(line)) {
      flush();
      out.push('<hr>');
    } else if (heading) {
      flush();
      // ## -> h3, ### -> h3, #### -> h4: the page title is the only h1 and
      // "কোর্স সম্পর্কে" is the h2 above the description.
      out.push(`<${heading[1].length >= 4 ? 'h4' : 'h3'}>${inline(heading[2])}</${heading[1].length >= 4 ? 'h4' : 'h3'}>`);
    } else if (item) {
      if (para.length) flush();
      list.push(item[1]);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join('\n');
}

export function plainText(html) {
  return sanitizeHtml(html)
    .replace(/\*+/g, '')
    .replace(/(^|\n|>)[ \t]*#{1,4}\s+/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}
