# Taste: rules from my feedback

Each rule here came from a screenshot I sent back to the agents during the
2026-09-20 and 21 build. Walk this list against a screenshot at my window
width (about 1200px wide) before showing any UI change. This file holds the
concrete settings for this repo.

## Header and tabs

- **Switching is instant.** A tab's tree is cached until something it reads
  changes (`depsKey()` in `src/main.ts`); expensive pure functions are
  memoised (`simulate`). I noticed a one-second switch immediately.
- **Nothing moves when a tab activates.** Tab labels keep one font weight;
  the active state is a 2px bar on the header rule. A bold active label
  widens the button and pushes its neighbours.
- **The page never shifts sideways.** `html { scrollbar-gutter: stable }`
  because the Chat tab hides page scroll; without it the header slides by
  the scrollbar width on every switch.
- **Scroll is per tab.** Coming back to a tab lands where you left it.

## Layout

- **No orphan rows.** Four things are 4 across or 2x2, never 3+1. Stat tiles
  and account cards `flex-grow` so the last row fills. `.controls` uses
  `minmax(420px, 1fr)` so four groups go 2x2 at 1240px; a 300px minimum let
  them land 3+1 at my width. Single column under 900px.
- **Notes are tooltips.** Explanations go in `help()` "?" hovers on the group
  title, section heading, field label or stat label. No footnotes, no
  subtitle sentences after a heading, no explainer paragraphs under a chart
  or table. A number that belongs to the heading (value at retirement) may
  stay in the heading; the sentence explaining it goes in the tip.
- **Tips are short and readable.** 13px, markdown, one idea per line: a
  lead sentence, then bullets with the term in bold, then at most one more
  sentence. My note: "bigger text, maybe markdown, shorter and unslopped".
- **Reality rules are modelled, not footnoted.** When a strategy option
  exists (Roth first) the model applies the law that constrains it
  (penalty age, Roth basis, rule of 55, required minimums) rather than
  leaving a caveat in a tip. Effects that are not spending (RMD surplus
  re-saved) get their own series so a jump on a chart reads as what it is.
- **Inputs align.** Inside a group every control sits in one right-aligned
  column (`.field { grid-template-columns: 1fr 140px }`), unit after it.
- **Squished means add space.** Do not shrink type or padding to fit.
- **Scrollbars are thin.** `scrollbar-width: thin`, transparent track, rounded
  thumb in `--border`, brighter on hover.
- **One border per control.** A `<details>` popover styles its `summary` as
  the pill; the outer element gets no pill class. Hover and focus states are
  checked in the browser before a control is called done.
- **Shipped defaults are synthetic.** `src/data/defaults.json` and
  `src/data/holdings.csv` are a made-up sample; real numbers stay in the
  gitignored `private/` folder and load through `PLANNER_HOLDINGS` and
  `PLANNER_DEFAULTS` (see `vite.config.ts`).
  Edits persist to localStorage and round-trip through Export/Import.

## Chat tab

- **Cap output tokens.** Requests send `max_tokens` (4000 chat, 1200 ask
  modal). Without it OpenRouter reserves the model's whole output window
  against the key's remaining credit and a one-dollar key gets refused.

- **No decorative marks.** No avatar circle beside assistant turns, no icon
  above the empty-state title. The text is the surface.
- **Streaming is in place, not rebuilt.** The live turn updates nodes in
  place (`liveTurn` in `src/tabs/chat.ts`) so shimmer and spinner animations
  never restart per token. No blinking caret. A status line with a spinner
  names the phase: Waiting for <model>, Thinking, Running scenario, Reading
  the results, Writing.
- **Superseded results get out of the way.** When the model retries a tool
  call (same tool, same label) later in the turn, the earlier step row greys
  out with "superseded by the corrected call below" and its card collapses to
  one line with a "Show anyway" toggle. Grey it out or say to scroll down;
  hide it by default.
- **One indicator at a time.** While a step row shows its own spinner and
  "Running scenario", the status line is hidden. Two "Running scenario"
  lines at once read as a bug.
- **Prose has a book width.** Assistant text, thinking and status are capped
  at 820px inside the 1100px column; cards and tables use the full width.
- **Cards arrive, they do not pop.** A running tool step shows a skeleton the
  shape of the coming card and stays at least 320ms (tools finish in a few
  ms, so without the hold the swap is a jolt); the real card replaces it
  with a 500ms fade-and-rise. Card charts use the same `lineChart` frame as the Retirement tab
  (gridlines, hover, low point and end labels), never a bare mini path.
- **Real chat primitives.** 1100px column (about the header width) at 15px/1.6. User turns
  are bubbles (`18px 18px 4px 18px`), assistant turns are plain blocks.
  Streaming caret on the live text, three-dot pulse while waiting, thread
  follows only when already at the bottom.
- **Thinking is one line.** Shimmering "Thinking" while it streams, then
  "Thought for Ns" collapsed; the body is italic behind a left rule.
- **Tool calls are steps.** A row per call: spinner, check or warning mark,
  a verb ("Ran scenario", "Swept"), the arguments, expandable raw JSON. Cards
  render under their step.
- **The composer is the control centre.** Pill with auto-growing textarea,
  round send that becomes stop. Bottom row: model pill (Luna, Opus 5, or any
  tool-capable id with live price), Key pill (amber "Add key" until set),
  Thinking toggle, New chat, and spend as `$0.0028 · 5.3k context · 12k total`
  from OpenRouter usage chunks. No settings strip above the thread.
- **Presets over precision.** Strategy inputs (withdrawal order, social
  security level) are a short list of named presets with a one-line note,
  never free weights the user has to get exactly right. My note: "a couple
  different settings ... where the user doesn't have to be exact". A
  preset control with five or six short options is a segmented control in
  the section header, not a select with a subtitle.
- **Presets are strategies, not permutations.** The withdrawal options are
  the ones worth choosing between (fill the 12% or 22% bracket with pre-tax
  and Roth conversions, taxable first, pre-tax first, Roth first, and a
  proportional baseline), each with a note saying what it is for and what
  it costs. My note: "add more intelligent options ... strategies you would
  recommend, to replace these simple options". An option that is only a
  different ordering (equal thirds, Roth last) is noise.
- **A stacked chart whose total explodes gets a share view.** When one
  series grows to tens of millions the early years compress to nothing and
  a small series vanishes; a Share | Dollars control with a 100% stack as
  the default keeps the mix readable at every age.
- **Skeletons match the card.** A placeholder is sized from the tool call's
  arguments (rows per swept value, rows per account), so the swap does not
  reflow the thread.
- **Comparisons and solves are tools.** Two scenarios across a range is
  `compare`; "how much can I spend" or "how early" is `solve`. The model
  never approximates either by reading a sweep.
- **Tools expose what the model is asked about.** If the model says the
  planner cannot break something down, that is a missing tool, not an
  answer. `get_first_year` exists because the model told me it could not
  split year one by account.
- **Model orchestrates, tools compute.** Every number comes from a tool
  result; cards are built from results, never parsed from prose. Scenario
  cards carry Apply and Show on chart (dashed ghost median on the fan chart).
- **Ask is minimal.** Hover-only "ask" on a stat tile opens a closeable modal
  that streams a two-to-four sentence note. It never switches tabs.
- **Cost is a design input.** Luna is the default because a question costs
  well under a cent; Opus 5 is the option. Say what a feature will cost before
  building it.
