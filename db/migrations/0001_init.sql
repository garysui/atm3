-- 0001_init: layer schemas and initial tables (docs/data-model.md).
--
-- Migration rules:
-- - Migrations are run-once, in filename order, each inside a transaction
--   together with its ops.schema_migrations ledger insert.
-- - Never edit an applied migration: databases that already ran it will not
--   pick up the change. Add a new numbered migration instead.
--
-- Layers: raw (vendor truth catalog; payloads live on disk), facts (organized
-- facts, rebuildable from raw), computed (caches of pure functions over
-- facts; always droppable), ops (bookkeeping, never market truth).

create schema if not exists raw;
create schema if not exists facts;
create schema if not exists computed;
create schema if not exists ops;

-- ops ------------------------------------------------------------------

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

-- Catalog of verbatim vendor payload files under data/raw/. The files are the
-- raw truth; these rows only account for them.
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
  primary key (source_id, instrument_id, market_date)
);

-- computed ---------------------------------------------------------------
-- Caches of pure functions over facts + a point in time. Dropping any
-- computed table must lose nothing but time.

create table if not exists computed.adjustment_factors (
  instrument_id uuid not null,
  event_date date not null,
  action_type varchar not null, -- split | cash_dividend
  price_factor double not null,
  volume_factor double not null,
  evidence varchar not null, -- facts.corporate_actions key
  primary key (instrument_id, event_date, action_type)
);

create table if not exists computed.bars_daily_adjusted (
  instrument_id uuid not null,
  market_date date not null,
  adjustment_policy varchar not null, -- none | split | split_dividend
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
