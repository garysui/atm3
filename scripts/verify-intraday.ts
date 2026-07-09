import { formatTable } from '../core/format.ts'
import { openDatabase } from '../server/db.ts'

// Cross-SOURCE truth check: the minute flat files and the grouped-daily REST
// bars are independent vendor products describing the same sessions.
// Learned vendor semantics (2026-07-09, from this check's first runs), the
// doctrine: DAILY bars are authoritative for official OHLC; MINUTE bars are
// authoritative for intraday paths. Neither derives the other, because
// intraday aggregation excludes condition-coded prints:
// - Volume: sum(minute) <= daily by construction (blocks/late reports are
//   daily-only). HARD INVARIANT — zero violations required. Median ratio
//   baseline ~0.91.
// - Close: the auction print opens the 16:00 ET minute where an auction
//   exists (CAT 2026-07-07: 16:00 bar open 940.12 = daily close, its close
//   drifts to 929.573 on 8k late shares); micro-caps' official closes are
//   often condition-coded prints absent from the minute tape entirely.
//   MONITORED BASELINE, not a gate — 2026-07-09: ~93.5% within tolerance
//   with an auction bar, ~71% without, disagreement concentrated in
//   sub-$5 and sparse names. Investigate if these drift materially.
const db = await openDatabase()

try {
  await db.connection.run(`
    create or replace temp table t_minute_day as
    select
      instrument_id,
      market_date,
      sum(volume) as minute_volume,
      max_by(open, window_start_utc) filter (
        (window_start_utc at time zone 'America/New_York')
          = market_date + interval 16 hours
      ) as auction_open,
      max_by(close, window_start_utc) filter (
        (window_start_utc at time zone 'America/New_York')
          < market_date + interval 16 hours
      ) as last_regular_close,
      count(*) as minute_bars
    from facts.bars_minute
    group by instrument_id, market_date
  `)

  await db.connection.run(`
    create or replace temp table t_compare as
    select
      d.symbol_as_traded as symbol,
      d.market_date,
      d.close as daily_close,
      coalesce(m.auction_open, m.last_regular_close) as regular_close,
      m.auction_open is not null as has_auction_bar,
      d.volume as daily_volume,
      m.minute_volume,
      m.minute_bars,
      m.minute_volume / nullif(d.volume, 0) as volume_ratio,
      abs(coalesce(m.auction_open, m.last_regular_close) - d.close)
        > greatest(0.01, d.close * 0.001) as close_mismatch,
      m.minute_volume > coalesce(d.volume, 0) * 1.02 + 100
        as volume_violation
    from computed.canonical_bars_daily d
    join t_minute_day m using (instrument_id, market_date)
  `)

  const summary = await db.connection.runAndReadAll(`
    select
      count(*) as instrument_days,
      count(distinct market_date) as dates,
      count(*) filter (close_mismatch) as close_mismatches,
      round(100.0 * (1 - count(*) filter (close_mismatch) / count(*)), 4)
        as close_match_pct,
      count(*) filter (volume_violation) as volume_violations,
      round(median(volume_ratio), 4) as volume_ratio_median,
      round(quantile_cont(volume_ratio, 0.10), 4) as volume_ratio_p10
    from t_compare
  `)
  console.log('Minute flat files vs grouped daily bars (cross-source)\n')
  console.log(formatTable(summary.getRowObjectsJson() as never))

  // Where disagreement lives: auction presence × trading continuity.
  const segments = await db.connection.runAndReadAll(`
    select
      case when has_auction_bar then 'auction bar'
           else 'no auction bar' end as close_source,
      case when minute_bars >= 390 then 'continuous (>=390 bars)'
           when minute_bars >= 100 then 'intermittent (100-389)'
           else 'sparse (<100 bars)' end as trading_pattern,
      count(*) as instrument_days,
      count(*) filter (close_mismatch) as close_mismatches,
      round(100.0 * (1 - count(*) filter (close_mismatch) / count(*)), 3)
        as close_match_pct,
      round(median(volume_ratio), 4) as volume_ratio_median
    from t_compare
    group by 1, 2
    order by 1, 2
  `)
  console.log('\nClose-agreement baselines by segment (monitored, not a gate)')
  console.log(formatTable(segments.getRowObjectsJson() as never))

  const worstClose = await db.connection.runAndReadAll(`
    select symbol, cast(market_date as varchar) as market_date,
           round(regular_close, 4) as regular_close, daily_close,
           minute_bars
    from t_compare
    where close_mismatch
    order by abs(regular_close - daily_close) desc
    limit 10
  `)
  console.log('\nWorst close mismatches (if any)')
  console.log(formatTable(worstClose.getRowObjectsJson() as never))

  const violations = await db.connection.runAndReadAll(`
    select symbol, cast(market_date as varchar) as market_date,
           cast(minute_volume as bigint) as minute_volume,
           cast(daily_volume as bigint) as daily_volume
    from t_compare
    where volume_violation
    order by minute_volume - daily_volume desc
    limit 10
  `)
  console.log('\nVolume violations — minute > daily is impossible (if any)')
  console.log(formatTable(violations.getRowObjectsJson() as never))
} finally {
  db.closeSync()
}
