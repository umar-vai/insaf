// Lesson text typed in the admin, turned into safe HTML.
//
// Everything is escaped first, so nothing typed can become markup on its own.
// Then a small set of conventions is applied:
//   blank line      new paragraph        ## or ###   heading
//   - or *          list item            ---         divider
//   **text**        bold                 *text*      italic
//   https://...     link             [text](/page)   link on this site
//   > text          quotation (a verse or hadith)

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(line: string): string {
  return escape(line)
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_, pre: string, url: string) => `${pre}<a href="${url}" rel="noopener nofollow" target="_blank">${url}</a>`)
    .replace(/\[([^\]]+)\]\((\/[\w\-/#?=.]*)\)/g, '<a href="$2">$1</a>');
}

export function renderText(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    const item = /^[-*]\s+(.+)$/.exec(line);
    const quote = /^>\s?(.+)$/.exec(line);
    if (!line) flush();
    else if (/^-{3,}$/.test(line)) {
      flush();
      out.push('<hr>');
    } else if (heading) {
      flush();
      const tag = heading[1]!.length === 2 ? 'h3' : 'h4';
      out.push(`<${tag}>${inline(heading[2]!)}</${tag}>`);
    } else if (quote) {
      flush();
      out.push(`<blockquote><p>${inline(quote[1]!)}</p></blockquote>`);
    } else if (item) {
      if (para.length) flush();
      list.push(item[1]!);
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** Imported lesson HTML as editable text, for the first edit only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<(strong|b)>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
