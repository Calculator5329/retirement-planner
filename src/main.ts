import { renderAccounts } from './tabs/accounts';
import { renderHoldings } from './tabs/holdings';
import { renderProjection } from './tabs/projection';
import { renderRetirement } from './tabs/retirement';
import { askModal, renderChat } from './tabs/chat';
import { loadCsv, save, exportSettings, importSettings, DEFAULTS, settings, holdings, accounts, csvSource } from './state';
import { ghost } from './chat/store';

type Tab = { id: string; label: string; render: (rerender: () => void) => HTMLElement };
const TABS: Tab[] = [
  { id: 'accounts', label: 'Accounts', render: renderAccounts },
  { id: 'retirement', label: 'Retirement', render: renderRetirement },
  { id: 'projection', label: 'Projection', render: renderProjection },
  { id: 'holdings', label: 'Holdings', render: renderHoldings },
  { id: 'chat', label: 'Chat', render: renderChat },
];

const view = document.getElementById('view')!;
const nav = document.getElementById('tabs')!;
const source = document.getElementById('source')!;
// An unknown or missing hash lands on Accounts and the URL is corrected in place.
function tabFromHash(): string {
  const id = location.hash.slice(1);
  if (TABS.some((t) => t.id === id)) return id;
  history.replaceState(null, '', '#accounts');
  return 'accounts';
}
let current = tabFromHash();

// A tab's tree is rebuilt only when something it reads has changed. Switching
// back to a tab whose inputs are untouched reuses the tree it built last time,
// so the switch is instant even for the Retirement tab's 26 simulations. The
// chat tab keeps its own live state and is never rebuilt on a switch.
const trees = new Map<string, { key: string; el: HTMLElement }>();
const scrollAt = new Map<string, number>();
// The app restores each tab's own scroll position; the browser's restore on Back would fight it.
history.scrollRestoration = 'manual';
const depsKey = (): string => JSON.stringify([settings, ghost, csvSource, holdings.length]);
// The input being typed in, moved into a rebuilt tree and focused again by render() once that tree is attached.
let refocus: HTMLElement | null = null;

function tree(tab: Tab): HTMLElement {
  const key = tab.id === 'chat' ? 'chat' : depsKey();
  const cached = trees.get(tab.id);
  if (cached && cached.key === key) return cached.el;
  // Rebuilding the current tab (an input changed): keep the input the user is
  // typing in by moving the live node into the new tree so its caret survives.
  // Moving it blurs it, so render() focuses it again in the same task: a key
  // pressed while the page was busy must reach the input, not the tab shortcuts.
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && view.contains(active) ? active.dataset.key : undefined;
  const el = tab.render(render);
  if (focusKey && active instanceof HTMLElement) {
    const twin = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
    if (twin) { twin.replaceWith(active); refocus = active; }
  }
  trees.set(tab.id, { key, el });
  return el;
}

function render(): void {
  save();
  const tab = TABS.find((t) => t.id === current) ?? TABS[0]!;
  const el = tree(tab);
  if (view.firstElementChild !== el) view.replaceChildren(el);
  if (refocus) { refocus.focus({ preventScroll: true }); refocus = null; }
  view.classList.toggle('full', current === 'chat');
  document.body.classList.toggle('chat-mode', current === 'chat');
  for (const b of nav.children) b.classList.toggle('active', (b as HTMLElement).dataset.tab === current);
  source.textContent = `${holdings.length} holdings in ${accounts.length} accounts · ${csvSource === 'bundled' ? 'bundled export' : 'your CSV'}`;
}

function switchTo(id: string): void {
  if (id === current) return;
  scrollAt.set(current, window.scrollY);
  current = id;
  // Each switch is a history entry, so Back returns to the previous tab instead of leaving the app.
  if (location.hash.slice(1) !== id) history.pushState(null, '', `#${id}`);
  render();
  window.scrollTo(0, scrollAt.get(id) ?? 0);
}

nav.replaceChildren(...TABS.map((t, i) => {
  const b = document.createElement('button');
  b.textContent = t.label;
  b.className = 'tab-btn';
  b.dataset.tab = t.id;
  b.title = `${t.label} (${i + 1})`;
  b.onclick = () => switchTo(t.id);
  return b;
}));
// 1 to 5 switch tabs when the focus is not in a field.
window.addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLElement | null;
  if (e.metaKey || e.ctrlKey || e.altKey || tgt?.closest('input, textarea, select, [contenteditable]')) return;
  const tab = TABS[Number(e.key) - 1];
  if (tab && /^[1-5]$/.test(e.key)) switchTo(tab.id);
});

// Load CSV and Import are real buttons (reachable by keyboard) that open the hidden file pickers.
document.getElementById('csv-load')!.addEventListener('click', () => document.getElementById('csv-file')!.click());
document.getElementById('settings-import')!.addEventListener('click', () => document.getElementById('settings-file')!.click());
document.getElementById('csv-file')!.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const n = loadCsv(await file.text());
  if (n === 0) { alert('No holdings found. Expected the combined_holdings export format.'); loadCsv(null); }
  render();
});
document.getElementById('settings-export')!.addEventListener('click', () => {
  const blob = new Blob([exportSettings()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `retirement-planner-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
document.getElementById('settings-file')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!importSettings(await file.text())) { alert('That file is not a retirement-planner settings export.'); return; }
  render();
});
document.getElementById('csv-reset')!.addEventListener('click', () => {
  if (!confirm('Reset to the bundled holdings file and default inputs? Export settings first if you want to keep them.')) return;
  loadCsv(null); importSettings(JSON.stringify(DEFAULTS)); render();
});
// "ask" on any stat tile: a quick streamed note in a modal, no tab switch.
view.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.ask');
  if (!btn) return;
  const tile = btn.closest<HTMLElement>('.stat');
  const label = tile?.querySelector('.stat-label')?.childNodes[0]?.textContent?.trim() ?? '';
  const value = tile?.querySelector('.stat-value')?.textContent?.trim() ?? '';
  const sub = tile?.querySelector('.stat-sub')?.textContent?.trim() ?? '';
  const tab = TABS.find((t) => t.id === current)?.label ?? '';
  askModal(`On the ${tab} tab, explain "${label}: ${value}"${sub ? ` (${sub})` : ''}. Where does that number come from and what moves it most?`, render);
});
window.addEventListener('popstate', () => switchTo(tabFromHash()));
render();
