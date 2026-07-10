# atm3 Bootstrap Plan

Status: M0–M6 and the CN structural prototype are complete. The owner's
bootstrap sequence was: (1) tech stack specs, (2) data modeling/ERDs, (3) raw
data ingestion, (4) computation over raw data. Strategy/backtest work can now
begin on the source-neutral research contract below.

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

Status: done 2026-07-09.

Small Express API + minimal Data Center UI: instrument search (scoped by
market), symbol history, bar chart with adjustment-policy toggle, runs/fetches
views. UI filters by market_scope — proving market selection lives at the UI
level.

Evidence: read-only Express API (`npm run serve`; opens the database with
access_mode=READ_ONLY over a 3-connection read pool) serving health, scopes,
status, instrument search/detail, policy/as-of bars straight from the
`adjusted_bars_for` macro, runs, and quarantine. React UI (`npm run dev`,
Vite proxy) with a Data Center page (all status tables) and an Instruments
page (search → detail → symbol history incl. FB→META, identifiers, corporate
actions, candlestick chart with `none`/`split`/`split_dividend` toggle and
as-of date input — the algorithm-first thesis on screen). The market selector
is fed by `select distinct market_scope` from the data. Verified in a live
browser: META search → 501-bar chart, policy toggle re-computes from the
macro, zero console errors.

Added same day — the **Pipeline page** (daily replenish, owner request):
the data flow as clickable stages (raw ingest steps → facts build → cache
refresh), each step a card with a Run button, live state, and durable
last-run history from `ops.runs`; one "run full daily replenish" button
queues the whole chain in dependency order. To execute jobs from the UI the
API server now owns the database WRITE lock: operations run one at a time on
the writer connection through a FIFO queue while UI queries use a
3-connection reader pool of the same instance. Step ids equal ops.runs job
names, so button runs and CLI runs share one history; every step stays
idempotent, so buttons are safe to mash. CLI scripts and the read-only
inspection tools remain available when the server is stopped (DuckDB: one
writer process OR readers). Docs are also served in-app (Docs tab, rendered
markdown + zoomable diagrams).

## M6 — Intraday minute bars

Status: done 2026-07-09 (initial days; history accumulates via the pipeline,
window controlled by `ATM3_INTRADAY_BACKFILL_FROM`).

Raw: vendor flat files — one csv.gz per trading day, whole market, landed
byte-identical via the S3 endpoint (aws profile, not the REST key). Facts:
parse-only parquet per day, row-count-verified against raw, with identity
joined at QUERY time (`facts.bars_minute` + quarantine view) so
symbol-history refinements retroactively cover all minute history with zero
rebuilds. Computed: `adjusted_bars_minute(policy, as_of)` (+ `_for`) reusing
the same day-grained factor events and anchor rule. Pipeline: two new steps
(minute flat files → build minute facts). Known-closed days are skipped via
grouped-daily evidence; unpublished days retry next run.

Evidence: 2026-07-06…08 ingested = 5,637,619 minute bars across ~11.9k
instruments/day; SPY shows full 04:00–19:59 ET sessions; the offline fixture
test covers raw→parquet→identity→adjusted→quarantine→rebuild; and
`npm run verify:intraday` proved the cross-source volume-subset invariant
(0 violations) while recording close-agreement baselines — producing the
two-tapes doctrine (data-model, phenomena §13): daily bars are authoritative
for official OHLC, minute bars for intraday paths.

## CN structural prototype

Plan: [cn-market-plan.md](cn-market-plan.md), revised to use anonymous
BaoStock acquisition and a deliberately selected 42-code structural sample.

### CN-P0 — relay and raw-capture spike

Status: done 2026-07-10. BaoStock 0.9.2 protocol `00.9.20` is pinned in a
project-local Python environment. The stateless relay captures application
frames before SDK row parsing; TypeScript pins the SOH/JSON/CRC grammar.
Seventeen committed offline frames cover six calls and 5,686 rows. Calendar
and unadjusted-history hashes matched on identical live re-capture; the full
gate passed with 27 tests.

### CN-P1 — prototype raw ingestion

Status: done 2026-07-10. Six gated pipeline operations landed calendar,
universe, basics, unadjusted daily bars, distributions, and diagnostic vendor
factors. Current evidence: 42 basic rows, 19,749 daily rows, 149 distribution
rows, 120 factor rows, 914 calendar rows, and 7,302 universe rows across 269
verbatim frames. A second complete pass fetched zero frames. Rebuilding
`raw.fetches` from 2,228 manifests reproduced every BaoStock dataset count.
The 42-code list remains prominently owner-vetoable before expansion.

### CN-P2 — source-neutral facts

Status: done 2026-07-10 (schema v4). BaoStock frames rebuild the existing
shared exchange, identity, calendar, corporate-action, and daily-bar tables in
the same atomic transaction as Polygon. Live output: 42 deterministic
instruments/symbols/identifiers, 914 calendar days, 150 action components, and
19,642 traded bars; 107 suspension rows remain raw-only. A second live rebuild
reproduced id checksum `c17f7eb82acbc6c50d5c34452d610c7d` and the same
counts. US proof remained 5,723,744 bars / 15,302 instruments-with-bars with
unchanged AAPL, META, and MSFT checksums.

### CN-P3 — computed factors and diagnostic

Status: done 2026-07-10. `adjust_v3` adds bonus/conversion price and volume
factors to the existing policies and accepts cash in each instrument's own
currency. The real BYD 2025-07-29 mixed event matches the hand formula to 12
decimal places. The vendor comparison reports 81 comparable events, 37 first-
point baselines, 2 vendor points without local factors, 8 local events without
vendor points, and zero malformed rows. Residuals are descriptive and segmented
by action structure; they are never used as a blanket pass/fail threshold. The
live `adjust_v3` cache contains 5,741,773 canonical rows under each existing
policy (1,605 split, 7 stock-distribution, and 75,159 cash factor events).

### CN-P4 — surfaces and cross-market contract

Status: done 2026-07-10. The existing market selector discovers `cn_stocks`;
instrument search preserves leading-zero codes and matches current Chinese
names. CN detail pages use the same adjusted-bar chart and show cash,
post-tax-cash, bonus, and conversion action fields, including distinct cash
and stock-distribution markers.

`npm run verify:continuity` is green across both markets: CN has 42 codes, 739
calendar days, 491 open days, 19,749 raw coverage rows, 19,642 traded fact
bars, and 107 suspensions, with zero window gaps, missing raw open-day rows,
missing traded fact bars, invalid rows, or closure contradictions. The US
contract remains green for 507 open days plus 22 closures and four complete
intraday days.

`npm run verify:cn-contract` runs one source-neutral 20-observation
`split_dividend` return-series function for AAPL and 600519. Both return the
same columns and semantics; only instrument id and market scope change. Live
browser checks covered code/name search, Moutai cash actions, BYD's mixed
cash/bonus/conversion event, and a clean console.

## Later (explicitly out of scope now)

- Earnings (Benzinga) and SEC filings events
- Research/strategy/backtest redesign, monitoring, IBKR paper trading

## Resolved decisions (owner, 2026-07-08)

1. Storage: all local data lives on the external drive —
   `ATM3_DATA_DIR=/Volumes/atm-data/atm3/data` in `.env`. One variable moves
   everything; the DuckDB path derives from it.
2. Backfill window: 2 years (grouped daily bars, splits, dividends). Defaults
   from = today − 2y, to = yesterday; `ATM3_BACKFILL_FROM/TO` override.
3. Indices: not hooked up yet; SPY is the market proxy for now. `index_aggs`
   ingestion deferred.
4. **Coverage contract (2026-07-09): the daily window starts FIXED at
   2024-07-01** and grows through yesterday forever — `ATM3_BACKFILL_FROM`
   stays pinned in `.env` (the unset default is rolling and would silently
   shrink coverage). Every trading day in the window must have raw
   grouped-daily evidence and market-wide facts bars; zero-row files are
   closure evidence, and a claimed closure contradicted by minute data is a
   hard failure. Enforced by `npm run verify:continuity` and the pipeline's
   red/green "verify continuity" card; raw holes self-heal on the next
   replenish because ingestion rescans the whole window with presence-skip.
   Instrument-level gaps (halts, no trades) are market facts, not data
   holes — the contract is market-level.

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

## View at T

Status: VT-P1 through VT-P4 done 2026-07-10. The first research slice in
[view-at-t-plan.md](view-at-t-plan.md) now provides an as-of-T metric engine,
an opt-in forward-return scorer, SPY/tracking-ETF residual context, a validated
API, and the Instruments-page date/chart control with an explicit hindsight
band. It is compute-only; no schema or cache was added.

The exact plan tables contained 53 ids despite saying 47. All 40 instrument
and 13 context ids shipped, with null reasons and catalog/API equality tested.
Truncation and forward-anchor invariance, split-day gap math, event visibility,
delisting/suspension flags, synthetic residual recovery, source-neutral CN
shape, and all catalog formulas are fixture-tested. Live AAPL and 600519
evidence is recorded in the plan's dated implementation notes and available
through `npm run verify:view-at` with the development server stopped.

VT-P5 intraday-at-T shipped 2026-07-10: pick a minute on the intraday chart
(T lands just after the clicked bar) and see 17 session metrics from the
complete RTH bars before T, the full daily catalog as of the previous close,
and hindsight from a next-minute-open entry over to_close/next_open/1d/5d.
The same hardening pass made forward horizons degrade per-row
(`beyond_calendar`) instead of failing wholesale and moved the `delisted`
flag onto identity (`delisted_date`), with every other carried valuation
reported `stale`. Expansion beyond the 42-code CN prototype and a production
CN vendor decision remain separate commitments.
