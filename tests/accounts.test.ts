import { afterEach, describe, expect, it } from 'vitest';
import { isEmployerPlan, projectAccounts } from '../src/projection';
import { DEFAULTS, accounts, addAccount, applySetup, dropBundled, fromJson, holdings, importSettings, inputProblems, isSample, removeAccount, renameAccount, settings, updateAccount } from '../src/state';

afterEach(() => { importSettings(JSON.stringify(DEFAULTS)); });

describe('typed-in accounts', () => {
  it('join the file accounts with the bucket and account type of their kind', () => {
    const before = accounts.length;
    const e = addAccount('roth401k');
    updateAccount(e.id, { balance: 10000 });
    const a = accounts.find((x) => x.entered === e.id);
    expect(accounts).toHaveLength(before + 1);
    expect(a).toMatchObject({ name: 'Roth 401(k)', bucket: 'roth', value: 10000, costBasis: 10000, gain: 0, holdings: [] });
    expect(isEmployerPlan(a!)).toBe(true);
    updateAccount(e.id, { basis: 4000 });
    expect(accounts.find((x) => x.entered === e.id)?.gain).toBe(6000);
  });

  it('get a name no other account uses, and keep their settings through a rename', () => {
    expect(addAccount('rothIra').name).toBe('Roth IRA 2'); // the sample already has a Roth IRA
    const savings = addAccount('savings');
    expect(settings.accounts.Savings).toEqual({ cagr: 4 });
    renameAccount(savings.id, 'Roth IRA');
    expect(savings.name).toBe('Roth IRA 3');
    expect(settings.accounts['Roth IRA 3']).toEqual({ cagr: 4 });
    expect(settings.accounts.Savings).toBeUndefined();
    renameAccount(savings.id, '  ');
    expect(savings.name).toBe('Roth IRA 3');
    removeAccount(savings.id);
    expect(settings.accounts['Roth IRA 3']).toBeUndefined();
    expect(accounts.some((a) => a.name === 'Roth IRA 3')).toBe(false);
  });

  it('block the plan with a negative balance', () => {
    const e = addAccount('ira');
    updateAccount(e.id, { balance: -1 });
    expect(inputProblems(settings)).toContain('Traditional IRA: balance cannot be negative.');
  });

  it('round-trip through a settings file, which drops malformed or repeated ones', () => {
    const s = fromJson(JSON.stringify({ currentAge: 40, bundledHoldings: false, entered: [
      { id: 'e1', name: 'A', kind: 'ira', balance: 5 },
      { id: 'e2', name: 'A', kind: 'ira', balance: 1 },
      { id: 'e3', name: 'B', kind: 'pension', balance: 1 },
      { id: 'e4', name: 'C', kind: 'constructor', balance: 1 },
      { id: 'e5', name: 'D', kind: 'ira', balance: '5' },
      { id: 'e6', name: 'E', kind: 'brokerage', balance: 9, basis: 4 },
    ] }));
    expect(s?.entered).toEqual([{ id: 'e1', name: 'A', kind: 'ira', balance: 5 }, { id: 'e6', name: 'E', kind: 'brokerage', balance: 9, basis: 4 }]);
    expect(s?.bundledHoldings).toBe(false);
    expect(fromJson('{"currentAge": 40}')).toMatchObject({ entered: [], bundledHoldings: true });
  });

  it('stay when the sample is cleared, and the sample accounts take their settings with them', () => {
    const e = addAccount('ira');
    expect(Object.keys(settings.accounts)).toContain('Sample 401(k)');
    dropBundled();
    expect(holdings).toHaveLength(0);
    expect(accounts.map((a) => a.entered)).toEqual([e.id]);
    expect(Object.keys(settings.accounts)).not.toContain('Sample 401(k)');
    expect(isSample()).toBe(false);
  });
});

describe('the setup sheet', () => {
  it('replaces the sample with one typed account per bucket that holds or gets money', () => {
    expect(isSample()).toBe(true);
    applySetup({ currentAge: 30, retireAge: 60, filing: 'single',
      saved: { pretax: 200000, roth: 0, taxable: 50000 }, adding: { pretax: 20000, roth: 7000, taxable: 0 },
      spendingMonthly: 5000, fixedMonthly: 1500, fixedEndAge: 55, ssLevel: 'average' });
    expect(isSample()).toBe(false);
    expect(holdings).toHaveLength(0);
    expect(accounts.map((a) => [a.name, a.bucket, a.value])).toEqual([['401(k)', 'pretax', 200000], ['Roth IRA', 'roth', 0], ['Brokerage', 'taxable', 50000]]);
    expect(projectAccounts().map((p) => p.contribution)).toEqual([20000, 7000, 0]);
    expect(settings).toMatchObject({ currentAge: 30, retireAge: 60, retire: { filing: 'single', costs: 60000, fixedMonthly: 1500, fixedEndAge: 55, ssLevel: 'average', ssMonthly: 2000 } });
    expect(inputProblems(settings)).toEqual([]);
  });
});
