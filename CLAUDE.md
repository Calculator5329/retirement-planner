# retirement-planner

Mini planner over a combined brokerage export. Vite + TypeScript, vanilla
DOM, SVG charts, no runtime deps. Holdings come from `src/data/holdings.csv`
(the `combined_holdings` export, 10 columns: the last two are account type and
tax treatment) and default inputs from `src/data/defaults.json` (an Export
from the UI). Both shipped files are synthetic and must stay synthetic: real
exports live in the gitignored `private/` folder and load with
`PLANNER_HOLDINGS=private/holdings.csv PLANNER_DEFAULTS=private/defaults.json
npm run dev` (aliases in `vite.config.ts`, ignored under vitest). Load CSV in
the UI swaps holdings at runtime. Typed accounts are `settings.entered`
(`EnteredAccount`, kinds in `ACCOUNT_KINDS` in `src/state.ts`) and join the
file's accounts in `refreshAccounts`; `bundledHoldings: false` drops the
bundled CSV. The header's Set up opens `openSetup` (`src/tabs/setup.ts`), four
questions that `applySetup` turns into one typed account per tax bucket. Never commit real balances, account names or
fractional share counts. Publishing goes only through
`scripts/publish-copy.sh`; read `docs/publish.md` first (neither is in the
published copy).

Tabs: Accounts (an editable account list: rows read from the holdings file
plus accounts typed in by hand, each with contribution, CAGR and value at
retirement, match and basis behind a row toggle; donuts by tax bucket),
Retirement (ficalc-style historical-sequence simulation:
the plan is replayed from every S&P 500 start year in `src/data/history.ts`,
giving a success rate, fan chart, income-source bars, federal tax with 2025
brackets, social security, an allocation at retirement across the S&P 500,
10-year Treasuries and a life annuity with a Compare allocations table,
variable expenses per month plus fixed expenses such as a mortgage that stay
the same in dollars and stop at a payoff age, and a spending x retire-age sensitivity grid),
Projection (stacked areas by tax bucket and by money source, milestones),
Holdings (category and tax donuts, top stocks, grouped positions), Chat
(OpenRouter chat over the plan; `src/chat/` holds the store, streaming
client, tool definitions and markdown; `src/plan.ts` is the plan evaluator
with `evaluateWith(overrides)` that every tool uses).

Verify: `npm test` (model math and the parser), `npm run build` (typecheck),
`npm run dev` and click through the five tabs. `tests/chat.test.ts` covers the
tool loop and retries with a mocked fetch; to see the Chat UI without a key,
stub `window.fetch` with an SSE stream in the console (or paste a key).
Chat controls (model, key, thinking, New chat, spend) live in the composer's
bottom row; the stat-tile "ask" opens `askModal()` in `src/tabs/chat.ts`.
Tab trees are cached in `src/main.ts` keyed on settings, ghost and holdings;
`simulate` is memoised. Withdrawal strategy is a preset in `DRAW_ORDERS`
(`src/model.ts`) chosen on the Retirement tab and via `retire.drawOrder`;
the fill strategies (`DrawMix.fillBracket`) take pre-tax up to the bracket
room and convert the rest to Roth (`Withdrawal.converted`, never spendable);
`withdraw` applies the age rules (59.5 penalty, Roth basis, rule of 55,
RMDs from 75) whenever `YearInput.age` is set, and `yearInputAt` builds that
input for callers. The Roth ladder (`RothLadder`, `retire.ladder`) converts a fixed amount or up to a bracket top every year from retirement until `ssStartAge`, at any age, taxed that year; with a fill strategy the larger conversion wins and `ladder` carries the ladder's extra. Employer match is per account (`salary`, `matchPct`,
`matchUpToPct` in `AccountSettings`), only on employer plans
(`isEmployerPlan` in `src/projection.ts`), stays a separate line from the
employee contribution, and is always pre-tax money (`accountBuckets` splits
an account across buckets, so read bucket totals through it). Chat markdown renders pipe tables but the prompt forbids
the model from writing them. Social security is `SS_LEVELS` + `ssMonthlyFor` in
`src/state.ts`; `syncSocialSecurity` keeps `ssMonthly` derived unless the
level is custom. `help()` tooltips take markdown.

Rules (the reasons and the concrete settings are in `docs/taste.md`, read it
before any UI change): dark theme, no gradients/glassmorphism; stat tiles flex-grow
so a row never ends with a single orphan; explanatory notes go in `help()` tooltips, never footnotes; all retirement-tab math is in
today's dollars (brackets applied unindexed); user inputs persist to
localStorage under `retirement-planner-v3` and round-trip through the header's
Export/Import JSON (`fromJson` in `src/state.ts` is the one parser for both); the chat model never computes a
number, it calls tools and the UI renders cards from tool results, never from
prose; the OpenRouter key lives only in localStorage
(`retirement-planner-chat-config`) and is never committed or logged;
`src/model.ts`, `src/sim.ts` and `src/plan.ts` stay pure and tested. The S&P 500, 10-year Treasury and CPI series in `src/data/history.ts`
were typed from the Damodaran/BLS tables and can be replaced wholesale.

Allocation: `retire.equity` is the S&P 500 share, `retire.annuity` the
annuity share, and Treasuries take the rest (`treasuriesShare`). The annuity
is bought in `evaluate` with pre-tax money only (`buyAnnuity`), so
`planProblems` in `src/plan.ts` adds that cap to `inputProblems`; every
entry point that evaluates the plan (tabs, chat, overrides) uses
`planProblems`. Payout rates are the `PAYOUT` table in `src/model.ts` (a dated survey)
plus `YIELD_SHIFT` for yield moves since; a
level payment is eroded by each historical run's own CPI. `retire.costs` is
annual everywhere except the Variable expenses field, which shows it per
month. Fixed expenses (`retire.fixedMonthly`, `retire.fixedEndAge`) are nominal: `fixedAt` in
`src/plan.ts` deflates them to retirement at the assumed inflation and
`fixedPayments` erodes them the same way as a level annuity, on top of `costs`. The simple page
keeps its flat 1% bond return through `SimInput.bondReal`.
