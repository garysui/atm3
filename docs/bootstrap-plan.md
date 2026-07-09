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

Status: done 2026-07-08 (schema v2: the bars key gained `symbol_as_traded`
for concurrent tape lines).

Deterministic builders (raw views → facts): exchanges/trading_days; identity
(instruments + symbols + identifiers, deterministic ids); corporate_actions;
bars_daily with symbol→instrument resolution and `ops.unresolved` quarantine.

Done when: FB→META symbol history resolves correctly (the canonical
ticker-reuse case); bars for META span the FB/META ticker change under one
instrument_id; rebuild from raw reproduces identical ids and row counts.

Evidence (real 2-year data): FB resolves to Meta in [2012-05-18, 2022-06-09)
and to the ProShares ETF after (exact dates from ticker events); DMAT→EART
bars (413+88) span an in-window rename under one instrument (the bar window
postdates FB→META, so a real in-window case stands in); two full rebuilds
reproduced identical ids and counts — 34,959 instruments, 36,136 symbols,
77,227 corporate actions, 534 trading days, 5,655,972 bars; the quarantine
holds exchange test tickers (7,418 bar observations) and out-of-universe
dividend payers (mutual funds, CUSIP rows), never guessed.

## M4 — Computed layer

Status: done 2026-07-08. Reworked the same day after owner review
(schema v3): **algorithm-first**. The adjusted series is the
`computed.adjusted_bars(policy, as_of)` table macro over facts (plus a
single-instrument `adjusted_bars_for`, ~0.7s), the factor pipeline is a chain
of views, and the only table is `bars_daily_adjusted_cache` — an optional,
watermark-guarded, tested-identical snapshot of the macro (full-market
on-the-fly measures ~78s, which is why the cache exists). The parity check
reads the macro directly. Any as-of-T view is a function call; no T's view is
stored as data.

`core/` computations: adjustment factors from corporate actions; adjusted daily
bars per policy (`none`/`split`/`split_dividend`) as pure functions with
optional cache into `computed.*`; invalidation via `computed.build_state`
watermarks.

Done when: our `split` policy matches Polygon `adjusted=true` within epsilon
across a sample set (parity check against vendor-adjusted aggregates); dropping
all `computed.*` tables and rebuilding yields identical results.

Evidence: 1,600 split + 74,943 dividend factors; 5,655,488 adjusted bars per
cached policy; `npm run verify:adjustments` shows **100.000% close parity on
all 5,057,071 active-instrument bars** (tolerance max($0.01, 0.05%)), with
divergence only on delisted names where vendors apply post-final-bar
consolidations (uniform factor, zero return impact) and on renamed
instruments excluded from the vendor's per-ticker frame (419). Freshness
watermarks skip clean rebuilds; drop-and-rebuild reproduces identical rows.
Getting to 100% surfaced three vendor-data traps, now encoded in the
computation and data-model notes: duplicate action statements around renames,
future-dated/post-delisting actions (series anchor rule), and case-significant
tickers.

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

## Research-phase contract (owner-confirmed, 2026-07-08)

Locked before any strategy/backtest code exists:

1. **Raw grows append-only, forever.** New data (each day's bars, new
   reference/action snapshots, vendor corrections as new statements) only
   ADDS files; nothing prior is ever altered. Facts rebuild deterministically
   from the accumulated raw, so every as-of-T view function keeps working
   unchanged as data arrives. From a blank database the system repopulates
   from the raw archive with zero network (proven); from a truly blank state
   it re-fetches the window from the vendor (bounded by what the vendor
   still serves — one more reason the raw archive is the asset).
2. **Research runs on slices of the one market universe**, expressed as
   filters/functions over facts (market_scope, exchange, instrument_type /
   security_form / is_clean_common_stock, liquidity) — never as separate
   datasets or databases. Test tickers never resolve to instruments, so
   instrument-based universes exclude them by construction.
3. **At test date T, truth is the tape.** Selection predicates evaluate on
   REAL as-traded prices (`facts.bars_daily`, equivalently policy `none`) —
   "price > 10" means the tape printed > 10 on that date, never a value
   rescaled by adjustments anchored elsewhere. Historical context uses
   as-of-T anchored views (`computed.adjusted_bars(policy, as_of := T)`),
   which cannot see past T. Forward gains over (T, T+h] are computed from
   raw bars plus the corporate actions inside the window (dividends
   received, split share scaling) — the forward-return function is built on
   these primitives in the research phase.

## Open questions for the owner

1. Any desire to bring CN/Tushare in earlier than "after M4"?
