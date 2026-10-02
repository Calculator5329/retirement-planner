import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete } from '../src/chat/client';
import { parseOverrides, runTool, sweepLabel, TOOLS } from '../src/chat/tools';
import { evaluate, evaluateWith, withOverrides } from '../src/plan';
import { settings } from '../src/state';
import { evaluateGhost, ghost, isGhost, setGhost, type Card, type WireMessage } from '../src/chat/store';

describe('overrides', () => {
  it('validates and resolves partial account names', () => {
    const o = parseOverrides({ retireAge: 58, retire: { costs: 70000 }, accounts: { roth: { contribution: 7000 } } });
    expect(o.retireAge).toBe(58);
    expect(o.accounts?.['Roth IRA']).toEqual({ contribution: 7000 });
    expect(parseOverrides({ accounts: { '401': { salary: 100000, matchPct: 50, matchUpToPct: 6 } } }).accounts?.['Sample 401(k)']).toEqual({ salary: 100000, matchPct: 50, matchUpToPct: 6 });
    expect(() => parseOverrides({ retire: { spending: 1 } })).toThrow(/unknown retire keys/);
    expect(() => parseOverrides({ accounts: { nothing: {} } })).toThrow(/no account matches/);
    expect(() => parseOverrides({ retireAge: 'soon' })).toThrow(/must be a number/);
    expect(parseOverrides({ retire: { drawOrder: 'taxable-first' } }).retire?.drawOrder).toBe('taxable-first');
    expect(() => parseOverrides({ retire: { drawOrder: 'roth-only' } })).toThrow(/drawOrder/);
    expect(parseOverrides({ retire: { annuity: 20, annuityKind: 'rising' } }).retire).toEqual({ annuity: 20, annuityKind: 'rising' });
    expect(() => parseOverrides({ retire: { annuityKind: 'cpi' } })).toThrow(/annuityKind must be one of level, rising/);
  });

  it('withOverrides restores the live settings', () => {
    const before = JSON.stringify(settings);
    const inner = withOverrides({ retireAge: 55, retire: { costs: 50000 } }, () => settings.retireAge);
    expect(inner).toBe(55);
    expect(JSON.stringify(settings)).toBe(before);
  });
});

describe('tools', () => {
  const ui = { rerender: () => {} };
  it('run_scenario returns both sides and a card; errors come back as {error}', () => {
    const out = runTool('run_scenario', { label: 'Retire at 58', overrides: { retireAge: 58 } }, ui);
    const j = JSON.parse(out.result) as { current: { retireAge: number }; scenario: { retireAge: number; successRate: number } };
    expect(j.current.retireAge).toBe(settings.retireAge);
    expect(j.scenario.retireAge).toBe(58);
    expect(out.card?.type).toBe('scenario');
    const bad = runTool('run_scenario', { label: 'x', overrides: { retire: { nope: 1 } } }, ui);
    expect(JSON.parse(bad.result)).toHaveProperty('error');
  });
  it('sweep steps through the range', () => {
    const out = runTool('sweep', { input: 'retireAge', from: 55, to: 65, step: 5 }, ui);
    const rows = JSON.parse(out.result) as { retireAge: number; successRate: number }[];
    expect(rows.map((r) => r.retireAge)).toEqual([55, 60, 65]);
    expect(rows.every((r) => r.successRate >= 0 && r.successRate <= 1)).toBe(true);
  });
  it('sweep widens a fine step so the table stays short, and says so', () => {
    const out = runTool('sweep', { input: 'costs', from: 70000, to: 90000, step: 1000 }, ui);
    const j = JSON.parse(out.result) as { note: string; points: { costs: number }[] };
    expect(j.note).toMatch(/widened from 1000 to 2000/);
    expect(j.points.map((p) => p.costs)).toEqual([70000, 72000, 74000, 76000, 78000, 80000, 82000, 84000, 86000, 88000, 90000]);
    expect(out.card?.type).toBe('sweep');
  });
  it('sweep skips points the plan cannot buy, says why, and keeps the rest', () => {
    // With a 20% annuity, S&P 500 at 100% would make the shares add up to 120%.
    const out = runTool('sweep', { input: 'equity', from: 0, to: 100, step: 25, base: { retire: { annuity: 20 } } }, ui);
    const j = JSON.parse(out.result) as { note: string; points: { equity: number }[] };
    expect(j.points.map((p) => p.equity)).toEqual([0, 25, 50, 75]);
    expect(j.note).toMatch(/skipped equity 100: S&P 500 \(100%\) and annuity \(20%\) add up to more than 100%/);
  });
  it('get_first_year counts the annuity as ordinary income', () => {
    const o = { retire: { annuity: 10 } };
    const j = JSON.parse(runTool('get_first_year', { overrides: o }, ui).result) as { annuity: number; tax: { ordinaryIncome: number } };
    const p = evaluateWith(o);
    expect(j.annuity).toBe(Math.round(p.annuity!.payment));
    expect(j.tax.ordinaryIncome).toBe(Math.round(p.firstYear.fromBuckets.pretax + p.shared.otherIncome + p.annuity!.payment));
  });
  it('get_sequence rejects years without a full horizon', () => {
    const bad = runTool('get_sequence', { startYear: 2020 }, ui);
    expect(JSON.parse(bad.result)).toHaveProperty('error');
    const ok = runTool('get_sequence', { startYear: 1966 }, ui);
    expect(ok.card?.type).toBe('sequence');
  });
  it('get_first_year splits the withdrawal by bucket and account and the tax by component', () => {
    const out = runTool('get_first_year', {}, ui);
    const j = JSON.parse(out.result) as { gross: number; net: number; byBucket: Record<string, number>; byAccount: { withdrawal: number }[]; tax: { federal: number; state: number; total: number } };
    const p = evaluate();
    expect(j.gross).toBe(Math.round(p.firstYearGross));
    expect(j.tax.total).toBe(Math.round(p.firstYearTax));
    expect(j.byBucket.pretax! + j.byBucket.roth! + j.byBucket.taxable!).toBeCloseTo(j.gross, -1);
    expect(j.byAccount.reduce((a, b) => a + b.withdrawal, 0)).toBeCloseTo(j.gross, -1);
    expect(out.card?.type).toBe('table');
    const what = runTool('get_first_year', { overrides: { retire: { costs: 50000 } } }, ui);
    expect((JSON.parse(what.result) as { spendingTarget: number }).spendingTarget).toBe(50000);
  });
  it('get_first_year reports the conversion once: tax, buckets and conversion match the drawdown year', () => {
    type First = { gross: number; byBucket: Record<string, number>; rothConversion: number; rothLadderConversion: number; tax: { total: number } };
    // A fixed ladder under Taxable first: the strategy converts nothing, so all of it is the ladder's.
    const o = { retire: { drawOrder: 'taxable-first', ladder: 'amount', ladderAmount: 50000 } } as const;
    const j = JSON.parse(runTool('get_first_year', { overrides: o }, ui).result) as First;
    const year = withOverrides(parseOverrides(o), evaluate).typical[0]!;
    expect(j.rothLadderConversion).toBe(50000);
    expect(j.rothConversion).toBe(50000);
    // Gross is what the year spends; the conversion is reported on its own.
    expect(j.gross).toBe(Math.round(year.gross - year.converted));
    expect(j.tax.total).toBe(Math.round(year.tax));
    expect(j.byBucket.pretax! + j.byBucket.roth! + j.byBucket.taxable!).toBeCloseTo(j.gross, -1);
    // The default Fill 12% converts leftover room in year one; re-withdrawing the gross used to report 0.
    const fill = JSON.parse(runTool('get_first_year', {}, ui).result) as First;
    const fillYear = evaluate().typical[0]!;
    expect(fillYear.converted).toBeGreaterThan(0);
    expect(fill.rothConversion).toBe(Math.round(fillYear.converted));
    expect(fill.tax.total).toBe(Math.round(fillYear.tax));
  });
  it('get_first_year taxable income includes the conversion, matching the tax computation', () => {
    type First = { otherIncome: number; tax: { ordinaryIncome: number; capitalGainsRealised: number } };
    const out = runTool('get_first_year', { overrides: { retire: { costs: 70000 } } }, ui);
    const j = JSON.parse(out.result) as First;
    const card = out.card as Extract<Card, { type: 'table' }>;
    const dollars = (s: string | number): number => Number(String(s).replace(/[$,]/g, ''));
    const total = card.rows.at(-1)!;
    expect(total[0]).toBe('Total');
    expect(dollars(total[4]!)).toBeCloseTo(j.tax.ordinaryIncome - j.otherIncome + j.tax.capitalGainsRealised, -1);
    const accounts = card.rows.slice(0, -1).reduce((a, r) => a + dollars(r[4]!), 0);
    expect(accounts).toBeCloseTo(dollars(total[4]!), -1);
  });
  it('get_sequence withdrawal is spend plus tax, with the conversion on its own line', () => {
    type Year = { withdrawal: number; tax: number; socialSecurity: number; rothConversion: number };
    const j = JSON.parse(runTool('get_sequence', { startYear: 1966 }, ui).result) as { years: Year[] };
    const y = j.years[0]!;
    expect(y.rothConversion).toBeGreaterThan(0);
    // Year one at 60 is fully funded with no required minimum: withdrawal = costs - social security - other income + tax.
    expect(y.withdrawal).toBeCloseTo(settings.retire.costs - y.socialSecurity - settings.retire.addlIncome + y.tax, -1);
    const first = JSON.parse(runTool('get_first_year', {}, ui).result) as { gross: number };
    expect(y.withdrawal).toBeCloseTo(first.gross, -1);
    // With social security above costs, required-minimum years still never report a negative withdrawal.
    const rich = { retire: { costs: 40000, ssLevel: 'max' } };
    for (const startYear of [1966, 1980]) {
      const seq = JSON.parse(runTool('get_sequence', { startYear, overrides: rich }, ui).result) as { years: (Year & { requiredMinimumResaved: number })[] };
      // 1980 reaches 75 with pre-tax left, so its required minimums are re-saved (about $25k of a $31k draw at 75).
      if (startYear === 1980) expect(seq.years.some((x) => x.requiredMinimumResaved > 0)).toBe(true);
      expect(seq.years.every((x) => x.withdrawal >= 0 && (x.requiredMinimumResaved === 0 || x.withdrawal + 1 >= x.tax))).toBe(true);
    }
    const plan = JSON.parse(runTool('run_scenario', { label: 'rich', overrides: rich }, ui).result) as { scenario: { overMedianReturnPath: { totalWithdrawn: number } } };
    expect(plan.scenario.overMedianReturnPath.totalWithdrawn).toBeGreaterThanOrEqual(0);
  });
  it('what-ifs with impossible inputs come back as errors naming the problem', () => {
    expect(JSON.parse(runTool('run_scenario', { label: 'x', overrides: { retireAge: 90, retire: { endAge: 60 } } }, ui).result).error).toMatch(/Plan to age/);
    expect(JSON.parse(runTool('sweep', { input: 'retireAge', from: 96, to: 100, step: 1, base: { retire: { endAge: 95 } } }, ui).result).error).toMatch(/Plan to age/);
    expect(JSON.parse(runTool('run_scenario', { label: 'x', overrides: { accounts: { '401': { contribution: -200000 } } } }, ui).result).error).toMatch(/Sample 401\(k\)/);
  });
  it('apply_scenario refuses inputs that break the plan and leaves it unchanged', () => {
    const before = JSON.stringify(settings);
    let rerendered = false;
    const out = runTool('apply_scenario', { overrides: { retire: { endAge: 55 } } }, { rerender: () => { rerendered = true; } });
    expect(JSON.parse(out.result).error).toMatch(/Plan to age/);
    expect(JSON.stringify(settings)).toBe(before);
    expect(rerendered).toBe(false);
  });
  it('compare puts the current plan first and sweeps every scenario', () => {
    const out = runTool('compare', { scenarios: [{ label: 'Retire at 58', overrides: { retireAge: 58 } }], sweep: { input: 'costs', from: 60000, to: 80000, step: 10000 } }, ui);
    const j = JSON.parse(out.result) as { values: number[]; scenarios: { label: string; successRate: number[] }[] };
    expect(j.values).toEqual([60000, 70000, 80000]);
    expect(j.scenarios.map((x) => x.label)).toEqual(['Current', 'Retire at 58']);
    expect(j.scenarios[1]!.successRate).toHaveLength(3);
    expect(out.card?.type).toBe('table');
    const flat = runTool('compare', { scenarios: [{ label: 'A', overrides: { retire: { costs: 50000 } } }] }, ui);
    expect((JSON.parse(flat.result) as { lifetimeTax: number }[])[1]!.lifetimeTax).toBeGreaterThanOrEqual(0);
  });
  it('solve finds the spending ceiling and the earliest age for a target', () => {
    const c = JSON.parse(runTool('solve', { find: 'costs', successRate: 0.9 }, ui).result) as { maxCostsPerYear: number; plan: { successRate: number } };
    expect(c.plan.successRate).toBeGreaterThanOrEqual(0.9);
    expect(withOverrides({ retire: { costs: c.maxCostsPerYear + 5000 } }, () => evaluate().successRate)).toBeLessThan(0.9);
    const a = JSON.parse(runTool('solve', { find: 'retireAge', successRate: 0.9 }, ui).result) as { earliestRetireAge: number };
    expect(a.earliestRetireAge).toBeGreaterThan(settings.currentAge);
    expect(withOverrides({ retireAge: a.earliestRetireAge - 1 }, () => evaluate().successRate)).toBeLessThan(0.9);
  });
  it('ssLevel and ssStartAge overrides derive the benefit', () => {
    expect(withOverrides({ retire: { ssLevel: 'average', ssStartAge: 62 } }, () => settings.retire.ssMonthly)).toBe(2800);
    expect(withOverrides({ retire: { ssMonthly: 5000 } }, () => settings.retire.ssLevel)).toBe('custom');
  });
  it('show_on_chart never persists a ghost that cannot be drawn, and a stale one is skipped, not lost', () => {
    setGhost(null);
    // Fractional ages crash the simulation (Invalid array length), so inputProblems rejects them before anything evaluates.
    expect(JSON.parse(runTool('run_scenario', { label: 'x', overrides: { retireAge: 57.5 } }, ui).result).error).toMatch(/whole number/);
    expect(JSON.parse(runTool('run_scenario', { label: 'x', overrides: { retire: { endAge: 90.5 } } }, ui).result).error).toMatch(/whole number/);
    expect(JSON.parse(runTool('show_on_chart', { label: 'x', overrides: { retireAge: 57.5 } }, ui).result)).toHaveProperty('error');
    expect(ghost).toBeNull();
    // A ghost saved before that check (localStorage) must not blank the Retirement tab: it is skipped, with the reason.
    setGhost({ label: 'stale', overrides: { retireAge: 57.5 } });
    expect(evaluateGhost(evaluateWith)).toMatchObject({ problem: expect.stringMatching(/whole number/) });
    // A live edit that clashes with the ghost hides it only until the edit is undone.
    setGhost({ label: 'short', overrides: { retire: { endAge: 70 } } });
    const age = settings.retireAge;
    settings.retireAge = 72;
    expect(evaluateGhost(evaluateWith)).toHaveProperty('problem');
    settings.retireAge = age;
    expect(evaluateGhost(evaluateWith)).toHaveProperty('plan');
    expect(ghost?.label).toBe('short');
    setGhost({ label: 'ok', overrides: { retireAge: 58 } });
    expect(evaluateGhost(evaluateWith)).toMatchObject({ plan: { retireAge: 58 } });
    setGhost(null);
  });
  it('show_on_chart rejects empty inputs and a non-boolean clear', () => {
    setGhost(null);
    for (const overrides of [{}, { retire: {} }, { accounts: {} }, { accounts: { roth: {} } }]) {
      expect(JSON.parse(runTool('show_on_chart', { label: 'x', overrides }, ui).result).error).toMatch(/empty/);
    }
    expect(JSON.parse(runTool('show_on_chart', { clear: 'yes' }, ui).result).error).toMatch(/clear must be true/);
    expect(ghost).toBeNull();
  });
  it('isGhost ignores key order at every level', () => {
    setGhost({ label: 'a', overrides: { retireAge: 60, retire: { costs: 70000, equity: 60 }, accounts: { 'Roth IRA': { contribution: 7000, cagr: 6 } } } });
    expect(isGhost({ accounts: { 'Roth IRA': { cagr: 6, contribution: 7000 } }, retire: { equity: 60, costs: 70000 }, retireAge: 60 })).toBe(true);
    expect(isGhost({ retireAge: 60, retire: { costs: 70000, equity: 61 }, accounts: { 'Roth IRA': { contribution: 7000, cagr: 6 } } })).toBe(false);
    setGhost(null);
  });
  it('sweep values are exact decimals, so a row matches the same typed input', () => {
    const card = runTool('sweep', { input: 'inflation', from: 2, to: 3, step: 0.1 }, ui).card as Extract<Card, { type: 'sweep' }>;
    expect(card.points.map((p) => p.value)).toEqual([2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3]);
    setGhost({ label: 'x', overrides: { inflation: 2.3 } });
    expect(isGhost(card.points[3]!.overrides)).toBe(true);
    setGhost(null);
    const cmp = JSON.parse(runTool('compare', { scenarios: [{ label: 'A', overrides: {} }], sweep: { input: 'inflation', from: 2, to: 3, step: 0.1 } }, ui).result) as { values: number[] };
    expect(cmp.values[3]).toBe(2.3);
  });
  it('sweep rows get the same human labels as scenario chips', () => {
    expect(sweepLabel('retireAge', 65)).toBe('Retire at 65');
    expect(sweepLabel('inflation', 2.3)).toBe('Inflation 2.3%');
    expect(sweepLabel('costs', 70000)).toBe('Costs $70,000/yr');
  });
  it('every tool has a schema the API accepts', () => {
    for (const t of TOOLS) expect(t.parameters).toHaveProperty('type', 'object');
    expect(evaluate().runs).toBeGreaterThan(0);
  });
});

function stream(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
  return new Response(body, { status: 200 });
}
const sse = (objs: unknown[]): string => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('client', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('streams text, runs a tool call, feeds the result back, retries a 500', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) return new Response('{"error":{"message":"upstream"}}', { status: 502 });
      if (n === 2) return stream([sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_', arguments: '{"label":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'scenario', arguments: '"x","overrides":{"retireAge":58}}' } }] } }] },
      ])]);
      return stream([': OPENROUTER PROCESSING\n\n', sse([{ choices: [{ delta: { reasoning: 'hmm ' } }] }, { choices: [{ delta: { content: 'Done.' } }] }, { choices: [{ delta: {} }], usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.00031 } }])]);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'http://test' });
    const wire: WireMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }];
    let text = '', reasoning = '';
    const calls: string[] = [];
    const usage: unknown[] = [];
    await complete(wire, TOOLS, { apiKey: 'k', model: 'm', reasoning: false }, {
      onText: (d) => { text += d; }, onReasoning: (d) => { reasoning += d; },
      onUsage: (u) => usage.push(u),
      onToolCall: async (c) => { calls.push(`${c.name}:${JSON.stringify(c.args)}`); return '{"ok":true}'; },
    });
    expect(usage).toEqual([{ prompt: 1200, completion: 40, cost: 0.00031 }]);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).usage).toEqual({ include: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(['run_scenario:{"label":"x","overrides":{"retireAge":58}}']);
    expect(text).toBe('Done.');
    expect(reasoning).toBe('hmm ');
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
  });
  it('show_on_chart from a streamed tool call ghosts one sweep row at a time and its card shows it on', async () => {
    const ui = { rerender: () => {} };
    setGhost(null);
    const row = runTool('sweep', { input: 'retireAge', from: 55, to: 65, step: 5 }, ui).card as Extract<Card, { type: 'sweep' }>;
    const [r55, r60] = [row.points[0]!, row.points[1]!];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++n === 1
      ? stream([sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', function: { name: 'show_on_chart', arguments: JSON.stringify({ label: 'Retire at 60', overrides: { retireAge: 60 } }) } }] } }] }])])
      : stream([sse([{ choices: [{ delta: { content: 'On the chart.' } }] }])])));
    vi.stubGlobal('location', { origin: 'http://test' });
    const cards: (Card | undefined)[] = [];
    await complete([{ role: 'user', content: 'ghost the 60 row' }], TOOLS, { apiKey: 'k', model: 'm', reasoning: false }, {
      onText: () => {}, onReasoning: () => {},
      onToolCall: async (c) => { const out = runTool(c.name, c.args, ui); cards.push(out.card); return out.result; },
    });
    expect(ghost).toEqual({ label: 'Retire at 60', overrides: { retireAge: 60 } });
    expect(cards[0]?.type).toBe('scenario');
    expect(isGhost((cards[0] as Extract<Card, { type: 'scenario' }>).overrides)).toBe(true);
    // The sweep row with the same inputs lights up; its neighbours do not.
    expect(isGhost(r60.overrides)).toBe(true);
    expect(isGhost(r55.overrides)).toBe(false);
    // A second ghost replaces the first; clear removes it.
    runTool('show_on_chart', { label: 'Retire at 55', overrides: r55.overrides }, ui);
    expect([isGhost(r55.overrides), isGhost(r60.overrides)]).toEqual([true, false]);
    expect(JSON.parse(runTool('show_on_chart', { clear: true }, ui).result)).toEqual({ cleared: true });
    expect(ghost).toBeNull();
  });
  it('does not retry a 401', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'http://test' });
    await expect(complete([{ role: 'user', content: 'q' }], TOOLS, { apiKey: 'k', model: 'm', reasoning: false }, { onText: () => {}, onReasoning: () => {}, onToolCall: async () => '' })).rejects.toThrow('bad key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
