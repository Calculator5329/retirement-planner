// Persistent user inputs (localStorage) plus the derived data every tab reads.

import { BUCKETS, parseHoldings, rollupAccounts, type Account, type Holding, type TaxBucket } from './holdings';
import { REAL_EQUITY } from './data/history';
import { ANNUITY_KINDS, LADDER_MODES, type AnnuityKind, type Filing, type LadderMode } from './model';
import bundledCsv from './data/holdings.csv?raw';
import shippedDefaults from './data/defaults.json';

// cagr in percent. salary, matchPct and matchUpToPct describe an employer
// match ("matchPct% of contributions up to matchUpToPct% of salary"); all zero
// means no match, and only employer-plan accounts ever receive one.
/** Allowed yearly growth, percent, for the default and for any one account. */
export const CAGR_RANGE = [-20, 30] as const;
export interface AccountSettings { contribution: number; cagr: number; salary: number; matchPct: number; matchUpToPct: number }
export interface RetireSettings {
  swr: number;         // percent, for the "what would the N% rule give" tile
  equity: number;      // percent of the portfolio at retirement in the S&P 500; Treasuries hold whatever it and the annuity leave
  annuity: number;     // percent of the portfolio at retirement spent on a life annuity, out of pre-tax (buyAnnuity)
  annuityKind: AnnuityKind;
  costs: number;       // annual, today's dollars; keeps up with inflation
  fixedMonthly: number; // payments fixed in dollars, like a mortgage: the same dollar amount every month until fixedEndAge, so inflation shrinks them
  fixedEndAge: number;  // age the fixed payments stop (the payoff)
  addlIncome: number;  // annual, today's dollars
  ssMonthly: number;   // household, today's dollars; derived from ssLevel unless 'custom'
  ssStartAge: number;  // claiming age; the benefit scales with it
  ssLevel: SsLevel;
  filing: Filing;
  stateRate: number;   // percent
  endAge: number;
  drawOrder: DrawOrder; // which tax bucket each year's withdrawal comes from
  ladder: LadderMode;   // Roth conversion ladder from retirement until social security starts; 'off' by default
  ladderAmount: number; // annual conversion for ladder 'amount', today's dollars
}
export type SsLevel = 'none' | 'low' | 'average' | 'high' | 'max' | 'custom';
/** Per-person monthly benefit at full retirement age (67), today's dollars, rough 2025 figures. */
export const SS_LEVELS: Record<Exclude<SsLevel, 'custom'>, { label: string; each: number; note: string }> = {
  none: { label: 'None', each: 0, note: 'Plan without social security at all.' },
  low: { label: 'Low earners', each: 1200, note: 'A full career (35+ years) at $25k to $35k a year. About the floor for someone who worked full time all their adult life; the formula pays 90% of the first $1,226 of monthly earnings, so even low wages earn a benefit.' },
  average: { label: 'Average earners', each: 2000, note: 'The 2025 average retired-worker benefit. A median-wage career (about $60k) lands here.' },
  high: { label: 'High earners', each: 3000, note: 'A career averaging about $120k a year.' },
  max: { label: 'Maximum', each: 4000, note: 'Thirty-five years at or above the taxable maximum ($176k in 2025).' },
};
/** Benefit as a share of the full-retirement-age amount, by claiming age (born 1960 or later). */
export const SS_CLAIM_FACTOR: Record<number, number> = { 62: 0.7, 63: 0.75, 64: 0.8, 65: 0.8667, 66: 0.9333, 67: 1, 68: 1.08, 69: 1.16, 70: 1.24 };
export function ssMonthlyFor(level: SsLevel, claimAge: number, filing: Filing): number {
  if (level === 'custom') return NaN;
  const people = filing === 'married' ? 2 : 1;
  const factor = SS_CLAIM_FACTOR[Math.min(70, Math.max(62, Math.round(claimAge)))] ?? 1;
  return Math.round(SS_LEVELS[level].each * people * factor / 10) * 10;
}
/** Keep ssMonthly in step with the preset, claiming age and filing status. */
export function syncSocialSecurity(r: RetireSettings): void {
  if (r.ssLevel !== 'custom') r.ssMonthly = ssMonthlyFor(r.ssLevel, r.ssStartAge, r.filing);
}
/** Treasuries' share of the portfolio at retirement, percent: whatever the S&P 500 and the annuity leave. */
export const treasuriesShare = (r: RetireSettings): number => Math.max(0, 100 - r.equity - r.annuity);

/**
 * Set the annuity share; it comes out of Treasuries first, then the S&P 500,
 * so the three still add up to 100. `equityBefore` is the S&P 500 share when
 * the edit began: measuring every keystroke from it means a typed 100 then
 * backspaced to 10 hands the S&P 500 its share back.
 */
export function setAnnuityShare(r: RetireSettings, pct: number, equityBefore = r.equity): void {
  r.annuity = pct;
  if (Number.isFinite(pct)) r.equity = Math.max(0, Math.min(equityBefore, 100 - pct));
}

/**
 * Kinds of account you can type in by hand. The kind sets the tax bucket, and
 * its accountType is what isEmployerPlan reads for the employer match and the
 * rule of 55. cagr is the growth a new account of that kind starts with.
 */
export const ACCOUNT_KINDS = {
  '401k': { name: '401(k)', label: '401(k) / 403(b)', bucket: 'pretax', accountType: '401K', note: 'Through your job, taxed as income when you take it out' },
  roth401k: { name: 'Roth 401(k)', label: 'Roth 401(k)', bucket: 'roth', accountType: 'Roth 401K', note: 'Through your job, tax free when you take it out' },
  ira: { name: 'Traditional IRA', label: 'Traditional IRA', bucket: 'pretax', accountType: 'IRA', note: 'Your own, taxed as income when you take it out' },
  rothIra: { name: 'Roth IRA', label: 'Roth IRA', bucket: 'roth', accountType: 'Roth IRA', note: 'Your own, tax free when you take it out' },
  brokerage: { name: 'Brokerage', label: 'Brokerage', bucket: 'taxable', accountType: 'Brokerage', note: 'Any time, gains taxed at capital gains rates' },
  savings: { name: 'Savings', label: 'Savings', bucket: 'taxable', accountType: 'Savings', note: 'Cash, starts at 4% growth', cagr: 4 },
} as const satisfies Record<string, { name: string; label: string; bucket: TaxBucket; accountType: string; note: string; cagr?: number }>;
export type AccountKind = keyof typeof ACCOUNT_KINDS;
/** The kind the setup sheet uses for each bucket's one account. */
const BUCKET_KIND: Record<TaxBucket, AccountKind> = { pretax: '401k', roth: 'rothIra', taxable: 'brokerage' };

/** An account typed in by hand. basis is what was put in; unset means all of the balance (no gain yet). */
export interface EnteredAccount { id: string; name: string; kind: AccountKind; balance: number; basis?: number }

export type DrawOrder = 'fill-12' | 'fill-22' | 'taxable-first' | 'pretax-first' | 'roth-first' | 'proportional';
const DRAW_ORDER_KEYS: DrawOrder[] = ['fill-12', 'fill-22', 'taxable-first', 'pretax-first', 'roth-first', 'proportional'];
export interface Settings {
  currentAge: number;
  retireAge: number;
  inflation: number;   // percent
  defaultCagr: number; // percent
  showReal: boolean;
  accounts: Record<string, Partial<AccountSettings>>; // keyed by account name, for file and typed accounts alike
  entered: EnteredAccount[];  // accounts typed in by hand, in the order added
  bundledHoldings: boolean;   // plan over the bundled holdings file; a loaded CSV replaces it either way
  retire: RetireSettings;
}

const KEY = 'retirement-planner-v3';
const CSV_KEY = 'retirement-planner-csv';

// Built-in fallbacks; src/data/defaults.json (an Export from the UI) is layered on top.
const BASE: Settings = {
  currentAge: 40,
  retireAge: 65,
  inflation: 3,
  defaultCagr: 9,
  showReal: false,
  accounts: {},
  entered: [],
  bundledHoldings: true,
  retire: {
    swr: 4, equity: 100, costs: 80000, addlIncome: 0, ssMonthly: 2400, ssStartAge: 67, ssLevel: 'low',
    filing: 'married', stateRate: 0, endAge: 95, drawOrder: 'fill-12', ladder: 'off', ladderAmount: 30000,
    annuity: 0, annuityKind: 'level', fixedMonthly: 0, fixedEndAge: 95,
  },
};

function merge(base: Settings, p: Partial<Settings>): Settings {
  const out: Settings = { ...structuredClone(base), ...p, retire: { ...base.retire, ...(p.retire ?? {}) }, accounts: { ...(p.accounts ?? {}) } };
  // An older export carries an amount but no level: keep the amount as custom,
  // unless it is the old default of $4,200, which nobody chose.
  if (p.retire && p.retire.ssMonthly !== undefined && p.retire.ssLevel === undefined) out.retire.ssLevel = p.retire.ssMonthly === 4200 ? 'low' : 'custom';
  // Retired presets (equal thirds, Roth last) fall back to the recommended strategy.
  if (!DRAW_ORDER_KEYS.includes(out.retire.drawOrder)) out.retire.drawOrder = 'fill-12';
  if (!(out.retire.ladder in LADDER_MODES)) out.retire.ladder = 'off';
  if (typeof out.retire.ladderAmount !== 'number' || !Number.isFinite(out.retire.ladderAmount) || out.retire.ladderAmount < 0) out.retire.ladderAmount = 0;
  if (!(out.retire.annuityKind in ANNUITY_KINDS)) out.retire.annuityKind = 'level';
  if (typeof out.retire.annuity !== 'number' || !Number.isFinite(out.retire.annuity)) out.retire.annuity = 0;
  out.entered = cleanEntered(out.entered);
  if (typeof out.bundledHoldings !== 'boolean') out.bundledHoldings = base.bundledHoldings;
  syncSocialSecurity(out.retire);
  return out;
}

// Typed accounts from a file or storage: drops anything malformed and any repeated id or name.
function cleanEntered(raw: unknown): EnteredAccount[] {
  if (!Array.isArray(raw)) return [];
  const out: EnteredAccount[] = [];
  for (const x of raw as Partial<EnteredAccount>[]) {
    if (typeof x !== 'object' || x === null) continue;
    const { id, name, kind, balance, basis } = x;
    if (typeof id !== 'string' || typeof name !== 'string' || !name.trim() || typeof kind !== 'string' || !Object.hasOwn(ACCOUNT_KINDS, kind)) continue;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) continue;
    if (out.some((e) => e.id === id || e.name === name)) continue;
    out.push({ id, name, kind, balance, ...(typeof basis === 'number' && Number.isFinite(basis) ? { basis } : {}) });
  }
  return out;
}

const { app: _app, exported: _exported, ...fileOverrides } = shippedDefaults as unknown as Partial<Settings> & { app?: string; exported?: string };
export const DEFAULTS: Settings = merge(BASE, fileOverrides);

/** Merge a parsed settings object over the defaults; returns null when it is not a settings object. */
export function fromJson(raw: string): Settings | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Partial<Settings>;
    if (typeof p.currentAge !== 'number' && typeof p.retire !== 'object') return null;
    return merge(DEFAULTS, p);
  } catch {
    return null;
  }
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return (raw && fromJson(raw)) || structuredClone(DEFAULTS);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings: Settings = load();

/** Every user input as a JSON file body, re-importable with importSettings. */
export function exportSettings(): string {
  return JSON.stringify({ app: 'retirement-planner', exported: new Date().toISOString().slice(0, 10), ...settings }, null, 2);
}

/** Replace the live settings in place (every module holds the same object). */
export function importSettings(raw: string): boolean {
  const next = fromJson(raw);
  if (!next) return false;
  for (const k of Object.keys(settings) as (keyof Settings)[]) delete (settings as unknown as Record<string, unknown>)[k];
  Object.assign(settings, next);
  refreshAccounts();
  save();
  return true;
}

export function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export function accountSettings(a: Account): AccountSettings {
  const s = settings.accounts[a.name] ?? {};
  return { contribution: s.contribution ?? 0, cagr: s.cagr ?? settings.defaultCagr,
    salary: s.salary ?? 0, matchPct: s.matchPct ?? 0, matchUpToPct: s.matchUpToPct ?? 0 };
}

export function setAccountSetting(a: Account, patch: Partial<AccountSettings>): void {
  settings.accounts[a.name] = { ...(settings.accounts[a.name] ?? {}), ...patch };
}

/**
 * Inputs that make the plan meaningless: values out of range and ages out of
 * order. The one set of bounds for every entry point: tabs show these messages
 * instead of results, chat what-ifs return them as a tool error, and
 * apply_scenario refuses. An empty list means the plan can be evaluated.
 * Ages must be whole because they index the simulation's year arrays.
 */
export function inputProblems(s: Settings): string[] {
  const r = s.retire;
  const out: string[] = [];
  const wholeIn = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  const within = (v: number, lo: number, hi: number): boolean => Number.isFinite(v) && v >= lo && v <= hi;
  const atLeast0 = (v: number): boolean => within(v, 0, Number.MAX_VALUE);
  const [cagrLo, cagrHi] = CAGR_RANGE;
  if (!wholeIn(s.currentAge, 15, 100)) out.push('Current age must be a whole number from 15 to 100.');
  else if (!wholeIn(s.retireAge, s.currentAge, 100)) out.push(`Retirement age must be a whole number from your current age (${s.currentAge}) to 100.${s.retireAge < s.currentAge ? ` Already retired? Set it to ${s.currentAge}.` : ''}`);
  else if (!wholeIn(r.endAge, s.retireAge + 1, 120)) out.push(`Plan to age must be a whole number after the retirement age (${s.retireAge}), up to 120.`);
  else if (r.endAge - s.retireAge > REAL_EQUITY.length) out.push(`A ${r.endAge - s.retireAge}-year retirement is longer than the ${REAL_EQUITY.length} years of market history, so no historical sequence can test it. Plan to age ${s.retireAge + REAL_EQUITY.length} at most.`);
  if (!atLeast0(r.costs)) out.push('Variable expenses cannot be negative.');
  if (!atLeast0(r.fixedMonthly)) out.push('Fixed expenses cannot be negative.');
  if (!wholeIn(r.fixedEndAge, 0, 120)) out.push('Paid off at must be a whole number from 0 to 120.');
  // A negative S&P 500 share only comes from typing a Treasuries share bigger than the annuity leaves.
  if (r.equity < 0 && within(r.annuity, 0, 100)) out.push(`Treasuries (${100 - r.annuity - r.equity}%) and annuity (${r.annuity}%) add up to more than 100%.`);
  else if (!within(r.equity, 0, 100)) out.push('S&P 500 must be between 0% and 100%.');
  if (!within(r.annuity, 0, 100)) out.push('Annuity must be between 0% and 100%.');
  else if (within(r.equity, 0, 100) && r.equity + r.annuity > 100 + 1e-9) out.push(`S&P 500 (${r.equity}%) and annuity (${r.annuity}%) add up to more than 100%.`);
  if (!atLeast0(r.ssMonthly)) out.push('Social security cannot be negative.');
  if (!within(r.ssStartAge, 62, 70)) out.push('Social security can be claimed from 62 to 70.');
  if (!atLeast0(r.addlIncome)) out.push('Other income cannot be negative.');
  if (r.filing !== 'single' && r.filing !== 'married') out.push(`Filing must be Single or Married joint, not "${String(r.filing)}".`);
  if (!within(r.stateRate, 0, 20)) out.push('State tax must be between 0% and 20%.');
  if (!within(r.swr, 0, 20)) out.push('Rule-of-thumb rate must be between 0% and 20%.');
  if (!atLeast0(r.ladderAmount)) out.push('Roth conversion amount cannot be negative.');
  if (!within(s.inflation, -5, 20)) out.push('Inflation must be between -5% and 20%.');
  if (!within(s.defaultCagr, cagrLo, cagrHi)) out.push(`Default CAGR must be between ${cagrLo}% and ${cagrHi}%.`);
  for (const a of accounts) {
    const x = s.accounts[a.name] ?? {};
    if (a.value < 0) out.push(a.entered ? `${a.name}: balance cannot be negative.` : `${a.name}: the balance from your holdings file is negative.`);
    if (a.entered && a.costBasis < 0) out.push(`${a.name}: basis cannot be negative.`);
    if (x.contribution !== undefined && !atLeast0(x.contribution)) out.push(`${a.name}: contribution cannot be negative.`);
    if (x.cagr !== undefined && !within(x.cagr, cagrLo, cagrHi)) out.push(`${a.name}: CAGR must be between ${cagrLo}% and ${cagrHi}%.`);
    if (x.salary !== undefined && !atLeast0(x.salary)) out.push(`${a.name}: salary cannot be negative.`);
    if (x.matchPct !== undefined && !within(x.matchPct, 0, 200)) out.push(`${a.name}: employer match must be between 0% and 200% of contributions.`);
    if (x.matchUpToPct !== undefined && !within(x.matchUpToPct, 0, 100)) out.push(`${a.name}: match limit must be between 0% and 100% of salary.`);
  }
  return out;
}

export const yearsToRetire = (): number => Math.max(0, settings.retireAge - settings.currentAge);

// Holdings: a loaded CSV, else the bundled file unless setup turned it off.
// Accounts: the holdings rolled up, then the typed ones in the order added.
let uploadedCsv: string | null = null;
try { uploadedCsv = localStorage.getItem(CSV_KEY); } catch { /* ignore */ }

export let holdings: Holding[] = [];
export let accounts: Account[] = [];
export let csvSource: 'bundled' | 'uploaded' | 'none' = 'bundled';

/** Rebuild holdings and accounts after the CSV, settings.bundledHoldings or settings.entered change. */
export function refreshAccounts(): void {
  csvSource = uploadedCsv !== null ? 'uploaded' : settings.bundledHoldings ? 'bundled' : 'none';
  holdings = parseHoldings(uploadedCsv ?? (settings.bundledHoldings ? bundledCsv : ''));
  accounts = [...rollupAccounts(holdings), ...settings.entered.map(enteredAccount)];
}
refreshAccounts();

/** True while the plan shows the shipped sample (never in a build pointed at a real export). */
export const isSample = (): boolean => __SAMPLE_DATA__ && csvSource === 'bundled';

function enteredAccount(e: EnteredAccount): Account {
  const k = ACCOUNT_KINDS[e.kind];
  const basis = e.basis ?? e.balance;
  return { name: e.name, broker: '', accountType: k.accountType, bucket: k.bucket, value: e.balance, costBasis: basis, gain: e.balance - basis, holdings: [], entered: e.id };
}

/** Stop planning over the bundled holdings file. Typed accounts stay; the file accounts' settings go with them. */
export function dropBundled(): void {
  if (csvSource === 'bundled') for (const a of accounts) if (!a.entered) delete settings.accounts[a.name];
  settings.bundledHoldings = false;
  refreshAccounts();
}

/** Load a CSV's text, or null to drop it (back to the bundled file unless setup turned that off). Returns the number of holdings read. */
export function loadCsv(text: string | null): number {
  uploadedCsv = text;
  try {
    if (text === null) localStorage.removeItem(CSV_KEY); else localStorage.setItem(CSV_KEY, text);
  } catch { /* ignore */ }
  refreshAccounts();
  return holdings.length;
}

/** `base`, or `base 2`, `base 3`... whichever no other account uses. */
function uniqueName(base: string, except?: string): string {
  const taken = (n: string): boolean => accounts.some((a) => a.name === n && (except === undefined || a.entered !== except));
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}

/** Add a typed account of `kind` with a zero balance; returns it. */
export function addAccount(kind: AccountKind): EnteredAccount {
  const k: { name: string; cagr?: number } = ACCOUNT_KINDS[kind];
  const id = `e${Math.max(0, ...settings.entered.map((e) => Number(e.id.slice(1)) || 0)) + 1}`;
  const e: EnteredAccount = { id, name: uniqueName(k.name), kind, balance: 0 };
  settings.entered.push(e);
  if (k.cagr !== undefined) settings.accounts[e.name] = { cagr: k.cagr };
  refreshAccounts();
  return e;
}

export function updateAccount(id: string, patch: Partial<Pick<EnteredAccount, 'kind' | 'balance' | 'basis'>>): void {
  const e = settings.entered.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, patch);
  refreshAccounts();
}

/** Rename a typed account, carrying its per-account settings over. A blank name keeps the old one; a taken one gets a number. */
export function renameAccount(id: string, name: string): void {
  const e = settings.entered.find((x) => x.id === id);
  const next = name.trim();
  if (!e || !next || next === e.name) return;
  const final = uniqueName(next, id);
  const s = settings.accounts[e.name];
  delete settings.accounts[e.name];
  if (s) settings.accounts[final] = s;
  e.name = final;
  refreshAccounts();
}

export function removeAccount(id: string): void {
  const e = settings.entered.find((x) => x.id === id);
  if (!e) return;
  settings.entered = settings.entered.filter((x) => x !== e);
  delete settings.accounts[e.name];
  refreshAccounts();
}

/** The setup sheet's answers. Money is today's dollars; saved and adding are per tax bucket. */
export interface SetupAnswers {
  currentAge: number;
  retireAge: number;
  filing: Filing;
  saved: Record<TaxBucket, number>;
  adding: Record<TaxBucket, number>;  // per year
  spendingMonthly: number;
  fixedMonthly: number;
  fixedEndAge: number;
  ssLevel: Exclude<SsLevel, 'custom'>;
}

/**
 * Replace the plan with the setup sheet's answers: one typed account per tax
 * bucket that holds or receives money, no holdings file, every other input
 * back to its default.
 */
export function applySetup(a: SetupAnswers): void {
  const entered: EnteredAccount[] = [];
  const perAccount: Settings['accounts'] = {};
  for (const b of BUCKETS) {
    if (a.saved[b] <= 0 && a.adding[b] <= 0) continue;
    const kind = BUCKET_KIND[b];
    const name = ACCOUNT_KINDS[kind].name;
    entered.push({ id: `e${entered.length + 1}`, name, kind, balance: a.saved[b] });
    perAccount[name] = { contribution: a.adding[b] };
  }
  loadCsv(null);
  importSettings(JSON.stringify({
    ...DEFAULTS, currentAge: a.currentAge, retireAge: a.retireAge, accounts: perAccount, entered, bundledHoldings: false,
    retire: { ...DEFAULTS.retire, filing: a.filing, costs: a.spendingMonthly * 12, fixedMonthly: a.fixedMonthly, fixedEndAge: a.fixedEndAge, ssLevel: a.ssLevel },
  }));
}
