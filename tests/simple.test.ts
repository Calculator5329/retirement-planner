import { describe, expect, it } from 'vitest';
import { futureValue } from '../src/model';
import { GROWTH_WHILE_SAVING, LATEST_STOP, SAMPLE, checkStopAge, earliestStop, type Inputs } from '../simple/answer';

describe('simple: earliest age to stop working', () => {
  it('grows savings at the compound average of the 60/40 mix, about 4.9% above inflation', () => {
    expect(GROWTH_WHILE_SAVING).toBeGreaterThan(0.045);
    expect(GROWTH_WHILE_SAVING).toBeLessThan(0.053);
    const c = checkStopAge(SAMPLE, 60);
    expect(c.nestEgg).toBeCloseTo(futureValue(SAMPLE.saved, SAMPLE.savingPerMonth * 12, GROWTH_WHILE_SAVING, 20), 6);
  });

  it('answers the sample with an age between today and 75', () => {
    const a = earliestStop(SAMPLE);
    expect(a.stopAge).not.toBeNull();
    expect(a.stopAge!).toBeGreaterThan(SAMPLE.age);
    expect(a.stopAge!).toBeLessThanOrEqual(LATEST_STOP);
  });

  it('is the boundary: passes at the answer, fails a year earlier', () => {
    for (const i of [SAMPLE, { ...SAMPLE, age: 30, saved: 20_000 }, { ...SAMPLE, spendingPerMonth: 6_000 }]) {
      const a = earliestStop(i);
      expect(a.stopAge).not.toBeNull();
      expect(a.check.passes).toBe(true);
      if (!a.now) expect(checkStopAge(i, a.stopAge! - 1).passes).toBe(false);
    }
  });

  it('moves the right way with each input', () => {
    const at = (i: Inputs): number => earliestStop(i).stopAge ?? 99;
    const base = at(SAMPLE);
    expect(at({ ...SAMPLE, saved: 600_000 })).toBeLessThan(base);
    expect(at({ ...SAMPLE, savingPerMonth: 4_000 })).toBeLessThan(base);
    expect(at({ ...SAMPLE, spendingPerMonth: 7_000 })).toBeGreaterThan(base);
    expect(at({ ...SAMPLE, age: 50 })).toBeGreaterThan(base);
  });

  it('says now when the savings already cover it, and not by 75 when nothing does', () => {
    const rich = earliestStop({ age: 50, saved: 2_000_000, savingPerMonth: 0, spendingPerMonth: 3_000 });
    expect(rich.now).toBe(true);
    expect(rich.stopAge).toBe(50);
    const short = earliestStop({ age: 60, saved: 0, savingPerMonth: 0, spendingPerMonth: 15_000 });
    expect(short.stopAge).toBeNull();
    expect(short.check.stopAge).toBe(LATEST_STOP);
  });
});

// The page must never load the files that can carry real data: src/state.ts
// reads the holdings CSV and defaults JSON (aliased to private/ by the root
// vite config), and src/plan.ts reads state. Walk every relative import
// reachable from the page's entry and refuse those files.
describe('simple: no path to personal data', () => {
  // Every source file, keyed '../src/x.ts' relative to this test (no node typings in this repo).
  const sources = import.meta.glob<string>(['../src/**/*.ts', '../simple/**/*.ts'], { query: '?raw', import: 'default', eager: true });
  const forbidden = [/src\/state\.ts$/, /src\/plan\.ts$/, /holdings\.csv/, /defaults\.json$/, /\/private\//];
  const join = (from: string, spec: string): string => {
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  };
  function reachable(entry: string): string[] {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!file.endsWith('.ts')) continue;
      const src = sources[file];
      if (src === undefined) throw new Error(`import of a file that does not exist: ${file}`);
      // `from './x'`, bare `import './x'` and dynamic `import('./x')`; `import type` is erased at build time.
      for (const m of src.matchAll(/^[ \t]*(import|export)(\s+type\s)?(?:[\w$*\s{},]*?\sfrom\s*|\s*)['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]/gm)) {
        if (m[2]) continue;
        const target = join(file, (m[3] ?? m[4]!).replace(/\?raw$/, ''));
        stack.push(/\.(ts|csv|json)$/.test(target) ? target : `${target}.ts`);
      }
    }
    return [...seen].map((f) => f.replace(/^\.\.\//, ''));
  }

  it('reaches only the pure core from simple/main.ts', () => {
    const files = reachable('../simple/main.ts');
    expect(files).toContain('src/sim.ts');
    expect(files.filter((f) => forbidden.some((re) => re.test(f)))).toEqual([]);
  });

  it('would catch an import of the app state (checked against the real app entry)', () => {
    const files = reachable('../src/main.ts');
    expect(files.filter((f) => forbidden.some((re) => re.test(f))).length).toBeGreaterThan(0);
  });
});
