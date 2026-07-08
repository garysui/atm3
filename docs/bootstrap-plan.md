# atm3 Bootstrap Plan

Status: proposed 2026-07-08. The owner's bootstrap sequence: (1) tech stack
specs, (2) data modeling/ERDs, (3) raw data ingestion, (4) computation over raw
data. Strategies/backtesting come only after the data foundation works.

## M0 — Repo + specs (this phase)

- [x] git repo, README, AGENTS.md
- [x] [tech-stack.md](tech-stack.md) — stack decisions + deviations from atm2
- [x] [data-model.md](data-model.md) — layers + ERDs
- [ ] Owner sign-off on deviations D1–D6 and the ERDs
- [ ] GitHub remote `garysui/atm3` (owner decides public/private)

## M1 — Skeleton

Scaffold package.json/tsconfig/eslint from atm2's shape; migration runner;
DuckDB open helper; `0001_init.sql` creating `raw`/`facts`/`computed`/`ops`
schemas and tables; pino logging; `ops.runs` wrapper for jobs.

Done when: `npm test` green; running any script creates the DB and applies
migrations idempotently.

## M2 — Raw ingestion (Polygon)

Connector + one script per dataset, all idempotent and resumable via
`ops.sync_state`, all landing verbatim files + `raw.fetches` rows:

1. `reference_tickers` snapshot (active + inactive, paged)
2. `exchanges`, `market_holidays`
3. `splits`, `dividends`
4. `grouped_daily` backfill for a configurable window (`adjusted=false`),
   plus `adjusted=true` for parity checks
5. `ticker_events` for symbols of interest
6. `index_aggs` for a starter index list (entitlement permitting)

Done when: re-running any job fetches only what is missing and duplicates
nothing; `raw.fetches` accounts for every file on disk; a wiped DB re-catalogs
from disk or re-fetches cleanly.

## M3 — Facts builders

Deterministic builders (raw views → facts): exchanges/trading_days; identity
(instruments + symbols + identifiers, deterministic ids); corporate_actions;
bars_daily with symbol→instrument resolution and `ops.unresolved` quarantine.

Done when: FB→META symbol history resolves correctly (atm2's canonical case);
bars for META span the FB/META ticker change under one instrument_id; rebuild
from raw reproduces identical ids and row counts.

## M4 — Computed layer

`core/` computations: adjustment factors from corporate actions; adjusted daily
bars per policy (`none`/`split`/`split_dividend`) as pure functions with
optional cache into `computed.*`; invalidation via `computed.build_state`
watermarks.

Done when: our `split` policy matches Polygon `adjusted=true` within epsilon
across a sample set (port atm2's parity test); dropping all `computed.*` tables
and rebuilding yields identical results.

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

## Open questions for the owner

1. GitHub repo visibility: private like atm2, or public?
2. Polygon entitlements assumed same as atm2 (stocks + indices + flat files) —
   confirm indices access before M2 item 6.
3. Grouped-daily backfill window for M2 (e.g. 5 years? full history?).
4. Any desire to bring CN/Tushare in earlier than "after M4"?
