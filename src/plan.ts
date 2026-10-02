// One evaluation of the whole plan: accumulation to retirement, then the
// historical-sequence simulation. The Retirement tab and the chat tools both
// read from here so a number in chat is the same number on screen.

import { LAST_YEAR, medianRealReturn } from './data/history';
import { ANNUITY_KINDS, DRAW_ORDERS, LADDER_MODES, annuityPayments, annuityPayoutRate, buyAnnuity, drawdown, fixedPayments, grossNeeded, resavedSurplus, rothLadder, spendAndTax, withdraw, yearInputAt, type AnnuityKind, type Buckets, type DrawdownYear, type LadderMode, type Withdrawal } from './model';
import { endingBuckets, pretaxInEmployerPlans, projectAccounts, real, rothBasisAtRetirement, taxableGainFraction } from './projection';
import { simulate, type SimResult } from './sim';
import { accounts, inputProblems, settings, setAnnuityShare, syncSocialSecurity, treasuriesShare, yearsToRetire, SS_LEVELS, type AccountSettings, type DrawOrder, type RetireSettings, type Settings } from './state';
import { usd } from './format';

export interface Overrides {
  currentAge?: number;
  retireAge?: number;
  inflation?: number;
  defaultCagr?: number;
  accounts?: Record<string, Partial<AccountSettings>>;
  retire?: Partial<RetireSettings>;
}

export interface PlanSummary {
  currentAge: number;
  retireAge: number;
  endAge: number;
  yearsToRetire: number;
  horizon: number;
  costs: number;                // spending that keeps up with inflation, today's dollars
  fixed: { annual: number; years: number } | null; // payments fixed in dollars (fixedAt): the first retirement year's in today's dollars, and how many years they last
  firstYearCosts: number;       // costs plus the first year's fixed payments
  portfolioReal: number;        // the whole portfolio at retirement, before any annuity is bought
  portfolioNominal: number;
  buckets: Buckets;             // today's dollars at retirement, before any annuity is bought
  invested: number;             // what stays invested after the annuity's premium; the simulation draws on this
  annuity: { premium: number; payment: number; rate: number; kind: AnnuityKind } | null; // payment: the first year's, today's dollars
  stockShare: number;           // S&P 500 share of the invested part, 0..1; the rest is 10-year Treasuries
  gainFraction: number;
  successRate: number;
  runs: number;
  failures: number;
  earliestDepletionAge: number | null;
  medianEnding: number;
  worst: { startYear: number; depletedAt: number | null; ending: number } | null;
  best: { startYear: number; ending: number } | null;
  firstYearGross: number;       // what year one takes out to spend and pay tax (spendAndTax): the Roth conversion and a re-saved required-minimum surplus stay invested
  firstYearTax: number;         // includes the conversion's tax (firstYear.conversionTax)
  firstYearResaved: number;     // required-minimum dollars year one draws beyond its needs and saves back into taxable
  firstYear: Withdrawal;        // the first retirement year's withdrawal; read its buckets, tax and conversions, never re-withdraw its gross (that converts twice)
  withdrawalRate: number;       // first-year withdrawal over what stays invested
  ruleOfThumbNet: number;
  firstStartYear: number;
  lastStartYear: number;
  sim: SimResult;
  typical: DrawdownYear[];      // one path at the historical median real return
  shared: Parameters<typeof simulate>[0];
}

/** Buckets at retirement in today's dollars, `years` from now. */
export function bucketsAt(years = yearsToRetire()): Buckets {
  const nominal = endingBuckets(projectAccounts(undefined, years));
  return { pretax: real(nominal.pretax, years), roth: real(nominal.roth, years), taxable: real(nominal.taxable, years) };
}

/** S&P 500 share of the invested part (what the annuity leaves), 0..1. */
export function stockShareOf(r: RetireSettings): number {
  const invested = r.equity + treasuriesShare(r);
  return invested > 0 ? r.equity / invested : 0;
}

/** The annuity the settings buy on retiring at `age` with `balances`: null when there is none, or when pre-tax cannot pay for it. */
export function annuityAt(r: RetireSettings, age: number, balances: Buckets): ({ kind: AnnuityKind; rate: number } & NonNullable<ReturnType<typeof buyAnnuity>>) | null {
  if (r.annuity <= 0) return null;
  const rate = annuityPayoutRate(r.annuityKind, age, r.filing === 'married');
  const bought = buyAnnuity(balances, r.annuity / 100, rate);
  return bought && { ...bought, kind: r.annuityKind, rate };
}

/**
 * The fixed payments (a mortgage) on retiring at `age`: the first retirement
 * year's in today's dollars, already shrunk by the assumed inflation until
 * then, and how many retirement years remain before the payoff. Null when
 * there are none or they end before `age`.
 */
export function fixedAt(age: number): { annual: number; years: number } | null {
  const r = settings.retire;
  const years = Math.min(r.fixedEndAge, r.endAge) - age;
  if (r.fixedMonthly <= 0 || years <= 0) return null;
  return { annual: real(r.fixedMonthly * 12, age - settings.currentAge), years };
}

export function evaluate(): PlanSummary {
  const r = settings.retire;
  const years = yearsToRetire();
  const projs = projectAccounts();
  const nominal = endingBuckets(projs);
  const buckets: Buckets = { pretax: real(nominal.pretax), roth: real(nominal.roth), taxable: real(nominal.taxable) };
  const total = buckets.pretax + buckets.roth + buckets.taxable;
  const gainFraction = taxableGainFraction(projs);
  const ssAnnual = r.ssMonthly * 12;
  const horizon = Math.max(1, r.endAge - settings.retireAge);
  // The annuity is bought on the first day of retirement; everything after draws on what is left.
  const annuity = annuityAt(r, settings.retireAge, buckets);
  const start = annuity?.balances ?? buckets;
  const raise = ANNUITY_KINDS[r.annuityKind].raise;
  const fixed = fixedAt(settings.retireAge);
  const assumed = new Array<number>(horizon).fill(settings.inflation / 100);
  const base = { startAge: settings.retireAge, endAge: r.endAge, ssStartAge: r.ssStartAge, ssAnnual, otherIncome: r.addlIncome,
    costs: r.costs, balances: start, taxableGainFraction: gainFraction, filing: r.filing, stateRate: r.stateRate / 100, mix: DRAW_ORDERS[r.drawOrder].mix,
    rothBasis: real(rothBasisAtRetirement(projs)), ruleOf55: pretaxInEmployerPlans(projs), ladder: rothLadder(r.ladder, r.ladderAmount),
    // Outside the historical replay a level payment and a fixed payment lose to the assumed inflation.
    annuity: annuity ? annuityPayments(annuity.payment, raise, assumed) : undefined,
    fixedCosts: fixed ? fixedPayments(fixed.annual, fixed.years, assumed) : undefined };
  const stockShare = stockShareOf(r);
  // The simulation rebuilds both payment paths from each run's own inflation.
  const { fixedCosts: _paths, ...common } = base;
  const shared = { ...common, equityShare: stockShare, annuity: annuity ? { payment: annuity.payment, raise } : null, fixed };
  const sim = simulate(shared);
  const failures = sim.runs.filter((x) => x.depletedAt !== null);
  const firstYearCosts = r.costs + (fixed?.annual ?? 0);
  const firstYear = grossNeeded(firstYearCosts, yearInputAt(base, settings.retireAge, start));
  const firstYearResaved = resavedSurplus(firstYear, firstYearCosts);
  const firstYearGross = spendAndTax({ ...firstYear, surplus: firstYearResaved });
  const invested = start.pretax + start.roth + start.taxable;
  // The flat-rule comparison is a spending rule, so it runs without the ladder (a fill strategy's own conversion still applies).
  const ruleOfThumb = withdraw(invested * r.swr / 100, { ...yearInputAt(base, settings.retireAge, start), ladder: null });
  const typical = drawdown({ ...base, returns: new Array<number>(horizon).fill(medianRealReturn(stockShare)) });
  return {
    currentAge: settings.currentAge, retireAge: settings.retireAge, endAge: r.endAge, yearsToRetire: years, horizon, costs: r.costs, fixed, firstYearCosts,
    portfolioReal: total, portfolioNominal: nominal.pretax + nominal.roth + nominal.taxable, buckets, gainFraction,
    invested, stockShare, annuity: annuity && { premium: annuity.premium, payment: annuity.payment, rate: annuity.rate, kind: annuity.kind },
    successRate: sim.successRate, runs: sim.runs.length, failures: failures.length,
    earliestDepletionAge: failures.length ? Math.min(...failures.map((x) => x.depletedAt ?? Infinity)) : null,
    medianEnding: sim.medianEnding,
    worst: sim.worst ? { startYear: sim.worst.startYear, depletedAt: sim.worst.depletedAt, ending: sim.worst.ending } : null,
    best: sim.best ? { startYear: sim.best.startYear, ending: sim.best.ending } : null,
    firstYearGross, firstYearTax: firstYear.tax.total, firstYearResaved, firstYear,
    withdrawalRate: invested > 0 ? firstYearGross / invested : 0,
    ruleOfThumbNet: ruleOfThumb.net,
    firstStartYear: sim.runs[0]?.startYear ?? 0, lastStartYear: LAST_YEAR - horizon + 1,
    sim, typical, shared,
  };
}

/**
 * Run fn against the live settings, then restore them whatever fn changed.
 * Restores in place, so a tab holding `settings.retire` from before the call
 * still edits the live plan after it. Synchronous only.
 */
function restoring<T>(fn: () => T): T {
  const snapshot = structuredClone(settings);
  try {
    return fn();
  } finally {
    restoreInto(settings as unknown as Record<string, unknown>, snapshot as unknown as Record<string, unknown>);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function restoreInto(to: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) {
    const cur = to[k];
    if (isRecord(v) && isRecord(cur)) restoreInto(cur, v);
    else to[k] = v;
  }
}

/**
 * inputProblems plus the one allocation rule that needs the projection: the
 * annuity is bought with pre-tax money, so it cannot cost more than pre-tax
 * holds at retirement. Every entry point that evaluates the plan checks this.
 */
export function planProblems(): string[] {
  const problems = inputProblems(settings);
  const r = settings.retire;
  if (problems.length || r.annuity <= 0) return problems;
  const b = bucketsAt();
  if (annuityAt(r, settings.retireAge, b)) return [];
  const total = b.pretax + b.roth + b.taxable;
  const most = total > 0 ? Math.floor(b.pretax / total * 100) : 0;
  return [`An annuity of ${r.annuity}% costs ${usd(total * r.annuity / 100)}, but pre-tax savings hold ${usd(b.pretax)} at ${settings.retireAge}. Annuities here are bought with pre-tax money (an IRA rollover), so it can be at most ${most}%.`];
}

/** What planProblems would say about the plan with these overrides applied; empty means they are safe. */
export function overrideProblems(o: Overrides): string[] {
  return restoring(() => { applyOverrides(o); return planProblems(); });
}

/** Run fn with overrides applied to the live settings, then restore them. Throws the input problems instead of evaluating an impossible plan. */
export function withOverrides<T>(o: Overrides, fn: () => T): T {
  return restoring(() => {
    applyOverrides(o);
    const problems = planProblems();
    if (problems.length) throw new Error(problems.join(' '));
    return fn();
  });
}

/** Write overrides into the live plan unless they would break it. Returns the problems; empty means applied. */
export function applyChecked(o: Overrides): string[] {
  const problems = overrideProblems(o);
  if (!problems.length) applyOverrides(o);
  return problems;
}

function applyOverrides(o: Overrides): void {
  if (o.currentAge !== undefined) settings.currentAge = o.currentAge;
  if (o.retireAge !== undefined) settings.retireAge = o.retireAge;
  if (o.inflation !== undefined) settings.inflation = o.inflation;
  if (o.defaultCagr !== undefined) settings.defaultCagr = o.defaultCagr;
  if (o.retire) {
    if (o.retire.ssMonthly !== undefined && o.retire.ssLevel === undefined) settings.retire.ssLevel = 'custom';
    Object.assign(settings.retire, o.retire);
    // A new annuity share on its own comes out of Treasuries first, as it does on the Retirement tab.
    if (o.retire.annuity !== undefined && o.retire.equity === undefined) setAnnuityShare(settings.retire, o.retire.annuity);
    syncSocialSecurity(settings.retire);
  }
  if (o.accounts) {
    for (const [name, patch] of Object.entries(o.accounts)) {
      const key = resolveAccount(name);
      if (!key) continue;
      settings.accounts[key] = { ...(settings.accounts[key] ?? {}), ...patch };
    }
  }
}

/** Case-insensitive, substring-tolerant account lookup so "roth" finds "Roth IRA". */
export function resolveAccount(name: string): string | null {
  const needle = name.trim().toLowerCase();
  const exact = accounts.find((a) => a.name.toLowerCase() === needle);
  if (exact) return exact.name;
  const partial = accounts.filter((a) => a.name.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0]!.name : null;
}

export function evaluateWith(o: Overrides): PlanSummary {
  return withOverrides(o, evaluate);
}

/** Human-readable list of what an override changes, for cards and chips. */
export function describeOverrides(o: Overrides): string[] {
  const out: string[] = [];
  if (o.currentAge !== undefined) out.push(`current age ${o.currentAge}`);
  if (o.retireAge !== undefined) out.push(`retire at ${o.retireAge}`);
  if (o.inflation !== undefined) out.push(`inflation ${o.inflation}%`);
  if (o.defaultCagr !== undefined) out.push(`default CAGR ${o.defaultCagr}%`);
  const rl: Record<keyof RetireSettings, (v: unknown) => string> = {
    drawOrder: (v) => `draw ${DRAW_ORDERS[v as DrawOrder]?.label.toLowerCase() ?? String(v)}`,
    costs: (v) => `costs $${Number(v).toLocaleString()}/yr`, fixedMonthly: (v) => `fixed payments $${Number(v).toLocaleString()}/mo`, fixedEndAge: (v) => `paid off at ${v}`, equity: (v) => `S&P 500 ${v}%`, swr: (v) => `rule ${v}%`,
    annuity: (v) => `annuity ${v}%`, annuityKind: (v) => `${ANNUITY_KINDS[v as AnnuityKind]?.label.toLowerCase() ?? String(v)} annuity`,
    addlIncome: (v) => `other income $${Number(v).toLocaleString()}/yr`, ssMonthly: (v) => `SS $${Number(v).toLocaleString()}/mo`,
    ssStartAge: (v) => `SS from ${v}`, ssLevel: (v) => `SS ${v === 'custom' ? 'custom' : SS_LEVELS[v as keyof typeof SS_LEVELS].label.toLowerCase()}`, filing: (v) => `filing ${v}`, stateRate: (v) => `state tax ${v}%`, endAge: (v) => `plan to ${v}`,
    ladder: (v) => `Roth ladder ${LADDER_MODES[v as LadderMode]?.label.toLowerCase() ?? String(v)}`, ladderAmount: (v) => `convert $${Number(v).toLocaleString()}/yr`,
  };
  for (const [k, v] of Object.entries(o.retire ?? {})) if (v !== undefined) out.push(rl[k as keyof RetireSettings](v));
  for (const [name, p] of Object.entries(o.accounts ?? {})) {
    const bits: string[] = [];
    if (p.contribution !== undefined) bits.push(`$${p.contribution.toLocaleString()}/yr`);
    if (p.cagr !== undefined) bits.push(`${p.cagr}% CAGR`);
    if (p.salary !== undefined) bits.push(`salary $${p.salary.toLocaleString()}`);
    if (p.matchPct !== undefined) bits.push(`${p.matchPct}% match`);
    if (p.matchUpToPct !== undefined) bits.push(`match up to ${p.matchUpToPct}% of salary`);
    out.push(`${resolveAccount(name) ?? name}: ${bits.join(', ')}`);
  }
  return out;
}
