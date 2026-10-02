import { describe, expect, it } from 'vitest';
import { CPI, FIRST_YEAR, REAL_EQUITY, REAL_TREASURY, TREASURY_10Y } from '../src/data/history';
import { annuityPayments, annuityPayoutRate, buyAnnuity, drawdown } from '../src/model';
import { evaluateWith, overrideProblems } from '../src/plan';
import { simulate } from '../src/sim';
import { DEFAULTS, fromJson, inputProblems, setAnnuityShare, type Settings } from '../src/state';

const retiree = { startAge: 65, endAge: 67, ssStartAge: 99, ssAnnual: 0, otherIncome: 0, taxableGainFraction: 0,
  filing: 'single' as const, stateRate: 0, balances: { pretax: 0, roth: 1e6, taxable: 0 } };

describe('treasuries', () => {
  it('line up year for year with the S&P 500 record', () => {
    expect(TREASURY_10Y).toHaveLength(REAL_EQUITY.length);
    expect(REAL_TREASURY).toHaveLength(REAL_EQUITY.length);
    // Damodaran's table: 2022 is the worst 10-year Treasury year in the record, 1982 the best.
    expect(TREASURY_10Y.indexOf(Math.min(...TREASURY_10Y))).toBe(2022 - FIRST_YEAR);
    expect(TREASURY_10Y.indexOf(Math.max(...TREASURY_10Y))).toBe(1982 - FIRST_YEAR);
  });

  it('a portfolio with no stocks earns that year\'s real Treasury return, not a flat 1%', () => {
    const run = simulate({ ...retiree, costs: 0, equityShare: 0 }).runs.find((r) => r.startYear === 1974);
    // 1974: the bond paid about 2% while prices rose 12.3%.
    expect(REAL_TREASURY[1974 - FIRST_YEAR]).toBeLessThan(-0.08);
    expect(run?.years[0]?.end).toBeCloseTo(1e6 * (1 + REAL_TREASURY[1974 - FIRST_YEAR]!), 0);
  });

  it('keeps a flat bond return when the caller passes one, as the simple page does', () => {
    const run = simulate({ ...retiree, costs: 0, equityShare: 0, bondReal: 0.01 }).runs[0];
    expect(run?.years[0]?.end).toBeCloseTo(1.01e6, 0);
  });
});

describe('annuity', () => {
  it('level payments lose real value to each year\'s inflation; a fixed raise only offsets it', () => {
    const level = annuityPayments(1000, 0, [0.1, 0.1, 0]);
    expect(level[0]).toBe(1000);
    expect(level[1]).toBeCloseTo(1000 / 1.1, 6);
    expect(level[2]).toBeCloseTo(1000 / 1.21, 6);
    expect(annuityPayments(1000, 0.02, [0.05, 0.05, 0])[2]).toBeCloseTo(1000 * (1.02 / 1.05) ** 2, 6);
    // A fixed raise equal to inflation holds its real value too.
    expect(annuityPayments(1000, 0.03, [0.03, 0.03, 0.03])[2]).toBeCloseTo(1000, 6);
  });

  it('is bought with pre-tax money only, and not at all when pre-tax holds less than the premium', () => {
    const b = { pretax: 300000, roth: 500000, taxable: 200000 };
    const bought = buyAnnuity(b, 0.2, 0.07);
    expect(bought?.premium).toBe(200000);
    expect(bought?.payment).toBeCloseTo(14000, 6);
    expect(bought?.balances).toEqual({ pretax: 100000, roth: 500000, taxable: 200000 });
    expect(buyAnnuity(b, 0.4, 0.07)).toBeNull();
  });

  it('pays more the older you buy, and less for a couple or with a yearly raise', () => {
    expect(annuityPayoutRate('level', 70, false)).toBeGreaterThan(annuityPayoutRate('level', 60, false));
    expect(annuityPayoutRate('level', 65, true)).toBeLessThan(annuityPayoutRate('level', 65, false));
    expect(annuityPayoutRate('rising', 65, false)).toBeLessThan(annuityPayoutRate('level', 65, false));
  });

  it('is taxed and spent exactly like the same amount of other ordinary income', () => {
    const d = { ...retiree, endAge: 75, costs: 60000, returns: new Array<number>(10).fill(0.03),
      balances: { pretax: 600000, roth: 200000, taxable: 200000 }, mix: null };
    const annuity = drawdown({ ...d, annuity: new Array<number>(10).fill(20000) });
    const income = drawdown({ ...d, otherIncome: 20000 });
    expect(annuity.map((y) => y.end)).toEqual(income.map((y) => y.end));
    expect(annuity.map((y) => y.tax)).toEqual(income.map((y) => y.tax));
    expect(annuity[0]?.annuity).toBe(20000);
    expect(drawdown(d)[0]!.gross).toBeGreaterThan(annuity[0]!.gross);
  });

  it('with nothing left invested, the plan succeeds when the annuity covers costs and fails when it does not', () => {
    const none = { ...retiree, balances: { pretax: 0, roth: 0, taxable: 0 }, equityShare: 0.6, annuity: { payment: 40000, raise: 0 } };
    expect(simulate({ ...none, costs: 20000 }).successRate).toBe(1);
    expect(simulate({ ...none, costs: 60000 }).successRate).toBe(0);
  });

  it('in a historical run, a level annuity shrinks with that run\'s actual inflation', () => {
    const sim = simulate({ ...retiree, endAge: 75, costs: 40000, equityShare: 0.6, annuity: { payment: 20000, raise: 0 } });
    const run = sim.runs.find((r) => r.startYear === 1966);
    const cpi = (y: number): number => 1 + (CPI[y - FIRST_YEAR] ?? 0) / 100;
    expect(run?.years[0]?.annuity).toBe(20000);
    expect(run?.years[2]?.annuity).toBeCloseTo(20000 / cpi(1966) / cpi(1967), 6);
  });
});

describe('allocation in the plan', () => {
  const withInputs = (retire: Partial<Settings['retire']>): Settings => ({ ...structuredClone(DEFAULTS), retire: { ...DEFAULTS.retire, ...retire } });

  it('buys the annuity at retirement out of pre-tax and simulates what is left', () => {
    const p = evaluateWith({ retire: { equity: 60, annuity: 10 } });
    expect(p.annuity?.premium).toBeCloseTo(p.portfolioReal * 0.1, 6);
    expect(p.annuity?.payment).toBeCloseTo(p.annuity!.premium * annuityPayoutRate('level', 60, true), 6);
    expect(p.shared.balances.pretax).toBeCloseTo(p.buckets.pretax - p.annuity!.premium, 6);
    // 60 of the 90 invested points are S&P 500.
    expect(p.shared.equityShare).toBeCloseTo(60 / 90, 9);
    expect(evaluateWith({}).annuity).toBeNull();
  });

  it('refuses an annuity bigger than pre-tax holds at retirement, naming the most it can be', () => {
    expect(overrideProblems({ retire: { equity: 5, annuity: 95 } })).toEqual([expect.stringMatching(/pre-tax.*at most \d+%/)]);
  });

  it('flags an S&P 500 share and annuity that add up to more than 100%', () => {
    expect(inputProblems(withInputs({ equity: 90, annuity: 20 }))).toEqual(['S&P 500 (90%) and annuity (20%) add up to more than 100%.']);
    expect(inputProblems(withInputs({ equity: 70, annuity: 30 }))).toEqual([]);
  });

  it('takes a new annuity out of Treasuries first, then the S&P 500', () => {
    const r = { ...DEFAULTS.retire, equity: 70, annuity: 0 };
    setAnnuityShare(r, 20);
    expect([r.equity, r.annuity]).toEqual([70, 20]);
    setAnnuityShare(r, 50);
    expect([r.equity, r.annuity]).toEqual([50, 50]);
  });

  it('measures each keystroke from the S&P 500 share the edit started with, so a typo gives it back', () => {
    const r = { ...DEFAULTS.retire, equity: 90, annuity: 0 };
    setAnnuityShare(r, 100, 90);
    expect(r.equity).toBe(0);
    setAnnuityShare(r, 10, 90);
    expect([r.equity, r.annuity]).toEqual([90, 10]);
  });

  it('flags a Treasuries share that leaves the S&P 500 below zero, in the words of the field that caused it', () => {
    expect(inputProblems(withInputs({ equity: -15, annuity: 20 }))).toEqual(['Treasuries (95%) and annuity (20%) add up to more than 100%.']);
  });

  it('imports an older export with no annuity as none', () => {
    const { annuity: _a, annuityKind: _k, ...old } = DEFAULTS.retire;
    const s = fromJson(JSON.stringify({ ...DEFAULTS, retire: old }));
    expect(s?.retire.annuity).toBe(0);
    expect(s?.retire.annuityKind).toBe('level');
  });
});
