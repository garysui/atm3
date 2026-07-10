-- Declarative schema (docs/data-model.md), applied idempotently at every
-- database open. The database file is a disposable index over data/raw/:
-- it holds nothing that raw files cannot reproduce.
--
-- Schema-change rules:
-- - New tables/schemas: just add them here; `if not exists` picks them up.
-- - Anything `if not exists` cannot express (column/key changes): edit the
--   declaration AND bump SCHEMA_VERSION in server/db.ts. Existing database
--   files then refuse to open and are deleted + rebuilt from data/raw.
--   There is no migration machinery, on purpose.
--
-- Layers: raw (vendor truth catalog; payloads live on disk), facts (organized
-- facts, rebuildable from raw), computed (caches of pure functions over
-- facts; always droppable), ops (bookkeeping, never market truth).

create schema if not exists raw;
create schema if not exists facts;
create schema if not exists computed;
create schema if not exists ops;

-- Deterministic ids (tech-stack D5): the same identity evidence always mints
-- the same uuid, so a full rebuild from raw reproduces every id. MD5-derived
-- with RFC 4122 version-3 and variant bits set (validators like zod's
-- z.uuid() reject raw-hash "uuids" whose version nibble is not 1-8).
create or replace macro deterministic_uuid(kind, key) as
  cast(concat(
    substr(md5(concat('atm3:', kind, ':', key)), 1, 8), '-',
    substr(md5(concat('atm3:', kind, ':', key)), 9, 4), '-3',
    substr(md5(concat('atm3:', kind, ':', key)), 14, 3), '-',
    substr('89ab',
      ((strpos('0123456789abcdef',
               substr(md5(concat('atm3:', kind, ':', key)), 17, 1)) - 1) % 4)
        + 1, 1),
    substr(md5(concat('atm3:', kind, ':', key)), 18, 3), '-',
    substr(md5(concat('atm3:', kind, ':', key)), 21, 12)
  ) as uuid);

-- ops ------------------------------------------------------------------

create table if not exists ops.meta (
  key varchar primary key, -- schema_version | ...
  value varchar not null
);

create table if not exists ops.runs (
  run_id uuid primary key,
  job varchar not null,
  status varchar not null, -- running | ok | failed
  params json,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error varchar
);

create table if not exists ops.sync_state (
  job varchar not null,
  scope varchar not null,
  cursor varchar,
  last_success_date date,
  detail json,
  updated_at timestamptz not null default now(),
  primary key (job, scope)
);

-- Observations that could not be resolved to an instrument: quarantined,
-- never guessed, never silently dropped.
create table if not exists ops.unresolved (
  dataset varchar not null,
  market_scope varchar not null,
  symbol varchar not null,
  market_date date not null,
  reason varchar not null, -- no_symbol_match | ambiguous | bad_row
  sample json,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (dataset, market_scope, symbol, market_date)
);

-- raw ------------------------------------------------------------------

create table if not exists raw.sources (
  source_id varchar primary key,
  display_name varchar not null,
  base_url varchar
);

-- Index of verbatim vendor payload files under data/raw/. The files (each
-- with a .meta.json manifest) are the raw truth; this table is rebuildable
-- by rescanning the raw zone.
create table if not exists raw.fetches (
  fetch_id uuid primary key,
  run_id uuid,
  source_id varchar not null,
  dataset varchar not null,
  request_url varchar not null,
  request_params json,
  market_scope varchar,
  market_date date,
  page_cursor varchar,
  http_status integer not null,
  file_path varchar not null, -- relative to ATM3_DATA_DIR
  file_bytes bigint not null,
  content_sha256 varchar not null,
  row_count integer,
  fetched_at timestamptz not null default now()
);

-- facts ----------------------------------------------------------------

create table if not exists facts.exchanges (
  exchange_mic varchar primary key,
  name varchar not null,
  exchange_type varchar,
  market_scope varchar not null,
  calendar_id varchar not null, -- us_equities | cn_equities | ...
  timezone varchar not null,
  country varchar,
  currency varchar
);

create table if not exists facts.trading_days (
  calendar_id varchar not null,
  market_date date not null,
  is_open boolean not null,
  is_half_day boolean not null default false,
  open_utc timestamptz,
  close_utc timestamptz,
  source_id varchar not null,
  primary key (calendar_id, market_date)
);

create table if not exists facts.instruments (
  instrument_id uuid primary key, -- deterministic, minted from identity evidence
  asset_class varchar not null, -- equity | index | ...
  instrument_type varchar not null, -- common_stock | etf | adr | index | ...
  security_form varchar not null default 'unknown_stock_like',
  is_clean_common_stock boolean not null default false,
  name varchar not null,
  primary_market_scope varchar not null,
  primary_exchange_mic varchar,
  currency varchar,
  active boolean not null default true,
  delisted_date date,
  first_seen_date date,
  updated_at timestamptz not null default now()
);

-- A ticker is a time-ranged lookup handle, never an identity.
-- resolve(market_scope, symbol, date) -> instrument_id.
create table if not exists facts.symbols (
  symbol_id uuid primary key,
  instrument_id uuid not null,
  market_scope varchar not null,
  symbol varchar not null,
  exchange_mic varchar,
  valid_from date, -- null = unknown start
  valid_to date, -- null = current
  is_primary boolean not null default true,
  evidence json,
  updated_at timestamptz not null default now(),
  unique (market_scope, symbol, valid_from)
);

create table if not exists facts.instrument_identifiers (
  identifier_type varchar not null, -- composite_figi | share_class_figi | cik | isin | ts_code
  identifier_value varchar not null,
  valid_from date not null, -- earliest evidence date when the source states none
  instrument_id uuid not null,
  source_id varchar not null,
  valid_to date,
  primary key (identifier_type, identifier_value, valid_from)
);

create table if not exists facts.symbol_events (
  source_id varchar not null,
  event_type varchar not null, -- ticker_change | listing | delisting
  event_date date not null,
  old_symbol varchar not null default '',
  new_symbol varchar not null default '',
  market_scope varchar not null,
  instrument_id uuid,
  primary key (source_id, event_type, event_date, old_symbol, new_symbol)
);

create table if not exists facts.corporate_actions (
  source_id varchar not null,
  source_action_id varchar not null,
  instrument_id uuid not null,
  market_scope varchar not null,
  symbol_as_stated varchar not null,
  action_type varchar not null, -- split | cash_dividend | stock_dividend | merger | spinoff | delisting
  ex_date date not null,
  declaration_date date,
  record_date date,
  pay_date date,
  split_from double,
  split_to double,
  cash_amount double,
  cash_amount_post_tax double,
  bonus_ratio double,
  conversion_ratio double,
  currency varchar,
  dividend_type varchar,
  frequency integer,
  primary key (source_id, source_action_id)
);

create table if not exists facts.instrument_events (
  source_id varchar not null,
  source_event_id varchar not null,
  instrument_id uuid not null,
  event_type varchar not null, -- earnings | filing | ...
  event_date date not null,
  event_time_utc timestamptz,
  timing varchar not null default 'unknown', -- bmo | amc | during | unknown
  title varchar not null,
  payload json,
  primary key (source_id, source_event_id)
);

-- Unadjusted, as traded, under the ticker of the day, linked to the
-- instrument. Vendor-adjusted bars are never stored here.
-- symbol_as_traded is part of the key because one instrument can trade as
-- two concurrent tape lines on the same day (e.g. when-issued tickers like
-- AAP/AAPW); the computed layer picks the primary line per instrument-day.
create table if not exists facts.bars_daily (
  source_id varchar not null,
  instrument_id uuid not null,
  market_date date not null,
  market_scope varchar not null,
  symbol_as_traded varchar not null,
  open double not null,
  high double not null,
  low double not null,
  close double not null,
  volume double,
  vwap double,
  trade_count bigint,
  primary key (source_id, instrument_id, market_date, symbol_as_traded)
);

-- Minute bars. Raw truth is the vendor's csv.gz flat file per trading day;
-- facts materialize a PARSE-ONLY parquet per day under
-- __ATM3_DATA_DIR__/facts/bars_minute/ (typed columns, nothing interpreted
-- beyond parsing; derived and rebuildable from raw). Identity attaches HERE,
-- at query time — never baked into files — so symbol-history refinements
-- retroactively apply to all minute history with zero rebuilds. The
-- _sentinel parquet (zero rows) is auto-created so the glob always binds.
create or replace view facts.bars_minute_parsed as
select market_date, symbol, window_start_utc,
       open, high, low, close, volume, transactions
from read_parquet('__ATM3_DATA_DIR__/facts/bars_minute/*/*.parquet')
where market_date is not null;

create or replace view facts.bars_minute as
with usage_resolution as (
  select d.market_date, d.symbol, s.instrument_id
  from (
    select distinct market_date, symbol from facts.bars_minute_parsed
  ) d
  join facts.symbols s
    on s.market_scope = 'us_stocks'
   and s.symbol = d.symbol
   and (s.valid_from is null or d.market_date >= s.valid_from)
   and (s.valid_to is null or d.market_date < s.valid_to)
  qualify row_number() over (
    partition by d.symbol, d.market_date
    order by s.valid_from desc nulls last
  ) = 1
)
select r.instrument_id, p.market_date, p.symbol as symbol_as_traded,
       p.window_start_utc, p.open, p.high, p.low, p.close, p.volume,
       p.transactions
from facts.bars_minute_parsed p
join usage_resolution r
  on r.symbol = p.symbol and r.market_date = p.market_date;

-- Quarantine as a function: minute rows whose symbol resolves to no
-- instrument on that date (exchange test tickers, out-of-universe lines).
create or replace view facts.bars_minute_unresolved as
select p.symbol, p.market_date, count(*) as bars
from facts.bars_minute_parsed p
anti join (
  select d.market_date, d.symbol
  from (
    select distinct market_date, symbol from facts.bars_minute_parsed
  ) d
  join facts.symbols s
    on s.market_scope = 'us_stocks'
   and s.symbol = d.symbol
   and (s.valid_from is null or d.market_date >= s.valid_from)
   and (s.valid_to is null or d.market_date < s.valid_to)
) r on r.symbol = p.symbol and r.market_date = p.market_date
group by p.symbol, p.market_date;

-- computed ---------------------------------------------------------------
-- The computed layer is ALGORITHMS over facts: views and table macros,
-- computed at query time. Adjusted data is a view of the facts at a point
-- in time T, never data — a new corporate action retroactively changes
-- every historical adjusted bar. "100 functions on one data."
--
-- Exactly one optional cache table exists (bars_daily_adjusted_cache); it
-- is a materialized snapshot of the macro at the current T, verified
-- identical, invalidated by watermark, and always droppable.

-- One canonical vendor per market scope, then one tape line per
-- instrument-day (max volume; one instrument can trade as concurrent lines,
-- e.g. when-issued tickers). Adding a second vendor for one scope requires an
-- explicit precedence/reconciliation policy here; volume never picks vendors.
create or replace view computed.canonical_bars_daily as
select instrument_id, market_date, symbol_as_traded,
       open, high, low, close, volume, vwap
from facts.bars_daily
where (market_scope = 'us_stocks' and source_id = 'polygon')
   or (market_scope = 'cn_stocks' and source_id = 'baostock')
qualify row_number() over (
  partition by instrument_id, market_date
  order by volume desc nulls last, symbol_as_traded
) = 1;

-- Same-day dividend cash per instrument: accept the instrument's own currency
-- (USD fallback for legacy rows), collapse duplicate statements, then SUM
-- distinct regular/special distributions because they reduce one prev close.
create or replace view computed.dividend_cash_by_exdate as
with statements as (
  select distinct
    c.instrument_id, c.ex_date,
    coalesce(c.dividend_type, '') as dividend_type,
    c.cash_amount,
    coalesce(nullif(upper(i.currency), ''), 'USD') as expected_currency,
    coalesce(
      nullif(upper(c.currency), ''),
      coalesce(nullif(upper(i.currency), ''), 'USD')
    ) as statement_currency
  from facts.corporate_actions c
  join facts.instruments i using (instrument_id)
  where c.action_type = 'cash_dividend' and coalesce(c.cash_amount, 0) > 0
)
select
  instrument_id,
  ex_date,
  -- Compatibility aliases: for all existing US rows expected_currency=USD,
  -- so these retain their exact historical meaning and values.
  coalesce(
    sum(cash_amount) filter (statement_currency = expected_currency), 0
  ) as cash_usd,
  count(*) filter (statement_currency <> expected_currency) as non_usd_rows,
  string_agg(dividend_type || ':' || cash_amount, ','
             order by dividend_type, cash_amount) as evidence,
  expected_currency,
  coalesce(
    sum(cash_amount) filter (statement_currency = expected_currency), 0
  ) as cash_amount,
  count(*) filter (statement_currency <> expected_currency)
    as currency_mismatch_rows
from statements
group by instrument_id, ex_date, expected_currency;

-- Per-event adjustment factors from corporate-action facts and our own raw
-- closes (see core/adjustments.ts). Vendor adjustment factors are never
-- used (Polygon dividend factors are cumulative, not per-event). A company
-- executes at most one split per day: duplicate same-day split statements
-- collapse to one (lowest source_action_id), never a product.
create or replace view computed.adjustment_factor_events as
with split_statements as (
  select *,
    row_number() over (
      partition by instrument_id, ex_date order by source_action_id
    ) as statement_rank,
    string_agg(source_id || ':' || source_action_id, ',') over (
      partition by instrument_id, ex_date
    ) as all_evidence
  from facts.corporate_actions
  where action_type = 'split'
    and coalesce(split_from, 0) > 0
    and coalesce(split_to, 0) > 0
),
stock_statements as (
  select *,
    row_number() over (
      partition by instrument_id, ex_date,
                   coalesce(bonus_ratio, 0), coalesce(conversion_ratio, 0)
      order by source_id, source_action_id
    ) as statement_rank
  from facts.corporate_actions
  where action_type = 'stock_dividend'
    and coalesce(bonus_ratio, 0) + coalesce(conversion_ratio, 0) > 0
),
stock_by_exdate as (
  select
    instrument_id,
    ex_date,
    sum(coalesce(bonus_ratio, 0)) as bonus_ratio,
    sum(coalesce(conversion_ratio, 0)) as conversion_ratio,
    string_agg(source_id || ':' || source_action_id, ','
               order by source_id, source_action_id) as evidence
  from stock_statements
  where statement_rank = 1
  group by instrument_id, ex_date
)
select
  instrument_id, ex_date as event_date, 'split' as action_type,
  split_from / split_to as price_factor,
  split_to / split_from as volume_factor,
  all_evidence as evidence
from split_statements
where statement_rank = 1
union all
select
  c.instrument_id, c.ex_date as event_date, 'cash_dividend' as action_type,
  1 - c.cash_amount / b.close as price_factor,
  1.0 as volume_factor,
  c.evidence
from computed.dividend_cash_by_exdate c
asof join computed.canonical_bars_daily b
  on c.instrument_id = b.instrument_id and c.ex_date > b.market_date
where c.cash_amount > 0 and b.close > c.cash_amount
union all
select
  s.instrument_id, s.ex_date as event_date, 'stock_dividend' as action_type,
  1.0 / (1.0 + s.bonus_ratio + s.conversion_ratio) as price_factor,
  1.0 + s.bonus_ratio + s.conversion_ratio as volume_factor,
  s.evidence
from stock_by_exdate s;

-- Dividends that produce no factor, with the reason — quarantine-style
-- visibility as a function, not a stored table.
create or replace view computed.unadjustable_dividends as
select
  c.instrument_id, c.ex_date, c.cash_usd, c.non_usd_rows,
  b.close as prev_close,
  case when c.cash_amount = 0 and c.expected_currency = 'USD'
         then 'non_usd_only'
       when c.cash_amount = 0 then 'currency_mismatch_only'
       when b.close is null then 'no_prev_close'
       else 'cash_exceeds_prev_close' end as reason,
  c.cash_amount, c.expected_currency, c.currency_mismatch_rows
from computed.dividend_cash_by_exdate c
asof left join computed.canonical_bars_daily b
  on c.instrument_id = b.instrument_id and c.ex_date > b.market_date
where c.cash_amount = 0 or b.close is null or b.close <= c.cash_amount;

-- THE adjusted-bars algorithm: any policy, any as-of date T, computed on
-- the fly from facts. A bar's cumulative factor is the product over events
-- with ex_date > bar date; an event applies only where the (as-of-limited)
-- series has bars after it — each series anchors to its own latest tape.
-- Policies: 'none' | 'split' | 'split_dividend'.
create or replace macro computed.adjusted_bars(policy, as_of := null) as table
with bars as (
  select * from computed.canonical_bars_daily
  where as_of is null or market_date <= as_of
),
last_bar as (
  select instrument_id, max(market_date) as last_bar_date
  from bars
  group by instrument_id
),
f as (
  select af.instrument_id, af.event_date,
         product(af.price_factor) as pf,
         product(af.volume_factor) as vf
  from computed.adjustment_factor_events af
  join last_bar lb
    on lb.instrument_id = af.instrument_id
    and af.event_date <= lb.last_bar_date
  where (af.action_type in ('split', 'stock_dividend')
           and policy in ('split', 'split_dividend'))
     or (af.action_type = 'cash_dividend'
           and policy = 'split_dividend')
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
  policy as adjustment_policy,
  b.open * coalesce(c.cum_pf, 1) as open,
  b.high * coalesce(c.cum_pf, 1) as high,
  b.low * coalesce(c.cum_pf, 1) as low,
  b.close * coalesce(c.cum_pf, 1) as close,
  b.volume * coalesce(c.cum_vf, 1) as volume,
  b.vwap * coalesce(c.cum_pf, 1) as vwap,
  coalesce(c.cum_pf, 1) as cum_price_factor,
  coalesce(c.cum_vf, 1) as cum_volume_factor,
  b.symbol_as_traded
from bars b
left join cum c
  on c.instrument_id = b.instrument_id
  and b.market_date < c.event_date
  and (c.prev_event_date is null or b.market_date >= c.prev_event_date);

-- Single-instrument variant with the filter INSIDE every stage, so one
-- chart/series query prunes to one instrument instead of paying the
-- full-market computation.
create or replace macro computed.adjusted_bars_for(instrument, policy, as_of := null) as table
with bars as (
  select * from computed.canonical_bars_daily
  where instrument_id = instrument
    and (as_of is null or market_date <= as_of)
),
last_bar as (
  select max(market_date) as last_bar_date from bars
),
f as (
  select af.event_date,
         product(af.price_factor) as pf,
         product(af.volume_factor) as vf
  from computed.adjustment_factor_events af, last_bar lb
  where af.instrument_id = instrument
    and af.event_date <= lb.last_bar_date
    and ((af.action_type in ('split', 'stock_dividend')
            and policy in ('split', 'split_dividend'))
      or (af.action_type = 'cash_dividend'
            and policy = 'split_dividend'))
  group by af.event_date
),
cum as (
  select
    event_date,
    lag(event_date) over (order by event_date) as prev_event_date,
    product(pf) over (order by event_date desc) as cum_pf,
    product(vf) over (order by event_date desc) as cum_vf
  from f
)
select
  b.instrument_id,
  b.market_date,
  policy as adjustment_policy,
  b.open * coalesce(c.cum_pf, 1) as open,
  b.high * coalesce(c.cum_pf, 1) as high,
  b.low * coalesce(c.cum_pf, 1) as low,
  b.close * coalesce(c.cum_pf, 1) as close,
  b.volume * coalesce(c.cum_vf, 1) as volume,
  b.vwap * coalesce(c.cum_pf, 1) as vwap,
  coalesce(c.cum_pf, 1) as cum_price_factor,
  coalesce(c.cum_vf, 1) as cum_volume_factor,
  b.symbol_as_traded
from bars b
left join cum c
  on b.market_date < c.event_date
  and (c.prev_event_date is null or b.market_date >= c.prev_event_date);

-- Minute-level adjusted bars: the SAME per-event factors, day-grained — all
-- minutes of a trading day share that day's cumulative factor. Policies and
-- the series-anchor rule match computed.adjusted_bars.
create or replace macro computed.adjusted_bars_minute(policy, as_of := null) as table
with bars as (
  select * from facts.bars_minute
  where as_of is null or market_date <= as_of
),
last_bar as (
  select instrument_id, max(market_date) as last_bar_date
  from bars
  group by instrument_id
),
f as (
  select af.instrument_id, af.event_date,
         product(af.price_factor) as pf,
         product(af.volume_factor) as vf
  from computed.adjustment_factor_events af
  join last_bar lb
    on lb.instrument_id = af.instrument_id
   and af.event_date <= lb.last_bar_date
  where (af.action_type in ('split', 'stock_dividend')
           and policy in ('split', 'split_dividend'))
     or (af.action_type = 'cash_dividend'
           and policy = 'split_dividend')
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
  b.window_start_utc,
  policy as adjustment_policy,
  b.open * coalesce(c.cum_pf, 1) as open,
  b.high * coalesce(c.cum_pf, 1) as high,
  b.low * coalesce(c.cum_pf, 1) as low,
  b.close * coalesce(c.cum_pf, 1) as close,
  b.volume * coalesce(c.cum_vf, 1) as volume,
  b.transactions,
  coalesce(c.cum_pf, 1) as cum_price_factor,
  coalesce(c.cum_vf, 1) as cum_volume_factor,
  b.symbol_as_traded
from bars b
left join cum c
  on c.instrument_id = b.instrument_id
  and b.market_date < c.event_date
  and (c.prev_event_date is null or b.market_date >= c.prev_event_date);

-- Single-instrument variant with filters inside every stage.
create or replace macro computed.adjusted_bars_minute_for(instrument, policy, as_of := null) as table
with bars as (
  select * from facts.bars_minute
  where instrument_id = instrument
    and (as_of is null or market_date <= as_of)
),
last_bar as (
  select max(market_date) as last_bar_date from bars
),
f as (
  select af.event_date,
         product(af.price_factor) as pf,
         product(af.volume_factor) as vf
  from computed.adjustment_factor_events af, last_bar lb
  where af.instrument_id = instrument
    and af.event_date <= lb.last_bar_date
    and ((af.action_type in ('split', 'stock_dividend')
            and policy in ('split', 'split_dividend'))
      or (af.action_type = 'cash_dividend'
            and policy = 'split_dividend'))
  group by af.event_date
),
cum as (
  select
    event_date,
    lag(event_date) over (order by event_date) as prev_event_date,
    product(pf) over (order by event_date desc) as cum_pf,
    product(vf) over (order by event_date desc) as cum_vf
  from f
)
select
  b.instrument_id,
  b.market_date,
  b.window_start_utc,
  policy as adjustment_policy,
  b.open * coalesce(c.cum_pf, 1) as open,
  b.high * coalesce(c.cum_pf, 1) as high,
  b.low * coalesce(c.cum_pf, 1) as low,
  b.close * coalesce(c.cum_pf, 1) as close,
  b.volume * coalesce(c.cum_vf, 1) as volume,
  b.transactions,
  coalesce(c.cum_pf, 1) as cum_price_factor,
  coalesce(c.cum_vf, 1) as cum_volume_factor,
  b.symbol_as_traded
from bars b
left join cum c
  on b.market_date < c.event_date
  and (c.prev_event_date is null or b.market_date >= c.prev_event_date);

-- Optional accelerator: a snapshot of computed.adjusted_bars(policy) at the
-- current T. Refreshed by `npm run computed:cache`; consumers must check
-- computed.build_state freshness or use the macro directly.
create table if not exists computed.bars_daily_adjusted_cache (
  instrument_id uuid not null,
  market_date date not null,
  adjustment_policy varchar not null, -- split | split_dividend
  open double not null,
  high double not null,
  low double not null,
  close double not null,
  volume double,
  vwap double,
  cum_price_factor double not null,
  cum_volume_factor double not null,
  symbol_as_traded varchar not null,
  computation_version varchar not null,
  computed_at timestamptz not null default now(),
  primary key (instrument_id, market_date, adjustment_policy)
);

create table if not exists computed.build_state (
  artifact varchar not null,
  scope varchar not null,
  computation_version varchar not null,
  inputs_watermark varchar not null,
  built_at timestamptz not null default now(),
  primary key (artifact, scope)
);

-- seeds ------------------------------------------------------------------

insert into raw.sources (source_id, display_name, base_url) values
  ('polygon', 'Polygon.io', 'https://api.polygon.io'),
  ('sec', 'SEC EDGAR', 'https://data.sec.gov'),
  ('benzinga', 'Benzinga via Polygon', 'https://api.polygon.io'),
  ('cboe', 'CBOE', 'https://www.cboe.com'),
  ('tushare', 'Tushare Pro', 'https://api.tushare.pro')
on conflict (source_id) do nothing;
