# View at T — plan (v1.1, 2026-07-10, executable spec)

Status: PLAN, approved direction; written to be executed by another
implementer without further design decisions. Supersedes v1 (same day):
market context is reframed as **residualization** — separating a stock's
movement from named baselines — and the metric catalog is now an exact
spec, not prose.

## Concept

At any time T, the data splits into two directions with different rules:

1. **Backward (the visible past).** Everything with a bar date ≤ T, adjusted
   *as of T* — exactly what a careful observer standing at T could know.
   The algorithm exists: `computed.adjusted_bars(policy, as_of := T)` /
   `adjusted_bars_for`. v1 adds the contract (visibility rules + tests) and
   consumers (metrics).
2. **Forward (the hidden future).** Bars after T are invisible for
   decisions but needed to score a position hypothetically opened at T,
   adjusted **relative to T** (splits scale shares, dividends pay cash).

Doctrine unchanged: one data layer, algorithms over facts, compute on
demand. v1 stores nothing.

## The visibility contract (what is knowable at T)

- **Bars:** market_date ≤ T. Default convention: **end-of-day T** (T's bar
  complete). Metrics knowable earlier are tagged `available_at: 'open'`
  (gap); everything else `'close'`.
- **Corporate actions — two dates, two meanings:**
  - *Effective*: `ex_date <= T` adjusts the backward view (existing `as_of`
    semantics).
  - *Known*: `declaration_date <= T` may appear in forward-looking context
    ("ex-dividend upcoming") only when present and ≤ T. Polygon populates it
    for dividends, not splits → splits are unknowable before ex-date.
- **Baselines too:** every context/residual quantity (β, correlations,
  tracking-ETF selection) uses only bars ≤ T. No full-sample betas, no
  today's-label leakage.
- **The law — truncation invariance:** any at-T computation returns
  identical results on the full database and on one rebuilt from only raw
  files dated ≤ T. This is the acceptance test for "no lookahead".

## Forward returns (new primitive)

`forwardReturns(connection, {instrumentId, marketScope, t, horizons,
entryBasis, policy})` in `server/forward-returns.ts` — source-neutral,
same shape discipline as `adjustedReturnSeries`.

- **Horizons:** open days of the instrument's market-scope calendar
  (default `{1, 5, 21, 63, 126, 252}`). Calendar-based, not bar-based — a
  CN suspension stretches time truthfully instead of compressing it.
- **Entry bases:** `next_open` (default; raw open of the first bar after T
  — entering at the signal bar's own close is mild lookahead) and
  `t_close` (raw close at T).
- **Math (total-return convention):** return from entry date E to horizon
  date D = ratio of `split_dividend`-adjusted prices with any anchor
  `as_of >= D`. Factor products only involve events in `(E, D]`, so the
  ratio is **anchor-invariant** (tested). Equivalent to raw price + split
  share scaling + dividends reinvested at ex. Cash-tally (non-reinvested)
  is execution-realism scope, later.
- **Per horizon:** `{horizon, date, ret, mae, mfe, delisted, stale,
  bars_used}`:
  - `delisted`: tape ends before D → return through the last bar, flagged.
    Never silently dropped — this is where survivorship bias would enter.
  - `stale`: no bar on D (suspension) → carry last close ≤ D, flagged.
  - `mae`/`mfe`: min adjusted low / max adjusted high in (E, D] over entry.
- Entry-bar edge cases: T is the last bar → `next_open` entry impossible →
  explicit `no_entry_bar` result, not an error. T not a bar date of the
  instrument → error (the UI only offers bar dates).

## Metrics at T — engine design

1. **Catalog as data.** `core/metrics-catalog.ts` exports one entry per
   metric: `{id, family, window, min_bars, available_at, basis, unit,
   description}`. `server/metrics-at.ts` computes all metrics in one SQL
   pass of window functions over
   `computed.adjusted_bars_for(id, 'split_dividend', as_of := T)` (canonical
   line, per existing macro semantics), joined with raw OHLC where basis
   requires. UI and tests enumerate the catalog; adding a metric = one
   catalog entry + one expression.
2. **Null with a reason.** Fewer than `min_bars` bars ≤ T → `{value: null,
   reason: 'insufficient_window', bars_available}` — never a shortened
   window wearing a long window's label. Guarded denominators (H=L, zero
   dollar volume) → `'undefined_input'`.
3. **Bases.** `adj` = split_dividend-adjusted as-of-T (anything crossing
   dates); `raw` = as-traded (within-bar shapes — factors cancel;
   plus the level metrics used by real-price predicates); `dollar` = raw
   close × raw volume (split-invariant by construction).
4. No smoothing, winsorizing, or z-scoring here — research-layer choices,
   later, over honest inputs.

### Notation

Bars are the instrument's own bar series ≤ T, indexed backward (`x_0` = T's
bar, `x_1` = previous). `ac/ao/ah/al` adjusted close/open/high/low;
`c/o/h/l/v` raw; `dv_i = c_i × v_i`; `r_i = ac_i/ac_{i+1} − 1` (daily
return); `lr_i = ln(ac_i/ac_{i+1})`; `SMAn` = mean of last n adjusted
closes; `ann = √252`. "n bars" windows end at T inclusive.

### Catalog v1 — exact spec

**A. State** (levels, for predicates; unit tagged)

| id | definition | window | min_bars | notes |
|---|---|---|---|---|
| `close_raw` | `c_0` | 1 | 1 | as-traded; real-price predicates |
| `dollar_adv21_log10` | `log10(mean(dv_1..dv_21))` | 21 | 22 | liquidity filter scale; excludes T |
| `listed_bars` | count of bars ≤ T | all | 1 | |
| `active_at_t` | symbol validity window contains T | — | 1 | boolean |

**B. Returns / momentum** (basis adj, dimensionless)

| id | definition | min_bars |
|---|---|---|
| `ret_1d` | `ac_0/ac_1 − 1` | 2 |
| `ret_5d` | `ac_0/ac_5 − 1` | 6 |
| `ret_21d` | `ac_0/ac_21 − 1` | 22 |
| `ret_63d` | `ac_0/ac_63 − 1` | 64 |
| `ret_126d` | `ac_0/ac_126 − 1` | 127 |
| `ret_252d` | `ac_0/ac_252 − 1` | 253 |
| `mom_12_1` | `ac_21/ac_252 − 1` (momentum ex short-term reversal) | 253 |
| `ret_intraday` | `c_0/o_0 − 1` (raw, same bar) | 1 |

**C. Gap** (basis adj; `gap` is `available_at: 'open'`)

| id | definition | min_bars |
|---|---|---|
| `gap` | `ao_0/ac_1 − 1` — overnight move on an adjusted basis; across a split ex-date this is the true economic gap, not −50% | 2 |
| `gap_freq_63d` | share of last 63 bars with `abs(gap_i) > 0.02` | 64 |
| `abs_gap_med_63d` | `median(abs(gap_i))`, last 63 bars | 64 |

**D. Trend / price position** (basis adj)

| id | definition | min_bars |
|---|---|---|
| `close_vs_sma20` | `ac_0/SMA20 − 1` | 20 |
| `close_vs_sma50` | `ac_0/SMA50 − 1` | 50 |
| `close_vs_sma200` | `ac_0/SMA200 − 1` | 200 |
| `sma50_vs_sma200` | `SMA50/SMA200 − 1` (regime) | 200 |
| `high_252_dist` | `ac_0/max(ah_0..ah_251) − 1` (52-week-high effect) | 252 |
| `low_252_dist` | `ac_0/min(al_0..al_251) − 1` | 252 |
| `drawdown_252` | `ac_0/max(ac_0..ac_251) − 1` | 252 |
| `up_streak` | signed run length: consecutive `ac_i > ac_{i+1}` (negative for down; 0 if unchanged) | 2 |
| `up_days_21d` | share of last 21 bars with `r_i > 0` | 22 |

**E. Volatility** (log returns; annualized where noted)

| id | definition | min_bars |
|---|---|---|
| `vol_21d` | `stdev(lr_0..lr_20) × ann` | 22 |
| `vol_63d` | `stdev(lr_0..lr_62) × ann` | 64 |
| `vol_ratio_21_63` | `vol_21d / vol_63d` (term structure) | 64 |
| `parkinson_21d` | `sqrt(mean(ln(h_i/l_i)²)/(4·ln2)) × ann`, last 21 bars, raw h/l (factors cancel); bars with h=l contribute 0 | 21 |
| `atr_pct_14` | `mean(TR_0..TR_13)/ac_0`, `TR_i = max(ah_i, ac_{i+1}) − min(al_i, ac_{i+1})` | 15 |
| `max_abs_ret_21d` | `max(abs(r_i))`, last 21 (MAX/lottery effect) | 22 |
| `range_pct` | `(h_0 − l_0)/c_0` (raw) | 1 |
| `clv` | `(2c_0 − h_0 − l_0)/(h_0 − l_0)`; null when `h_0 = l_0` | 1 |

**F. Volume / liquidity** (basis dollar — split-invariant)

| id | definition | min_bars |
|---|---|---|
| `rvol_21d` | `dv_0 / mean(dv_1..dv_21)` (today vs trailing avg, T excluded from the average) | 22 |
| `volume_trend_5_63` | `mean(dv_0..dv_4)/mean(dv_0..dv_62)` | 63 |
| `amihud_21d` | `mean(abs(r_i)/dv_i) × 1e6`, last 21 bars (unit: per 1e6 currency) | 22 |
| `suspended_days_63d` | share of the last 63 *scope-calendar open days* ≤ T with no bar; null if listed (per symbol validity) < 63 open days | — |

**G. Events** (visibility-honest)

| id | definition | min_bars |
|---|---|---|
| `days_since_split` | bars since last split `ex_date <= T`; null if none | 1 |
| `days_since_dividend` | bars since last cash dividend `ex_date <= T`; null if none | 1 |
| `declared_ex_days` | scope-calendar open days from T to the nearest `ex_date > T` with `declaration_date <= T`; null when nothing knowably scheduled | 1 |
| `div_yield_ttm` | `Σ (cash_e / c(prev bar before ex_e))` over dividends with ex in the last 252 bars — a sum of per-event yields, each measured in its own price era: dimensionless and split-safe with no share conversion | 253 |

**H. Context & residuals** (`us_stocks` v1; for `cn_stocks` the whole
family is `{value: null, reason: 'no_market_baseline'}` — explicit, never
faked. See Residualization below.)

| id | definition | min_bars |
|---|---|---|
| `beta_63_spy` | `cov(lr, lr_SPY)/var(lr_SPY)`, last 63 aligned bars | 64 |
| `corr_63_spy` | Pearson corr of the same series | 64 |
| `resid_ret_21_spy` | `exp(Σ_{i<21} e_i) − 1`, `e_i = lr_i − β̂·lr_SPY,i`, β̂ = `beta_63_spy` | 64 |
| `resid_ret_63_spy` | `exp(Σ_{i<63} e_i) − 1` | 64 |
| `idio_vol_63_spy` | `stdev(e_0..e_62) × ann` | 64 |
| `rel_ret_21` | `ret_21d − ret_21d(SPY)` | 22 |
| `rel_ret_63` | `ret_63d − ret_63d(SPY)` | 64 |
| `tracking_etf` | argmax `corr_63` over the curated ETF list (as-of-T, trailing bars only); value = ETF symbol | 64 |
| `tracking_corr_63` | that max correlation | 64 |
| `tracking_beta_63` | β vs the tracking ETF | 64 |
| `resid_ret_21_tracking` | as `resid_ret_21_spy` with the tracking ETF baseline | 64 |
| `resid_ret_63_tracking` | 〃 63d | 64 |
| `idio_vol_63_tracking` | 〃 idio vol | 64 |

Total: 47 metrics.

## Residualization (the point of the tracking ETF)

Purpose: separate a stock's own movement from co-movement with a named
baseline, so research can ask "did this stock move, or did its market/
sector move it?" **"True" idiosyncratic movement is a modeling opinion** —
so v1 makes the model explicit and small rather than pretending neutrality:

- **Two named baselines**, both reported: `spy` (the market proxy, per the
  bootstrap decision to use SPY until indices are hooked up) and
  `tracking` (the best trailing-correlation ETF from a curated list). Every
  residual metric carries its baseline in the id.
- **Model:** daily log-return regression through the origin,
  `β̂ = cov/var` over the trailing 63 aligned bars ending at T; residual
  `e_i = lr_i − β̂·lr_b,i`. No intercept, no shrinkage, no multi-factor in
  v1 — those are research-layer refinements over the same primitives.
- **Alignment:** join on market_date over the stock's own bar dates;
  baseline bars come from the same `adjusted_bars_for` macro (ETFs are
  ordinary instruments in facts — SPY, QQQ, sector SPDRs are already
  present with full bars). A date where the baseline lacks a bar drops out
  of the pair-window (counted in `bars_available`).
- **As-of honesty:** the tracking ETF is *selected* at T from trailing data
  only, and β̂ uses trailing bars only, so residual metrics obey truncation
  invariance like everything else.
- **Curated list** (`acquisition/us-context-etfs.json`, one-line rationale
  per entry, owner-vetoable): `SPY QQQ IWM DIA` + sector SPDRs
  `XLK XLF XLE XLV XLI XLY XLP XLB XLRE XLU XLC` + industry proxies
  `SMH XBI KRE XOP`. ~19 symbols. Resolve symbol → instrument at T via the
  symbol validity window (`valid_from <= T < valid_to`), never bare
  current-symbol lookup.
- **Documented caveat:** the list itself is today's survivors; using the
  *label* as a tradable historical signal is out of bounds and the docs say
  so. Prices/correlations are period-correct.

## Surfaces

- **API:** `GET /api/instruments/:id/view-at?t=YYYY-MM-DD` →
  `{t, available_at: 'close', metrics: [{id, family, value,
  bars_available, reason?, unit?}], context_baselines: {spy, tracking} |
  null}`. Forward is opt-in and labeled:
  `&forward=1&entry=next_open|t_close` adds
  `forward: {hindsight: true, entry_basis, rows: [...]}`. Validation via
  zod like existing endpoints; T must be a bar date of the instrument
  (404-style error naming the nearest valid dates otherwise).
- **UI (Instruments page):** "view at T" control — date input + chart-click
  sets T; vertical T marker on the chart; metric panel grouped by family
  (nulls rendered with their reason, not hidden); forward block visually
  separated and labeled "what happened next — hindsight". Identical for
  AAPL and 600519 (600519 shows the context family as null with its
  reason).

## Explicitly NOT in v1

- No persistence/caching (later: a watermarked `computed.metrics_at_cache`
  shaped like the adjusted-bars cache, only once a real consumer makes
  recompute cost visible).
- No cross-market screening at T (next concept; reuses this catalog).
- No execution realism (fees, T+1, price limits, cash-tally dividends).
- No multi-factor residualization, z-scores, winsorizing.
- No fundamentals (shares outstanding, earnings) — separate ingestion
  decision.
- No schema changes at all: v1 touches no `db/schema.sql` table; it is
  TypeScript + SQL over existing facts/computed objects.
- Intraday-T metrics: phase VT-P5, after daily proves the shape (only ~4
  days of minute history exist; algorithms would be truthful but thin).

## Milestones (PR-sized, in order)

- **VT-P1 — forward returns + visibility contract.**
  `server/forward-returns.ts` + tests: anchor invariance (anchor = D, D+5,
  full), delisting flag (tape-ends fixture), CN suspension staleness, both
  entry bases, `no_entry_bar` edge, MAE/MFE hand-check; plus the
  truncation-invariance harness (fixture: compute at T → land post-T raw →
  rebuild facts → recompute → byte-equal) covering the backward view.
- **VT-P2 — catalog + engine.** `core/metrics-catalog.ts`,
  `server/metrics-at.ts`; fixture with a split AND a cash dividend inside
  the windows, every formula asserted to 1e-9; split-day gap sanity case;
  insufficient-window null per family; 600519 parity (same row schema,
  context family null-with-reason).
- **VT-P3 — residualization + context.** Curated ETF json; SPY + tracking
  baselines, β/corr/residual/idio metrics; synthetic test (stock =
  1.5×baseline + known noise → β̂ ≈ 1.5, residual metrics recover the
  noise); tracking selection as-of honesty test (selection flips only when
  trailing data says so).
- **VT-P4 — API + UI + docs + live evidence.** `view-at` endpoint +
  instrument-page panel + T marker + hindsight block; `docs/data-model.md`
  gains a "view at T" section; bootstrap plan status updated; live spot
  demo documented for AAPL (a 2025 date, values independently recomputed)
  and 600519 (a suspension-window CN name for `suspended_days_63d` if
  present in the sample).
- **VT-P5 (later, not now)** — intraday-T subset (`vwap_dist`,
  `session_range_pos`, `session_rvol_pace`, `minutes_since_open`).

## Acceptance contract (all objectively testable)

1. **Truncation invariance:** metrics_at(T) and the backward view are
   identical between the full fixture database and one rebuilt from raw
   ≤ T only.
2. **Anchor invariance:** forward returns identical for any adjustment
   anchor ≥ horizon date.
3. **Hand-checked math:** every catalog formula asserted to 1e-9 on a
   synthetic series spanning a split and a dividend inside the windows;
   one real AAPL spot-check documented with independent arithmetic.
4. **Split-day gap sanity:** synthetic 2:1 split ex T → naive raw
   open/prev-close ≈ −50%; catalog `gap` equals the true overnight move.
5. **Survivorship honesty:** forward from T near a delisting returns
   flagged, truncated results; never a silent drop.
6. **No-lookahead events:** `declared_ex_days` null when declaration_date
   > T despite a near ex_date; splits never "known" pre-ex.
7. **Residual sanity:** on stock = 1.5×baseline + noise, `beta_63` ≈ 1.5
   and residual metrics match the injected noise to tolerance; all
   baseline selection/estimation uses trailing bars only (covered by the
   truncation harness).
8. **Source-neutral:** identical metric row schema for AAPL and 600519;
   `suspended_days_63d` > 0 on a CN suspension fixture; CN context family
   null with reason `no_market_baseline`.
9. **Catalog discipline:** every metric declares family, window, min_bars,
   availability, basis, unit; the null path is tested at least once per
   family; the API returns exactly the catalog's ids, no more, no fewer.

## Owner decisions (resolved 2026-07-10 unless vetoed)

1. Horizons `{1, 5, 21, 63, 126, 252}`, default entry `next_open` —
   approved as recommended.
2. Context ETF list — implementer curates
   `acquisition/us-context-etfs.json` with rationales; flagged prominently
   in the VT-P3 report for owner veto, non-blocking (CN-universe pattern).
3. Catalog — the 47 metrics above are the approved v1 set; additions go
   through a plan amendment, not ad-hoc code.
4. UI placement — panel on the existing instrument page.

## Risks / notes

- **Metric correctness is concentration risk** — a wrong window boundary
  poisons research silently. No metric ships without its hand-checked
  fixture value and the truncation harness passing.
- **Per-call cost** (~500 bars × 47 metrics + 2 baseline series) is
  milliseconds-scale in DuckDB; the cache stage is deferred until
  screening-at-T makes cost real.
- **Windows are bar-count windows** (except `suspended_days_63d` and
  `declared_ex_days`, which are calendar-based by definition). For a
  suspended CN name, 63 bars may span far more than 63 calendar days —
  `bars_available` plus `suspended_days_63d` make that visible rather than
  hidden.

## Implementation notes

- 2026-07-10, VT-P1 interpretation: horizon dates are scope-calendar open
  dates counted strictly after T. `next_open` enters on the first instrument
  bar after T; a horizon before that delayed entry returns `no_entry_bar`.
  MAE/MFE follow the specified `(E, D]` interval exactly, while `bars_used`
  counts the entry bar through the carried valuation bar inclusively.
- 2026-07-10, VT-P2 correction: the exact catalog tables enumerate 53 ids
  (40 non-context plus 13 context), not the stated total of 47. All named ids
  are implemented; none were cut to force the erroneous prose total. `stdev`
  uses sample standard deviation, matching DuckDB's `stddev` convention.
- 2026-07-10, VT-P3: the owner-vetoable context list contains the 19 symbols
  named in the plan. Its labels are today's survivors; period prices and
  trailing selection are as-of-T honest, but list membership itself must not
  be interpreted as a historically tradable signal.
