// Pure math: growth projection, US federal tax, social security, drawdown.
// Everything here is deterministic and unit-tested in tests/model.test.ts.

import type { TaxBucket } from './holdings';

export type Filing = 'single' | 'married';

// Future value of a lump sum plus level end-of-year contributions.
export function futureValue(pv: number, annual: number, rate: number, years: number): number {
  const g = 1 + rate;
  if (years <= 0) return pv;
  if (Math.abs(rate) < 1e-9) return pv + annual * years;
  return pv * g ** years + annual * (g ** years - 1) / rate;
}

// Year-by-year balances (index 0 = today) for a single account.
export function growthPath(pv: number, annual: number, rate: number, years: number): number[] {
  const out = [pv];
  let v = pv;
  for (let y = 1; y <= years; y++) {
    v = v * (1 + rate) + annual;
    out.push(v);
  }
  return out;
}

/**
 * One year's employer match: `ratePct`% of the employee's own contribution,
 * counting only the part up to `upToPct`% of salary ("50% up to 6%").
 * It is its own inflow and never reduces or counts as the employee's line.
 */
export function employerMatch(contribution: number, salary: number, ratePct: number, upToPct: number): number {
  const pos = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0); // a blank or junk input means none
  return Math.min(pos(contribution), pos(salary) * pos(upToPct) / 100) * pos(ratePct) / 100;
}

export function deflate(nominal: number, inflation: number, years: number): number {
  return nominal / (1 + inflation) ** years;
}

// 2025 federal figures. Brackets index with inflation, so applying them to
// today's-dollar income is the right approximation for a future year.
interface Bracket { upTo: number; rate: number }
const ORDINARY: Record<Filing, Bracket[]> = {
  single: [
    { upTo: 11925, rate: 0.10 }, { upTo: 48475, rate: 0.12 }, { upTo: 103350, rate: 0.22 },
    { upTo: 197300, rate: 0.24 }, { upTo: 250525, rate: 0.32 }, { upTo: 626350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
  married: [
    { upTo: 23850, rate: 0.10 }, { upTo: 96950, rate: 0.12 }, { upTo: 206700, rate: 0.22 },
    { upTo: 394600, rate: 0.24 }, { upTo: 501050, rate: 0.32 }, { upTo: 751600, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 },
  ],
};
const LTCG: Record<Filing, Bracket[]> = {
  single: [{ upTo: 48350, rate: 0 }, { upTo: 533400, rate: 0.15 }, { upTo: Infinity, rate: 0.20 }],
  married: [{ upTo: 96700, rate: 0 }, { upTo: 600050, rate: 0.15 }, { upTo: Infinity, rate: 0.20 }],
};
export const STANDARD_DEDUCTION: Record<Filing, number> = { single: 15000, married: 30000 };

function bracketTax(brackets: Bracket[], from: number, to: number): number {
  // Tax on income in the slice (from, to] using the bracket ladder.
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const lo = Math.max(lower, from);
    const hi = Math.min(b.upTo, to);
    if (hi > lo) tax += (hi - lo) * b.rate;
    lower = b.upTo;
    if (lower >= to) break;
  }
  return tax;
}

export interface TaxInput {
  filing: Filing;
  ordinary: number;      // pre-tax withdrawals + other earned income (before deduction)
  capitalGains: number;  // long-term gains realised from taxable withdrawals
  socialSecurity: number;
  stateRate: number;     // flat rate applied to federal taxable income
}

export interface TaxResult {
  taxableSS: number;
  federal: number;
  state: number;
  total: number;
  effectiveRate: number;
}

// How much of a social security benefit is taxable (the provisional-income test).
export function taxableSocialSecurity(ss: number, otherIncome: number, filing: Filing): number {
  if (ss <= 0) return 0;
  const [t1, t2] = filing === 'single' ? [25000, 34000] : [32000, 44000];
  const provisional = otherIncome + ss / 2;
  if (provisional <= t1) return 0;
  if (provisional <= t2) return Math.min(0.5 * (provisional - t1), 0.5 * ss);
  const tier1 = filing === 'single' ? 4500 : 6000;
  return Math.min(0.85 * (provisional - t2) + Math.min(tier1, 0.5 * ss), 0.85 * ss);
}

export function computeTax(t: TaxInput): TaxResult {
  const taxableSS = taxableSocialSecurity(t.socialSecurity, t.ordinary + t.capitalGains, t.filing);
  const deduction = STANDARD_DEDUCTION[t.filing];
  // Deduction comes off ordinary income first; any remainder shelters gains.
  const ordTaxable = Math.max(0, t.ordinary + taxableSS - deduction);
  const leftover = Math.max(0, deduction - (t.ordinary + taxableSS));
  const gainsTaxable = Math.max(0, t.capitalGains - leftover);
  const ordTax = bracketTax(ORDINARY[t.filing], 0, ordTaxable);
  // Gains stack on top of ordinary income for the 0/15/20% thresholds.
  const gainsTax = bracketTax(LTCG[t.filing], ordTaxable, ordTaxable + gainsTaxable);
  const federal = ordTax + gainsTax;
  const state = (ordTaxable + gainsTaxable) * t.stateRate;
  const gross = t.ordinary + t.capitalGains + t.socialSecurity;
  return { taxableSS, federal, state, total: federal + state,
           effectiveRate: gross > 0 ? (federal + state) / gross : 0 };
}

export interface Buckets { pretax: number; roth: number; taxable: number }

export interface YearInput {
  balances: Buckets;
  taxableGainFraction: number; // share of the taxable bucket that is unrealised gain
  socialSecurity: number;      // annual, this year (0 before start age)
  otherIncome: number;         // annual, taxed as ordinary
  filing: Filing;
  stateRate: number;
  mix?: DrawMix | null;        // draw order; absent = proportional to balances
  // Age rules. With no age the year is unconstrained (pure strategy maths).
  age?: number;
  rothBasis?: number;          // Roth contributions still unwithdrawn: penalty-free at any age
  pretaxFreeAge?: number;      // pre-tax is penalty-free from here (59.5, or the retirement age under the rule of 55)
  ladder?: RothLadder | null;  // a planned Roth conversion this year (set by yearInputAt only in the gap years)
}

/**
 * A planned Roth conversion ladder for the gap years between retirement and
 * social security: a fixed amount of pre-tax moved to Roth each year, or
 * enough to fill ordinary income to the top of a bracket. The conversion is
 * taxed as income that year; the tax raises the year's withdrawal, which
 * follows the chosen draw order. Converting is never penalised, but the
 * five-year rule on withdrawing converted dollars before 59.5 is not
 * modelled: converted dollars never count as penalty-free Roth basis.
 */
export type RothLadder = { kind: 'amount'; amount: number } | { kind: 'bracket'; rate: number };
export const LADDER_MODES = {
  off: { label: 'Off', note: 'No planned conversions. A fill strategy still converts on its own.' },
  amount: { label: 'Fixed amount', note: 'Convert the same amount of pre-tax to Roth every gap year.' },
  'fill-12': { label: 'Fill 12%', note: 'Convert enough to fill ordinary income to the top of the 12% bracket every gap year.' },
  'fill-22': { label: 'Fill 22%', note: 'Convert enough to fill ordinary income to the top of the 22% bracket every gap year.' },
} as const satisfies Record<string, { label: string; note: string }>;
export type LadderMode = keyof typeof LADDER_MODES;
/** The ladder a mode and amount describe; null when off. A blank or junk amount converts nothing. */
export function rothLadder(mode: LadderMode, amount: number): RothLadder | null {
  if (mode === 'off') return null;
  if (mode === 'amount') return { kind: 'amount', amount: Number.isFinite(amount) ? Math.max(0, amount) : 0 };
  return { kind: 'bracket', rate: mode === 'fill-12' ? 0.12 : 0.22 };
}

/**
 * A single-premium immediate annuity: part of the portfolio is handed to an
 * insurer at retirement for an income that lasts for life (joint life with
 * 100% to the survivor when filing jointly). It is bought with pre-tax money,
 * an IRA rollover, so nothing is taxed at purchase, every payment is ordinary
 * income, and life-annuity payments are exempt from the early-withdrawal
 * penalty. Life only: no refund, nothing left at the end. `raise` is the
 * fixed yearly increase in the nominal payment. US insurers stopped selling
 * CPI-linked annuities around 2019, so a fixed raise is the closest option.
 */
export const ANNUITY_KINDS = {
  level: { label: 'Level', raise: 0, note: 'The same dollar amount every year. Pays the most at the start, then inflation eats it: at 3% a year it buys about half as much after 23 years.' },
  rising: { label: 'Rising 2%', raise: 0.02, note: 'Grows 2% a year in dollars and starts about a fifth lower than level. It keeps up with 2% inflation and falls behind anything higher. Insurers no longer sell annuities tied to CPI.' },
} as const satisfies Record<string, { label: string; raise: number; note: string }>;
export type AnnuityKind = keyof typeof ANNUITY_KINDS;

// First-year payout per dollar of premium, by age at purchase, life only.
// Single level: immediateannuities.com's average across insurers surveyed
// 2026-09-09, $100k, mean of the male and female quotes (excludes state
// premium tax). Age 55 (the survey starts at 58), the joint rates (100% to
// the survivor, same-age couple) and the rising rates are derived: SOA 2012
// IAM Basic mortality with Scale G2, discount rate fitted per age to those
// quotes. Checks: CANNEX's Aug 2026 index pays 6.74% for a 70/65 couple
// (table 6.83%); the 2%-raise ratio at 65 matches the insurer's own chart
// within 2%. Shopping around pays about 6% to 12% more than the average.
const PAYOUT: Record<AnnuityKind, { single: [number, number][]; joint: [number, number][] }> = {
  level: {
    single: [[55, 0.0645], [60, 0.0689], [65, 0.0751], [70, 0.0826], [75, 0.0962], [80, 0.1154]],
    joint: [[55, 0.0595], [60, 0.0624], [65, 0.0665], [70, 0.0711], [75, 0.0803], [80, 0.0922]],
  },
  rising: {
    single: [[55, 0.0498], [60, 0.0545], [65, 0.0611], [70, 0.0690], [75, 0.0829], [80, 0.1022]],
    joint: [[55, 0.0449], [60, 0.0482], [65, 0.0529], [70, 0.0581], [75, 0.0677], [80, 0.0801]],
  },
};
// The table is the 2026-09-09 survey. The 10-year Treasury rose from 4.83% that
// day to about 5.2% by 2026-09-26, and payout rates follow yields by roughly
// the annuity's duration times its rate: 0.22 to 0.32 points across this
// table for that rise. An estimate, not a quote; set to 0 when the table is
// refreshed from a new survey.
const YIELD_SHIFT = 0.0025;

export const PAYOUT_SOURCE = 'Average quotes across insurers on 2026-09-09, raised a quarter point for the rise in Treasury yields since. Life only. Shopping around pays about 6% to 12% more. Couple and rising rates are modelled from those quotes.';

/** Payout rate for buying at `age` (linear between the table's ages, flat past its ends), plus the yield shift. */
export function annuityPayoutRate(kind: AnnuityKind, age: number, joint: boolean): number {
  const rows = PAYOUT[kind][joint ? 'joint' : 'single'];
  const first = rows[0]!, last = rows[rows.length - 1]!;
  if (age <= first[0]) return first[1] + YIELD_SHIFT;
  if (age >= last[0]) return last[1] + YIELD_SHIFT;
  const i = rows.findIndex(([a]) => a >= age);
  const [a0, r0] = rows[i - 1]!, [a1, r1] = rows[i]!;
  return r0 + (r1 - r0) * (age - a0) / (a1 - a0) + YIELD_SHIFT;
}

/** Spend `share` of the portfolio on an annuity paying `rate` a year, out of pre-tax. Null when pre-tax holds less than the premium. */
export function buyAnnuity(balances: Buckets, share: number, rate: number): { balances: Buckets; premium: number; payment: number } | null {
  const premium = share * (balances.pretax + balances.roth + balances.taxable);
  if (premium > balances.pretax + 1e-6) return null;
  return { balances: { ...balances, pretax: Math.max(0, balances.pretax - premium) }, premium, payment: premium * rate };
}

/** The payment each year in today's dollars (index 0 = first year), given each year's inflation. A raise below inflation erodes it. */
export function annuityPayments(payment: number, raise: number, inflation: number[]): number[] {
  const out = [payment];
  for (let k = 1; k < inflation.length; k++) out.push(out[k - 1]! * (1 + raise) / (1 + (inflation[k - 1] ?? 0)));
  return out;
}

/** A payment fixed in dollars, like a mortgage, for `years` years, in today's dollars: each year's inflation shrinks it, and it is 0 once paid off. */
export function fixedPayments(annual: number, years: number, inflation: number[]): number[] {
  return annuityPayments(annual, 0, inflation).map((v, k) => (k < years ? v : 0));
}

export interface Withdrawal {
  gross: number;      // total pulled from the portfolio (raised when a required minimum forces more)
  fromBuckets: Buckets;
  tax: TaxResult;     // total includes the early-withdrawal penalty
  penalty: number;    // 10% on pre-tax and Roth-earnings dollars taken before 59.5
  rmd: number;        // required minimum distribution this year (0 before the RMD age)
  converted: number;  // pre-tax dollars moved to Roth, by a bracket-fill strategy or the ladder (inside `gross` and `fromBuckets.pretax`)
  ladder: number;     // the part of `converted` beyond the fill strategy's leftover bracket room (all of it without a fill strategy)
  conversionTax: number; // the part of `tax` the conversion adds (tax with it minus tax without it)
  net: number;        // spendable after tax, including SS and other income
}

/** Age rules, born 1960 or later: penalty-free at 59.5, required minimums from 75. */
export const PENALTY_AGE = 59.5;
export const RMD_AGE = 75;
export const EARLY_PENALTY = 0.1;
// IRS uniform lifetime table (2022), divisor by age.
const RMD_DIVISOR: Record<number, number> = { 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4 };
export function rmdDivisor(age: number): number {
  return age < RMD_AGE ? Infinity : RMD_DIVISOR[Math.min(100, Math.floor(age))] ?? 6.4;
}

const BUCKET_KEYS: TaxBucket[] = ['pretax', 'roth', 'taxable'];

/**
 * How a year's withdrawal is spread over the buckets: tiers are drained in
 * order, and inside a tier buckets give in proportion to their balances.
 * `fillBracket` is the bracket-fill strategy: pre-tax dollars are taken first,
 * up to the top of that ordinary bracket, and any room left over is converted
 * from pre-tax to Roth (taxed now at the low rate, tax free after). The
 * presets are the strategies worth choosing between.
 */
export interface DrawMix { tiers: TaxBucket[][]; fillBracket?: number }
const FILL_TIERS: TaxBucket[][] = [['taxable'], ['roth'], ['pretax']];
export const DRAW_ORDERS = {
  'fill-12': { label: 'Fill 12%', mix: { tiers: FILL_TIERS, fillBracket: 0.12 }, note: 'Recommended. Pre-tax pays the bills up to the top of the 12% bracket each year, taxable covers the rest, Roth last. Room left in the bracket converts pre-tax to Roth, so the money is taxed once at 12% and never again, and required minimums shrink.' },
  'fill-22': { label: 'Fill 22%', mix: { tiers: FILL_TIERS, fillBracket: 0.22 }, note: 'Same idea one bracket higher: pre-tax and conversions up to the top of 22%. Pays more tax early to shrink a large pre-tax balance before required minimums begin at 75.' },
  'taxable-first': { label: 'Taxable first', mix: { tiers: [['taxable'], ['pretax'], ['roth']] }, note: 'Taxable, then pre-tax, then Roth. The conventional order: spend the taxable account down first, keep tax-free Roth growth the longest. Leaves pre-tax to grow into large required minimums.' },
  'pretax-first': { label: 'Pre-tax first', mix: { tiers: [['pretax'], ['taxable'], ['roth']] }, note: 'Pre-tax, then taxable, then Roth. Drains the taxable-as-income bucket while spending is the only income, so required minimums never bite, at the cost of higher brackets in those years.' },
  'roth-first': { label: 'Roth first', mix: { tiers: [['roth'], ['taxable'], ['pretax']] }, note: 'Roth, then taxable, then pre-tax. Spends tax-free money first. Usually the worst order: Roth growth is the most valuable and pre-tax is left to be forced out later. Before 59.5 only Roth contributions come out penalty-free.' },
  proportional: { label: 'Proportional', mix: null, note: 'Baseline. Every bucket gives the same share of its balance each year, so the mix never changes. No strategy, useful as the comparison.' },
} as const satisfies Record<string, { label: string; mix: DrawMix | null; note: string }>;

/** Ordinary income that still fits under the top of `rate`'s bracket after the deduction, other income and taxable social security. */
export function bracketRoom(rate: number, filing: Filing, otherIncome: number, socialSecurity: number): number {
  const top = ORDINARY[filing].find((b) => b.rate >= rate)?.upTo ?? 0;
  return Math.max(0, STANDARD_DEDUCTION[filing] + top - otherIncome - 0.85 * socialSecurity);
}

/** Spread `gross` over `avail` by the mix; returns what could not be placed. */
function allocate(gross: number, avail: Buckets, mix?: DrawMix | null): { out: Buckets; left: number } {
  const out: Buckets = { pretax: 0, roth: 0, taxable: 0 };
  const tiers = mix?.tiers ?? [BUCKET_KEYS];
  let left = gross;
  for (const tier of tiers) {
    // A tier may need a few passes: a small bucket can run dry inside it.
    for (let pass = 0; pass < 3 && left > 1e-9; pass++) {
      const open = tier.filter((b) => avail[b] - out[b] > 1e-9);
      const weight = (b: TaxBucket): number => avail[b] - out[b];
      const wsum = open.reduce((a, b) => a + weight(b), 0);
      if (!open.length || wsum <= 0) break;
      const want = left;
      for (const b of open) {
        const take = Math.min(want * weight(b) / wsum, avail[b] - out[b]);
        out[b] += take; left -= take;
      }
    }
    if (left <= 1e-9) break;
  }
  return { out, left };
}

export function splitWithdrawal(gross: number, balances: Buckets, mix?: DrawMix | null): Buckets {
  const { out, left } = allocate(gross, balances, mix);
  // More asked than the portfolio holds: attribute the excess by balance so
  // the split still sums to `gross` and the caller's scaling drains it to zero.
  if (left > 1e-9) {
    const total = balances.pretax + balances.roth + balances.taxable;
    for (const b of BUCKET_KEYS) out[b] += total > 0 ? left * balances[b] / total : left / 3;
  }
  return out;
}

/**
 * Withdraw `gross` across the buckets under the age rules and tax the result.
 * Before 59.5 the order first uses what is penalty-free (taxable money, Roth
 * contributions, pre-tax under the rule of 55); only when that runs short does
 * it continue into penalised dollars, which cost 10% extra and, for Roth
 * earnings, ordinary income tax. From 75 the pre-tax bucket must give at least
 * its required minimum, which raises the gross when spending alone would not.
 */
export function withdraw(gross: number, y: YearInput): Withdrawal {
  const b = y.balances;
  const age = y.age;
  const early = age !== undefined && age < PENALTY_AGE;
  const pretaxFree = age === undefined || age >= (y.pretaxFreeAge ?? PENALTY_AGE);
  const free: Buckets = { pretax: pretaxFree ? b.pretax : 0, roth: early ? Math.min(b.roth, y.rothBasis ?? b.roth) : b.roth, taxable: b.taxable };
  // Bracket fill: cheap pre-tax dollars first, up to the room under the chosen bracket.
  const room = y.mix?.fillBracket ? bracketRoom(y.mix.fillBracket, y.filing, y.otherIncome, y.socialSecurity) : 0;
  const fill = Math.min(room, gross, free.pretax);
  const first = allocate(gross - fill, { ...free, pretax: free.pretax - fill }, y.mix);
  const out = first.out;
  out.pretax += fill;
  let left = first.left;
  let penalised = 0, rothEarnings = 0;
  if (left > 1e-9) {
    const rest: Buckets = { pretax: b.pretax - out.pretax, roth: b.roth - out.roth, taxable: b.taxable - out.taxable };
    const more = allocate(left, rest, y.mix);
    penalised = more.out.pretax + more.out.roth; rothEarnings = more.out.roth;
    for (const k of BUCKET_KEYS) out[k] += more.out[k];
    left = more.left;
  }
  if (left > 1e-9) {
    const total = b.pretax + b.roth + b.taxable;
    for (const k of BUCKET_KEYS) out[k] += total > 0 ? left * b[k] / total : left / 3;
  }
  const rmd = age !== undefined && age >= RMD_AGE ? b.pretax / rmdDivisor(age) : 0;
  if (out.pretax + 1e-9 < rmd) {
    // Pull the shortfall back out of the other buckets first so the gross holds; raise it only when it must.
    const need = rmd - out.pretax;
    const others = out.roth + out.taxable;
    const shift = Math.min(need, others);
    if (shift > 0) { out.roth -= shift * out.roth / others; out.taxable -= shift * out.taxable / others; }
    out.pretax += need; gross += need - shift;
  }
  // Room still unused converts pre-tax to Roth: taxed as income now, no penalty, not spendable. Stops once required minimums begin.
  // Bracket room is measured against what is already ordinary income: pre-tax drawn and penalised Roth earnings.
  const pretaxLeft = b.pretax - out.pretax;
  const ordinarySoFar = out.pretax + rothEarnings;
  const fillConverted = room > 0 && pretaxFree && rmd === 0 ? Math.max(0, Math.min(room - ordinarySoFar, pretaxLeft)) : 0;
  // The ladder converts at least its target on top of spending draws; a conversion is never penalised, so no age gate.
  const target = !y.ladder || rmd > 0 ? 0 : y.ladder.kind === 'amount' ? y.ladder.amount
    : bracketRoom(y.ladder.rate, y.filing, y.otherIncome, y.socialSecurity) - ordinarySoFar;
  const converted = Math.max(fillConverted, Math.min(Math.max(0, target), pretaxLeft));
  out.pretax += converted; gross += converted;
  const taxIn: TaxInput = {
    filing: y.filing,
    ordinary: out.pretax + rothEarnings + y.otherIncome,
    capitalGains: out.taxable * y.taxableGainFraction,
    socialSecurity: y.socialSecurity,
    stateRate: y.stateRate,
  };
  const tax = computeTax(taxIn);
  const conversionTax = converted > 0 ? tax.total - computeTax({ ...taxIn, ordinary: taxIn.ordinary - converted }).total : 0;
  const penalty = penalised * EARLY_PENALTY;
  tax.federal += penalty; tax.total += penalty;
  return { gross, fromBuckets: out, tax, penalty, rmd, converted, ladder: converted - fillConverted, conversionTax, net: gross - converted + y.socialSecurity + y.otherIncome - tax.total };
}

// Smallest gross withdrawal whose after-tax result covers `costs`. Every
// simulated year calls this, so it is the planner's hot loop. After-tax net is
// increasing and piecewise linear in gross (brackets, penalties, the social
// security phase-in), so a secant step inside the bracket lands on the root in
// a few calls where bisection took 60. The Illinois halving keeps a stuck end
// moving; a step that leaves the bracket falls back to bisection.
export function grossNeeded(costs: number, y: YearInput): Withdrawal {
  const zero = withdraw(0, y);
  if (zero.net >= costs) return zero;
  let lo = 0, fLo = zero.net - costs;
  let hi = Math.max(costs * 2, 1);
  let w = withdraw(hi, y);
  while (w.net < costs) { lo = hi; fLo = w.net - costs; hi *= 2; w = withdraw(hi, y); }
  let fHi = w.net - costs;
  let kept: 'lo' | 'hi' | null = null;
  for (let i = 0; i < 100 && w.net - costs > 1e-7 && hi - lo > 1e-12 * hi; i++) {
    let mid = hi - fHi * (hi - lo) / (fHi - fLo);
    if (!(mid > lo && mid < hi)) mid = (lo + hi) / 2;
    const m = withdraw(mid, y);
    const f = m.net - costs;
    if (f < 0) { lo = mid; fLo = f; if (kept === 'hi') fHi /= 2; kept = 'hi'; }
    else { hi = mid; fHi = f; w = m; if (kept === 'lo') fLo /= 2; kept = 'lo'; }
  }
  return w;
}

export interface DrawdownYear {
  age: number;
  start: number;
  gross: number;
  tax: number;
  socialSecurity: number;
  from: Buckets;         // gross withdrawn from each bucket this year
  penalty: number;       // early-withdrawal penalty inside `tax`
  surplus: number;       // required-minimum dollars not needed for spending, saved into taxable (resavedSurplus)
  converted: number;     // pre-tax dollars moved to Roth this year (bracket-fill strategies and the ladder)
  ladder: number;        // the part of `converted` beyond the fill strategy's leftover room (see Withdrawal.ladder)
  annuity: number;       // annuity income this year, today's dollars (taxed as ordinary income)
  fixed: number;         // payments fixed in dollars spent this year on top of costs, today's dollars
  shortfall: number;     // what the year needed beyond what the portfolio held; above zero means the plan ran out this year
  balances: Buckets;     // end of year, per bucket
  end: number;
}

/**
 * Required-minimum dollars a year draws beyond its needs and saves into taxable.
 * Capped at what the portfolio itself yields after the conversion and tax, so
 * social security left over after costs is spent, never saved, as in years
 * without a required minimum.
 */
export function resavedSurplus(w: Withdrawal, costs: number): number {
  if (w.rmd <= 0) return 0;
  return Math.max(0, Math.min(w.net - costs, w.gross - w.converted - w.tax.total));
}

/** What a year takes out to spend and pay tax: the gross less the Roth conversion (it stays invested) and the required-minimum surplus saved back into taxable. */
export function spendAndTax(y: { gross: number; converted: number; surplus: number }): number {
  return y.gross - y.converted - y.surplus;
}

export interface DrawdownInput {
  startAge: number;
  endAge: number;
  ssStartAge: number;
  ssAnnual: number;      // today's dollars
  otherIncome: number;   // today's dollars
  costs: number;         // today's dollars, the same every year: spending that keeps up with inflation
  fixedCosts?: number[]; // payments fixed in dollars (fixedPayments) for each retirement year, today's dollars, spent on top of costs
  returns: number[];     // real return for each retirement year (index 0 = first year)
  balances: Buckets;     // today's dollars
  taxableGainFraction: number;
  filing: Filing;
  stateRate: number;
  mix?: DrawMix | null;
  rothBasis?: number;    // Roth contributions to date plus those still to come, today's dollars
  ruleOf55?: boolean;    // pre-tax sits in employer plans, so leaving at 55+ makes it penalty-free at once
  ladder?: RothLadder | null; // conversions each year from startAge until ssStartAge
  annuity?: number[];    // annuity income for each retirement year (index 0 = first year), today's dollars; taxed like otherIncome
}

/** The year input for one retirement year, with the age rules filled in. */
export function yearInputAt(d: Omit<DrawdownInput, 'returns'>, age: number, balances: Buckets, rothBasis?: number): YearInput {
  const ss = age >= d.ssStartAge ? d.ssAnnual : 0;
  const annuity = d.annuity?.[age - d.startAge] ?? 0;
  return { balances, taxableGainFraction: d.taxableGainFraction, socialSecurity: ss, otherIncome: d.otherIncome + annuity, filing: d.filing,
    stateRate: d.stateRate, mix: d.mix, age, rothBasis: rothBasis ?? d.rothBasis,
    pretaxFreeAge: d.ruleOf55 && d.startAge >= 55 ? d.startAge : PENALTY_AGE,
    ladder: age >= d.startAge && age < d.ssStartAge ? d.ladder : null };
}

// Real-dollar drawdown: each year pull what covers costs after tax, then grow
// by that year's real return. Everything stays in today's dollars, so brackets
// never need re-indexing. Stops the first year the portfolio cannot cover what the year needs.
export function drawdown(d: DrawdownInput): DrawdownYear[] {
  const b: Buckets = { ...d.balances };
  let basis = d.rothBasis;
  const years: DrawdownYear[] = [];
  for (let age = d.startAge; age < d.endAge; age++) {
    const start = b.pretax + b.roth + b.taxable;
    const y = yearInputAt(d, age, b, basis);
    const fixed = d.fixedCosts?.[age - d.startAge] ?? 0;
    const w = grossNeeded(d.costs + fixed, y);
    const gross = Math.min(w.gross, start);
    const shortfall = w.gross - start > 1e-6 ? w.gross - start : 0;
    const scale = w.gross > 0 ? gross / w.gross : 0;
    // A required minimum can pull out more than the year needs; the portfolio's after-tax surplus is saved in the taxable account.
    const surplus = resavedSurplus(w, d.costs + fixed) * scale;
    const g = 1 + (d.returns[age - d.startAge] ?? 0);
    const converted = w.converted * scale;
    b.pretax = Math.max(0, (b.pretax - w.fromBuckets.pretax * scale) * g);
    b.roth = Math.max(0, (b.roth - w.fromBuckets.roth * scale + converted) * g);
    b.taxable = Math.max(0, (b.taxable - w.fromBuckets.taxable * scale + surplus) * g);
    if (basis !== undefined) basis = Math.max(0, basis - w.fromBuckets.roth * scale);
    years.push({ age, start, gross, tax: w.tax.total * scale, socialSecurity: y.socialSecurity,
                 from: { pretax: w.fromBuckets.pretax * scale, roth: w.fromBuckets.roth * scale, taxable: w.fromBuckets.taxable * scale },
                 penalty: w.penalty * scale, surplus, converted, ladder: w.ladder * scale, annuity: d.annuity?.[age - d.startAge] ?? 0, fixed, shortfall, balances: { ...b },
                 end: b.pretax + b.roth + b.taxable });
    // An empty portfolio is not a failure while income covers the year (an annuity bought with everything); a shortfall is.
    if (shortfall > 0) break;
  }
  return years;
}
