import type { DuckDBConnection } from '@duckdb/node-api'
import { ADJUSTMENT_COMPUTATION_VERSION } from '../core/adjustments.ts'
import { logger } from './log.ts'

// The adjusted-bars ALGORITHM is computed.adjusted_bars(policy, as_of) —
// a table macro over facts, defined in db/schema.sql. This module only
// maintains the optional accelerator: a materialized snapshot of that macro
// at the current T in computed.bars_daily_adjusted_cache, watermarked so a
// stale snapshot is never silently served. Dropping the cache loses nothing
// but time; consumers without a freshness check must call the macro.

export type CacheRefreshResult = {
  skipped: boolean
  watermark: string
  factorEvents: { splits: number; stockDividends: number; dividends: number }
  unadjustableDividends: Array<Record<string, unknown>>
  cacheRows: { split: number; split_dividend: number }
}

const cachedPolicies = ['split', 'split_dividend'] as const

// Freshness keys on the facts_generation id (bumped atomically by every
// facts rebuild), so corrections that leave counts and max dates unchanged
// still invalidate (review finding #2). Counts/max-dates stay in the
// watermark as belt-and-suspenders against out-of-band writes.
async function readWatermark(connection: DuckDBConnection): Promise<string> {
  const result = await connection.runAndReadAll(`
    select
      (select coalesce(max(value), 'none') from ops.meta
        where key = 'facts_generation') as generation,
      (select count(*) from facts.corporate_actions) as ca_count,
      (select coalesce(cast(max(ex_date) as varchar), '')
         from facts.corporate_actions) as ca_max,
      (select count(*) from facts.bars_daily) as bar_count,
      (select coalesce(cast(max(market_date) as varchar), '')
         from facts.bars_daily) as bar_max
  `)
  const row = result.getRowObjectsJson()[0] as Record<string, unknown>

  return (
    `gen:${row.generation}` +
    `|ca:${row.ca_count}:${row.ca_max}` +
    `|bars:${row.bar_count}:${row.bar_max}` +
    `|${ADJUSTMENT_COMPUTATION_VERSION}`
  )
}

export async function isCacheFresh(
  connection: DuckDBConnection,
  watermark?: string,
): Promise<boolean> {
  const expected = watermark ?? (await readWatermark(connection))
  const result = await connection.runAndReadAll(
    `
      select count(*) as n
      from computed.build_state
      where artifact = 'bars_daily_adjusted_cache'
        and scope in ('split', 'split_dividend')
        and computation_version = $version
        and inputs_watermark = $watermark
    `,
    { version: ADJUSTMENT_COMPUTATION_VERSION, watermark: expected },
  )

  return Number(result.getRowObjectsJson()[0]?.n) === cachedPolicies.length
}

async function count(
  connection: DuckDBConnection,
  sql: string,
): Promise<number> {
  const result = await connection.runAndReadAll(sql)
  return Number(result.getRowObjectsJson()[0]?.n ?? 0)
}

async function collectStats(
  connection: DuckDBConnection,
  skipped: boolean,
  watermark: string,
): Promise<CacheRefreshResult> {
  const unadjustable = await connection.runAndReadAll(`
    select reason, count(*) as entries
    from computed.unadjustable_dividends
    group by reason
    order by reason
  `)

  return {
    skipped,
    watermark,
    factorEvents: {
      splits: await count(
        connection,
        `select count(*) as n from computed.adjustment_factor_events
         where action_type = 'split'`,
      ),
      stockDividends: await count(
        connection,
        `select count(*) as n from computed.adjustment_factor_events
         where action_type = 'stock_dividend'`,
      ),
      dividends: await count(
        connection,
        `select count(*) as n from computed.adjustment_factor_events
         where action_type = 'cash_dividend'`,
      ),
    },
    unadjustableDividends: unadjustable.getRowObjectsJson() as Array<
      Record<string, unknown>
    >,
    cacheRows: {
      split: await count(
        connection,
        `select count(*) as n from computed.bars_daily_adjusted_cache
         where adjustment_policy = 'split'`,
      ),
      split_dividend: await count(
        connection,
        `select count(*) as n from computed.bars_daily_adjusted_cache
         where adjustment_policy = 'split_dividend'`,
      ),
    },
  }
}

export async function refreshAdjustedBarsCache(
  connection: DuckDBConnection,
  options: { force?: boolean } = {},
): Promise<CacheRefreshResult> {
  const watermark = await readWatermark(connection)

  if (!options.force && (await isCacheFresh(connection, watermark))) {
    logger.info({ watermark }, 'adjusted-bars cache is fresh, skipping')
    return collectStats(connection, true, watermark)
  }

  await connection.run('begin transaction')

  try {
    await connection.run('delete from computed.bars_daily_adjusted_cache')

    for (const policy of cachedPolicies) {
      // The cache is BY CONSTRUCTION the macro's output — one algorithm.
      await connection.run(`
        insert into computed.bars_daily_adjusted_cache (
          instrument_id, market_date, adjustment_policy,
          open, high, low, close, volume, vwap,
          cum_price_factor, cum_volume_factor, symbol_as_traded,
          computation_version
        )
        select
          instrument_id, market_date, adjustment_policy,
          open, high, low, close, volume, vwap,
          cum_price_factor, cum_volume_factor, symbol_as_traded,
          '${ADJUSTMENT_COMPUTATION_VERSION}'
        from computed.adjusted_bars('${policy}')
      `)

      await connection.run(
        `
          insert or replace into computed.build_state (
            artifact, scope, computation_version, inputs_watermark, built_at
          ) values ('bars_daily_adjusted_cache', $scope, $version, $watermark,
                    now())
        `,
        {
          scope: policy,
          version: ADJUSTMENT_COMPUTATION_VERSION,
          watermark,
        },
      )
    }

    await connection.run('commit')
  } catch (error) {
    try {
      await connection.run('rollback')
    } catch {
      // The failed statement may have already aborted the transaction.
    }
    throw error
  }

  const result = await collectStats(connection, false, watermark)
  logger.info(result, 'adjusted-bars cache refreshed')
  return result
}
