import { describe, expect, it } from 'vitest';
import { ghostPoints } from '../src/chart';

// A 5-age chart from 60 to 64; the ghost's values start at its own retire age.
describe('ghostPoints', () => {
  const g = (startAge: number, n = 5) => ({ startAge, values: Array.from({ length: n }, (_, k) => 100 + k) });
  it('a later retire age starts to the right', () => {
    expect(ghostPoints(5, 60, g(62))).toEqual([{ i: 2, v: 100 }, { i: 3, v: 101 }, { i: 4, v: 102 }]);
  });
  it('an earlier retire age is clipped at the chart start', () => {
    expect(ghostPoints(5, 60, g(58))).toEqual([{ i: 0, v: 102 }, { i: 1, v: 103 }, { i: 2, v: 104 }]);
  });
  it('a ghost past the end has no points, one at the last age has one', () => {
    expect(ghostPoints(5, 60, g(70))).toEqual([]);
    expect(ghostPoints(5, 60, g(64))).toEqual([{ i: 4, v: 100 }]);
  });
});
