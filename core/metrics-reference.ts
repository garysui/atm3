import {
  metricsCatalog,
  sessionMetricsCatalog,
  type MetricCatalogEntry,
  type MetricFamily,
} from './metrics-catalog.ts'

// The metrics reference is GENERATED from the catalog so it can never drift
// from the code: `npm run docs:metrics` rewrites it, and a sync test fails
// whenever the catalog changes without regeneration.

const familySummaries: Record<MetricFamily, string> = {
  state:
    'Levels and status for filter predicates — real as-traded prices, listing state, sample size.',
  returns:
    'How much the price moved over standard bar windows (adjusted basis; 21 ≈ month, 63 ≈ quarter, 252 ≈ year).',
  gap: 'Overnight behavior — the move between the previous close and the open, economically adjusted.',
  trend:
    'Where the price sits against its own averages, 52-week extremes, drawdown, and streaks.',
  volatility:
    'How much the name typically moves — close-to-close, range-based (Parkinson), and gap-robust (Yang-Zhang) sigmas, plus day-shape measures.',
  volume:
    'Participation and liquidity on split-invariant dollar volume.',
  events:
    'Corporate-action context knowable at T — recency, knowably upcoming ex-dates, trailing yield.',
  context:
    'Co-movement with named baselines (SPY and the trailing-correlation tracking ETF) and the residual — the movement that is the name\'s own.',
  surprise:
    'Today versus this name\'s OWN trailing distribution; every denominator ends at T-1 so today never contaminates its own sigma.',
  session:
    'Intraday state at minute T, from the session\'s complete RTH minute bars strictly before T.',
}

function windowLabel(entry: MetricCatalogEntry): string {
  if (entry.window === 'all') return 'all'
  if (entry.window === null) return '—'
  return String(entry.window)
}

function tableFor(entries: readonly MetricCatalogEntry[]): string {
  const rows = entries.map((entry) =>
    `| \`${entry.id}\` | ${entry.description} | ${windowLabel(entry)} | ` +
    `${entry.min_bars} | ${entry.basis} | ${entry.unit} | ${entry.available_at} |`,
  )
  return [
    '| id | measures | window | needs | basis | unit | at |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

export function renderMetricsReference(): string {
  const families: MetricFamily[] = []
  for (const entry of metricsCatalog) {
    if (!families.includes(entry.family)) families.push(entry.family)
  }

  const sections = families.map((family) => {
    const entries = metricsCatalog.filter((entry) => entry.family === family)
    return [
      `## ${family} (${entries.length})`,
      '',
      familySummaries[family],
      '',
      tableFor(entries),
      '',
    ].join('\n')
  })

  return [
    '# Metrics reference',
    '',
    '<!-- GENERATED FILE — DO NOT EDIT. Source: core/metrics-catalog.ts. -->',
    '<!-- Regenerate with `npm run docs:metrics`; a sync test fails when stale. -->',
    '',
    `Every metric the view-at-T engine computes: **${metricsCatalog.length}` +
    ` daily** metrics across ${families.length} families plus ` +
    `**${sessionMetricsCatalog.length} session** (intraday) metrics — ` +
    `${metricsCatalog.length + sessionMetricsCatalog.length} total. This page ` +
    'is generated from the catalog (`core/metrics-catalog.ts`), so it is ' +
    'always complete and current by construction. Exact formulas, the theory ' +
    'behind the estimators, and every term used below live in the ' +
    '[glossary](glossary.md).',
    '',
    'How to read the columns: **measures** — what the number tells you; ' +
    '**window** — the lookback in bars (daily) or minute bars (session); ' +
    '**needs** — minimum bars before the metric reports a value instead of ' +
    'an honest null; **basis** — `adj` (split-dividend adjusted as of T), ' +
    '`raw` (as-traded), `dollar` (raw close × raw volume, split-invariant); ' +
    '**at** — earliest availability (`open`, `close`, or intraday `minute`).',
    '',
    ...sections,
    '',
    `## session (${sessionMetricsCatalog.length})`,
    '',
    familySummaries.session,
    '',
    tableFor(sessionMetricsCatalog),
    '',
  ].join('\n')
}
