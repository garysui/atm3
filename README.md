# atm3

Local-first market data management and research platform. A ground-up rewrite of
[atm2](https://github.com/garysui/atm2) with better data modeling and process.

## Why a rewrite

atm2 proved the ideas: raw-first data, instrument identity (ticker ≠ identity),
corporate-action-derived adjustments, and one research/trading process. But two
design decisions aged badly:

1. **Per-market database files.** US and CN lived in separate DuckDB files.
   Market tenancy leaked into every layer: scripts, API routes, calendars, and
   backup rules. In atm3, the data layer holds the whole world; selecting a
   portion of the market (US stocks, CN stocks, indices) is a query/UI concern,
   not a storage boundary.
2. **Raw and derived data intermixed.** Raw observations, normalized facts, and
   research caches all lived in one `app` schema and grew together. In atm3 the
   layers are physically explicit and lower layers never depend on higher ones.

atm3 starts from scratch. No data is migrated from atm2 — its databases and
downloaded files are not sources of truth. Every byte enters through raw
vendor ingestion; atm2 is a design and behavior reference only.

## Core principles

1. **Raw data is saved as-is.** Vendor responses land on disk verbatim
   (untouched bytes), append-only, with fetch metadata. Raw data is the only
   ground truth.
2. **Everything else is computed.** Organized facts (instruments, symbol
   history, corporate actions, bars, calendars) are deterministic computations
   over raw data. Derived data (adjusted bars, metrics) are pure functions of
   facts plus a point in time T. Persisting computed results is a performance
   cache, never a source of truth — every computed table must be rebuildable,
   and the database file itself is disposable: it holds nothing that
   `data/raw/` cannot reproduce.
3. **One market universe.** All markets share one database and one identity
   space. `market_scope` is an attribute, filtering is a query.
4. **A ticker is not an identity.** Symbols are time-ranged lookup handles that
   resolve to an `instrument_id`. All facts hang off instruments.
5. **Idempotent operations.** Every ingestion and build job can be re-run
   safely and resumes from its last good point.

## Stack

- TypeScript everywhere (no Python)
- API: Node + Express
- UI: React + Vite
- Database/query engine: DuckDB (`@duckdb/node-api`), single file `<ATM3_DATA_DIR>/atm3.duckdb`
- Raw zone: verbatim vendor files + `.meta.json` manifests under
  `<ATM3_DATA_DIR>/raw/`, indexed (rebuildably) in DuckDB. On this machine
  `ATM3_DATA_DIR` points at the external drive (`/Volumes/atm-data/atm3/data`)
- Market data: Polygon.io first; connectors stay pluggable (Tushare, SEC, CBOE later)

See [docs/tech-stack.md](docs/tech-stack.md) for decisions and rationale,
[docs/data-model.md](docs/data-model.md) for the ERDs, and
[docs/bootstrap-plan.md](docs/bootstrap-plan.md) for the build sequence.

## Status

Specs (M0) and skeleton (M1) are done; raw Polygon ingestion (M2) is next.
Strategies/backtesting come after the data foundation works. See
[docs/bootstrap-plan.md](docs/bootstrap-plan.md).
