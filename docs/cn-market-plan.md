# CN stock market plan (cn_stocks)

Status: PLAN, awaiting owner review — written 2026-07-10 for hand-off.
Goal: at the end of this iteration atm3 handles Chinese A-share stocks
(daily bars) with the same guarantees as US — verbatim raw, deterministic
facts, algorithm-first adjustments with parity proof, continuity contract,
pipeline buttons, charts. **This is the payoff test of "one universe,
market as attribute": no new database, no new tables, no per-market forks.**

## Scope

In: SSE + SZSE common A-shares, daily bars, corporate actions, calendar,
name history, from a fixed start (owner to confirm: 2024-07-01, matching
US). Out (explicitly): CN intraday minutes (no source chosen), BSE (北交所,
owner may add later — it is only another `exchange` value), funds/bonds,
signals/trading, HK.

## Design tenets that must survive review

1. Raw is verbatim vendor bytes + manifest; Tushare responses land as
   fetched JSON, append-only.
2. Facts builders are PER-SOURCE code writing to the SAME tables
   (`facts.instruments/symbols/corporate_actions/bars_daily/trading_days`)
   — "connector differences stop at the raw edge" (architecture doc).
3. Computed stays ONE algorithm: the factor/adjusted views gain CN action
   types, not CN copies.
4. Vendor-computed adjustment data (`adj_factor`) is PARITY ONLY, never an
   input — the same doctrine that caught the Polygon cumulative-dividend
   trap.
5. Anything unresolvable is quarantined with a reason, never guessed.

## Source: Tushare Pro

- Transport: `POST http://api.tushare.pro` with JSON
  `{ api_name, token, params, fields }` → `{ code, msg, data: { fields,
  items } }`. `code !== 0` is an API error (surface `msg`); items are
  positional arrays zipped with `fields`.
- Auth: `TUSHARE_TOKEN` env (new), never in URLs or manifests.
- Rate limits are per-minute and tier-dependent. Connector mirrors
  `connectors/polygon.ts`: retries with backoff on HTTP failures AND on
  Tushare's rate-limit error message; sequential requests; progress logs.
- **Implementer task zero: verify the account tier grants each API below
  (points requirements differ); record actuals in this doc.**

### Datasets (raw zone layout mirrors polygon)

| dataset | api_name | cadence / partition | key fields | feeds |
|---|---|---|---|---|
| `trade_cal` | trade_cal | snapshot (start_date=1990, end_date=+1y), `snapshot_date=` | exchange, cal_date, is_open | facts.trading_days (`cn_equities`) — AUTHORITATIVE past+future, better than US |
| `stock_basic` | stock_basic | snapshot per day, `snapshot_date=`, list_status L+D+P | ts_code, symbol, name, exchange, list_date, delist_date, list_status | instruments + symbols |
| `namechange` | namechange | snapshot sweep, `snapshot_date=` | ts_code, name, start_date, end_date, change_reason | instrument name/ST history (NOT symbols — CN renames change the NAME, the code is stable) |
| `daily` | daily | **per trade_date** (whole market per call — mirrors grouped_daily), `date=` | ts_code, open/high/low/close, pre_close, vol (手, ×100 shares!), amount (千元) | facts.bars_daily |
| `dividend` | dividend | snapshot sweep per day (paged by ann_date or per ts_code — implementer picks cheaper for tier), `snapshot_date=` | ts_code, div_proc, stk_div, stk_bo_rate, stk_co_rate, cash_div, cash_div_tax, record_date, ex_date | facts.corporate_actions |
| `adj_factor` | adj_factor | per trade_date, `date=` | ts_code, trade_date, adj_factor | **parity only** (vendor CUMULATIVE factor) |

Raw paths: `raw/tushare/<dataset>/(date|snapshot_date)=YYYY-MM-DD/…json.gz`
with the standard `.meta.json` manifest (request params minus token).

Unit normalization happens in FACTS (parse layer), never in raw:
`vol × 100 → shares`, `amount × 1000 → CNY`. Raw keeps vendor units.

## CN market realities to encode (phenomena doc gets a section)

- **Identity = ts_code** (`600519.SH`). Stable across renames; no FIGI.
  `deterministic_uuid('instrument', 'tushare:' + ts_code)`. Code reuse
  after delisting is effectively nonexistent; if `stock_basic` ever shows
  one code with conflicting list windows → quarantine, never merge.
- **Renames change names, not tickers** (`万科A` → `ST万科` patterns): the
  name history from `namechange` records ST/*ST status changes — store as
  `facts.instrument_events` (event_type `name_change`, payload with
  reason). Symbols table stays simple: one row per code,
  `[list_date, delist_date)`.
- **Suspensions (停牌)** are common and can last months: per-instrument
  daily gaps are NORMAL market facts. The continuity contract stays
  market-level (trade_cal says open + market-wide bars exist); document so
  research never "fills" suspension gaps.
- **Corporate actions are ratio events, not splits**: 送股 (bonus shares),
  转增 (conversion from reserves), 派息 (cash per share; Tushare fields are
  per-share), 配股 (rights issue at a price — needs ratio AND price).
- **Vendor factor is cumulative** — adj_factor is the CN twin of the KO
  dividend-factor trap. Parity target, never input.
- Price limits (涨跌停 ±10%/±5% ST/±20% STAR-Chuangye) and T+1 are research
  notes, not data-layer concerns.

## The math: CN ex-right formula (goes in core/adjustments.ts + factor view)

For an event on ex-date E with per-share values against `prev_close` (the
last raw close strictly before E — the same ASOF machinery as US):

```
bonus  = stk_bo_rate + stk_co_rate          (送股 + 转增, per share)
rights = rights_ratio                        (配股, per share)
ex_reference_price =
  (prev_close − cash_div_tax + rights_price × rights)
  / (1 + bonus + rights)

price_factor  = ex_reference_price / prev_close
volume_factor = 1 + bonus + rights
```

- Use PRE-TAX cash (`cash_div_tax`) — the exchange's ex-right reference and
  hfq convention; record post-tax in the fact row too.
- Only `div_proc = '实施'` (implemented) rows become facts; 预案/股东大会预案
  (proposals) are ignored at the facts layer (announcement-time knowledge is
  a later, fetched_at-based refinement — same stance as US).
- Cash-only events degenerate to the existing `1 − cash/prev_close`;
  bonus-only to `1/(1+bonus)` — the US formulas are special cases, which is
  why this extends the ONE factor view instead of forking it.

## Schema deltas (SCHEMA_VERSION → 4; disposable DB makes this cheap)

1. `facts.corporate_actions` — new nullable columns:
   `bonus_ratio double, conversion_ratio double, rights_ratio double,
   rights_price double, cash_amount_post_tax double`.
   New `action_type` values: `stock_dividend`, `rights_issue` (comment the
   enum). US rows unaffected (nulls).
2. `computed.dividend_cash_by_exdate` → generalize currency: join
   `facts.instruments` and accept cash where
   `coalesce(ca.currency, i.currency, 'USD') = coalesce(i.currency,'USD')`
   (per-instrument expected currency instead of literal `'USD'`;
   `non_usd_rows` becomes `foreign_currency_rows`).
3. `computed.adjustment_factor_events` — add the CN branch: one combined
   event per (instrument, ex_date) computing the formula above from the new
   columns via the SAME asof prev-close join; same-day statement dedupe
   rules carry over.
4. `computed.canonical_bars_daily` — remove `where source_id = 'polygon'`
   (line ~309): instruments never span sources (ids embed source evidence),
   so max-volume-per-(instrument,date) is already correct cross-source.
5. `facts.bars_minute*` views — remove the hardcoded
   `market_scope = 'us_stocks'` in resolution (take scope from the symbols
   row); behavior unchanged today (only US minute data exists).

## Code deltas by file (the executable checklist)

| file | change |
|---|---|
| `connectors/tushare.ts` (new) | POST client: token from env, zod envelope (`code/msg/data`), items→objects zip, retry/backoff incl. rate-limit messages |
| `server/tushare-ingest.ts` (new) | 6 jobs mirroring polygon-ingest: per-date `daily` + `adj_factor` (skip via `raw.fetches` presence + trade_cal closed days), snapshot sweeps for `stock_basic`/`namechange`/`dividend`/`trade_cal`; all land via `landRawFile` |
| `server/facts-build-cn.ts` (new) | builders: instruments+symbols (+name events) from stock_basic/namechange; trading_days `cn_equities` from trade_cal; corporate_actions from dividend (实施 only, per-share fields, new columns); bars_daily from daily (units normalized, `currency` CNY via instruments); quarantine to `ops.unresolved` |
| `server/facts-build.ts` | extract shared helpers (context/glob/count/inTransaction) to `server/facts-common.ts`; `buildAllFacts` calls polygon builders THEN cn builders inside the same single transaction; one `facts_generation` bump |
| `core/adjustments.ts` | add `cnExRightFactor(...)` pure fn + tests (source of truth mirrored by the SQL, like the US formulas) |
| `core/publication.ts` | add `latestCompletedTradingDateCn(now)` — Tushare `daily` publishes ~17:00–18:00 CST same day; cutoff = CST yesterday before 18:30 CST, else CST today… implementer verifies actual publication time empirically and encodes + tests it |
| `server/operations.ts` | append steps: `ingest:tushare:*` (raw stage), cn facts inside existing `build:facts`; steps no-op cleanly when `TUSHARE_TOKEN` unset (skip with reason, so US-only setups stay green) |
| `server/verify-continuity.ts` | generalize to a per-market spec list: `[{scope:'us_stocks', calendar:'us_equities', dataset:'grouped_daily', from:env US}, {scope:'cn_stocks', calendar:'cn_equities', dataset:'tushare daily', from:env CN}]`; CN open-days come from trade_cal (authoritative), missing-bar days checked against it |
| `scripts/verify-adjustments-cn.ts` (new, or extend) | parity: our `split_dividend`-equivalent cumulative factor vs vendor `adj_factor` per (ts_code, date): compare RATIOS normalized to the latest date (vendor factor is cumulative hfq); segment report like US; target ≥99.9% on non-suspended days |
| `server/api.ts` | timezone for minute-day formatting from `facts.exchanges` per instrument (CN daily unaffected; keeps the door open) |
| `src/components/StockChart.tsx` | daily charts are date-labeled (no change needed for CN); leave intraday ET until CN minutes exist — note in code |
| `.env(.example)` | `TUSHARE_TOKEN=`, `ATM3_CN_BACKFILL_FROM=2024-07-01` (pinned, same contract language as US) |
| docs | phenomena §14 (CN realities above), data-model source table + cn calendar note, bootstrap-plan CN milestone entries |

## Phasing (each phase = one PR-sized unit, done-when + proof)

**CN-M1 — connector + raw.** All six datasets landing with manifests;
idempotent re-runs fetch nothing; `raw:reindex` reproduces `raw.fetches`.
Done when: `npm run status` shows tushare datasets; re-run = all skipped;
2 years of `daily` files present (~490 files, small).

**CN-M2 — facts.** Builders fill the same tables; 600519.SH exists with
symbol `[list_date, ∞)`; trading_days has `cn_equities` past+future from
trade_cal; corporate actions carry the new ratio columns; bars in shares/
CNY. Done when: fixture test (CN mini-universe incl. a 送股+派息 case and a
suspension gap) passes; live: `select count(*) from facts.bars_daily where
market_scope='cn_stocks'` ≈ 5000+ stocks × ~485 days; rebuild reproduces
identical ids/counts; all US tests untouched and green.

**CN-M3 — computed + parity.** Factor view handles
`stock_dividend`/`rights_issue`; `adjusted_bars('split_dividend')` returns
correct CN series (the policy name is kept; docs note it means "all
capital adjustments" — renaming the policy is an owner decision, default
keep). Done when: hand-computed fixture cases match to 1e-9 (e.g.
prev_close 10.00, 10送2转3派1.5税前 → factor = (10−0.15)/(10×1.5) = 0.6567,
volume ×1.5); live parity vs `adj_factor` ≥99.9% with a segmented report
and every mismatch class explained in the doc (suspensions around ex-dates
are the expected residual).

**CN-M4 — pipeline + contract + surfaces.** Pipeline cards for tushare
steps (skip cleanly without token); `verify:continuity` green across BOTH
markets with per-market windows; UI: market selector lists `cn_stocks`
automatically (it is data-driven), search 贵州茅台 / 600519 works, chart
renders with dividend markers. Done when: full run-all ends green on both
verify segments; screenshots in the PR.

## Acceptance for the whole iteration

1. `600519.SH` searchable by code and name; chart shows cash-dividend
   markers; `split_dividend` policy visibly steps at ex-dates.
2. One real 送股/转增 case (implementer picks from the window) adjusts
   exactly; parity vs adj_factor ≥99.9% market-wide, residuals explained.
3. `verify:continuity` green for `us_stocks` AND `cn_stocks` windows.
4. Everything US: 25/25 existing tests still green, zero behavior change.
5. Docs updated (phenomena §14, data-model, bootstrap-plan); no `TODO`s.

## Open decisions for the owner (answer before CN-M1)

1. CN window start 2024-07-01 (same as US)? [recommended: yes]
2. Include BSE (北交所)? [recommended: not yet]
3. Tushare account tier — confirm points cover `daily`-by-date, `dividend`,
   `namechange`, `adj_factor` sweeps at ~500 calls/backfill.
4. Keep policy name `split_dividend` for CN (meaning "all capital
   adjustments") or rename to `capital_adjusted` globally? [recommended:
   keep; renaming touches API/UI/tests for cosmetic gain]

## Known risks

- Tushare per-minute rate limits: backfill must throttle (connector
  enforces a configurable delay; ~500 daily calls is minutes, fine).
- `dividend` data quality: duplicate 实施 statements per event exist —
  the same-day statement dedupe (US rename lesson) must apply.
- Rights issues are rarer and messier (ratios conditional on record date);
  if the window has none, the fixture test still pins the formula.
- Delisted-stock daily coverage: `daily` by trade_date includes then-listed
  codes — verify one delisted example end-to-end (the FB→META analogue).
