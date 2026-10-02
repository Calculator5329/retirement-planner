// Historical-sequence retirement simulation: the plan is run once from every
// start year in the S&P 500 record that has enough years left to cover the
// whole retirement, the way ficalc.app does it.

import { CPI, FIRST_YEAR, REAL_EQUITY, REAL_TREASURY } from './data/history';
import { annuityPayments, drawdown, fixedPayments, type DrawdownInput, type DrawdownYear } from './model';

// A flat real return for the part not in stocks, for callers that want one (the simple page).
export const BOND_REAL = 0.01;

export interface SimInput extends Omit<DrawdownInput, 'returns' | 'annuity' | 'fixedCosts'> {
  equityShare: number;   // 0..1 of the invested portfolio in the S&P 500, rebalanced every year
  bondReal?: number;     // flat real return on the rest; absent, the rest earns that year's real 10-year Treasury return
  annuity?: { payment: number; raise: number } | null; // an annuity already bought: `balances` are what its premium left
  fixed?: { annual: number; years: number } | null;    // payments fixed in dollars: the first year's in today's dollars, for `years` years
}

export interface SimRun { startYear: number; years: DrawdownYear[]; depletedAt: number | null; ending: number }

export interface SimResult {
  runs: SimRun[];
  successRate: number;
  // Percentile bands of the balance at each retirement age, index 0 = start age.
  bands: { age: number; p10: number; p25: number; p50: number; p75: number; p90: number }[];
  medianEnding: number;
  worst: SimRun | null;
  best: SimRun | null;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i] ?? 0;
}

// Pure and deterministic, so results are memoised on their inputs: the
// Retirement tab asks for the same 26 simulations on every render.
const memo = new Map<string, SimResult>();
export function simulate(s: SimInput): SimResult {
  const key = JSON.stringify(s);
  const hit = memo.get(key);
  if (hit) return hit;
  const out = simulateRaw(s);
  if (memo.size > 400) memo.delete(memo.keys().next().value as string);
  memo.set(key, out);
  return out;
}

function simulateRaw(s: SimInput): SimResult {
  const horizon = Math.max(1, s.endAge - s.startAge);
  const runs: SimRun[] = [];
  for (let i = 0; i + horizon <= REAL_EQUITY.length; i++) {
    const returns = REAL_EQUITY.slice(i, i + horizon).map((r, k) => s.equityShare * r + (1 - s.equityShare) * (s.bondReal ?? REAL_TREASURY[i + k] ?? 0));
    // A level annuity payment and a fixed mortgage payment both lose to the inflation of that run's own years.
    const inflation = CPI.slice(i, i + horizon).map((c) => c / 100);
    const annuity = s.annuity ? annuityPayments(s.annuity.payment, s.annuity.raise, inflation) : undefined;
    const fixedCosts = s.fixed ? fixedPayments(s.fixed.annual, s.fixed.years, inflation) : undefined;
    const years = drawdown({ ...s, returns, annuity, fixedCosts });
    const depleted = years.find((y) => y.shortfall > 0);
    runs.push({ startYear: FIRST_YEAR + i, years,
      depletedAt: depleted ? depleted.age + 1 : null, ending: years[years.length - 1]?.end ?? 0 });
  }
  const bands = [];
  for (let k = 0; k <= horizon; k++) {
    const vals = runs.map((r) => (k === 0 ? r.years[0]?.start ?? 0 : r.years[k - 1]?.end ?? 0)).sort((a, b) => a - b);
    bands.push({ age: s.startAge + k, p10: pct(vals, 0.1), p25: pct(vals, 0.25), p50: pct(vals, 0.5), p75: pct(vals, 0.75), p90: pct(vals, 0.9) });
  }
  const endings = runs.map((r) => r.ending).sort((a, b) => a - b);
  const byOutcome = [...runs].sort((a, b) => (a.depletedAt ?? Infinity) - (b.depletedAt ?? Infinity) || a.ending - b.ending);
  return {
    runs,
    successRate: runs.length ? runs.filter((r) => r.depletedAt === null).length / runs.length : 0,
    bands,
    medianEnding: pct(endings, 0.5),
    worst: byOutcome[0] ?? null,
    best: byOutcome[byOutcome.length - 1] ?? null,
  };
}
