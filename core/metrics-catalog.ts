export const metricFamilies = [
  'state',
  'returns',
  'gap',
  'trend',
  'volatility',
  'volume',
  'events',
  'context',
] as const

export type MetricFamily = (typeof metricFamilies)[number]
export type MetricBasis = 'adj' | 'raw' | 'dollar'
export type MetricAvailableAt = 'open' | 'close'

export type MetricCatalogEntry = {
  id: string
  family: MetricFamily
  window: number | 'all' | null
  min_bars: number
  available_at: MetricAvailableAt
  basis: MetricBasis
  unit: string
  description: string
}

const close = 'close' as const

export const metricsCatalog = [
  { id: 'close_raw', family: 'state', window: 1, min_bars: 1, available_at: close, basis: 'raw', unit: 'currency', description: 'As-traded close at T.' },
  { id: 'dollar_adv21_log10', family: 'state', window: 21, min_bars: 22, available_at: close, basis: 'dollar', unit: 'log10_currency', description: 'Log10 mean raw dollar volume over the 21 bars before T.' },
  { id: 'listed_bars', family: 'state', window: 'all', min_bars: 1, available_at: close, basis: 'raw', unit: 'bars', description: 'Instrument bars observed through T.' },
  { id: 'active_at_t', family: 'state', window: null, min_bars: 1, available_at: close, basis: 'raw', unit: 'boolean', description: 'A symbol validity window contains T.' },

  { id: 'ret_1d', family: 'returns', window: 1, min_bars: 2, available_at: close, basis: 'adj', unit: 'ratio', description: 'One-bar adjusted return.' },
  { id: 'ret_5d', family: 'returns', window: 5, min_bars: 6, available_at: close, basis: 'adj', unit: 'ratio', description: 'Five-bar adjusted return.' },
  { id: 'ret_21d', family: 'returns', window: 21, min_bars: 22, available_at: close, basis: 'adj', unit: 'ratio', description: 'Twenty-one-bar adjusted return.' },
  { id: 'ret_63d', family: 'returns', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Sixty-three-bar adjusted return.' },
  { id: 'ret_126d', family: 'returns', window: 126, min_bars: 127, available_at: close, basis: 'adj', unit: 'ratio', description: 'One-hundred-twenty-six-bar adjusted return.' },
  { id: 'ret_252d', family: 'returns', window: 252, min_bars: 253, available_at: close, basis: 'adj', unit: 'ratio', description: 'Two-hundred-fifty-two-bar adjusted return.' },
  { id: 'mom_12_1', family: 'returns', window: 252, min_bars: 253, available_at: close, basis: 'adj', unit: 'ratio', description: 'Twelve-to-one-month adjusted momentum.' },
  { id: 'ret_intraday', family: 'returns', window: 1, min_bars: 1, available_at: close, basis: 'raw', unit: 'ratio', description: 'T close versus T open.' },

  { id: 'gap', family: 'gap', window: 1, min_bars: 2, available_at: 'open', basis: 'adj', unit: 'ratio', description: 'Adjusted overnight opening gap.' },
  { id: 'gap_freq_63d', family: 'gap', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'share', description: 'Share of 63 gaps whose absolute value exceeds two percent.' },
  { id: 'abs_gap_med_63d', family: 'gap', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Median absolute adjusted gap over 63 bars.' },

  { id: 'close_vs_sma20', family: 'trend', window: 20, min_bars: 20, available_at: close, basis: 'adj', unit: 'ratio', description: 'Adjusted close relative to its 20-bar mean.' },
  { id: 'close_vs_sma50', family: 'trend', window: 50, min_bars: 50, available_at: close, basis: 'adj', unit: 'ratio', description: 'Adjusted close relative to its 50-bar mean.' },
  { id: 'close_vs_sma200', family: 'trend', window: 200, min_bars: 200, available_at: close, basis: 'adj', unit: 'ratio', description: 'Adjusted close relative to its 200-bar mean.' },
  { id: 'sma50_vs_sma200', family: 'trend', window: 200, min_bars: 200, available_at: close, basis: 'adj', unit: 'ratio', description: 'Fifty-bar mean relative to the 200-bar mean.' },
  { id: 'high_252_dist', family: 'trend', window: 252, min_bars: 252, available_at: close, basis: 'adj', unit: 'ratio', description: 'Adjusted close distance from the 252-bar adjusted high.' },
  { id: 'low_252_dist', family: 'trend', window: 252, min_bars: 252, available_at: close, basis: 'adj', unit: 'ratio', description: 'Adjusted close distance from the 252-bar adjusted low.' },
  { id: 'drawdown_252', family: 'trend', window: 252, min_bars: 252, available_at: close, basis: 'adj', unit: 'ratio', description: 'Adjusted close drawdown from the 252-bar close high.' },
  { id: 'up_streak', family: 'trend', window: 'all', min_bars: 2, available_at: close, basis: 'adj', unit: 'bars', description: 'Signed run length of consecutive up or down closes.' },
  { id: 'up_days_21d', family: 'trend', window: 21, min_bars: 22, available_at: close, basis: 'adj', unit: 'share', description: 'Share of positive adjusted returns over 21 bars.' },

  { id: 'vol_21d', family: 'volatility', window: 21, min_bars: 22, available_at: close, basis: 'adj', unit: 'annualized', description: 'Annualized sample standard deviation of 21 log returns.' },
  { id: 'vol_63d', family: 'volatility', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'annualized', description: 'Annualized sample standard deviation of 63 log returns.' },
  { id: 'vol_ratio_21_63', family: 'volatility', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Twenty-one-day volatility divided by 63-day volatility.' },
  { id: 'parkinson_21d', family: 'volatility', window: 21, min_bars: 21, available_at: close, basis: 'raw', unit: 'annualized', description: 'Annualized 21-bar Parkinson range volatility.' },
  { id: 'atr_pct_14', family: 'volatility', window: 14, min_bars: 15, available_at: close, basis: 'adj', unit: 'ratio', description: 'Mean 14-bar adjusted true range divided by adjusted close.' },
  { id: 'max_abs_ret_21d', family: 'volatility', window: 21, min_bars: 22, available_at: close, basis: 'adj', unit: 'ratio', description: 'Largest absolute adjusted return over 21 bars.' },
  { id: 'range_pct', family: 'volatility', window: 1, min_bars: 1, available_at: close, basis: 'raw', unit: 'ratio', description: 'T raw high-low range divided by close.' },
  { id: 'clv', family: 'volatility', window: 1, min_bars: 1, available_at: close, basis: 'raw', unit: 'ratio', description: 'T close location value inside the raw high-low range.' },

  { id: 'rvol_21d', family: 'volume', window: 21, min_bars: 22, available_at: close, basis: 'dollar', unit: 'ratio', description: 'T dollar volume relative to the previous 21-bar mean.' },
  { id: 'volume_trend_5_63', family: 'volume', window: 63, min_bars: 63, available_at: close, basis: 'dollar', unit: 'ratio', description: 'Five-bar mean dollar volume divided by its 63-bar mean.' },
  { id: 'amihud_21d', family: 'volume', window: 21, min_bars: 22, available_at: close, basis: 'dollar', unit: 'per_1e6_currency', description: 'Mean absolute return per dollar volume, scaled by one million.' },
  { id: 'suspended_days_63d', family: 'volume', window: 63, min_bars: 1, available_at: close, basis: 'raw', unit: 'share', description: 'Share of 63 listed scope-calendar open days with no bar.' },

  { id: 'days_since_split', family: 'events', window: 'all', min_bars: 1, available_at: close, basis: 'raw', unit: 'bars', description: 'Instrument bars since the latest effective split.' },
  { id: 'days_since_dividend', family: 'events', window: 'all', min_bars: 1, available_at: close, basis: 'raw', unit: 'bars', description: 'Instrument bars since the latest effective cash dividend.' },
  { id: 'declared_ex_days', family: 'events', window: null, min_bars: 1, available_at: close, basis: 'raw', unit: 'open_days', description: 'Open days to the nearest known future ex date.' },
  { id: 'div_yield_ttm', family: 'events', window: 252, min_bars: 253, available_at: close, basis: 'raw', unit: 'ratio', description: 'Sum of split-safe per-event cash yields over the last 252 bars.' },

  { id: 'beta_63_spy', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'beta', description: 'Trailing return beta to SPY.' },
  { id: 'corr_63_spy', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'correlation', description: 'Trailing return correlation to SPY.' },
  { id: 'resid_ret_21_spy', family: 'context', window: 21, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Twenty-one-bar residual return versus SPY.' },
  { id: 'resid_ret_63_spy', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Sixty-three-bar residual return versus SPY.' },
  { id: 'idio_vol_63_spy', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'annualized', description: 'Annualized residual volatility versus SPY.' },
  { id: 'rel_ret_21', family: 'context', window: 21, min_bars: 22, available_at: close, basis: 'adj', unit: 'ratio', description: 'Twenty-one-bar return minus SPY return.' },
  { id: 'rel_ret_63', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Sixty-three-bar return minus SPY return.' },
  { id: 'tracking_etf', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'symbol', description: 'Highest trailing-correlation ETF from the curated list.' },
  { id: 'tracking_corr_63', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'correlation', description: 'Trailing correlation to the selected tracking ETF.' },
  { id: 'tracking_beta_63', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'beta', description: 'Trailing beta to the selected tracking ETF.' },
  { id: 'resid_ret_21_tracking', family: 'context', window: 21, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Twenty-one-bar residual return versus the tracking ETF.' },
  { id: 'resid_ret_63_tracking', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'ratio', description: 'Sixty-three-bar residual return versus the tracking ETF.' },
  { id: 'idio_vol_63_tracking', family: 'context', window: 63, min_bars: 64, available_at: close, basis: 'adj', unit: 'annualized', description: 'Annualized residual volatility versus the tracking ETF.' },
] as const satisfies readonly MetricCatalogEntry[]

export type MetricId = (typeof metricsCatalog)[number]['id']
