// Plain-SVG charts with hover tooltips. Colours come from CSS classes s1..s6
// (fixed categorical slots) so a series keeps its colour whatever its rank.

import { h } from './dom';
import { usd, usdK } from './format';

export interface Series { label: string; cls: string; values: number[] }

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
function text(x: number, y: number, s: string, anchor: 'start' | 'middle' | 'end' = 'start', cls = 'axis'): SVGTextElement {
  const t = svg('text', { x, y, class: cls, 'text-anchor': anchor });
  t.textContent = s;
  return t;
}

export function legend(items: { label: string; cls: string }[]): HTMLElement {
  return h('div', { class: 'legend' }, ...items.map((i) => h('span', {}, h('span', { class: `dot ${i.cls}` }), i.label)));
}

interface Frame { W: number; H: number; pad: { l: number; r: number; t: number; b: number }; x: (i: number) => number; y: (v: number) => number }
function frame(W: number, H: number, n: number, max: number, min = 0): Frame {
  const pad = { l: 60, r: 16, t: 12, b: 26 };
  return { W, H, pad,
    x: (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r),
    y: (v) => pad.t + (1 - (v - min) / Math.max(1e-9, max - min)) * (H - pad.t - pad.b) };
}
function grid(root: SVGSVGElement, f: Frame, max: number, labels: (i: number) => string, n: number, every: number, axis: (v: number) => string = usdK): void {
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    root.append(svg('line', { x1: f.pad.l, x2: f.W - f.pad.r, y1: f.y(v), y2: f.y(v), class: 'grid' }));
    root.append(text(f.pad.l - 8, f.y(v) + 4, axis(v), 'end'));
  }
  for (let i = 0; i < n; i += every) root.append(text(f.x(i), f.H - 8, labels(i), 'middle'));
}
// Shared hover wiring: crosshair, index lookup, tooltip placement.
function hover(root: SVGSVGElement, f: Frame, n: number, render: (i: number) => (Node | string)[], onIndex?: (i: number) => void): HTMLElement {
  const cross = svg('line', { x1: 0, x2: 0, y1: f.pad.t, y2: f.H - f.pad.b, class: 'crosshair', visibility: 'hidden' });
  root.append(cross);
  const tip = h('div', { class: 'tooltip', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, root, tip);
  root.addEventListener('mousemove', (e) => {
    const rect = root.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * f.W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - f.pad.l) / (f.W - f.pad.l - f.pad.r)) * (n - 1))));
    cross.setAttribute('x1', String(f.x(i))); cross.setAttribute('x2', String(f.x(i))); cross.setAttribute('visibility', 'visible');
    onIndex?.(i);
    tip.replaceChildren(...render(i));
    tip.hidden = false;
    const left = (f.x(i) / f.W) * rect.width;
    tip.style.left = `${left > rect.width * 0.6 ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = `${Math.max(0, e.clientY - rect.top - 20)}px`;
  });
  root.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; onIndex?.(-1); });
  return wrap;
}
const row = (cls: string, label: string, val: string) =>
  h('div', { class: 'tip-row' }, h('span', { class: `dot ${cls}` }), label, h('span', { class: 'tip-val' }, val));

export interface StackedAreaOpts { series: Series[]; startAge: number; height?: number; extra?: (i: number) => string; format?: (v: number) => string; max?: number }

export function stackedArea(o: StackedAreaOpts): HTMLElement {
  const W = 900, H = o.height ?? 300;
  const n = o.series[0]?.values.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) => o.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const fmt = o.format ?? usd;
  const top = o.max ?? Math.max(1, ...totals);
  const f = frame(W, H, n, top);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  grid(root, f, top, (i) => String(o.startAge + i), n, 5, o.format);
  let base = new Array<number>(n).fill(0);
  const dots: SVGCircleElement[] = [];
  for (const s of o.series) {
    const top = base.map((v, i) => v + (s.values[i] ?? 0));
    const d = top.map((v, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${f.y(v).toFixed(1)}`).join(' ')
      + ' ' + [...base.keys()].reverse().map((i) => `L${f.x(i).toFixed(1)},${f.y(base[i] ?? 0).toFixed(1)}`).join(' ') + ' Z';
    root.append(svg('path', { d, class: `area ${s.cls}` }));
    const c = svg('circle', { r: 4, class: `dot-mark ${s.cls}`, visibility: 'hidden' });
    dots.push(c);
    base = top;
  }
  root.append(...dots);
  const wrap = hover(root, f, n, (i) => [
    h('div', { class: 'tip-title' }, o.format ? `Age ${o.startAge + i}` : `Age ${o.startAge + i} · ${usd(totals[i] ?? 0)}`),
    ...o.series.map((s) => row(s.cls, s.label, fmt(s.values[i] ?? 0))),
    ...(o.extra ? [h('div', { class: 'tip-sub' }, o.extra(i))] : []),
  ], (i) => {
    let acc = 0;
    o.series.forEach((s, k) => {
      acc += s.values[i] ?? 0;
      const c = dots[k]; if (!c) return;
      if (i < 0) { c.setAttribute('visibility', 'hidden'); return; }
      c.setAttribute('cx', String(f.x(i))); c.setAttribute('cy', String(f.y(acc))); c.setAttribute('visibility', 'visible');
    });
  });
  return h('div', {}, legend(o.series), wrap);
}

export interface Band { p10: number; p25: number; p50: number; p75: number; p90: number }
export interface FanGhost { label: string; startAge: number; values: number[] }
export interface FanOpts { bands: Band[]; startAge: number; height?: number; reference?: number; ghost?: FanGhost }

/**
 * Where a ghost line lands on a fan chart of `n` ages starting at `startAge`. The ghost's values start at its
 * own age, so a later retire age shifts right and an earlier one is clipped at the chart start; `i` is the chart
 * index. Fewer than two points draw no line, which the caller reports instead of claiming the ghost is shown.
 */
export function ghostPoints(n: number, startAge: number, ghost: Pick<FanGhost, 'startAge' | 'values'>): { i: number; v: number }[] {
  const shift = ghost.startAge - startAge;
  const out: { i: number; v: number }[] = [];
  for (let i = Math.max(0, shift); i < n; i++) {
    const v = ghost.values[i - shift];
    if (v === undefined) break;
    out.push({ i, v });
  }
  return out;
}

// Percentile fan: 10-90 light, 25-75 stronger, median line.
export function fanChart(o: FanOpts): HTMLElement {
  const W = 900, H = o.height ?? 300;
  const n = o.bands.length;
  const pts = o.ghost ? ghostPoints(n, o.startAge, o.ghost) : [];
  const ghostPts = pts.length > 1 ? pts : [];   // one point is not a line
  const ghostAt = (i: number): number | undefined => ghostPts.find((p) => p.i === i)?.v;
  const max = Math.max(1, ...o.bands.map((b) => b.p90), o.reference ?? 0, ...ghostPts.map((p) => p.v));
  const f = frame(W, H, n, max);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  grid(root, f, max, (i) => String(o.startAge + i), n, 5);
  const band = (lo: keyof Band, hi: keyof Band, cls: string) => {
    const d = o.bands.map((b, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${f.y(b[hi]).toFixed(1)}`).join(' ')
      + ' ' + [...o.bands.keys()].reverse().map((i) => `L${f.x(i).toFixed(1)},${f.y(o.bands[i]?.[lo] ?? 0).toFixed(1)}`).join(' ') + ' Z';
    root.append(svg('path', { d, class: `band ${cls}` }));
  };
  band('p10', 'p90', 'outer');
  band('p25', 'p75', 'inner');
  root.append(svg('path', { d: o.bands.map((b, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${f.y(b.p50).toFixed(1)}`).join(' '), class: 'line s1' }));
  if (ghostPts.length) root.append(svg('path', { d: ghostPts.map((p, k) => `${k ? 'L' : 'M'}${f.x(p.i).toFixed(1)},${f.y(p.v).toFixed(1)}`).join(' '), class: 'line ghost' }));
  if (o.reference !== undefined) {
    root.append(svg('line', { x1: f.pad.l, x2: f.W - f.pad.r, y1: f.y(o.reference), y2: f.y(o.reference), class: 'refline' }));
    root.append(text(f.W - f.pad.r, f.y(o.reference) - 4, 'starting balance', 'end'));
  }
  const wrap = hover(root, f, n, (i) => {
    const b = o.bands[i];
    return b ? [
      h('div', { class: 'tip-title' }, `Age ${o.startAge + i}`),
      row('s1', 'Median', usd(b.p50)),
      ...(o.ghost && ghostAt(i) !== undefined ? [row('ghost', o.ghost.label, usd(ghostAt(i)!))] : []),
      h('div', { class: 'tip-row' }, h('span', { class: 'dot inner' }), '25th to 75th', h('span', { class: 'tip-val' }, `${usdK(b.p25)} to ${usdK(b.p75)}`)),
      h('div', { class: 'tip-row' }, h('span', { class: 'dot outer' }), '10th to 90th', h('span', { class: 'tip-val' }, `${usdK(b.p10)} to ${usdK(b.p90)}`)),
    ] : [];
  });
  return h('div', {}, h('div', { class: 'legend' },
    h('span', {}, h('span', { class: 'dot s1' }), 'Median'),
    ...(o.ghost && ghostPts.length ? [h('span', {}, h('span', { class: 'dot ghost' }), `${o.ghost.label} (median)`)] : []),
    h('span', {}, h('span', { class: 'dot inner' }), '25th to 75th percentile'),
    h('span', {}, h('span', { class: 'dot outer' }), '10th to 90th percentile')), wrap);
}

export interface LineOpts {
  series: Series[]; startAge: number; height?: number; reference?: number;
  /** Mark the lowest point of this series (index into `series`) with a label. */
  markLow?: number;
}

// One or more balance paths by age, on the same frame as the fan chart:
// gridlines, hover tooltip, optional reference line, low-point and end labels.
export function lineChart(o: LineOpts): HTMLElement {
  const W = 900, H = o.height ?? 240;
  const n = Math.max(...o.series.map((s) => s.values.length));
  const max = Math.max(1, ...o.series.flatMap((s) => s.values), o.reference ?? 0);
  const f = frame(W, H, n, max);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  grid(root, f, max, (i) => String(o.startAge + i), n, n > 20 ? 5 : n > 10 ? 2 : 1);
  if (o.reference !== undefined) {
    root.append(svg('line', { x1: f.pad.l, x2: f.W - f.pad.r, y1: f.y(o.reference), y2: f.y(o.reference), class: 'refline' }));
    root.append(text(f.W - f.pad.r, f.y(o.reference) - 4, 'starting balance', 'end'));
  }
  o.series.forEach((s, si) => {
    const path = s.values.map((v, i) => `${i ? 'L' : 'M'}${f.x(i).toFixed(1)},${f.y(v).toFixed(1)}`).join(' ');
    if (si === 0) root.append(svg('path', { d: `${path} L${f.x(s.values.length - 1).toFixed(1)},${f.y(0)} L${f.x(0)},${f.y(0)} Z`, class: `fill ${s.cls}` }));
    root.append(svg('path', { d: path, class: `line ${s.cls}` }));
    const last = s.values.length - 1;
    const end = s.values[last] ?? 0;
    root.append(svg('circle', { cx: f.x(last), cy: f.y(end), r: 4, class: `dot-mark ${s.cls}` }));
    if (end <= 0) root.append(text(f.x(last), f.y(0) - 8, `runs out at ${o.startAge + last}`, last > n * 0.7 ? 'end' : 'start', 'axis warn'));
  });
  if (o.markLow !== undefined) {
    const s = o.series[o.markLow];
    if (s) {
      let lo = 0;
      s.values.forEach((v, i) => { if (v < (s.values[lo] ?? Infinity)) lo = i; });
      const v = s.values[lo] ?? 0;
      if (lo > 0 && v > 0) {
        root.append(svg('circle', { cx: f.x(lo), cy: f.y(v), r: 4, class: `dot-mark ${s.cls}` }));
        root.append(text(f.x(lo), f.y(v) + 16, `low ${usdK(v)} at ${o.startAge + lo}`, lo > n * 0.7 ? 'end' : lo < n * 0.15 ? 'start' : 'middle'));
      }
    }
  }
  const wrap = hover(root, f, n, (i) => [
    h('div', { class: 'tip-title' }, `Age ${o.startAge + i}`),
    ...o.series.map((s) => row(s.cls, s.label, usd(s.values[i] ?? 0))),
  ]);
  return h('div', {}, o.series.length > 1 ? legend(o.series) : null, wrap);
}

export interface StackedBarsOpts { series: Series[]; labels: string[]; height?: number; negative?: Series }

// Per-year stacked bars (e.g. where spending comes from); an optional negative
// series (tax) hangs below the baseline.
export function stackedBars(o: StackedBarsOpts): HTMLElement {
  const W = 900, H = o.height ?? 280;
  const n = o.labels.length;
  const totals = Array.from({ length: n }, (_, i) => o.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const negMax = o.negative ? Math.max(0, ...o.negative.values) : 0;
  const max = Math.max(1, ...totals);
  const pad = { l: 60, r: 16, t: 12, b: 26 };
  const plotH = H - pad.t - pad.b;
  const span = max + negMax;
  const y = (v: number) => pad.t + ((max - v) / span) * plotH;
  const f: Frame = { W, H, pad, x: (i) => pad.l + ((i + 0.5) / n) * (W - pad.l - pad.r), y };
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }));
    root.append(text(pad.l - 8, y(v) + 4, usdK(v), 'end'));
  }
  if (negMax > 0) root.append(text(pad.l - 8, y(-negMax) + 4, `-${usdK(negMax)}`, 'end'));
  const bw = Math.max(2, ((W - pad.l - pad.r) / n) * 0.7);
  const every = n > 20 ? 5 : n > 10 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const s of o.series) {
      const v = s.values[i] ?? 0;
      if (v <= 0) continue;
      root.append(svg('rect', { x: f.x(i) - bw / 2, y: y(acc + v), width: bw, height: Math.max(0, y(acc) - y(acc + v)), class: `bar-seg ${s.cls}` }));
      acc += v;
    }
    if (o.negative) {
      const v = o.negative.values[i] ?? 0;
      if (v > 0) root.append(svg('rect', { x: f.x(i) - bw / 2, y: y(0), width: bw, height: Math.max(0, y(-v) - y(0)), class: `bar-seg ${o.negative.cls}` }));
    }
    if (i % every === 0) root.append(text(f.x(i), H - 8, o.labels[i] ?? '', 'middle'));
  }
  root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'baseline' }));
  const wrap = hover(root, f, n, (i) => [
    h('div', { class: 'tip-title' }, `${o.labels[i] ?? ''} · ${usd(totals[i] ?? 0)}`),
    ...o.series.map((s) => row(s.cls, s.label, usd(s.values[i] ?? 0))),
    ...(o.negative ? [row(o.negative.cls, o.negative.label, `-${usd(o.negative.values[i] ?? 0)}`)] : []),
  ]);
  return h('div', {}, legend([...o.series, ...(o.negative ? [o.negative] : [])]), wrap);
}

export interface Slice { label: string; cls: string; value: number; sub?: string }

// Donut with a centred total and a legend that doubles as the value table.
export function donut(slices: Slice[], centre: string, centreSub?: string): HTMLElement {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 70, r = 46, C = 80;
  const root = svg('svg', { viewBox: '0 0 160 160', class: 'donut', role: 'img' });
  let a0 = -Math.PI / 2;
  for (const s of slices) {
    if (s.value <= 0) continue;
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${(C + rad * Math.cos(ang)).toFixed(2)},${(C + rad * Math.sin(ang)).toFixed(2)}`;
    const d = `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`;
    const path = svg('path', { d, class: `slice ${s.cls}` });
    path.append(svg('title', {})); path.firstChild!.textContent = `${s.label} ${usd(s.value)}`;
    root.append(path);
    a0 = a1;
  }
  root.append(text(C, C - 2, centre, 'middle', 'donut-centre'));
  if (centreSub) root.append(text(C, C + 14, centreSub, 'middle', 'axis'));
  const list = h('div', { class: 'donut-legend' }, ...slices.filter((s) => s.value > 0).map((s) =>
    h('div', { class: 'donut-row' }, h('span', { class: `dot ${s.cls}` }), h('span', { class: 'donut-label' }, s.label, s.sub ? h('span', { class: 'muted' }, ` ${s.sub}`) : null),
      h('span', { class: 'donut-val' }, usd(s.value)), h('span', { class: 'donut-pct' }, `${((s.value / total) * 100).toFixed(1)}%`))));
  return h('div', { class: 'donut-wrap' }, root, list);
}

export interface BarRow { label: string; value: number; cls: string; sub?: string }

// Horizontal bars, one per row, sorted as given.
export function hbars(rows: BarRow[]): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'hbars' }, ...rows.map((r) =>
    h('div', { class: 'hbar-row' },
      h('div', { class: 'hbar-label' }, r.label, r.sub ? h('span', { class: 'muted' }, ` ${r.sub}`) : null),
      h('div', { class: 'hbar-track' }, h('div', { class: `hbar ${r.cls}`, style: `width:${(r.value / max) * 100}%` })),
      h('div', { class: 'hbar-val' }, usd(r.value)))));
}
