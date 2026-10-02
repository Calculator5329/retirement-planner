// Persistent user inputs (localStorage) plus the derived data every tab reads.

import { parseHoldings, rollupAccounts, type Account, type Holding } from './holdings';
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

export type DrawOrder = 'fill-12' | 'fill-22' | 'taxable-first' | 'pretax-first' | 'roth-first' | 'proportional';
const DRAW_ORDER_KEYS: DrawOrder[] = ['fill-12', 'fill-22', 'taxable-first', 'pretax-first', 'roth-first', 'proportional'];
export interface Settings {
  currentAge: number;
  retireAge: number;
  inflation: number;   // percent
  defaultCagr: number; // percent
  showReal: boolean;
  accounts: Record<string, Partial<AccountSettings>>;
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
  syncSocialSecurity(out.retire);
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
    if (a.value < 0) out.push(`${a.name}: the balance from your holdings file is negative.`);
    if (x.contribution !== undefined && !atLeast0(x.contribution)) out.push(`${a.name}: contribution cannot be negative.`);
    if (x.cagr !== undefined && !within(x.cagr, cagrLo, cagrHi)) out.push(`${a.name}: CAGR must be between ${cagrLo}% and ${cagrHi}%.`);
    if (x.salary !== undefined && !atLeast0(x.salary)) out.push(`${a.name}: salary cannot be negative.`);
    if (x.matchPct !== undefined && !within(x.matchPct, 0, 200)) out.push(`${a.name}: employer match must be between 0% and 200% of contributions.`);
    if (x.matchUpToPct !== undefined && !within(x.matchUpToPct, 0, 100)) out.push(`${a.name}: match limit must be between 0% and 100% of salary.`);
  }
  return out;
}

export const yearsToRetire = (): number => Math.max(0, settings.retireAge - settings.currentAge);

// Holdings: bundled CSV unless the user loaded their own.
let csvText = bundledCsv;
try { csvText = localStorage.getItem(CSV_KEY) ?? bundledCsv; } catch { /* ignore */ }

export let holdings: Holding[] = parseHoldings(csvText);
export let accounts: Account[] = rollupAccounts(holdings);
export let csvSource: 'bundled' | 'uploaded' = csvText === bundledCsv ? 'bundled' : 'uploaded';

export function loadCsv(text: string | null): number {
  csvText = text ?? bundledCsv;
  csvSource = text === null ? 'bundled' : 'uploaded';
  try {
    if (text === null) localStorage.removeItem(CSV_KEY); else localStorage.setItem(CSV_KEY, text);
  } catch { /* ignore */ }
  holdings = parseHoldings(csvText);
  accounts = rollupAccounts(holdings);
  return holdings.length;
}
