import { describe, expect, it } from 'vitest';
import { spendAndTax } from '../src/model';
import { evaluateWith } from '../src/plan';
import { DEFAULTS, inputProblems, settings, type Settings } from '../src/state';

describe('first-year withdrawal', () => {
  it('is spending plus tax: the Roth conversion stays invested but its tax counts', () => {
    // The shipped sample runs Fill 12%, which converts leftover bracket room in year one; retiring at 60, social security has not started.
    const p = evaluateWith({ retire: { costs: 70000 } });
    expect(p.firstYear.converted).toBeGreaterThan(0);
    expect(p.firstYearGross - p.firstYearTax).toBeCloseTo(70000, 0);
    expect(p.firstYear.conversionTax).toBeGreaterThan(0);
    expect(p.firstYear.conversionTax).toBeLessThan(p.firstYearTax);
    expect(evaluateWith({ retire: { costs: 80000 } }).firstYearGross - evaluateWith({ retire: { costs: 80000 } }).firstYearTax).toBeCloseTo(80000, 0);
    // Without a conversion there is no conversion tax.
    expect(evaluateWith({ retire: { costs: 70000, drawOrder: 'taxable-first' } }).firstYear.conversionTax).toBe(0);
  });

  it('never goes negative when social security covers the year: only the portfolio own after-tax dollars are re-saved', () => {
    for (const o of [{ retireAge: 76, retire: { costs: 20000 } }, { retireAge: 78, retire: { costs: 20000 } }]) {
      const p = evaluateWith(o);
      const w = p.firstYear;
      expect(p.firstYearGross).toBeGreaterThanOrEqual(0);
      expect(p.firstYearResaved).toBeLessThanOrEqual(w.gross - w.converted - w.tax.total + 1e-6);
      // The portfolio pays at least its own tax; social security left over after costs is spent, as in every other year.
      expect(p.firstYearGross).toBeCloseTo(w.tax.total, 0);
      expect(p.withdrawalRate).toBeGreaterThanOrEqual(0);
    }
    const rich = evaluateWith({ retire: { costs: 40000, ssLevel: 'max' } });
    expect(rich.typical.some((y) => y.surplus > 0)).toBe(true);
    // Before 75 social security can even pay a conversion's tax, so only a re-saved year is held to the portfolio's after-tax dollars.
    expect(rich.typical.every((y) => spendAndTax(y) >= -1e-6 && y.surplus <= Math.max(0, y.gross - y.converted - y.tax) + 1e-6)).toBe(true);
  });

  it('leaves out a required minimum that is saved back rather than spent', () => {
    // At 78 the required minimum draws more than $70k of costs needs once social security pays $48k.
    const p = evaluateWith({ retireAge: 78, retire: { costs: 70000 } });
    expect(p.firstYearResaved).toBeGreaterThan(0);
    expect(p.firstYearGross - p.firstYearTax).toBeCloseTo(70000 - 48000, 0);
    expect(p.firstYearGross).toBeLessThan(p.firstYear.gross);
  });
});

describe('input checks', () => {
  const withInputs = (patch: Partial<Omit<Settings, 'retire'>> & { retire?: Partial<Settings['retire']> }): Settings =>
    ({ ...structuredClone(DEFAULTS), ...patch, retire: { ...DEFAULTS.retire, ...patch.retire } });

  it('passes the shipped defaults', () => {
    expect(inputProblems(DEFAULTS)).toEqual([]);
  });

  it('flags each case the dogfood pass found instead of evaluating it', () => {
    expect(inputProblems(withInputs({ retire: { endAge: 50 } }))).toEqual(['Plan to age must be a whole number after the retirement age (60), up to 120.']);
    expect(inputProblems(withInputs({ retireAge: 120 }))).toEqual(['Retirement age must be a whole number from your current age (40) to 100.']);
    expect(inputProblems(withInputs({ retireAge: 30 }))).toEqual(['Retirement age must be a whole number from your current age (40) to 100. Already retired? Set it to 40.']);
    expect(inputProblems(withInputs({ retire: { costs: -50000 } }))).toEqual(['Variable expenses cannot be negative.']);
    expect(inputProblems(withInputs({ retire: { equity: 150 } }))).toEqual(['S&P 500 must be between 0% and 100%.']);
    expect(inputProblems(withInputs({ retireAge: 57.5 }))).toHaveLength(1);
  });

  it('flags a filing status the tax tables do not have, as an imported file can carry', () => {
    const imported: object = JSON.parse('{ "filing": "joint" }');
    expect(inputProblems({ ...structuredClone(DEFAULTS), retire: { ...DEFAULTS.retire, ...imported } })).toEqual(['Filing must be Single or Married joint, not "joint".']);
  });

  it('accepts the edges: retiring now and a one-year plan', () => {
    expect(inputProblems(withInputs({ retireAge: 40 }))).toEqual([]);
    expect(inputProblems(withInputs({ retire: { endAge: 61 } }))).toEqual([]);
  });

  it('flags a retirement longer than the market record, which would have no runs', () => {
    expect(inputProblems(withInputs({ currentAge: 20, retireAge: 20, retire: { endAge: 120 } }))[0]).toMatch(/longer than the \d+ years of market history/);
  });

  it('names the account when a per-account input is out of range', () => {
    const acct = (patch: Partial<Settings['accounts'][string]>): string[] => inputProblems(withInputs({ accounts: { 'Sample 401(k)': patch } }));
    expect(acct({ contribution: -200000 })).toEqual(['Sample 401(k): contribution cannot be negative.']);
    expect(acct({ cagr: 400 })).toEqual(['Sample 401(k): CAGR must be between -20% and 30%.']);
    expect(acct({ matchPct: 5000 })).toEqual(['Sample 401(k): employer match must be between 0% and 200% of contributions.']);
    expect(acct({ contribution: 23000, cagr: 7, matchPct: 50, matchUpToPct: 6 })).toEqual([]);
  });
});

describe('what-if evaluation', () => {
  it('leaves settings.retire the same object, so a tab that holds it still edits the live plan', () => {
    const retire = settings.retire;
    const costs = retire.costs;
    evaluateWith({ retire: { costs: costs + 5000, equity: 60 } });
    expect(settings.retire).toBe(retire);
    expect(retire.costs).toBe(costs);
  });
});
