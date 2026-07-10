import type { DuckDBConnection } from '@duckdb/node-api'
import {
  metricsCatalog,
  type MetricFamily,
  type MetricId,
} from '../core/metrics-catalog.ts'
import { ViewAtTDateError } from './forward-returns.ts'
import { contextAt } from './context-at.ts'

export type MetricReason =
  | 'insufficient_window'
  | 'undefined_input'
  | 'no_market_baseline'
  | 'no_known_event'

// Event metrics whose null means "no such event is knowable at T" — a
// distinct honest state, not a computation failure.
const noKnownEventIds = new Set<string>([
  'days_since_split',
  'days_since_dividend',
  'declared_ex_days',
])

export type MetricAt = {
  id: MetricId
  family: MetricFamily
  value: number | string | boolean | null
  bars_available: number
  reason: MetricReason | null
  unit: string
}

export type MetricsAtResult = {
  t: string
  available_at: 'close'
  metrics: MetricAt[]
  context_baselines: null | {
    spy: string | null
    tracking: string | null
  }
}

async function assertValidT(
  connection: DuckDBConnection,
  instrumentId: string,
  marketScope: string,
  t: string,
): Promise<void> {
  const result = await connection.runAndReadAll(
    `
      with bars as (
        select market_date
        from computed.canonical_bars_daily
        where instrument_id = cast($instrument_id as uuid)
      )
      select
        exists(
          select 1 from facts.instruments
          where instrument_id = cast($instrument_id as uuid)
            and primary_market_scope = $market_scope
        ) as scope_matches,
        exists(
          select 1 from bars where market_date = cast($t as date)
        ) as t_is_bar,
        cast((select max(market_date) from bars
              where market_date < cast($t as date)) as varchar)
          as previous_date,
        cast((select min(market_date) from bars
              where market_date > cast($t as date)) as varchar)
          as next_date
    `,
    { instrument_id: instrumentId, market_scope: marketScope, t },
  )
  const row = result.getRowObjectsJson()[0]
  if (row?.scope_matches !== true) {
    throw new Error(`instrument ${instrumentId} is not in ${marketScope}`)
  }
  if (row.t_is_bar !== true) {
    throw new ViewAtTDateError(
      t,
      row.previous_date === null ? null : String(row.previous_date),
      row.next_date === null ? null : String(row.next_date),
    )
  }
}

function mappedValue(value: unknown): number | string | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^-?\d+(\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return Number(value)
  }
  return String(value)
}

export async function metricsAt(
  connection: DuckDBConnection,
  options: { instrumentId: string; marketScope: string; t: string },
): Promise<MetricsAtResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.t)) {
    throw new Error('t must be YYYY-MM-DD')
  }
  await assertValidT(
    connection,
    options.instrumentId,
    options.marketScope,
    options.t,
  )

  const result = await connection.runAndReadAll(
    `
      with adjusted as (
        select * from computed.adjusted_bars_for(
          cast($instrument_id as uuid), 'split_dividend',
          as_of := cast($t as date)
        )
      ),
      series as (
        select
          a.market_date,
          a.open as ao, a.high as ah, a.low as al, a.close as ac,
          r.open as o, r.high as h, r.low as l, r.close as c, r.volume as v
        from adjusted a
        join computed.canonical_bars_daily r
          on r.instrument_id = a.instrument_id
         and r.market_date = a.market_date
      ),
      indexed as (
        select
          *,
          row_number() over (order by market_date desc) - 1 as idx,
          count(*) over () as total_bars,
          lead(ac) over (order by market_date desc) as prev_ac
        from series
      ),
      calc as (
        select
          *,
          ac / nullif(prev_ac, 0) - 1 as r,
          ln(ac / nullif(prev_ac, 0)) as lr,
          ao / nullif(prev_ac, 0) - 1 as gap_i,
          c * v as dv,
          greatest(ah, prev_ac) - least(al, prev_ac) as tr
        from indexed
      ),
      direction as (
        select sign(max(r) filter (where idx = 0)) as current_direction
        from calc
      ),
      streak as (
        select case
          when d.current_direction = 0 or d.current_direction is null then 0
          else d.current_direction * coalesce(
            min(idx) filter (
              where r is not null and sign(r) <> d.current_direction
            ),
            count(*) filter (where r is not null)
          )
        end as up_streak
        from calc cross join direction d
        group by d.current_direction
      ),
      calendar as (
        select min(calendar_id) as calendar_id
        from facts.exchanges where market_scope = $market_scope
      ),
      calendar_63 as (
        select market_date
        from facts.trading_days, calendar
        where facts.trading_days.calendar_id = calendar.calendar_id
          and is_open and market_date <= cast($t as date)
        order by market_date desc
        limit 63
      ),
      calendar_stats as (
        select
          count(*) as calendar_days,
          count(*) filter (where exists (
            select 1 from facts.symbols s
            where s.instrument_id = cast($instrument_id as uuid)
              and s.market_scope = $market_scope
              and (s.valid_from is null or d.market_date >= s.valid_from)
              and (s.valid_to is null or d.market_date < s.valid_to)
          )) as listed_days,
          count(*) filter (
            where exists (
              select 1 from facts.symbols s
              where s.instrument_id = cast($instrument_id as uuid)
                and s.market_scope = $market_scope
                and (s.valid_from is null or d.market_date >= s.valid_from)
                and (s.valid_to is null or d.market_date < s.valid_to)
            )
            and not exists (
              select 1 from series b where b.market_date = d.market_date
            )
          ) as missing_days
        from calendar_63 d
      ),
      event_dates as (
        select
          max(ex_date) filter (
            where action_type in ('split', 'stock_dividend')
              and ex_date <= cast($t as date)
          ) as last_split,
          max(ex_date) filter (
            where action_type = 'cash_dividend'
              and ex_date <= cast($t as date)
          ) as last_dividend,
          min(ex_date) filter (
            where ex_date > cast($t as date)
              and declaration_date <= cast($t as date)
          ) as next_known_ex
        from facts.corporate_actions
        where instrument_id = cast($instrument_id as uuid)
      ),
      boundary as (
        select min(market_date) as first_date
        from calc where idx between 0 and 251
      ),
      dividend_yield as (
        select sum(cash.cash_amount / previous.close) as value
        from computed.dividend_cash_by_exdate cash
        cross join boundary
        left join lateral (
          select c as close
          from series
          where market_date < cash.ex_date
          order by market_date desc
          limit 1
        ) previous on true
        where cash.instrument_id = cast($instrument_id as uuid)
          and cash.ex_date between boundary.first_date and cast($t as date)
          and cash.cash_amount > 0 and previous.close > 0
      ),
      aggregates as (
        select
          max(total_bars) as total_bars,
          max(c) filter (where idx = 0) as c0,
          max(o) filter (where idx = 0) as o0,
          max(h) filter (where idx = 0) as h0,
          max(l) filter (where idx = 0) as l0,
          max(ac) filter (where idx = 0) as ac0,
          max(ac) filter (where idx = 1) as ac1,
          max(ac) filter (where idx = 5) as ac5,
          max(ac) filter (where idx = 21) as ac21,
          max(ac) filter (where idx = 63) as ac63,
          max(ac) filter (where idx = 126) as ac126,
          max(ac) filter (where idx = 252) as ac252,
          max(ao) filter (where idx = 0) as ao0,
          avg(dv) filter (where idx between 1 and 21) as adv21_before,
          count(dv) filter (where idx between 1 and 21) as adv21_count,
          avg(case when abs(gap_i) > 0.02 then 1.0 else 0.0 end)
            filter (where idx between 0 and 62) as gap_freq_63d,
          median(abs(gap_i)) filter (where idx between 0 and 62)
            as abs_gap_med_63d,
          avg(ac) filter (where idx between 0 and 19) as sma20,
          avg(ac) filter (where idx between 0 and 49) as sma50,
          avg(ac) filter (where idx between 0 and 199) as sma200,
          max(ah) filter (where idx between 0 and 251) as high252,
          min(al) filter (where idx between 0 and 251) as low252,
          max(ac) filter (where idx between 0 and 251) as close_high252,
          avg(case when r > 0 then 1.0 else 0.0 end)
            filter (where idx between 0 and 20) as up_days_21d,
          stddev_samp(lr) filter (where idx between 0 and 20) * sqrt(252)
            as vol_21d,
          stddev_samp(lr) filter (where idx between 0 and 62) * sqrt(252)
            as vol_63d,
          sqrt(
            avg(power(ln(h / nullif(l, 0)), 2))
              filter (where idx between 0 and 20) / (4 * ln(2))
          ) * sqrt(252) as parkinson_21d,
          avg(tr) filter (where idx between 0 and 13) as atr14,
          max(abs(r)) filter (where idx between 0 and 20)
            as max_abs_ret_21d,
          max(dv) filter (where idx = 0) as dv0,
          avg(dv) filter (where idx between 0 and 4) as dv5,
          avg(dv) filter (where idx between 0 and 62) as dv63,
          count(dv) filter (where idx between 0 and 62) as dv63_count,
          count(dv) filter (where idx between 0 and 20) as dv21_count,
          min(dv) filter (where idx between 0 and 20) as dv21_min,
          avg(abs(r) / nullif(dv, 0)) filter (where idx between 0 and 20)
            * 1000000 as amihud_21d
        from calc
      )
      select
        a.total_bars,
        cs.listed_days as calendar_listed_days,
        a.c0 as close_raw,
        case when a.adv21_count = 21 and a.adv21_before > 0
          then log10(a.adv21_before) end as dollar_adv21_log10,
        a.total_bars as listed_bars,
        exists(
          select 1 from facts.symbols s
          where s.instrument_id = cast($instrument_id as uuid)
            and s.market_scope = $market_scope
            and (s.valid_from is null or cast($t as date) >= s.valid_from)
            and (s.valid_to is null or cast($t as date) < s.valid_to)
        ) as active_at_t,
        a.ac0 / nullif(a.ac1, 0) - 1 as ret_1d,
        a.ac0 / nullif(a.ac5, 0) - 1 as ret_5d,
        a.ac0 / nullif(a.ac21, 0) - 1 as ret_21d,
        a.ac0 / nullif(a.ac63, 0) - 1 as ret_63d,
        a.ac0 / nullif(a.ac126, 0) - 1 as ret_126d,
        a.ac0 / nullif(a.ac252, 0) - 1 as ret_252d,
        a.ac21 / nullif(a.ac252, 0) - 1 as mom_12_1,
        a.c0 / nullif(a.o0, 0) - 1 as ret_intraday,
        a.ao0 / nullif(a.ac1, 0) - 1 as gap,
        a.gap_freq_63d,
        a.abs_gap_med_63d,
        a.ac0 / nullif(a.sma20, 0) - 1 as close_vs_sma20,
        a.ac0 / nullif(a.sma50, 0) - 1 as close_vs_sma50,
        a.ac0 / nullif(a.sma200, 0) - 1 as close_vs_sma200,
        a.sma50 / nullif(a.sma200, 0) - 1 as sma50_vs_sma200,
        a.ac0 / nullif(a.high252, 0) - 1 as high_252_dist,
        a.ac0 / nullif(a.low252, 0) - 1 as low_252_dist,
        a.ac0 / nullif(a.close_high252, 0) - 1 as drawdown_252,
        streak.up_streak,
        a.up_days_21d,
        a.vol_21d,
        a.vol_63d,
        a.vol_21d / nullif(a.vol_63d, 0) as vol_ratio_21_63,
        a.parkinson_21d,
        a.atr14 / nullif(a.ac0, 0) as atr_pct_14,
        a.max_abs_ret_21d,
        (a.h0 - a.l0) / nullif(a.c0, 0) as range_pct,
        (2 * a.c0 - a.h0 - a.l0) / nullif(a.h0 - a.l0, 0) as clv,
        case when a.adv21_count = 21 and a.adv21_before > 0
          then a.dv0 / a.adv21_before end as rvol_21d,
        case when a.dv63_count = 63 and a.dv63 > 0
          then a.dv5 / a.dv63 end as volume_trend_5_63,
        case when a.dv21_count = 21 and a.dv21_min > 0
          then a.amihud_21d end as amihud_21d,
        case when cs.calendar_days = 63 and cs.listed_days = 63
          then cs.missing_days / 63.0 end as suspended_days_63d,
        case when e.last_split is not null then (
          select count(*) from series b where b.market_date > e.last_split
        ) end as days_since_split,
        case when e.last_dividend is not null then (
          select count(*) from series b where b.market_date > e.last_dividend
        ) end as days_since_dividend,
        case when e.next_known_ex is not null then (
          select count(*)
          from facts.trading_days d, calendar c
          where d.calendar_id = c.calendar_id and d.is_open
            and d.market_date > cast($t as date)
            and d.market_date <= e.next_known_ex
        ) end as declared_ex_days,
        dy.value as div_yield_ttm
      from aggregates a
      cross join streak
      cross join calendar_stats cs
      cross join event_dates e
      cross join dividend_yield dy
    `,
    {
      instrument_id: options.instrumentId,
      market_scope: options.marketScope,
      t: options.t,
    },
  )
  const row = result.getRowObjectsJson()[0] as Record<string, unknown>
  const barsAvailable = Number(row.total_bars)
  const calendarListedDays = Number(row.calendar_listed_days)

  const metrics = metricsCatalog.map((definition): MetricAt => {
    let reason: MetricReason | undefined
    let value = mappedValue(row[definition.id])

    if (
      definition.family === 'context' &&
      options.marketScope === 'cn_stocks'
    ) {
      reason = 'no_market_baseline'
      value = null
    } else if (barsAvailable < definition.min_bars) {
      reason = 'insufficient_window'
      value = null
    } else if (
      definition.id === 'suspended_days_63d' &&
      calendarListedDays < 63
    ) {
      reason = 'insufficient_window'
      value = null
    } else if (definition.family === 'context') {
      reason = 'undefined_input'
      value = null
    } else if (value === null && noKnownEventIds.has(definition.id)) {
      reason = 'no_known_event'
    } else if (value === null) {
      reason = 'undefined_input'
    }

    return {
      id: definition.id,
      family: definition.family,
      value,
      bars_available: barsAvailable,
      reason: reason ?? null,
      unit: definition.unit,
    }
  })

  const context = options.marketScope === 'us_stocks'
    ? await contextAt(connection, {
        instrumentId: options.instrumentId,
        t: options.t,
      })
    : null
  if (context) {
    for (const metric of metrics) {
      const contextValue = context.metrics[metric.id]
      if (contextValue && metric.reason !== 'insufficient_window') {
        metric.value = contextValue.value
        metric.bars_available = contextValue.bars_available
        metric.reason = contextValue.reason
      }
    }
  }

  return {
    t: options.t,
    available_at: 'close',
    metrics,
    context_baselines: context?.baselines ?? null,
  }
}
