// Just enough markdown for chat replies: paragraphs, bullet and numbered
// lists, headings, bold, italic, inline code, fenced code. No raw HTML.

import { h } from '../dom';

function inline(s: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(s.slice(last, i));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
    else out.push(h('em', {}, t.slice(1, -1)));
    last = i + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function markdown(src: string): HTMLElement {
  const root = h('div', { class: 'md' });
  const lines = src.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!);
      i++;
      root.append(h('pre', {}, h('code', {}, buf.join('\n'))));
      continue;
    }
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) { root.append(h(hm[1]!.length === 1 ? 'h3' : 'h4', {}, ...inline(hm[2]!))); i++; continue; }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = h(ordered ? 'ol' : 'ul', {});
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]!) || /^\s*\d+[.)]\s+/.test(lines[i]!))) {
        list.append(h('li', {}, ...inline(lines[i]!.replace(/^\s*([-*]|\d+[.)])\s+/, ''))));
        i++;
      }
      root.append(list);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    // Pipe table: a header row, a separator row, then body rows. A model that
    // flattens the table onto one line ("| a | b | |---|---| | 1 | 2 |") is unflattened first.
    if (line.includes('|')) {
      const isFlat = /\|\s*\|/.test(line) && /\|\s*:?-{2,}/.test(line);
      // Text before the first pipe of a flattened table is its own paragraph.
      const lead = isFlat ? line.slice(0, line.indexOf('|')).trim() : '';
      if (lead) root.append(h('p', {}, ...inline(lead)));
      const flat = isFlat ? line.slice(line.indexOf('|')).split(/\|\s+(?=\|)/).map((x) => x.trim()) : [];
      const rows: string[] = flat.length > 1 ? flat : [];
      if (!rows.length) { while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') rows.push(lines[i++]!); }
      else i++;
      if (rows.length >= 2 && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(rows[1]!)) {
        const cells = (r: string): string[] => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const aligns = cells(rows[1]!).map((c) => (/:$/.test(c) ? 'num' : ''));
        const tr = (r: string, tag: 'th' | 'td'): HTMLElement => h('tr', {}, ...cells(r).map((c, k) => h(tag, { class: aligns[k] ?? '' }, ...inline(c))));
        root.append(h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, tr(rows[0]!, 'th')), h('tbody', {}, ...rows.slice(2).map((r) => tr(r, 'td'))))));
        continue;
      }
      // Not a table after all: fall through as a paragraph.
      root.append(h('p', {}, ...inline(rows.join(' '))));
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,3}\s|```|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) buf.push(lines[i++]!);
    root.append(h('p', {}, ...inline(buf.join(' '))));
  }
  return root;
}
