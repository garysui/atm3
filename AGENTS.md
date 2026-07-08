# AGENTS.md

Guidance for AI coding agents working on `atm3`.

## Project Goal

`atm3` is a local-first market data management and research platform: truthful
raw market data, deterministic computed facts, and later research, backtesting,
monitoring, and trading automation. It is a rewrite of `atm2`
(`../atm2`, github `garysui/atm2`) with better data modeling. atm2 is a design
and behavior reference only (identity resolution, adjustment math, parity-test
ideas) — never a data source. Do not ingest, copy, or migrate data from atm2;
its databases and downloaded files are not sources of truth. All atm3 data
enters through raw vendor ingestion.

Treat future auto-trading behavior as high risk: prefer explicit review points,
conservative defaults, and clear separation between read-only analysis,
simulation, paper trading, and live trading.

## Current Stack

- TypeScript everywhere. Do not introduce Python unless the user explicitly changes this rule.
- API: Node + Express. UI: React + Vite.
- Database/query engine: DuckDB via `@duckdb/node-api`, one file `data/atm3.duckdb`.
- Initial market data source: Polygon.io via `@polygon.io/client-js`.

## Karpathy-Inspired Working Rules

Think before coding, keep changes simple, make surgical edits, verify against
concrete goals.

- Ask the user when requirements are unclear, risky, or product-defining. Do not silently make large assumptions.
- State important assumptions before implementing non-trivial work.
- Keep changes small and directly tied to the request.
- Avoid speculative abstractions, future-proofing, or extra features that were not requested.
- Do not refactor adjacent code merely because it could be nicer.
- Match the existing style and project shape.
- Define success criteria for multi-step tasks and verify them with commands or browser checks.
- Prefer a working narrow slice over a broad half-built system.

## Data Rules

The data layers are strict; lower layers never read from higher ones:

1. **raw** — vendor responses saved verbatim under `data/raw/`, append-only,
   each payload file with a `.meta.json` manifest, indexed in the `raw` DuckDB
   schema (the index is rebuildable by rescanning disk). Never edit,
   re-encode, or "fix" raw files. Raw is the only source of truth.
2. **facts** — organized facts computed deterministically from raw (identity,
   symbol history, corporate actions, calendars, unadjusted bars). Persisted in
   the `facts` schema for queryability, but must always be rebuildable from raw.
3. **computed** — pure functions of facts + a point in time T (adjusted bars,
   metrics, universes). Persisting them is a cache. A computed table that
   cannot be dropped and rebuilt is a design bug.
4. **ops** — ingestion runs, sync cursors, quarantine. Operational state, not
   market truth.

Additional rules carried from atm2:

- One database for all markets. `market_scope` is a column; never create
  per-market database files, schemas, or table forks.
- The database file is disposable. It holds nothing that `data/raw/` cannot
  reproduce. There is no migration machinery, on purpose: `db/schema.sql` is
  declarative and idempotent; schema changes that `create ... if not exists`
  cannot express bump `SCHEMA_VERSION` in `server/db.ts` and rebuild the file.
- Never import data from atm2 or any prior system — no databases, parquet
  exports, or previously downloaded files. All data enters through raw vendor
  ingestion.
- Keep schema and code in git. Keep local market data out of git;
  `data/` is ignored except `.gitkeep`.
- Store source OHLCV bars raw and unadjusted. Vendor-adjusted data may be
  ingested for parity checks only, never as input to facts.
- Store corporate actions (splits, dividends, mergers) as facts; derive
  adjustment factors and adjusted bars in the computed layer.
- A ticker symbol is a time-ranged lookup handle, not an identity. Resolve
  `(market_scope, symbol, date)` to an `instrument_id`, then key everything by
  `instrument_id`.
- All jobs are idempotent: upserts/conflict keys, resume from the last good
  point with small overlap, no duplicates on re-run.
- Store timestamps in UTC (`timestamptz`). `market_date` is the exchange-local
  trading date. Convert to exchange-local time only for display.
- Do not commit `.env`, API keys, credentials, downloaded data, or database files.
- Stop the dev server before running scripts that write the DuckDB file; DuckDB
  write locks are per file.

## Safety Rules

- Never add live trading behavior without an explicit user request.
- Do not place order execution behind generic UI controls.
- Keep read-only data inspection separate from write/admin operations.
- SQL exposed through any UI defaults to read-only.
- Prefer explicit environment variables for credentials and endpoints.

## Development Workflow

- `npm run dev` for the local app; `npm run lint` and `npm run build` before committing meaningful changes.
- Tests use the Node test runner via `tsx --test`.
- Keep the GitHub remote as `origin` for `garysui/atm3`.
- Commit focused changes with clear messages when the user asks to commit or push.

## Implementation Preferences

- Keep pure domain types and computations in `core/` (no I/O, no Express, no direct DB handles).
- Keep vendor connectors in `connectors/`, API logic in `server/`, React UI in `src/`, thin CLI entrypoints in `scripts/`.
- Keep the DuckDB schema declarative in `db/schema.sql`.
- Validate API inputs and vendor responses with `zod`.
- Use TypeScript types for request/response shapes that cross the API/UI boundary.
- Keep UI dense, plain, operational, and local-tool oriented.

## UI Rules

- Prefer simple words. Prefer lists, trees, tables, forms, and buttons.
- Show dates/times in the instrument's exchange-local time; preserve UTC in storage.
- No marketing copy, decorative cards, hero sections, or extra explanation.
- Tabs are for switching sections. Buttons are for actions.
- Mock sections must be marked `Mock`, but should stay plain.

## When Unsure

Pause and ask. Especially for: data storage layout changes, schema changes that
affect future ingestion/backtests, paid API behavior, broker or order-routing
decisions, destructive database operations, public/private GitHub or deployment
choices, and introducing new languages, services, queues, or infrastructure.
