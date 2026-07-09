import type { DuckDBConnection } from '@duckdb/node-api'

// Read-only status collection for `npm run status`. Every query tolerates an
// empty database — the report is useful at any stage of the pipeline.

export type StatusReport = {
  raw: Array<Record<string, unknown>>
  instruments: Array<Record<string, unknown>>
  symbols: Array<Record<string, unknown>>
  bars: Array<Record<string, unknown>>
  corporateActions: Array<Record<string, unknown>>
  tradingDays: Array<Record<string, unknown>>
  computedAlgorithms: Array<Record<string, unknown>>
  computed: Array<Record<string, unknown>>
  unresolved: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
}

async function rows(
  connection: DuckDBConnection,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await connection.runAndReadAll(sql)
  return result.getRowObjectsJson() as Array<Record<string, unknown>>
}

export async function collectStatus(
  connection: DuckDBConnection,
): Promise<StatusReport> {
  return {
    raw: await rows(
      connection,
      `
        select
          dataset,
          count(*) as files,
          sum(coalesce(row_count, 0)) as rows,
          cast(min(market_date) as varchar) as first_date,
          cast(max(market_date) as varchar) as last_date,
          strftime(max(fetched_at), '%Y-%m-%d %H:%M') as last_fetched_utc
        from raw.fetches
        group by dataset
        order by dataset
      `,
    ),
    instruments: await rows(
      connection,
      `
        select
          instrument_type,
          count(*) as total,
          count(*) filter (active) as active,
          count(*) filter (is_clean_common_stock) as clean_common
        from facts.instruments
        group by instrument_type
        order by total desc
        limit 10
      `,
    ),
    symbols: await rows(
      connection,
      `
        select
          market_scope,
          count(*) as total,
          count(*) filter (valid_to is null) as current,
          count(*) filter (valid_to is not null) as ended
        from facts.symbols
        group by market_scope
        order by market_scope
      `,
    ),
    bars: await rows(
      connection,
      `
        select
          market_scope,
          count(*) as bars,
          count(distinct instrument_id) as instruments,
          cast(min(market_date) as varchar) as first_date,
          cast(max(market_date) as varchar) as last_date
        from facts.bars_daily
        group by market_scope
        order by market_scope
      `,
    ),
    corporateActions: await rows(
      connection,
      `
        select
          action_type,
          count(*) as total,
          cast(min(ex_date) as varchar) as first_ex_date,
          cast(max(ex_date) as varchar) as last_ex_date
        from facts.corporate_actions
        group by action_type
        order by total desc
      `,
    ),
    tradingDays: await rows(
      connection,
      `
        select
          calendar_id,
          count(*) as days,
          count(*) filter (is_open) as open_days,
          cast(min(market_date) as varchar) as first_date,
          cast(max(market_date) as varchar) as last_date
        from facts.trading_days
        group by calendar_id
        order by calendar_id
      `,
    ),
    computedAlgorithms: await rows(
      connection,
      `
        select view_name as name, 'view' as kind
        from duckdb_views()
        where schema_name = 'computed'
        union all
        select distinct function_name, 'macro'
        from duckdb_functions()
        where schema_name = 'computed'
        order by kind desc, name
      `,
    ),
    computed: await rows(
      connection,
      `
        select table_name as cache_table, estimated_size as rows
        from duckdb_tables()
        where schema_name = 'computed'
        order by table_name
      `,
    ),
    unresolved: await rows(
      connection,
      `
        select dataset, reason, count(*) as entries
        from ops.unresolved
        group by dataset, reason
        order by dataset, reason
      `,
    ),
    runs: await rows(
      connection,
      `
        select
          job,
          status,
          strftime(started_at, '%Y-%m-%d %H:%M') as started_utc,
          cast(round(epoch(finished_at - started_at)) as integer) as seconds
        from ops.runs
        order by started_at desc
        limit 8
      `,
    ),
  }
}
