// The one-question planner: given four plain inputs, the earliest age you can
// stop working. Pure, and built only on the planner's pure core (src/model.ts,
// src/sim.ts, src/data/history.ts). It never imports src/state.ts or
// src/plan.ts, which read the holdings and defaults files, so no personal
// data can reach this page. Every assumption is a named constant below.

import { futureValue } from '../src/model';
import { BOND_REAL, simulate, type SimResult } from '../src/sim';
import { FIRST_YEAR, REAL_EQUITY } from '../src/data/history';

export interface Inputs {
  age: number;             // years
  saved: number;           // dollars saved for retirement so far
  savingPerMonth: number;  // dollars a month, today's dollars, until you stop
  spendingPerMonth: number; // dollars a month after tax once you stop, today's dollars
}

export const SAMPLE: Inputs = { age: 40, saved: 150_000, savingPerMonth: 1_500, spendingPerMonth: 4_000 };

export const STOCK_SHARE = 0.6;          // the rest earns BOND_REAL
export const LAST_AGE = 95;              // money has to last to this age
export const LATEST_STOP = 75;           // the answer never goes past this
export const PASS_SHARE = 0.9;           // 9 in 10 past markets must last
export const SOCIAL_SECURITY_MONTHLY = 2_000; // one person, the 2025 average retired-worker benefit (SS_LEVELS.average in src/state.ts)
export const SOCIAL_SECURITY_AGE = 67;   // full retirement age, born 1960 or later
export { BOND_REAL };

/** Yearly return above inflation while you are still saving: the 1928-2024 compound average of the same stock and bond mix. */
export const GROWTH_WHILE_SAVING: number = Math.exp(
  REAL_EQUITY.reduce((sum, r) => sum + Math.log(1 + STOCK_SHARE * r + (1 - STOCK_SHARE) * BOND_REAL), 0) / REAL_EQUITY.length,
) - 1;

export interface Check { stopAge: number; nestEgg: number; sim: SimResult; lasted: number; tested: number; passes: boolean }

/** Savings at `stopAge` in today's dollars, then every historical start year replayed from there to LAST_AGE. */
export function checkStopAge(i: Inputs, stopAge: number): Check {
  const nestEgg = futureValue(i.saved, i.savingPerMonth * 12, GROWTH_WHILE_SAVING, stopAge - i.age);
  const sim = simulate({
    startAge: stopAge, endAge: LAST_AGE,
    ssStartAge: Math.max(SOCIAL_SECURITY_AGE, stopAge), ssAnnual: SOCIAL_SECURITY_MONTHLY * 12,
    otherIncome: 0, costs: i.spendingPerMonth * 12,
    // All savings sit in a workplace plan (a 401(k) or similar): every dollar out is taxed as income,
    // with the 10% early penalty before 59.5 unless you stop at 55 or later (the rule of 55).
    balances: { pretax: nestEgg, roth: 0, taxable: 0 }, taxableGainFraction: 0, rothBasis: 0, ruleOf55: true,
    filing: 'single', stateRate: 0, mix: null,
    equityShare: STOCK_SHARE, bondReal: BOND_REAL,
  });
  const lasted = sim.runs.filter((r) => r.depletedAt === null).length;
  return { stopAge, nestEgg, sim, lasted, tested: sim.runs.length, passes: sim.runs.length > 0 && lasted / sim.runs.length >= PASS_SHARE };
}

export interface Answer {
  stopAge: number | null; // null: not even at LATEST_STOP
  now: boolean;           // you could stop at your current age
  check: Check;           // the plan at the answer (or at LATEST_STOP when there is none)
}

/**
 * Earliest whole age from today to LATEST_STOP at which the money lasts in at
 * least PASS_SHARE of past markets. Working longer only adds savings and
 * shortens retirement, so the test is treated as monotone: a binary search,
 * then a walk down in case a single age breaks the pattern.
 */
export function earliestStop(i: Inputs): Answer {
  const from = Math.min(Math.round(i.age), LATEST_STOP);
  const last = checkStopAge(i, LATEST_STOP);
  if (!last.passes) return { stopAge: null, now: false, check: last };
  let lo = from, hi = LATEST_STOP, best = last;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const c = checkStopAge(i, mid);
    if (c.passes) { hi = mid; best = c; } else lo = mid + 1;
  }
  if (best.stopAge !== lo) best = checkStopAge(i, lo);
  while (best.stopAge > from) {
    const below = checkStopAge(i, best.stopAge - 1);
    if (!below.passes) break;
    best = below;
  }
  return { stopAge: best.stopAge, now: best.stopAge === from, check: best };
}

export const FIRST_START_YEAR = FIRST_YEAR;
