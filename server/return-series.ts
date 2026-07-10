import type { DuckDBConnection } from '@duckdb/node-api'
import type { AdjustmentPolicy } from '../core/adjustments.ts'

export type AdjustedReturnPoint = {
  date: string
  close: number
  one_day_return: number | null
  return_from_start: number
}

// Source-neutral research surface: market scope validates identity membership;
// the actual series is the same computed algorithm for every market/vendor.
export async function adjustedReturnSeries(
  connection: DuckDBConnection,
  options: {
    instrumentId: string
    marketScope: string
    observations: number
    policy: AdjustmentPolicy
    asOf?: string | null
  },
): Promise<AdjustedReturnPoint[]> {
  if (!Number.isInteger(options.observations) || options.observations < 2) {
    throw new Error('observations must be an integer >= 2')
  }

  const result = await connection.runAndReadAll(
    `
      with scoped_instrument as (
        select instrument_id
        from facts.instruments
        where instrument_id = cast($instrument_id as uuid)
          and primary_market_scope = $market_scope
      ),
      recent_desc as (
        select market_date, close
        from computed.adjusted_bars_for(
          cast($instrument_id as uuid), $policy,
          as_of := cast($as_of as date)
        )
        where exists (select 1 from scoped_instrument)
        order by market_date desc
        limit $observations
      ),
      recent as (
        select * from recent_desc order by market_date
      )
      select
        cast(market_date as varchar) as date,
        close,
        close / lag(close) over (order by market_date) - 1 as one_day_return,
        close / first_value(close) over (
          order by market_date rows between unbounded preceding and unbounded following
        ) - 1 as return_from_start
      from recent
      order by market_date
    `,
    {
      instrument_id: options.instrumentId,
      market_scope: options.marketScope,
      policy: options.policy,
      as_of: options.asOf ?? null,
      observations: options.observations,
    },
  )

  return result.getRowObjectsJson().map((row) => ({
    date: String(row.date),
    close: Number(row.close),
    one_day_return:
      row.one_day_return === null ? null : Number(row.one_day_return),
    return_from_start: Number(row.return_from_start),
  }))
}
