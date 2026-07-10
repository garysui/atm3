# Glossary

The project's dictionary: every non-obvious term, one place, kept current.
**Evolving contract:** any change that introduces a new term, metric, flag,
or reason adds its entry here in the same commit. Entries are short — one
definition, the exact calculation where one exists, and why it matters.
Formulas are ```` ```math ```` blocks (KaTeX-rendered in the Docs tab).
The complete metric list with one-line meanings is the generated
[metrics reference](metrics-reference.md); this glossary holds the formulas
and the theory.

Sections: Notation · Data layers · Identity · Corporate actions &
adjustment · Calendars, sessions, publication · View at T · Volatility
estimation (theory) · Daily metrics (state, returns, gap, trend,
volatility, volume, events, context & residuals, surprise) · Cross-
sectional ranking · Session metrics · Forward returns · Flags & reasons ·
CN market terms · Pipeline & operations.

## Notation (used by every metric)

Bars are the instrument's own daily bar series up to and including T,
indexed **backward**: index 0 is T's bar, index 1 the bar before it.

- `ac, ao, ah, al` — adjusted close/open/high/low, `split_dividend` policy,
  **as of T** (see *as-of*). `c, o, h, l, v` — raw (as-traded) values.
- Daily simple and log returns, and dollar volume:

```math
r_i = \frac{ac_i}{ac_{i+1}} - 1
\qquad
\mathit{lr}_i = \ln\!\frac{ac_i}{ac_{i+1}}
\qquad
\mathit{dv}_i = c_i \, v_i
```

- Dollar volume is **split-invariant** — a split divides price and
  multiplies volume by the same factor, so their product is unchanged:

```math
\left(\tfrac{c}{f}\right)\!\cdot\!\left(v f\right) = c\,v
```

- Moving average and annualization:

```math
\mathit{SMA}_n = \frac{1}{n}\sum_{i=0}^{n-1} ac_i
\qquad
\mathit{ann} = \sqrt{252}
```

- "n bars" windows end at T inclusive unless an entry says otherwise.
  Session (minute) metrics use their own notation, defined in that section.

## Data layers

- **raw zone** — verbatim vendor bytes on disk, append-only, never edited.
  The only source of truth; everything else can be deleted and rebuilt.
- **verbatim payload / storeVerbatim** — the exact bytes a vendor returned,
  landed unmodified (no re-serialization, no normalization).
- **manifest (`.meta.json`)** — the sidecar written with every raw file:
  request URL/params, content hash, row count, timestamps. `raw:reindex`
  rebuilds the `raw.fetches` index from manifests alone, no network.
- **facts** — deterministic, full-refresh tables built from raw (identity,
  calendars, corporate actions, bars). Rebuilding from the same raw
  reproduces identical rows and ids.
- **computed** — algorithms over facts: views and table macros (adjusted
  bars, factor events). Nothing here is truth; all of it is derivable.
- **ops** — bookkeeping (runs, quarantine, watermarks). Never truth.
- **disposable database** — the DuckDB file is an index over `data/raw/`.
  A `SCHEMA_VERSION` mismatch deletes the file and rebuilds; there are no
  migrations.
- **deterministic id** — `deterministic_uuid(kind, key)`:
  `md5('atm3:' + kind + ':' + key)` shaped into a UUID (version 3 bits), so
  every rebuild mints identical ids.
- **watermark** — a fingerprint of the inputs a cached artifact was built
  from (e.g. facts generation + action/bar counts). Cache is used only
  while the watermark matches; otherwise rebuilt and verified.
- **facts generation** — a UUID stamped at the end of each atomic facts
  build; downstream caches key their watermarks on it.
- **single writer, reader pool** — one process owns the DuckDB write lock
  (the API server, which runs pipeline jobs); UI queries use a small pool
  of read connections in the same process.

## Identity

- **instrument** — the economic entity (a listing of a company's share
  class). Stable `instrument_id`; everything else hangs off it.
- **symbol** — a time-ranged *label* on an instrument: `[valid_from,
  valid_to)`, **valid_to exclusive**. Tickers are reused across companies
  (FB: Meta → an ETF), so a symbol only means something on a date.
- **identifier** — a vendor's or registry's key for the instrument
  (composite FIGI, `baostock_code`), also validity-ranged.
- **market_scope** — locale + asset class (`us_stocks`, `cn_stocks`). A
  query concern, never a storage boundary: one data layer serves all
  markets.
- **symbol chaining** — inferring when a reused ticker's new life began
  from the previous holder's delisting, when no explicit event exists.
- **case-significant tickers** — `INNpF` (preferred) and `INNPF` are
  different securities. Tickers are never case-folded anywhere.
- **canonical line** — one instrument can trade as concurrent tape lines
  (when-issued `AAPW` next to `AAP`). `canonical_bars_daily` picks one line
  per instrument-day by max volume — within one vendor, never across
  vendors.
- **canonical source** — the explicit per-scope vendor map (`us_stocks` →
  polygon, `cn_stocks` → baostock). Adding a second vendor for a scope
  requires a stated precedence policy; volume never arbitrates vendors.
- **symbol_as_traded** — the label a bar actually printed under that day
  (survives renames; lets bars span FB→META under one instrument).
- **quarantine (`ops.unresolved`)** — rows the builders refuse to guess
  about, kept visible with a reason instead of being dropped or forced.

## Corporate actions & adjustment

- **action components** — one fact row per economic component, even when
  announced together: `split`, `cash_dividend` (per-share cash, pre-tax in
  `cash_amount`, vendor post-tax kept in `cash_amount_post_tax`),
  `stock_dividend` (CN bonus + conversion share ratios).
- **ex-date** — first trading day the price no longer carries the
  entitlement; the date an action becomes *effective*.
- **declaration date** — when the action became publicly known; the only
  date that may drive *forward-looking* context at T.
- **adjustment policy** — which events adjust history: `none` (the raw
  tape), `split` (structure only: splits + stock dividends),
  `split_dividend` (structure + cash; the total-return basis).
- **per-event price factor** — computed from our own raw closes, never
  vendor cumulative factors:

```math
f_{\text{split}} = \frac{\mathit{from}}{\mathit{to}}
\qquad
f_{\text{cash}} = 1 - \frac{\mathit{cash}}{P_{\text{prev}}}
\qquad
f_{\text{stock}} = \frac{1}{1 + b + t}
```

  where `P_prev` is the last raw close strictly before the ex-date, `b` the
  bonus ratio and `t` the conversion ratio. Volume factors are the share
  multipliers (`to/from`, `1`, `1+b+t`).
- **separability** — same-day components compose by multiplication and
  reproduce the exchange's combined ex-right formula exactly:

```math
\left(1 - \frac{c}{P}\right)\cdot\frac{1}{1+b}
= \frac{P - c}{P\,(1+b)}
```

- **cumulative factor** — what a bar is multiplied by under a policy: the
  product of per-event factors for events *after* the bar and ≤ the anchor:

```math
F(d) = \prod_{e\,:\; d \,<\, \mathit{ex}_e \,\le\, \mathit{anchor}} f_e
```

- **as-of (anchor)** — the knowledge date of an adjusted view. `as_of := T`
  applies only events with ex-date ≤ T: the same facts serve every T on
  demand, storing none of them.
- **anchor invariance** — the ratio of two adjusted prices depends only on
  events *between* the two dates, so any anchor ≥ both dates gives the
  same ratio. This is why forward returns are well-defined.
- **series anchor rule** — an event applies to a series only where the
  series has bars after it (ex-date ≤ the instrument's last bar), so
  future-dated or post-delisting statements (SOXS, FOXO) cannot corrupt
  history.
- **duplicate statement collapse** — vendors restate one distribution under
  both rename tickers (MULN, BINI); identical same-day statements collapse
  to one before factors are built.
- **unadjustable dividends** — dividends that produce no factor, visible
  with reasons (`no_prev_close`, `cash_exceeds_prev_close`,
  `non_usd_only` / `currency_mismatch_only`) instead of silently skewing.
- **vendor factor diagnostic** — comparisons against vendor adjustment
  series are classified and reported, never used as a pass/fail oracle
  (BaoStock's factors are price-change ratios, a different method).

## Calendars, sessions, publication

- **trading day / open day** — a calendar row (`us_equities`,
  `cn_equities`) with `is_open`. Only evidenced days are materialized:
  past days from data, future closures from holiday feeds — which is why
  far horizons report `beyond_calendar`.
- **closure** — a zero-row whole-market day: evidence the market was
  closed, not missing data.
- **contradicted closure** — a claimed closure with minute data present —
  a red flag the continuity check hunts for.
- **coverage / continuity contract** — from the fixed start (2024-07-01),
  every weekday is either covered by data or an evidenced closure;
  `verify:continuity` alarms on any hole.
- **publication cutoff** — the last date whose data can exist yet: daily =
  yesterday exchange-local; US minute files = yesterday only after ~06:00
  ET (published ~00:30 ET).
- **suspension** — an open market day with no bar for an instrument (CN);
  bars are simply absent, and views must stretch time truthfully.
- **RTH (regular trading hours)** — 09:30–16:00 ET, minutes 570–960
  inclusive; minute 960 is the **auction minute** where the official close
  prints.
- **two-tapes doctrine** — daily bars are authoritative for official OHLC;
  minute bars for intraday paths. Minute-derived values (session VWAP, the
  first minute's open) are never passed off as official prints.
- **minute ⊆ daily volume invariant** — an instrument-day's minute volume
  can never exceed its daily volume; violations are data bugs.

## View at T

- **T** — the observation moment. Daily: end of day T (T's bar complete).
  Intraday: (date, exchange-local minute); complete bars strictly before
  the minute.
- **visibility** — what an observer at T could know: bars ≤ T, actions
  *effective* if ex-date ≤ T, actions *known* if declaration ≤ T.
- **truncation invariance** — the law: any at-T computation returns
  identical results on the full database and on one rebuilt from only raw
  files dated ≤ T. The mechanical definition of "no lookahead".
- **hindsight** — anything computed from data after T (forward returns).
  Always delivered under an explicit `hindsight: true` label and rendered
  separately in the UI.
- **basis** — which price series a metric reads: `adj` (split_dividend
  as-of T; anything crossing dates), `raw` (within-bar shapes and real
  price levels), `dollar` (raw close × raw volume; split-invariant).
- **catalog** — metrics are data (`core/metrics-catalog.ts`): id, family,
  window, `min_bars`, availability, basis, unit. The engine, API, UI, and
  tests all enumerate it; the API returns exactly the catalog's ids.
- **null with a reason** — below `min_bars` or with an undefined input, a
  metric is `null` plus a machine reason — never a shortened window wearing
  a long window's label. See *Flags & reasons*.
- **residualization** — removing a named baseline's co-movement from a
  stock's returns to isolate its own movement. "Own" is a modeling opinion,
  so the baseline is explicit in every metric id (`_spy`, `_tracking`).
- **baseline** — the series regressed against: `spy` (market proxy) or
  `tracking` (best trailing-correlation ETF from the curated list).
- **tracking ETF** — argmax of 63-bar return correlation over
  `acquisition/us-context-etfs.json`, selected with trailing data only.
  The list itself is today's survivors: prices are period-correct, but the
  *label* is not a historically tradable signal.

## Volatility estimation — why range-based (theory)

A daily bar is a cumulative conclusion about a whole path, not one trading
point — its high and low carry information the close alone throws away.
That observation founded a family of estimators this project uses:

- **Close-to-close** (`vol_21d`): the baseline, `stdev` of log returns.
  Unbiased but statistically wasteful — one number per day.
- **Parkinson (1980)** — variance from the squared log range; for a
  driftless diffusion `E[ln²(H/L)] = 4\ln 2 \, \sigma^2`, giving ~5×
  the efficiency of close-to-close:

```math
\hat\sigma^2_{P} = \frac{1}{4 \ln 2}\;
\operatorname{mean}\!\left(\ln^2 \frac{h_i}{l_i}\right)
```

  Assumptions to respect: no drift, no overnight jump, continuous trading
  (discrete sampling means the observed range under-covers the true range,
  biasing σ slightly low — worst for thinly traded names).
- **Garman–Klass (1980)** — adds open/close information to the range
  (~7–8× efficient); same no-drift, no-overnight assumptions:

```math
\hat\sigma^2_{GK} = \operatorname{mean}\!\left(
\tfrac{1}{2}\ln^2\tfrac{h_i}{l_i}
- (2\ln 2 - 1)\,\ln^2\tfrac{c_i}{o_i}\right)
```

- **Rogers–Satchell (1991)** — drift-robust; each bar contributes
  `u(u-c) + d(d-c)` with `u = ln(h/o)`, `d = ln(l/o)`, `c = ln(c/o)`:

```math
\hat\sigma^2_{RS} = \operatorname{mean}\big(u_i(u_i - c_i) + d_i(d_i - c_i)\big)
```

- **Yang–Zhang (2000)** — the practical default for daily bars
  (`yz_vol_21d`): decomposes variance into the overnight jump, the
  open-to-close move, and the drift-robust RS term, with a
  minimum-variance weight `k`. Handles both drift AND overnight gaps —
  the two failure modes of everything above:

```math
\hat\sigma^2_{YZ} = \hat\sigma^2_{\text{overnight}}
+ k\,\hat\sigma^2_{\text{open-close}}
+ (1 - k)\,\hat\sigma^2_{RS}
\qquad
k = \frac{0.34}{1.34 + \frac{n+1}{n-1}}
```

Distributional facts that shape the surprise metrics:

- The **raw range is not normal** — it is the range of a diffusion path
  (Feller 1951): strictly positive, right-skewed. `range_surprise` is
  therefore a ratio to the trailing *median*, not a z-score.
- The **log range is approximately normal**
  (Alizadeh–Brandt–Diebold 2002) — the result that makes range-based
  sigma estimation well-behaved.
- **Returns are conditionally fat-tailed**: per-name kurtosis is commonly
  5–30 versus 3 for a Gaussian, so a "2σ day" is more frequent than the
  normal 4.6% and differently so per name. σ is a *scale*, not a
  probability — `ret_pctile_252d` supplies the distribution-free
  probability and `ret_kurt_252d` says how literally to read σ bands for
  this name.
- **Mixture of Distributions Hypothesis** (Clark 1973): variance scales
  with trading volume — volume proxies information arrival, making it the
  market's clock. Dividing a z-score by `sqrt(relative volume)` re-expresses
  the move in participation time; that is the `_vadj` family.

## Daily metrics — state

- **`close_raw`** — the as-traded close at T, `c_0`. The price a predicate
  like "price > 10" must use — screens at T filter on real prices, not
  adjusted ones. *(level, currency; 1 bar)*
- **`dollar_adv21_log10`** — liquidity scale for filters. T excluded, so
  today's spike doesn't flatter its own average. *(21 bars before T; needs
  22)*

```math
\log_{10}\!\Big(\operatorname{mean}(\mathit{dv}_1 .. \mathit{dv}_{21})\Big)
```

- **`listed_bars`** — count of the instrument's bars ≤ T; the sample size
  behind every other metric.
- **`active_at_t`** — whether a symbol validity window contains T (still
  listed).

## Daily metrics — returns / momentum

All on the adjusted basis, dimensionless.

- **`ret_1d` / `ret_5d` / `ret_21d` / `ret_63d` / `ret_126d` /
  `ret_252d`** — the n-bar return; e.g. `ret_5d` compares T's adjusted
  close with the adjusted close 5 bars earlier. Windows are trading bars,
  not calendar days (21 ≈ one month, 63 ≈ a quarter, 252 ≈ a year). Needs
  n+1 bars. Short windows carry reversal effects; 6–12-month windows carry
  the momentum effect.

```math
\mathit{ret\_nd} = \frac{ac_0}{ac_n} - 1
```

- **`mom_12_1`** — classic momentum: the past year's return *excluding the
  most recent month*, because the last month tends to mean-revert
  (Jegadeesh–Titman). *(needs 253 bars)*

```math
\mathit{mom\_12\_1} = \frac{ac_{21}}{ac_{252}} - 1
```

- **`ret_intraday`** — T's open-to-close move, raw (same bar, factors
  irrelevant): `c_0 / o_0 − 1`. The day's directional body.

## Daily metrics — gap

- **`gap`** — the overnight move into T, **on the adjusted basis**, and the
  reason the basis matters: across a 2-for-1 split ex-date the raw
  open/prev-close is ≈ −50% of mechanics; the adjusted ratio is the true
  economic move (available at open; needs 2 bars).

```math
\mathit{gap} = \frac{ao_0}{ac_1} - 1
```

- **`gap_freq_63d`** — share of the last 63 bars whose |gap| > 2%: how
  jumpy the name is overnight (event/news exposure, thin books).
- **`abs_gap_med_63d`** — the *typical* overnight jump,
  `median(|gap_i|)` over 63 bars — robust to one earnings night.

## Daily metrics — trend / price position

Adjusted basis throughout.

- **`close_vs_sma20` / `close_vs_sma50` / `close_vs_sma200`** — distance
  from the n-bar mean; the standard stretched/depressed measures. Needs n
  bars.

```math
\frac{ac_0}{\mathit{SMA}_n} - 1
```

- **`sma50_vs_sma200`** — `SMA50/SMA200 − 1`: the golden-cross/death-cross
  regime state as a number rather than an event.
- **`high_252_dist`** — distance below the 52-week high; names near their
  high behave differently (the George–Hwang 52-week-high effect):

```math
\frac{ac_0}{\max_{i \le 251} ah_i} - 1
```

- **`low_252_dist`** — same against the 252-bar low (`min al_i`).
- **`drawdown_252`** — distance from the rolling 252-bar *close* peak; the
  standard drawdown definition.
- **`up_streak`** — signed run length of consecutive up (or down) closes:
  +4 = four straight up days, −3 = three straight down; 0 if unchanged.
  Short-term stretch/reversal raw material.
- **`up_days_21d`** — share of the last 21 bars with `r_i > 0`; direction
  consistency as opposed to magnitude.

## Daily metrics — volatility

Log returns; annualized values multiply by √252. `stdev` is the *sample*
standard deviation.

- **`vol_21d` / `vol_63d`** — realized volatility over 21/63 bars:

```math
\operatorname{stdev}(\mathit{lr}_0 .. \mathit{lr}_{n-1}) \times \sqrt{252}
```

- **`vol_ratio_21_63`** — the vol term structure, `vol_21d / vol_63d`:
  above 1 = volatility rising versus its own recent norm.
- **`parkinson_21d`** — range-based volatility from intraday highs/lows
  (raw h/l — the adjustment factor cancels in the ratio). More efficient
  than close-to-close vol when gaps are small; bars with h = l contribute
  0.

```math
\sqrt{\frac{1}{4\ln 2}\;
\operatorname{mean}\!\left(\ln^2\frac{h_i}{l_i}\right)}
\times \sqrt{252}
```

- **`atr_pct_14`** — Wilder's true range, normalized by price so it's
  comparable across names. True range extends the bar's range to the
  previous close to capture gaps:

```math
\mathit{TR}_i = \max(ah_i,\, ac_{i+1}) - \min(al_i,\, ac_{i+1})
\qquad
\mathit{atr\_pct\_14} = \frac{\operatorname{mean}(\mathit{TR}_0..\mathit{TR}_{13})}{ac_0}
```

- **`yz_vol_21d`** — the Yang–Zhang annualized sigma over the last 21
  bars (see the theory section above): overnight + open-close + RS terms,
  drift- and gap-robust. The σ to quote for a name.
- **`max_abs_ret_21d`** — the largest single-day |move| in a month: the
  MAX/lottery-preference measure (Bali–Cakici–Whitelaw); big recent
  jackpots predict poor subsequent returns on average.
- **`range_pct`** — T's raw bar range over close, `(h_0 − l_0)/c_0`; the
  day's total travel.
- **`clv`** — close location value: where in the day's range the close
  landed, +1 at the high, −1 at the low; null when h = l.

```math
\mathit{clv} = \frac{2c_0 - h_0 - l_0}{h_0 - l_0}
```

## Daily metrics — volume / liquidity

Dollar-volume based (split-invariant by construction).

- **`rvol_21d`** — relative volume: T's dollar volume against the mean of
  the 21 bars *before* T (T excluded from its own baseline). The standard
  "is something happening today" measure.

```math
\mathit{rvol\_21d} = \frac{\mathit{dv}_0}{\operatorname{mean}(\mathit{dv}_1..\mathit{dv}_{21})}
```

- **`volume_trend_5_63`** — ADV5/ADV63: is participation building or
  draining over weeks.
- **`amihud_21d`** — Amihud illiquidity: average absolute return per unit
  of dollar volume (×10⁶, i.e. per million). High values = prices move a
  lot per traded currency = illiquid; carries a documented return premium.

```math
\operatorname{mean}\!\left(\frac{|r_i|}{\mathit{dv}_i}\right) \times 10^6
```

- **`suspended_days_63d`** — share of the last 63 *scope-calendar open
  days* (while listed) with no bar. ≈0 for US; the honest CN suspension
  measure. Null until the instrument has 63 listed open days.

## Daily metrics — events

Visibility-honest: knowledge only from dates ≤ T.

- **`days_since_split` / `days_since_dividend`** — bars since the most
  recent effective (ex-date ≤ T) structure event / cash dividend; null
  with `no_known_event` when there has never been one.
- **`declared_ex_days`** — open days to the nearest *future* ex-date whose
  declaration date ≤ T — i.e. an ex-dividend the observer at T actually
  knows is coming. Splits never appear (no declared date exists in the
  feed, so they are unknowable before ex).
- **`div_yield_ttm`** — trailing dividend yield as a **sum of per-event
  yields**, each measured against the raw close just before its own
  ex-date. Era-safe by construction: no share-count conversions across
  splits are ever needed. Needs 253 bars (a real trailing year).

```math
\mathit{div\_yield\_ttm} =
\sum_{e \,\in\, \text{last 252 bars}} \frac{\mathit{cash}_e}{c_{\mathit{prev}(e)}}
```

## Daily metrics — context & residuals

US only in v1 (`cn_stocks` reports the family as null with
`no_market_baseline`). All estimation uses trailing bars ≤ T only. `b`
denotes a baseline series (SPY or the tracking ETF).

- **`beta_63_spy` / `tracking_beta_63`** — regression-through-origin beta
  over the trailing 63 aligned bars:

```math
\hat\beta = \frac{\operatorname{cov}(\mathit{lr}, \mathit{lr}_b)}{\operatorname{var}(\mathit{lr}_b)}
```

- **`corr_63_spy` / `tracking_corr_63`** — Pearson correlation of the same
  series; how much of the movement is shared at all.
- **`resid_ret_21_spy` / `resid_ret_63_spy` /
  `resid_ret_21_tracking` / `resid_ret_63_tracking`** — the compounded
  *residual* return over the last 21/63 bars: the stock's move with the
  baseline's contribution removed. This is the purpose of the tracking
  ETF — separating "the stock moved" from "its market/sector moved it".

```math
e_i = \mathit{lr}_i - \hat\beta\,\mathit{lr}_{b,i}
\qquad
\mathit{resid\_ret\_n} = \exp\!\Big(\sum_{i<n} e_i\Big) - 1
```

- **`idio_vol_63_spy` / `idio_vol_63_tracking`** — idiosyncratic
  volatility: `stdev(e) × √252`. The low-idio-vol anomaly's raw material,
  and the honest "how much of this name is its own" number.
- **`rel_ret_21` / `rel_ret_63`** — simple relative strength,
  `ret_n − ret_n(SPY)`: no beta model, just outperformance.
- **`tracking_etf`** — the selected baseline's symbol (see *tracking ETF*
  above). Selection is trailing-only and can legitimately flip over time.
- **`resid_z_spy`** — **today's own movement in units of yesterday's own
  sigma**: β̂ and the residual sigma are estimated on the 63 aligned pairs
  ending at T−1 (today never contaminates its own denominator), then
  today's residual is scored. The default cross-sectional ranking key — on
  a −3% market day a raw-z list is a beta list; this one is not.

```math
\hat\beta_{prev} = \frac{\operatorname{cov}_{1..63}}{\operatorname{var}_{1..63}}
\qquad
\mathit{resid\_z} = \frac{\mathit{lr}_0 - \hat\beta_{prev}\,\mathit{lr}_{b,0}}
{\operatorname{stdev}_{1..63}(e)}
```

- **`resid_z_vadj_spy`** — `resid_z / sqrt(rvol)`: the residual surprise
  in participation time (MDH). Reading the pair: big `resid_z`, small
  `vadj` = repricing fully backed by volume; both big = the move outran
  even its own participation.

## Daily metrics — surprise

Today versus this name's own trailing distribution; every denominator ends
at **T−1**.

- **`range_med_21d`** — median relative range `(h−l)/prev close` of the
  21 bars ending yesterday: the name's typical daily travel, robust to one
  event day.
- **`range_surprise`** — today's relative range over that median. Ratio,
  not z — the range is right-skewed (Feller), so sigma-scaling would lie.
- **`ret_z_21d`** — today's log return over the yesterday-anchored *daily*
  Parkinson sigma (range-based per the theory section: ~5× the data per
  day, so 21 bars estimate it usefully):

```math
\mathit{ret\_z} = \frac{\mathit{lr}_0}
{\sqrt{\operatorname{mean}_{1..21}\!\left(\ln^2\tfrac{h_i}{l_i}\right) / (4\ln 2)}}
```

- **`ret_z_vadj_21d`** — `ret_z / sqrt(dv_0 / mean(dv_1..dv_21))`: the
  move in volume-clock units (MDH). Distinguishes "normal random walk,
  loud tape" from "genuinely out of bounds".
- **`ret_pctile_252d`** — where today's return sits in the trailing 252
  (below-count + half of ties, over 252): calibrated, distribution-free,
  but saturating — every "biggest day in a year" reads ~0.996, which is
  why ranking breaks ties with |z|.
- **`ret_kurt_252d`** — excess kurtosis of the trailing returns: ≈0 means
  σ bands read literally; 10+ means tails happen and 3σ is Tuesday.

## Cross-sectional ranking (Movers at T)

- **rank-at** — the first cross-sectional computation: one SQL pass over
  the adjusted cache computes each traded name's surprise metrics at T and
  ranks them across the day (`GET /api/rank-at`, the Movers page).
- **sort key** — `resid_z` by default where a market baseline exists (rank
  own-movement, not beta), `ret_z` otherwise (and for scopes without a
  baseline, explicitly).
- **xs_rank** — the name's position by |sort key| among the day's
  qualifying universe: time-series surprise first, then a second
  normalization across the market.
- **liquidity floor (`min_dollar_adv`)** — z-scores explode on empty
  tapes (a spread bounce on no volume is a huge "surprise"); names below
  the trailing dollar-ADV floor are excluded and counted, never silently
  dropped.
- **day-context gauges** — the cross-section's own state: median |ret z|
  and the share of names beyond 2σ. A 3σ name on a day when 1% of the
  market is beyond 2σ is an event; the same name on a 20% day is weather.
- **universe accounting** — every exclusion is a number in the response:
  `traded_at_t`, `qualifying`, `excluded_liquidity`, `excluded_window`.

## Session metrics (intraday view at minute T)

Visible bars are the session's RTH minute bars **strictly before** T (the
in-progress minute is invisible), indexed like daily bars (`x_0` = last
visible minute). `first` is the first visible RTH bar; `prev` is the
**adjusted previous daily close as of D** — within one session raw and
as-of-D adjusted prices coincide, so cross-day ratios are exact.
`bars_available` counts visible bars.

- **`last_price`** — close of the last complete minute (level).
- **`cum_dollar_volume`** — Σ `c·v` over visible bars (level).
- **`minutes_since_open`** — count of visible bars (a halt makes this less
  than wall-clock minutes — deliberately).
- **`session_fraction`** — `min(1, visible/390)`; how much of the regular
  session has elapsed.
- **`gap_at_open`** — `first.open / prev − 1`. Adjusted denominator: an
  ex-date session gaps economically, not mechanically. Uses the minute
  tape's first print, which is *not* the official auction open (two-tapes
  doctrine).
- **`session_ret`** — `last / first.open − 1`: the move since the open.
- **`ret_from_prev_close`** — `last / prev − 1` = gap ∘ session move.
- **`vwap_dist`** — distance from the session's typical-price VWAP so far
  (same formula the chart draws):

```math
\mathit{VWAP} = \frac{\sum_i \frac{h_i + l_i + c_i}{3}\, v_i}{\sum_i v_i}
\qquad
\mathit{vwap\_dist} = \frac{\mathit{last}}{\mathit{VWAP}} - 1
```

- **`session_range_pos`** — where the last price sits in the session range
  so far: `(last − low) / (high − low)`; null when the range is zero.
- **`session_high_dist` / `session_low_dist`** — `last/high − 1`,
  `last/low − 1`.
- **`range_pct_so_far`** — `(high − low) / prev`: the session's travel in
  yesterday-close units.
- **`ret_30m` / `ret_60m`** — `last / close 30 (60) visible bars earlier
  − 1`; bar-based, so halts stretch it honestly. Needs 31/61 bars.
- **`session_vol`** — annualized realized vol of visible minute log
  returns; needs 22 bars.

```math
\operatorname{stdev}(\mathit{lr}^{min}) \times \sqrt{390 \times 252}
```

- **`up_minutes_share`** — share of visible minute closes above the prior
  minute close; needs 22 bars.
- **`rvol_pace`** — cumulative dollar volume versus the mean of the *same
  cutoff* over up to 20 prior sessions (≥5 required — honest
  `insufficient_window` until minute history accumulates):

```math
\mathit{rvol\_pace} =
\frac{\mathit{cumdv}(T)}{\operatorname{mean}_s\, \mathit{cumdv}_s(T)}
```

## Forward returns (hindsight)

- **entry basis** — the price a hypothetical position pays: `next_open`
  (first bar after T — default; entering on the signal bar's own close is
  mild lookahead), `t_close`, or for intraday the **next minute open** (the
  first RTH bar at/after minute T).
- **horizon** — daily: open days of the scope calendar after T
  ({1, 5, 21, 63, 126, 252}); intraday: `to_close`, `next_open`, `1d`,
  `5d`. Calendar-based, so suspensions stretch time instead of compressing
  it.
- **forward return** — the anchor-invariant ratio of adjusted prices
  (total-return convention: splits scale shares, dividends reinvest at
  ex):

```math
\mathit{ret}(E, D) = \frac{AC(D)}{AC(E)} - 1
```

- **MAE / MFE** — maximum adverse / favorable excursion over the path
  interval (E, D]: the worst and best mark against the entry, for
  stop/target research. Intraday horizons mix the remaining session's
  minute path with the daily bars after D.

```math
\mathit{MAE} = \min_{(E,\,D]} \frac{al_i}{P_E} - 1
\qquad
\mathit{MFE} = \max_{(E,\,D]} \frac{ah_i}{P_E} - 1
```

## Flags & reasons

- **`delisted`** (forward flag) — the valuation is carried because the
  instrument's tape ended, and **identity says so**
  (`delisted_date ≤ horizon`). Never inferred from missing bars — that
  would brand an active name delisted whenever a horizon outruns the
  newest data. This is where survivorship bias would silently enter.
- **`stale`** (forward flag) — the valuation is carried from an earlier
  bar for any other reason: a suspension, or the horizon lies beyond the
  last known bar of a live instrument.
- **`beyond_calendar`** (forward reason) — the horizon date is past the
  known trading calendar; the row exists with null date/return rather than
  failing the request or being dropped.
- **`no_entry_bar`** (forward reason) — no entry bar exists by the horizon
  (T was the last bar under `next_open`, or the horizon precedes a delayed
  entry).
- **`insufficient_window`** (metric reason) — fewer bars than the metric's
  `min_bars`; the value is null instead of a mislabeled shorter window.
- **`undefined_input`** (metric reason) — a guarded denominator or missing
  input (h = l for `clv`, no previous close for a first-day gap).
- **`no_known_event`** (metric reason) — the null means "no such event is
  knowable at T" (never a dividend, nothing declared) — an honest state,
  not a failure.
- **`no_market_baseline`** (metric reason) — the scope has no baseline
  wired (CN context family in v1); reported explicitly, never faked.
- **`skipped`** (pipeline state) — a step didn't run: chain-cancelled
  after an upstream failure, or intentionally (CN steps when
  `ATM3_CN_SOURCE` is unset), always with a reason.

## CN market terms

- **BaoStock** — the anonymous-login CN data source of the structural
  prototype (Alpha, no SLA; pinned client, custom TCP protocol).
- **protocol frame** — one decompressed application-layer response message
  from BaoStock's server, captured verbatim *before* the SDK parses it.
  Frames are the CN raw truth; pandas output never is.
- **relay** — the stateless Python CLI (`acquisition/baostock_relay.py`)
  that performs one API call and emits base64 frames as JSONL. Python is
  acquisition-only; TypeScript owns everything after the bytes.
- **vendor code** — `sh.600519` / `sz.000001`. An identifier, not the
  identity: instruments key on `cn:XSHG:600519` (exchange MIC + bare
  code), so a second CN vendor resolves to the same instrument.
- **XSHG / XSHE** — Shanghai / Shenzhen exchange MICs.
- **送股 (bonus) / 转增 (conversion)** — stock distributions: extra shares
  per existing share, from profits (送) or capital reserves (转). Both are
  structure events; "10送8转12" = 0.8 + 1.2 new shares per share.
- **派息 (cash dividend)** — per-share cash; stated pre-tax (used for
  adjustment, per exchange convention) and post-tax (kept as evidence).
- **ST / \*ST** — "special treatment" risk-warning name prefixes; part of
  the observed name, never parsed away, and such names remain ordinary
  identities.
- **tradestatus** — BaoStock's per-day trading flag; only `1` (traded)
  rows with volume become bar facts, suspension rows stay raw-only.
- **prototype universe** — the deliberately selected ~42-code CN sample
  (`acquisition/cn-prototype-universe.json`). Structural proof only: no
  population-level research conclusions may be drawn from it.
- **T+1 / price limits** — CN execution constraints (buy today, sell
  tomorrow; ±10%/±20% daily bands). Deliberately not modeled yet;
  execution-realism scope.

## Pipeline & operations

- **replenish** — the daily run: ingest missing raw → rebuild facts →
  refresh caches → verify continuity. Every step idempotent; buttons are
  safe to mash.
- **chain / fail-fast** — run-all executes steps in dependency order; a
  failed step cancels the rest of its chain (rebuilding from a failed
  ingest would launder stale input)…
- **`continueOnError` (soft-fail)** — …except steps whose absence
  downstream tolerates: CN raw ingests record their failure and let the
  chain continue, so a BaoStock outage cannot block the US build; the gap
  then surfaces in `verify:continuity`.
- **run (`ops.runs`)** — the durable record of every job execution (CLI
  and button runs share one history); crashed runs are marked aborted at
  boot.
- **backfill window** — the fixed coverage start (`2024-07-01`) to the
  publication cutoff; replenish extends coverage to "now" and fills holes
  automatically.
