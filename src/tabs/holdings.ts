import { BUCKETS, BUCKET_LABEL, type Holding } from '../holdings';
import { donut, hbars } from '../chart';
import { h, stat, table, help } from '../dom';
import { pct, usd } from '../format';
import { accounts, holdings } from '../state';

// Fund-type groups shown as one row each. Known tickers are listed explicitly;
// the name-based fallbacks catch tickers a newer export might add.
type Group = 'Market Funds' | 'International Market Funds' | 'Other ETFs' | 'Bonds' | 'Leveraged Funds' | 'CDs';
const GROUPS: Record<Group, string[]> = {
  'Market Funds': ['VTI', 'VOO', 'SPY', 'IVV', 'SCHB', 'FSKAX', 'FXAIX', 'VXF'],
  'International Market Funds': ['VXUS', 'VEA', 'VWO', 'FSPSX'],
  'Other ETFs': ['QQQ', 'SOXX'],
  'Bonds': ['BND', 'AGG', 'FXNAX'],
  'Leveraged Funds': ['TQQQ', 'SSO'],
  'CDs': [],
};
const GROUP_ORDER = Object.keys(GROUPS) as Group[];
const HIDDEN = new Set<string>([]); // tickers to leave off the tab entirely
const CASH = new Set(['SPAXX', 'FDRXX', 'SPRXX']);

function classify(x: Holding): Group | null {
  for (const g of GROUP_ORDER) if (GROUPS[g].includes(x.ticker)) return g;
  const n = x.name.toUpperCase();
  if (/\bCD\b/.test(n)) return 'CDs';
  if (/\b(2X|3X|BULL|BEAR|LEVERAGE)/.test(n)) return 'Leveraged Funds';
  if (/\b(BOND|BD IDX|TREASURY|TR BD)\b/.test(n)) return 'Bonds';
  const fund = /\b(ETF|INDEX|IDX|FUND|TRUST|MKT)\b/.test(n);
  if (fund && /\b(INTL|INTERNATIONAL|EMRG|EMERGING|EX-US)\b/.test(n)) return 'International Market Funds';
  if (fund && /\b(TOTAL|BROAD|S&P|STOCK MKT|STKMK|SMALL CAP|SMCAP|EXTD|EXTENDED)\b/.test(n)) return 'Market Funds';
  if (fund) return 'Other ETFs';
  return null;
}

interface Position { key: string; label: string; meta: string; value: number; basis: number; gain: number; accounts: Set<string>; tickers: Set<string>; group: Group | null }

export function renderHoldings(): HTMLElement {
  const total = holdings.reduce((s, x) => s + x.value, 0);
  const positions = new Map<string, Position>();
  let cash = 0;
  for (const x of holdings) {
    if (CASH.has(x.ticker)) { cash += x.value; continue; }
    if (HIDDEN.has(x.ticker)) continue;
    const group = classify(x);
    const key = group ?? x.ticker;
    let p = positions.get(key);
    if (!p) {
      p = { key, label: key, meta: group ? '' : x.name, value: 0, basis: 0, gain: 0, accounts: new Set(), tickers: new Set(), group };
      positions.set(key, p);
    }
    p.value += x.value; p.basis += x.costBasis || x.value; p.gain += x.gain;
    p.accounts.add(x.account); p.tickers.add(x.ticker);
  }
  const rows = [...positions.values()].sort((a, b) => b.value - a.value);
  const top5 = rows.slice(0, 5).reduce((s, p) => s + p.value, 0);
  const groupTotal = (g: Group) => positions.get(g)?.value ?? 0;
  const maxV = rows[0]?.value ?? 1;

  const body = rows.map((p) => [
    h('div', { class: 'acct' },
      h('div', { class: 'acct-name' }, p.label, p.group ? h('span', { class: 'tag' }, `${p.tickers.size}`) : null),
      h('div', { class: 'acct-meta' }, p.group ? [...p.tickers].join(' · ') : p.meta)),
    h('div', { class: 'bar-cell' }, h('span', { class: 'bar-track' }, h('span', { class: 'bar', style: `width:${(p.value / maxV) * 100}%` })), usd(p.value)),
    pct(p.value / total),
    h('span', { class: p.gain >= 0 ? 'pos' : 'neg' }, `${usd(p.gain)} (${pct(p.basis > 0 ? p.gain / p.basis : 0)})`),
    [...p.accounts].join(', '),
  ]);

  const bucketTotals = BUCKETS.map((b) => accounts.filter((a) => a.bucket === b).reduce((s, a) => s + a.value, 0));
  const taxDonut = donut(BUCKETS.map((b, i) => ({ label: BUCKET_LABEL[b], cls: b, value: bucketTotals[i] ?? 0 })), usd(total / 1000, 0) + 'k');

  const funds = groupTotal('Market Funds') + groupTotal('International Market Funds') + groupTotal('Other ETFs');
  const stocks = rows.filter((p) => p.group === null).reduce((s, p) => s + p.value, 0);
  const lev = groupTotal('Leveraged Funds');

  const categories = donut([
    { label: 'Individual stocks', cls: 's1', value: stocks },
    { label: 'Market Funds', cls: 's3', value: groupTotal('Market Funds') },
    { label: 'International Market Funds', cls: 's6', value: groupTotal('International Market Funds') },
    { label: 'Other ETFs', cls: 's4', value: groupTotal('Other ETFs') },
    { label: 'Cash, CDs, bonds', cls: 's5', value: cash + groupTotal('CDs') + groupTotal('Bonds') },
    { label: 'Leveraged Funds', cls: 's2', value: lev },
  ], usd(total / 1000, 0) + 'k');
  const stockBars = hbars(rows.filter((p) => p.group === null).slice(0, 10).map((p) => ({ label: p.label, sub: p.meta, value: p.value, cls: 's1' })));

  return h('div', { class: 'tab' },
    h('section', { class: 'stats' },
      stat('Total', usd(total), `${holdings.length} lines · ${rows.length} rows`),
      stat('Top 5 rows', pct(top5 / total), rows.slice(0, 5).map((p) => p.label).join(' · ')),
      stat('Index / ETF funds', usd(funds), pct(funds / total)),
      stat('Individual stocks', usd(stocks), pct(stocks / total)),
      stat('Cash + CDs + bonds', usd(cash + groupTotal('CDs') + groupTotal('Bonds')), pct((cash + groupTotal('CDs') + groupTotal('Bonds')) / total)),
      stat('Leveraged funds', usd(lev), pct(lev / total), lev / total > 0.05 ? 'bad' : undefined)),
    h('section', { class: 'two-col' },
      h('div', { class: 'panel' }, h('h3', {}, 'What kind of thing you own'), categories),
      h('div', { class: 'panel' }, h('h3', {}, 'Tax buckets'), taxDonut),
      h('div', { class: 'panel' }, h('h3', {}, 'Largest single stocks'), stockBars)),
    h('section', {}, h('h2', {}, 'Positions across all accounts', help('Funds are grouped by type. Cash is left out.')),
      table(['Position', 'Value', 'Weight', 'Unrealized gain', 'Held in'], body, { numericFrom: 1, wrap: [0, 4] })));
}
