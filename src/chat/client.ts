// Streaming OpenRouter client (OpenAI-compatible chat completions) with a
// tool loop. The model never sees a number it did not get from a tool.

import type { ToolCall, WireMessage } from './store';

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface StreamEvents {
  onText: (delta: string) => void;
  onReasoning: (delta: string) => void;
  onToolCall: (call: ToolCall) => Promise<string>;  // returns the tool result to feed back
  onUsage?: (u: Usage) => void;                     // once per request, from OpenRouter's final chunk
}

export interface Usage { prompt: number; completion: number; cost: number }

export interface ClientOpts { apiKey: string; model: string; reasoning: boolean; signal?: AbortSignal; maxTokens?: number }

const URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ROUNDS = 8;

interface Delta { content?: string | null; reasoning?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }

/** Runs the conversation until the model stops calling tools. Mutates `wire` in place. */
export async function complete(wire: WireMessage[], tools: ToolSpec[], o: ClientOpts, ev_: StreamEvents): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = JSON.stringify({
      model: o.model, stream: true, messages: wire, usage: { include: true },
      // Explicit cap: OpenRouter otherwise reserves the model's full output window against the key's remaining credit.
      max_tokens: o.maxTokens ?? 4000,
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      ...(o.reasoning ? { reasoning: { effort: 'low' } } : {}),
    });
    const res = await fetchWithRetry(body, o);

    let content = '';
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const ev of sse(res.body!)) {
      if (ev.usage) ev_.onUsage?.(ev.usage);
      const delta = ev.delta;
      if (!delta) continue;
      if (delta.reasoning) ev_.onReasoning(delta.reasoning);
      if (delta.content) { content += delta.content; ev_.onText(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
    const made = calls.filter((c) => c.name);
    wire.push({ role: 'assistant', content: content || null,
      ...(made.length ? { tool_calls: made.map((c) => ({ id: c.id || c.name, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) } : {}) });
    if (!made.length) return;
    for (const c of made) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.args || '{}') as Record<string, unknown>; } catch { /* model sent bad JSON; tool gets {} */ }
      const result = await ev_.onToolCall({ id: c.id || c.name, name: c.name, args });
      wire.push({ role: 'tool', tool_call_id: c.id || c.name, content: result });
    }
  }
  throw new Error('The model kept calling tools without answering. Try rephrasing.');
}

/** Rate limits, upstream errors and network drops get three tries with backoff. Client errors do not. */
async function fetchWithRetry(body: string, o: ClientOpts): Promise<Response> {
  let lastError = 'request failed';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(URL, {
        method: 'POST', signal: o.signal, body,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}`, 'HTTP-Referer': location.origin, 'X-Title': 'Retirement Planner' },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (res.ok && res.body) return res;
    lastError = await errorText(res);
    if (res.status === 429 || res.status >= 500) continue;
    throw new Error(lastError);
  }
  throw new Error(lastError);
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j.error?.message ?? `${res.status} ${res.statusText}`;
  } catch { return `${res.status} ${res.statusText}`; }
}

interface RawUsage { prompt_tokens?: number; completion_tokens?: number; cost?: number }

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ delta?: Delta; usage?: Usage }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;   // comments like ": OPENROUTER PROCESSING"
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: Delta }[]; usage?: RawUsage; error?: { message?: string } };
        if (j.error?.message) throw new Error(j.error.message);
        const d = j.choices?.[0]?.delta;
        if (d) yield { delta: d };
        if (j.usage) yield { usage: { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0, cost: j.usage.cost ?? 0 } };
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
  }
}

/** Models OpenRouter says support tool calling, for the picker. Fails quietly. */
export async function listToolModels(): Promise<{ id: string; name: string; prompt: number; completion: number }[]> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const j = (await res.json()) as { data?: { id: string; name: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }[] };
    return (j.data ?? [])
      .filter((m) => m.supported_parameters?.includes('tools'))
      .map((m) => ({ id: m.id, name: m.name, prompt: Number(m.pricing?.prompt ?? 0) * 1e6, completion: Number(m.pricing?.completion ?? 0) * 1e6 }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch { return []; }
}
