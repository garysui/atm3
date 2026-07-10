import { randomUUID } from 'node:crypto'
import type { DuckDBConnection } from '@duckdb/node-api'
import { classificationCaseSql } from '../core/instrument-types.ts'
import {
  context,
  count,
  datasetHasFiles,
  glob,
  inTransaction,
  type BuildOptions,
} from './facts-common.ts'
import {
  buildCnBarsDaily,
  buildCnCorporateActions,
  buildCnExchanges,
  buildCnIdentity,
  buildCnTradingDays,
} from './facts-build-cn.ts'
import { logger } from './log.ts'

// Facts builders: deterministic, full-refresh computations from the raw zone
// into the facts schema. Heavy set-based work runs as SQL inside DuckDB; this
// module only orchestrates. Rebuilding from unchanged raw reproduces
// identical ids (deterministic_uuid macro) and row counts.
//
// Validity semantics everywhere: valid_from inclusive, valid_to EXCLUSIVE,
// null = open-ended. resolve(market_scope, symbol, date) picks the row with
// valid_from <= date < valid_to.

export type { BuildOptions } from './facts-common.ts'

// facts.exchanges from the latest exchanges snapshot. market_scope is
// locale + asset_class (us_stocks, ...); calendar/timezone/currency are
// per-locale conventions.
export async function buildExchanges(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ exchanges: number }> {
  const ctx = context(connection, options)

  await inTransaction(ctx, async () => {
    // This builder owns every scope in the polygon exchanges snapshot
    // (us_* and global_*); scopes owned by other market builders are
    // excluded so a standalone run cannot drop their rows.
    await ctx.connection.run(
      "delete from facts.exchanges where market_scope <> 'cn_stocks'",
    )

    if (!(await datasetHasFiles(ctx, 'exchanges'))) {
      return
    }

    await ctx.connection.run(`
      insert into facts.exchanges (
        exchange_mic, name, exchange_type, market_scope, calendar_id,
        timezone, country, currency
      )
      with rows as (
        select
          unnest(results) as r,
          regexp_extract(filename, 'snapshot_date=(\\d{4}-\\d{2}-\\d{2})', 1)
            as snapshot_date
        from read_json(
          ${glob(ctx, 'polygon/exchanges/*/exchanges.json.gz')},
          columns = {results: 'JSON[]'}, filename = true
        )
      ),
      parsed as (
        select
          r->>'$.mic' as exchange_mic,
          r->>'$.name' as name,
          r->>'$.type' as exchange_type,
          r->>'$.asset_class' as asset_class,
          r->>'$.locale' as locale,
          snapshot_date
        from rows
        where (r->>'$.mic') is not null and (r->>'$.mic') <> ''
      )
      select
        exchange_mic,
        any_value(name),
        any_value(exchange_type),
        any_value(locale || '_' || asset_class),
        any_value(case when locale = 'us' then 'us_equities'
                       else locale || '_equities' end),
        any_value(case when locale = 'us' then 'America/New_York'
                       else 'UTC' end),
        any_value(locale),
        any_value(case when locale = 'us' then 'USD' end)
      from (
        select *
        from parsed
        qualify row_number() over (
          partition by exchange_mic order by snapshot_date desc
        ) = 1
      )
      group by exchange_mic
    `)
  }, options.transactional ?? true)

  const exchanges = await count(
    ctx,
    "select count(*) as n from facts.exchanges where market_scope = 'us_stocks'",
  )
  logger.info({ exchanges }, 'built facts.exchanges')
  return { exchanges }
}

// facts.trading_days for the us_equities calendar. Past days come from
// grouped-daily evidence in raw.fetches (row_count > 0 means the market
// traded); future days come from the latest upcoming-holidays snapshot.
export async function buildTradingDays(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ tradingDays: number }> {
  const ctx = context(connection, options)
  const hasHolidays = await datasetHasFiles(ctx, 'market_holidays')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.trading_days where calendar_id = 'us_equities'",
    )
    await ctx.connection.run(`
      insert into facts.trading_days (
        calendar_id, market_date, is_open, is_half_day, open_utc, close_utc,
        source_id
      )
      select
        'us_equities', market_date, coalesce(row_count, 0) > 0, false,
        null, null, 'polygon'
      from raw.fetches
      where source_id = 'polygon'
        and dataset = 'grouped_daily'
        and market_date is not null
    `)

    if (!hasHolidays) {
      return
    }

    await ctx.connection.run(`
      insert into facts.trading_days (
        calendar_id, market_date, is_open, is_half_day, open_utc, close_utc,
        source_id
      )
      with holidays_all as (
        select
          *,
          regexp_extract(filename, 'snapshot_date=(\\d{4}-\\d{2}-\\d{2})', 1)
            as snapshot_date
        from read_json(
          ${glob(ctx, 'polygon/market_holidays/*/upcoming.json.gz')},
          columns = {
            exchange: 'VARCHAR', name: 'VARCHAR', date: 'DATE',
            status: 'VARCHAR', open: 'VARCHAR', close: 'VARCHAR'
          },
          filename = true
        )
      ),
      latest as (
        select * from holidays_all
        where snapshot_date = (select max(snapshot_date) from holidays_all)
      )
      select
        'us_equities',
        date,
        not bool_or(status = 'closed'),
        bool_or(status = 'early-close'),
        max(try_cast(open as timestamptz)),
        max(try_cast(close as timestamptz)),
        'polygon'
      from latest
      where date is not null
        and date not in (
          select market_date from facts.trading_days
          where calendar_id = 'us_equities'
        )
      group by date
    `)
  }, options.transactional ?? true)

  const tradingDays = await count(
    ctx,
    "select count(*) as n from facts.trading_days where calendar_id = 'us_equities'",
  )
  logger.info({ tradingDays }, 'built facts.trading_days')
  return { tradingDays }
}

// Identity: instruments, symbol history, and external identifiers.
//
// Identity evidence is composite_figi (stable across ticker changes — META
// kept its FIGI through FB→META). Rows without a FIGI get a conservative
// fallback key that never merges two different companies.
//
// Symbol validity: a delisted usage ends (exclusively) on its delisted date;
// when a ticker is reused, the next usage inherits the previous usage's end
// as its start. Ticker-events files, where fetched, override with exact
// change dates. Irreconcilable overlaps are quarantined, never guessed.
export async function buildIdentity(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ instruments: number; symbols: number; identifiers: number }> {
  const ctx = context(connection, options)
  const hasTickers = await datasetHasFiles(ctx, 'reference_tickers')
  const hasEvents = await datasetHasFiles(ctx, 'ticker_events')

  await inTransaction(ctx, async () => {
    // Scoped to what this builder inserts (us_stocks / polygon) so a
    // standalone run cannot drop other markets' identity — mirrors the
    // per-source deletes in facts-build-cn.
    await ctx.connection.run(
      "delete from facts.instruments where primary_market_scope = 'us_stocks'",
    )
    await ctx.connection.run(
      "delete from facts.symbols where market_scope = 'us_stocks'",
    )
    await ctx.connection.run(
      "delete from facts.instrument_identifiers where source_id = 'polygon'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset = 'reference_tickers'",
    )

    if (!hasTickers) {
      return
    }

    await ctx.connection.run(`
      create or replace temp table t_ref as
      select
        r->>'$.ticker' as symbol,
        r->>'$.name' as name,
        r->>'$.type' as type_code,
        nullif(r->>'$.composite_figi', '') as composite_figi,
        nullif(r->>'$.share_class_figi', '') as share_class_figi,
        nullif(r->>'$.cik', '') as cik,
        nullif(r->>'$.primary_exchange', '') as primary_exchange_mic,
        nullif(upper(r->>'$.currency_name'), '') as currency,
        coalesce(cast(r->>'$.active' as boolean), false) as active,
        coalesce(r->>'$.last_updated_utc', '') as last_updated_utc,
        try_cast(substr(r->>'$.delisted_utc', 1, 10) as date) as delisted_date,
        cast(
          regexp_extract(filename, 'snapshot_date=(\\d{4}-\\d{2}-\\d{2})', 1)
          as date
        ) as snapshot_date
      from (
        select unnest(results) as r, filename
        from read_json(
          ${glob(ctx, 'polygon/reference_tickers/*/*/*.json.gz')},
          columns = {results: 'JSON[]'}, filename = true
        )
      )
      where (r->>'$.ticker') is not null
    `)

    await ctx.connection.run(`
      create or replace temp table t_keyed as
      select *,
        coalesce(
          composite_figi,
          'nofigi:' || symbol || ':'
            || coalesce(cast(delisted_date as varchar), 'active')
        ) as identity_key
      from t_ref
    `)

    await ctx.connection.run(`
      create or replace temp table t_instruments as
      with agg as (
        select
          identity_key,
          bool_or(active) as any_active,
          max(delisted_date) as max_delisted_date,
          min(snapshot_date) as first_seen_date
        from t_keyed
        group by identity_key
      ),
      picked as (
        select *
        from t_keyed
        qualify row_number() over (
          partition by identity_key
          order by active desc, last_updated_utc desc, snapshot_date desc,
                   symbol asc
        ) = 1
      )
      select
        deterministic_uuid('instrument', p.identity_key) as instrument_id,
        p.identity_key,
        'equity' as asset_class,
        ${classificationCaseSql('p.type_code', 'instrumentType')} as instrument_type,
        ${classificationCaseSql('p.type_code', 'securityForm')} as security_form,
        ${classificationCaseSql('p.type_code', 'isCleanCommonStock')} as is_clean_common_stock,
        coalesce(p.name, p.symbol) as name,
        'us_stocks' as primary_market_scope,
        p.primary_exchange_mic,
        p.currency,
        a.any_active as active,
        case when a.any_active then null else a.max_delisted_date end
          as delisted_date,
        a.first_seen_date
      from picked p
      join agg a using (identity_key)
    `)

    // Symbol usages chained per ticker: order usages by end date; a usage
    // with no stated start inherits the previous usage's end.
    await ctx.connection.run(`
      create or replace temp table t_sym as
      with pair as (
        select
          identity_key,
          symbol,
          bool_or(active) as pair_active,
          max(delisted_date) as pair_delisted,
          max(try_cast(substr(last_updated_utc, 1, 10) as date))
            as pair_last_updated
        from t_keyed
        group by identity_key, symbol
      ),
      ranges as (
        select
          i.instrument_id,
          i.primary_exchange_mic,
          p.symbol,
          -- An inactive usage ends on its delisted date; renames often lack
          -- delisted_utc, so fall back to the row's last vendor update as
          -- the end-of-usage evidence. Active usages stay open-ended.
          case when p.pair_active then null
               else coalesce(p.pair_delisted, p.pair_last_updated) end
            as valid_to_raw
        from pair p
        join t_instruments i using (identity_key)
      )
      select
        *,
        lag(valid_to_raw) over w as inherited_valid_from,
        row_number() over w as chain_position
      from ranges
      window w as (
        partition by symbol
        order by coalesce(valid_to_raw, date '9999-12-31'),
                 cast(instrument_id as varchar)
      )
    `)

    if (hasEvents) {
      await ctx.connection.run(`
        create or replace temp table t_event_ranges as
        with events as (
          select distinct
            nullif(res->>'$.composite_figi', '') as composite_figi,
            e->>'$.ticker_change.ticker' as symbol,
            cast(e->>'$.date' as date) as event_date
          from (
            select
              results as res,
              unnest(from_json(json_extract(results, '$.events'), '["json"]'))
                as e
            from read_json(
              ${glob(ctx, 'polygon/ticker_events/*/*.json.gz')},
              columns = {results: 'JSON'}
            )
          )
          where nullif(res->>'$.composite_figi', '') is not null
            and (e->>'$.ticker_change.ticker') is not null
        )
        select
          composite_figi,
          symbol,
          event_date as valid_from,
          lead(event_date) over (
            partition by composite_figi order by event_date
          ) as valid_to
        from events
      `)
    } else {
      await ctx.connection.run(`
        create or replace temp table t_event_ranges (
          composite_figi varchar, symbol varchar, valid_from date,
          valid_to date
        )
      `)
    }

    await ctx.connection.run(`
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, security_form,
        is_clean_common_stock, name, primary_market_scope,
        primary_exchange_mic, currency, active, delisted_date,
        first_seen_date
      )
      select
        instrument_id, asset_class, instrument_type, security_form,
        is_clean_common_stock, name, primary_market_scope,
        primary_exchange_mic, currency, active, delisted_date,
        first_seen_date
      from t_instruments
    `)

    await ctx.connection.run(`
      insert into facts.symbols (
        symbol_id, instrument_id, market_scope, symbol, exchange_mic,
        valid_from, valid_to, is_primary, evidence
      )
      with overlay as (
        select
          i.instrument_id,
          i.primary_exchange_mic,
          r.symbol,
          r.valid_from,
          r.valid_to,
          '{"basis":"ticker_events"}' as evidence
        from t_event_ranges r
        join t_instruments i on i.identity_key = r.composite_figi
      ),
      base as (
        select
          s.instrument_id,
          s.primary_exchange_mic,
          s.symbol,
          s.inherited_valid_from as valid_from,
          s.valid_to_raw as valid_to,
          case when s.inherited_valid_from is null
            then '{"basis":"reference_snapshot"}'
            else '{"basis":"reference_snapshot_chained"}'
          end as evidence
        from t_sym s
        where not (s.inherited_valid_from is null and s.chain_position > 1)
          and not exists (
            select 1 from overlay o
            where o.instrument_id = s.instrument_id and o.symbol = s.symbol
          )
      ),
      unioned as (
        select * from base
        union all
        select * from overlay
      )
      select
        deterministic_uuid(
          'symbol',
          'us_stocks:' || symbol || ':' || cast(instrument_id as varchar)
            || ':' || coalesce(cast(valid_from as varchar), 'open')
        ),
        instrument_id,
        'us_stocks',
        symbol,
        primary_exchange_mic,
        valid_from,
        valid_to,
        true,
        cast(evidence as json)
      from unioned
    `)

    // Ambiguous reuse (two open-ended usages of one ticker) is quarantined.
    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'reference_tickers',
        'us_stocks',
        symbol,
        (select max(snapshot_date) from t_ref),
        'ambiguous',
        cast('{"instrument_id":"' || cast(instrument_id as varchar) || '"}'
          as json)
      from t_sym
      where inherited_valid_from is null and chain_position > 1
      on conflict do nothing
    `)

    // External identifiers, only where they map to exactly one instrument
    // (CIK is company-level and legitimately spans share classes).
    await ctx.connection.run(`
      insert into facts.instrument_identifiers (
        identifier_type, identifier_value, valid_from, instrument_id,
        source_id, valid_to
      )
      with unpivoted as (
        select 'composite_figi' as identifier_type,
               composite_figi as identifier_value,
               identity_key, snapshot_date
        from t_keyed where composite_figi is not null
        union all
        select 'share_class_figi', share_class_figi, identity_key,
               snapshot_date
        from t_keyed where share_class_figi is not null
        union all
        select 'cik', cik, identity_key, snapshot_date
        from t_keyed where cik is not null
      ),
      grouped as (
        select
          u.identifier_type,
          u.identifier_value,
          min(u.snapshot_date) as valid_from,
          i.instrument_id
        from unpivoted u
        join t_instruments i using (identity_key)
        group by u.identifier_type, u.identifier_value, i.instrument_id
      )
      select identifier_type, identifier_value, valid_from, instrument_id,
             'polygon', null
      from grouped
      qualify count(*) over (
        partition by identifier_type, identifier_value
      ) = 1
    `)
  }, options.transactional ?? true)

  const instruments = await count(
    ctx,
    "select count(*) as n from facts.instruments where primary_market_scope = 'us_stocks'",
  )
  const symbols = await count(
    ctx,
    "select count(*) as n from facts.symbols where market_scope = 'us_stocks'",
  )
  const identifiers = await count(
    ctx,
    "select count(*) as n from facts.instrument_identifiers where source_id = 'polygon'",
  )
  logger.info({ instruments, symbols, identifiers }, 'built identity facts')
  return { instruments, symbols, identifiers }
}

// Corporate actions from splits + dividends sweeps, resolved to instruments
// through symbol validity at the ex date. Unresolved actions are quarantined.
export async function buildCorporateActions(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ corporateActions: number; unresolved: number }> {
  const ctx = context(connection, options)
  const hasSplits = await datasetHasFiles(ctx, 'splits')
  const hasDividends = await datasetHasFiles(ctx, 'dividends')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.corporate_actions where source_id = 'polygon'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset in ('splits', 'dividends')",
    )

    const sources: Array<{ dataset: 'splits' | 'dividends'; sql: string }> = []

    if (hasSplits) {
      sources.push({
        dataset: 'splits',
        sql: `
          select distinct
            r->>'$.id' as source_action_id,
            r->>'$.ticker' as symbol,
            'split' as action_type,
            cast(r->>'$.execution_date' as date) as ex_date,
            cast(null as date) as declaration_date,
            cast(null as date) as record_date,
            cast(null as date) as pay_date,
            cast(r->>'$.split_from' as double) as split_from,
            cast(r->>'$.split_to' as double) as split_to,
            cast(null as double) as cash_amount,
            cast(null as varchar) as currency,
            cast(null as varchar) as dividend_type,
            cast(null as integer) as frequency
          from (
            select unnest(results) as r
            from read_json(
              ${glob(ctx, 'polygon/splits/*/*.json.gz')},
              columns = {results: 'JSON[]'}
            )
          )
          where (r->>'$.id') is not null
            and (r->>'$.execution_date') is not null
        `,
      })
    }

    if (hasDividends) {
      sources.push({
        dataset: 'dividends',
        sql: `
          select distinct
            r->>'$.id' as source_action_id,
            r->>'$.ticker' as symbol,
            'cash_dividend' as action_type,
            cast(r->>'$.ex_dividend_date' as date) as ex_date,
            try_cast(r->>'$.declaration_date' as date) as declaration_date,
            try_cast(r->>'$.record_date' as date) as record_date,
            try_cast(r->>'$.pay_date' as date) as pay_date,
            cast(null as double) as split_from,
            cast(null as double) as split_to,
            cast(r->>'$.cash_amount' as double) as cash_amount,
            nullif(upper(r->>'$.currency'), '') as currency,
            nullif(r->>'$.dividend_type', '') as dividend_type,
            try_cast(r->>'$.frequency' as integer) as frequency
          from (
            select unnest(results) as r
            from read_json(
              ${glob(ctx, 'polygon/dividends/*/*.json.gz')},
              columns = {results: 'JSON[]'}
            )
          )
          where (r->>'$.id') is not null
            and (r->>'$.ex_dividend_date') is not null
        `,
      })
    }

    for (const source of sources) {
      await ctx.connection.run(`
        create or replace temp table t_actions as
        with rows as (${source.sql}),
        resolved as (
          select rows.*, sym.instrument_id
          from rows
          left join facts.symbols sym
            on sym.market_scope = 'us_stocks'
            and sym.symbol = rows.symbol
            and (sym.valid_from is null or rows.ex_date >= sym.valid_from)
            and (sym.valid_to is null or rows.ex_date < sym.valid_to)
          qualify row_number() over (
            partition by rows.source_action_id
            order by sym.valid_from desc nulls last
          ) = 1
        )
        select * from resolved
      `)

      await ctx.connection.run(`
        insert into facts.corporate_actions (
          source_id, source_action_id, instrument_id, market_scope,
          symbol_as_stated, action_type, ex_date, declaration_date,
          record_date, pay_date, split_from, split_to, cash_amount, currency,
          dividend_type, frequency
        )
        select
          'polygon', source_action_id, instrument_id, 'us_stocks', symbol,
          action_type, ex_date, declaration_date, record_date, pay_date,
          split_from, split_to, cash_amount, currency, dividend_type,
          frequency
        from t_actions
        where instrument_id is not null
      `)

      await ctx.connection.run(`
        insert into ops.unresolved (
          dataset, market_scope, symbol, market_date, reason, sample
        )
        select
          '${source.dataset}', 'us_stocks', symbol, min(ex_date),
          'no_symbol_match',
          cast('{"count":' || count(*) || '}' as json)
        from t_actions
        where instrument_id is null
        group by symbol
        on conflict do nothing
      `)
    }
  }, options.transactional ?? true)

  const corporateActions = await count(
    ctx,
    "select count(*) as n from facts.corporate_actions where source_id = 'polygon'",
  )
  const unresolved = await count(
    ctx,
    `select count(*) as n from ops.unresolved
     where dataset in ('splits', 'dividends')`,
  )
  logger.info({ corporateActions, unresolved }, 'built facts.corporate_actions')
  return { corporateActions, unresolved }
}

// Unadjusted daily bars from grouped-daily payloads, keyed by instrument and
// exchange-local market date, keeping the ticker as traded. Bars that resolve
// to no instrument are quarantined per (symbol, date).
export async function buildBarsDaily(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ bars: number; unresolved: number }> {
  const ctx = context(connection, options)
  const hasBars = await datasetHasFiles(ctx, 'grouped_daily')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.bars_daily where source_id = 'polygon'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset = 'grouped_daily'",
    )

    if (!hasBars) {
      return
    }

    await ctx.connection.run(`
      create or replace temp table t_bars as
      select
        b->>'$.T' as symbol,
        cast(
          regexp_extract(filename, 'date=(\\d{4}-\\d{2}-\\d{2})', 1) as date
        ) as market_date,
        cast(b->>'$.o' as double) as open,
        cast(b->>'$.h' as double) as high,
        cast(b->>'$.l' as double) as low,
        cast(b->>'$.c' as double) as close,
        try_cast(b->>'$.v' as double) as volume,
        try_cast(b->>'$.vw' as double) as vwap,
        try_cast(b->>'$.n' as bigint) as trade_count
      from (
        select unnest(results) as b, filename
        from read_json(
          ${glob(ctx, 'polygon/grouped_daily/*/*.json.gz')},
          columns = {results: 'JSON[]'}, filename = true
        )
      )
      where (b->>'$.T') is not null
    `)

    await ctx.connection.run(`
      create or replace temp table t_bars_resolved as
      select b.*, sym.instrument_id
      from t_bars b
      left join facts.symbols sym
        on sym.market_scope = 'us_stocks'
        and sym.symbol = b.symbol
        and (sym.valid_from is null or b.market_date >= sym.valid_from)
        and (sym.valid_to is null or b.market_date < sym.valid_to)
      qualify row_number() over (
        partition by b.symbol, b.market_date
        order by sym.valid_from desc nulls last
      ) = 1
    `)

    await ctx.connection.run(`
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume, vwap, trade_count
      )
      select
        'polygon', instrument_id, market_date, 'us_stocks', symbol,
        open, high, low, close, volume, vwap, trade_count
      from t_bars_resolved
      where instrument_id is not null
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'grouped_daily', 'us_stocks', symbol, market_date, 'no_symbol_match',
        cast('{"close":' || close || '}' as json)
      from t_bars_resolved
      where instrument_id is null
      on conflict do nothing
    `)
  }, options.transactional ?? true)

  const bars = await count(
    ctx,
    "select count(*) as n from facts.bars_daily where source_id = 'polygon'",
  )
  const unresolved = await count(
    ctx,
    `select count(*) as n from ops.unresolved where dataset = 'grouped_daily'`,
  )
  logger.info({ bars, unresolved }, 'built facts.bars_daily')
  return { bars, unresolved }
}

// One transaction end to end: readers see either the previous facts
// generation or the new one, never a mix, and any failure rolls the whole
// rebuild back. The facts_generation id commits atomically with the data —
// cache freshness keys on it, so a rebuild from corrected raw invalidates
// even when row counts and max dates are unchanged (review finding #2).
export async function buildAllFacts(
  connection: DuckDBConnection,
  options: BuildOptions = {},
) {
  const inner: BuildOptions = { ...options, transactional: false }
  await connection.run('begin transaction')

  try {
    const exchanges = await buildExchanges(connection, inner)
    const identity = await buildIdentity(connection, inner)
    const tradingDays = await buildTradingDays(connection, inner)
    const corporateActions = await buildCorporateActions(connection, inner)
    const bars = await buildBarsDaily(connection, inner)
    const cnExchanges = await buildCnExchanges(connection, inner)
    const cnIdentity = await buildCnIdentity(connection, inner)
    const cnTradingDays = await buildCnTradingDays(connection, inner)
    const cnCorporateActions = await buildCnCorporateActions(connection, inner)
    const cnBars = await buildCnBarsDaily(connection, inner)
    await connection.run(
      `insert or replace into ops.meta (key, value)
       values ('facts_generation', $generation)`,
      { generation: randomUUID() },
    )
    await connection.run('commit')

    return {
      ...exchanges,
      ...identity,
      ...tradingDays,
      ...corporateActions,
      ...bars,
      ...cnExchanges,
      ...cnIdentity,
      ...cnTradingDays,
      ...cnCorporateActions,
      ...cnBars,
    }
  } catch (error) {
    try {
      await connection.run('rollback')
    } catch {
      // The failed statement may have already aborted the transaction.
    }
    throw error
  }
}
