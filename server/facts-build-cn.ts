import type { DuckDBConnection } from '@duckdb/node-api'
import {
  context,
  count,
  datasetHasFiles,
  glob,
  inTransaction,
  type BuildContext,
  type BuildOptions,
} from './facts-common.ts'
import { logger } from './log.ts'

function frameRecords(ctx: BuildContext, relative: string): string {
  return `
    frame_payloads as (
      select
        filename,
        split_part(substr(content, 22), chr(1), 7) as payload
      from read_text(${glob(ctx, relative)})
    ),
    frame_records as (
      select
        filename,
        unnest(
          from_json(payload, '{"record":["VARCHAR[]"]}').record
        ) as r
      from frame_payloads
      where trim(payload) <> ''
    )
  `
}

export async function buildCnExchanges(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ cnExchanges: number }> {
  const ctx = context(connection, options)
  const hasCnRaw =
    (await datasetHasFiles(ctx, 'stock_basic', 'baostock')) ||
    (await datasetHasFiles(ctx, 'trade_cal', 'baostock'))

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.exchanges where market_scope = 'cn_stocks'",
    )
    if (!hasCnRaw) return

    await ctx.connection.run(`
      insert into facts.exchanges (
        exchange_mic, name, exchange_type, market_scope, calendar_id,
        timezone, country, currency
      ) values
        ('XSHG', 'Shanghai Stock Exchange', 'exchange', 'cn_stocks',
         'cn_equities', 'Asia/Shanghai', 'CN', 'CNY'),
        ('XSHE', 'Shenzhen Stock Exchange', 'exchange', 'cn_stocks',
         'cn_equities', 'Asia/Shanghai', 'CN', 'CNY')
    `)
  }, options.transactional ?? true)

  const cnExchanges = await count(
    ctx,
    "select count(*) as n from facts.exchanges where market_scope = 'cn_stocks'",
  )
  logger.info({ cnExchanges }, 'built CN exchange facts')
  return { cnExchanges }
}

export async function buildCnIdentity(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{
  cnInstruments: number
  cnSymbols: number
  cnIdentifiers: number
}> {
  const ctx = context(connection, options)
  const hasBasics = await datasetHasFiles(ctx, 'stock_basic', 'baostock')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.instrument_events where source_id = 'baostock'",
    )
    await ctx.connection.run(
      "delete from facts.instrument_identifiers where source_id = 'baostock'",
    )
    await ctx.connection.run(
      "delete from facts.symbols where market_scope = 'cn_stocks'",
    )
    await ctx.connection.run(
      "delete from facts.instruments where primary_market_scope = 'cn_stocks'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset = 'stock_basic' and market_scope = 'cn_stocks'",
    )
    if (!hasBasics) return

    await ctx.connection.run(`
      create or replace temp table t_cn_basic_raw as
      with ${frameRecords(ctx, 'baostock/stock_basic/*/*/*.frame')}
      select
        trim(r[1]) as code,
        trim(r[2]) as code_name,
        trim(r[3]) as ipo_date_text,
        trim(r[4]) as out_date_text,
        trim(r[5]) as type_code,
        trim(r[6]) as status,
        try_cast(nullif(trim(r[3]), '') as date) as ipo_date,
        try_cast(nullif(trim(r[4]), '') as date) as out_date,
        cast(
          regexp_extract(filename, 'snapshot_date=(\\d{4}-\\d{2}-\\d{2})', 1)
          as date
        ) as snapshot_date
      from frame_records
    `)

    await ctx.connection.run(`
      create or replace temp table t_cn_reused_codes as
      select code
      from t_cn_basic_raw
      where regexp_full_match(code, '(sh|sz)\\.[0-9]{6}')
      group by code
      having count(distinct nullif(ipo_date_text, '')) > 1
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'stock_basic', 'cn_stocks', code, max(snapshot_date),
        'code_reuse_suspected',
        json_object('listing_dates', string_agg(distinct ipo_date_text, ','))
      from t_cn_basic_raw
      where code in (select code from t_cn_reused_codes)
      group by code
      on conflict do nothing
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'stock_basic', 'cn_stocks', coalesce(nullif(code, ''), '(blank)'),
        snapshot_date, 'bad_row',
        json_object(
          'ipoDate', ipo_date_text, 'outDate', out_date_text, 'type', type_code
        )
      from t_cn_basic_raw
      where not regexp_full_match(code, '(sh|sz)\\.[0-9]{6}')
         or type_code <> '1'
         or (ipo_date_text <> '' and ipo_date is null)
         or (out_date_text <> '' and out_date is null)
      on conflict do nothing
    `)

    await ctx.connection.run(`
      create or replace temp table t_cn_basic as
      select
        code,
        substr(code, 4) as symbol,
        code_name,
        case when starts_with(code, 'sh.') then 'XSHG' else 'XSHE' end
          as exchange_mic,
        ipo_date,
        out_date,
        snapshot_date,
        status
      from t_cn_basic_raw
      where regexp_full_match(code, '(sh|sz)\\.[0-9]{6}')
        and type_code = '1'
        and not (ipo_date_text <> '' and ipo_date is null)
        and not (out_date_text <> '' and out_date is null)
        and code not in (select code from t_cn_reused_codes)
      qualify row_number() over (
        partition by code order by snapshot_date desc
      ) = 1
    `)

    await ctx.connection.run(`
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, security_form,
        is_clean_common_stock, name, primary_market_scope,
        primary_exchange_mic, currency, active, delisted_date,
        first_seen_date
      )
      select
        deterministic_uuid(
          'instrument', 'cn:' || exchange_mic || ':' || symbol
        ),
        'equity', 'common_stock', 'ordinary_common', true,
        coalesce(nullif(code_name, ''), symbol), 'cn_stocks', exchange_mic,
        'CNY', status = '1' and out_date is null, out_date, ipo_date
      from t_cn_basic
    `)

    await ctx.connection.run(`
      insert into facts.symbols (
        symbol_id, instrument_id, market_scope, symbol, exchange_mic,
        valid_from, valid_to, is_primary, evidence
      )
      select
        deterministic_uuid(
          'symbol',
          'cn_stocks:' || b.symbol || ':' || cast(i.instrument_id as varchar)
            || ':' || coalesce(cast(b.ipo_date as varchar), 'open')
        ),
        i.instrument_id, 'cn_stocks', b.symbol, b.exchange_mic,
        b.ipo_date, b.out_date, true,
        json_object('basis', 'baostock_stock_basic', 'vendor_code', b.code)
      from t_cn_basic b
      join facts.instruments i
        on i.instrument_id = deterministic_uuid(
          'instrument', 'cn:' || b.exchange_mic || ':' || b.symbol
        )
    `)

    await ctx.connection.run(`
      insert into facts.instrument_identifiers (
        identifier_type, identifier_value, valid_from, instrument_id,
        source_id, valid_to
      )
      select
        'baostock_code', b.code, coalesce(b.ipo_date, b.snapshot_date),
        i.instrument_id, 'baostock', b.out_date
      from t_cn_basic b
      join facts.instruments i
        on i.instrument_id = deterministic_uuid(
          'instrument', 'cn:' || b.exchange_mic || ':' || b.symbol
        )
    `)

    await ctx.connection.run(`
      insert into facts.instrument_events (
        source_id, source_event_id, instrument_id, event_type, event_date,
        timing, title, payload
      )
      with history as (
        select
          code,
          code_name,
          snapshot_date,
          lag(code_name) over (partition by code order by snapshot_date)
            as previous_name
        from t_cn_basic_raw
        where regexp_full_match(code, '(sh|sz)\\.[0-9]{6}')
          and code not in (select code from t_cn_reused_codes)
      )
      select
        'baostock',
        'baostock:' || h.code || ':' || cast(h.snapshot_date as varchar)
          || ':name_change',
        id.instrument_id, 'name_change', h.snapshot_date, 'unknown',
        'Name changed to ' || h.code_name,
        json_object('old_name', h.previous_name, 'new_name', h.code_name)
      from history h
      join facts.instrument_identifiers id
        on id.identifier_type = 'baostock_code'
       and id.identifier_value = h.code
      where h.previous_name is not null and h.previous_name <> h.code_name
    `)
  }, options.transactional ?? true)

  const cnInstruments = await count(
    ctx,
    "select count(*) as n from facts.instruments where primary_market_scope = 'cn_stocks'",
  )
  const cnSymbols = await count(
    ctx,
    "select count(*) as n from facts.symbols where market_scope = 'cn_stocks'",
  )
  const cnIdentifiers = await count(
    ctx,
    "select count(*) as n from facts.instrument_identifiers where source_id = 'baostock'",
  )
  logger.info(
    { cnInstruments, cnSymbols, cnIdentifiers },
    'built CN identity facts',
  )
  return { cnInstruments, cnSymbols, cnIdentifiers }
}

export async function buildCnTradingDays(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ cnTradingDays: number }> {
  const ctx = context(connection, options)
  const hasCalendar = await datasetHasFiles(ctx, 'trade_cal', 'baostock')
  const hasUniverse = await datasetHasFiles(ctx, 'universe', 'baostock')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.trading_days where calendar_id = 'cn_equities'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset in ('trade_cal', 'universe') and market_scope = 'cn_stocks'",
    )
    if (!hasCalendar) return

    await ctx.connection.run(`
      create or replace temp table t_cn_calendar as
      with ${frameRecords(ctx, 'baostock/trade_cal/*/*.frame')},
      parsed as (
        select
          try_cast(trim(r[1]) as date) as market_date,
          trim(r[1]) as market_date_text,
          trim(r[2]) as trading_flag,
          cast(
            regexp_extract(filename, 'snapshot_date=(\\d{4}-\\d{2}-\\d{2})', 1)
            as date
          ) as snapshot_date
        from frame_records
      )
      select *
      from parsed
      where snapshot_date = (select max(snapshot_date) from parsed)
    `)

    await ctx.connection.run(`
      insert into facts.trading_days (
        calendar_id, market_date, is_open, is_half_day, open_utc, close_utc,
        source_id
      )
      select
        'cn_equities', market_date, trading_flag = '1', false,
        null, null, 'baostock'
      from t_cn_calendar
      where market_date is not null and trading_flag in ('0', '1')
      qualify row_number() over (
        partition by market_date order by snapshot_date desc
      ) = 1
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'trade_cal', 'cn_stocks', '*', snapshot_date, 'bad_row',
        json_object('calendar_date', market_date_text, 'flag', trading_flag)
      from t_cn_calendar
      where market_date is null or trading_flag not in ('0', '1')
      on conflict do nothing
    `)

    if (!hasUniverse) return

    await ctx.connection.run(`
      create or replace temp table t_cn_universe_status as
      with
      universe_frames as (
        select
          filename,
          split_part(substr(content, 22), chr(1), 7) as payload,
          try_cast(split_part(substr(content, 22), chr(1), 8) as date)
            as market_date,
          cast(
            regexp_extract(filename, 'snapshot_date=(\\d{4}-\\d{2}-\\d{2})', 1)
            as date
          ) as snapshot_date
        from read_text(${glob(ctx, 'baostock/universe/*/*.frame')})
      ),
      records as (
        select
          market_date,
          snapshot_date,
          unnest(from_json(payload, '{"record":["VARCHAR[]"]}').record) as r
        from universe_frames
        where trim(payload) <> ''
      ),
      latest as (
        select * from records
        where snapshot_date = (select max(snapshot_date) from records)
      )
      select market_date, bool_or(trim(r[2]) = '1') as any_stock_traded
      from latest
      where regexp_full_match(trim(r[1]), '(sh|sz)\\.[0-9]{6}')
      group by market_date
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'universe', 'cn_stocks', '*', u.market_date,
        'calendar_trade_status_conflict',
        json_object(
          'calendar_open', d.is_open,
          'any_security_traded', u.any_stock_traded
        )
      from t_cn_universe_status u
      join facts.trading_days d
        on d.calendar_id = 'cn_equities' and d.market_date = u.market_date
      where d.is_open <> u.any_stock_traded
      on conflict do nothing
    `)
  }, options.transactional ?? true)

  const cnTradingDays = await count(
    ctx,
    "select count(*) as n from facts.trading_days where calendar_id = 'cn_equities'",
  )
  logger.info({ cnTradingDays }, 'built CN trading-day facts')
  return { cnTradingDays }
}

export async function buildCnCorporateActions(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ cnCorporateActions: number; cnActionUnresolved: number }> {
  const ctx = context(connection, options)
  const hasDividends = await datasetHasFiles(ctx, 'dividend', 'baostock')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.corporate_actions where source_id = 'baostock'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset = 'dividend' and market_scope = 'cn_stocks'",
    )
    if (!hasDividends) return

    await ctx.connection.run(`
      create or replace temp table t_cn_dividend_raw as
      with ${frameRecords(ctx, 'baostock/dividend/*/*/*.frame')}
      select
        trim(r[1]) as code,
        try_cast(nullif(trim(r[4]), '') as date) as declaration_date,
        try_cast(nullif(trim(r[6]), '') as date) as record_date,
        trim(r[7]) as ex_date_text,
        try_cast(nullif(trim(r[7]), '') as date) as ex_date,
        try_cast(nullif(trim(r[8]), '') as date) as pay_date,
        trim(r[10]) as cash_text,
        try_cast(nullif(trim(r[10]), '') as double) as cash_amount,
        trim(r[11]) as cash_post_tax_text,
        try_cast(
          nullif(regexp_extract(trim(r[11]), '[0-9]+(\\.[0-9]+)?', 0), '')
          as double
        ) as cash_amount_post_tax,
        trim(r[12]) as bonus_text,
        try_cast(nullif(trim(r[12]), '') as double) as bonus_ratio,
        trim(r[14]) as conversion_text,
        try_cast(nullif(trim(r[14]), '') as double) as conversion_ratio,
        cast(
          regexp_extract(filename, 'year=(\\d{4})', 1) || '-01-01' as date
        ) as evidence_date,
        filename
      from frame_records
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'dividend', 'cn_stocks', coalesce(nullif(code, ''), '(blank)'),
        coalesce(ex_date, evidence_date), 'bad_row',
        json_object(
          'ex_date', ex_date_text, 'cash', cash_text,
          'bonus', bonus_text, 'conversion', conversion_text
        )
      from t_cn_dividend_raw
      where ex_date_text <> ''
        and (
          not regexp_full_match(code, '(sh|sz)\\.[0-9]{6}')
          or ex_date is null
          or (cash_text <> '' and cash_amount is null)
          or (bonus_text <> '' and bonus_ratio is null)
          or (conversion_text <> '' and conversion_ratio is null)
        )
      on conflict do nothing
    `)

    await ctx.connection.run(`
      create or replace temp table t_cn_actions as
      with implemented as (
        select *
        from t_cn_dividend_raw
        where ex_date is not null
          and regexp_full_match(code, '(sh|sz)\\.[0-9]{6}')
          and (cash_text = '' or cash_amount is not null)
          and (bonus_text = '' or bonus_ratio is not null)
          and (conversion_text = '' or conversion_ratio is not null)
        qualify row_number() over (
          partition by code, ex_date order by filename desc
        ) = 1
      ),
      components as (
        select
          code, ex_date, declaration_date, record_date, pay_date,
          'cash' as component, 'cash_dividend' as action_type,
          cash_amount, cash_amount_post_tax,
          cast(null as double) as bonus_ratio,
          cast(null as double) as conversion_ratio
        from implemented
        where coalesce(cash_amount, 0) > 0
        union all
        select
          code, ex_date, declaration_date, record_date, pay_date,
          'stock', 'stock_dividend', null, null,
          coalesce(bonus_ratio, 0), coalesce(conversion_ratio, 0)
        from implemented
        where coalesce(bonus_ratio, 0) + coalesce(conversion_ratio, 0) > 0
      )
      select
        c.*,
        'baostock:' || c.code || ':' || cast(c.ex_date as varchar)
          || ':' || c.component as source_action_id,
        id.instrument_id
      from components c
      left join facts.instrument_identifiers id
        on id.identifier_type = 'baostock_code'
       and id.identifier_value = c.code
       and c.ex_date >= id.valid_from
       and (id.valid_to is null or c.ex_date < id.valid_to)
    `)

    await ctx.connection.run(`
      insert into facts.corporate_actions (
        source_id, source_action_id, instrument_id, market_scope,
        symbol_as_stated, action_type, ex_date, declaration_date,
        record_date, pay_date, split_from, split_to, cash_amount,
        cash_amount_post_tax, bonus_ratio, conversion_ratio, currency,
        dividend_type, frequency
      )
      select
        'baostock', source_action_id, instrument_id, 'cn_stocks',
        substr(code, 4), action_type, ex_date, declaration_date,
        record_date, pay_date, null, null, cash_amount,
        cash_amount_post_tax, bonus_ratio, conversion_ratio, 'CNY', null, null
      from t_cn_actions
      where instrument_id is not null
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select distinct
        'dividend', 'cn_stocks', code, ex_date, 'no_symbol_match',
        json_object('source_action_id', source_action_id)
      from t_cn_actions
      where instrument_id is null
      on conflict do nothing
    `)
  }, options.transactional ?? true)

  const cnCorporateActions = await count(
    ctx,
    "select count(*) as n from facts.corporate_actions where source_id = 'baostock'",
  )
  const cnActionUnresolved = await count(
    ctx,
    "select count(*) as n from ops.unresolved where dataset = 'dividend' and market_scope = 'cn_stocks'",
  )
  logger.info(
    { cnCorporateActions, cnActionUnresolved },
    'built CN corporate-action facts',
  )
  return { cnCorporateActions, cnActionUnresolved }
}

export async function buildCnBarsDaily(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ cnBars: number; cnBarsUnresolved: number }> {
  const ctx = context(connection, options)
  const hasBars = await datasetHasFiles(ctx, 'daily_k', 'baostock')

  await inTransaction(ctx, async () => {
    await ctx.connection.run(
      "delete from facts.bars_daily where source_id = 'baostock'",
    )
    await ctx.connection.run(
      "delete from ops.unresolved where dataset = 'daily_k' and market_scope = 'cn_stocks'",
    )
    if (!hasBars) return

    await ctx.connection.run(`
      create or replace temp table t_cn_daily_raw as
      with ${frameRecords(ctx, 'baostock/daily_k/*/*/*.frame')}
      select
        trim(r[2]) as code,
        trim(r[1]) as market_date_text,
        try_cast(trim(r[1]) as date) as market_date,
        try_cast(nullif(trim(r[3]), '') as double) as open,
        try_cast(nullif(trim(r[4]), '') as double) as high,
        try_cast(nullif(trim(r[5]), '') as double) as low,
        try_cast(nullif(trim(r[6]), '') as double) as close,
        try_cast(nullif(trim(r[8]), '') as double) as volume,
        trim(r[12]) as trade_status,
        trim(r[14]) as is_st,
        try_cast(
          regexp_extract(filename, 'window=(\\d{4}-\\d{2}-\\d{2})_', 1)
          as date
        ) as evidence_date,
        filename
      from frame_records
      qualify row_number() over (
        partition by trim(r[2]), try_cast(trim(r[1]) as date)
        order by filename desc
      ) = 1
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'daily_k', 'cn_stocks', coalesce(nullif(code, ''), '(blank)'),
        coalesce(market_date, evidence_date), 'bad_row',
        json_object(
          'date', market_date_text, 'trade_status', trade_status,
          'open', open, 'high', high, 'low', low, 'close', close,
          'volume', volume
        )
      from t_cn_daily_raw
      where trade_status not in ('0', '1')
         or (
           trade_status = '1' and (
             market_date is null or coalesce(volume, 0) <= 0
             or open is null or high is null or low is null or close is null
             or low > least(open, close) or high < greatest(open, close)
           )
         )
      on conflict do nothing
    `)

    await ctx.connection.run(`
      create or replace temp table t_cn_bars_resolved as
      select b.*, id.instrument_id
      from t_cn_daily_raw b
      left join facts.instrument_identifiers id
        on id.identifier_type = 'baostock_code'
       and id.identifier_value = b.code
       and b.market_date >= id.valid_from
       and (id.valid_to is null or b.market_date < id.valid_to)
      where b.trade_status = '1'
        and coalesce(b.volume, 0) > 0
        and b.market_date is not null
        and b.open is not null and b.high is not null
        and b.low is not null and b.close is not null
        and b.low <= least(b.open, b.close)
        and b.high >= greatest(b.open, b.close)
    `)

    await ctx.connection.run(`
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume, vwap, trade_count
      )
      select
        'baostock', instrument_id, market_date, 'cn_stocks', substr(code, 4),
        open, high, low, close, volume, null, null
      from t_cn_bars_resolved
      where instrument_id is not null
    `)

    await ctx.connection.run(`
      insert into ops.unresolved (
        dataset, market_scope, symbol, market_date, reason, sample
      )
      select
        'daily_k', 'cn_stocks', code, market_date, 'no_symbol_match',
        json_object('close', close, 'is_st', is_st)
      from t_cn_bars_resolved
      where instrument_id is null
      on conflict do nothing
    `)
  }, options.transactional ?? true)

  const cnBars = await count(
    ctx,
    "select count(*) as n from facts.bars_daily where source_id = 'baostock'",
  )
  const cnBarsUnresolved = await count(
    ctx,
    "select count(*) as n from ops.unresolved where dataset = 'daily_k' and market_scope = 'cn_stocks'",
  )
  logger.info({ cnBars, cnBarsUnresolved }, 'built CN daily-bar facts')
  return { cnBars, cnBarsUnresolved }
}

// Diagnostic-only staging of BaoStock's cumulative adjustment series. The
// generic temp-table contract keeps vendor field positions inside this module;
// downstream comparison code never references BaoStock response names.
export async function stageCnVendorAdjustmentFactors(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ vendorFactorRows: number; invalidVendorFactorRows: number }> {
  const ctx = context(connection, options)
  const hasFactors = await datasetHasFiles(ctx, 'adj_factor', 'baostock')

  await ctx.connection.run(`
    create or replace temp table t_cn_vendor_factor_events (
      vendor_code varchar,
      event_date date,
      cumulative_factor double,
      vendor_price_factor double,
      row_status varchar
    );
    create or replace temp table t_cn_vendor_factor_invalid (
      vendor_code varchar,
      event_date_text varchar,
      cumulative_factor_text varchar,
      reason varchar
    )
  `)
  if (!hasFactors) {
    return { vendorFactorRows: 0, invalidVendorFactorRows: 0 }
  }

  await ctx.connection.run(`
    create or replace temp table t_cn_vendor_factor_parsed as
    with ${frameRecords(ctx, 'baostock/adj_factor/*/*/*.frame')}
    select
      trim(r[1]) as vendor_code,
      trim(r[2]) as event_date_text,
      try_cast(trim(r[2]) as date) as event_date,
      trim(r[4]) as cumulative_factor_text,
      try_cast(trim(r[4]) as double) as cumulative_factor,
      filename
    from frame_records
  `)

  await ctx.connection.run(`
    insert into t_cn_vendor_factor_invalid
    select
      vendor_code, event_date_text, cumulative_factor_text,
      case
        when not regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
          then 'invalid_vendor_code'
        when event_date is null then 'invalid_event_date'
        when cumulative_factor is null then 'invalid_cumulative_factor'
        else 'nonpositive_cumulative_factor'
      end
    from t_cn_vendor_factor_parsed
    where not regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
       or event_date is null
       or cumulative_factor is null
       or cumulative_factor <= 0
  `)

  await ctx.connection.run(`
    insert into t_cn_vendor_factor_events
    with valid as (
      select vendor_code, event_date, cumulative_factor
      from t_cn_vendor_factor_parsed
      where regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
        and event_date is not null
        and cumulative_factor > 0
      qualify row_number() over (
        partition by vendor_code, event_date order by filename desc
      ) = 1
    ),
    increments as (
      select
        *,
        lag(cumulative_factor) over (
          partition by vendor_code order by event_date
        ) as previous_cumulative_factor
      from valid
    )
    select
      vendor_code,
      event_date,
      cumulative_factor,
      previous_cumulative_factor / cumulative_factor,
      case when previous_cumulative_factor is null
        then 'vendor_baseline'
        else 'comparable'
      end
    from increments
  `)

  const vendorFactorRows = await count(
    ctx,
    'select count(*) as n from t_cn_vendor_factor_events',
  )
  const invalidVendorFactorRows = await count(
    ctx,
    'select count(*) as n from t_cn_vendor_factor_invalid',
  )
  return { vendorFactorRows, invalidVendorFactorRows }
}

// Generic raw-coverage staging for the continuity contract. BaoStock response
// positions and manifest parameter names stay here; the verifier consumes only
// vendor_code/date/traded/suspended and normalized request windows.
export async function stageCnDailyCoverage(
  connection: DuckDBConnection,
  options: BuildOptions = {},
): Promise<{ dailyRows: number; rawWindows: number; invalidRows: number }> {
  const ctx = context(connection, options)
  const hasDaily = await datasetHasFiles(ctx, 'daily_k', 'baostock')

  await ctx.connection.run(`
    create or replace temp table t_cn_daily_coverage (
      vendor_code varchar,
      market_date date,
      is_traded boolean,
      is_suspended boolean
    );
    create or replace temp table t_cn_daily_raw_windows (
      vendor_code varchar,
      window_start date,
      window_end date
    );
    create or replace temp table t_cn_daily_coverage_invalid (
      vendor_code varchar,
      market_date_text varchar,
      reason varchar
    )
  `)
  if (!hasDaily) {
    return { dailyRows: 0, rawWindows: 0, invalidRows: 0 }
  }

  await ctx.connection.run(`
    create or replace temp table t_cn_daily_windows_parsed as
    select
      json_extract_string(request_params, '$.code') as vendor_code,
      json_extract_string(request_params, '$.start_date') as start_text,
      json_extract_string(request_params, '$.end_date') as end_text,
      try_cast(json_extract_string(request_params, '$.start_date') as date)
        as window_start,
      try_cast(json_extract_string(request_params, '$.end_date') as date)
        as window_end,
      count(*) as actual_frames,
      max(try_cast(json_extract_string(request_params, '$.frame_count')
                   as integer)) as expected_frames
    from raw.fetches
    where source_id = 'baostock' and dataset = 'daily_k'
    group by all
  `)
  await ctx.connection.run(`
    insert into t_cn_daily_raw_windows
    select vendor_code, window_start, window_end
    from t_cn_daily_windows_parsed
    where regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
      and window_start is not null
      and window_end is not null
      and window_start <= window_end
      and expected_frames > 0
      and actual_frames = expected_frames
  `)
  await ctx.connection.run(`
    insert into t_cn_daily_coverage_invalid
    select
      coalesce(vendor_code, '(blank)'),
      coalesce(start_text, '') || '..' || coalesce(end_text, ''),
      case
        when expected_frames is null or expected_frames <= 0
          then 'missing_frame_count'
        when actual_frames <> expected_frames then 'incomplete_raw_window'
        else 'invalid_raw_window'
      end
    from t_cn_daily_windows_parsed
    where not regexp_full_match(coalesce(vendor_code, ''), '(sh|sz)\\.[0-9]{6}')
       or window_start is null
       or window_end is null
       or window_start > window_end
       or expected_frames is null
       or expected_frames <= 0
       or actual_frames <> expected_frames
  `)

  await ctx.connection.run(`
    create or replace temp table t_cn_daily_coverage_parsed as
    with ${frameRecords(ctx, 'baostock/daily_k/*/*/*.frame')}
    select
      trim(r[2]) as vendor_code,
      trim(r[1]) as market_date_text,
      try_cast(trim(r[1]) as date) as market_date,
      trim(r[12]) as trade_status,
      try_cast(nullif(trim(r[8]), '') as double) as volume,
      filename
    from frame_records
  `)
  await ctx.connection.run(`
    insert into t_cn_daily_coverage_invalid
    select
      coalesce(nullif(vendor_code, ''), '(blank)'), market_date_text,
      case
        when not regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
          then 'invalid_vendor_code'
        when market_date is null then 'invalid_market_date'
        when trade_status not in ('0', '1') then 'invalid_trade_status'
        else 'traded_without_volume'
      end
    from t_cn_daily_coverage_parsed
    where not regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
       or market_date is null
       or trade_status not in ('0', '1')
       or (trade_status = '1' and coalesce(volume, 0) <= 0)
  `)
  await ctx.connection.run(`
    insert into t_cn_daily_coverage
    select
      vendor_code,
      market_date,
      trade_status = '1' and volume > 0,
      trade_status = '0'
    from t_cn_daily_coverage_parsed
    where regexp_full_match(vendor_code, '(sh|sz)\\.[0-9]{6}')
      and market_date is not null
      and trade_status in ('0', '1')
      and (trade_status = '0' or volume > 0)
    qualify row_number() over (
      partition by vendor_code, market_date order by filename desc
    ) = 1
  `)

  return {
    dailyRows: await count(
      ctx,
      'select count(*) as n from t_cn_daily_coverage',
    ),
    rawWindows: await count(
      ctx,
      'select count(*) as n from t_cn_daily_raw_windows',
    ),
    invalidRows: await count(
      ctx,
      'select count(*) as n from t_cn_daily_coverage_invalid',
    ),
  }
}
