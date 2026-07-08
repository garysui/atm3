import type { DuckDBConnection } from '@duckdb/node-api'
import { ADJUSTMENT_COMPUTATION_VERSION } from '../core/adjustments.ts'
import { logger } from './log.ts'

// Computed layer: pure functions of facts, cached in computed.* tables.
// Dropping every computed table loses nothing but time. A build is skipped
// when computed.build_state already records the same inputs watermark and
// computation version; any change in facts (or in the computation) rebuilds.
//
// Cached policies are 'split' and 'split_dividend'; policy 'none' IS
// facts.bars_daily and is never duplicated here.
//
// The factor formulas mirror core/adjustments.ts — per-event factors from
// corporate-action facts and our own raw closes. Vendor adjustment factors
// are never used (Polygon's dividend factors are cumulative, not per-event).

export type ComputedBuildResult = {
  skipped: boolean
  watermark: string
  splitFactors: number
  dividendFactors: number
  dividendsSkipped: {
    noPrevClose: number
    nonPositiveFactor: number
    nonUsdOnly: number
  }
  adjustedBars: { split: number; split_dividend: number }
}

const artifacts = [
  { artifact: 'adjustment_factors', scope: 'all' },
  { artifact: 'bars_daily_adjusted', scope: 'split' },
  { artifact: 'bars_daily_adjusted', scope: 'split_dividend' },
]

async function readWatermark(connection: DuckDBConnection): Promise<string> {
  const result = await connection.runAndReadAll(`
    select
      (select count(*) from facts.corporate_actions) as ca_count,
      (select coalesce(cast(max(ex_date) as varchar), '')
         from facts.corporate_actions) as ca_max,
      (select count(*) from facts.bars_daily) as bar_count,
      (select coalesce(cast(max(market_date) as varchar), '')
         from facts.bars_daily) as bar_max
  `)
  const row = result.getRowObjectsJson()[0] as Record<string, unknown>

  return (
    `ca:${row.ca_count}:${row.ca_max}` +
    `|bars:${row.bar_count}:${row.bar_max}` +
    `|${ADJUSTMENT_COMPUTATION_VERSION}`
  )
}

async function isFresh(
  connection: DuckDBConnection,
  watermark: string,
): Promise<boolean> {
  const result = await connection.runAndReadAll(
    `
      select count(*) as n
      from computed.build_state
      where artifact || ':' || scope in (
        'adjustment_factors:all',
        'bars_daily_adjusted:split',
        'bars_daily_adjusted:split_dividend'
      )
        and computation_version = $version
        and inputs_watermark = $watermark
    `,
    { version: ADJUSTMENT_COMPUTATION_VERSION, watermark },
  )

  return Number(result.getRowObjectsJson()[0]?.n) === artifacts.length
}

async function count(
  connection: DuckDBConnection,
  sql: string,
): Promise<number> {
  const result = await connection.runAndReadAll(sql)
  return Number(result.getRowObjectsJson()[0]?.n ?? 0)
}

export async function buildComputed(
  connection: DuckDBConnection,
  options: { force?: boolean } = {},
): Promise<ComputedBuildResult> {
  const watermark = await readWatermark(connection)

  if (!options.force && (await isFresh(connection, watermark))) {
    logger.info({ watermark }, 'computed layer is fresh, skipping build')
    return {
      skipped: true,
      watermark,
      splitFactors: await count(
        connection,
        `select count(*) as n from computed.adjustment_factors
         where action_type = 'split'`,
      ),
      dividendFactors: await count(
        connection,
        `select count(*) as n from computed.adjustment_factors
         where action_type = 'cash_dividend'`,
      ),
      dividendsSkipped: { noPrevClose: 0, nonPositiveFactor: 0, nonUsdOnly: 0 },
      adjustedBars: {
        split: await count(
          connection,
          `select count(*) as n from computed.bars_daily_adjusted
           where adjustment_policy = 'split'`,
        ),
        split_dividend: await count(
          connection,
          `select count(*) as n from computed.bars_daily_adjusted
           where adjustment_policy = 'split_dividend'`,
        ),
      },
    }
  }

  await connection.run('begin transaction')

  try {
    // One canonical tape line per instrument-day (max volume) — dividend
    // prev-close lookups and adjusted bars both use it.
    await connection.run(`
      create or replace temp table t_canon as
      select instrument_id, market_date, symbol_as_traded,
             open, high, low, close, volume, vwap
      from facts.bars_daily
      where source_id = 'polygon'
      qualify row_number() over (
        partition by instrument_id, market_date
        order by volume desc nulls last, symbol_as_traded
      ) = 1
    `)

    await connection.run('delete from computed.adjustment_factors')

    // Splits: per-event by construction (see core/adjustments.ts:
    // price = from/to, volume = to/from). A company executes at most one
    // split per day, but vendors state the same action under BOTH tickers
    // around a rename — so per (instrument, ex_date) exactly ONE statement
    // becomes the factor (lowest source_action_id, deterministic), never a
    // product of statements. Conflicting same-day ratios are counted.
    await connection.run(`
      insert into computed.adjustment_factors (
        instrument_id, event_date, action_type, price_factor, volume_factor,
        evidence
      )
      with statements as (
        select *,
          row_number() over (
            partition by instrument_id, ex_date
            order by source_action_id
          ) as statement_rank,
          count(distinct split_from || ':' || split_to) over (
            partition by instrument_id, ex_date
          ) as ratio_variants,
          string_agg(source_id || ':' || source_action_id, ',') over (
            partition by instrument_id, ex_date
          ) as all_evidence
        from facts.corporate_actions
        where action_type = 'split'
          and coalesce(split_from, 0) > 0
          and coalesce(split_to, 0) > 0
      )
      select
        instrument_id, ex_date, 'split',
        split_from / split_to,
        split_to / split_from,
        all_evidence
      from statements
      where statement_rank = 1
    `)

    const conflictingSplitStatements = await count(
      connection,
      `
        select count(*) as n from (
          select instrument_id, ex_date
          from facts.corporate_actions
          where action_type = 'split'
            and coalesce(split_from, 0) > 0
            and coalesce(split_to, 0) > 0
          group by instrument_id, ex_date
          having count(distinct split_from || ':' || split_to) > 1
        )
      `,
    )

    if (conflictingSplitStatements > 0) {
      logger.warn(
        { conflictingSplitStatements },
        'same-day split statements disagree on ratio; picked deterministically',
      )
    }

    // Dividends: duplicate statements of one distribution (same day, type,
    // amount, currency — the rename pattern again) collapse first; then
    // same-day DISTINCT distributions (e.g. regular + special) SUM their
    // cash (they reduce one prev close once); then factor =
    // 1 - cash / prev raw close, where prev close is the last unadjusted
    // close strictly before the ex date.
    await connection.run(`
      create or replace temp table t_div as
      with statements as (
        select distinct
          instrument_id, ex_date,
          coalesce(dividend_type, '') as dividend_type,
          cash_amount,
          coalesce(currency, 'USD') as currency
        from facts.corporate_actions
        where action_type = 'cash_dividend' and coalesce(cash_amount, 0) > 0
      ),
      cash as (
        select
          instrument_id,
          ex_date,
          coalesce(sum(cash_amount)
            filter (currency = 'USD'), 0) as cash_usd,
          count(*) filter (currency <> 'USD') as non_usd_rows,
          string_agg(dividend_type || ':' || cash_amount, ','
                     order by dividend_type, cash_amount) as evidence
        from statements
        group by instrument_id, ex_date
      )
      select c.*, b.close as prev_close
      from cash c
      asof left join t_canon b
        on c.instrument_id = b.instrument_id and c.ex_date > b.market_date
    `)

    await connection.run(`
      insert into computed.adjustment_factors (
        instrument_id, event_date, action_type, price_factor, volume_factor,
        evidence
      )
      select
        instrument_id, ex_date, 'cash_dividend',
        1 - cash_usd / prev_close,
        1.0,
        evidence
      from t_div
      where cash_usd > 0
        and prev_close is not null
        and prev_close > cash_usd
    `)

    const dividendsSkipped = {
      noPrevClose: await count(
        connection,
        `select count(*) as n from t_div
         where cash_usd > 0 and prev_close is null`,
      ),
      nonPositiveFactor: await count(
        connection,
        `select count(*) as n from t_div
         where cash_usd > 0 and prev_close is not null
           and prev_close <= cash_usd`,
      ),
      nonUsdOnly: await count(
        connection,
        `select count(*) as n from t_div
         where cash_usd = 0 and non_usd_rows > 0`,
      ),
    }

    await connection.run('delete from computed.bars_daily_adjusted')

    for (const policy of ['split', 'split_dividend'] as const) {
      const actionTypes =
        policy === 'split' ? `('split')` : `('split', 'cash_dividend')`

      // A bar's cumulative factor is the product over events with
      // ex_date > bar date: reverse-cumulative products per instrument,
      // joined by the interval [previous event, event). Events past the
      // instrument's last bar (future-dated or post-delisting statements)
      // do not apply — each series anchors to its own latest tape.
      await connection.run(`
        insert into computed.bars_daily_adjusted (
          instrument_id, market_date, adjustment_policy,
          open, high, low, close, volume, vwap,
          cum_price_factor, cum_volume_factor, symbol_as_traded,
          computation_version
        )
        with f as (
          select af.instrument_id, af.event_date,
                 product(af.price_factor) as pf,
                 product(af.volume_factor) as vf
          from computed.adjustment_factors af
          join (
            select instrument_id, max(market_date) as last_bar_date
            from t_canon
            group by instrument_id
          ) lb
            on lb.instrument_id = af.instrument_id
            and af.event_date <= lb.last_bar_date
          where af.action_type in ${actionTypes}
          group by af.instrument_id, af.event_date
        ),
        cum as (
          select
            instrument_id,
            event_date,
            lag(event_date) over (
              partition by instrument_id order by event_date
            ) as prev_event_date,
            product(pf) over (
              partition by instrument_id order by event_date desc
            ) as cum_pf,
            product(vf) over (
              partition by instrument_id order by event_date desc
            ) as cum_vf
          from f
        )
        select
          b.instrument_id,
          b.market_date,
          '${policy}',
          b.open * coalesce(c.cum_pf, 1),
          b.high * coalesce(c.cum_pf, 1),
          b.low * coalesce(c.cum_pf, 1),
          b.close * coalesce(c.cum_pf, 1),
          b.volume * coalesce(c.cum_vf, 1),
          b.vwap * coalesce(c.cum_pf, 1),
          coalesce(c.cum_pf, 1),
          coalesce(c.cum_vf, 1),
          b.symbol_as_traded,
          '${ADJUSTMENT_COMPUTATION_VERSION}'
        from t_canon b
        left join cum c
          on c.instrument_id = b.instrument_id
          and b.market_date < c.event_date
          and (c.prev_event_date is null or b.market_date >= c.prev_event_date)
      `)
    }

    for (const { artifact, scope } of artifacts) {
      await connection.run(
        `
          insert or replace into computed.build_state (
            artifact, scope, computation_version, inputs_watermark, built_at
          ) values ($artifact, $scope, $version, $watermark, now())
        `,
        {
          artifact,
          scope,
          version: ADJUSTMENT_COMPUTATION_VERSION,
          watermark,
        },
      )
    }

    await connection.run('commit')

    const result: ComputedBuildResult = {
      skipped: false,
      watermark,
      splitFactors: await count(
        connection,
        `select count(*) as n from computed.adjustment_factors
         where action_type = 'split'`,
      ),
      dividendFactors: await count(
        connection,
        `select count(*) as n from computed.adjustment_factors
         where action_type = 'cash_dividend'`,
      ),
      dividendsSkipped,
      adjustedBars: {
        split: await count(
          connection,
          `select count(*) as n from computed.bars_daily_adjusted
           where adjustment_policy = 'split'`,
        ),
        split_dividend: await count(
          connection,
          `select count(*) as n from computed.bars_daily_adjusted
           where adjustment_policy = 'split_dividend'`,
        ),
      },
    }

    logger.info(result, 'built computed layer')
    return result
  } catch (error) {
    try {
      await connection.run('rollback')
    } catch {
      // The failed statement may have already aborted the transaction.
    }
    throw error
  }
}
