// Parses the broker export CSV into holdings and rolls them up into accounts.
// The export has an 8-column header but 10 data columns: the last two are the
// account type (401K, 403B, Roth, Normal Brokerage) and tax treatment.

export type TaxBucket = 'pretax' | 'roth' | 'taxable';

export interface Holding {
  ticker: string;
  name: string;
  shares: number;
  value: number;
  costBasis: number;
  gain: number;
  account: string;
  broker: string;
  accountType: string;
  bucket: TaxBucket;
}

export interface Account {
  name: string;
  broker: string;
  accountType: string;
  bucket: TaxBucket;
  value: number;
  costBasis: number;
  gain: number;
  holdings: Holding[];   // empty for an account typed in by hand
  entered?: string;      // the EnteredAccount id when typed in by hand (src/state.ts), absent when read from a holdings file
}

export const BUCKET_LABEL: Record<TaxBucket, string> = {
  pretax: 'Pre-tax',
  roth: 'Roth',
  taxable: 'Taxable',
};

export const BUCKETS: TaxBucket[] = ['pretax', 'roth', 'taxable'];

function toBucket(treatment: string): TaxBucket {
  const t = treatment.trim().toLowerCase();
  if (t === 'pre-tax') return 'pretax';
  if (t === 'post-tax') return 'roth';
  return 'taxable';
}

function num(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Splits one CSV line, honouring double-quoted fields.
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseHoldings(csv: string): Holding[] {
  const rows: Holding[] = [];
  for (const raw of csv.split(/\r?\n/).slice(1)) {
    const c = splitLine(raw);
    const ticker = (c[0] ?? '').trim();
    const account = (c[6] ?? '').trim();
    if (!ticker || !account) continue;
    const value = num(c[3]);
    const costBasis = num(c[4]);
    rows.push({
      ticker,
      name: (c[1] ?? '').trim(),
      shares: num(c[2]),
      value,
      costBasis,
      // Money market and CDs have no basis column; treat them as fully basis.
      gain: c[4] ? num(c[5]) : 0,
      account,
      broker: (c[7] ?? '').trim(),
      accountType: (c[8] ?? '').trim() || 'Normal Brokerage',
      bucket: toBucket(c[9] ?? ''),
    });
  }
  return rows;
}

export function rollupAccounts(holdings: Holding[]): Account[] {
  const map = new Map<string, Account>();
  for (const h of holdings) {
    const key = `${h.broker}::${h.account}`;
    let a = map.get(key);
    if (!a) {
      a = { name: h.account, broker: h.broker, accountType: h.accountType, bucket: h.bucket,
            value: 0, costBasis: 0, gain: 0, holdings: [] };
      map.set(key, a);
    }
    a.value += h.value;
    // A holding with no basis (cash, CDs without one) counts at face value.
    a.costBasis += h.costBasis || h.value;
    a.gain += h.gain;
    a.holdings.push(h);
  }
  return [...map.values()].sort((x, y) => y.value - x.value);
}
