// Chat tab: a full-height conversation with the plan. Text streams in,
// reasoning collapses, tool calls show as steps, and tool results render as
// cards (scenario, sweep, sequence) built from the numbers, never from prose.

import { save, settings } from '../state';
import { projectAccounts } from '../projection';
import { complete, listToolModels, type Usage } from '../chat/client';
import { markdown } from '../chat/markdown';
import { clearLog, config, DEFAULT_MODEL, isGhost, log, onGhostChange, pendingPrompt, queuePrompt, saveConfig, saveLog, setGhost, type Card, type Metrics, type ToolRecord, type Turn, type WireMessage } from '../chat/store';
import { runTool, sweepLabel, systemPrompt, TOOLS } from '../chat/tools';
import { lineChart } from '../chart';
import { h } from '../dom';
import { pct, usd, usdK } from '../format';
import { applyChecked, describeOverrides, planProblems, type Overrides } from '../plan';

const SUGGESTIONS: { title: string; q: string }[] = [
  { title: 'Weakest link', q: 'How does my plan look? What is the weakest part?' },
  { title: 'A bad start year', q: 'Show me what retiring in 1966 would have looked like.' },
  { title: 'Max the accounts', q: 'What happens if I max the Roth at $7,000 a year and the 401(k) at $23,500?' },
  { title: 'First-year taxes', q: 'How much tax do I pay in the first year and why?' },
  { title: 'Two plans, one table', q: 'Compare retiring at 58 with retiring at 62: at each spending level from $60k to $100k, what is the success rate of each?' },
  { title: 'Spending ceiling', q: 'What is the most I can spend each year and still keep a 90% success rate?' },
  { title: 'Claim early or late', q: 'Does claiming social security at 62 or at 70 give the better outcome, and how much does it change my first-year tax?' },
  { title: 'Which draw order', q: 'Which withdrawal order pays the least lifetime tax: taxable first, pre-tax first, or proportional?' },
];

const PRESETS: { label: string; match: RegExp; fallback: string }[] = [
  { label: 'Luna', match: /gpt-5\.6-luna|luna/i, fallback: 'openai/gpt-5.6-luna' },
  { label: 'Opus 5', match: /claude-opus-5(?!\.)|opus-5$/i, fallback: 'anthropic/claude-opus-5' },
];

const TOOL_VERBS: Record<string, string> = {
  get_state: 'Read the plan', get_holdings: 'Read holdings', get_first_year: 'Read the first year', compare: 'Compared', solve: 'Solved', run_scenario: 'Ran scenario', sweep: 'Swept', get_sequence: 'Replayed', show_on_chart: 'Shown on chart', apply_scenario: 'Applied to plan',
};

let busy = false;
let abort: AbortController | null = null;
let models: { id: string; name: string; prompt: number; completion: number }[] = [];
let modelsLoaded = false;

const SEND_ICON = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor"/></svg>';

export function renderChat(rerender: () => void): HTMLElement {
  const root = h('div', { class: 'tab chat' });
  const thread = h('div', { class: 'thread' });
  const column = h('div', { class: 'thread-col' });
  thread.append(column);
  const composer = h('textarea', { class: 'composer', placeholder: 'Ask about the plan or try a what-if. Enter sends, Shift+Enter is a new line.', rows: '1', 'data-key': 'chat-composer' }) as HTMLTextAreaElement;
  const send = h('button', { class: 'send', type: 'button', title: 'Send (Enter)', 'aria-label': 'Send', disabled: '' });
  send.innerHTML = SEND_ICON;
  const stop = h('button', { class: 'send stop', type: 'button', title: 'Stop', 'aria-label': 'Stop', hidden: '' });
  stop.innerHTML = STOP_ICON;

  // Follow the stream only while the reader is already at the bottom.
  let pinned = true;
  thread.addEventListener('scroll', () => { pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; });
  const scroll = (force = false): void => { if (force || pinned) thread.scrollTop = thread.scrollHeight; };

  const grow = (): void => { composer.style.height = 'auto'; composer.style.height = `${Math.min(composer.scrollHeight, 220)}px`; send.toggleAttribute('disabled', !composer.value.trim()); };

  // Apply/ghost inside a card changes the plan; other tabs pick that up when
  // they next render. Here we only repaint the cards and keep the scroll spot.
  const repaint = (): void => {
    const top = thread.scrollTop;
    column.replaceChildren(...(log.turns.length ? log.turns.map((t) => turnView(t, repaint, resend)) : [emptyState((q) => { composer.value = q; grow(); void submit(); })]));
    thread.scrollTo({ top, behavior: 'instant' });   // the thread scrolls smoothly otherwise, which would animate back from the top
  };
  const paint = (): void => {
    repaint();
    requestAnimationFrame(() => scroll(true));   // the thread may not be attached yet
  };

  const resend = (): void => {
    // Retry after an error: drop the failed assistant turn and resend the user text.
    const last = log.turns[log.turns.length - 1];
    if (last?.role === 'assistant' && last.error) log.turns.pop();
    const user = log.turns[log.turns.length - 1];
    if (user?.role !== 'user') return;
    log.turns.pop();
    while (log.wire.length && log.wire[log.wire.length - 1]!.role !== 'system' && log.wire[log.wire.length - 1] !== undefined && (log.wire[log.wire.length - 1] as { content?: unknown }).content !== user.text) log.wire.pop();
    if (log.wire.length && (log.wire[log.wire.length - 1] as { content?: unknown }).content === user.text) log.wire.pop();
    composer.value = user.text; grow();
    void submit();
  };

  const submit = async (): Promise<void> => {
    const text = composer.value.trim();
    if (!text || busy) return;
    if (!config.apiKey) { flash('Add your OpenRouter key first (key button under the input).'); return; }
    const problems = planProblems();
    if (problems.length) { flash(`Fix the plan inputs first: ${problems[0]}`); return; }
    composer.value = ''; grow();
    busy = true; send.hidden = true; stop.hidden = false; pinned = true;
    abort = new AbortController();
    if (!log.wire.length) log.wire.push({ role: 'system', content: systemPrompt() });
    else log.wire[0] = { role: 'system', content: systemPrompt() };
    log.turns.push({ role: 'user', text });
    log.wire.push({ role: 'user', content: text });
    const turn: Turn = { role: 'assistant', text: '', tools: [] };
    log.turns.push(turn);
    paint();
    const lt = liveTurn(turn, repaint, resend);
    (column.lastElementChild as HTMLElement).replaceWith(lt.el);
    const refresh = (): void => { lt.update(); scroll(); };
    let thinkStart = 0;
    try {
      await complete(log.wire, TOOLS, { apiKey: config.apiKey, model: config.model, reasoning: config.reasoning, signal: abort.signal }, {
        onText: (d) => {
          if (thinkStart && !turn.thinkMs) turn.thinkMs = Date.now() - thinkStart;
          if (turn.text && !turn.text.endsWith('\n') && turn.tools?.length && turn.tools[turn.tools.length - 1]?.result && !turn.textAfterTools) { turn.text += '\n\n'; }
          if (turn.tools?.length) turn.textAfterTools = true;
          turn.text += d; refresh();
        },
        onReasoning: (d) => { thinkStart ||= Date.now(); turn.reasoning = (turn.reasoning ?? '') + d; refresh(); },
        onUsage: (u) => { addSpend(u); foot.sync(); },
        onToolCall: async (call) => {
          if (thinkStart && !turn.thinkMs) turn.thinkMs = Date.now() - thinkStart;
          const rec: ToolRecord = { ...call, result: '' };
          turn.tools!.push(rec);
          refresh();
          await new Promise((r) => setTimeout(r, 0));   // let the running state paint
          const out = runTool(call.name, call.args, { rerender: () => { /* other tabs pick it up on their next render */ } });
          rec.result = out.result; rec.card = out.card; turn.textAfterTools = false;
          refresh();
          return out.result;
        },
      });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) turn.error = e instanceof Error ? e.message : String(e);
      // Drop a dangling assistant/tool tail so the next request is well-formed.
      while (log.wire.length && log.wire[log.wire.length - 1]!.role !== 'user') log.wire.pop();
      if (!turn.text && !turn.tools?.length) { log.wire.pop(); }
    } finally {
      busy = false; send.hidden = false; stop.hidden = true; abort = null;
      saveLog();
      lt.finish();
      scroll();
      composer.focus();
    }
  };

  composer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } });
  composer.addEventListener('input', grow);
  send.addEventListener('click', () => void submit());
  stop.addEventListener('click', () => abort?.abort());

  const foot = composerFoot(() => { if (log.turns.length && !confirm('Start a new chat? This conversation will be cleared.')) return; abort?.abort(); clearLog(); paint(); foot.sync(); composer.focus(); });
  const box = h('div', { class: 'composer-box' }, composer, h('div', { class: 'composer-foot' }, foot.el, h('div', { class: 'composer-actions' }, send, stop)));
  box.addEventListener('click', (e) => { if (e.target === box) composer.focus(); });
  root.append(thread, h('div', { class: 'composer-row' }, box));
  paint();
  requestAnimationFrame(grow);   // measure once attached
  // The chat tab is built once and cached, so its ghost buttons follow every change in place:
  // a card click, show_on_chart mid-stream, or the Retirement chip's × while this tab is hidden.
  onGhostChange(() => syncGhostButtons(column));

  if (pendingPrompt) { composer.value = pendingPrompt; queuePrompt(null); grow(); queueMicrotask(() => void submit()); }
  return root;

  // One notice at a time: a repeat replaces the one showing.
  function flash(msg: string): void {
    column.querySelector(':scope > .flash')?.remove();
    const el = h('div', { class: 'flash' }, msg);
    column.append(el); scroll(true);
    setTimeout(() => el.remove(), 3500);
  }
}

function emptyState(pick: (q: string) => void): HTMLElement {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-title' }, 'Ask the plan anything'),
    h('div', { class: 'empty-sub' }, 'Every number comes from the same simulation the other tabs use. What-ifs show up as cards you can apply or ghost onto the Retirement chart.'),
    h('div', { class: 'suggestions' }, ...SUGGESTIONS.map((s) => h('button', { class: 'suggestion', type: 'button', onclick: () => pick(s.q) }, h('span', { class: 'suggestion-title' }, s.title), h('span', { class: 'suggestion-q' }, s.q)))));
}

function shortModel(id: string): string { return id.split('/').pop() ?? id; }

function addSpend(u: Usage): void {
  log.spend.cost += u.cost; log.spend.prompt += u.prompt; log.spend.completion += u.completion; log.spend.context = u.prompt + u.completion;
}

function fmtTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }
function fmtCost(c: number): string { return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`; }

/** Model, key, thinking, spend and New chat, all in the composer's bottom row. */
function composerFoot(onNew: () => void): { el: HTMLElement; sync: () => void } {
  // Model popover.
  const list = h('datalist', { id: 'model-list' });
  const model = h('input', { class: 'model', list: 'model-list', value: config.model, placeholder: DEFAULT_MODEL, 'data-key': 'or-model', spellcheck: 'false' }) as HTMLInputElement;
  model.addEventListener('change', () => { config.model = model.value.trim() || DEFAULT_MODEL; saveConfig(); sync(); });
  const price = h('div', { class: 'pop-note' });
  const presets = h('div', { class: 'presets' }, ...PRESETS.map((p) => h('button', { class: 'chip small', type: 'button', 'data-preset': p.fallback, onclick: () => {
    const hit = models.find((m) => m.id === p.fallback) ?? models.find((m) => p.match.test(m.id));
    config.model = hit?.id ?? p.fallback; model.value = config.model; saveConfig(); sync(); modelPop.open = false;
  } }, p.label)));
  const modelLabel = h('span', {});
  const modelPop = popover('model-pill', [modelLabel], [
    h('div', { class: 'pop-title' }, 'Model'),
    presets,
    model,
    price,
    h('div', { class: 'pop-note' }, 'Any OpenRouter model that supports tool calling. Prices are per 1M tokens.'),
  ]);

  // Key popover.
  const key = h('input', { type: 'password', class: 'key', placeholder: 'sk-or-…', value: config.apiKey, autocomplete: 'off', 'data-key': 'or-key' }) as HTMLInputElement;
  key.addEventListener('change', () => { config.apiKey = key.value.trim(); saveConfig(); loadModels(); sync(); });
  const keyLabel = h('span', {});
  const keyPop = popover('key-pill', [keyLabel], [
    h('div', { class: 'pop-title' }, 'OpenRouter key'),
    key,
    h('div', { class: 'pop-note' }, 'Stored only in this browser (localStorage). Requests go straight from here to OpenRouter.'),
  ]);

  // Thinking toggle.
  const think = h('button', { class: 'pill', type: 'button', title: 'Ask the model to reason first and show it', onclick: () => { config.reasoning = !config.reasoning; saveConfig(); sync(); } }, 'Thinking');

  const spend = h('span', { class: 'spend', title: 'Spend and context size for this conversation' });
  const fresh = h('button', { class: 'pill', type: 'button', onclick: onNew }, h('span', { class: 'plus' }, '+'), 'New chat');

  const sync = (): void => {
    price.textContent = priceOf(config.model);
    modelLabel.textContent = shortModel(config.model);
    keyLabel.textContent = config.apiKey ? 'Key' : 'Add key';
    keyPop.classList.toggle('warn', !config.apiKey);
    think.classList.toggle('active', config.reasoning);
    for (const b of presets.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.preset === config.model);
    const s = log.spend;
    spend.textContent = s.prompt + s.completion ? `${fmtCost(s.cost)} · ${fmtTokens(s.context)} context · ${fmtTokens(s.prompt + s.completion)} total` : '';
  };
  const fill = (): void => {
    list.replaceChildren(...models.map((m) => h('option', { value: m.id }, `${m.name} · $${m.prompt.toFixed(2)} / $${m.completion.toFixed(2)} per 1M`)));
    sync();
  };
  // The model list is only fetched once there is a key; without one the Chat tab makes no network calls.
  function loadModels(): void {
    if (modelsLoaded || !config.apiKey) return;
    modelsLoaded = true;
    void listToolModels().then((m) => { models = m; fill(); });
  }
  if (modelsLoaded) fill(); else loadModels();
  sync();
  return { el: h('div', { class: 'foot-left' }, modelPop, keyPop, think, fresh, spend, list), sync };
}

function popover(cls: string, summary: (Node | string)[], body: (Node | string)[]): HTMLDetailsElement {
  const d = h('details', { class: `pop ${cls}` }, h('summary', {}, ...summary), h('div', { class: 'pop-body' }, ...body)) as HTMLDetailsElement;
  document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target as Node)) d.open = false; });
  return d;
}

/**
 * "Ask" on a stat tile: a closeable modal that streams a short note, using
 * the same tools but its own throwaway conversation. Nothing is saved.
 */
export function askModal(question: string, rerender: () => void): void {
  document.querySelector('.ask-modal')?.remove();
  const body = h('div', { class: 'ask-body' });
  const close = h('button', { class: 'ask-close', type: 'button', 'aria-label': 'Close' }, '×');
  const modal = h('div', { class: 'ask-modal' }, h('div', { class: 'ask-panel' }, h('div', { class: 'ask-head' }, h('div', { class: 'ask-q' }, question), close), body));
  const ctrl = new AbortController();
  const shut = (): void => { ctrl.abort(); modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') shut(); };
  close.addEventListener('click', shut);
  modal.addEventListener('click', (e) => { if (e.target === modal) shut(); });
  document.addEventListener('keydown', onKey);
  document.body.append(modal);

  if (!config.apiKey) { body.append(h('div', { class: 'error' }, 'Add your OpenRouter key on the Chat tab first.')); return; }
  const problems = planProblems();
  if (problems.length) { body.append(h('div', { class: 'error' }, `Fix the plan inputs first: ${problems[0]}`)); return; }
  const turn: Turn = { role: 'assistant', text: '', tools: [] };
  const lt = liveTurn(turn, rerender, () => { /* no retry in the modal */ });
  body.append(lt.el);
  const refresh = (): void => lt.update();
  const wire: WireMessage[] = [
    { role: 'system', content: `${systemPrompt()}\n\nThis is a quick note, not a chat: answer in two to four short sentences. Call tools if you need a number.` },
    { role: 'user', content: question },
  ];
  void complete(wire, TOOLS, { apiKey: config.apiKey, model: config.model, reasoning: false, signal: ctrl.signal, maxTokens: 1200 }, {
    onText: (d) => { turn.text += d; refresh(); },
    onReasoning: (d) => { turn.reasoning = (turn.reasoning ?? '') + d; refresh(); },
    onUsage: (u) => { addSpend(u); },
    onToolCall: async (call) => {
      const rec: ToolRecord = { ...call, result: '' };
      turn.tools!.push(rec); refresh();
      await new Promise((r) => setTimeout(r, 0));
      const out = runTool(call.name, call.args, { rerender: () => { /* nothing to repaint here */ } });
      rec.result = out.result; rec.card = out.card; refresh();
      return out.result;
    },
  }).catch((e: unknown) => { if (!(e instanceof DOMException && e.name === 'AbortError')) turn.error = e instanceof Error ? e.message : String(e); })
    .finally(() => { saveLog(); lt.finish(); });
}

function priceOf(id: string): string {
  const m = models.find((x) => x.id === id);
  return m ? `$${m.prompt.toFixed(2)} in · $${m.completion.toFixed(2)} out per 1M tokens` : '';
}

function turnView(t: Turn, rerender: () => void, retry: () => void): HTMLElement {
  if (t.role === 'user') return h('div', { class: 'turn user' }, h('div', { class: 'bubble' }, t.text));
  const parts: (Node | null)[] = [];
  if (t.reasoning) {
    const secs = t.thinkMs ? `${Math.max(1, Math.round(t.thinkMs / 1000))}s` : '';
    parts.push(h('details', { class: 'thinking' },
      h('summary', {}, h('span', { class: 'shimmer' }, `Thought${secs ? ` for ${secs}` : ''}`)),
      h('div', { class: 'thinking-body' }, t.reasoning)));
  }
  (t.tools ?? []).forEach((tool, i, all) => {
    const running = !tool.result;
    const failed = tool.result.startsWith('{"error"');
    const stale = superseded(all, i);
    const status = running ? 'running' : failed ? 'failed' : 'done';
    parts.push(h('details', { class: `step ${status}${stale ? ' stale' : ''}` },
      h('summary', {},
        h('span', { class: 'step-icon' }, running ? '' : failed ? '!' : '✓'),
        h('span', { class: 'step-verb' }, running ? `${TOOL_VERBS[tool.name] ?? tool.name}…`.replace(/(Ran|Swept|Replayed|Applied|Read)(.*)…/, (_m, v: string, rest: string) => `${verbing(v)}${rest}`) : (TOOL_VERBS[tool.name] ?? tool.name)),
        h('span', { class: 'step-args' }, argsLabel(tool.args)),
        failed ? h('span', { class: 'step-note' }, 'the model is correcting the call') : stale ? h('span', { class: 'step-note stale-note' }, STALE_NOTE) : null),
      running ? null : h('pre', { class: 'step-raw' }, pretty(tool.result))));
    if (tool.card) parts.push(staleWrap(cardView(tool.card, rerender), stale));
  });
  if (t.text) parts.push(markdown(t.text));
  if (t.error) parts.push(h('div', { class: 'error' }, h('span', {}, t.error), h('button', { class: 'btn small', type: 'button', onclick: retry }, 'Retry')));
  return h('div', { class: 'turn assistant' }, h('div', { class: 'turn-body' }, ...parts));
}

/**
 * A streaming assistant turn that updates in place: the status line and
 * thinking summary change text, steps flip from running to done, skeletons
 * become cards with a fade-in, and the markdown body re-renders. Nothing is
 * rebuilt wholesale, so animations never restart mid-stream.
 */
interface LiveTurn { el: HTMLElement; update: () => void; finish: () => void }

function liveTurn(t: Turn, rerender: () => void, retry: () => void): LiveTurn {
  const body = h('div', { class: 'turn-body' });
  const el = h('div', { class: 'turn assistant live' }, body);
  let thinking: HTMLDetailsElement | null = null;
  let thinkSummary: HTMLElement | null = null;
  let thinkBody: HTMLElement | null = null;
  const steps: { el: HTMLElement; icon: HTMLElement; verb: HTMLElement; slot: HTMLElement; done: boolean; stale: boolean; since: number }[] = [];
  let md: HTMLElement | null = null;
  const statusText = h('span', { class: 'shimmer' });
  const status = h('div', { class: 'status' }, h('span', { class: 'spinner' }), statusText);
  body.append(status);
  let finished = false;

  const update = (): void => {
    if (t.reasoning && !thinking) {
      thinkSummary = h('span', { class: 'shimmer' });
      thinkBody = h('div', { class: 'thinking-body' });
      thinking = h('details', { class: 'thinking live' }, h('summary', {}, thinkSummary), thinkBody) as HTMLDetailsElement;
      body.insertBefore(thinking, status);
    }
    if (thinking && thinkBody && thinkSummary) {
      thinkBody.textContent = t.reasoning ?? '';
      const stillThinking = !finished && !t.text && !t.tools?.length;
      thinking.classList.toggle('live', stillThinking);
      const secs = t.thinkMs ? ` for ${Math.max(1, Math.round(t.thinkMs / 1000))}s` : '';
      thinkSummary.textContent = stillThinking ? 'Thinking' : `Thought${secs}`;
    }
    (t.tools ?? []).forEach((tool, i) => {
      let s = steps[i];
      if (!s) {
        const icon = h('span', { class: 'step-icon' });
        const verb = h('span', { class: 'step-verb' }, runningVerb(tool.name));
        const stepEl = h('details', { class: 'step running' }, h('summary', {}, icon, verb, h('span', { class: 'step-args' }, argsLabel(tool.args))));
        const slot = h('div', { class: 'card-slot' }, skeleton(tool.name, tool.args));
        s = { el: stepEl, icon, verb, slot, done: false, stale: false, since: performance.now() };
        steps.push(s);
        if (md) body.insertBefore(stepEl, md); else body.insertBefore(stepEl, status);
        if (md) body.insertBefore(slot, md); else body.insertBefore(slot, status);
      }
      if (tool.result && !s.done) {
        s.done = true;
        const failed = tool.result.startsWith('{"error"');
        s.el.className = `step ${failed ? 'failed' : 'done'}`;
        s.icon.textContent = failed ? '!' : '✓';
        s.verb.textContent = TOOL_VERBS[tool.name] ?? tool.name;
        if (failed) s.el.querySelector('summary')?.append(h('span', { class: 'step-note' }, 'the model is correcting the call'));
        s.el.append(h('pre', { class: 'step-raw' }, pretty(tool.result)));
        if (tool.card) {
          const card = cardView(tool.card, rerender);
          card.classList.add('enter');
          // Tools finish in a few ms; hold the skeleton so the card fades in over it instead of popping.
          const wait = Math.max(0, 320 - (performance.now() - s.since));
          const slot = s.slot;
          // The ghost may have moved while the card waited off-DOM (show_on_chart then clear in one turn).
          setTimeout(() => { syncGhostButtons(card); slot.replaceChildren(card); if (superseded(t.tools ?? [], i)) staleWrap(card, true); }, wait);
        } else s.slot.remove();
      }
      const stale = superseded(t.tools ?? [], i);
      if (stale && !s.stale) {
        s.stale = true;
        s.el.classList.add('stale');
        if (!s.el.querySelector('.step-note')) s.el.querySelector('summary')?.append(h('span', { class: 'step-note stale-note' }, STALE_NOTE));
        const card = s.slot.querySelector<HTMLElement>('.card-block');
        if (card && !card.classList.contains('stale')) staleWrap(card, true);
      }
    });
    if (t.text) {
      const next = markdown(t.text);
      if (md) md.replaceWith(next); else body.insertBefore(next, status);
      md = next;
    }
    if (finished) {
      status.remove();
      if (t.error) body.append(h('div', { class: 'error' }, h('span', {}, t.error), h('button', { class: 'btn small', type: 'button', onclick: retry }, 'Retry')));
      el.classList.remove('live');
      return;
    }
    // While a tool runs its step row already shows the spinner and verb, so
    // the status line would only repeat it.
    const running = t.tools?.find((x) => !x.result);
    status.hidden = !!running;
    const phase = running ? '' : (t.reasoning && !t.text && !t.tools?.length) ? 'Thinking' : t.text ? 'Writing' : t.tools?.length ? 'Reading the results' : `Waiting for ${shortModel(config.model)}`;
    statusText.textContent = `${phase}…`;
  };
  update();
  return { el, update, finish: () => { finished = true; update(); } };
}

function runningVerb(name: string): string {
  const v = TOOL_VERBS[name] ?? name;
  return `${v.replace(/^(Ran|Swept|Replayed|Applied|Read)\b/, (m) => verbing(m))}…`;
}

/** Placeholder with the rough shape of the card a tool will produce, sized from the call's arguments. */
function skeleton(tool: string, args: Record<string, unknown>): HTMLElement {
  const bar = (w: string, hgt = '12px'): HTMLElement => h('div', { class: 'sk', style: `width:${w};height:${hgt}` });
  const rows = (n: number): HTMLElement[] => Array.from({ length: n }, () => bar('100%'));
  const sweep = (args.sweep ?? (args.input !== undefined ? args : null)) as { from?: unknown; to?: unknown; step?: unknown } | null;
  const points = sweep && typeof sweep.from === 'number' && typeof sweep.to === 'number' && typeof sweep.step === 'number' && sweep.step > 0
    ? Math.min(11, Math.floor((sweep.to - sweep.from) / sweep.step) + 1) : 5;
  const scenario = (): HTMLElement[] => [bar('30%', '16px'), bar('55%'), ...rows(6), bar('100%', '220px')];
  if (tool === 'run_scenario' || tool === 'solve' || (tool === 'show_on_chart' && args.clear !== true)) return h('div', { class: 'card-block skeleton' }, ...scenario());
  if (tool === 'sweep') return h('div', { class: 'card-block skeleton' }, bar('35%', '16px'), bar('100%', '90px'), ...rows(points + 1));
  if (tool === 'get_sequence') return h('div', { class: 'card-block skeleton' }, bar('30%', '16px'), bar('100%', '240px'));
  if (tool === 'compare') return h('div', { class: 'card-block skeleton' }, bar('30%', '16px'), ...rows(sweep ? points + 1 : 10));
  if (tool === 'get_first_year') return h('div', { class: 'card-block skeleton' }, bar('45%', '16px'), ...rows(projectAccounts().length + 2));
  return h('div', { class: 'card-slot-empty' });
}

function verbing(v: string): string {
  return ({ Ran: 'Running', Swept: 'Sweeping', Replayed: 'Replaying', Applied: 'Applying', Read: 'Reading' } as Record<string, string>)[v] ?? v;
}

function pretty(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

/** True when a later call in the same turn targets the same thing (a corrected retry), so the earlier result is stale. */
function superseded(tools: ToolRecord[], i: number): boolean {
  const a = tools[i]!;
  const target = (x: ToolRecord): string => `${x.name}:${String(x.args.label ?? x.args.input ?? x.args.startYear ?? '')}`;
  return tools.slice(i + 1).some((b) => target(b) === target(a));
}
const STALE_NOTE = 'superseded by the corrected call below';

function argsLabel(a: Record<string, unknown>): string {
  const o = a.overrides ?? a.base;
  const bits: string[] = [];
  if (typeof a.label === 'string') bits.push(a.label);
  if (o && typeof o === 'object') { try { bits.push(describeOverrides(o as never).join(', ')); } catch { /* unresolvable names */ } }
  if (a.input !== undefined) bits.push(`${a.input} ${a.from} to ${a.to} by ${a.step}`);
  if (a.startYear !== undefined) bits.push(`start ${a.startYear}`);
  return bits.join(' · ');
}

function tone(v: number, ref: number, higherIsBetter = true): string {
  if (Math.abs(v - ref) < 1e-9) return '';
  return (v > ref) === higherIsBetter ? 'good' : 'bad';
}

/** Grey out a card whose tool call was retried later in the turn, with a line saying where to look. */
function staleWrap(card: HTMLElement, stale: boolean): HTMLElement {
  if (!stale || card.classList.contains('stale')) return card;
  card.classList.add('stale');
  const wrap = h('details', { class: 'stale-wrap' }, h('summary', {}, h('span', { class: 'stale-mark' }, '↓'), 'Superseded result, the corrected one is below. ', h('span', { class: 'stale-toggle' }, 'Show anyway')));
  card.replaceWith(wrap);
  wrap.append(card);
  return wrap;
}

function cardView(c: Card, rerender: () => void): HTMLElement {
  switch (c.type) {
    case 'scenario': return scenarioCard(c, rerender);
    case 'sweep': return sweepCard(c, rerender);
    case 'sequence': return sequenceCard(c);
    case 'table': return h('div', { class: 'card-block' }, h('div', { class: 'card-title' }, c.title),
      h('table', {}, h('thead', {}, h('tr', {}, ...c.headers.map((x) => h('th', {}, x)))), h('tbody', {}, ...c.rows.map((r) => h('tr', {}, ...r.map((x) => { const m = /^(\d+)%$/.exec(String(x)); const n = m ? Number(m[1]) : NaN; return h('td', { class: Number.isNaN(n) ? '' : n >= 90 ? 'pos' : n < 75 ? 'neg' : '' }, String(x)); }))))));
  }
}

function metricRows(base: Metrics, s: Metrics): HTMLElement {
  const row = (label: string, b: string, v: string, cls: string): HTMLElement =>
    h('div', { class: 'cmp-row' }, h('span', { class: 'cmp-label' }, label), h('span', { class: 'cmp-base' }, b), h('span', { class: `cmp-val ${cls}` }, v));
  return h('div', { class: 'cmp' },
    h('div', { class: 'cmp-row head' }, h('span', {}, ''), h('span', {}, 'Current'), h('span', {}, 'Scenario')),
    row('Success rate', pct(base.successRate, 0), pct(s.successRate, 0), tone(s.successRate, base.successRate)),
    row(`Portfolio at ${s.retireAge}`, usdK(base.portfolioReal), usdK(s.portfolioReal), tone(s.portfolioReal, base.portfolioReal)),
    row('First-year withdrawal', usdK(base.firstYearGross), usdK(s.firstYearGross), tone(s.firstYearGross, base.firstYearGross, false)),
    row('Withdrawal rate', pct(base.withdrawalRate, 2), pct(s.withdrawalRate, 2), tone(s.withdrawalRate, base.withdrawalRate, false)),
    row(`Median at ${s.endAge}`, usdK(base.medianEnding), usdK(s.medianEnding), tone(s.medianEnding, base.medianEnding)),
    row('Worst case left', usdK(base.worstEnding), usdK(s.worstEnding), tone(s.worstEnding, base.worstEnding)),
  );
}

/** Toggle for the Retirement chart's ghost line; one ghost at a time, so turning one on turns any other off. Reads the ghost at click time, so a button that missed an update still does the right thing. */
const ghostButtons = new WeakMap<HTMLElement, Overrides>();
function ghostButton(label: string, overrides: Overrides, size: 'small' | 'tiny'): HTMLElement {
  const btn = h('button', { class: `btn ${size}`, type: 'button', 'data-ghost': '', onclick: () => setGhost(isGhost(overrides) ? null : { label, overrides }) });
  ghostButtons.set(btn, overrides);
  paintGhostButton(btn, overrides);
  return btn;
}
function paintGhostButton(btn: HTMLElement, overrides: Overrides): void {
  const on = isGhost(overrides);
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'Shown on chart' : 'Show on chart';
}
/** Bring every ghost button under `root` in line with the current ghost. */
function syncGhostButtons(root: HTMLElement): void {
  for (const btn of root.querySelectorAll<HTMLElement>('[data-ghost]')) { const o = ghostButtons.get(btn); if (o) paintGhostButton(btn, o); }
}

/** A card's Apply: writes the scenario into the plan, or says under the card why it cannot (the plan may have changed since the card was made). */
function applyFromCard(btn: HTMLElement, overrides: Overrides, rerender: () => void): void {
  const card = btn.closest('.card-block');
  card?.querySelector(':scope > .apply-problem')?.remove();
  const problems = applyChecked(overrides);
  if (problems.length) { card?.append(h('div', { class: 'error apply-problem' }, `Not applied: ${problems[0]}`)); return; }
  setGhost(null); rerender();
}

function scenarioCard(c: Extract<Card, { type: 'scenario' }>, rerender: () => void): HTMLElement {
  const ghostBtn = ghostButton(c.label, c.overrides, 'small');
  const apply = h('button', { class: 'btn small primary', type: 'button', onclick: () => applyFromCard(apply, c.overrides, rerender) }, 'Apply');
  return h('div', { class: 'card-block scenario' },
    h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'card-title' }, c.label), h('div', { class: 'card-sub' }, describeOverrides(c.overrides).join(' · '))), h('div', { class: 'card-actions' }, ghostBtn, apply)),
    metricRows(c.base, c.scenario),
    lineChart({ series: [{ label: 'Current (median)', cls: 's1', values: c.base.medianPath }, { label: `${c.label} (median)`, cls: 'ghost', values: c.scenario.medianPath }], startAge: Math.min(c.base.retireAge, c.scenario.retireAge), height: 220 }));
}

function sweepCard(c: Extract<Card, { type: 'sweep' }>, rerender: () => void): HTMLElement {
  const rows = c.points.map((p) => {
    const apply: HTMLElement = h('button', { class: 'btn tiny', type: 'button', onclick: () => applyFromCard(apply, p.overrides, rerender) }, 'Apply');
    return h('tr', {},
      h('td', {}, String(p.value)),
      h('td', { class: `num ${p.metrics.successRate >= 0.9 ? 'good' : p.metrics.successRate < 0.75 ? 'bad' : ''}` }, pct(p.metrics.successRate, 0)),
      h('td', { class: 'num' }, usdK(p.metrics.portfolioReal)),
      h('td', { class: 'num' }, usdK(p.metrics.medianEnding)),
      h('td', { class: 'num row-actions' }, ghostButton(sweepLabel(c.input, p.value), p.overrides, 'tiny'), apply));
  });
  return h('div', { class: 'card-block' },
    h('div', { class: 'card-title' }, `Sweep: ${c.label}`),
    miniBars(c.points.map((p) => ({ label: String(p.value), value: p.metrics.successRate }))),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, c.input), h('th', { class: 'num' }, 'Success'), h('th', { class: 'num' }, 'At retirement'), h('th', { class: 'num' }, 'Median at end'), h('th', {}, ''))), h('tbody', {}, ...rows))));
}

function sequenceCard(c: Extract<Card, { type: 'sequence' }>): HTMLElement {
  const last = c.balances[c.balances.length - 1] ?? 0;
  return h('div', { class: 'card-block' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, `Retiring in ${c.startYear}`),
      h('div', { class: `card-sub ${c.depletedAt ? 'bad' : 'good'}` }, c.depletedAt ? `runs out at age ${c.depletedAt}` : `${usd(last)} left at ${c.ages[c.ages.length - 1]}`)),
    lineChart({ series: [{ label: `Balance, ${c.startYear} start`, cls: c.depletedAt ? 's2' : 's1', values: c.balances }], startAge: c.ages[0] ?? 0, reference: c.balances[0], markLow: 0, height: 240 }));
}

function miniBars(points: { label: string; value: number }[]): HTMLElement {
  return h('div', { class: 'mini-bars' }, ...points.map((p) => h('div', { class: 'mini-bar-col', title: `${p.label}: ${pct(p.value, 0)}` },
    h('div', { class: 'mini-bar-track' }, h('div', { class: `mini-bar ${p.value >= 0.9 ? 'good' : p.value < 0.75 ? 'bad' : 'mid'}`, style: `height:${Math.round(p.value * 100)}%` })),
    h('div', { class: 'mini-bar-label' }, p.label))));
}

