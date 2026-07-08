import path from 'node:path'
import { formatTable } from '../core/format.ts'
import { openDatabase } from '../server/db.ts'
import { env } from '../server/env.ts'

// Parity check (M4 done-when): our `split` policy against Polygon's
// adjusted=true grouped files, which are split-adjusted by the vendor.
// Vendor-adjusted data is used ONLY here — never as an input to facts.
// Joined on (ticker, date) so the comparison is independent of our identity
// layer. Vendor prices are rounded, so the tolerance is
// max($0.01, 0.05% of price).
const db = await openDatabase()
const adjustedGlob = path
  .join(
    path.resolve(env.ATM3_DATA_DIR),
    'raw/polygon/grouped_daily_adjusted/*/*.json.gz',
  )
  .replaceAll("'", "''")

try {
  await db.connection.run(`
    create or replace temp table t_parity as
    with theirs as (
      select
        b->>'$.T' as symbol,
        cast(regexp_extract(filename, 'date=(\\d{4}-\\d{2}-\\d{2})', 1) as date)
          as market_date,
        cast(b->>'$.c' as double) as close_theirs,
        try_cast(b->>'$.v' as double) as volume_theirs
      from (
        select unnest(results) as b, filename
        from read_json('${adjustedGlob}',
                       columns = {results: 'JSON[]'}, filename = true)
      )
      where (b->>'$.T') is not null
    ),
    ours as (
      -- Vendor adjusted files are per-TICKER: they never carry adjustments
      -- across a rename, while our instrument-level series correctly does.
      -- Parity is therefore scoped to instruments that traded under exactly
      -- one ticker in the window, where the two frames agree.
      select instrument_id, symbol_as_traded as symbol, market_date,
             close as close_ours, volume as volume_ours
      from computed.bars_daily_adjusted
      where adjustment_policy = 'split'
      qualify count(distinct symbol_as_traded)
        over (partition by instrument_id) = 1
    )
    select
      o.symbol,
      o.market_date,
      i.active,
      o.close_ours,
      t.close_theirs,
      abs(o.close_ours - t.close_theirs) as close_diff,
      abs(o.close_ours - t.close_theirs)
        > greatest(0.01, t.close_theirs * 0.0005) as close_mismatch,
      abs(coalesce(o.volume_ours, 0) - coalesce(t.volume_theirs, 0))
        > coalesce(t.volume_theirs, 0) * 0.005 + 1 as volume_mismatch
    from ours o
    join theirs t using (symbol, market_date)
    join facts.instruments i using (instrument_id)
  `)

  // Delisted names diverge legitimately: vendors keep applying
  // post-delisting consolidations (e.g. FOXO's 3000:1 after going dark),
  // which our identity quarantines. A constant factor across an
  // instrument's entire traded window changes no return — the active
  // universe is the meaningful parity headline.
  const summary = await db.connection.runAndReadAll(`
    select
      case when segment = 'all' then 'all'
           when segment = 'true' then 'active instruments'
           else 'delisted instruments' end as segment,
      bars_compared, close_mismatches, close_match_pct, max_close_diff,
      volume_mismatches
    from (
      select
        coalesce(cast(active as varchar), 'all') as segment,
        count(*) as bars_compared,
        count(*) filter (close_mismatch) as close_mismatches,
        round(100.0 * (1 - count(*) filter (close_mismatch) / count(*)), 4)
          as close_match_pct,
        round(max(close_diff), 4) as max_close_diff,
        count(*) filter (volume_mismatch) as volume_mismatches
      from t_parity
      group by grouping sets ((active), ())
    )
    order by segment
  `)
  console.log('Split-adjustment parity vs Polygon adjusted=true\n')
  console.log(formatTable(summary.getRowObjectsJson() as never))

  const worst = await db.connection.runAndReadAll(`
    select symbol, cast(market_date as varchar) as market_date,
           round(close_ours, 4) as close_ours, close_theirs,
           round(close_diff, 4) as close_diff
    from t_parity
    where close_mismatch and active
    order by close_diff desc
    limit 10
  `)
  console.log('\nWorst close mismatches among ACTIVE instruments (if any)')
  console.log(formatTable(worst.getRowObjectsJson() as never))

  const coverage = await db.connection.runAndReadAll(`
    select
      (select count(*) from computed.bars_daily_adjusted
       where adjustment_policy = 'split') as ours,
      (select count(*) from t_parity) as compared,
      (select count(*) from (
        select instrument_id from computed.bars_daily_adjusted
        where adjustment_policy = 'split'
        group by instrument_id
        having count(distinct symbol_as_traded) > 1
      )) as renamed_instruments_excluded
  `)
  console.log('\nCoverage')
  console.log(formatTable(coverage.getRowObjectsJson() as never))
} finally {
  db.closeSync()
}
