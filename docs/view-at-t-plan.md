# View at T — plan (v1, 2026-07-10)

Status: PLAN, for owner review before implementation. This is the research
layer's first core concept, implementing the primitives the
[bootstrap plan](bootstrap-plan.md) locked in its research-phase contract.
First iteration is algorithms + a relatively complete metric catalog,
computed on demand; persistence is explicitly a later stage.

## Concept

At any time T, the data splits into two directions with different rules:

1. **Backward (the visible past).** Everything with a bar date ≤ T, adjusted
   *as of T* — reconstructing exactly what a careful observer standing at T
   could have known. This algorithm already exists:
   `computed.adjusted_bars(policy, as_of := T)` and `adjusted_bars_for`. What
   v1 adds is the *contract* (visibility rules, tests) and consumers
   (metrics).
2. **Forward (the hidden future).** Bars after T are invisible for decisions,
   but needed to score a position hypothetically opened at T. They must be
   adjusted **relative to T**: a split or dividend between T and T+n changes
   share count / pays cash, and the gain math must account for it.

Doctrine unchanged: one data layer, algorithms over facts, compute on the
fly. "100 functions on one data."

## The visibility contract (what is knowable at T)

- **Bars:** market_date ≤ T. Default convention is **end-of-day T** (T's own
  bar is complete). Metrics that are already known earlier carry an
  `available_at: 'open'` tag (gap, overnight return) so a future at-open
  backtest can select only those; everything else is `'close'`.
- **Corporate actions, two distinct dates:**
  - *Effective* at T: `ex_date <= T` — these adjust the backward view
    (already the `as_of` semantics of the factor views).
  - *Known* at T: `declaration_date <= T` — these may appear in
    forward-looking context ("ex-dividend upcoming") **only** when a
    declaration date exists and is ≤ T. Polygon populates it for dividends
    and not for splits; splits are therefore treated as unknowable until
    ex-date. Conservative beats clairvoyant.
- **The law: truncation invariance.** Any at-T computation must return
  identical results on the full database and on a database rebuilt from only
  the raw files dated ≤ T. This is THE acceptance test for "no lookahead" —
  see the contract section.

## Forward returns (new primitive)

`forwardReturns(instrumentId, t, {horizons, entryBasis, policy})` in
`server/forward-returns.ts`, source-neutral like `adjustedReturnSeries`.

- **Horizons:** open days of the instrument's market-scope calendar
  (`{1, 5, 21, 63, 126, 252}` default). Calendar days, not instrument bars —
  a CN suspension must stretch time truthfully, not silently compress it.
- **Entry bases:** `t_close` (raw close at T) and `next_open` (raw open of
  the first bar after T). Default `next_open` — entering at the close of the
  bar that generated the signal is mild lookahead.
- **Math (total-return convention):** gain from entry date E to horizon date
  D is the ratio of `split_dividend`-adjusted prices with any anchor
  `as_of >= D`. Cumulative factors are products over events in `(date, anchor]`,
  so the ratio between two dates depends only on events *between* them —
  anchor-invariant. Equivalent to raw prices + split share scaling + cash
  dividends reinvested on ex-date. A cash-tally (non-reinvested) variant is
  execution-realism scope, later.
- **Honest edges, per horizon:** `{date, ret, mae, mfe, delisted, stale, bars_used}`:
  - `delisted`: the instrument's tape ends before D → report the last
    available bar's return, flagged. Never silently drop — this is where
    survivorship bias would otherwise enter.
  - `stale`: no bar on D (CN suspension) → carry the last close ≤ D, flagged.
  - `mae`/`mfe`: max adverse/favorable excursion — min adjusted low / max
    adjusted high within (E, D] over entry, for stop/target research.

## Metrics at T

### Design rules

1. **Dimensionless by default.** Ratios and returns. The few level metrics
   (as-traded close, log10 dollar ADV) are tagged `family: 'level'` with
   units; they exist for filter predicates (`price > 10` uses the REAL
   as-traded price, per the research contract).
2. **Declared, not scattered.** `core/metrics-catalog.ts` is data: one entry
   per metric — `{id, family, formula description, window, min_bars,
   available_at, unit}`. The engine (`server/metrics-at.ts`) computes all of
   them in one SQL pass over `adjusted_bars_for(id, policy, as_of := T)`
   window functions. UI and tests enumerate the catalog; adding a metric is
   adding one entry + one expression.
3. **Null with a reason, never a partial window.** A 252-day return with 100
   bars of history is null (`insufficient_window`, `bars_available: 100`) —
   not a 100-day return wearing a 252-day label.
4. **Adjusted basis for anything crossing dates** (`split_dividend` as-of-T),
   raw basis for within-day shapes (H/L/C of the same bar — factors cancel).
   Volume metrics use **dollar volume** (close × volume), which is
   split-invariant by construction.
5. **No smoothing, no winsorizing, no z-scores here.** Those are research-
   layer choices over honest inputs.

### Catalog v1 (~40 metrics)

**Returns / momentum** (adjusted closes; `r_n = c_T/c_{T-n} - 1`):
`ret_1d, ret_5d, ret_21d, ret_63d, ret_126d, ret_252d`; `mom_12_1`
(252→21 days ago, the classic momentum window excluding short-term
reversal); `ret_overnight` (adj open T / adj close D₁ − 1, `at: open`);
`ret_intraday` (close/open of T, raw).

**Gap** — `gap = ret_overnight` is THE motivating example for adjusted
basis: across a 2:1 split ex-date, raw open/close ≈ −50% "gap"; the as-of-T
adjusted basis reports the true economic overnight move. Plus
`gap_freq_63d` (share of |gap| > 2%) and `abs_gap_med_63d` (median |gap|).

**Trend / price position** (adjusted): `close_vs_sma20/50/200` (c/SMA − 1),
`sma50_vs_sma200`; `high_252_dist`, `low_252_dist` (close vs 252-day extreme
of adjusted high/low — the 52-week-high effect), `drawdown_252` (vs rolling
peak close); `up_streak` (signed consecutive closes), `up_days_21d`.

**Volatility** (log returns, annualized √252): `vol_21d, vol_63d`,
`vol_ratio_21_63` (term structure), `parkinson_21d` (from ln(H/L)², factors
cancel), `atr_pct_14` (true range with adjusted prev close, over close),
`max_abs_ret_21d` (the MAX/lottery effect), `range_pct` ((H−L)/C of T),
`clv` (close location in T's range, null when H=L).

**Volume / liquidity** (dollar volume): `dollar_adv21_log10` (level, USD/CNY
tagged), `rvol_21d` (T's dollar volume / 21-day average),
`volume_trend_5_63` (ADV5/ADV63), `amihud_21d` (mean |ret|/dollar volume,
unit-tagged per 1e6), `suspended_days_63d` (scope-calendar open days with no
bar ÷ 63 — ~0 for US, meaningful for CN).

**Events** (visibility-honest): `days_since_split`, `days_since_dividend`
(bar-days since last ex ≤ T); `declared_ex_days` (open days to the nearest
ex_date > T *whose declaration_date ≤ T*; null when nothing is knowably
scheduled); `div_yield_ttm` = Σ per-event yields (each event's
`cash / raw prev close in its own era`) over the trailing 252 bars —
era-safe without share conversions, dimensionless.

**Market context (US v1)**: `beta_63_spy`, `corr_63_spy`, `idio_vol_63`
(residual vol after the SPY beta), `rel_ret_21`, `rel_ret_63` (return minus
SPY's); **representative ETFs**: top-3 by `corr_63` of daily adjusted
returns against a curated ~20-ETF liquid list (`SPY QQQ IWM DIA` + the 11
SPDR sectors + `SMH XBI KRE XOP`, in `acquisition/us-context-etfs.json`,
owner-vetoable), each with its beta. Derived from our own bars — no new
vendor feed, no membership data to go stale. CN context: **deferred** —
indices aren't hooked up and the CN sample holds no ETFs; the context
section is explicitly null for `cn_stocks`, never faked.

**Identity / state** (levels): `close_raw` (as-traded, for predicates),
`listed_bars` (count ≤ T), `active_at_t` (listing window contains T).

### Intraday T (phase VT-P5, thin by design)

Same concept, minute granularity, T = (date, minute): `vwap_dist` (close vs
session VWAP so far), `session_range_pos`, `session_rvol_pace` (cumulative
volume vs same-minute average of prior sessions), `minutes_since_open`,
`gap` (known at open). Only ~4 days of minute history exist yet — the
algorithms are still built truthfully; history depth is a data decision,
not an algorithm one.

## Surfaces

- **API:** `GET /api/instruments/:id/view-at?t=YYYY-MM-DD` →
  `{t, available_at: 'close', metrics: [{id, family, value, bars_available,
  reason?}], context: {...} | null}`. Forward is opt-in and clearly labeled:
  `&forward=1&entry=next_open` → `forward: [{horizon, ...}]` under a
  `hindsight: true` key — the UI must render it visually separated from
  at-T knowledge.
- **UI (Instruments page):** a "view at T" control — date input plus
  click-on-chart to set T; a vertical T marker on the chart; a panel grouped
  by family rendering every catalog metric (nulls shown with their reason,
  not hidden); a separate, visually distinct forward block ("what happened
  next — hindsight"). Works identically for daily bars of AAPL and 600519.

## Explicitly NOT in v1

- **No persistence/caching.** Same doctrine as adjusted bars: algorithm
  first, snapshot later behind a watermark once recomputation cost is felt
  (a `computed.metrics_at_cache` shaped like `bars_daily_adjusted_cache` is
  the anticipated later stage).
- **No screening/ranking engine** (metrics across all instruments at T) —
  that is the next research concept and will reuse this catalog; v1's
  engine is per-instrument.
- **No execution realism** (fees, T+1, limits, cash-tally dividends), no
  z-scoring/winsorizing, no CN market context, no fundamental data
  (earnings/shares outstanding are not ingested; turnover-based metrics wait
  for that decision).

## Milestones (PR-sized)

- **VT-P1 — forward-returns primitive + visibility contract.**
  `server/forward-returns.ts`; fixture tests: anchor invariance, delisting
  flag (FOXO-style), CN suspension staleness, entry bases; plus the
  truncation-invariance test for the backward view (build fixture facts,
  compute at T, land post-T raw, rebuild, recompute — byte-equal).
- **VT-P2 — metrics catalog + engine.** `core/metrics-catalog.ts`,
  `server/metrics-at.ts` (one SQL pass); hand-checked fixture values to 1e-9
  for every formula, windows spanning a split+dividend; the split-day gap
  sanity case; 600519 parity (same row schema, context null).
- **VT-P3 — market context.** Curated ETF list, beta/corr/idio-vol vs SPY,
  top-3 representative ETFs; tests on synthetic correlated series.
- **VT-P4 — API + UI + docs.** `view-at` endpoint, instrument-page panel and
  T marker, hindsight-separated forward block; data-model doc gains a
  "view at T" section; bootstrap plan status updated; live demo evidence on
  AAPL and 600519.
- **VT-P5 (later) — intraday-T subset.** After daily proves the shape.

## Acceptance contract

1. **Truncation invariance:** metrics_at(T) and the backward view are
   byte-identical between the full fixture database and one rebuilt from
   raw ≤ T only.
2. **Anchor invariance:** forward returns identical for any adjustment
   anchor ≥ horizon date (test at anchor = D, D+5, full history).
3. **Hand-checked math:** every catalog formula asserted to 1e-9 on a
   synthetic series that spans a split AND a cash dividend inside the
   metric windows; one real spot-check documented (AAPL around
   2024-08 vs independently computed values).
4. **Split-day gap sanity:** synthetic 2:1 split ex T → naive raw gap
   ≈ −50%, catalog `gap` equals the true overnight move.
5. **Survivorship honesty:** forward returns from T near a delisting return
   flagged truncated results; the instrument never silently vanishes.
6. **No-lookahead events:** `declared_ex_days` is null when the dividend's
   declaration_date > T even though its ex_date is near; a split is never
   "known" before its ex-date.
7. **Source-neutral:** identical metric row schema for AAPL and 600519;
   `suspended_days_63d` > 0 on a CN suspension fixture; context null for CN
   with an explicit reason, not absence.
8. **Catalog discipline:** every metric declares family, window, min_bars,
   availability, unit; the insufficient-window null path is tested for at
   least one metric per family.

## Owner decisions

1. Default horizons `{1, 5, 21, 63, 126, 252}` and default entry basis
   `next_open` — confirm or amend.
2. The ~20-ETF context list (curated into `acquisition/us-context-etfs.json`
   with one-line rationales, like the CN universe) — sign off list.
3. Metric catalog cuts/additions — anything you use personally that is
   missing, or families to drop for v1.
4. UI placement: panel on the existing instrument page (recommended) vs a
   separate research tab.

## Risks / notes

- **Metric correctness is concentration risk** — one wrong window boundary
  poisons research silently. Mitigation is the hand-checked fixture per
  formula and truncation invariance; no metric ships without both.
- **Recompute cost** at ~500 bars × ~40 metrics per (instrument, T) is
  milliseconds-scale in DuckDB; the cache stage is deliberately deferred
  until a real consumer (screening at T across the whole market) makes cost
  visible.
- **Context ETFs are themselves survivors** — correlation against today's
  ETF list at a historical T is mild hindsight in *labeling* (not in
  price data). Acceptable for context display; documented so research never
  uses the label as a tradable signal.
