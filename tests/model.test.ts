import { describe, expect, it } from 'vitest';
import { computeTax, drawdown, DRAW_ORDERS, futureValue, grossNeeded, taxableSocialSecurity, withdraw } from '../src/model';
import { parseHoldings, rollupAccounts } from '../src/holdings';
import { simulate } from '../src/sim';
import { REAL_EQUITY } from '../src/data/history';

describe('futureValue', () => {
  it('compounds a lump sum and level contributions', () => {
    expect(futureValue(1000, 0, 0.09, 10)).toBeCloseTo(2367.36, 1);
    expect(futureValue(0, 1000, 0.09, 10)).toBeCloseTo(15192.93, 1);
    expect(futureValue(1000, 100, 0, 5)).toBe(1500);
  });
});

describe('federal tax', () => {
  it('applies the standard deduction then the ladder', () => {
    // $60k ordinary, single: taxable 45,000 -> 1,192.50 + 12% of 33,075 = 5,161.50
    const t = computeTax({ filing: 'single', ordinary: 60000, capitalGains: 0, socialSecurity: 0, stateRate: 0 });
    expect(t.federal).toBeCloseTo(5161.5, 1);
  });
  it('taxes gains at 0% while under the LTCG threshold', () => {
    const t = computeTax({ filing: 'single', ordinary: 20000, capitalGains: 30000, socialSecurity: 0, stateRate: 0 });
    // ordinary taxable 5,000 -> $500; gains 5,000..35,000 all inside the 0% band
    expect(t.federal).toBeCloseTo(500, 1);
  });
  it('stacks gains on top of ordinary income for the 15% band', () => {
    const t = computeTax({ filing: 'single', ordinary: 63350, capitalGains: 10000, socialSecurity: 0, stateRate: 0 });
    // ordinary taxable 48,350 (top of 0% band), so every gain dollar is at 15%
    const ordinaryOnly = computeTax({ filing: 'single', ordinary: 63350, capitalGains: 0, socialSecurity: 0, stateRate: 0 });
    expect(t.federal - ordinaryOnly.federal).toBeCloseTo(1500, 1);
  });
});

describe('social security', () => {
  it('is untaxed below the first threshold and capped at 85%', () => {
    expect(taxableSocialSecurity(20000, 10000, 'single')).toBe(0);
    expect(taxableSocialSecurity(30000, 200000, 'single')).toBeCloseTo(25500, 1);
  });
  it('phases in at 50% between thresholds', () => {
    // provisional = 20,000 + 15,000 = 35,000 -> 50% of 9,000 tier 1 + 85% of 1,000 tier 2
    expect(taxableSocialSecurity(30000, 20000, 'single')).toBeCloseTo(0.85 * 1000 + 4500, 1);
  });
});

describe('withdrawals', () => {
  const y = { balances: { pretax: 500000, roth: 250000, taxable: 250000 }, taxableGainFraction: 0.5,
              socialSecurity: 0, otherIncome: 0, filing: 'single' as const, stateRate: 0 };
  it('splits proportionally and only taxes the taxable parts', () => {
    const w = withdraw(40000, y);
    expect(w.fromBuckets).toEqual({ pretax: 20000, roth: 10000, taxable: 10000 });
    // ordinary 20,000 -> taxable 5,000 -> $500; gains 5,000 in the 0% band
    expect(w.tax.federal).toBeCloseTo(500, 1);
    expect(w.net).toBeCloseTo(39500, 1);
  });
  it('grossNeeded lands exactly on the target net', () => {
    const w = grossNeeded(60000, y);
    expect(w.net).toBeCloseTo(60000, 0);
    expect(w.gross).toBeGreaterThan(60000);
  });
  it('grossNeeded finds the same smallest withdrawal as a 60-step bisection, under every strategy and age rule', () => {
    // The planner's old solver, kept here as the reference.
    const bisect = (costs: number, yi: Parameters<typeof withdraw>[1]): number => {
      if (withdraw(0, yi).net >= costs) return withdraw(0, yi).gross;
      let lo = 0, hi = Math.max(costs * 2, 1);
      while (withdraw(hi, yi).net < costs) hi *= 2;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (withdraw(mid, yi).net < costs) lo = mid; else hi = mid; }
      return withdraw(hi, yi).gross;
    };
    const ladder = { kind: 'bracket' as const, rate: 0.22 };
    for (const mix of Object.values(DRAW_ORDERS).map((d) => d.mix)) {
      for (const [age, socialSecurity, rothBasis] of [[50, 0, 20000], [60, 0, undefined], [70, 40000, undefined], [80, 40000, undefined]] as const) {
        for (const costs of [15000, 60000, 180000, 2e6]) {
          for (const extra of [{}, { ladder, otherIncome: 25000 }]) {
            const yi = { ...y, filing: 'married' as const, stateRate: 0.05, mix, age, socialSecurity, rothBasis, ...extra };
            expect(grossNeeded(costs, yi).gross).toBeCloseTo(bisect(costs, yi), 4);
          }
        }
      }
    }
  });
});

describe('drawdown', () => {
  it('runs out when costs exceed what the balance can support', () => {
    const years = drawdown({ startAge: 60, endAge: 95, ssStartAge: 67, ssAnnual: 0, otherIncome: 0, costs: 100000,
      returns: new Array(35).fill(0), balances: { pretax: 0, roth: 300000, taxable: 0 }, taxableGainFraction: 0, filing: 'single', stateRate: 0 });
    expect(years[2]?.end).toBe(0);
  });
  it('never touches principal when SS covers costs', () => {
    const years = drawdown({ startAge: 70, endAge: 72, ssStartAge: 67, ssAnnual: 30000, otherIncome: 0, costs: 25000,
      returns: [0, 0], balances: { pretax: 100000, roth: 0, taxable: 0 }, taxableGainFraction: 0, filing: 'single', stateRate: 0 });
    expect(years[0]?.gross).toBe(0);
    expect(years[1]?.end).toBe(100000);
  });
});

describe('holdings parser', () => {
  const csv = `ticker,name,shares,current_value,cost_basis,unrealized_gain,account,broker,,
,,,,,,,,,
VOO,VANGUARD S&P 500 ETF,40,20000,15000,5000,Roth IRA,Example Brokerage,Roth,Post-Tax
SPAXX,HELD IN MONEY MARKET,,500,,,Roth IRA,Example Brokerage,Roth,Post-Tax
VTI,VANGUARD TOTAL STOCK MARKET ETF,400,100000,60000,40000,Sample 401(k),Example Brokerage,401K,Pre-Tax
`;
  it('skips blank rows, maps tax treatment to buckets, and rolls up accounts', () => {
    const rows = parseHoldings(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.bucket).toBe('roth');
    expect(rows[2]?.bucket).toBe('pretax');
    const accts = rollupAccounts(rows);
    expect(accts.map((a) => a.name)).toEqual(['Sample 401(k)', 'Roth IRA']);
    expect(accts[1]?.value).toBeCloseTo(20500, 2);
    expect(accts[1]?.costBasis).toBeCloseTo(15000 + 500, 2); // cash counts at face value
  });
});

describe('historical simulation', () => {
  const base = { startAge: 65, endAge: 95, ssStartAge: 99, ssAnnual: 0, otherIncome: 0, taxableGainFraction: 0,
                 filing: 'single' as const, stateRate: 0, equityShare: 1, bondReal: 0.01 };
  it('has 97 years of data and one run per full 30-year window', () => {
    expect(REAL_EQUITY).toHaveLength(97);
    const r = simulate({ ...base, costs: 40000, balances: { pretax: 0, roth: 1000000, taxable: 0 } });
    expect(r.runs).toHaveLength(97 - 30 + 1);
    expect(r.runs[0]?.startYear).toBe(1928);
  });
  it('4% of a Roth-only million survives most but not all windows; 10% survives few', () => {
    const four = simulate({ ...base, costs: 40000, balances: { pretax: 0, roth: 1000000, taxable: 0 } });
    const ten = simulate({ ...base, costs: 100000, balances: { pretax: 0, roth: 1000000, taxable: 0 } });
    expect(four.successRate).toBeGreaterThan(0.85);
    expect(four.successRate).toBeLessThan(1);
    expect(ten.successRate).toBeLessThan(0.2);
    expect(four.bands[0]?.p50).toBe(1000000);
  });
});

describe('settings export and import', () => {
  it('round-trips through JSON and rejects junk', async () => {
    const { fromJson, DEFAULTS } = await import('../src/state');
    const s = fromJson(JSON.stringify({ ...DEFAULTS, retire: { ...DEFAULTS.retire, costs: 91000 }, accounts: { 'Roth IRA': { contribution: 7000, cagr: 8 } } }));
    expect(s?.retire.costs).toBe(91000);
    expect(s?.retire.ssMonthly).toBe(DEFAULTS.retire.ssMonthly);
    expect(s?.accounts['Roth IRA']).toEqual({ contribution: 7000, cagr: 8 });
    expect(DEFAULTS.retireAge).toBe(60); // from src/data/defaults.json
    expect(DEFAULTS.accounts['Roth IRA']?.contribution).toBe(7000);
    expect(fromJson('{"hello":1}')).toBeNull();
    expect(fromJson('not json')).toBeNull();
  });
  it('imports a junk ladder as off with no amount', async () => {
    const { fromJson, DEFAULTS } = await import('../src/state');
    const s = fromJson(JSON.stringify({ ...DEFAULTS, retire: { ...DEFAULTS.retire, ladder: 'weekly', ladderAmount: -5 } }));
    expect(s?.retire.ladder).toBe('off');
    expect(s?.retire.ladderAmount).toBe(0);
    expect(fromJson(JSON.stringify({ ...DEFAULTS, retire: { ...DEFAULTS.retire, ladder: 'amount', ladderAmount: '40000' } }))?.retire.ladderAmount).toBe(0);
  });
});

describe('draw order', async () => {
  const { splitWithdrawal, DRAW_ORDERS } = await import('../src/model');
  const balances = { pretax: 600, roth: 300, taxable: 100 };
  it('proportional splits by balance', () => {
    expect(splitWithdrawal(100, balances, null)).toEqual({ pretax: 60, roth: 30, taxable: 10 });
  });
  it('roth first drains Roth before the taxable buckets', () => {
    expect(splitWithdrawal(350, balances, DRAW_ORDERS['roth-first'].mix)).toEqual({ pretax: 0, roth: 300, taxable: 50 });
  });
});

describe('bracket fill', async () => {
  const { withdraw, drawdown, bracketRoom, DRAW_ORDERS, STANDARD_DEDUCTION } = await import('../src/model');
  const base = { balances: { pretax: 500000, roth: 100000, taxable: 200000 }, taxableGainFraction: 0.5, socialSecurity: 0, otherIncome: 0, filing: 'married' as const, stateRate: 0, age: 65 };
  it('room is the deduction plus the bracket top, less other income and most of social security', () => {
    expect(bracketRoom(0.12, 'married', 0, 0)).toBe(STANDARD_DEDUCTION.married + 96950);
    expect(bracketRoom(0.22, 'single', 10000, 20000)).toBe(15000 + 103350 - 10000 - 17000);
    expect(bracketRoom(0.12, 'single', 500000, 0)).toBe(0);
  });
  it('spending comes from pre-tax up to the room, then taxable; the rest of the room converts to Roth', () => {
    const w = withdraw(60000, { ...base, mix: DRAW_ORDERS['fill-12'].mix });
    expect(w.fromBuckets.pretax).toBeCloseTo(126950);
    expect(w.converted).toBeCloseTo(66950);
    expect(w.fromBuckets.taxable).toBe(0);
    expect(w.gross).toBeCloseTo(126950);
    // The conversion is not spendable: net is the 60k less the tax on the whole 126,950 of income.
    expect(w.net).toBeCloseTo(60000 - w.tax.total);
    const big = withdraw(150000, { ...base, mix: DRAW_ORDERS['fill-12'].mix });
    expect(big.fromBuckets.pretax).toBeCloseTo(126950);
    expect(big.fromBuckets.taxable).toBeCloseTo(150000 - 126950);
    expect(big.converted).toBe(0);
  });
  it('no conversion before the money is penalty-free or once required minimums begin', () => {
    expect(withdraw(60000, { ...base, age: 50, mix: DRAW_ORDERS['fill-12'].mix }).converted).toBe(0);
    expect(withdraw(60000, { ...base, age: 80, mix: DRAW_ORDERS['fill-12'].mix }).converted).toBe(0);
    expect(withdraw(60000, { ...base, mix: DRAW_ORDERS['taxable-first'].mix }).converted).toBe(0);
  });
  it('over a drawdown the conversions move pre-tax into Roth', () => {
    const d = { startAge: 65, endAge: 75, ssStartAge: 99, ssAnnual: 0, otherIncome: 0, costs: 60000, returns: new Array<number>(10).fill(0),
      balances: base.balances, taxableGainFraction: 0.5, filing: 'married' as const, stateRate: 0 };
    const fill = drawdown({ ...d, mix: DRAW_ORDERS['fill-12'].mix });
    const plain = drawdown({ ...d, mix: DRAW_ORDERS['taxable-first'].mix });
    expect(fill[0]!.converted).toBeGreaterThan(0);
    expect(fill[9]!.balances.roth).toBeGreaterThan(plain[9]!.balances.roth);
    expect(fill[9]!.balances.pretax).toBeLessThan(plain[9]!.balances.pretax);
    expect(plain.every((y) => y.converted === 0)).toBe(true);
  });
});

describe('social security presets', async () => {
  const { ssMonthlyFor, fromJson } = await import('../src/state');
  it('scale with the claiming age and filing status', () => {
    expect(ssMonthlyFor('low', 67, 'married')).toBe(2400);
    expect(ssMonthlyFor('low', 67, 'single')).toBe(1200);
    expect(ssMonthlyFor('low', 62, 'married')).toBe(1680);
    expect(ssMonthlyFor('average', 70, 'married')).toBe(4960);
    expect(ssMonthlyFor('none', 65, 'married')).toBe(0);
  });
  it('an older export with only an amount stays custom', () => {
    const s = fromJson(JSON.stringify({ currentAge: 40, retire: { ssMonthly: 3100 } }))!;
    expect(s.retire.ssLevel).toBe('custom');
    expect(s.retire.ssMonthly).toBe(3100);
    const t = fromJson(JSON.stringify({ currentAge: 40, retire: { ssLevel: 'high', ssStartAge: 65, filing: 'single' } }))!;
    expect(t.retire.ssMonthly).toBe(2600);
  });
});

describe('age rules', () => {
  const base = { balances: { pretax: 400000, roth: 200000, taxable: 100000 }, taxableGainFraction: 0, socialSecurity: 0, otherIncome: 0, filing: 'single' as const, stateRate: 0 };
  it('before 59.5 the order uses penalty-free money first and penalises the rest', () => {
    // Pre-tax first at 50: taxable and Roth contributions are the only penalty-free money.
    const w = withdraw(150000, { ...base, age: 50, rothBasis: 30000, mix: DRAW_ORDERS['pretax-first'].mix });
    expect(w.fromBuckets.taxable).toBeCloseTo(100000, 0);
    expect(w.fromBuckets.roth).toBeCloseTo(30000, 0);
    expect(w.fromBuckets.pretax).toBeCloseTo(20000, 0);
    expect(w.penalty).toBeCloseTo(2000, 0);
    // The same draw at 60 goes straight to pre-tax with no penalty.
    const later = withdraw(150000, { ...base, age: 60, rothBasis: 30000, mix: DRAW_ORDERS['pretax-first'].mix });
    expect(later.fromBuckets.pretax).toBeCloseTo(150000, 0);
    expect(later.penalty).toBe(0);
  });
  it('Roth earnings taken early are taxed as income plus the penalty', () => {
    const w = withdraw(50000, { ...base, age: 50, rothBasis: 20000, mix: DRAW_ORDERS['roth-first'].mix, balances: { pretax: 0, roth: 200000, taxable: 0 } });
    expect(w.fromBuckets.roth).toBeCloseTo(50000, 0);
    expect(w.penalty).toBeCloseTo(3000, 0);
    expect(w.tax.federal).toBeGreaterThan(3000);
  });
  it('the rule of 55 makes pre-tax penalty-free from the retirement age', () => {
    const d = { startAge: 56, endAge: 58, ssStartAge: 67, ssAnnual: 0, otherIncome: 0, costs: 50000, returns: [0, 0], balances: { pretax: 500000, roth: 0, taxable: 0 }, taxableGainFraction: 0, filing: 'single' as const, stateRate: 0 };
    expect(drawdown({ ...d, ruleOf55: true })[0]?.penalty).toBe(0);
    expect(drawdown({ ...d, ruleOf55: false })[0]?.penalty).toBeGreaterThan(4000);
  });
  it('from 75 the required minimum is taken and the surplus is saved', () => {
    const w = withdraw(0, { ...base, age: 80, balances: { pretax: 404000, roth: 0, taxable: 0 } });
    expect(w.rmd).toBeCloseTo(20000, 0);
    expect(w.fromBuckets.pretax).toBeCloseTo(20000, 0);
    const years = drawdown({ startAge: 80, endAge: 81, ssStartAge: 67, ssAnnual: 30000, otherIncome: 0, costs: 25000, returns: [0], balances: { pretax: 404000, roth: 0, taxable: 0 }, taxableGainFraction: 0, filing: 'single', stateRate: 0 });
    expect(years[0]?.gross).toBeCloseTo(20000, 0);
    expect(years[0]?.end).toBeGreaterThan(384000);   // the after-tax surplus landed in the taxable bucket
  });
  it('Roth basis is used up across years', () => {
    const d = { startAge: 50, endAge: 53, ssStartAge: 67, ssAnnual: 0, otherIncome: 0, costs: 20000, returns: [0, 0, 0], balances: { pretax: 500000, roth: 100000, taxable: 0 }, taxableGainFraction: 0, filing: 'single' as const, stateRate: 0, rothBasis: 30000, mix: DRAW_ORDERS['roth-first'].mix };
    const years = drawdown(d);
    expect(years[0]?.penalty).toBe(0);
    expect(years[1]?.penalty).toBeGreaterThan(0);
  });
});

describe('employer match', () => {
  it('adds its own inflow to the employer plan, capped at a share of salary', async () => {
    const { settings, accounts } = await import('../src/state');
    const { projectAccounts } = await import('../src/projection');
    const saved = structuredClone(settings.accounts);
    const plan = accounts.find((a) => a.name === 'Sample 401(k)');
    const ira = accounts.find((a) => a.name === 'Roth IRA');
    if (!plan || !ira) throw new Error('sample accounts missing');
    const ending = (name: string) => projectAccounts(0, 1).find((p) => p.account.name === name);
    try {
      // 50% up to 6% of $100k: the first $6,000 of the $20,000 contribution is matched.
      settings.accounts = { [plan.name]: { contribution: 20000, salary: 100000, matchPct: 50, matchUpToPct: 6 } };
      const matched = ending(plan.name);
      expect(matched?.contribution).toBe(20000);
      expect(matched?.match).toBe(3000);
      expect(matched?.ending).toBe(plan.value + 20000 + 3000);
      // Contributing more past the cap adds nothing to the match.
      settings.accounts = { [plan.name]: { contribution: 30000, salary: 100000, matchPct: 50, matchUpToPct: 6 } };
      expect(ending(plan.name)?.match).toBe(3000);
      // Below the cap the match follows the contribution.
      settings.accounts = { [plan.name]: { contribution: 4000, salary: 100000, matchPct: 50, matchUpToPct: 6 } };
      expect(ending(plan.name)?.ending).toBe(plan.value + 4000 + 2000);
      // An IRA is not an employer plan and never receives one.
      settings.accounts = { [ira.name]: { contribution: 7000, salary: 100000, matchPct: 50, matchUpToPct: 6 } };
      expect(ending(ira.name)?.ending).toBe(ira.value + 7000);
    } finally {
      settings.accounts = saved;
    }
  });
  it('is pre-tax money even inside a Roth 401(k)', async () => {
    const { settings, loadCsv } = await import('../src/state');
    const { projectAccounts, endingBuckets, bucketPaths } = await import('../src/projection');
    const saved = structuredClone(settings.accounts);
    try {
      loadCsv('ticker,name,shares,current_value,cost_basis,unrealized_gain,account,broker,,\nVTI,VANGUARD TOTAL STOCK MARKET ETF,100,50000,40000,10000,Roth 401(k),Example Brokerage,401K,Post-Tax\n');
      settings.accounts = { 'Roth 401(k)': { contribution: 20000, cagr: 5, salary: 100000, matchPct: 50, matchUpToPct: 6 } };
      const projs = projectAccounts(undefined, 10);
      const b = endingBuckets(projs);
      expect(b.pretax).toBeCloseTo(futureValue(0, 3000, 0.05, 10), 6);
      expect(b.roth).toBeCloseTo(futureValue(50000, 20000, 0.05, 10), 6);
      expect(b.taxable).toBe(0);
      expect(bucketPaths(projs, 10).pretax[10]).toBeCloseTo(b.pretax, 6);
    } finally {
      settings.accounts = saved;
      loadCsv(null);
    }
  });
  it('treats a blank or junk input as no match', async () => {
    const { employerMatch } = await import('../src/model');
    expect(employerMatch(20000, NaN, 50, 6)).toBe(0);
    expect(employerMatch(NaN, 100000, 50, 6)).toBe(0);
  });
});

describe('roth conversion ladder', () => {
  // Retire at 60, social security from 63: the gap years are 60, 61 and 62.
  // Spending comes from taxable with no gains, so the conversion is the only taxable income.
  const base = { startAge: 60, endAge: 66, ssStartAge: 63, ssAnnual: 20000, otherIncome: 0, costs: 30000, returns: [0, 0, 0, 0, 0, 0],
    balances: { pretax: 500000, roth: 0, taxable: 500000 }, taxableGainFraction: 0, filing: 'single' as const, stateRate: 0,
    mix: DRAW_ORDERS['taxable-first'].mix };

  it('moves the annual amount pre-tax to Roth in the gap years only and taxes it that year', () => {
    const years = drawdown({ ...base, ladder: { kind: 'amount', amount: 40000 } });
    const taxOn40k = computeTax({ filing: 'single', ordinary: 40000, capitalGains: 0, socialSecurity: 0, stateRate: 0 }).total;
    expect(years.map((y) => y.converted)).toEqual([40000, 40000, 40000, 0, 0, 0]);
    expect(years.slice(0, 3).map((y) => y.ladder)).toEqual([40000, 40000, 40000]);
    expect(years[2]!.balances.pretax).toBeCloseTo(500000 - 3 * 40000);
    expect(years[2]!.balances.roth).toBeCloseTo(3 * 40000);
    // The conversion's income tax lands in the year it happens, paid by extra withdrawal from taxable.
    expect(years[0]!.tax).toBeCloseTo(taxOn40k, 2);
    expect(years[0]!.balances.taxable).toBeCloseTo(500000 - 30000 - taxOn40k, 2);
    const plain = drawdown(base);
    expect(plain.every((y) => y.converted === 0)).toBe(true);
    expect(plain[0]!.tax).toBe(0);
  });

  it('fills to the top of a bracket and converts before 59.5 without a penalty', () => {
    const [first] = drawdown({ ...base, startAge: 55, ladder: { kind: 'bracket', rate: 0.12 } });
    // Single: 15,000 deduction + 48,475 top of 12% = 63,475 of room, nothing else taxed as income.
    expect(first!.converted).toBeCloseTo(63475);
    expect(first!.penalty).toBe(0);
  });

  it('counts penalised Roth earnings as income before filling the bracket', () => {
    // Retired at 55 with no Roth basis: spending comes out of Roth earnings, taxed as ordinary income.
    const y = { balances: { pretax: 1e6, roth: 1e6, taxable: 0 }, taxableGainFraction: 0, socialSecurity: 0, otherIncome: 0,
      filing: 'single' as const, stateRate: 0, mix: DRAW_ORDERS['roth-first'].mix, age: 55, rothBasis: 0, ladder: { kind: 'bracket' as const, rate: 0.12 } };
    const room = 15000 + 48475;
    const some = grossNeeded(30000, y);
    expect(some.fromBuckets.roth).toBeGreaterThan(0);
    expect(some.fromBuckets.roth + some.converted).toBeCloseTo(room);
    // Earnings alone already pass the top of 12%: nothing is converted.
    const lots = grossNeeded(60000, y);
    expect(lots.fromBuckets.roth).toBeGreaterThan(room);
    expect(lots.converted).toBe(0);
  });
});
