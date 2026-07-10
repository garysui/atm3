# CN stock market plan (cn_stocks) — v2, structural prototype

Status: PLAN v2, 2026-07-10 — revised per external review and new owner
constraints. Supersedes v1 (which targeted Tushare; retained as a future
connector in the appendix). Written for hand-off: identity keys, action
ids, canonical-source policy, and relay boundaries are DECIDED here, not
left to the engineer.

## Goal and constraints (owner)

**Goal: a structural proof** — adding Chinese A-shares must not materially
alter atm3's architecture or its source-neutral research interfaces. Not a
production vendor commitment; not a whole-market backfill.

Constraints:
1. No user registration, Chinese phone number, or personal API token.
2. A local Python package / small local acquisition relay is acceptable.
3. Python is isolated to ACQUISITION ONLY. TypeScript owns raw manifests,
   facts building, DuckDB, API, UI, research.
4. Prototype universe of ~30–50 representative securities, not 5,000.
5. US behavior must be byte/row-equivalent after this work.

## Source: BaoStock (prototype; pinned `baostock==0.8.9`)

Free, anonymous `bs.login()` (no registration/token) — satisfies the
constraint. Honestly labeled: community project, self-classified **Alpha**,
no SLA, custom TCP protocol via a Python-only client. Acceptable for a
structural prototype; a production vendor decision is explicitly deferred.

### Capability table

| need | BaoStock call | notes / fields |
|---|---|---|
| trading calendar | `query_trade_dates(start, end)` | calendar_date, is_trading_day — past+future; feeds `cn_equities` |
| universe snapshot | `query_all_stock(day)` | code, tradeStatus, code_name — one day's listed set |
| instrument metadata | `query_stock_basic(code=)` | code, code_name, ipoDate, outDate, type (1=stock), status |
| daily bars (unadjusted) | `query_history_k_data_plus(code, fields, start, end, frequency="d", adjustflag="3")` | date, code, open/high/low/close, preclose, **volume in SHARES, amount in CNY** (no ×100/×1000 normalization — that was Tushare), turn, tradestatus (1 trade / 0 suspended), pctChg, isST |
| distributions | `query_dividend_data(code, year, yearType)` | per-share cash pre/post tax (`dividCashPsBeforeTax` / `...AfterTax`), bonus (`dividStocksPs`), conversion (`dividReserveToStockPs`), register/ex/pay dates, plan/implement markers |
| vendor factors (diagnostic only) | `query_adjust_factor(code, start, end)` | fore/back cumulative factors; **BaoStock computes them from price-change ratios** (documented), which is NOT atm3's economic ex-right method — comparison is a classified diagnostic, never a pass/fail oracle |
| rights issues (配股) | **no established coverage** | DEFERRED — see corporate actions |

## Python relay boundary (exact)

A stateless CLI at `acquisition/baostock_relay.py` (pinned deps in
`acquisition/requirements.txt`), invoked by the TS ingester via
child_process — same pattern as the aws CLI for flat files.

Contract:
- stdin: one JSON job `{ api: string, params: object }`.
- stdout: JSONL, one line per PROTOCOL RESPONSE FRAME:
  `{ seq, request: string, frame_b64: string }`, then a final
  `{ done: true, frames: n }` line. stderr: diagnostics only.
- The relay holds NO state, writes NO files, does NO parsing beyond what
  frame capture requires. Login/logout are performed per invocation; the
  client version and login response code go into the manifest params.

**Raw truth (review finding #3):** BaoStock's SDK parses server frames into
`ResultData`/pandas — pandas output is NOT raw. The relay captures each
**decompressed application-layer response frame verbatim** (the exact
message string the SDK receives, before `setData()` parses it) by wrapping
the SDK's low-level receive path. Transport decompression is mechanical
(same stance as HTTP gzip on REST payloads); the frame string is the
vendor payload. TS base64-decodes each frame and lands it UNMODIFIED via
`landRawFile` (`storeVerbatim`), one file per frame:

```
raw/baostock/<dataset>/code=sh.600519/window=2024-07-01_2026-07-09/frame-0001.txt.gz
raw/baostock/trade_cal/snapshot_date=2026-07-15/frame-0001.txt.gz
```

Manifests record `{api, params, client_version, login_code}`; content
hashes cover the frame bytes. `raw:reindex` reproduces `raw.fetches` from
disk as everywhere else. Facts parse frames in TypeScript/DuckDB (the
frame body is a delimited/JSON-structured record set — the CN-P0 spike
pins the exact grammar and commits a fixture).

**Request shape (finding #4):** bars and dividends are per-code (+range/
year), NOT whole-market-per-day. Partitioning is per (dataset, code,
window); idempotency = presence of a completed (code, window) in
`raw.fetches`; the daily replenish extends each sample code's window
incrementally (`window=<last+1>_<cutoff>`). Throttle: sequential requests,
small fixed delay; the prototype is ~50 codes × a handful of calls —
minutes, not hours.

**Enablement (finding #15):** everything CN is gated on
`ATM3_CN_SOURCE=baostock` (plus `ATM3_CN_BACKFILL_FROM`). Unset → CN
pipeline steps report `skipped: CN source not enabled`; a US-only run-all
never installs Python, contacts BaoStock, or starts CN work.

## Prototype universe (~40 codes; curated, not representative statistics)

Selection criteria (implementer curates the list into
`acquisition/cn-prototype-universe.json`; owner signs off): main board SH
(60xxxx) and SZ (00xxxx), STAR 688xxx, ChiNext 300xxx, ≥2 ST/*ST names,
≥2 long-suspension names, ≥2 delisted-in-window names, ≥5 cash-dividend
payers, ≥3 bonus/conversion (送/转) events in window, 贵州茅台 600519
(acceptance case). **Research caveat, stated in code and docs: this sample
is intentionally selected; no historical research conclusion may be drawn
from it.**

## Identity (finding #6 — source-neutral; one deliberate deviation)

- `instrument_id = deterministic_uuid('instrument', 'cn:XSHG:600519')` —
  normalized exchange (XSHG/XSHE) + bare code. Source-neutral: a future
  Tushare/other connector resolves to the SAME instrument.
- Vendor codes are `facts.instrument_identifiers` rows:
  `baostock_code = sh.600519`, later `tushare_ts_code = 600519.SH`.
- **Deviation from the review's `XSHG:600519:<listing_date>` suggestion:**
  embedding the listing date makes the id hostage to vendor disagreement —
  two sources differing by one day on `ipoDate` would mint DUPLICATE
  instruments, the exact failure the finding aims to prevent. A-share code
  reuse across eras is effectively nonexistent; if evidence of reuse ever
  appears (disjoint listing windows with different names), the builder
  QUARANTINES the code (reason `code_reuse_suspected`) pending an explicit
  era policy, rather than guessing. Era-free key + quarantine handles the
  real risk without creating a new one.
- Renames change NAMES not codes: `namechange`-equivalent history from
  `code_name` deltas across universe snapshots lands as
  `facts.instrument_events` (`name_change`, payload old/new, incl. ST
  markers). Full name history is EXPLICIT DEFERRED SCOPE (BaoStock has no
  dedicated history API; snapshots only capture changes we observe).
- Symbols: one row per code, `[ipoDate, outDate)`, scope `cn_stocks`,
  exchange XSHG/XSHE, currency CNY.

## Canonical source per market (finding #7)

`computed.canonical_bars_daily` does NOT drop its source filter; it gains
an explicit per-scope canonical map, declared in schema.sql:

```sql
where (market_scope = 'us_stocks' and source_id = 'polygon')
   or (market_scope = 'cn_stocks' and source_id = 'baostock')
```

Comment at the site: adding a second source for a scope REQUIRES an
explicit precedence/reconciliation policy here — max-volume selection must
never arbitrate between vendors.

## Facts mapping (finding #13 — fields reconciled, no schema bloat)

- `facts.bars_daily`: only TRADED bars (`tradestatus=1 and volume>0`).
  Suspension-day rows, `preclose`, `turn`, `pctChg`, `isST` stay RAW-ONLY
  for the prototype (documented; suspension analytics later get their own
  fact/view if research needs them). Volume already shares, amount already
  CNY — no unit conversion.
- `facts.trading_days`: `cn_equities` from `query_trade_dates` (authoritative
  past+future). SSE/SZSE share one calendar; the CN facts builder
  cross-checks universe-snapshot trade statuses against it and quarantines
  discrepancies rather than silently ignoring them.
- `market_scope='cn_stocks'`, `currency='CNY'`, exchanges XSHG/XSHE rows in
  `facts.exchanges` (timezone `Asia/Shanghai`, calendar `cn_equities`).

## Corporate actions (findings #9, #10, #12 — exact representation)

**Per-component rows, one per (code, ex_date, component):**

| action_type | fields used | price factor | volume factor |
|---|---|---|---|
| `cash_dividend` | `cash_amount` = pre-tax per share (`dividCashPsBeforeTax`; post-tax recorded in new `cash_amount_post_tax`) | `1 − cash/prev_close` (existing) | 1 |
| `stock_dividend` | new `bonus_ratio` (=dividStocksPs) + `conversion_ratio` (=dividReserveToStockPs), per share | `1 / (1 + bonus + conversion)` | `1 + bonus + conversion` |
| `rights_issue` | **DEFERRED** — no raw feed established (finding #9); NO columns added until one exists | — | — |

- Deterministic `source_action_id = baostock:<code>:<ex_date>:<component>`;
  re-sweeps dedupe on it; only implemented (non-plan) rows become facts;
  same-day statement dedupe rules carry over from the US rename lesson.
- **Policy semantics:** `split` = share-structure events only (`split`,
  `stock_dividend`); `split_dividend` = plus cash. Policy names keep their
  meaning "structure-only" vs "all capital adjustments" (owner may rename
  later; cosmetic).
- **Separability proof (why per-component rows are exact):** the SSE
  ex-right reference for cash c + bonus/conversion b (no rights) is
  `(P − c) / (P(1 + b))`. The factor machinery multiplies same-day
  factors: `(1 − c/P) × 1/(1+b) = (P − c)/(P(1+b))` — identical. Composition
  through the existing same-date product is mathematically exact, so no
  combined-event type is needed. (With rights this separability breaks —
  one more reason rights wait for a real feed and their own validation,
  incl. the volume-factor question in finding #12.)
- Formula validity scope (finding #8): uniform distributions only.
  Differential distributions, repurchase-share exclusions, and
  exchange-approved special formulas are out of prototype scope; the
  diagnostic comparison classifies them, and the phenomena doc gets a CN
  section saying so.

## Schema deltas (SCHEMA_VERSION → 4; minimal)

1. `facts.corporate_actions` + `bonus_ratio double`,
   `conversion_ratio double`, `cash_amount_post_tax double` (nullable; US
   rows unaffected). NO rights columns (deferred with their feed).
2. `computed.adjustment_factor_events`: add the `stock_dividend` branch
   (pure ratio, no prev_close needed) alongside existing split/cash
   branches; `cash_dividend` branch gains per-instrument currency
   acceptance: expected currency = `facts.instruments.currency`
   (fallback 'USD'), replacing the `'USD'` literal.
3. `computed.canonical_bars_daily`: explicit per-scope canonical source map
   (above).
4. NOTHING else: no minute-view or API-timezone refactors in this
   milestone (finding #14) — CN minutes are out of scope and those touch
   US surface.

`core/adjustments.ts` gains the pure `stockDividendFactor(bonus, conversion)`
+ tests mirroring the SQL (house rule: formulas live in both, pinned by
fixture tests). `core/publication.ts` gains a CN daily cutoff (BaoStock
daily data updates in the evening CST; CN-P0 verifies the actual hour
empirically and encodes it with tests — until then the conservative cutoff
is CST yesterday).

## Milestones — structural proof (each PR-sized, done-when + proof)

**CN-P0 — relay + raw-capture spike.** Build the relay; capture frames for
one code across all five datasets; commit a REDACTED-free fixture frame
set + the frame grammar notes; verify hash-stable re-capture of identical
requests where the vendor is deterministic (calendar/history). Done when:
frame fixtures land in `tests/fixtures/baostock/` and a TS parser spike
reads them in DuckDB.

**CN-P1 — raw ingestion.** `server/baostock-ingest.ts` jobs (calendar,
universe snapshot, stock_basic, daily_k per code-window, dividends,
adj_factor) for the prototype universe; presence-skip idempotency;
pipeline steps gated on `ATM3_CN_SOURCE`. Done when: re-run fetches
nothing; `raw:reindex` reproduces `raw.fetches`; `npm run status` shows
baostock datasets.

**CN-P2 — facts.** `server/facts-build-cn.ts` inside the same
`buildAllFacts` transaction (shared helpers extracted to
`facts-common.ts`); identity/symbols/calendar/actions/bars per the
mappings above; quarantine paths exercised (suspended, delisted, ST).
Done when: fixture-driven test (mini CN universe incl. a 送转+派息 event,
a suspension gap, a delisted code) passes; rebuild reproduces identical
ids/counts; all existing US tests green and US facts row-identical.

**CN-P3 — computed + diagnostics.** Factor view CN branch; hand-checked
cases match to 1e-9 (e.g. P=10.00, 10派1.5送2转3 pre-tax →
`(10−0.15)/(10×1.5) = 0.985/1.5 = 0.656667`, volume ×1.5);
`verify:adjustments-cn` compares our cumulative series against
`query_adjust_factor` ratios **as a segmented diagnostic** (methodology
differences expected and classified — finding #11), NOT a % gate. Done
when: fixtures + a real 送转 case hand-verified; diagnostic report runs
and its residual classes are written into the doc.

**CN-P4 — surfaces + contract.** Market selector shows `cn_stocks`
automatically; search by code and current name (600519 / 贵州茅台); daily
chart with dividend markers; `verify:continuity` gains the CN spec —
per-code raw window coverage for the sample + facts bars present for every
`trade_cal`-open, non-suspended (code, day) — green on both markets. Done
when: the structural acceptance contract below passes end to end.

## Structural acceptance contract (replaces v1 acceptance)

1. Raw frames + manifests alone rebuild ALL CN prototype facts
   (delete DB → reindex → facts:build → identical ids/counts).
2. Acquisition and facts building are idempotent (re-run changes nothing).
3. US outputs remain row-equivalent: all pre-existing tests green;
   `facts.*` US row counts and spot checksums unchanged.
4. One source-neutral query/strategy function (e.g. "N-day return series
   with split_dividend policy, as-of T") runs for AAPL and 600519 with ONLY
   the instrument/market_scope input changing — same columns, types,
   policy semantics, as-of behavior.
5. No query outside `facts-build-cn.ts`/the relay references
   BaoStock-specific field names.
6. Current-name search and daily charts work for the prototype universe.
7. ≥1 cash event and ≥1 bonus/conversion event hand-checked to 1e-9.
8. Vendor-factor comparison exists as a SEGMENTED DIAGNOSTIC with residual
   classes explained in-doc; no unexplained blanket threshold.
9. Explicitly deferred and documented: rights issues, full name history,
   CN minutes, whole-market backfill, BSE.

## Future (separate commitment, not this iteration)

- Whole-market CN backfill: requires source re-evaluation (BaoStock scale/
  reliability vs a token-bearing vendor) — the connector seam and identity
  keys above are deliberately source-neutral to keep this swappable.
- Tushare appendix (v1 plan) remains valid if a token materializes.
- Rights issues + their volume convention, with a named feed and
  independent validation.
- Execution-realism layer for CN backtests (T+1, price limits, lot sizes,
  suspension tradability) — enters as market/execution constraints keyed by
  market_scope, never per-source strategy branches (finding #16).

## Owner decisions (only true owner calls; all else is decided above)

1. Approve BaoStock (Alpha, no SLA, anonymous) as the prototype source
   under constraint #1? [plan assumes yes]
2. CN prototype window: 2024-07-01, matching US? [recommended yes]
3. Prototype universe list sign-off once curated (criteria above).
4. Keep policy name `split_dividend` meaning "all capital adjustments"?
   [recommended keep]

## Risks

- BaoStock is Alpha with no SLA: outages stall CN replenish (US unaffected
  by design); frames grammar could change — pinned version + committed
  fixtures detect drift loudly.
- Frame-capture depends on wrapping SDK internals of the pinned version —
  CN-P0 exists precisely to de-risk this first.
- Dividend data quality (plan vs implemented markers, missing ex-dates) —
  quarantine + the diagnostic comparison surface these.
- Name-change capture is snapshot-diff-based → gaps are expected and
  documented as deferred scope.
