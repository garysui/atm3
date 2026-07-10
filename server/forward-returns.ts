import type { DuckDBConnection } from '@duckdb/node-api'
import type { AdjustmentPolicy } from '../core/adjustments.ts'

export const defaultForwardHorizons = [1, 5, 21, 63, 126, 252] as const

export type ForwardEntryBasis = 'next_open' | 't_close'

// no_entry_bar: the entry bar does not exist by the horizon date.
// beyond_calendar: the horizon date is past the known trading calendar —
// the row is present (never silently dropped) with a null date and return.
export type ForwardReturnReason = 'no_entry_bar' | 'beyond_calendar'

export type ForwardReturnRow = {
  horizon: number
  date: string | null
  ret: number | null
  mae: number | null
  mfe: number | null
  delisted: boolean
  stale: boolean
  bars_used: number
  reason?: ForwardReturnReason
}

export function beyondCalendarRow(horizon: number): ForwardReturnRow {
  return {
    horizon,
    date: null,
    ret: null,
    mae: null,
    mfe: null,
    delisted: false,
    stale: false,
    bars_used: 0,
    reason: 'beyond_calendar',
  }
}

export class ViewAtTDateError extends Error {
  readonly previousDate: string | null
  readonly nextDate: string | null

  constructor(t: string, previousDate: string | null, nextDate: string | null) {
    super(
      `${t} is not an instrument bar date` +
        ` (previous: ${previousDate ?? 'none'}, next: ${nextDate ?? 'none'})`,
    )
    this.name = 'ViewAtTDateError'
    this.previousDate = previousDate
    this.nextDate = nextDate
  }
}

function validatedHorizons(horizons?: readonly number[]): number[] {
  const values = [...(horizons ?? defaultForwardHorizons)]
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value <= 0)
  ) {
    throw new Error('horizons must contain positive integers')
  }
  if (new Set(values).size !== values.length) {
    throw new Error('horizons must not contain duplicates')
  }
  return values.sort((a, b) => a - b)
}

export async function forwardReturns(
  connection: DuckDBConnection,
  options: {
    instrumentId: string
    marketScope: string
    t: string
    horizons?: readonly number[]
    entryBasis?: ForwardEntryBasis
    policy: AdjustmentPolicy
    adjustmentAnchor?: string | null
  },
): Promise<ForwardReturnRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.t)) {
    throw new Error('t must be YYYY-MM-DD')
  }

  const horizons = validatedHorizons(options.horizons)
  const entryBasis = options.entryBasis ?? 'next_open'
  const horizonValues = horizons.map((value) => `(${value})`).join(', ')
  const validation = await connection.runAndReadAll(
    `
      with horizons(horizon) as (values ${horizonValues}),
      scoped as (
        select instrument_id
        from facts.instruments
        where instrument_id = cast($instrument_id as uuid)
          and primary_market_scope = $market_scope
      ),
      calendar as (
        select min(calendar_id) as calendar_id
        from facts.exchanges
        where market_scope = $market_scope
      ),
      ranked_dates as (
        select
          market_date,
          row_number() over (order by market_date) as horizon
        from facts.trading_days, calendar
        where facts.trading_days.calendar_id = calendar.calendar_id
          and is_open
          and market_date > cast($t as date)
      ),
      targets as (
        select r.market_date, r.horizon
        from ranked_dates r join horizons h using (horizon)
      ),
      instrument_bars as (
        select market_date
        from computed.canonical_bars_daily
        where instrument_id = cast($instrument_id as uuid)
      )
      select
        exists(select 1 from scoped) as scope_matches,
        (select calendar_id from calendar) as calendar_id,
        exists(
          select 1 from instrument_bars where market_date = cast($t as date)
        ) as t_is_bar,
        cast((select max(market_date) from instrument_bars
              where market_date < cast($t as date)) as varchar) as previous_date,
        cast((select min(market_date) from instrument_bars
              where market_date > cast($t as date)) as varchar) as next_date,
        count(targets.market_date) as target_count,
        cast(max(targets.market_date) as varchar) as max_target
      from targets
    `,
    {
      instrument_id: options.instrumentId,
      market_scope: options.marketScope,
      t: options.t,
    },
  )
  const checked = validation.getRowObjectsJson()[0]
  if (checked?.scope_matches !== true) {
    throw new Error(
      `instrument ${options.instrumentId} is not in ${options.marketScope}`,
    )
  }
  if (checked.calendar_id === null || checked.calendar_id === undefined) {
    throw new Error(`no trading calendar for ${options.marketScope}`)
  }
  if (checked.t_is_bar !== true) {
    throw new ViewAtTDateError(
      options.t,
      checked.previous_date === null ? null : String(checked.previous_date),
      checked.next_date === null ? null : String(checked.next_date),
    )
  }
  // Horizons past the known calendar are reported per-row (beyond_calendar),
  // never a wholesale failure: at a recent T the near horizons still resolve.
  const coveredCount = Number(checked.target_count)
  const covered = horizons.slice(0, coveredCount)
  const beyond = horizons.slice(coveredCount).map(beyondCalendarRow)
  if (coveredCount === 0) {
    return beyond
  }

  const maxTarget = String(checked.max_target)
  const anchor = options.adjustmentAnchor ?? maxTarget
  if (anchor < maxTarget) {
    throw new Error(`adjustment anchor ${anchor} is before horizon ${maxTarget}`)
  }

  const coveredValues = covered.map((value) => `(${value})`).join(', ')
  const result = await connection.runAndReadAll(
    `
      with horizons(horizon) as (values ${coveredValues}),
      inst as (
        select delisted_date
        from facts.instruments
        where instrument_id = cast($instrument_id as uuid)
      ),
      calendar as (
        select min(calendar_id) as calendar_id
        from facts.exchanges where market_scope = $market_scope
      ),
      ranked_dates as (
        select
          market_date,
          row_number() over (order by market_date) as horizon
        from facts.trading_days, calendar
        where facts.trading_days.calendar_id = calendar.calendar_id
          and is_open
          and market_date > cast($t as date)
      ),
      targets as (
        select r.market_date, r.horizon
        from ranked_dates r join horizons h using (horizon)
      ),
      full_bars as (
        select * from computed.canonical_bars_daily
        where instrument_id = cast($instrument_id as uuid)
      ),
      adjusted as (
        select * from computed.adjusted_bars_for(
          cast($instrument_id as uuid), $policy,
          as_of := cast($anchor as date)
        )
      ),
      entry_date as (
        select case
          when $entry_basis = 't_close' then cast($t as date)
          else (select min(market_date) from full_bars
                where market_date > cast($t as date))
        end as market_date
      ),
      entry as (
        select
          e.market_date,
          case when $entry_basis = 't_close' then a.close else a.open end
            as price
        from entry_date e
        left join adjusted a using (market_date)
      )
      select
        t.horizon,
        cast(t.market_date as varchar) as date,
        case
          when e.market_date is null or e.market_date > t.market_date then null
          else valuation.close / e.price - 1
        end as ret,
        case
          when e.market_date is null or e.market_date > t.market_date
            or path.path_bars = 0 then null
          else path.min_low / e.price - 1
        end as mae,
        case
          when e.market_date is null or e.market_date > t.market_date
            or path.path_bars = 0 then null
          else path.max_high / e.price - 1
        end as mfe,
        -- delisted comes from IDENTITY, never inferred from missing bars: a
        -- horizon past the last known bar of an active instrument is a stale
        -- (carried) valuation, not a delisting.
        case
          when e.market_date is null or e.market_date > t.market_date then false
          when valuation.market_date < t.market_date
            and inst.delisted_date is not null
            and inst.delisted_date <= t.market_date then true
          else false
        end as delisted,
        case
          when e.market_date is null or e.market_date > t.market_date then false
          when valuation.market_date < t.market_date
            and not (inst.delisted_date is not null
                     and inst.delisted_date <= t.market_date) then true
          else false
        end as stale,
        case
          when e.market_date is null or e.market_date > t.market_date then 0
          else coverage.bars_used
        end as bars_used,
        case
          when e.market_date is null or e.market_date > t.market_date
            then 'no_entry_bar'
          else null
        end as reason
      from targets t
      cross join entry e
      cross join inst
      left join lateral (
        select market_date, close
        from adjusted a
        where a.market_date <= t.market_date
        order by a.market_date desc
        limit 1
      ) valuation on true
      left join lateral (
        select
          count(*) as path_bars,
          min(a.low) as min_low,
          max(a.high) as max_high
        from adjusted a
        where a.market_date > e.market_date
          and a.market_date <= t.market_date
      ) path on true
      left join lateral (
        select count(*) as bars_used
        from adjusted a
        where a.market_date >= e.market_date
          and a.market_date <= valuation.market_date
      ) coverage on true
      order by t.horizon
    `,
    {
      instrument_id: options.instrumentId,
      market_scope: options.marketScope,
      t: options.t,
      policy: options.policy,
      anchor,
      entry_basis: entryBasis,
    },
  )

  const rows = result.getRowObjectsJson().map((row) => ({
    horizon: Number(row.horizon),
    date: String(row.date),
    ret: row.ret === null ? null : Number(row.ret),
    mae: row.mae === null ? null : Number(row.mae),
    mfe: row.mfe === null ? null : Number(row.mfe),
    delisted: Boolean(row.delisted),
    stale: Boolean(row.stale),
    bars_used: Number(row.bars_used),
    ...(row.reason === null || row.reason === undefined
      ? {}
      : { reason: String(row.reason) as ForwardReturnReason }),
  }))
  return [...rows, ...beyond]
}
