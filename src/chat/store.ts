// Chat state that lives in this browser only: OpenRouter key and model, the
// transcript, and the scenario currently ghosted onto the Retirement chart.

import type { Overrides } from '../plan';

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ToolRecord extends ToolCall { result: string; card?: Card }

export type Card =
  | { type: 'scenario'; label: string; overrides: Overrides; base: Metrics; scenario: Metrics }
  | { type: 'sweep'; label: string; input: string; points: { value: number; overrides: Overrides; metrics: Metrics }[] }
  | { type: 'sequence'; startYear: number; ages: number[]; balances: number[]; depletedAt: number | null }
  | { type: 'table'; title: string; headers: string[]; rows: (string | number)[][] };

export interface Metrics {
  retireAge: number; endAge: number; portfolioReal: number; successRate: number; failures: number; runs: number;
  medianEnding: number; firstYearGross: number; firstYearTax: number; withdrawalRate: number; worstEnding: number; worstYear: number | null;
  medianPath: number[];
  lifetimeTax: number; lifetimeWithdrawals: number; lifetimeSocialSecurity: number; lifetimeRothConversions: number;   // over the median-return path
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  thinkMs?: number;
  textAfterTools?: boolean;   // transient: was the current text started after the last tool round
  tools?: ToolRecord[];
  error?: string;
}

/** OpenAI-style wire messages, kept alongside the transcript so a reload can continue the conversation. */
export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatConfig { apiKey: string; model: string; reasoning: boolean }
export interface Ghost { label: string; overrides: Overrides }

const CFG_KEY = 'retirement-planner-chat-config';
const LOG_KEY = 'retirement-planner-chat-log';
const GHOST_KEY = 'retirement-planner-ghost';

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export const config: ChatConfig = { apiKey: '', model: DEFAULT_MODEL, reasoning: false, ...read<Partial<ChatConfig>>(CFG_KEY, {}) };
export function saveConfig(): void { write(CFG_KEY, config); }

/** Spend and size of this conversation, from OpenRouter's usage chunks. `context` is the last request's prompt size. */
export interface Spend { cost: number; prompt: number; completion: number; context: number }
const EMPTY_SPEND: Spend = { cost: 0, prompt: 0, completion: 0, context: 0 };

const saved = read<Partial<{ turns: Turn[]; wire: WireMessage[]; spend: Spend }>>(LOG_KEY, {});
export const log: { turns: Turn[]; wire: WireMessage[]; spend: Spend } = { turns: saved.turns ?? [], wire: saved.wire ?? [], spend: saved.spend ?? { ...EMPTY_SPEND } };
export function saveLog(): void { write(LOG_KEY, log); }
export function clearLog(): void { log.turns = []; log.wire = []; log.spend = { ...EMPTY_SPEND }; saveLog(); }

// One ghost at a time: setting a new one replaces the old. Views that show
// ghost state (the chat's Show on chart buttons) subscribe with onGhostChange,
// so a change from anywhere (a card, the model, the Retirement chip's ×) reaches them.
export let ghost: Ghost | null = read<Ghost | null>(GHOST_KEY, null);
const ghostListeners = new Set<() => void>();
export function setGhost(g: Ghost | null): void { ghost = g; write(GHOST_KEY, g); for (const fn of ghostListeners) fn(); }
export function onGhostChange(fn: () => void): () => void { ghostListeners.add(fn); return () => ghostListeners.delete(fn); }

/**
 * Evaluate the current ghost with `evaluate` (evaluateWith). A ghost that does not evaluate against the live plan
 * (its inputs clash with a live edit, or an older build saved it) is kept but returned as a problem, so the chart
 * skips it instead of blanking, and it draws again once the plan allows it.
 */
export function evaluateGhost<T>(evaluate: (o: Overrides) => T): { ghost: Ghost; plan: T } | { ghost: Ghost; problem: string } | null {
  if (!ghost) return null;
  try { return { ghost, plan: evaluate(ghost.overrides) }; } catch (e) { return { ghost, problem: e instanceof Error ? e.message : String(e) }; }
}

/** JSON with sorted keys, so overrides built in different key orders compare equal. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/** Is this scenario the one on the chart? Matches on inputs alone, so a sweep row, a scenario card and a show_on_chart card for the same inputs all read "Shown on chart". */
export function isGhost(overrides: Overrides): boolean { return !!ghost && canonical(ghost.overrides) === canonical(overrides); }

/** A question queued by an "ask" link on another tab; consumed when the Chat tab opens. */
export let pendingPrompt: string | null = null;
export function queuePrompt(p: string | null): void { pendingPrompt = p; }
