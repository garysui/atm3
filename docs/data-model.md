# atm3 Data Model

Status: proposed 2026-07-08, needs owner sign-off. Entity names below are
`schema_table`; the prefix is the DuckDB schema (`raw`, `facts`, `computed`,
`ops`).

## Layers

```mermaid
flowchart LR
  V["Vendors\nPolygon / SEC / CBOE / Tushare"] -->|fetch verbatim| RAW
  subgraph RAW["raw — untouched truth"]
    files["data/raw/&lt;source&gt;/&lt;dataset&gt;/... files"]
    catalog["raw.fetches catalog"]
    views["raw.v_* parse views (no copy)"]
    files --- catalog
    files --> views
  end
  subgraph FACTS["facts — organized facts (rebuildable from raw)"]
    identity["instruments / symbols / identifiers"]
    actions["corporate_actions / events"]
    bars["bars_daily (unadjusted)"]
    cal["exchanges / trading_days"]
  end
  subgraph COMPUTED["computed — pure functions of facts + time T (droppable cache)"]
    adj["adjustment_factors"]
    adjbars["bars_daily_adjusted (policy)"]
    metrics["metrics / universes (later)"]
  end
  views -->|deterministic builders| FACTS
  FACTS -->|named, versioned computations| COMPUTED
  OPS["ops — runs / cursors / quarantine"] -.-> RAW
  OPS -.-> FACTS
```

Layer rules:

- **raw** is append-only vendor bytes. Never edited. The only ground truth.
- **facts** are deterministic parses/organizations of raw with identity
  attached. Persisted for performance, rebuildable from raw at any time.
- **computed** is `f(facts, asOfDate, policyParams)` — pure, versioned
  functions. Tables here are caches; dropping any `computed.*` table must lose
  nothing but time.
- **ops** is bookkeeping, never market truth.

## Key concepts

### market_scope

A namespace in which a ticker string is unique at a point in time. It is an
attribute, not a storage boundary — one database holds all scopes.

| market_scope | examples | derived from |
|---|---|---|
| `us_stocks` | AAPL, SPY (stocks, ETFs, ADRs…) | Polygon `locale=us, market=stocks` |
| `us_indices` | I:SPX, I:NDX | Polygon `market=indices` |
| `cn_stocks` | 600519.SH, 000001.SZ | Tushare (later) |

US ticker uniqueness is market-wide (consolidated tape), not per-exchange, so
the scope is the market, and `exchange_mic` is a property of the listing.

### Instrument identity

An instrument is the persistent thing (Meta Platforms Inc. common stock, the
S&P 500 index, SPY the ETF). Tickers are time-ranged labels:

- `resolve(market_scope, symbol, date)` → the `facts_symbols` row whose
  `[valid_from, valid_to)` covers the date → `instrument_id`.
- Current lookup uses `valid_to is null`.
- Canonical test case: `FB` resolved to Meta until 2022-06-09, and to a
  different instrument (an ETF) later. History must never leak across.

`instrument_id` is minted deterministically from identity evidence (FIGI when
present, else first `(market_scope, symbol, first_seen)`), so a full rebuild
from raw reproduces the same ids.

### Time

- Storage timestamps are UTC (`timestamptz`). `fetched_at` = when we observed.
- `market_date` is the exchange-local trading date (the natural key of daily
  facts). Intraday uses `timestamp_utc`.
- Computed artifacts take an explicit as-of date T; "facts at time T" is a
  function call, not a mutable table.

## raw + ops

```mermaid
erDiagram
  ops_runs ||--o{ raw_fetches : "produced by"
  raw_sources ||--o{ raw_fetches : "from vendor"

  raw_sources {
    varchar source_id PK "polygon | sec | benzinga | cboe | tushare"
    varchar display_name
    varchar base_url
  }
  raw_fetches {
    uuid fetch_id PK
    uuid run_id FK
    varchar source_id FK
    varchar dataset "reference_tickers | grouped_daily | splits | dividends | ..."
    varchar request_url
    json request_params
    varchar market_scope "nullable"
    date market_date "nullable, data date"
    varchar page_cursor "nullable"
    integer http_status
    varchar file_path "relative under data/raw/"
    bigint file_bytes
    varchar content_sha256
    integer row_count "nullable"
    timestamptz fetched_at
  }
  ops_runs {
    uuid run_id PK
    varchar job "ingest:polygon:splits | build:facts:bars_daily | ..."
    varchar status "running | ok | failed"
    json params
    timestamptz started_at
    timestamptz finished_at
    varchar error "nullable"
  }
  ops_sync_state {
    varchar job PK
    varchar scope PK
    varchar cursor "nullable"
    date last_success_date "nullable"
    json detail
    timestamptz updated_at
  }
  ops_unresolved {
    varchar dataset PK
    varchar market_scope PK
    varchar symbol PK
    date market_date PK
    varchar reason "no_symbol_match | ambiguous | bad_row"
    json sample
    timestamptz first_seen_at
    timestamptz last_seen_at
  }
  ops_schema_migrations {
    varchar migration_id PK
    timestamptz applied_at
  }
```

Raw payload files are not rows — `raw.fetches` catalogs them. Per-dataset views
(`raw.v_polygon_grouped_daily`, `raw.v_polygon_reference_tickers`, …) parse the
files in place via `read_json`/`read_csv`/`read_parquet`.

## facts — identity and calendars

```mermaid
erDiagram
  facts_instruments ||--o{ facts_symbols : "ticker history"
  facts_instruments ||--o{ facts_instrument_identifiers : "external ids"
  facts_instruments ||--o{ facts_symbol_events : "explains changes"
  facts_exchanges ||--o{ facts_symbols : "listed on"
  facts_exchanges }o--o{ facts_trading_days : "share calendar_id"

  facts_instruments {
    uuid instrument_id PK "deterministic"
    varchar asset_class "equity | index | ..."
    varchar instrument_type "common_stock | etf | adr | preferred | warrant | unit | right | index | ..."
    varchar security_form "atm2 concept carried over"
    boolean is_clean_common_stock
    varchar name
    varchar primary_market_scope
    varchar primary_exchange_mic "nullable"
    varchar currency "nullable"
    boolean active
    date delisted_date "nullable"
    date first_seen_date
    timestamptz updated_at
  }
  facts_symbols {
    uuid symbol_id PK
    uuid instrument_id FK
    varchar market_scope "UK(market_scope, symbol, valid_from)"
    varchar symbol
    varchar exchange_mic "nullable"
    date valid_from "nullable = unknown start"
    date valid_to "null = current"
    boolean is_primary
    json evidence "source refs backing this range"
    timestamptz updated_at
  }
  facts_instrument_identifiers {
    varchar identifier_type PK "composite_figi | share_class_figi | cik | isin | ts_code"
    varchar identifier_value PK
    date valid_from PK
    uuid instrument_id FK
    varchar source_id
    date valid_to "nullable"
  }
  facts_symbol_events {
    varchar source_id PK
    varchar event_type PK "ticker_change | listing | delisting"
    date event_date PK
    varchar old_symbol PK
    varchar new_symbol PK
    varchar market_scope
    uuid instrument_id FK "nullable until resolved"
  }
  facts_exchanges {
    varchar exchange_mic PK
    varchar name
    varchar exchange_type
    varchar market_scope
    varchar calendar_id "us_equities | cn_equities"
    varchar timezone "America/New_York | Asia/Shanghai"
    varchar country
    varchar currency
  }
  facts_trading_days {
    varchar calendar_id PK
    date market_date PK
    boolean is_open
    boolean is_half_day
    timestamptz open_utc "nullable"
    timestamptz close_utc "nullable"
    varchar source_id
  }
```

## facts — market data

```mermaid
erDiagram
  facts_instruments ||--o{ facts_corporate_actions : "acts on"
  facts_instruments ||--o{ facts_instrument_events : "events"
  facts_instruments ||--o{ facts_bars_daily : "traded"

  facts_corporate_actions {
    varchar source_id PK
    varchar source_action_id PK
    uuid instrument_id FK
    varchar market_scope
    varchar symbol_as_stated "vendor's ticker at the time"
    varchar action_type "split | cash_dividend | stock_dividend | merger | spinoff | delisting"
    date ex_date "effective/ex date drives adjustment"
    date declaration_date "nullable"
    date record_date "nullable"
    date pay_date "nullable"
    double split_from "nullable"
    double split_to "nullable"
    double cash_amount "nullable"
    varchar currency "nullable"
    varchar dividend_type "nullable: CD | SC | LT ..."
    integer frequency "nullable"
  }
  facts_instrument_events {
    varchar source_id PK
    varchar source_event_id PK
    uuid instrument_id FK
    varchar event_type "earnings | filing | guidance | ..."
    date event_date
    timestamptz event_time_utc "nullable"
    varchar timing "bmo | amc | during | unknown"
    varchar title
    json payload
  }
  facts_bars_daily {
    varchar source_id PK
    uuid instrument_id PK
    date market_date PK
    varchar market_scope
    varchar symbol_as_traded "e.g. FB before 2022-06-09"
    double open
    double high
    double low
    double close
    double volume "nullable (indices have none)"
    double vwap "nullable"
    bigint trade_count "nullable"
  }
```

Bars are stored **unadjusted, as traded, under the ticker of the day**, linked
to the instrument. Vendor-adjusted bars are never facts; when ingested (e.g.
Polygon `adjusted=true`) they are used only as parity checks for our own
adjustment computation. Rows that cannot be resolved to an instrument go to
`ops.unresolved` — never guessed, never dropped silently.

Intraday bars (minute) come in a later milestone: same identity rules, stored
as partitioned parquet under `data/` with a DuckDB view, not as DB rows.

## computed — functions of facts + time T

The computed layer is primarily **code**: named, versioned pure functions in
`core/`. Persisting outputs is opportunistic caching. Initial artifacts:

```mermaid
erDiagram
  facts_instruments ||--o{ computed_adjustment_factors : ""
  facts_instruments ||--o{ computed_bars_daily_adjusted : ""

  computed_adjustment_factors {
    uuid instrument_id PK
    date event_date PK
    varchar action_type PK "split | cash_dividend"
    double price_factor
    double volume_factor
    varchar evidence "corporate_actions key"
  }
  computed_bars_daily_adjusted {
    uuid instrument_id PK
    date market_date PK
    varchar adjustment_policy PK "none | split | split_dividend"
    double open
    double high
    double low
    double close
    double volume
    double vwap
    double cum_price_factor
    double cum_volume_factor
    varchar symbol_as_traded
    varchar computation_version
    timestamptz computed_at
  }
  computed_build_state {
    varchar artifact PK
    varchar scope PK
    varchar computation_version
    varchar inputs_watermark "e.g. max facts ingest point used"
    timestamptz built_at
  }
```

Adjustment policies:

- `none` — raw as traded.
- `split` — back-adjusted for splits only.
- `split_dividend` — back-adjusted for splits and cash dividends
  (atm2's `split_dividend_back_adjusted`).

When a new corporate action arrives for an instrument, its cached computed rows
are invalidated (watermark mismatch) and rebuilt. Later artifacts (technical
metrics, universes, research stores) follow the same pattern and are specified
when that phase starts — atm2's wide metric tables are explicitly **not**
copied now.

## Source precedence

`facts.bars_daily` keeps `source_id` in the key, so two vendors can both state
facts about the same instrument-day. Computations select by an explicit
precedence rule (default: `polygon` first) — disagreement between sources is
surfaced as a data-quality signal, not silently merged.

## Mapping from atm2

| atm2 (`app.*`) | atm3 |
|---|---|
| per-market DB files | one DB; `market_scope` column |
| `data_sources` | `raw.sources` |
| `source_symbols` (parsed rows + raw_source JSON) | raw files + `raw.v_polygon_reference_tickers` view |
| `instruments`, `symbols`, `instrument_identifiers`, `symbol_events` | `facts.*` same concepts, symbols scoped by `market_scope` |
| `corporate_actions` | `facts.corporate_actions` (+ merger/spinoff/delisting types) |
| `price_adjustment_events` | `computed.adjustment_factors` |
| `instrument_events` | `facts.instrument_events` |
| `ohlcv_bars` (raw rows in DB) | raw files + `facts.bars_daily` |
| `normalized_ohlcv_bars`, `research_daily_bars` | `computed.bars_daily_adjusted` |
| `market_trading_days` (global, per-market DB) | `facts.trading_days` keyed by `calendar_id` |
| `market_data_files` | `raw.fetches` |
| `ingestion_runs`, `event_ingestion_state`, `computation_state` | `ops.runs`, `ops.sync_state`, `computed.build_state` |
| research/backtest/trading tables | out of scope; redesigned in a later phase |

## Initial Polygon dataset map

| raw dataset | endpoint | feeds |
|---|---|---|
| `reference_tickers` | `/v3/reference/tickers` (paged snapshot, incl. inactive) | instruments, symbols |
| `ticker_events` | `/vX/reference/tickers/{id}/events` | symbol_events |
| `splits` | `/v3/reference/splits` | corporate_actions |
| `dividends` | `/v3/reference/dividends` | corporate_actions |
| `exchanges` | `/v3/reference/exchanges` | exchanges |
| `market_holidays` | `/v1/marketstatus/upcoming` | trading_days |
| `grouped_daily` | `/v2/aggs/grouped/.../{date}` `adjusted=false` | bars_daily (us_stocks) |
| `grouped_daily_adjusted` | same, `adjusted=true` | parity checks only |
| `index_aggs` | `/v2/aggs/ticker/I:*/range/1/day/...` | bars_daily (us_indices) |
| `earnings` | Benzinga via Polygon (later) | instrument_events |
