import { BUCKETS, BUCKET_LABEL, type TaxBucket } from '../holdings';
import { h, help } from '../dom';
import { accounts, accountSettings, applySetup, isSample, settings, SS_LEVELS, type SetupAnswers } from '../state';
import type { Filing } from '../model';

const SAVED_NOTE: Record<TaxBucket, string> = { pretax: '401(k), 403(b), traditional IRA', roth: 'Roth IRA, Roth 401(k)', taxable: 'Brokerage, savings' };
type Level = SetupAnswers['ssLevel'];

/**
 * The four-question setup sheet: ages, savings and yearly additions per tax
 * bucket, spending. Finishing replaces the plan through applySetup and calls
 * onDone so the caller re-renders. On the sample the money starts blank;
 * otherwise every answer starts from the current plan.
 */
export function openSetup(onDone: () => void): void {
  document.querySelector('.ask-modal')?.remove();
  const sample = isSample();
  const sums = (f: (a: (typeof accounts)[number]) => number): Record<TaxBucket, number> =>
    Object.fromEntries(BUCKETS.map((b) => [b, sample ? 0 : accounts.filter((a) => a.bucket === b).reduce((s, a) => s + f(a), 0)])) as Record<TaxBucket, number>;
  const r = settings.retire;
  const a: SetupAnswers = {
    currentAge: settings.currentAge, retireAge: settings.retireAge, filing: r.filing,
    saved: sums((x) => x.value), adding: sums((x) => accountSettings(x).contribution),
    spendingMonthly: sample ? 0 : Math.round(r.costs / 12), fixedMonthly: sample ? 0 : r.fixedMonthly, fixedEndAge: r.fixedEndAge,
    ssLevel: r.ssLevel === 'custom' ? 'average' : r.ssLevel,
  };

  // Each step builds its rows and a read() that stores the answers or returns the first problem.
  // Back reads too, so going back keeps what was typed on this step.
  type Step = { title: string; tip: string; rows: HTMLElement[]; read: () => string | null };
  const steps: (() => Step)[] = [
    () => {
      const cur = num('Current age', a.currentAge, '');
      const ret = num('Retire at', a.retireAge, '');
      let filing = a.filing;
      const seg = segment<Filing>('Filing', [['single', 'Single', 'One person, single brackets'], ['married', 'Married', 'Married filing jointly: wider brackets, two social security checks']], filing, (v) => { filing = v; });
      return { title: 'About you', tip: 'Ages are whole years. Filing sets the tax brackets and doubles social security for a couple.',
        rows: [cur.row, ret.row, row('Filing', seg)],
        read: () => {
          const c = cur.get(), t = ret.get();
          if (c === null || !Number.isInteger(c) || c < 15 || c > 100) return 'Current age must be a whole number from 15 to 100.';
          if (t === null || !Number.isInteger(t) || t < c || t > 100) return `Retire at must be a whole number from ${c} to 100.`;
          a.currentAge = c; a.retireAge = t; a.filing = filing; return null;
        } };
    },
    () => money('What you have saved', "Today's balances, grouped by how withdrawals are taxed. Split them into separate accounts later on the Accounts tab.", 'saved', '$'),
    () => money('What you add each year', 'Your own contributions per year until retirement. An employer match goes in later, under **Match** on the 401(k) row.', 'adding', '$ / yr'),
    () => {
      const spend = num('Spending', a.spendingMonthly || null, '$ / mo', "Everything you expect to spend in a month of retirement, in today's dollars, except the fixed payments below.");
      const fixed = num('Fixed payments', a.fixedMonthly || null, '$ / mo', 'A mortgage or loan payment that stays the same in dollars until it is paid off.');
      const end = num('Paid off at age', a.fixedMonthly > 0 ? a.fixedEndAge : null, '');
      let ss = a.ssLevel;
      const seg = segment<Level>('Social security', (Object.keys(SS_LEVELS) as Level[]).map((k) => [k, SS_LEVELS[k].label.replace(' earners', ''), SS_LEVELS[k].note]), ss, (v) => { ss = v; });
      return { title: 'Spending in retirement', tip: "Monthly, in today's dollars. Social security is a level per person, adjusted later on the Retirement tab.",
        rows: [spend.row, fixed.row, end.row, row('Social security', seg)],
        read: () => {
          const s = spend.get() ?? 0, f = fixed.get() ?? 0, e = end.get();
          if (!(s > 0)) return 'Put in what you expect to spend per month.';
          if (f < 0) return 'Fixed payments cannot be negative.';
          if (f > 0 && e === null) return 'Put in the age the fixed payments end.';
          if (e !== null && (!Number.isInteger(e) || e < 0 || e > 120)) return 'Paid off at must be a whole age.';
          a.spendingMonthly = s; a.fixedMonthly = f; a.fixedEndAge = e ?? a.fixedEndAge; a.ssLevel = ss; return null;
        } };
    },
  ];

  function money(title: string, tip: string, field: 'saved' | 'adding', suffix: string): Step {
    const fields = BUCKETS.map((b) => ({ b, f: num(BUCKET_LABEL[b], a[field][b] || null, suffix, undefined, SAVED_NOTE[b]) }));
    return { title, tip, rows: fields.map((x) => x.f.row),
      read: () => {
        for (const { b, f } of fields) {
          const v = f.get() ?? 0;
          if (!Number.isFinite(v) || v < 0) return `${BUCKET_LABEL[b]} cannot be negative.`;
          a[field][b] = v;
        }
        return null;
      } };
  }

  let i = 0;
  let current: Step;
  const titleEl = h('div', { class: 'setup-title' });
  const body = h('div', { class: 'setup-body' });
  const error = h('div', { class: 'setup-error', role: 'alert' });
  const count = h('span', { class: 'muted' });
  const back = h('button', { class: 'btn', type: 'button', onclick: () => { current.read(); go(i - 1); } }, 'Back');
  const next = h('button', { class: 'btn primary', type: 'button', onclick: () => advance() });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => shut() }, sample ? 'Keep the sample' : 'Cancel');
  const close = h('button', { class: 'ask-close', type: 'button', 'aria-label': 'Close' }, '×');
  const panel = h('div', { class: 'setup-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Set up your plan' },
    h('div', { class: 'ask-head' }, titleEl, close), body, error,
    h('div', { class: 'setup-foot' }, count, h('span', { class: 'setup-btns' }, cancel, back, next)));
  const modal = h('div', { class: 'ask-modal' }, panel);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') shut();
    else if (e.key === 'Enter' && (e.target as HTMLElement).closest('input')) { e.preventDefault(); advance(); }
  };
  function shut(): void { modal.remove(); document.removeEventListener('keydown', onKey); }
  function go(n: number): void {
    i = n; current = steps[i]!();
    titleEl.replaceChildren(current.title, help(current.tip));
    body.replaceChildren(...current.rows);
    error.textContent = '';
    count.textContent = `Step ${i + 1} of ${steps.length}`;
    back.hidden = i === 0;
    cancel.hidden = i > 0;
    next.textContent = i === steps.length - 1 ? 'See my plan' : 'Next';
    body.querySelector<HTMLElement>('input, button')?.focus();
  }
  function advance(): void {
    const problem = current.read();
    if (problem) { error.textContent = problem; return; }
    if (i < steps.length - 1) { go(i + 1); return; }
    if (!sample && accounts.length > 0 && !confirm('Replace your accounts and inputs with these answers? Export settings first if you want to keep the current ones.')) return;
    applySetup(a);
    shut();
    onDone();
  }
  close.addEventListener('click', shut);
  document.addEventListener('keydown', onKey);
  document.body.append(modal);
  go(0);
}

// A labelled row: label (and an optional note under it) on the left, the control on the right,
// ending where the inputs do (before their unit). A segmented control sits in a div: a <label>
// would forward a click on its text to the first button.
function row(label: string | HTMLElement, control: HTMLElement, note?: string): HTMLElement {
  const input = control.querySelector('input') !== null;
  return h(input ? 'label' : 'div', { class: 'setup-row' },
    h('span', { class: 'setup-label' }, label, note ? h('span', { class: 'setup-note' }, note) : null),
    input ? control : h('span', { class: 'field-input' }, control, h('span', { class: 'suffix setup-suffix' })));
}

// A number row whose blank reads as null, so a money field can start empty and mean zero.
function num(label: string, value: number | null, suffix: string, tip?: string, note?: string): { row: HTMLElement; get: () => number | null } {
  const input = h('input', { type: 'number', value: value ?? '', placeholder: suffix.startsWith('$') ? '0' : '', min: 0, step: suffix.startsWith('$') ? 100 : 1, 'aria-label': label }) as HTMLInputElement;
  const lab = h('span', {}, label, tip ? help(tip) : null);
  return { row: row(lab, h('span', { class: 'field-input' }, input, h('span', { class: 'suffix setup-suffix' }, suffix)), note),
    get: () => (input.value.trim() === '' ? null : Number(input.value)) };
}

// A segmented control like the Retirement tab's: one button per option, the note as a hover tip.
function segment<T extends string>(label: string, options: [T, string, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const [v, text, tip] of options) {
    const b = h('button', { type: 'button', class: v === value ? 'on' : '', role: 'radio', 'aria-checked': String(v === value), 'data-tip': tip,
      onclick: () => {
        for (const x of seg.children) { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }
        b.classList.add('on'); b.setAttribute('aria-checked', 'true'); onPick(v);
      } }, text);
    seg.append(b);
  }
  return seg;
}

