import { markdown } from './chat/markdown';
// Tiny DOM helpers so tabs can build elements without a framework.

type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

export function h(tag: string, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

export interface NumberFieldOpts {
  key: string;        // stable id so focus survives a re-render
  label: string;
  value: number;
  step?: number;
  min?: number;
  suffix?: string;
  onChange: (n: number) => void;
}

/** A number input. A cleared or half-typed field saves nothing, and leaving it empty puts the last saved value back. */
export function numberField(o: NumberFieldOpts): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, o.label), numberInput(o));
}

/** numberField without the visible label (a table cell, where the column says what it is); `label` becomes the aria-label. */
export function numberInput(o: NumberFieldOpts): HTMLElement {
  let last = o.value;
  const input = h('input', {
    type: 'number', value: o.value, step: o.step ?? 1, 'data-key': o.key, 'aria-label': o.label,
    ...(o.min !== undefined ? { min: o.min } : {}),
    oninput: () => {
      if (input.value.trim() === '') return;   // Number('') is 0, and a lone "-" also reads as ''
      const n = Number(input.value);
      if (Number.isFinite(n)) { last = n; o.onChange(n); }
    },
    onblur: () => { if (input.value.trim() === '') input.value = String(last); },
  }) as HTMLInputElement;
  return h('span', { class: 'field-input' }, input, h('span', { class: 'suffix' }, o.suffix ?? ''));
}

export function selectField<T extends string>(key: string, label: string, value: T,
  options: [T, string][], onChange: (v: T) => void, tip?: string): HTMLElement {
  const sel = h('select', { 'data-key': key, onchange: (e) => onChange((e.target as HTMLSelectElement).value as T) });
  for (const [v, text] of options) {
    const opt = h('option', { value: v }, text) as HTMLOptionElement;
    opt.selected = v === value;
    sel.append(opt);
  }
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label, tip ? help(tip) : ''), h('span', { class: 'field-input' }, sel));
}

export function toggle(key: string, label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', 'data-key': key,
    onchange: (e) => onChange((e.target as HTMLInputElement).checked) }) as HTMLInputElement;
  input.checked = value;
  return h('label', { class: 'toggle' }, input, h('span', {}, label));
}

/** Shown in place of a tab's results while inputProblems() reports anything. */
export function problemsNote(problems: string[]): HTMLElement {
  return h('section', { class: 'problems', role: 'alert' },
    h('div', { class: 'problems-title' }, 'Fix these inputs to see the plan'),
    h('ul', {}, ...problems.map((p) => h('li', {}, p))));
}

/** A small "?" that shows `text` on hover or focus. Use it instead of footnotes. */
export function help(text: string): HTMLElement {
  const tip = markdown(text); tip.classList.add('tip');
  return h('span', { class: 'help', tabindex: '0', 'aria-label': text }, '?', tip);
}

export function stat(label: string, value: string, sub?: string, tone?: 'good' | 'bad', tip?: string): HTMLElement {
  return h('div', { class: `stat${tone ? ' ' + tone : ''}` },
    h('div', { class: 'stat-label' }, label, tip ? help(tip) : null, h('button', { class: 'ask', type: 'button', title: 'Ask the chat about this number' }, 'ask')),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null);
}

export function table(headers: string[], rows: (Node | string)[][], opts: { numericFrom?: number; classes?: string[]; wrap?: number[] } = {}): HTMLElement {
  const from = opts.numericFrom ?? 1;
  const thead = h('thead', {}, h('tr', {}, ...headers.map((t, i) => h('th', { class: `${i >= from ? 'num' : ''}${opts.wrap?.includes(i) ? ' wrap' : ''}` }, t))));
  const tbody = h('tbody', {});
  rows.forEach((r, ri) => {
    const tr = h('tr', { class: opts.classes?.[ri] ?? '' });
    r.forEach((c, i) => tr.append(h('td', { class: `${i >= from ? 'num' : ''}${opts.wrap?.includes(i) ? ' wrap' : ''}` }, c)));
    tbody.append(tr);
  });
  return h('div', { class: 'table-wrap' }, h('table', {}, thead, tbody));
}
