import { describe, expect, it } from 'vitest';
import { runTool } from '../src/chat/tools';
import { CPI, FIRST_YEAR } from '../src/data/history';
import { drawdown, fixedPayments } from '../src/model';
import { evaluateWith } from '../src/plan';
import { simulate } from '../src/sim';
import { DEFAULTS, fromJson, inputProblems, settings, type Settings } from '../src/state';

const retiree = { startAge: 65, endAge: 75, ssStartAge: 99, ssAnnual: 0, otherIncome: 0, taxableGainFraction: 0,
  filing: 'single' as const, stateRate: 0, balances: { pretax: 0, roth: 1e6, taxable: 0 } };

describe('payments fixed in dollars', () => {
  it('shrink with each year\'s inflation and stop once paid off', () => {
    const p = fixedPayments(1000, 2, [0.1, 0.1, 0.1]);
    expect(p[0]).toBe(1000);
    expect(p[1]).toBeCloseTo(1000 / 1.1, 6);
    expect(p[2]).toBe(0);
  });

  it('are spent on top of costs, exactly like the same amount of costs', () => {
    const d = { ...retiree, returns: new Array<number>(10).fill(0.03), mix: null };
    const fixed = drawdown({ ...d, costs: 30000, fixedCosts: new Array<number>(10).fill(20000) });
    const costs = drawdown({ ...d, costs: 50000 });
    expect(fixed.map((y) => y.end)).toEqual(costs.map((y) => y.end));
    expect(fixed[0]?.fixed).toBe(20000);
  });

  it('in a historical run, shrink with that run\'s actual inflation', () => {
    const run = simulate({ ...retiree, costs: 30000, equityShare: 0.6, fixed: { annual: 24000, years: 5 } }).runs.find((r) => r.startYear === 1966);
    const cpi = (y: number): number => 1 + (CPI[y - FIRST_YEAR] ?? 0) / 100;
    expect(run?.years[2]?.fixed).toBeCloseTo(24000 / cpi(1966) / cpi(1967), 6);
    expect(run?.years[5]?.fixed).toBe(0);
  });
});

describe('fixed payments in the plan', () => {
  const withInputs = (retire: Partial<Settings['retire']>): Settings => ({ ...structuredClone(DEFAULTS), retire: { ...DEFAULTS.retire, ...retire } });

  it('a mortgage fixed in dollars is worth less by retirement, and ends at its payoff age', () => {
    const p = evaluateWith({ retire: { fixedMonthly: 4000, fixedEndAge: settings.retireAge + 5 } });
    expect(p.fixed?.annual).toBeCloseTo(48000 / (1 + settings.inflation / 100) ** (p.retireAge - p.currentAge), 6);
    expect(p.fixed?.years).toBe(5);
    expect(p.firstYearCosts).toBeCloseTo(p.costs + p.fixed!.annual, 6);
    expect(p.typical[5]?.fixed).toBe(0);
    expect(p.medianEnding).toBeLessThan(evaluateWith({}).medianEnding);
  });

  it('costs less than the same spending growing with inflation', () => {
    const fixed = evaluateWith({ retire: { fixedMonthly: 4000, fixedEndAge: 95 } });
    const grows = evaluateWith({ retire: { costs: fixed.costs + fixed.fixed!.annual } });
    expect(fixed.firstYearGross).toBeCloseTo(grows.firstYearGross, 6);
    expect(fixed.medianEnding).toBeGreaterThan(grows.medianEnding);
  });

  it('paid off before retirement changes nothing', () => {
    const p = evaluateWith({ retire: { fixedMonthly: 4000, fixedEndAge: settings.retireAge } });
    expect(p.fixed).toBeNull();
    expect(p.successRate).toBe(evaluateWith({}).successRate);
  });

  it('refuses a negative payment or a payoff age that is not an age', () => {
    expect(inputProblems(withInputs({ fixedMonthly: -1 }))).toEqual(['Fixed expenses cannot be negative.']);
    expect(inputProblems(withInputs({ fixedEndAge: 70.5 }))).toEqual(['Paid off at must be a whole number from 0 to 120.']);
  });

  it('imports an older export with no fixed payments as none', () => {
    const { fixedMonthly: _m, fixedEndAge: _e, ...old } = DEFAULTS.retire;
    expect(fromJson(JSON.stringify({ ...DEFAULTS, retire: old }))?.retire.fixedMonthly).toBe(0);
  });

  it('chat what-ifs take fixed payments, and the first year counts them in the spending target', () => {
    const o = { retire: { fixedMonthly: 4000, fixedEndAge: 80 } };
    const j = JSON.parse(runTool('get_first_year', { overrides: o }, { rerender: () => {} }).result) as { spendingTarget: number; fixedPayments: number };
    const p = evaluateWith(o);
    expect(j.fixedPayments).toBe(Math.round(p.fixed!.annual));
    expect(j.spendingTarget).toBe(Math.round(p.firstYearCosts));
  });
});
