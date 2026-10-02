// The tools the chat model can call. Every number the model reports comes out
// of these; they run the same code as the tabs. Errors are returned as
// {error} so the model can fix its arguments and try again.

import { applyChecked, describeOverrides, evaluate, evaluateWith, overrideProblems, resolveAccount, withOverrides, type Overrides, type PlanSummary } from '../plan';
import { ANNUITY_KINDS, DRAW_ORDERS, LADDER_MODES, STANDARD_DEDUCTION, spendAndTax, type AnnuityKind, type LadderMode } from '../model';
import { accountBuckets, projectAccounts, real } from '../projection';
import { accounts, holdings, settings, type AccountSettings, type DrawOrder, type SsLevel } from '../state';
import type { ToolSpec } from './client';
import { setGhost, type Card, type Metrics } from './store';

const OVERRIDES_SCHEMA = {
  type: 'object',
  description: 'Inputs to change. Omit anything that stays as it is. Dollar amounts are today\'s dollars, percentages are plain numbers (7 means 7%).',
  properties: {
    currentAge: { type: 'number' },
    retireAge: { type: 'number' },
    inflation: { type: 'number', description: 'percent per year' },
    defaultCagr: { type: 'number', description: 'percent; only affects accounts without their own CAGR' },
    accounts: {
      type: 'object',
      description: 'Per-account changes keyed by account name (partial names are fine when unique).',
      additionalProperties: { type: 'object', properties: { contribution: { type: 'number', description: 'dollars per year' }, cagr: { type: 'number', description: 'percent' },
        salary: { type: 'number', description: 'dollars per year; with matchPct and matchUpToPct sets an employer match (employer plans only)' }, matchPct: { type: 'number', description: 'percent of the contribution the employer adds' }, matchUpToPct: { type: 'number', description: 'percent of salary the match stops at' } } },
    },
    retire: {
      type: 'object',
      properties: {
        costs: { type: 'number', description: 'annual spending after tax that keeps up with inflation, today\'s dollars. The Retirement tab shows it per month as Variable expenses (costs / 12). Payments fixed in dollars, like a mortgage, are separate (fixedMonthly)' },
        fixedMonthly: { type: 'number', description: 'Fixed expenses on the Retirement tab: payments fixed in dollars, like a mortgage, per month: the same dollar amount every month from now until fixedEndAge, so inflation shrinks them in today\'s dollars (each historical run by its own inflation). Spent on top of costs. 0 for none' },
        fixedEndAge: { type: 'number', description: 'age the fixed payments stop (the payoff); at or past endAge they last the whole plan' },
        equity: { type: 'number', description: 'percent of the portfolio at retirement in the S&P 500; whatever equity and annuity leave is in 10-year Treasuries. Both follow their real historical returns year by year, rebalanced annually' },
        annuity: { type: 'number', description: 'percent of the portfolio at retirement spent on a single-premium immediate annuity, bought with pre-tax money (an IRA rollover) on the retirement date; it pays for life (joint life when married) and is taxed as ordinary income. Cannot exceed the pre-tax share. Changing annuity without equity takes it out of Treasuries first' },
        annuityKind: { type: 'string', enum: Object.keys(ANNUITY_KINDS), description: Object.entries(ANNUITY_KINDS).map(([k, v]) => `${k}: ${v.note}`).join(' ') },
        ssMonthly: { type: 'number', description: 'household social security per month' },
        ssStartAge: { type: 'number', description: 'claiming age 62 to 70; the preset benefit scales with it (62 = 70%, 67 = 100%, 70 = 124%)' },
        ssLevel: { type: 'string', enum: ['none', 'low', 'average', 'high', 'max', 'custom'], description: 'rough benefit level per person at 67: low $1,200, average $2,000, high $3,000, max $4,000 (doubled when married); custom keeps ssMonthly as given' },
        addlIncome: { type: 'number', description: 'other retirement income per year' },
        filing: { type: 'string', enum: ['single', 'married'] },
        stateRate: { type: 'number', description: 'flat state tax percent' },
        endAge: { type: 'number', description: 'plan to this age' },
        swr: { type: 'number', description: 'rule-of-thumb withdrawal percent, comparison only' },
        drawOrder: { type: 'string', enum: ['fill-12', 'fill-22', 'taxable-first', 'pretax-first', 'roth-first', 'proportional'], description: 'withdrawal strategy by tax bucket. fill-12 (default, recommended): pre-tax pays spending up to the top of the 12% bracket, taxable covers the rest, Roth last, and unused bracket room converts pre-tax to Roth each year until required minimums begin; fill-22: the same up to the 22% bracket; taxable-first: taxable, pre-tax, Roth; pretax-first: pre-tax, taxable, Roth; roth-first: Roth, taxable, pre-tax; proportional: every bucket gives the same share of its balance. Age rules always apply on top (10% penalty on pre-tax and Roth earnings before 59.5 unless the rule of 55 covers it, Roth contributions penalty-free, required minimums from 75).' },
        ladder: { type: 'string', enum: ['off', 'amount', 'fill-12', 'fill-22'], description: 'Roth conversion ladder in the gap years from retirement until social security starts (none when retiring at or after the claiming age). off (default); amount: convert ladderAmount of pre-tax to Roth each gap year; fill-12 / fill-22: convert enough to fill ordinary income to the top of that bracket. Conversions are taxed as income that year (the extra tax is part of that year\'s withdrawal), are never penalised, stop once required minimums begin, and combine with a fill strategy by taking the larger conversion. The five-year rule on spending converted dollars before 59.5 is not modelled: converted dollars never count as penalty-free Roth basis.' },
        ladderAmount: { type: 'number', description: 'dollars per year converted when ladder is "amount", today\'s dollars' },
      },
    },
  },
} as const;

export const TOOLS: ToolSpec[] = [
  { name: 'get_state', description: 'Every input and every headline number of the current plan: ages, per-account balances, contributions, employer match and CAGR, retirement inputs, success rate, portfolio at retirement, first-year withdrawal, median and worst outcomes. Call this before answering anything about the plan.', parameters: { type: 'object', properties: {} } },
  { name: 'compare', description: 'Put several scenarios side by side (the current plan is always the first column). Without a sweep: one table of the headline numbers per scenario. With a sweep: success rate for every scenario at every value of one input, so "at the same spending, how do the two plans differ" and "what spending gives each plan 90%" are answered in one call.', parameters: { type: 'object', required: ['scenarios'], properties: { scenarios: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['label', 'overrides'], properties: { label: { type: 'string' }, overrides: OVERRIDES_SCHEMA } } }, sweep: { type: 'object', required: ['input', 'from', 'to', 'step'], properties: { input: { type: 'string', enum: ['retireAge', 'costs', 'fixedMonthly', 'fixedEndAge', 'equity', 'annuity', 'ssMonthly', 'ssStartAge', 'addlIncome', 'endAge', 'stateRate', 'inflation', 'defaultCagr'] }, from: { type: 'number' }, to: { type: 'number' }, step: { type: 'number' } } } } } },
  { name: 'solve', description: 'Find the largest yearly spending (costs, on top of any fixed payments), or the earliest retirement age, that still meets a target success rate, optionally under a scenario. Use for "how much can I spend", "how early can I retire", "what spending keeps me at 90%".', parameters: { type: 'object', required: ['find'], properties: { find: { type: 'string', enum: ['costs', 'retireAge'] }, successRate: { type: 'number', description: 'target, 0 to 1; default 0.9' }, overrides: { ...OVERRIDES_SCHEMA, description: 'Optional scenario to solve under.' } } } },
  { name: 'get_first_year', description: 'The first retirement year in detail: gross withdrawal, net spending, the amount drawn from each tax bucket and from each account, and the tax computation (ordinary income including any annuity payment, realised gains, taxable social security, standard deduction, federal, state). Use for "how much tax do I pay and why" and "what am I withdrawing from where". Optional overrides evaluate a what-if instead of the current plan.', parameters: { type: 'object', properties: { overrides: { ...OVERRIDES_SCHEMA, description: 'Optional what-if to evaluate instead of the current plan.' } } } },
  { name: 'get_holdings', description: 'Every position: ticker, name, value, cost basis, account, tax treatment. Use for questions about what is held where.', parameters: { type: 'object', properties: {} } },
  { name: 'run_scenario', description: 'Evaluate a what-if without changing anything. Returns the headline numbers for the current plan and for the scenario side by side, and shows the user a scenario card with an Apply button.', parameters: { type: 'object', required: ['label', 'overrides'], properties: { label: { type: 'string', description: 'short name, e.g. "Retire at 58"' }, overrides: OVERRIDES_SCHEMA } } },
  { name: 'sweep', description: 'Vary one input across a range and return the success rate and median ending balance at each step. Use for "at what age/spending/rate does X happen" questions.', parameters: { type: 'object', required: ['input', 'from', 'to', 'step'], properties: { input: { type: 'string', enum: ['retireAge', 'costs', 'fixedMonthly', 'fixedEndAge', 'equity', 'annuity', 'ssMonthly', 'ssStartAge', 'addlIncome', 'endAge', 'stateRate', 'inflation', 'defaultCagr'] }, from: { type: 'number' }, to: { type: 'number' }, step: { type: 'number' }, base: { ...OVERRIDES_SCHEMA, description: 'Optional overrides to hold fixed while sweeping.' } } } },
  { name: 'get_sequence', description: 'The year-by-year path for one historical start year under the current plan (or overrides): balance, withdrawal (spending plus tax, the same definition as get_first_year\'s gross), tax, social security, annuity income (when the plan buys one), Roth conversion and any re-saved required minimum each year, and whether it ran out.', parameters: { type: 'object', required: ['startYear'], properties: { startYear: { type: 'number', description: '1928 or later' }, overrides: OVERRIDES_SCHEMA } } },
  { name: 'show_on_chart', description: 'Draw a scenario\'s median balance as a dashed ghost line on the Retirement tab\'s fan chart, next to the current plan, without changing the plan. One ghost at a time: a new one replaces the old. To ghost a sweep row, pass that row\'s inputs (the sweep base plus the swept value). clear: true removes the ghost.', parameters: { type: 'object', properties: { label: { type: 'string', description: 'short name shown on the chart, e.g. "Retire at 60"' }, overrides: OVERRIDES_SCHEMA, clear: { type: 'boolean', description: 'remove the ghost instead of setting one' } } } },
  { name: 'apply_scenario', description: 'Write overrides into the live plan so every tab reflects them. Only call when the user clearly asked to change the plan, not for what-ifs.', parameters: { type: 'object', required: ['overrides'], properties: { overrides: OVERRIDES_SCHEMA } } },
];

export interface ToolOutcome { result: string; card?: Card }

export function metrics(p: PlanSummary): Metrics {
  return {
    retireAge: p.retireAge, endAge: p.endAge, portfolioReal: Math.round(p.portfolioReal), successRate: p.successRate, failures: p.failures, runs: p.runs,
    medianEnding: Math.round(p.medianEnding), firstYearGross: Math.round(p.firstYearGross), firstYearTax: Math.round(p.firstYearTax),
    withdrawalRate: p.withdrawalRate, worstEnding: Math.round(p.worst?.ending ?? 0), worstYear: p.worst?.startYear ?? null,
    medianPath: p.sim.bands.map((b) => Math.round(b.p50)),
    lifetimeTax: Math.round(p.typical.reduce((a, y) => a + y.tax, 0)),
    lifetimeWithdrawals: Math.round(p.typical.reduce((a, y) => a + spendAndTax(y), 0)),
    lifetimeSocialSecurity: Math.round(p.typical.reduce((a, y) => a + y.socialSecurity, 0)),
    lifetimeRothConversions: Math.round(p.typical.reduce((a, y) => a + y.converted, 0)),
  };
}

const usd0 = (n: number): string => `$${Math.round(n).toLocaleString()}`;

function summary(p: PlanSummary): Record<string, unknown> {
  const m = metrics(p);
  return {
    retireAge: m.retireAge, endAge: m.endAge, yearsToRetire: p.yearsToRetire, costsPerYear: p.costs,
    fixedPayments: p.fixed ? { perMonthInDollars: settings.retire.fixedMonthly, paidOffAt: settings.retire.fixedEndAge, firstYearTodaysDollars: Math.round(p.fixed.annual), years: p.fixed.years } : null,
    portfolioAtRetirementTodaysDollars: m.portfolioReal, portfolioAtRetirementNominal: Math.round(p.portfolioNominal),
    bucketsAtRetirement: { pretax: Math.round(p.buckets.pretax), roth: Math.round(p.buckets.roth), taxable: Math.round(p.buckets.taxable) },
    allocation: { sp500Pct: settings.retire.equity, treasuriesPct: Math.max(0, 100 - settings.retire.equity - settings.retire.annuity), annuityPct: settings.retire.annuity,
      investedAfterAnnuity: Math.round(p.invested), sp500ShareOfInvested: Number(p.stockShare.toFixed(3)) },
    annuity: p.annuity ? { kind: p.annuity.kind, premium: Math.round(p.annuity.premium), payoutRate: Number(p.annuity.rate.toFixed(4)), firstYearPayment: Math.round(p.annuity.payment) } : null,
    successRate: Number(m.successRate.toFixed(3)), historicalStartYears: `${p.firstStartYear} to ${p.lastStartYear} (${m.runs} runs)`, failedSequences: m.failures,
    earliestDepletionAge: p.earliestDepletionAge, medianBalanceAtEnd: m.medianEnding,
    worstSequence: p.worst ? { startYear: p.worst.startYear, ranOutAtAge: p.worst.depletedAt, endingBalance: Math.round(p.worst.ending) } : null,
    bestSequence: p.best ? { startYear: p.best.startYear, endingBalance: Math.round(p.best.ending) } : null,
    firstYearWithdrawal: m.firstYearGross, firstYearTax: m.firstYearTax, firstYearWithdrawalRate: Number(m.withdrawalRate.toFixed(4)),
    overMedianReturnPath: { totalTax: m.lifetimeTax, totalWithdrawn: m.lifetimeWithdrawals, totalSocialSecurity: m.lifetimeSocialSecurity, totalRothConversions: m.lifetimeRothConversions },
    flatRuleAfterTaxIncome: Math.round(p.ruleOfThumbNet),
  };
}

function num(v: unknown, name: string, lo = -Infinity, hi = Infinity): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
  return n;
}

const RETIRE_KEYS = ['costs', 'fixedMonthly', 'fixedEndAge', 'equity', 'annuity', 'annuityKind', 'ssMonthly', 'ssStartAge', 'addlIncome', 'filing', 'stateRate', 'endAge', 'swr', 'drawOrder', 'ssLevel', 'ladder', 'ladderAmount'] as const;

/** Check the shape of model-supplied overrides; throws a message the model can act on. Ranges are checked on the overridden plan by inputProblems (withOverrides, applyChecked). Empty nested objects are dropped, so `{ retire: {} }` normalises to `{}`. */
export function parseOverrides(raw: unknown): Overrides {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') throw new Error('overrides must be an object');
  const o = raw as Record<string, unknown>;
  const out: Overrides = {};
  if (o.currentAge !== undefined) out.currentAge = num(o.currentAge, 'currentAge');
  if (o.retireAge !== undefined) out.retireAge = num(o.retireAge, 'retireAge');
  if (o.inflation !== undefined) out.inflation = num(o.inflation, 'inflation');
  if (o.defaultCagr !== undefined) out.defaultCagr = num(o.defaultCagr, 'defaultCagr');
  if (o.retire !== undefined) {
    if (typeof o.retire !== 'object' || o.retire === null) throw new Error('retire must be an object');
    const r = o.retire as Record<string, unknown>;
    const unknown = Object.keys(r).filter((k) => !(RETIRE_KEYS as readonly string[]).includes(k));
    if (unknown.length) throw new Error(`unknown retire keys: ${unknown.join(', ')}. Allowed: ${RETIRE_KEYS.join(', ')}`);
    out.retire = {};
    if (r.costs !== undefined) out.retire.costs = num(r.costs, 'retire.costs');
    if (r.fixedMonthly !== undefined) out.retire.fixedMonthly = num(r.fixedMonthly, 'retire.fixedMonthly');
    if (r.fixedEndAge !== undefined) out.retire.fixedEndAge = num(r.fixedEndAge, 'retire.fixedEndAge');
    if (r.equity !== undefined) out.retire.equity = num(r.equity, 'retire.equity');
    if (r.annuity !== undefined) out.retire.annuity = num(r.annuity, 'retire.annuity');
    if (r.annuityKind !== undefined) {
      if (typeof r.annuityKind !== 'string' || !(r.annuityKind in ANNUITY_KINDS)) throw new Error(`retire.annuityKind must be one of ${Object.keys(ANNUITY_KINDS).join(', ')}`);
      out.retire.annuityKind = r.annuityKind as AnnuityKind;
    }
    if (r.ssMonthly !== undefined) out.retire.ssMonthly = num(r.ssMonthly, 'retire.ssMonthly');
    if (r.ssStartAge !== undefined) out.retire.ssStartAge = num(r.ssStartAge, 'retire.ssStartAge');
    if (r.addlIncome !== undefined) out.retire.addlIncome = num(r.addlIncome, 'retire.addlIncome');
    if (r.stateRate !== undefined) out.retire.stateRate = num(r.stateRate, 'retire.stateRate');
    if (r.endAge !== undefined) out.retire.endAge = num(r.endAge, 'retire.endAge');
    if (r.swr !== undefined) out.retire.swr = num(r.swr, 'retire.swr');
    if (r.ssLevel !== undefined) {
      if (typeof r.ssLevel !== 'string' || !['none', 'low', 'average', 'high', 'max', 'custom'].includes(r.ssLevel)) throw new Error('retire.ssLevel must be none, low, average, high, max or custom');
      out.retire.ssLevel = r.ssLevel as SsLevel;
    }
    if (r.drawOrder !== undefined) {
      if (typeof r.drawOrder !== 'string' || !(r.drawOrder in DRAW_ORDERS)) throw new Error(`retire.drawOrder must be one of ${Object.keys(DRAW_ORDERS).join(', ')}`);
      out.retire.drawOrder = r.drawOrder as DrawOrder;
    }
    if (r.ladder !== undefined) {
      if (typeof r.ladder !== 'string' || !(r.ladder in LADDER_MODES)) throw new Error(`retire.ladder must be one of ${Object.keys(LADDER_MODES).join(', ')}`);
      out.retire.ladder = r.ladder as LadderMode;
    }
    if (r.ladderAmount !== undefined) out.retire.ladderAmount = num(r.ladderAmount, 'retire.ladderAmount');
    if (r.filing !== undefined) {
      if (r.filing !== 'single' && r.filing !== 'married') throw new Error('retire.filing must be "single" or "married"');
      out.retire.filing = r.filing;
    }
    if (!Object.keys(out.retire).length) delete out.retire;
  }
  if (o.accounts !== undefined) {
    if (typeof o.accounts !== 'object' || o.accounts === null) throw new Error('accounts must be an object keyed by account name');
    out.accounts = {};
    for (const [name, patch] of Object.entries(o.accounts as Record<string, unknown>)) {
      const key = resolveAccount(name);
      if (!key) throw new Error(`no account matches "${name}". Accounts: ${accounts.map((a) => a.name).join(', ')}`);
      if (typeof patch !== 'object' || patch === null) throw new Error(`accounts["${name}"] must be an object`);
      const p = patch as Record<string, unknown>;
      const entry: Partial<AccountSettings> = {};
      if (p.contribution !== undefined) entry.contribution = num(p.contribution, `accounts["${name}"].contribution`);
      if (p.cagr !== undefined) entry.cagr = num(p.cagr, `accounts["${name}"].cagr`);
      if (p.salary !== undefined) entry.salary = num(p.salary, `accounts["${name}"].salary`);
      if (p.matchPct !== undefined) entry.matchPct = num(p.matchPct, `accounts["${name}"].matchPct`);
      if (p.matchUpToPct !== undefined) entry.matchUpToPct = num(p.matchUpToPct, `accounts["${name}"].matchUpToPct`);
      if (Object.keys(entry).length) out.accounts[key] = entry;
    }
    if (!Object.keys(out.accounts).length) delete out.accounts;
  }
  return out;
}

/** Round a step up to a multiple of the model's own step (1000 stays 1000, 2500 becomes 3000 for a 1000 grid, etc). */
function niceStep(target: number, unit: number): number {
  return Math.ceil(target / unit) * unit;
}

/** The values from `from` to `to` by `step`, computed as from + i*step and rounded so 2 + 3*0.1 is 2.3, not 2.3000000000000003. */
function sweepValues(from: number, to: number, step: number): number[] {
  const dir = to >= from ? 1 : -1;
  const values: number[] = [];
  for (let i = 0; i < 60; i++) {
    const v = Math.round((from + dir * i * step) * 1e10) / 1e10;
    if (dir * (v - to) > 1e-9) break;
    values.push(v);
  }
  return values;
}

/** Chip and button label for one sweep row, in the words scenario cards use: "Retire at 65", "Inflation 2.3%". */
export function sweepLabel(input: string, value: number): string {
  const d = describeOverrides(sweepOverride(input, value, {}))[0] ?? `${input} ${value}`;
  return d.charAt(0).toUpperCase() + d.slice(1);
}

function sweepOverride(input: string, value: number, base: Overrides): Overrides {
  const o: Overrides = structuredClone(base);
  if (input === 'retireAge' || input === 'inflation' || input === 'defaultCagr') o[input] = value;
  else if (['costs', 'fixedMonthly', 'fixedEndAge', 'equity', 'annuity', 'ssMonthly', 'ssStartAge', 'addlIncome', 'endAge', 'stateRate'].includes(input)) o.retire = { ...(o.retire ?? {}), [input]: value };
  else throw new Error(`cannot sweep "${input}"`);
  return o;
}

export function runTool(name: string, args: Record<string, unknown>, ui: { rerender: () => void }): ToolOutcome {
  try {
    switch (name) {
      case 'get_state': {
        const p = evaluate();
        const projs = projectAccounts();
        return { result: JSON.stringify({
          inputs: { currentAge: settings.currentAge, retireAge: settings.retireAge, inflationPct: settings.inflation, defaultCagrPct: settings.defaultCagr, retire: settings.retire },
          accounts: accounts.map((a) => ({ name: a.name, broker: a.broker, type: a.accountType, taxBucket: a.bucket, valueToday: Math.round(a.value),
            contributionPerYear: settings.accounts[a.name]?.contribution ?? 0, employerMatchPerYear: Math.round(projs.find((x) => x.account === a)?.match ?? 0),
            cagrPct: settings.accounts[a.name]?.cagr ?? settings.defaultCagr })),
          plan: summary(p),
          notes: 'All retirement figures are today\'s dollars. Success rate = share of historical start years (real S&P 500 and 10-year Treasury returns from 1928, and that run\'s actual inflation for a level annuity) in which the portfolio covered costs, plus any fixed payments shrinking with that run\'s inflation, to endAge. firstYearWithdrawalRate is over what stays invested after the annuity.',
        }) };
      }
      case 'get_first_year': {
        const overrides = parseOverrides(args.overrides);
        return withOverrides(overrides, () => {
          const p = evaluate();
          const r = settings.retire;
          const ss = p.retireAge >= r.ssStartAge ? r.ssMonthly * 12 : 0;
          const w = p.firstYear;
          const annuity = p.annuity?.payment ?? 0;
          // What the year spends from each bucket; the Roth conversion and a re-saved required minimum are reported on their own.
          // Taxable income still counts every pre-tax dollar drawn, conversion included, because the tax is computed on it.
          const spent = { ...w.fromBuckets, pretax: w.fromBuckets.pretax - w.converted - p.firstYearResaved };
          // Buckets follow the chosen strategy (see method below); inside a bucket the accounts are pro rata by projected balance.
          // An account can span two buckets (its employer match is pre-tax), so each slice is drawn from its own bucket.
          const projs = projectAccounts();
          const byAccount = projs.map((x) => {
            const balance = real(x.ending);
            const slices = accountBuckets(x);
            let withdrawal = 0;
            let taxable = 0;
            for (const b of ['pretax', 'roth', 'taxable'] as const) {
              const share = p.buckets[b] > 0 ? real(slices[b]) / p.buckets[b] : 0;
              withdrawal += spent[b] * share;
              taxable += b === 'pretax' ? w.fromBuckets.pretax * share : b === 'taxable' ? w.fromBuckets.taxable * share * p.gainFraction : 0;
            }
            const bucket = slices.pretax > 0 && x.account.bucket !== 'pretax' ? `${x.account.bucket} + pretax match` : x.account.bucket;
            return { account: x.account.name, bucket, balanceAtRetirement: Math.round(balance), withdrawal: Math.round(withdrawal), taxableIncome: Math.round(taxable) };
          }).sort((a, b) => b.withdrawal - a.withdrawal);
          const rows: (string | number)[][] = byAccount.map((a) => [a.account, a.bucket, usd0(a.balanceAtRetirement), usd0(a.withdrawal), usd0(a.taxableIncome)]);
          rows.push(['Total', '', usd0(p.portfolioReal), usd0(p.firstYearGross), usd0(w.fromBuckets.pretax + w.fromBuckets.taxable * p.gainFraction)]);
          const result = {
            age: p.retireAge, spendingTarget: Math.round(p.firstYearCosts), fixedPayments: Math.round(p.fixed?.annual ?? 0), gross: Math.round(p.firstYearGross), net: Math.round(w.net), socialSecurity: ss, otherIncome: r.addlIncome, annuity: Math.round(annuity),
            byBucket: { pretax: Math.round(spent.pretax), roth: Math.round(spent.roth), taxable: Math.round(spent.taxable) },
            byAccount,
            rothConversion: Math.round(w.converted), rothConversionTax: Math.round(w.conversionTax), rothLadderConversion: Math.round(w.ladder), requiredMinimumResaved: Math.round(p.firstYearResaved), ageRules: { retireAge: settings.retireAge, earlyWithdrawalPenalty: Math.round(w.penalty), rothContributionsPenaltyFree: Math.round(p.shared.rothBasis ?? 0), ruleOf55Applies: !!p.shared.ruleOf55 && settings.retireAge >= 55, requiredMinimum: Math.round(w.rmd) },
            tax: { ordinaryIncome: Math.round(w.fromBuckets.pretax + r.addlIncome + annuity), capitalGainsRealised: Math.round(w.fromBuckets.taxable * p.gainFraction), gainFractionOfTaxable: Number(p.gainFraction.toFixed(3)),
              taxableSocialSecurity: Math.round(w.tax.taxableSS), standardDeduction: STANDARD_DEDUCTION[r.filing], filing: r.filing, federal: Math.round(w.tax.federal), state: Math.round(w.tax.state), stateRatePct: r.stateRate, total: Math.round(w.tax.total), effectiveRate: Number(w.tax.effectiveRate.toFixed(4)) },
            method: `Strategy "${DRAW_ORDERS[r.drawOrder].label}": ${DRAW_ORDERS[r.drawOrder].note} Within a bucket, accounts are pro rata by projected balance. Pre-tax withdrawals are ordinary income, Roth is untaxed, taxable-account withdrawals are taxed only on their unrealised-gain share. Before 59.5 the order first uses penalty-free money (taxable, Roth contributions, pre-tax under the rule of 55) and only then penalised dollars at 10% extra; from 75 pre-tax pays at least its required minimum. 2025 federal brackets on today's dollars, flat state rate on federal taxable income.`,
          };
          return { result: JSON.stringify(result), card: { type: 'table', title: `First retirement year at ${p.retireAge}: ${usd0(p.firstYearGross)} withdrawn, ${usd0(w.tax.total)} tax${w.converted > 0 ? `, ${usd0(w.converted)} converted to Roth` : ''}${p.firstYearResaved > 0 ? `, ${usd0(p.firstYearResaved)} required minimum re-saved` : ''}`, headers: ['Account', 'Bucket', 'Balance at retirement', 'Withdrawal', 'Taxable income'], rows } };
        });
      }
      case 'compare': {
        const raw = Array.isArray(args.scenarios) ? args.scenarios as { label?: unknown; overrides?: unknown }[] : [];
        if (!raw.length || raw.length > 4) throw new Error('scenarios must have 1 to 4 entries');
        const scenarios = [{ label: 'Current', overrides: {} as Overrides }, ...raw.map((x, i) => ({ label: typeof x.label === 'string' && x.label.trim() ? x.label.trim() : `Scenario ${i + 1}`, overrides: parseOverrides(x.overrides) }))];
        const sw = args.sweep as { input?: unknown; from?: unknown; to?: unknown; step?: unknown } | undefined;
        if (sw) {
          const input = String(sw.input);
          const from = num(sw.from, 'sweep.from'), to = num(sw.to, 'sweep.to'), rawStep = Math.abs(num(sw.step, 'sweep.step'));
          if (rawStep === 0) throw new Error('sweep.step must not be 0');
          const span = Math.abs(to - from);
          const step = span / 10 > rawStep ? niceStep(span / 10, rawStep) : rawStep;
          const values = sweepValues(from, to, step);
          // A cell the scenario cannot buy (an annuity bigger than pre-tax holds, shares over 100%) is null, not an error for the whole table.
          const grid = scenarios.map((sc) => values.map((v) => {
            const o = sweepOverride(input, v, sc.overrides);
            return overrideProblems(o).length ? null : metrics(evaluateWith(o));
          }));
          const rows: (string | number)[][] = values.map((v, vi) => [String(v), ...grid.map((g) => { const m = g[vi]; return m ? `${Math.round(m.successRate * 100)}%` : '—'; })]);
          const notes = [step !== rawStep ? `step widened from ${rawStep} to ${step} so the table stays short` : '', grid.flat().includes(null) ? 'null where that scenario cannot be evaluated at that value' : ''].filter(Boolean);
          return { result: JSON.stringify({ input, values, scenarios: scenarios.map((sc, si) => ({ label: sc.label, applied: describeOverrides(sc.overrides), successRate: grid[si]!.map((m) => m && Number(m.successRate.toFixed(3))), medianBalanceAtEnd: grid[si]!.map((m) => m && m.medianEnding) })), note: notes.join('; ') || undefined }),
            card: { type: 'table', title: `Success rate by ${input}`, headers: [input, ...scenarios.map((sc) => sc.label)], rows } };
        }
        const ms = scenarios.map((sc) => metrics(evaluateWith(sc.overrides)));
        const line = (label: string, f: (m: Metrics) => string | number): (string | number)[] => [label, ...ms.map(f)];
        const rows: (string | number)[][] = [
          line('Success rate', (m) => `${Math.round(m.successRate * 100)}%`),
          line('Retire at', (m) => m.retireAge),
          line('Portfolio at retirement', (m) => usd0(m.portfolioReal)),
          line('First-year withdrawal', (m) => usd0(m.firstYearGross)),
          line('First-year tax', (m) => usd0(m.firstYearTax)),
          line('Median balance at end', (m) => usd0(m.medianEnding)),
          line('Worst case left', (m) => usd0(m.worstEnding)),
          line('Lifetime tax (median path)', (m) => usd0(m.lifetimeTax)),
          line('Roth conversions (median path)', (m) => usd0(m.lifetimeRothConversions)),
        ];
        return { result: JSON.stringify(scenarios.map((sc, i) => ({ label: sc.label, applied: describeOverrides(sc.overrides), ...ms[i] , medianPath: undefined }))),
          card: { type: 'table', title: 'Side by side', headers: ['', ...scenarios.map((sc) => sc.label)], rows } };
      }
      case 'solve': {
        const find = String(args.find);
        const target = args.successRate === undefined ? 0.9 : num(args.successRate, 'successRate', 0, 1);
        const base = parseOverrides(args.overrides);
        const rate = (o: Overrides): number => evaluateWith(o).successRate;
        if (find === 'costs') {
          let lo = 0, hi = Math.max(1, settings.retire.costs * 2);
          while (rate(sweepOverride('costs', hi, base)) >= target && hi < 5e6) hi *= 2;
          if (rate(sweepOverride('costs', lo, base)) < target) throw new Error(`even $0 of spending misses ${Math.round(target * 100)}% under this scenario`);
          for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (rate(sweepOverride('costs', mid, base)) >= target) lo = mid; else hi = mid; }
          const value = Math.floor(lo / 500) * 500;
          const o = sweepOverride('costs', value, base);
          const p = evaluateWith(o);
          return { result: JSON.stringify({ find, targetSuccessRate: target, maxCostsPerYear: value, plan: summary(p) }),
            card: { type: 'scenario', label: `Spend up to ${usd0(value)}/yr at ${Math.round(target * 100)}%`, overrides: o, base: metrics(evaluate()), scenario: metrics(p) } };
        }
        if (find === 'retireAge') {
          const endAge = base.retire?.endAge ?? settings.retire.endAge;
          for (let age = settings.currentAge + 1; age < endAge; age++) {
            const o = sweepOverride('retireAge', age, base);
            // Too early can leave pre-tax too small for the annuity; that age is skipped, not fatal.
            if (overrideProblems(o).length) continue;
            if (rate(o) >= target) {
              const p = evaluateWith(o);
              return { result: JSON.stringify({ find, targetSuccessRate: target, earliestRetireAge: age, plan: summary(p) }),
                card: { type: 'scenario', label: `Retire at ${age} at ${Math.round(target * 100)}%`, overrides: o, base: metrics(evaluate()), scenario: metrics(p) } };
            }
          }
          throw new Error(`no retirement age before ${endAge} reaches ${Math.round(target * 100)}% under this scenario`);
        }
        throw new Error('find must be costs or retireAge');
      }
      case 'get_holdings':
        return { result: JSON.stringify(holdings.map((x) => ({ ticker: x.ticker, name: x.name, value: Math.round(x.value), basis: Math.round(x.costBasis), account: x.account, bucket: x.bucket }))) };
      case 'run_scenario': {
        const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : 'Scenario';
        const overrides = parseOverrides(args.overrides);
        if (!Object.keys(overrides).length) throw new Error('overrides is empty; say what changes');
        const base = evaluate();
        const scen = evaluateWith(overrides);
        return { result: JSON.stringify({ label, changes: describeOverrides(overrides), current: summary(base), scenario: summary(scen) }),
          card: { type: 'scenario', label, overrides, base: metrics(base), scenario: metrics(scen) } };
      }
      case 'sweep': {
        const input = String(args.input);
        const from = num(args.from, 'from'), to = num(args.to, 'to'), rawStep = Math.abs(num(args.step, 'step'));
        if (rawStep === 0) throw new Error('step must not be 0');
        const base = parseOverrides(args.base);
        // A card with 20 rows is unreadable; widen the step so a sweep has at most 10 points.
        const span = Math.abs(to - from);
        const step = Math.max(rawStep, span / 10 > rawStep ? niceStep(span / 10, rawStep) : rawStep);
        // Points the plan cannot buy (shares over 100%, an annuity bigger than pre-tax holds) are skipped and named in the note.
        const skipped: { value: number; problem: string }[] = [];
        const points = sweepValues(from, to, step).flatMap((v) => {
          const overrides = sweepOverride(input, v, base);
          const problem = overrideProblems(overrides)[0];
          if (problem) { skipped.push({ value: v, problem }); return []; }
          return [{ value: v, overrides, metrics: metrics(evaluateWith(overrides)) }];
        });
        if (!points.length) throw new Error(`no ${input} from ${from} to ${to} can be evaluated: ${skipped[0]?.problem ?? 'empty range'}`);
        const label = `${input} ${from} to ${to}`;
        const note = [step !== rawStep ? `step widened from ${rawStep} to ${step} so the table stays short` : '',
          skipped.length ? `skipped ${input} ${skipped.map((x) => x.value).join(', ')}: ${skipped[0]!.problem}` : ''].filter(Boolean).join('; ');
        const rows = points.map((p) => ({ [input]: p.value, successRate: Number(p.metrics.successRate.toFixed(3)), portfolioAtRetirement: p.metrics.portfolioReal, medianBalanceAtEnd: p.metrics.medianEnding, firstYearWithdrawal: p.metrics.firstYearGross }));
        return { result: JSON.stringify(note ? { note, points: rows } : rows), card: { type: 'sweep', label, input, points } };
      }
      case 'get_sequence': {
        const startYear = num(args.startYear, 'startYear', 1928, 2100);
        const overrides = parseOverrides(args.overrides);
        const p = evaluateWith(overrides);
        const run = p.sim.runs.find((x) => x.startYear === startYear);
        if (!run) throw new Error(`no full ${p.horizon}-year sequence starts in ${startYear}; available ${p.firstStartYear} to ${p.lastStartYear}`);
        const years = run.years.map((y) => ({ age: y.age, balance: Math.round(y.end), withdrawal: Math.round(spendAndTax(y)), tax: Math.round(y.tax), socialSecurity: Math.round(y.socialSecurity), rothConversion: Math.round(y.converted), requiredMinimumResaved: Math.round(y.surplus), ...(p.annuity ? { annuity: Math.round(y.annuity) } : {}) }));
        return { result: JSON.stringify({ startYear, ranOutAtAge: run.depletedAt, endingBalance: Math.round(run.ending), years }),
          card: { type: 'sequence', startYear, ages: run.years.map((y) => y.age), balances: run.years.map((y) => Math.round(y.end)), depletedAt: run.depletedAt } };
      }
      case 'show_on_chart': {
        if (args.clear !== undefined && typeof args.clear !== 'boolean') throw new Error('clear must be true (remove the ghost) or omitted');
        if (args.clear) { setGhost(null); ui.rerender(); return { result: JSON.stringify({ cleared: true }) }; }
        const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : 'Scenario';
        const overrides = parseOverrides(args.overrides);
        if (!Object.keys(overrides).length) throw new Error('overrides is empty; the current plan is already on the chart');
        // Evaluate before persisting: a ghost that cannot be simulated must never reach localStorage.
        const base = evaluate();
        const scen = evaluateWith(overrides);
        setGhost({ label, overrides });
        ui.rerender();
        return { result: JSON.stringify({ shownOnChart: label, changes: describeOverrides(overrides), current: summary(base), scenario: summary(scen) }),
          card: { type: 'scenario', label, overrides, base: metrics(base), scenario: metrics(scen) } };
      }
      case 'apply_scenario': {
        const overrides = parseOverrides(args.overrides);
        if (!Object.keys(overrides).length) throw new Error('overrides is empty');
        const problems = applyChecked(overrides);
        if (problems.length) throw new Error(`not applied, the plan is unchanged: ${problems.join(' ')}`);
        ui.rerender();
        return { result: JSON.stringify({ applied: describeOverrides(overrides), plan: summary(evaluate()) }) };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (e) {
    return { result: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) };
  }
}

export function systemPrompt(): string {
  const p = evaluate();
  return [
    'You are the assistant inside a personal retirement planner. The user is planning with real numbers from their brokerage export.',
    'Rules:',
    '- Never compute or estimate a financial figure yourself. Every number you state must come from a tool result in this conversation. If you have not called a tool for it, call one.',
    '- Never write a markdown table. Every tool result is already rendered as a card in the conversation; refer to the card ("the table above") and state the one or two figures that matter in a sentence.',
    '- For tax or "where does the withdrawal come from" questions, call get_first_year; it breaks the first year down by bucket, by account and by tax component.',
    '- retire.drawOrder in overrides picks the withdrawal strategy (fill-12, fill-22, taxable-first, pretax-first, roth-first, proportional); use compare with it for withdrawal-order and tax-strategy questions. Pre-tax means 401k/403b/IRA money taxed as income when withdrawn; Roth means post-tax money, tax free when withdrawn. The fill strategies convert pre-tax to Roth inside the bracket, which shows up as lifetime tax paid earlier and a larger Roth later. Age rules are built in: a 10% penalty on pre-tax and Roth earnings before 59.5 (Roth contributions and, when retiring at 55 or later from an employer plan, pre-tax are exempt), and required minimum distributions from 75.',
    '- retire.equity (S&P 500 %), retire.annuity (%) and retire.annuityKind set the allocation at retirement; Treasuries take the rest. The annuity is bought with pre-tax money at retirement and pays for life, so it lowers the invested balance and the withdrawals. Use compare across allocations for "should I buy an annuity" or "how much in bonds" questions.',
    '- retire.ladder plans Roth conversions in the gap years between retirement and social security (off, amount with retire.ladderAmount, fill-12, fill-22); use compare with it for "should I convert before claiming" questions. The conversion is taxed that year, so lifetime tax moves earlier and the Roth grows.',
    '- To compare two or more scenarios, or one input across several scenarios, call compare (it puts the current plan in the first column). To find the most someone can spend or the earliest they can retire at a target success rate, call solve. Do not approximate either by reading a sweep.',
    '- Social security has presets (retire.ssLevel: none, low, average, high, max) and a claiming age (retire.ssStartAge 62 to 70) that scales the benefit; a question like "what if I claim at 62" is a run_scenario with ssStartAge 62.',
    '- For any what-if, call run_scenario (or sweep for a range). The user sees a card with the numbers and an Apply button; you summarise what changed and why it matters in two or three sentences.',
    '- To put a scenario or a sweep row on the Retirement chart as a dashed line next to the current plan, call show_on_chart with its inputs (for a sweep row, the base plus that row\'s value). It does not change the plan; one ghost at a time.',
    '- Only call apply_scenario when the user clearly asks to change the plan.',
    '- Be direct and brief. Plain language, no hedging, no disclaimers about not being a financial advisor. Use markdown lists sparingly.',
    '- All retirement figures are today\'s dollars. Ages are the user\'s. Money in accumulation is nominal unless stated.',
    `Today: ${new Date().toISOString().slice(0, 10)}. Current plan snapshot (call get_state for details): age ${p.currentAge}, retire at ${p.retireAge}, plan to ${p.endAge}, variable expenses $${Math.round(p.costs / 12).toLocaleString()}/mo (costs $${p.costs.toLocaleString()}/yr)${p.fixed ? ` plus fixed expenses of $${settings.retire.fixedMonthly.toLocaleString()}/mo until ${settings.retire.fixedEndAge}` : ''}, success rate ${(p.successRate * 100).toFixed(0)}%, portfolio at retirement $${Math.round(p.portfolioReal).toLocaleString()} today's dollars.`,
    `Accounts: ${accounts.map((a) => `${a.name} (${a.bucket}, $${Math.round(a.value).toLocaleString()})`).join('; ')}.`,
  ].join('\n');
}
