import { BUCKETS, BUCKET_LABEL, type TaxBucket } from '../holdings';
import { donut, hbars } from '../chart';
import { h, numberField, problemsNote, stat, toggle, help } from '../dom';
import { pct, usd } from '../format';
import { accountBuckets, display, endingBuckets, isEmployerPlan, projectAccounts, real, type AccountProjection } from '../projection';
import { accountSettings, accounts, inputProblems, setAccountSetting, settings, yearsToRetire } from '../state';

const NOTE: Record<TaxBucket, string> = {
  pretax: 'withdrawals taxed as ordinary income',
  roth: 'withdrawals tax free',
  taxable: 'gains taxed at capital gains rates',
};

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
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Growth', help(`Each card compounds its balance plus contributions for **${years} years**.\n\nThe S&P 500 has returned about 10% nominal, 7% real, since 1928.`)),
      numberField({ key: 'defaultCagr', label: 'Default CAGR', value: settings.defaultCagr, step: 0.5, suffix: '%', onChange: (n) => { settings.defaultCagr = n; rerender(); } }),
      numberField({ key: 'inflation', label: 'Inflation', value: settings.inflation, step: 0.1, suffix: '%', onChange: (n) => { settings.inflation = n; rerender(); } }),
      toggle('showReal', "Show in today's dollars", settings.showReal, (v) => { settings.showReal = v; rerender(); }),
      h('button', { class: 'btn', onclick: () => { for (const a of accounts) setAccountSetting(a, { cagr: settings.defaultCagr }); rerender(); } }, 'Apply default CAGR to every account')),
  );
  const problems = inputProblems(settings);
  const blocked = problems.length > 0;
  const sections = BUCKETS.map((b) => {
    const rows = projs.filter((p) => p.account.bucket === b);
    // Read through accountBuckets so the heading agrees with the donut: a match
    // inside a Roth 401(k) counts here under pre-tax, not under its card's bucket.
    const end = projs.reduce((s, p) => s + accountBuckets(p)[b], 0);
    if (rows.length === 0 && end === 0) return null;
    return h('section', {},
      h('h2', {}, h('span', { class: `dot ${b}` }), BUCKET_LABEL[b], help(NOTE[b]), blocked ? null : h('span', { class: 'muted' }, ` · ${usd(display(end))} at ${settings.retireAge}`)),
      h('div', { class: 'cards' }, ...rows.map((p) => card(p, years, rerender, blocked))));
  }).filter((s): s is HTMLElement => s !== null);

  // Per-account inputs live on the cards, so they stay editable while the inputs are blocked; only projected figures are hidden.
  if (blocked) return h('div', { class: 'tab' }, controls, problemsNote(problems), ...sections);

  const stats = h('section', { class: 'stats' },
    stat('Portfolio today', usd(totalNow), `${accounts.length} accounts`),
    stat('Contributions / yr', usd(totalContrib), totalMatch > 0 ? `plus ${usd(totalMatch)} employer match` : 'sum of every card'),
    stat(`Value at ${settings.retireAge}`, usd(display(totalEnd)), unit),
    stat("Same, in today's dollars", usd(real(totalEnd)), `${settings.inflation}% inflation over ${years} years`),
  );

  const byBucket = BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], cls: b, value: accounts.filter((a) => a.bucket === b).reduce((s, a) => s + a.value, 0) }));
  const endBuckets = endingBuckets(projs); // employer match counts as pre-tax
  const endByBucket = BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], cls: b, value: display(endBuckets[b]) }));
  const visuals = h('section', { class: 'two-col' },
    h('div', { class: 'panel' }, h('h3', {}, 'Tax buckets today'), donut(byBucket, usd(totalNow / 1000, 0) + 'k')),
    h('div', { class: 'panel' }, h('h3', {}, `Tax buckets at ${settings.retireAge}`), donut(endByBucket, usd(display(totalEnd) / 1000, 0) + 'k', unit)),
    h('div', { class: 'panel' }, h('h3', {}, 'Accounts by value'), hbars(accounts.map((a) => ({ label: a.name, sub: a.broker, value: a.value, cls: a.bucket })))),
  );

  return h('div', { class: 'tab' }, controls, stats, visuals, ...sections);
}

function card(p: AccountProjection, years: number, rerender: () => void, blocked: boolean): HTMLElement {
  const a = p.account;
  const gainPct = a.costBasis > 0 ? a.gain / a.costBasis : 0;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('span', { class: `dot ${a.bucket}` }), h('span', { class: 'card-name' }, a.name), h('span', { class: 'card-meta' }, `${a.broker} · ${a.accountType}`)),
    h('div', {}, h('span', { class: 'card-value' }, usd(a.value)),
      h('span', { class: `card-gain ${a.gain >= 0 ? 'pos' : 'neg'}` }, `${a.gain >= 0 ? '+' : ''}${usd(a.gain)} (${pct(gainPct)})`)),
    h('div', { class: 'card-inputs' },
      numberField({ key: `contrib:${a.name}`, label: 'Contribution / yr', value: p.contribution, step: 500, suffix: '$', onChange: (n) => { setAccountSetting(a, { contribution: n }); rerender(); } }),
      numberField({ key: `cagr:${a.name}`, label: 'CAGR', value: Math.round(p.cagr * 1000) / 10, step: 0.5, suffix: '%', onChange: (n) => { setAccountSetting(a, { cagr: n }); rerender(); } })),
    isEmployerPlan(a) ? matchInputs(p, rerender) : null,
    blocked ? null : h('div', { class: 'card-foot' }, h('span', {}, `At ${settings.retireAge}`), h('strong', {}, usd(display(p.ending, years)))));
}

// The employer match line on an employer-plan card: salary, match rate and cap,
// then the dollars it adds per year on top of the employee contribution.
function matchInputs(p: AccountProjection, rerender: () => void): HTMLElement {
  const a = p.account;
  const s = accountSettings(a);
  return h('div', { class: 'card-match' },
    h('div', { class: 'card-line' },
      h('span', {}, 'Employer match', help(`Added on top of your contribution, into this account as pre-tax money (even in a Roth 401k).\n\n- **Match** is the share of your contribution the employer adds\n- **Up to** caps the matched part at that share of salary\n\n50% up to 6% of a $100,000 salary adds at most $3,000 a year.`)),
      h('strong', {}, p.match > 0 ? `${usd(p.match)} / yr` : 'none')),
    h('div', { class: 'card-inputs' },
      numberField({ key: `salary:${a.name}`, label: 'Salary', value: s.salary, step: 1000, min: 0, suffix: '$', onChange: (n) => { setAccountSetting(a, { salary: n }); rerender(); } }),
      numberField({ key: `matchPct:${a.name}`, label: 'Match', value: s.matchPct, step: 5, min: 0, suffix: '%', onChange: (n) => { setAccountSetting(a, { matchPct: n }); rerender(); } }),
      numberField({ key: `matchUpTo:${a.name}`, label: 'Up to', value: s.matchUpToPct, step: 0.5, min: 0, suffix: '%', onChange: (n) => { setAccountSetting(a, { matchUpToPct: n }); rerender(); } })));
}
