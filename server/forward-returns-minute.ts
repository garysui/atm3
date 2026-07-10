import type { DuckDBConnection } from '@duckdb/node-api'
import {
  assertMinuteCoverage,
  parseSessionMinute,
  sessionWindowByScope,
} from './metrics-at-minute.ts'

// Forward horizons from an intraday entry — the owner's holding
// conventions: hold to the close, to the next open, to the next day's
// close, to the third day's close. All values share one adjustment anchor
// (the max resolvable target), so ratios are anchor-invariant exactly like
// the daily forward primitive.
export const minuteForwardHorizons = [
  'to_close',
  'next_open',
  '1d',
  '3d',
] as const

export type MinuteForwardHorizon = (typeof minuteForwardHorizons)[number]

export type MinuteForwardReason = 'no_entry_bar' | 'beyond_calendar'

export type MinuteForwardRow = {
  horizon: MinuteForwardHorizon
  date: string | null
  ret: number | null
  mae: number | null
  mfe: number | null
  delisted: boolean
  stale: boolean
  bars_used: number
  reason?: MinuteForwardReason
}

type DailyBar = {
  date: string
  open: number
  close: number
  high: number
  low: number
  cum_price_factor: number
}

function emptyRow(
  horizon: MinuteForwardHorizon,
  reason?: MinuteForwardReason,
): MinuteForwardRow {
  return {
    horizon,
    date: null,
    ret: null,
    mae: null,
    mfe: null,
    delisted: false,
    stale: false,
    bars_used: 0,
    ...(reason === undefined ? {} : { reason }),
  }
}

export async function forwardReturnsFromMinute(
  connection: DuckDBConnection,
  options: {
    instrumentId: string
    marketScope: string
    date: string
    minute: string
  },
): Promise<MinuteForwardRow[]> {
  const session = sessionWindowByScope[options.marketScope]
  if (!session) {
    throw new Error(`no minute data source for ${options.marketScope}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error('date must be YYYY-MM-DD')
  }
  const tMinute = parseSessionMinute(options.minute)
  await assertMinuteCoverage(connection, options)

  // Targets from the scope calendar, delisting from identity, the next
  // tradable bar from the instrument's own tape.
  const shape = await connection.runAndReadAll(
    `
      with calendar as (
        select min(calendar_id) as calendar_id
        from facts.exchanges where market_scope = $market_scope
      ),
      frontier as (
        -- Same data-frontier bound as the daily forward: future calendar
        -- rows exist only for known special days, so open-day counting past
        -- the frontier would leap across unmaterialized dates.
        select max(market_date) as last_date
        from facts.bars_daily where market_scope = $market_scope
      ),
      future_days as (
        select market_date,
               row_number() over (order by market_date) as n
        from facts.trading_days, calendar, frontier
        where facts.trading_days.calendar_id = calendar.calendar_id
          and is_open and market_date > cast($d as date)
          and market_date <= frontier.last_date
      )
      select
        cast((select market_date from future_days where n = 1) as varchar)
          as d1_target,
        cast((select market_date from future_days where n = 3) as varchar)
          as d3_target,
        cast((
          select delisted_date from facts.instruments
          where instrument_id = cast($instrument_id as uuid)
        ) as varchar) as delisted_date,
        cast((
          select min(market_date) from computed.canonical_bars_daily
          where instrument_id = cast($instrument_id as uuid)
            and market_date > cast($d as date)
        ) as varchar) as next_bar_date
    `,
    {
      instrument_id: options.instrumentId,
      market_scope: options.marketScope,
      d: options.date,
    },
  )
  const meta = shape.getRowObjectsJson()[0] as Record<string, unknown>
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value)
  const d1Target = text(meta.d1_target)
  const d3Target = text(meta.d3_target)
  const delistedDate = text(meta.delisted_date)
  const nextBarDate = text(meta.next_bar_date)

  const anchorCandidates = [options.date, d1Target, d3Target, nextBarDate]
    .filter((value): value is string => value !== null)
    .sort()
  const anchor = anchorCandidates.at(-1) as string

  const dailyResult = await connection.runAndReadAll(
    `
      select cast(market_date as varchar) as date, open, close, high, low,
             cum_price_factor
      from computed.adjusted_bars_for(
        cast($instrument_id as uuid), 'split_dividend',
        as_of := cast($anchor as date)
      )
      where market_date >= cast($d as date)
      order by market_date
    `,
    { instrument_id: options.instrumentId, d: options.date, anchor },
  )
  const dailyRows = dailyResult.getRowObjectsJson().map(
    (row): DailyBar => ({
      date: String(row.date),
      open: Number(row.open),
      close: Number(row.close),
      high: Number(row.high),
      low: Number(row.low),
      cum_price_factor: Number(row.cum_price_factor),
    }),
  )

  // RAW minute prices scaled by day D's DAILY cumulative factor under the
  // shared anchor. The minute macro cannot be used here: its series-anchor
  // rule stops at the minute tape's last bar, so an event between D and the
  // horizon that postdates the (days-old) minute tape would adjust the daily
  // valuation but not the minute entry — inconsistent bases. Every minute of
  // one day shares the day's factor, so scaling raw minutes by the daily
  // factor is exact and consistent by construction.
  const minuteResult = await connection.runAndReadAll(
    `
      select et_minute, open, high, low
      from (
        select
          (extract(hour from window_start_utc at time zone '${session.timezone}') * 60
           + extract(minute from window_start_utc at time zone '${session.timezone}'))
            as et_minute,
          open, high, low
        from facts.bars_minute
        where instrument_id = cast($instrument_id as uuid)
          and market_date = cast($d as date)
      )
      where et_minute between ${session.open} and ${session.close}
      order by et_minute
    `,
    { instrument_id: options.instrumentId, d: options.date },
  )
  const dayBarForFactor = dailyRows.find((bar) => bar.date === options.date)
  const dayFactor = dayBarForFactor?.cum_price_factor ?? 1
  const minuteRows = minuteResult.getRowObjectsJson().map((row) => ({
    et_minute: Number(row.et_minute),
    open: Number(row.open) * dayFactor,
    high: Number(row.high) * dayFactor,
    low: Number(row.low) * dayFactor,
  }))

  const entryBar = minuteRows.find((bar) => Number(bar.et_minute) >= tMinute)
  if (!entryBar) {
    return minuteForwardHorizons.map((horizon) =>
      emptyRow(horizon, 'no_entry_bar'),
    )
  }
  const entry = Number(entryBar.open)
  const entryMinute = Number(entryBar.et_minute)
  const pathAfterEntry = minuteRows.filter(
    (bar) => Number(bar.et_minute) > entryMinute,
  )
  const barsFromEntry = minuteRows.filter(
    (bar) => Number(bar.et_minute) >= entryMinute,
  ).length

  const dayBar = dailyRows.find((bar) => bar.date === options.date) ?? null
  const isDelistedBy = (target: string): boolean =>
    delistedDate !== null && delistedDate <= target

  const rows: MinuteForwardRow[] = []

  // to_close: the official close of D against the intraday entry, with the
  // remaining session minutes as the excursion path (interval (E, close]).
  if (dayBar === null) {
    // Minutes without a daily bar would violate the two-tapes invariant;
    // report a stale (unvaluable) row rather than pretending.
    rows.push({ ...emptyRow('to_close'), date: options.date, stale: true })
  } else {
    const lows = pathAfterEntry.map((bar) => Number(bar.low))
    const highs = pathAfterEntry.map((bar) => Number(bar.high))
    rows.push({
      horizon: 'to_close',
      date: options.date,
      ret: Number(dayBar.close) / entry - 1,
      mae: lows.length === 0 ? null : Math.min(...lows) / entry - 1,
      mfe: highs.length === 0 ? null : Math.max(...highs) / entry - 1,
      delisted: false,
      stale: false,
      bars_used: barsFromEntry,
    })
  }

  // next_open: the first tradable open after D, from the instrument's tape.
  const nextBar = dailyRows.find((bar) => bar.date > options.date) ?? null
  if (nextBar === null) {
    const delisted = delistedDate !== null
    rows.push({
      horizon: 'next_open',
      date: null,
      ret: null,
      mae: null,
      mfe: null,
      delisted,
      stale: !delisted,
      bars_used: 0,
    })
  } else {
    rows.push({
      horizon: 'next_open',
      date: nextBar.date,
      ret: Number(nextBar.open) / entry - 1,
      mae: null,
      mfe: null,
      delisted: false,
      stale: false,
      bars_used: 1,
    })
  }

  // 1d / 3d (next-day close and third-day close — the owner's holding
  // conventions): calendar targets; valuation carried from the last bar <=
  // target when the tape stops early (stale), delisting only from identity.
  for (const [horizon, target] of [
    ['1d', d1Target],
    ['3d', d3Target],
  ] as const) {
    if (target === null) {
      rows.push(emptyRow(horizon, 'beyond_calendar'))
      continue
    }
    const covered = dailyRows.filter((bar) => bar.date <= target)
    const valuation = covered.at(-1) ?? null
    if (valuation === null) {
      // No bar at or after D up to the target (D itself missing would violate
      // the minute-within-daily invariant; stay honest regardless).
      const delisted = isDelistedBy(target)
      rows.push({
        ...emptyRow(horizon),
        date: target,
        delisted,
        stale: !delisted,
      })
      continue
    }
    const carried = valuation.date < target
    const afterDay = covered.filter((bar) => bar.date > options.date)
    const lows = [
      ...pathAfterEntry.map((bar) => Number(bar.low)),
      ...afterDay.map((bar) => Number(bar.low)),
    ]
    const highs = [
      ...pathAfterEntry.map((bar) => Number(bar.high)),
      ...afterDay.map((bar) => Number(bar.high)),
    ]
    rows.push({
      horizon,
      date: target,
      ret: Number(valuation.close) / entry - 1,
      mae: lows.length === 0 ? null : Math.min(...lows) / entry - 1,
      mfe: highs.length === 0 ? null : Math.max(...highs) / entry - 1,
      delisted: carried && isDelistedBy(target),
      stale: carried && !isDelistedBy(target),
      bars_used: barsFromEntry + afterDay.length,
    })
  }

  return rows
}
