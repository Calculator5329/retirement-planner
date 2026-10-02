import { BUCKETS, BUCKET_LABEL } from '../holdings';
import { stackedArea } from '../chart';
import { h, problemsNote, stat, table, toggle, help } from '../dom';
import { usd } from '../format';
import { bucketPaths, display, projectAccounts, real } from '../projection';
import { inputProblems, settings, yearsToRetire } from '../state';

export function renderProjection(rerender: () => void): HTMLElement {
  const problems = inputProblems(settings);
  if (problems.length) return h('div', { class: 'tab' }, problemsNote(problems));
  const years = yearsToRetire();
  const projs = projectAccounts();
  const paths = bucketPaths(projs);
  const totals = paths.pretax.map((_, i) => BUCKETS.reduce((s, b) => s + (paths[b][i] ?? 0), 0));
  const d = (v: number, i: number) => display(v, i);

  const byBucket = stackedArea({ startAge: settings.currentAge,
    series: BUCKETS.map((b) => ({ label: BUCKET_LABEL[b], cls: b, values: paths[b].map(d) })),
    extra: (i) => settings.showReal ? `${usd(totals[i] ?? 0)} nominal` : `${usd(real(totals[i] ?? 0, i))} in today's dollars` });

  // What you put in versus what the market added.
  const start = totals[0] ?? 0;
  const contribPerYear = projs.reduce((s, p) => s + p.contribution, 0);
  const matchPerYear = projs.reduce((s, p) => s + p.match, 0);
  const contributed = totals.map((_, i) => contribPerYear * i);
  const matched = totals.map((_, i) => matchPerYear * i);
  const growth = totals.map((t, i) => Math.max(0, t - start - (contributed[i] ?? 0) - (matched[i] ?? 0)));
  const sources = stackedArea({ startAge: settings.currentAge, height: 240,
    series: [
      { label: 'Starting balance', cls: 's6', values: totals.map((_, i) => d(start, i)) },
      { label: 'Contributions', cls: 's4', values: contributed.map(d) },
      ...(matchPerYear > 0 ? [{ label: 'Employer match', cls: 's5', values: matched.map(d) }] : []),
      { label: 'Market growth', cls: 's1', values: growth.map(d) },
    ] });

  const milestones = [500000, 1000000, 2000000, 3000000, 5000000, 10000000]
    .map((m) => ({ m, i: totals.findIndex((t) => t >= m) }))
    .filter((x) => x.i > 0 && x.i <= years);
  const tiles = h('section', { class: 'stats' },
    stat(`At ${settings.retireAge}`, usd(d(totals[years] ?? 0, years)), settings.showReal ? "today's dollars" : `${usd(real(totals[years] ?? 0, years))} in today's dollars`),
    stat('Contributed by then', usd(contributed[years] ?? 0), `${usd(contribPerYear)} a year`),
    matchPerYear > 0 ? stat('Employer match by then', usd(matched[years] ?? 0), `${usd(matchPerYear)} a year`) : null,
    stat('Market growth by then', usd(d(growth[years] ?? 0, years)), growth[years] && totals[years] ? `${Math.round((growth[years] / totals[years]) * 100)}% of the ending value` : ''),
    ...milestones.map((x) => stat(`Crosses ${usd(x.m / 1e6, x.m < 1e6 ? 1 : 0)}M`, `age ${settings.currentAge + x.i}`, `${new Date().getFullYear() + x.i}, nominal`)),
  );

  const step = years > 30 ? 5 : years > 12 ? 2 : 1;
  const rows: string[][] = [];
  const line = (i: number) => [`${settings.currentAge + i} (${new Date().getFullYear() + i})`, ...BUCKETS.map((b) => usd(d(paths[b][i] ?? 0, i))), usd(d(totals[i] ?? 0, i)), usd(real(totals[i] ?? 0, i))];
  for (let i = 0; i <= years; i += step) rows.push(line(i));
  if (years % step !== 0) rows.push(line(years));

  return h('div', { class: 'tab' },
    h('section', { class: 'controls' }, h('div', { class: 'group' },
      h('div', { class: 'group-title' }, `Age ${settings.currentAge} to ${settings.retireAge}`, help('Contributions, employer match and CAGR per account come from the Accounts tab.')),
      toggle('showReal2', "Show in today's dollars", settings.showReal, (v) => { settings.showReal = v; rerender(); }))),
    tiles,
    h('section', {}, h('h2', {}, 'Growth by tax bucket'), byBucket),
    h('section', {}, h('h2', {}, 'Your money versus market growth'), sources),
    h('section', {}, h('h2', {}, 'By year'), table(['Age (year)', ...BUCKETS.map((b) => BUCKET_LABEL[b]), 'Total', "Today's $"], rows)));
}
