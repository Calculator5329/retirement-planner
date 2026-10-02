// Derived projections shared by the tabs: per-account and per-bucket paths.

import { BUCKETS, type Account, type TaxBucket } from './holdings';
import { deflate, employerMatch, growthPath, type Buckets } from './model';
import { accountSettings, accounts, settings, yearsToRetire } from './state';

export interface AccountProjection {
  account: Account;
  contribution: number; // the employee's own dollars per year
  match: number;        // employer match per year, a separate inflow on top of contribution
  cagr: number;      // fraction
  path: number[];    // nominal account total, index 0 = today (includes the match)
  matchPath: number[]; // the match's part of path: pre-tax money whatever the account's own bucket
  ending: number;    // nominal at retirement
}

/** 401k, 403b, 457 and TSP accounts: the only ones that take an employer match or fall under the rule of 55. */
export const isEmployerPlan = (a: Account): boolean => /401|403|457|tsp/i.test(a.accountType);

// cagrOverride replaces every account's rate (used by the scenario grid).
export function projectAccounts(cagrOverride?: number, years = yearsToRetire()): AccountProjection[] {
  return accounts.map((account) => {
    const s = accountSettings(account);
    const cagr = (cagrOverride ?? s.cagr) / 100;
    const match = isEmployerPlan(account) ? employerMatch(s.contribution, s.salary, s.matchPct, s.matchUpToPct) : 0;
    const path = growthPath(account.value, s.contribution + match, cagr, years);
    const matchPath = growthPath(0, match, cagr, years);
    return { account, contribution: s.contribution, match, cagr, path, matchPath, ending: path[years] ?? account.value };
  });
}

/**
 * One account's balance in year y (default: retirement) split by tax bucket.
 * An employer match is pre-tax money, so it sits in pretax even inside a
 * Roth 401(k) or an employer plan whose treatment parsed as taxable.
 */
export function accountBuckets(p: AccountProjection, y = p.path.length - 1): Buckets {
  const b: Buckets = { pretax: 0, roth: 0, taxable: 0 };
  const m = p.matchPath[y] ?? 0;
  b[p.account.bucket] += (p.path[y] ?? 0) - m;
  b.pretax += m;
  return b;
}

export function bucketPaths(projs: AccountProjection[], years = yearsToRetire()): Record<TaxBucket, number[]> {
  const out: Record<TaxBucket, number[]> = { pretax: [], roth: [], taxable: [] };
  for (const b of BUCKETS) {
    out[b] = Array.from({ length: years + 1 }, (_, y) =>
      projs.reduce((s, p) => s + accountBuckets(p, y)[b], 0));
  }
  return out;
}

export function endingBuckets(projs: AccountProjection[]): Buckets {
  const b: Buckets = { pretax: 0, roth: 0, taxable: 0 };
  for (const p of projs) {
    const a = accountBuckets(p);
    for (const k of BUCKETS) b[k] += a[k];
  }
  return b;
}

// Cost basis of the taxable bucket at retirement: today's basis plus every
// contribution made along the way (contributions are after-tax money). The
// value excludes any employer match, which accountBuckets moves to pretax.
export function taxableGainFraction(projs: AccountProjection[], years = yearsToRetire()): number {
  let value = 0;
  let basis = 0;
  for (const p of projs) {
    if (p.account.bucket !== 'taxable') continue;
    value += accountBuckets(p).taxable;
    basis += p.account.costBasis + p.contribution * years;
  }
  return value > 0 ? Math.max(0, Math.min(1, (value - basis) / value)) : 0;
}

export const real = (nominal: number, years = yearsToRetire()): number =>
  deflate(nominal, settings.inflation / 100, years);

export const display = (nominal: number, years = yearsToRetire()): number =>
  settings.showReal ? real(nominal, years) : nominal;

/** Roth contributions available penalty-free at any age: cost basis today plus every employee contribution still to come (an employer match is not basis). Rough: reinvested dividends count as basis here. */
export function rothBasisAtRetirement(projs: AccountProjection[], years = yearsToRetire()): number {
  return projs.filter((p) => p.account.bucket === 'roth').reduce((a, p) => a + p.account.costBasis + p.contribution * years, 0);
}

/** True when every pre-tax dollar sits in an employer plan (401k, 403b, 457, TSP), where the rule of 55 applies. */
export function pretaxInEmployerPlans(projs: AccountProjection[]): boolean {
  const pre = projs.filter((p) => accountBuckets(p).pretax > 0);
  return pre.length > 0 && pre.every((p) => isEmployerPlan(p.account));
}
