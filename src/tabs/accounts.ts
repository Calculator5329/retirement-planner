import { BUCKETS, BUCKET_LABEL, type Account } from '../holdings';
import { donut, hbars } from '../chart';
import { h, numberField, numberInput, problemsNote, stat, toggle, help } from '../dom';
import { usd } from '../format';
import { display, endingBuckets, isEmployerPlan, projectAccounts, real, type AccountProjection } from '../projection';
import { ACCOUNT_KINDS, accounts, accountSettings, addAccount, dropBundled, inputProblems, isSample, removeAccount, renameAccount, setAccountSetting, settings, updateAccount, yearsToRetire, type AccountKind, type EnteredAccount } from '../state';
import { openSetup } from './setup';

// Rows whose detail line (employer match, basis) is open. The tree is cached
// until settings change, so a toggle flips `hidden` in place and this set
// carries the state into the next rebuild.
const open = new Set<string>();
// Typed accounts key by id so a rename keeps focus and the open detail; file accounts by name.
const rowKey = (a: Account): string => (a.entered ? `id:${a.entered}` : `name:${a.name}`);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export function renderAccounts(rerender: () => void): HTMLElement {
  const years = yearsToRetire();
  const projs = projectAccounts();
  const totalNow = accounts.reduce((s, a) => s + a.value, 0);
  const totalEnd = projs.reduce((s, p) => s + p.ending, 0);
  const totalContrib = projs.reduce((s, p) => s + p.contribution, 0);
  const totalMatch = projs.reduce((s, p) => s + p.match, 0);
  const unit = settings.showReal ? "today's dollars" : 'nominal';

  const controls = h('section', { class: 'controls' },
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Timeline'),
      numberField({ key: 'currentAge', label: 'Current age', value: settings.currentAge, min: 0, onChange: (n) => { settings.currentAge = n; rerender(); } }),
      numberField({ key: 'retireAge', label: 'Retirement age', value: settings.retireAge, min: 0, onChange: (n) => { settings.retireAge = n; rerender(); } }),
      numberField({ key: 'years', label: 'Years to retirement', value: years, min: 0, onChange: (n) => { settings.retireAge = settings.currentAge + n; rerender(); } })),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Growth', help(`Each account compounds its balance plus what you add for **${years} years**.\n\nThe S&P 500 has returned about 10% nominal, 7% real, since 1928.`)),
      numberField({ key: 'defaultCagr', label: 'Default CAGR', value: settings.defaultCagr, step: 0.5, suffix: '%', onChange: (n) => { settings.defaultCagr = n; rerender(); } }),
      numberField({ key: 'inflation', label: 'Inflation', value: settings.inflation, step: 0.1, suffix: '%', onChange: (n) => { settings.inflation = n; rerender(); } }),
      toggle('showReal', "Show in today's dollars", settings.showReal, (v) => { settings.showReal = v; rerender(); }),
      h('button', { class: 'btn', onclick: () => { for (const a of accounts) setAccountSetting(a, { cagr: settings.defaultCagr }); rerender(); } }, 'Apply default CAGR to every account')),
  );
  const problems = inputProblems(settings);
  const blocked = problems.length > 0;
  if (accounts.length === 0) return h('div', { class: 'tab' }, firstAccount(rerender), blocked ? problemsNote(problems) : null, controls);

  // The list stays editable while the inputs are blocked; only projected figures are hidden.
  const list = accountList(projs, years, blocked, rerender);
  if (blocked) return h('div', { class: 'tab' }, list, problemsNote(problems), controls);

  const stats = h('section', { class: 'stats' },
    stat('Portfolio today', usd(totalNow), plural(accounts.length, 'account')),
    stat('Contributions / yr', usd(totalContrib), totalMatch > 0 ? `plus ${usd(totalMatch)} employer match` : 'sum of every account'),
    stat(`Value at ${settings.retireAge}`, usd(display(totalEnd)), unit),
    stat("Same, in today's dollars", usd(real(totalEnd)), `${settings.inflation}% inflation over ${years} years`),
  );

  const byBucket = BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], cls: b, value: accounts.filter((a) => a.bucket === b).reduce((s, a) => s + a.value, 0) }));
  const endBuckets = endingBuckets(projs); // employer match counts as pre-tax
  const endByBucket = BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], cls: b, value: display(endBuckets[b]) }));
  const visuals = h('section', { class: 'two-col' },
    h('div', { class: 'panel' }, h('h3', {}, 'Tax buckets today'), donut(byBucket, usd(totalNow / 1000, 0) + 'k')),
    h('div', { class: 'panel' }, h('h3', {}, `Tax buckets at ${settings.retireAge}`), donut(endByBucket, usd(display(totalEnd) / 1000, 0) + 'k', unit)),
    h('div', { class: 'panel' }, h('h3', {}, 'Accounts by value'), hbars(accounts.map((a) => ({ label: a.name, sub: a.broker || a.accountType, value: a.value, cls: a.bucket })))),
  );

  return h('div', { class: 'tab' }, list, controls, stats, visuals);
}

// One row per account: typed accounts edit everything, file accounts take
// their name, type and balance from the holdings file. "Add" chips close it.
function accountList(projs: AccountProjection[], years: number, blocked: boolean, rerender: () => void): HTMLElement {
  const head = h('div', { class: 'acct-row acct-head' },
    h('span', {}, 'Account'), h('span', {}, 'Type'), h('span', { class: 'num pad' }, 'Balance'),
    h('span', { class: 'num pad' }, 'Adding / yr', help('Your own contributions each year until retirement. An employer match goes under **Match** on a 401(k) row.')),
    h('span', { class: 'num pad' }, 'Growth', help('Yearly growth, compounded (CAGR). New accounts start at the default CAGR below.')),
    h('span', { class: 'num' }, `At ${settings.retireAge}`), h('span', {}));
  const sample = isSample()
    ? h('span', { class: 'sec-tools' }, h('span', { class: 'muted' }, 'Showing a made-up sample'),
        h('button', { class: 'btn small', type: 'button', onclick: () => openSetup(rerender) }, 'Use my own numbers'),
        h('button', { class: 'btn small', type: 'button', title: 'Remove the sample accounts and keep any you added', onclick: () => { dropBundled(); rerender(); } }, 'Clear sample'))
    : null;
  return h('section', {},
    h('div', { class: 'sec-head' }, h('h2', {}, 'Your accounts', help('Each account grows its balance plus what you add each year, until retirement.\n\n- **Typed in** accounts are yours to edit or remove\n- **From a holdings file** take name, type and balance from the CSV\n\nThe color is the tax bucket.')), sample),
    h('div', { class: 'acct-list' }, head, ...projs.map((p) => accountRow(p, years, blocked, rerender)),
      h('div', { class: 'acct-add' }, h('span', { class: 'acct-add-label' }, 'Add'), ...kindChips(rerender))));
}

function accountRow(p: AccountProjection, years: number, blocked: boolean, rerender: () => void): HTMLElement {
  const a = p.account;
  const key = rowKey(a);
  const e = settings.entered.find((x) => x.id === a.entered);
  const name = e
    ? h('input', { class: 'acct-name-input', type: 'text', value: e.name, 'data-key': `name:${key}`, 'aria-label': 'Account name',
        onchange: (ev) => { const input = ev.target as HTMLInputElement; renameAccount(e.id, input.value); input.value = e.name; rerender(); } })
    : h('span', { class: 'acct-name-text' }, a.name, a.broker ? h('span', { class: 'muted' }, a.broker) : null);
  const type = e ? kindSelect(e, key, rerender) : h('span', { class: 'acct-type' }, a.accountType);
  const balance = e
    ? numberInput({ key: `bal:${key}`, label: `${a.name} balance`, value: e.balance, step: 1000, min: 0, suffix: '$', onChange: (n) => { updateAccount(e.id, { balance: n }); rerender(); } })
    : h('span', { class: 'field-input acct-fixed', title: 'From your holdings file' }, usd(a.value), h('span', { class: 'suffix' }, ''));

  const detail = detailLine(p, e, key, rerender);
  const toggleBtn = detail && h('button', { class: `btn small${open.has(key) ? ' on' : ''}`, type: 'button', 'aria-expanded': String(open.has(key)),
    onclick: () => {
      if (open.has(key)) open.delete(key); else open.add(key);
      detail.el.hidden = !open.has(key);
      toggleBtn!.classList.toggle('on', open.has(key));
      toggleBtn!.setAttribute('aria-expanded', String(open.has(key)));
    } }, detail.label);
  const remove = e && h('button', { class: 'acct-x', type: 'button', title: `Remove ${e.name}`, 'aria-label': `Remove ${e.name}`,
    onclick: () => {
      if (e.balance > 0 && !confirm(`Remove ${e.name} and its ${usd(e.balance)}?`)) return;
      removeAccount(e.id); open.delete(key); rerender();
    } }, '×');

  return h('div', { class: 'acct-item' },
    h('div', { class: 'acct-row' },
      h('span', { class: 'acct-name' }, h('span', { class: `dot ${a.bucket}`, title: BUCKET_LABEL[a.bucket] }), name),
      h('span', { 'data-label': 'Type' }, type),
      h('span', { class: 'num', 'data-label': 'Balance' }, balance),
      h('span', { class: 'num', 'data-label': 'Adding / yr' }, numberInput({ key: `contrib:${key}`, label: `${a.name} adding per year`, value: p.contribution, step: 500, min: 0, suffix: '$', onChange: (n) => { setAccountSetting(a, { contribution: n }); rerender(); } })),
      h('span', { class: 'num', 'data-label': 'Growth' }, numberInput({ key: `cagr:${key}`, label: `${a.name} growth`, value: Math.round(p.cagr * 1000) / 10, step: 0.5, suffix: '%', onChange: (n) => { setAccountSetting(a, { cagr: n }); rerender(); } })),
      h('span', { class: 'num acct-end', 'data-label': `At ${settings.retireAge}` }, blocked ? '—' : usd(display(p.ending, years))),
      h('span', { class: 'acct-actions' }, toggleBtn, remove)),
    detail?.el);
}

function kindSelect(e: EnteredAccount, key: string, rerender: () => void): HTMLElement {
  const sel = h('select', { 'data-key': `kind:${key}`, 'aria-label': `${e.name} type`,
    onchange: (ev) => { updateAccount(e.id, { kind: (ev.target as HTMLSelectElement).value as AccountKind }); rerender(); } });
  for (const [k, v] of Object.entries(ACCOUNT_KINDS)) {
    const opt = h('option', { value: k }, v.label) as HTMLOptionElement;
    opt.selected = k === e.kind;
    sel.append(opt);
  }
  return sel;
}

// The second line under a row: employer match on employer plans, basis on
// typed Roth and taxable accounts (a file account's basis comes from its lots).
function detailLine(p: AccountProjection, e: EnteredAccount | undefined, key: string, rerender: () => void): { label: string; el: HTMLElement } | null {
  const a = p.account;
  const match = isEmployerPlan(a);
  const basis = e !== undefined && a.bucket !== 'pretax';
  if (!match && !basis) return null;
  const s = accountSettings(a);
  const parts: HTMLElement[] = [];
  if (match) parts.push(h('span', { class: 'acct-detail-group' },
    h('span', { class: 'acct-detail-title' }, 'Employer match', help('Added on top of what you put in, into this account as pre-tax money (even in a Roth 401k).\n\n- **Match** is the share of your contribution the employer adds\n- **Up to** caps the matched part at that share of salary\n\n50% up to 6% of a $100,000 salary adds at most $3,000 a year.')),
    numberField({ key: `salary:${key}`, label: 'Salary', value: s.salary, step: 1000, min: 0, suffix: '$', onChange: (n) => { setAccountSetting(a, { salary: n }); rerender(); } }),
    numberField({ key: `matchPct:${key}`, label: 'Match', value: s.matchPct, step: 5, min: 0, suffix: '%', onChange: (n) => { setAccountSetting(a, { matchPct: n }); rerender(); } }),
    numberField({ key: `matchUpTo:${key}`, label: 'Up to', value: s.matchUpToPct, step: 0.5, min: 0, suffix: '%', onChange: (n) => { setAccountSetting(a, { matchUpToPct: n }); rerender(); } }),
    h('strong', { class: 'acct-detail-sum' }, p.match > 0 ? `adds ${usd(p.match)} / yr` : 'no match')));
  if (e && basis) parts.push(h('span', { class: 'acct-detail-group' },
    h('span', { class: 'acct-detail-title' }, 'Cost basis', help(`What you put in, not counting growth. It starts equal to the balance.\n\n- **Roth**: this part can come out before 59.5 with no tax or penalty\n- **Taxable**: only the growth above it is taxed when sold`)),
    numberField({ key: `basis:${key}`, label: 'Put in', value: e.basis ?? e.balance, step: 1000, min: 0, suffix: '$', onChange: (n) => { updateAccount(e.id, { basis: n }); rerender(); } })));
  const label = match && basis ? 'Match, basis' : match ? (p.match > 0 ? `Match ${usd(p.match)}` : 'Match') : 'Basis';
  return { label, el: h('div', { class: 'acct-detail', hidden: !open.has(key) }, ...parts) };
}

// One chip per account kind; the new row's balance takes focus with its 0 selected.
function kindChips(rerender: () => void): HTMLElement[] {
  return (Object.keys(ACCOUNT_KINDS) as AccountKind[]).map((k) => h('button', { class: 'chip small', type: 'button', title: ACCOUNT_KINDS[k].note,
    onclick: () => {
      const e = addAccount(k);
      rerender();
      const input = document.querySelector<HTMLInputElement>(`[data-key="bal:id:${e.id}"]`);
      input?.focus(); input?.select();
    } }, `+ ${ACCOUNT_KINDS[k].label}`));
}

function firstAccount(rerender: () => void): HTMLElement {
  return h('section', { class: 'empty first-account' },
    h('div', { class: 'empty-title' }, 'Add your first account'),
    h('div', { class: 'empty-sub' }, 'Pick a type and type in its balance, or answer four questions instead.'),
    h('div', { class: 'acct-kinds' }, ...kindChips(rerender)),
    h('button', { class: 'btn primary', type: 'button', onclick: () => openSetup(rerender) }, 'Answer four questions'));
}
