# atm3 Tech Stack

Status: approved 2026-07-08 (D3 reworked the same day to the
disposable-database model). Baseline is "copy atm2's stack"; deviations are
listed explicitly with rationale. atm2 is a design reference only — see D3 and
"Considered and rejected": no data is ever migrated from it.

## Decisions

| Area | Choice | Same as atm2? | Notes |
|---|---|---|---|
| Language | TypeScript everywhere, ESM, no Python | same | atm2 rule carried over |
| Runtime | Node.js (current LTS), `tsx` for scripts/dev | same | |
| API | Express 5 | same | proven in atm2; no framework churn |
| UI | React 19 + Vite | same | UI comes late in the bootstrap sequence |
| Database / query engine | DuckDB via `@duckdb/node-api` | same engine | **one** file `data/atm3.duckdb` for all markets (D1) |
| Raw storage | verbatim vendor files + `.meta.json` manifests under `data/raw/` + DuckDB index | changed | D2 |
| Schema management | declarative `db/schema.sql` + `SCHEMA_VERSION` stamp; DB file is disposable | changed | D3 |
| DB layout | DuckDB schemas `raw`, `facts`, `computed`, `ops` | changed | D4 |
| Market data client | `@polygon.io/client-js` | same | |
| Validation | `zod` (API inputs and vendor payload parsing) | same | |
| Logging | `pino` | same | |
| Testing | Node test runner (`tsx --test tests/*.test.ts`) | same | |
| Lint | eslint + typescript-eslint | same | |
| Charts (later) | `lightweight-charts` | same | |
| Broker (later) | IBKR TWS socket via `@stoqey/ib`, paper only | same | out of scope for bootstrap |
| Env | `.env` via `dotenv`, `ATM3_*` prefix, `POLYGON_API_KEY` | same pattern | |
| Repo | single npm package (no workspaces), github `garysui/atm3` | same | layering enforced by convention + lint, not packaging |

Dependency versions: start from atm2's current versions (React 19, Express 5,
Vite 8, TypeScript 6, `@duckdb/node-api` 1.5.x, polygon client 8, zod 4,
pino 10) and take latest patch/minor at install time.

## Deviations from atm2

### D1 — One database, market as an attribute

atm2 used one DuckDB file per market (`atm2.duckdb`, `atm2-cn.duckdb`).
Market tenancy leaked everywhere: `ATM2_MARKET` script bootstrap, market-scoped
API routes, per-market lock/backup runbooks, and instrument ids that were only
unique within one file.

atm3 uses a single `data/atm3.duckdb`. Instruments are globally unique;
`market_scope` (e.g. `us_stocks`, `us_indices`, `cn_stocks`) is a column on
symbols/listings; calendars are keyed by `calendar_id`. "Show me US stocks" is
a `where` clause at the query/UI level, not a storage boundary.

### D2 — Raw zone is verbatim files, not parsed rows

atm2 stored "raw-ish" data as parsed columns with a `raw_source` JSON column.
That is already a transformation, and it bloats the DB.

atm3 lands every vendor response on disk exactly as received (JSON/CSV/parquet,
gzipped where large), append-only:

```
data/raw/<source>/<dataset>/<partition>/<file>
e.g. data/raw/polygon/grouped_daily/date=2026-07-07/us_stocks.json.gz
     data/raw/polygon/reference_tickers/snapshot_date=2026-07-08/page-0001.json.gz
```

Each payload file is written together with a `<file>.meta.json` manifest
(request url, params, http status, sha256, byte count, fetched_at, run id).
`raw.fetches` in DuckDB is only an index over those manifests — rebuildable at
any time by rescanning `data/raw/` — so fetch provenance lives in the raw zone
itself, not in the database. DuckDB reads payload files directly (`read_json`,
`read_csv`, `read_parquet`) through per-dataset views, so "parsing" is a view,
not a copy. Facts builders consume those views.

Benefits: raw is literally untouched (auditable, re-parseable when a parser bug
is found), the DB stays small and fully disposable, and backfills are file
drops.

### D3 — Declarative schema, disposable database

atm2's idempotent `schema.sql` became painful because its database held data
that could not be regenerated — evolving a column required hand-written
run-once migrations (atm2 eventually grew a migration ledger inside
`server/schema.ts`). Migration machinery exists to protect precious
in-database data.

atm3 removes the cause instead of managing the symptom: truth lives in
`data/raw/` files, and every DuckDB table is an index or cache derived from
them, so the database file is disposable. The schema stays declarative —
`db/schema.sql`, `create ... if not exists`, applied at every open. New tables
are picked up automatically; changes that `if not exists` cannot express
(column/key changes) bump `SCHEMA_VERSION` in `server/db.ts`, and a mismatched
database file refuses to open with instructions to delete and rebuild it from
raw (no network re-fetch needed). No migration ledger, no "never edit an
applied migration" process rule, and the rebuild-from-raw guarantee stays
exercised instead of theoretical.

### D4 — DuckDB schemas as data layers

Instead of one `app` schema, tables live in the schema of their layer: `raw`
(catalog + views over files), `facts` (organized facts), `computed` (rebuildable
caches), `ops` (runs, cursors, quarantine). Lineage is visible in every table
name, and "can I drop this?" has a schema-level answer (`computed`: always).

### D5 — Deterministic ids

atm2 minted random `uuid()` defaults; a rebuild-from-raw would re-mint different
ids and orphan every cache. atm3 mints stable ids (UUIDv5-style hash of the
identity evidence, e.g. FIGI or first `(market_scope, symbol, first_seen)`), so
rebuilding facts from raw reproduces the same `instrument_id`s.

### D6 — Pure compute core

Computations (identity resolution, adjustment factors, adjusted bars, metrics)
are named, versioned functions in `core/` with declared inputs/outputs. Heavy
set-based work is still SQL pushed into DuckDB — the discipline is that each
computation is one function invoked identically by scripts, API, and future
backtests, never re-implemented per caller. This is atm2's "backtests and scans
must consume the same logic" principle, enforced by structure.

## Repo layout

```
atm3/
  core/            pure domain types + computations (no I/O)
  connectors/      vendor clients: polygon, sec, cboe, tushare (later)
  server/          Express API, DuckDB access, job orchestration
  src/             React UI (later phase)
  scripts/         thin CLI entrypoints (ingest, build, verify)
  db/schema.sql    declarative schema, applied at every open
  tests/           node:test suites
  docs/            specs and decision records
  data/            local data (gitignored): atm3.duckdb, raw/, computed/
```

`data/` may be a symlink to external storage (atm2 pattern:
`data -> /Volumes/.../data`).

## Environment variables

```
ATM3_DATA_DIR=/Volumes/atm-data/atm3/data   # all local data; DB + raw zone live inside
ATM3_DUCKDB_PATH=...                        # optional; defaults to <ATM3_DATA_DIR>/atm3.duckdb
ATM3_LOG_LEVEL=info
ATM3_BACKFILL_FROM=...                      # optional; default = today - 2 years
ATM3_BACKFILL_TO=...                        # optional; default = yesterday
POLYGON_API_KEY=...
ATM3_API_PORT=5180                          # later, API phase
ATM3_API_HOST=127.0.0.1                     # later, API phase
SEC_USER_AGENT=atm3 local development <email>         # later
ATM3_POLYGON_FLATFILES_AWS_PROFILE=massive-flatfiles  # later, intraday flat files
```

`ATM3_DATA_DIR` is the one knob that moves all local data. On this machine it
points at the external drive (owner decision 2026-07-08: the internal disk is
low on space); a fresh clone without `.env` defaults to `data/` in the repo.

## Considered and rejected

- **Fastify/Hono instead of Express** — marginal gains, real migration risk;
  the API is a thin local layer.
- **npm workspaces / monorepo packages** — packaging ceremony without payoff
  for a one-machine app; folder layering + lint rules give the same discipline.
- **Postgres/Timescale** — DuckDB's columnar engine over local parquet/JSON is
  the right shape for single-user analytical scans; no server to babysit.
- **An ORM or query builder** — plain SQL in the schema and computations;
  DuckDB SQL *is* the compute engine.
- **Numbered run-once migrations with a ledger** — machinery for protecting
  in-database data that atm3 deliberately does not have; with a disposable
  database it is dead weight (rejected after an initial implementation).
- **Migrating data from atm2** — atm2's databases and downloaded files are not
  sources of truth; its parsed rows and randomly-minted instrument ids would
  smuggle the old data model into the new foundation. atm3 starts from
  scratch; all data enters through raw vendor ingestion.
