import type { DuckDBConnection } from '@duckdb/node-api'
import {
  sessionMetricsCatalog,
  type MetricFamily,
  type SessionMetricId,
} from '../core/metrics-catalog.ts'
import type { MetricReason } from './metrics-at.ts'

// Regular trading hours per market scope, in exchange-local minutes of day.
// 960 is the 16:00 auction minute (the official close prints there). Only
// scopes listed here have minute data; everything else is an explicit error.
export const sessionWindowByScope: Record<
  string,
  { timezone: string; open: number; close: number; regularMinutes: number }
> = {
  us_stocks: {
    timezone: 'America/New_York',
    open: 570,
    close: 960,
    regularMinutes: 390,
  },
}

export type SessionMetricAt = {
  id: SessionMetricId
  family: MetricFamily
  value: number | string | boolean | null
  bars_available: number
  reason: MetricReason | null
  unit: string
}

export type SessionMetricsResult = {
  t: { date: string; minute: string }
  available_at: 'minute'
  visible_bars: number
  prior_sessions: number
  prev_close_date: string | null
  metrics: SessionMetricAt[]
}

export class ViewAtMinuteDateError extends Error {
  readonly previousDate: string | null
  readonly nextDate: string | null

  constructor(
    date: string,
    previousDate: string | null,
    nextDate: string | null,
  ) {
    super(
      `${date} has no minute bars for this instrument` +
        ` (previous: ${previousDate ?? 'none'}, next: ${nextDate ?? 'none'})`,
    )
    this.name = 'ViewAtMinuteDateError'
    this.previousDate = previousDate
    this.nextDate = nextDate
  }
}

export function parseSessionMinute(minute: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(minute)
  if (!match) {
    throw new Error('minute must be HH:MM (exchange-local)')
  }
  const value = Number(match[1]) * 60 + Number(match[2])
  if (value >= 24 * 60) {
    throw new Error(`minute ${minute} is not a time of day`)
  }
  return value
}

// Shared gate: the instrument belongs to the scope and D has minute bars.
export async function assertMinuteCoverage(
  connection: DuckDBConnection,
  options: { instrumentId: string; marketScope: string; date: string },
): Promise<void> {
  const scoped = await connection.runAndReadAll(
    `
      select
        exists(
          select 1 from facts.instruments
          where instrument_id = cast($instrument_id as uuid)
            and primary_market_scope = $market_scope
        ) as scope_matches,
        exists(
          select 1 from facts.bars_minute
          where instrument_id = cast($instrument_id as uuid)
            and market_date = cast($d as date)
        ) as has_minutes,
        cast((
          select max(market_date) from facts.bars_minute
          where instrument_id = cast($instrument_id as uuid)
            and market_date < cast($d as date)
        ) as varchar) as previous_date,
        cast((
          select min(market_date) from facts.bars_minute
          where instrument_id = cast($instrument_id as uuid)
            and market_date > cast($d as date)
        ) as varchar) as next_date
    `,
    {
      instrument_id: options.instrumentId,
      market_scope: options.marketScope,
      d: options.date,
    },
  )
  const gate = scoped.getRowObjectsJson()[0]
  if (gate?.scope_matches !== true) {
    throw new Error(
      `instrument ${options.instrumentId} is not in ${options.marketScope}`,
    )
  }
  if (gate.has_minutes !== true) {
    throw new ViewAtMinuteDateError(
      options.date,
      gate.previous_date === null ? null : String(gate.previous_date),
      gate.next_date === null ? null : String(gate.next_date),
    )
  }
}

// The single at-T pass: RTH minute bars of D strictly before T, the adjusted
// previous daily close (as of D — within D raw and adjusted coincide), and
// the same-cutoff cumulative dollar volume of up to 20 prior sessions.
export async function sessionMetricsAt(
  connection: DuckDBConnection,
  options: {
    instrumentId: string
    marketScope: string
    date: string
    minute: string
  },
): Promise<SessionMetricsResult> {
  const session = sessionWindowByScope[options.marketScope]
  if (!session) {
    throw new Error(`no minute data source for ${options.marketScope}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error('date must be YYYY-MM-DD')
  }
  const tMinute = parseSessionMinute(options.minute)
  if (tMinute <= session.open) {
    throw new Error(
      `${options.minute} precedes the first complete session bar`,
    )
  }

  await assertMinuteCoverage(connection, options)

  const result = await connection.runAndReadAll(
    `
      with mb_all as (
        select
          market_date,
          (extract(hour from window_start_utc at time zone '${session.timezone}') * 60
           + extract(minute from window_start_utc at time zone '${session.timezone}'))
            as et_minute,
          open, high, low, close, volume,
          close * volume as dv
        from facts.bars_minute
        where instrument_id = cast($instrument_id as uuid)
      ),
      visible as (
        select *,
          row_number() over (order by et_minute desc) - 1 as idx,
          lag(close) over (order by et_minute) as prev_close
        from mb_all
        where market_date = cast($d as date)
          and et_minute between ${session.open} and ${session.close}
          and et_minute < $t_minute
      ),
      prev_daily as (
        select close, cast(market_date as varchar) as market_date
        from computed.adjusted_bars_for(
          cast($instrument_id as uuid), 'split_dividend',
          as_of := cast($d as date)
        )
        where market_date < cast($d as date)
        order by market_date desc
        limit 1
      ),
      prior_sessions as (
        select market_date, sum(dv) as cum_dv
        from mb_all
        where market_date < cast($d as date)
          and et_minute between ${session.open} and ${session.close}
          and et_minute < $t_minute
        group by market_date
        order by market_date desc
        limit 20
      ),
      pace as (
        select count(*) as sessions, avg(cum_dv) as mean_cum_dv
        from prior_sessions
      ),
      aggregates as (
        select
          count(*) as visible_bars,
          arg_max(close, et_minute) as last_close,
          min(et_minute) as first_minute,
          arg_min(open, et_minute) as first_open,
          max(high) as session_high,
          min(low) as session_low,
          sum(((high + low + close) / 3) * volume) as pv,
          sum(volume) as v,
          sum(dv) as cum_dv,
          max(close) filter (where idx = 30) as close_30,
          max(close) filter (where idx = 60) as close_60,
          stddev_samp(ln(close / nullif(prev_close, 0))) as minute_vol,
          avg(case when close > prev_close then 1.0 else 0.0 end)
            filter (where prev_close is not null) as up_share,
          count(*) filter (where prev_close is not null) as return_count
        from visible
      )
      select
        a.*,
        p.close as prev_close,
        p.market_date as prev_close_date,
        pace.sessions as prior_session_count,
        pace.mean_cum_dv
      from aggregates a
      left join prev_daily p on true
      cross join pace
    `,
    {
      instrument_id: options.instrumentId,
      d: options.date,
      t_minute: tMinute,
    },
  )
  const row = result.getRowObjectsJson()[0] as Record<string, unknown>
  const visibleBars = Number(row.visible_bars)
  if (visibleBars === 0) {
    throw new Error(
      `${options.minute} is before the first visible session bar of ${options.date}`,
    )
  }

  const num = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value)
  const lastClose = num(row.last_close)
  const firstOpen = num(row.first_open)
  const sessionHigh = num(row.session_high)
  const sessionLow = num(row.session_low)
  const prevClose = num(row.prev_close)
  const pv = num(row.pv)
  const volume = num(row.v)
  const cumDv = num(row.cum_dv)
  const close30 = num(row.close_30)
  const close60 = num(row.close_60)
  const minuteVol = num(row.minute_vol)
  const returnCount = Number(row.return_count)
  const priorSessions = Number(row.prior_session_count)
  const meanCumDv = num(row.mean_cum_dv)
  const vwap = pv !== null && volume !== null && volume > 0 ? pv / volume : null
  // Annualization: 390 regular minutes per day, 252 days per year.
  const minuteAnn = Math.sqrt(session.regularMinutes * 252)

  const ratio = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : a / b - 1

  const values: Record<SessionMetricId, number | null> = {
    last_price: lastClose,
    cum_dollar_volume: cumDv,
    minutes_since_open: visibleBars,
    session_fraction: Math.min(1, visibleBars / session.regularMinutes),
    gap_at_open: ratio(firstOpen, prevClose),
    session_ret: ratio(lastClose, firstOpen),
    ret_from_prev_close: ratio(lastClose, prevClose),
    vwap_dist: ratio(lastClose, vwap),
    session_range_pos:
      lastClose === null || sessionHigh === null || sessionLow === null ||
      sessionHigh === sessionLow
        ? null
        : (lastClose - sessionLow) / (sessionHigh - sessionLow),
    session_high_dist: ratio(lastClose, sessionHigh),
    session_low_dist: ratio(lastClose, sessionLow),
    range_pct_so_far:
      sessionHigh === null || sessionLow === null || prevClose === null ||
      prevClose === 0
        ? null
        : (sessionHigh - sessionLow) / prevClose,
    ret_30m: ratio(lastClose, close30),
    ret_60m: ratio(lastClose, close60),
    session_vol:
      minuteVol === null || returnCount < 21 ? null : minuteVol * minuteAnn,
    up_minutes_share: returnCount < 21 ? null : num(row.up_share),
    rvol_pace:
      priorSessions < 5 || meanCumDv === null || meanCumDv === 0 || cumDv === null
        ? null
        : cumDv / meanCumDv,
  }

  const metrics = sessionMetricsCatalog.map((definition): SessionMetricAt => {
    let value: number | null = values[definition.id]
    let reason: MetricReason | null = null

    if (visibleBars < definition.min_bars) {
      value = null
      reason = 'insufficient_window'
    } else if (definition.id === 'rvol_pace' && priorSessions < 5) {
      value = null
      reason = 'insufficient_window'
    } else if (value === null) {
      reason = 'undefined_input'
    }

    return {
      id: definition.id,
      family: definition.family,
      value,
      bars_available: visibleBars,
      reason,
      unit: definition.unit,
    }
  })

  return {
    t: { date: options.date, minute: options.minute },
    available_at: 'minute',
    visible_bars: visibleBars,
    prior_sessions: priorSessions,
    prev_close_date:
      row.prev_close_date === null || row.prev_close_date === undefined
        ? null
        : String(row.prev_close_date),
    metrics,
  }
}
