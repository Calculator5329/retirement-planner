import { BUCKETS, BUCKET_LABEL } from '../holdings';
import { fanChart, ghostPoints, stackedArea, stackedBars, type FanGhost } from '../chart';
import { h, numberField, problemsNote, selectField, stat, table, help } from '../dom';
import { pct, signed, usd, usdK } from '../format';
import { medianRealReturn } from '../data/history';
import { ANNUITY_KINDS, DRAW_ORDERS, LADDER_MODES, PAYOUT_SOURCE, annuityPayoutRate, type AnnuityKind, type DrawdownYear, type Filing, type LadderMode } from '../model';
import { simulate } from '../sim';
import { settings, setAnnuityShare, syncSocialSecurity, treasuriesShare, yearsToRetire, SS_LEVELS, type DrawOrder, type SsLevel } from '../state';
import { annuityAt, bucketsAt, describeOverrides, evaluate, evaluateWith, fixedAt, overrideProblems, planProblems, type PlanSummary } from '../plan';
import { evaluateGhost, setGhost } from '../chat/store';

// Everything on this tab is in today's dollars: ending balances are deflated
// and the 2025 federal brackets are applied unindexed.
export function renderRetirement(rerender: () => void): HTMLElement {
  const r = settings.retire;
  const years = yearsToRetire();
  const horizon = Math.max(1, r.endAge - settings.retireAge);
  const problems = planProblems();
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  // With the inputs valid, the fixed-payments note speaks in the plan's own numbers.
  const fixed = problems.length ? null : fixedAt(settings.retireAge);
  const fixedNote = r.fixedMonthly <= 0 || problems.length ? ''
    : !fixed ? ` Yours are paid off at ${r.fixedEndAge}, before you retire, so they do not count here.`
    : ` Your ${usd(r.fixedMonthly)} a month is worth about ${usd(fixed.annual / 12)} a month in today's dollars at ${settings.retireAge}, and less each year after${r.fixedEndAge < r.endAge ? ` until it ends at ${r.fixedEndAge}` : ''}.`;
  const costsTip = "**Variable expenses** are what you spend each month after tax, in today's dollars, so they keep up with inflation.\n\n**Fixed expenses** stay the same dollar amount every month until paid off, like a mortgage, so inflation shrinks them. In the historical replay each run shrinks them by its own inflation." + fixedNote;
  const timelineTip = help(problems.length ? costsTip : `**${plural(horizon, 'year')}** of retirement, ${years > 0 ? `starting in ${plural(years, 'year')}` : 'starting now'}.\n\n${costsTip}`);
  const joint = r.filing === 'married';
  const rateAt = (k: AnnuityKind): number => annuityPayoutRate(k, settings.retireAge, joint);
  const equityBefore = r.equity;

  const controls = h('section', { class: 'controls' },
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Timeline and spending', timelineTip),
      numberField({ key: 'retireAge2', label: 'Retire at', value: settings.retireAge, onChange: (n) => { settings.retireAge = n; rerender(); } }),
      numberField({ key: 'endAge', label: 'Plan to age', value: r.endAge, onChange: (n) => { r.endAge = n; rerender(); } }),
      // retire.costs stays annual everywhere else (model, chat); only this field is per month.
      numberField({ key: 'costs', label: 'Variable expenses / mo', value: Math.round(r.costs / 12 * 100) / 100, step: 100, suffix: '$', onChange: (n) => { r.costs = n * 12; rerender(); } }),
      numberField({ key: 'fixedMonthly', label: 'Fixed expenses / mo', value: r.fixedMonthly, step: 100, min: 0, suffix: '$', onChange: (n) => { r.fixedMonthly = n; rerender(); } }),
      numberField({ key: 'fixedEndAge', label: 'Paid off at', value: r.fixedEndAge, onChange: (n) => { r.fixedEndAge = n; rerender(); } })),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Allocation at retirement', help("How the portfolio is split the day you retire, rebalanced every year.\n\n- **S&P 500** follows the index's real total return, year by year\n- **Treasuries** follow the 10-year Treasury bond's real total return for the same years. It is whatever the other two leave\n- **Annuity** is spent on a single-premium immediate annuity that pays for life, joint when filing married\n\nThe annuity is bought with pre-tax money (an IRA rollover), so its payments are ordinary income and never penalised.")),
      numberField({ key: 'equity', label: 'S&P 500', value: r.equity, step: 5, min: 0, suffix: '%', onChange: (n) => { r.equity = n; rerender(); } }),
      // Typing a Treasuries share moves the S&P 500 share; the annuity stays put. Too much shows as a problem, not a silent clamp.
      numberField({ key: 'treasuries', label: 'Treasuries', value: treasuriesShare(r), step: 5, min: 0, suffix: '%', onChange: (n) => { r.equity = 100 - r.annuity - n; rerender(); } }),
      // main.ts keeps a focused input (and this listener) across re-renders, so equityBefore is the S&P 500 share when the edit began.
      numberField({ key: 'annuity', label: 'Annuity', value: r.annuity, step: 5, min: 0, suffix: '%', onChange: (n) => { setAnnuityShare(r, n, equityBefore); rerender(); } }),
      selectField<AnnuityKind>('annuityKind', 'Annuity type', r.annuityKind,
        (Object.keys(ANNUITY_KINDS) as AnnuityKind[]).map((k): [AnnuityKind, string] => [k, `${ANNUITY_KINDS[k].label}, ${pct(rateAt(k))} / yr`]),
        (v) => { r.annuityKind = v; rerender(); },
        `First-year payout per dollar of premium, buying at ${settings.retireAge}${joint ? ' for a couple' : ''}.\n\n${(Object.keys(ANNUITY_KINDS) as AnnuityKind[]).map((k) => `- **${ANNUITY_KINDS[k].label}** ${pct(rateAt(k))}: ${ANNUITY_KINDS[k].note}`).join('\n')}\n\n${PAYOUT_SOURCE}`)),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Income', help("Social security for the household, in today's dollars.\n\n- Pick a rough level and the amount fills in\n- The claiming age scales it\n- Type an amount to override\n\nUp to 85% of it is taxable, by the IRS provisional-income test.")),
      selectField<SsLevel>('ssLevel', 'Social security', r.ssLevel,
        [...(Object.keys(SS_LEVELS) as Exclude<SsLevel, 'custom'>[]).map((k): [SsLevel, string] => [k, SS_LEVELS[k].label]), ['custom', 'Custom amount']],
        (v) => { r.ssLevel = v; syncSocialSecurity(r); rerender(); },
        "Per person at 67, doubled when filing jointly.\n\n- **Low** $1,200: a full career at $25k to $35k a year. About the floor for anyone who worked full time for 35 years.\n- **Average** $2,000: the 2025 average benefit, a median-wage career of about $60k\n- **High** $3,000: a career averaging about $120k\n- **Maximum** $4,000: 35 years at or above the wage cap, $176k in 2025"),
      selectField<string>('ssAge', 'Claim at', String(r.ssStartAge), [['62', '62 (earliest, 70%)'], ['65', '65 (87%)'], ['67', '67 (full, 100%)'], ['70', '70 (124%)']],
        (v) => { r.ssStartAge = Number(v); syncSocialSecurity(r); rerender(); },
        'Full retirement age is 67 for anyone born 1960 or later.\n\nClaiming earlier cuts the benefit for life, down to 70% at 62. Waiting adds 8% a year, up to 124% at 70. Nothing is paid before this age.'),
      numberField({ key: 'ss', label: 'Household / mo', value: r.ssMonthly, step: 100, suffix: '$', onChange: (n) => { r.ssMonthly = n; r.ssLevel = 'custom'; rerender(); } }),
      numberField({ key: 'addl', label: 'Other income / yr', value: r.addlIncome, step: 1000, suffix: '$', onChange: (n) => { r.addlIncome = n; rerender(); } })),
    h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Taxes', help("2025 federal brackets and standard deduction, applied to today's-dollar income.\n\nSocial security is taxed on provisional income. The rule-of-thumb rate only feeds the comparison under **First-year withdrawal**.")),
      selectField<Filing>('filing', 'Filing', r.filing, [['single', 'Single'], ['married', 'Married joint']], (v) => { r.filing = v; syncSocialSecurity(r); rerender(); }),
      numberField({ key: 'state', label: 'State tax (flat)', value: r.stateRate, step: 0.5, suffix: '%', onChange: (n) => { r.stateRate = n; rerender(); } }),
      numberField({ key: 'swr', label: 'Rule-of-thumb rate', value: r.swr, step: 0.25, suffix: '%', onChange: (n) => { r.swr = n; rerender(); } })),
  );

  // Out-of-range or out-of-order inputs get a message where the results would be, never a confident number.
  if (problems.length) return h('div', { class: 'tab' }, controls, problemsNote(problems));
  const plan = evaluate();
  const { portfolioReal: total, gainFraction: gainFrac, sim, shared, annuity } = plan;
  // What stays invested after the annuity's premium; every chart and table below starts from it.
  const balances = shared.balances;

  // The question: can the portfolio pay these costs from retirement to end age?
  const failures = { length: plan.failures };
  const worstAge = plan.earliestDepletionAge;
  const tone = sim.successRate >= 0.9 ? 'good' : sim.successRate >= 0.75 ? undefined : 'bad';
  const firstNeed = { gross: plan.firstYearGross, tax: plan.firstYearTax };
  const conv = plan.firstYear;
  const rate = plan.withdrawalRate;
  const ruleOfThumb = { net: plan.ruleOfThumbNet };

  const headline = h('section', { class: 'stats' },
    stat('Success rate', pct(sim.successRate, 0), `${sim.runs.length - failures.length} of ${sim.runs.length} historical start years (${plan.firstStartYear} to ${plan.lastStartYear})`, tone,
      `The plan is replayed once from every year in the market record with ${horizon} years of data after it, using that stretch's actual S&P 500 and Treasury returns${annuity ? ' and inflation, which sets what the annuity buys' : ''}. Each year it withdraws exactly what covers ${usd(r.costs / 12)} a month of variable expenses${fixed ? ' plus the fixed expenses' : ''} after tax, drawing from the buckets by the ${DRAW_ORDERS[r.drawOrder].label} strategy. ` +
      (failures.length ? `It ran out of money in ${failures.length} sequences, the earliest at age ${worstAge}.` : 'It never ran out of money.')),
    annuity
      ? stat(`Portfolio at ${settings.retireAge}`, usd(total), `${usdK(annuity.premium)} buys the annuity · ${usdK(plan.invested)} stays invested`, undefined,
        `The annuity is bought on the first day of retirement out of pre-tax savings. It pays **${usd(annuity.payment)}** the first year, ${pct(annuity.rate)} of its price, for life.\n\n${ANNUITY_KINDS[annuity.kind].note}\n\nIn nominal dollars the portfolio is ${usdK(plan.portfolioNominal)}.`)
      : stat(`Portfolio at ${settings.retireAge}`, usd(total), `today's dollars · ${usdK(plan.portfolioNominal)} nominal`),
    stat('First-year withdrawal', usd(firstNeed.gross), `${pct(rate, 2)} of ${annuity ? 'what stays invested' : 'the portfolio'}, ${usd(firstNeed.tax)} of it tax${conv.converted > 0 ? ` (includes ${usd(conv.conversionTax)} on the Roth conversion) · ${usd(conv.converted)} more converted to Roth` : ''}${plan.firstYearResaved > 0 ? ` · ${usd(plan.firstYearResaved)} of required minimum re-saved` : ''}`, undefined,
      `What the first year takes out to cover costs and tax.\n\n- **Roth conversion**: the converted dollars move between buckets without being spent, so they are not counted. Their tax is paid this year and is counted.\n- **Required minimum**: from 75, dollars drawn beyond what the year needs are saved back into taxable and not counted. Their tax is counted.\n\nFor comparison, a flat ${r.swr}% rule would give ${usd(ruleOfThumb.net)} a year after tax, ${signed(ruleOfThumb.net - plan.firstYearCosts)} versus your first year's ${fixed ? 'variable and fixed expenses' : 'expenses'}.`),
    stat(`Median balance at ${r.endAge}`, usd(sim.medianEnding), `worst case ${sim.worst ? (sim.worst.depletedAt ? `runs out at ${sim.worst.depletedAt} (retiring ${sim.worst.startYear})` : `${usdK(sim.worst.ending)} left (retiring ${sim.worst.startYear})`) : ''}`),
  );

  // A chat scenario can be ghosted onto the fan chart as a second median line.
  // A ghost whose inputs clash with the live plan is kept but not drawn, and its chip says why.
  let ghostLine: FanGhost | undefined;
  let ghostChip: HTMLElement | null = null;
  const live = evaluateGhost(evaluateWith);
  const removeGhost = (): HTMLElement => h('button', { class: 'chip-x', type: 'button', title: 'Remove from chart', onclick: () => { setGhost(null); rerender(); } }, '×');
  if (live && 'problem' in live) {
    ghostChip = h('span', { class: 'ghost-chip' }, h('span', { class: 'dot ghost' }), `${live.ghost.label} · not drawn: ${live.problem}`, removeGhost());
  } else if (live) {
    const { ghost: gh, plan: g } = live;
    ghostLine = { label: gh.label, startAge: g.retireAge, values: g.sim.bands.map((b) => b.p50) };
    const changes = describeOverrides(gh.overrides).join(', ');
    const drawn = ghostPoints(sim.bands.length, settings.retireAge, ghostLine).length > 1;
    const text = [changes.toLowerCase() === gh.label.toLowerCase() ? gh.label : `${gh.label}: ${changes}`, `${pct(g.successRate, 0)} success`,
      ...(drawn ? [] : [`not drawn: retiring at ${g.retireAge} leaves no line inside this chart's ages ${settings.retireAge} to ${r.endAge}`])].join(' · ');
    ghostChip = h('span', { class: 'ghost-chip' }, h('span', { class: 'dot ghost' }), text, removeGhost());
  }
  const fan = h('section', {}, h('h2', {}, 'Balance through retirement, across every historical sequence', ghostChip),
    fanChart({ bands: sim.bands, startAge: settings.retireAge, reference: plan.invested, ghost: ghostLine }));

  const compare = allocationSection(plan, rerender);

  // Where each year's spending comes from, at the historical median real return.
  const med = medianRealReturn(plan.stockShare);
  const typical = plan.typical;
  const labels = typical.map((y) => String(y.age));
  // The ladder's conversions get their own series beside the strategy's own, shown only when it converts anything.
  const laddered = typical.some((y) => y.ladder > 0);
  const ladderSeries = (label: string) => laddered ? [{ label, cls: 's7', values: typical.map((y) => y.ladder) }] : [];
  const sources = stackedBars({ labels, series: [
    { label: 'Portfolio withdrawals (after tax)', cls: 's1', values: typical.map((y) => Math.max(0, y.gross - y.tax - y.surplus - y.converted)) },
    { label: 'Converted to Roth', cls: 's5', values: typical.map((y) => y.converted - y.ladder) },
    ...ladderSeries('Roth ladder conversion'),
    { label: 'Required minimum, re-saved', cls: 's6', values: typical.map((y) => y.surplus) },
    { label: 'Social security', cls: 's3', values: typical.map((y) => y.socialSecurity) },
    ...(annuity ? [{ label: 'Annuity', cls: 's8', values: typical.map((y) => y.annuity) }] : []),
    { label: 'Other income', cls: 's4', values: typical.map(() => r.addlIncome) },
  ], negative: { label: 'Tax paid', cls: 's2', values: typical.map((y) => y.tax) } });
  // A level or 2%-raise payment against the assumed inflation, in real terms per year.
  const raise = annuity ? ANNUITY_KINDS[annuity.kind].raise : 0;
  const realDrift = (1 + raise) / (1 + settings.inflation / 100) - 1;
  const annuityLine = !annuity ? '' : `\n- **Annuity** is its payment, ${raise ? `up ${pct(raise, 0)} a year in dollars` : 'fixed in dollars'}. At the assumed ${pct(settings.inflation / 100)} inflation it buys ${pct(Math.abs(realDrift))} ${realDrift < 0 ? 'less' : 'more'} each year.`;
  const income = h('section', {}, h('h2', {}, 'Where each year\'s spending comes from', help(`One path at the historical median real return of **${pct(med)}** a year.\n${annuityLine}\n- **Converted to Roth** is pre-tax money moved into Roth under a bracket-fill strategy. It is taxed this year and not spent.\n- **Roth ladder conversion** is what the ladder below converts before social security, beyond the room a fill strategy would convert that year.\n- **Required minimum, re-saved** is pre-tax money forced out from 75 beyond what the year needs, taxed and saved into the taxable account.`)), sources);
  // The same years split by which account type the withdrawal came from.
  const byBucket = stackedBars({ labels, series: [
    { label: 'Pre-tax (taxed as income)', cls: 's1', values: typical.map((y) => Math.max(0, y.from.pretax - y.surplus - y.converted)) },
    { label: 'Pre-tax converted to Roth', cls: 's4', values: typical.map((y) => y.converted - y.ladder) },
    ...ladderSeries('Pre-tax laddered to Roth'),
    { label: 'Required minimum, re-saved', cls: 's6', values: typical.map((y) => y.surplus) },
    { label: 'Roth (tax-free)', cls: 's3', values: typical.map((y) => y.from.roth) },
    { label: 'Taxable (gains taxed)', cls: 's2', values: typical.map((y) => y.from.taxable) },
  ], negative: { label: 'Tax paid', cls: 's5', values: typical.map((y) => y.tax) } });
  // Draw order: a preset for which bucket each year's withdrawal comes from.
  const order = DRAW_ORDERS[r.drawOrder];
  // Draw order as a segmented control in the section header; each option carries its note as a hover tip.
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Withdrawal strategy' },
    ...(Object.keys(DRAW_ORDERS) as DrawOrder[]).map((k) => h('button', {
      type: 'button', class: k === r.drawOrder ? 'on' : '', role: 'radio', 'aria-checked': String(k === r.drawOrder), 'data-tip': DRAW_ORDERS[k].note,
      onclick: () => { r.drawOrder = k; rerender(); },
    }, DRAW_ORDERS[k].label)));
  const buckets = h('section', {}, h('div', { class: 'sec-head' },
    h('h2', {}, 'Withdrawals by account type', help(`Which bucket each year's withdrawal comes from, under the strategy picked on the right. When one runs dry the next takes over.\n\n- **Pre-tax** (401k, 403b, IRA) is taxed as income when withdrawn\n- **Taxable** (brokerage) is taxed only on its gain share\n- **Roth** (post-tax) is tax free\n\nThe fill strategies also convert pre-tax to Roth with whatever room is left in the bracket. Age rules sit on top. Before 59.5, penalty-free money goes first: taxable, Roth contributions (about ${usd(shared.rothBasis ?? 0)}), and pre-tax under the rule of 55. Anything past that costs 10% extra. From 75, pre-tax must pay its required minimum and the surplus is saved into taxable.`)),
    seg), byBucket);
  // The same path as balances: what each bucket holds at the end of every retirement year.
  // Share view is the default: a 100% stack keeps Roth legible when the taxable bucket balloons late in retirement.
  const pathSeries = (share: boolean) => {
    const rows = [balances, ...typical.map((y) => y.balances)];
    const tot = rows.map((b) => b.pretax + b.roth + b.taxable);
    return BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], cls: b, values: rows.map((x, i) => share ? (tot[i]! > 0 ? x[b] / tot[i]! : 0) : x[b]) }));
  };
  const pathChart = (share: boolean): HTMLElement => stackedArea(share
    ? { startAge: settings.retireAge, height: 240, series: pathSeries(true), format: (v) => pct(v, 0), max: 1 }
    : { startAge: settings.retireAge, height: 240, series: pathSeries(false) });
  let pathShare = true;
  let pathEl = pathChart(pathShare);
  const pathSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Scale' });
  const pathBtn = (share: boolean, label: string, tip: string): HTMLElement => h('button', {
    type: 'button', class: share === pathShare ? 'on' : '', role: 'radio', 'aria-checked': String(share === pathShare), 'data-tip': tip,
    onclick: () => {
      pathShare = share;
      for (const btn of pathSeg.children) { btn.classList.toggle('on', btn === (share ? shareBtn : dollarBtn)); btn.setAttribute('aria-checked', String(btn === (share ? shareBtn : dollarBtn))); }
      const next = pathChart(share); pathEl.replaceWith(next); pathEl = next;
    },
  }, label);
  const shareBtn = pathBtn(true, 'Share', 'Each bucket as a share of the whole portfolio, so the mix stays readable when the total grows large.');
  const dollarBtn = pathBtn(false, 'Dollars', "Balances in today's dollars.");
  pathSeg.append(shareBtn, dollarBtn);
  const bucketPath = h('section', {}, h('div', { class: 'sec-head' },
    h('h2', {}, 'Balance by tax bucket through retirement', help('One path at the median real return.\n\n- **Share** shows the mix: Roth growing under a fill strategy, pre-tax shrinking as conversions and required minimums move it out.\n- **Dollars** shows the size in today\'s dollars.')),
    pathSeg), pathEl);

  const ladder = rothLadderSection(typical, rerender);

  const atRetire = plan.firstYear;
  const split = h('section', {}, h('h2', {}, 'First-year withdrawal by bucket', help(`${annuity ? `The pre-tax balance is what is left after ${usd(annuity.premium)} buys the annuity. The annuity's row shows that premium and its first payment.\n\n` : ''}**Federal** ${usd(atRetire.tax.federal)}, **state** ${usd(atRetire.tax.state)}, effective ${pct(atRetire.tax.effectiveRate)}.${atRetire.penalty > 0 ? ` ${usd(atRetire.penalty)} of that is the 10% early-withdrawal penalty.` : ''}\n\n${settings.retireAge >= r.ssStartAge ? `${usd(atRetire.tax.taxableSS)} of social security is taxable.` : `Social security starts at ${r.ssStartAge}.`} 2025 brackets and standard deduction.${atRetire.converted > 0 ? `\n\n**Withdrawn** leaves out the ${usd(atRetire.converted)} of pre-tax converted to Roth this year; its ${usd(atRetire.conversionTax)} of tax is included above.` : ''}${plan.firstYearResaved > 0 ? `\n\n**Withdrawn** also leaves out the ${usd(plan.firstYearResaved)} of required minimum saved back into taxable; its tax is included above.` : ''}`)),
    table(['Bucket', "Balance (today's $)", 'Share', 'Withdrawn', 'Taxed as'],
      BUCKETS.map((b) => [BUCKET_LABEL[b], usd(balances[b]), pct(total > 0 ? balances[b] / total : 0), usd(b === 'pretax' ? atRetire.fromBuckets.pretax - atRetire.converted - plan.firstYearResaved : atRetire.fromBuckets[b]),
        b === 'pretax' ? 'ordinary income' : b === 'roth' ? 'nothing' : `${pct(gainFrac)} of it is gain, at capital gains rates`])
        .concat(annuity ? [['Annuity', usd(annuity.premium), pct(total > 0 ? annuity.premium / total : 0), `${usd(annuity.payment)} paid`, 'ordinary income']] : [])));

  const grid = h('section', {}, h('h2', {}, 'Success rate by spending and retirement age', help([annuity ? `Each age buys the same ${r.annuity}% annuity at that age's rate. **—** means pre-tax savings would not cover it.` : 'Each cell replays the plan from every historical start year.',
    ...(fixed ? ['Rows vary the variable expenses. The fixed expenses stay as set, worth more the earlier you retire.'] : [])].join('\n\n'))), sensitivity(shared));

  return h('div', { class: 'tab' }, controls, headline, fan, compare, income, buckets, ladder, bucketPath, split, grid);
}

/**
 * The Roth conversion ladder: a preset in the section header (off, a fixed
 * amount, or fill a bracket) and, when on, one row per gap year between
 * retirement and social security on the median-return path.
 */
function rothLadderSection(typical: DrawdownYear[], rerender: () => void): HTMLElement {
  const r = settings.retire;
  const gap = typical.filter((y) => y.age < r.ssStartAge);
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Roth conversion ladder' },
    ...(Object.keys(LADDER_MODES) as LadderMode[]).map((k) => h('button', {
      type: 'button', class: k === r.ladder ? 'on' : '', role: 'radio', 'aria-checked': String(k === r.ladder), 'data-tip': LADDER_MODES[k].note,
      onclick: () => { r.ladder = k; rerender(); },
    }, LADDER_MODES[k].label)));
  const amount = r.ladder === 'amount'
    ? numberField({ key: 'ladderAmount', label: 'Convert / yr', value: r.ladderAmount, step: 1000, min: 0, suffix: '$', onChange: (n) => { r.ladderAmount = Math.max(0, n); rerender(); } })
    : null;
  const title = gap.length ? `Roth conversion ladder, ages ${settings.retireAge} to ${settings.retireAge + gap.length - 1}` : `Roth conversion ladder, no gap years before social security at ${r.ssStartAge}`;
  const tip = "Move pre-tax money to Roth in the low-income years between retiring and claiming social security.\n\n- **Taxed** as ordinary income the year it converts; the tax is part of that year's withdrawal, taken in your strategy's order\n- **Never penalised**, at any age, and stops once required minimums begin\n- **Five-year rule**: each conversion must sit five years before it comes out penalty-free under 59.5. Not modelled; converted dollars never count as penalty-free here\n- **From the ladder** is the part beyond the room a fill strategy converts that year; without a fill strategy it is all of it\n\nACA subsidy cliffs and Medicare IRMAA surcharges are not modelled; a large conversion can cost more than its bracket.";
  const head = h('div', { class: 'sec-head' }, h('h2', {}, title, help(tip)), h('div', { class: 'sec-tools' }, amount, seg));
  if (r.ladder === 'off' || !gap.length) return h('section', {}, head);
  const total = (f: (y: DrawdownYear) => number): number => gap.reduce((a, y) => a + f(y), 0);
  const rows = gap.map((y) => [String(y.age), usd(y.converted), usd(y.ladder), usd(y.tax), usd(y.balances.pretax), usd(y.balances.roth)]);
  rows.push(['Total', usd(total((y) => y.converted)), usd(total((y) => y.ladder)), usd(total((y) => y.tax)), '', '']);
  return h('section', {}, head, table(['Age', 'Converted to Roth', 'From the ladder', 'Tax that year', 'Pre-tax at year end', 'Roth at year end'], rows));
}

/**
 * Allocations worth choosing between, each replayed as the whole plan with
 * everything else as set. Use copies one into the plan; the annuity type is
 * whatever the plan has.
 */
const ALLOCATIONS: { label: string; equity: number; annuity: number; note: string }[] = [
  { label: 'All S&P 500', equity: 100, annuity: 0, note: 'The most growth and the deepest drops. A bad first decade does the most damage.' },
  { label: '60 / 40', equity: 60, annuity: 0, note: 'The classic balanced mix. Treasuries soften stock crashes but lost to inflation through the 1970s.' },
  { label: 'Annuity floor', equity: 70, annuity: 30, note: 'Turn 30% into income for life and keep the rest in stocks. The annuity cannot run out, but its money is gone for good.' },
  { label: 'Three ways', equity: 50, annuity: 20, note: 'An annuity for a floor, Treasuries for the dips, the S&P 500 for growth.' },
];

function allocationSection(plan: PlanSummary, rerender: () => void): HTMLElement {
  const r = settings.retire;
  const custom = !ALLOCATIONS.some((a) => a.equity === r.equity && a.annuity === r.annuity);
  const rows = [...(custom ? [{ label: 'Your mix', equity: r.equity, annuity: r.annuity }] : []), ...ALLOCATIONS];
  const cells = rows.map((a) => {
    const current = a.equity === r.equity && a.annuity === r.annuity;
    const mix = [`${a.equity}%`, `${Math.max(0, 100 - a.equity - a.annuity)}%`, `${a.annuity}%`];
    const use = current ? h('span', { class: 'muted' }, 'current')
      : h('button', { type: 'button', class: 'btn tiny', onclick: () => { r.equity = a.equity; r.annuity = a.annuity; rerender(); } }, 'Use');
    const overrides = { retire: { equity: a.equity, annuity: a.annuity } };
    if (!current && overrideProblems(overrides).length) return [a.label, ...mix, 'pre-tax too small', '—', '—', '—', ''];
    const p = current ? plan : evaluateWith(overrides);
    const worst = p.worst ? (p.worst.depletedAt ? `runs out at ${p.worst.depletedAt}` : `${usdK(p.worst.ending)} left`) : '—';
    const tone = p.successRate >= 0.9 ? 'pos' : p.successRate < 0.75 ? 'neg' : '';
    return [a.label, ...mix, p.annuity ? usd(p.annuity.payment) : '—', h('span', { class: tone }, pct(p.successRate, 0)), usdK(p.medianEnding), worst, use];
  });
  const tip = `Each row replays the whole plan with that split, everything else as set above.\n\n${ALLOCATIONS.map((a) => `- **${a.label}**: ${a.note}`).join('\n')}`;
  return h('section', {}, h('h2', {}, 'Compare allocations', help(tip)),
    table(['Allocation', 'S&P 500', 'Treasuries', 'Annuity', 'Annuity pays / yr', 'Success', `Median at ${r.endAge}`, 'Worst case', ''], cells,
      { classes: rows.map((a) => a.equity === r.equity && a.annuity === r.annuity ? 'current' : '') }));
}

function sensitivity(shared: PlanSummary['shared']): HTMLElement {
  const r = settings.retire;
  const ages = [shared.startAge - 5, shared.startAge - 2, shared.startAge, shared.startAge + 2, shared.startAge + 5].filter((a) => a > settings.currentAge && a < shared.endAge);
  // Rows step the variable expenses in whole hundreds a month, the unit the field takes.
  const costs = [0.7, 0.85, 1, 1.15, 1.3].map((k) => Math.round(shared.costs * k / 1200) * 1200);
  // Each age buys the annuity out of that age's balances at that age's rate.
  const starts = ages.map((age) => {
    const b = bucketsAt(age - settings.currentAge);
    const bought = annuityAt(r, age, b);
    return r.annuity > 0 && !bought ? null : { balances: bought?.balances ?? b, annuity: bought ? { payment: bought.payment, raise: ANNUITY_KINDS[bought.kind].raise } : null };
  });
  const rows = costs.map((c) => [usd(c / 12) + ' / mo', ...ages.map((age, i) => {
    const start = starts[i];
    if (!start) return '—';
    const s = simulate({ ...shared, startAge: age, costs: c, ...start, fixed: fixedAt(age) });
    return h('span', { class: s.successRate >= 0.9 ? 'pos' : s.successRate < 0.75 ? 'neg' : '' }, pct(s.successRate, 0));
  })]);
  return table(['Variable expenses', ...ages.map((a) => `Retire at ${a}`)], rows);
}
