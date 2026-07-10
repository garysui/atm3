import { readFile } from 'node:fs/promises'
import type { DuckDBConnection } from '@duckdb/node-api'
import {
  residualize,
  type DatedClose,
  type ResidualizationOutcome,
} from '../core/residualization.ts'
import type { MetricId } from '../core/metrics-catalog.ts'
import type { MetricReason } from './metrics-at.ts'

type ContextEtf = { symbol: string; rationale: string }

export type ContextMetricValue = {
  value: number | string | null
  bars_available: number
  reason: MetricReason | null
}

export type ContextAtResult = {
  metrics: Partial<Record<MetricId, ContextMetricValue>>
  baselines: { spy: string | null; tracking: string | null }
}

let contextEtfsPromise: Promise<ContextEtf[]> | null = null

export function loadUsContextEtfs(): Promise<ContextEtf[]> {
  contextEtfsPromise ??= readFile(
    new URL('../acquisition/us-context-etfs.json', import.meta.url),
    'utf8',
  ).then((text) => {
    const parsed = JSON.parse(text) as {
      warning?: unknown
      securities?: Array<{ symbol?: unknown; rationale?: unknown }>
    }
    if (typeof parsed.warning !== 'string' || !Array.isArray(parsed.securities)) {
      throw new Error('invalid US context ETF configuration')
    }
    const securities = parsed.securities.map((entry) => {
      if (
        typeof entry.symbol !== 'string' ||
        !/^[A-Z]+$/.test(entry.symbol) ||
        typeof entry.rationale !== 'string' ||
        entry.rationale.length === 0
      ) {
        throw new Error('invalid US context ETF entry')
      }
      return { symbol: entry.symbol, rationale: entry.rationale }
    })
    if (new Set(securities.map(({ symbol }) => symbol)).size !== securities.length) {
      throw new Error('duplicate US context ETF symbol')
    }
    return securities
  })
  return contextEtfsPromise
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function emptyMetric(
  barsAvailable: number,
  reason: MetricReason,
): ContextMetricValue {
  return { value: null, bars_available: barsAvailable, reason }
}

function baselineMetrics(
  outcome: ResidualizationOutcome | undefined,
  ids: {
    beta: MetricId
    corr: MetricId
    resid21: MetricId
    resid63: MetricId
    idio: MetricId
  },
): Partial<Record<MetricId, ContextMetricValue>> {
  const stats = outcome?.result ?? null
  if (stats === null) {
    return Object.fromEntries(
      Object.values(ids).map((id) => [
        id,
        emptyMetric(
          outcome?.bars_available ?? 0,
          outcome?.reason ?? 'undefined_input',
        ),
      ]),
    ) as Partial<Record<MetricId, ContextMetricValue>>
  }
  const value = (number: number): ContextMetricValue => ({
    value: number,
    bars_available: stats.bars_available,
    reason: null,
  })
  return {
    [ids.beta]: value(stats.beta_63),
    [ids.corr]: value(stats.corr_63),
    [ids.resid21]: value(stats.resid_ret_21),
    [ids.resid63]: value(stats.resid_ret_63),
    [ids.idio]: value(stats.idio_vol_63),
  }
}

export async function contextAt(
  connection: DuckDBConnection,
  options: { instrumentId: string; t: string },
): Promise<ContextAtResult> {
  const configured = await loadUsContextEtfs()
  const symbolsSql = configured
    .map(({ symbol }) => `(${sqlString(symbol)})`)
    .join(', ')
  const resolvedResult = await connection.runAndReadAll(
    `
      with candidates(symbol) as (values ${symbolsSql})
      select c.symbol, cast(s.instrument_id as varchar) as instrument_id
      from candidates c
      join facts.symbols s
        on s.market_scope = 'us_stocks' and s.symbol = c.symbol
       and (s.valid_from is null or s.valid_from <= cast($t as date))
       and (s.valid_to is null or s.valid_to > cast($t as date))
      qualify row_number() over (
        partition by c.symbol order by s.is_primary desc, s.valid_from desc
      ) = 1
    `,
    { t: options.t },
  )
  const resolved = resolvedResult.getRowObjectsJson().map((row) => ({
    symbol: String(row.symbol),
    instrumentId: String(row.instrument_id),
  }))

  const unions = [
    `select '__stock__' as symbol, cast(market_date as varchar) as date, close
     from computed.adjusted_bars_for(
       cast($instrument_id as uuid), 'split_dividend',
       as_of := cast($t as date)
     )`,
    ...resolved.map(({ symbol, instrumentId }) =>
      `select ${sqlString(symbol)} as symbol,
              cast(market_date as varchar) as date, close
       from computed.adjusted_bars_for(
         cast(${sqlString(instrumentId)} as uuid), 'split_dividend',
         as_of := cast($t as date)
       )`,
    ),
  ]
  const seriesResult = await connection.runAndReadAll(
    unions.join('\nunion all\n'),
    { instrument_id: options.instrumentId, t: options.t },
  )
  const series = new Map<string, DatedClose[]>()
  for (const row of seriesResult.getRowObjectsJson()) {
    const symbol = String(row.symbol)
    const values = series.get(symbol) ?? []
    values.push({ date: String(row.date), close: Number(row.close) })
    series.set(symbol, values)
  }
  const stock = series.get('__stock__') ?? []
  const stats = new Map<string, ResidualizationOutcome>()
  for (const { symbol } of resolved) {
    stats.set(symbol, residualize(stock, series.get(symbol) ?? []))
  }

  const spyOutcome = stats.get('SPY')
  const spyStats = spyOutcome?.result ?? null
  const tracking = [...stats.entries()]
    .flatMap(([symbol, outcome]) =>
      outcome.result === null ? [] : [[symbol, outcome.result] as const],
    )
    .sort((a, b) =>
      b[1].corr_63 - a[1].corr_63 || a[0].localeCompare(b[0]),
    )[0] ?? null
  const trackingStats = tracking?.[1] ?? null
  const trackingFallback = [...stats.values()].sort(
    (a, b) => b.bars_available - a.bars_available,
  )[0]
  const trackingOutcome: ResidualizationOutcome | undefined = trackingStats
    ? {
        result: trackingStats,
        bars_available: trackingStats.bars_available,
        reason: null,
      }
    : trackingFallback
  const metrics: Partial<Record<MetricId, ContextMetricValue>> = {
    ...baselineMetrics(spyOutcome, {
      beta: 'beta_63_spy',
      corr: 'corr_63_spy',
      resid21: 'resid_ret_21_spy',
      resid63: 'resid_ret_63_spy',
      idio: 'idio_vol_63_spy',
    }),
    ...baselineMetrics(trackingOutcome, {
      beta: 'tracking_beta_63',
      corr: 'tracking_corr_63',
      resid21: 'resid_ret_21_tracking',
      resid63: 'resid_ret_63_tracking',
      idio: 'idio_vol_63_tracking',
    }),
  }

  if (spyStats === null) {
    const barsAvailable = spyOutcome?.bars_available ?? 0
    const reason = spyOutcome?.reason ?? 'undefined_input'
    metrics.rel_ret_21 = emptyMetric(barsAvailable, reason)
    metrics.rel_ret_63 = emptyMetric(barsAvailable, reason)
  } else {
    metrics.rel_ret_21 = {
      value: spyStats.relative_ret_21,
      bars_available: spyStats.bars_available,
      reason: null,
    }
    metrics.rel_ret_63 = {
      value: spyStats.relative_ret_63,
      bars_available: spyStats.bars_available,
      reason: null,
    }
  }
  metrics.tracking_etf = tracking
    ? {
        value: tracking[0],
        bars_available: tracking[1].bars_available,
        reason: null,
      }
    : emptyMetric(
        trackingOutcome?.bars_available ?? 0,
        trackingOutcome?.reason ?? 'undefined_input',
      )

  // Yesterday-anchored residual surprise vs SPY. Null resid_z with full
  // stats means the 64th aligned pair does not exist yet.
  metrics.resid_z_spy =
    spyStats !== null && spyStats.resid_z !== null
      ? {
          value: spyStats.resid_z,
          bars_available: spyStats.bars_available,
          reason: null,
        }
      : emptyMetric(
          spyOutcome?.bars_available ?? 0,
          spyStats !== null
            ? 'insufficient_window'
            : spyOutcome?.reason ?? 'undefined_input',
        )

  return {
    metrics,
    baselines: {
      spy: stats.has('SPY') ? 'SPY' : null,
      tracking: tracking?.[0] ?? null,
    },
  }
}
