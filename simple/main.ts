// Wires the four sliders to earliestStop and draws the one small chart behind
// the explanation. All maths lives in ./answer.ts.

import {
  BOND_REAL, FIRST_START_YEAR, GROWTH_WHILE_SAVING, LAST_AGE, LATEST_STOP, PASS_SHARE, SAMPLE,
  SOCIAL_SECURITY_AGE, SOCIAL_SECURITY_MONTHLY, STOCK_SHARE, earliestStop, type Answer, type Inputs,
} from './answer';
import { LAST_YEAR } from '../src/data/history';

const KEYS = ['age', 'saved', 'savingPerMonth', 'spendingPerMonth'] as const;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const money = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');
const pct = (n: number, digits = 0): string => (n * 100).toFixed(digits) + '%';
const shown: Record<(typeof KEYS)[number], (n: number) => string> = {
  age: (n) => String(n),
  saved: money,
  savingPerMonth: money,
  spendingPerMonth: money,
};

function read(): Inputs {
  const v = (k: (typeof KEYS)[number]): number => Number(($(k) as HTMLInputElement).value);
  return { age: v('age'), saved: v('saved'), savingPerMonth: v('savingPerMonth'), spendingPerMonth: v('spendingPerMonth') };
}

function stretches(a: Answer): string {
  return `${a.check.tested} stretches of real market history, one starting each year since ${FIRST_START_YEAR}`;
}

let last: Answer | null = null;

function render(): void {
  const i = read();
  for (const k of KEYS) {
    const text = shown[k](i[k]);
    $<HTMLOutputElement>(`${k}-out`).value = text;
    $(k).setAttribute('aria-valuetext', text);
  }
  const a = earliestStop(i);
  last = a;
  const big = $('big');
  const line = $('line');
  const c = a.check;
  if (a.stopAge === null) {
    big.textContent = `Not by ${LATEST_STOP}`;
    big.classList.add('long');
    line.textContent = `Even stopping at ${LATEST_STOP}, your money runs out before ${LAST_AGE} in ${c.tested - c.lasted} of ${stretches(a)}; saving more or planning to spend less brings this back.`;
  } else if (a.now) {
    big.textContent = 'Now';
    big.classList.remove('long');
    line.textContent = `If you stopped today, your money would last until ${LAST_AGE} in ${c.lasted} of ${stretches(a)}.`;
  } else {
    big.textContent = `At ${a.stopAge}`;
    big.classList.remove('long');
    line.textContent = `If you stop at ${a.stopAge}, your money lasts until ${LAST_AGE} in ${c.lasted} of ${stretches(a)}.`;
  }
  if (($('how') as HTMLDetailsElement).open) drawChart(a);
}

// ---- the chart behind the link: money left by age, typical run and a bad run ----

function drawChart(a: Answer): void {
  const bands = a.check.sim.bands;
  $('chart-age').textContent = String(a.check.stopAge);
  const W = 420, H = 200, L = 50, R = 86, T = 12, B = 26;
  const max = Math.max(1, ...bands.map((b) => b.p50));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const x0 = bands[0]?.age ?? 0, x1 = bands[bands.length - 1]?.age ?? 1;
  const x = (age: number): number => L + (W - L - R) * (age - x0) / Math.max(1, x1 - x0);
  const y = (v: number): number => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const path = (key: 'p50' | 'p10'): string => bands.map((b, k) => `${k ? 'L' : 'M'}${x(b.age).toFixed(1)},${y(b[key]).toFixed(1)}`).join('');
  const ticks: string[] = [];
  for (let v = 0; v <= top + 1; v += step) {
    ticks.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`);
  }
  const ages: string[] = [];
  const ageStep = x1 - x0 > 30 ? 10 : 5;
  for (let g = Math.ceil(x0 / ageStep) * ageStep; g <= x1; g += ageStep) {
    ages.push(`<text x="${x(g)}" y="${H - 8}" text-anchor="middle">${g}</text>`);
  }
  const end = bands[bands.length - 1];
  const endLabel = (v: number, cls: string, text: string, dy: number): string =>
    `<text class="${cls}" x="${W - R + 8}" y="${Math.min(H - B, Math.max(T + 8, y(v) + dy))}">${text}</text>`;
  const typicalY = end ? y(end.p50) : 0, badY = end ? y(end.p10) : 0;
  const apart = Math.abs(typicalY - badY) < 16;
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title">
    ${ticks.join('')}${ages.join('')}
    <path class="bad" d="${path('p10')}"/>
    <path class="typical" d="${path('p50')}"/>
    ${end ? endLabel(end.p50, 'label-typical', 'Typical', apart ? -6 : 4) + endLabel(end.p10, '', '1 in 10 worst', apart ? 12 : 4) : ''}
    <line class="cross" id="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="hit"/>
  </svg>`;
  const svg = $('chart').querySelector('svg')!;
  const cross = svg.querySelector('#cross')!;
  const readout = $('readout');
  const idle = `Solid line: the middle run. Dashed line: the run that did worse than 9 in 10.`;
  readout.textContent = idle;
  svg.querySelector('#hit')!.addEventListener('pointermove', (e) => {
    const pt = svg.getBoundingClientRect();
    const vx = ((e as PointerEvent).clientX - pt.left) * W / pt.width;
    const age = Math.round(x0 + (vx - L) / (W - L - R) * (x1 - x0));
    const b = bands.find((k) => k.age === age);
    if (!b) return;
    cross.setAttribute('x1', String(x(age))); cross.setAttribute('x2', String(x(age)));
    cross.setAttribute('visibility', 'visible');
    readout.textContent = `At ${age}: ${money(b.p50)} typical, ${money(b.p10)} in the 1 in 10 worst run.`;
  });
  svg.querySelector('#hit')!.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    readout.textContent = idle;
  });
  $('chart-table').innerHTML = '<tr><th>Age</th><th>Typical</th><th>1 in 10 worst</th></tr>' +
    bands.map((b) => `<tr><td>${b.age}</td><td>${money(b.p50)}</td><td>${money(b.p10)}</td></tr>`).join('');
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function short(v: number): string {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
  return '$' + v;
}

// ---- assumptions, filled from the constants so the text cannot drift ----

const ASSUMED: Record<string, string> = {
  growth: pct(GROWTH_WHILE_SAVING, 1),
  ssAge: String(SOCIAL_SECURITY_AGE),
  ss: money(SOCIAL_SECURITY_MONTHLY),
  firstYear: String(FIRST_START_YEAR),
  years: `${FIRST_START_YEAR} to ${LAST_YEAR}`,
  lastAge: String(LAST_AGE),
  pass: `${Math.round(PASS_SHARE * 10)} in 10`,
  stocks: pct(STOCK_SHARE),
  bonds: pct(1 - STOCK_SHARE),
  bondReal: pct(BOND_REAL),
};
document.querySelectorAll<HTMLElement>('[data-a]').forEach((el) => { el.textContent = ASSUMED[el.dataset.a ?? ''] ?? ''; });

for (const k of KEYS) ($(k) as HTMLInputElement).value = String(SAMPLE[k]);

let queued = false;
$('inputs').addEventListener('input', () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
});
$('how').addEventListener('toggle', () => { if (($('how') as HTMLDetailsElement).open && last) drawChart(last); });
render();
