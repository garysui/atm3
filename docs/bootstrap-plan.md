# atm3 Bootstrap Plan

Status: M0–M1 done, M2 next. The owner's bootstrap sequence: (1) tech stack
specs, (2) data modeling/ERDs, (3) raw data ingestion, (4) computation over raw
data. Strategies/backtesting come only after the data foundation works.

Non-goal: no data is migrated from atm2 or any prior system. atm2's databases
and downloaded files are not sources of truth — every byte enters through raw
vendor ingestion below.

## M0 — Repo + specs (this phase)

- [x] git repo, README, AGENTS.md
- [x] [tech-stack.md](tech-stack.md) — stack decisions + deviations from atm2
- [x] [data-model.md](data-model.md) — layers + ERDs
- [x] Owner sign-off on deviations D1–D6 and the ERDs
- [x] GitHub remote `garysui/atm3` (owner decides public/private)

## M1 — Skeleton

Status: done 2026-07-08. Reworked the same day: the initial run-once migration
ledger was removed in favor of a declarative `db/schema.sql` plus a
`SCHEMA_VERSION` stamp — the database is a disposable index over `data/raw/`,
so incompatible schema changes delete and rebuild the file instead of
migrating it.

Scaffold package.json/tsconfig/eslint (copying atm2's proven stack shape);
`db/schema.sql` creating the `raw`/`facts`/`computed`/`ops` schemas and
tables, applied idempotently at every database open; pino logging; `ops.runs`
wrapper for jobs.

Done when: `npm test` green; `npm run db:init` creates the database and
re-running it changes nothing. ✓

## M2 — Raw ingestion (Polygon)

Status: done 2026-07-08 (initial 2-year backfill landed).

Connector + one script per dataset, all idempotent and resumable via
`ops.sync_state`, all landing verbatim payload files with `.meta.json`
manifests plus `raw.fetches` index rows:

1. `reference_tickers` snapshot (active + inactive, paged)
2. `exchanges`, `market_holidays`
3. `splits`, `dividends`
4. `grouped_daily` backfill for a configurable window (`adjusted=false`),
   plus `adjusted=true` for parity checks
5. `ticker_events` for symbols of interest
6. ~~`index_aggs`~~ deferred — indices are not hooked up; SPY serves as the
   market proxy (owner decision 2026-07-08)

Done when: re-running any job fetches only what is missing and duplicates
nothing; `raw.fetches` accounts for every file on disk; deleting the database
file and re-indexing from the manifests reproduces `raw.fetches` without any
network call.

## M3 — Facts builders

Deterministic builders (raw views → facts): exchanges/trading_days; identity
(instruments + symbols + identifiers, deterministic ids); corporate_actions;
bars_daily with symbol→instrument resolution and `ops.unresolved` quarantine.

Done when: FB→META symbol history resolves correctly (the canonical
ticker-reuse case); bars for META span the FB/META ticker change under one
instrument_id; rebuild from raw reproduces identical ids and row counts.

## M4 — Computed layer

`core/` computations: adjustment factors from corporate actions; adjusted daily
bars per policy (`none`/`split`/`split_dividend`) as pure functions with
optional cache into `computed.*`; invalidation via `computed.build_state`
watermarks.

Done when: our `split` policy matches Polygon `adjusted=true` within epsilon
across a sample set (parity check against vendor-adjusted aggregates); dropping
all `computed.*` tables and rebuilding yields identical results.

## M5 — Minimal surface

Small Express API + minimal Data Center UI: instrument search (scoped by
market), symbol history, bar chart with adjustment-policy toggle, runs/fetches
views. UI filters by market_scope — proving market selection lives at the UI
level.

## Later (explicitly out of scope now)

- Intraday minute bars via Massive/Polygon flat files (parquet + views)
- Earnings (Benzinga) and SEC filings events
- CN market via Tushare (schema already supports it: new market_scope,
  calendar, connector — same tables)
- Research/strategy/backtest redesign, monitoring, IBKR paper trading

## Resolved decisions (owner, 2026-07-08)

1. Storage: all local data lives on the external drive —
   `ATM3_DATA_DIR=/Volumes/atm-data/atm3/data` in `.env`. One variable moves
   everything; the DuckDB path derives from it.
2. Backfill window: 2 years (grouped daily bars, splits, dividends). Defaults
   from = today − 2y, to = yesterday; `ATM3_BACKFILL_FROM/TO` override.
3. Indices: not hooked up yet; SPY is the market proxy for now. `index_aggs`
   ingestion deferred.

## Open questions for the owner

1. Any desire to bring CN/Tushare in earlier than "after M4"?
