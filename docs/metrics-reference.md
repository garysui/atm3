# Metrics reference

<!-- GENERATED FILE — DO NOT EDIT. Source: core/metrics-catalog.ts. -->
<!-- Regenerate with `npm run docs:metrics`; a sync test fails when stale. -->

Every metric the view-at-T engine computes: **62 daily** metrics across 9 families plus **17 session** (intraday) metrics — 79 total. This page is generated from the catalog (`core/metrics-catalog.ts`), so it is always complete and current by construction. Exact formulas, the theory behind the estimators, and every term used below live in the [glossary](glossary.md).

How to read the columns: **measures** — what the number tells you; **window** — the lookback in bars (daily) or minute bars (session); **needs** — minimum bars before the metric reports a value instead of an honest null; **basis** — `adj` (split-dividend adjusted as of T), `raw` (as-traded), `dollar` (raw close × raw volume, split-invariant); **at** — earliest availability (`open`, `close`, or intraday `minute`).

## state (4)

Levels and status for filter predicates — real as-traded prices, listing state, sample size.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `close_raw` | As-traded close at T. | 1 | 1 | raw | currency | close |
| `dollar_adv21_log10` | Log10 mean raw dollar volume over the 21 bars before T. | 21 | 22 | dollar | log10_currency | close |
| `listed_bars` | Instrument bars observed through T. | all | 1 | raw | bars | close |
| `active_at_t` | A symbol validity window contains T. | — | 1 | raw | boolean | close |

## returns (8)

How much the price moved over standard bar windows (adjusted basis; 21 ≈ month, 63 ≈ quarter, 252 ≈ year).

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `ret_1d` | One-bar adjusted return. | 1 | 2 | adj | ratio | close |
| `ret_5d` | Five-bar adjusted return. | 5 | 6 | adj | ratio | close |
| `ret_21d` | Twenty-one-bar adjusted return. | 21 | 22 | adj | ratio | close |
| `ret_63d` | Sixty-three-bar adjusted return. | 63 | 64 | adj | ratio | close |
| `ret_126d` | One-hundred-twenty-six-bar adjusted return. | 126 | 127 | adj | ratio | close |
| `ret_252d` | Two-hundred-fifty-two-bar adjusted return. | 252 | 253 | adj | ratio | close |
| `mom_12_1` | Twelve-to-one-month adjusted momentum. | 252 | 253 | adj | ratio | close |
| `ret_intraday` | T close versus T open. | 1 | 1 | raw | ratio | close |

## gap (3)

Overnight behavior — the move between the previous close and the open, economically adjusted.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `gap` | Adjusted overnight opening gap. | 1 | 2 | adj | ratio | open |
| `gap_freq_63d` | Share of 63 gaps whose absolute value exceeds two percent. | 63 | 64 | adj | share | close |
| `abs_gap_med_63d` | Median absolute adjusted gap over 63 bars. | 63 | 64 | adj | ratio | close |

## trend (9)

Where the price sits against its own averages, 52-week extremes, drawdown, and streaks.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `close_vs_sma20` | Adjusted close relative to its 20-bar mean. | 20 | 20 | adj | ratio | close |
| `close_vs_sma50` | Adjusted close relative to its 50-bar mean. | 50 | 50 | adj | ratio | close |
| `close_vs_sma200` | Adjusted close relative to its 200-bar mean. | 200 | 200 | adj | ratio | close |
| `sma50_vs_sma200` | Fifty-bar mean relative to the 200-bar mean. | 200 | 200 | adj | ratio | close |
| `high_252_dist` | Adjusted close distance from the 252-bar adjusted high. | 252 | 252 | adj | ratio | close |
| `low_252_dist` | Adjusted close distance from the 252-bar adjusted low. | 252 | 252 | adj | ratio | close |
| `drawdown_252` | Adjusted close drawdown from the 252-bar close high. | 252 | 252 | adj | ratio | close |
| `up_streak` | Signed run length of consecutive up or down closes. | all | 2 | adj | bars | close |
| `up_days_21d` | Share of positive adjusted returns over 21 bars. | 21 | 22 | adj | share | close |

## volatility (9)

How much the name typically moves — close-to-close, range-based (Parkinson), and gap-robust (Yang-Zhang) sigmas, plus day-shape measures.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `vol_21d` | Annualized sample standard deviation of 21 log returns. | 21 | 22 | adj | annualized | close |
| `vol_63d` | Annualized sample standard deviation of 63 log returns. | 63 | 64 | adj | annualized | close |
| `vol_ratio_21_63` | Twenty-one-day volatility divided by 63-day volatility. | 63 | 64 | adj | ratio | close |
| `parkinson_21d` | Annualized 21-bar Parkinson range volatility. | 21 | 21 | raw | annualized | close |
| `atr_pct_14` | Mean 14-bar adjusted true range divided by adjusted close. | 14 | 15 | adj | ratio | close |
| `max_abs_ret_21d` | Largest absolute adjusted return over 21 bars. | 21 | 22 | adj | ratio | close |
| `range_pct` | T raw high-low range divided by close. | 1 | 1 | raw | ratio | close |
| `clv` | T close location value inside the raw high-low range. | 1 | 1 | raw | ratio | close |
| `yz_vol_21d` | Yang-Zhang annualized volatility: overnight plus open-close plus Rogers-Satchell terms. | 21 | 22 | adj | annualized | close |

## volume (4)

Participation and liquidity on split-invariant dollar volume.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `rvol_21d` | T dollar volume relative to the previous 21-bar mean. | 21 | 22 | dollar | ratio | close |
| `volume_trend_5_63` | Five-bar mean dollar volume divided by its 63-bar mean. | 63 | 63 | dollar | ratio | close |
| `amihud_21d` | Mean absolute return per dollar volume, scaled by one million. | 21 | 22 | dollar | per_1e6_currency | close |
| `suspended_days_63d` | Share of 63 listed scope-calendar open days with no bar. | 63 | 1 | raw | share | close |

## events (4)

Corporate-action context knowable at T — recency, knowably upcoming ex-dates, trailing yield.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `days_since_split` | Instrument bars since the latest effective split. | all | 1 | raw | bars | close |
| `days_since_dividend` | Instrument bars since the latest effective cash dividend. | all | 1 | raw | bars | close |
| `declared_ex_days` | Open days to the nearest known future ex date. | — | 1 | raw | open_days | close |
| `div_yield_ttm` | Sum of split-safe per-event cash yields over the last 252 bars. | 252 | 253 | raw | ratio | close |

## context (15)

Co-movement with named baselines (SPY and the trailing-correlation tracking ETF) and the residual — the movement that is the name's own.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `beta_63_spy` | Trailing return beta to SPY. | 63 | 64 | adj | beta | close |
| `corr_63_spy` | Trailing return correlation to SPY. | 63 | 64 | adj | correlation | close |
| `resid_ret_21_spy` | Twenty-one-bar residual return versus SPY. | 21 | 64 | adj | ratio | close |
| `resid_ret_63_spy` | Sixty-three-bar residual return versus SPY. | 63 | 64 | adj | ratio | close |
| `idio_vol_63_spy` | Annualized residual volatility versus SPY. | 63 | 64 | adj | annualized | close |
| `rel_ret_21` | Twenty-one-bar return minus SPY return. | 21 | 22 | adj | ratio | close |
| `rel_ret_63` | Sixty-three-bar return minus SPY return. | 63 | 64 | adj | ratio | close |
| `tracking_etf` | Highest trailing-correlation ETF from the curated list. | 63 | 64 | adj | symbol | close |
| `tracking_corr_63` | Trailing correlation to the selected tracking ETF. | 63 | 64 | adj | correlation | close |
| `tracking_beta_63` | Trailing beta to the selected tracking ETF. | 63 | 64 | adj | beta | close |
| `resid_ret_21_tracking` | Twenty-one-bar residual return versus the tracking ETF. | 21 | 64 | adj | ratio | close |
| `resid_ret_63_tracking` | Sixty-three-bar residual return versus the tracking ETF. | 63 | 64 | adj | ratio | close |
| `idio_vol_63_tracking` | Annualized residual volatility versus the tracking ETF. | 63 | 64 | adj | annualized | close |
| `resid_z_spy` | Today residual return over the residual sigma of the 63 pairs ending yesterday. | 63 | 65 | adj | sigma | close |
| `resid_z_vadj_spy` | Residual z divided by the square root of relative dollar volume (volume as the clock). | 63 | 65 | adj | sigma | close |

## surprise (6)

Today versus this name's OWN trailing distribution; every denominator ends at T-1 so today never contaminates its own sigma.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `range_med_21d` | Median relative range (high minus low over previous close) of the 21 bars ending yesterday. | 21 | 22 | adj | ratio | close |
| `range_surprise` | Today relative range over its trailing median — travel versus this name's normal day. | 21 | 22 | adj | ratio | close |
| `ret_z_21d` | Today log return over yesterday-anchored daily Parkinson sigma. | 21 | 22 | adj | sigma | close |
| `ret_z_vadj_21d` | Return z divided by the square root of relative dollar volume. | 21 | 22 | dollar | sigma | close |
| `ret_pctile_252d` | Empirical percentile of today log return within the 252 returns ending yesterday. | 252 | 253 | adj | share | close |
| `ret_kurt_252d` | Excess kurtosis of the 252 log returns ending yesterday — how literally to read sigma bands. | 252 | 253 | adj | ratio | close |


## session (17)

Intraday state at minute T, from the session's complete RTH minute bars strictly before T.

| id | measures | window | needs | basis | unit | at |
|---|---|---|---|---|---|---|
| `last_price` | Close of the last complete RTH minute before T. | 1 | 1 | raw | currency | minute |
| `cum_dollar_volume` | Cumulative RTH dollar volume before T. | all | 1 | dollar | currency | minute |
| `minutes_since_open` | Complete RTH minute bars observed before T. | all | 1 | raw | bars | minute |
| `session_fraction` | Observed bars over the 390-minute regular session, capped at 1. | all | 1 | raw | share | minute |
| `gap_at_open` | First RTH minute open versus the adjusted previous daily close. | 1 | 1 | adj | ratio | minute |
| `session_ret` | Last price versus the first RTH minute open. | all | 1 | raw | ratio | minute |
| `ret_from_prev_close` | Last price versus the adjusted previous daily close. | all | 1 | adj | ratio | minute |
| `vwap_dist` | Last price versus the session typical-price VWAP so far. | all | 1 | raw | ratio | minute |
| `session_range_pos` | Last price position inside the session high-low range so far. | all | 1 | raw | ratio | minute |
| `session_high_dist` | Last price versus the session high so far. | all | 1 | raw | ratio | minute |
| `session_low_dist` | Last price versus the session low so far. | all | 1 | raw | ratio | minute |
| `range_pct_so_far` | Session high-low range so far over the adjusted previous daily close. | all | 1 | adj | ratio | minute |
| `ret_30m` | Last price versus the close 30 visible bars earlier. | 30 | 31 | raw | ratio | minute |
| `ret_60m` | Last price versus the close 60 visible bars earlier. | 60 | 61 | raw | ratio | minute |
| `session_vol` | Annualized sample volatility of visible minute log returns. | all | 22 | raw | annualized | minute |
| `up_minutes_share` | Share of visible minute closes above the prior minute close. | all | 22 | raw | share | minute |
| `rvol_pace` | Cumulative dollar volume versus the same-cutoff average of up to 20 prior sessions (needs at least 5). | all | 1 | dollar | ratio | minute |
