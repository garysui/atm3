export type Row = Record<string, unknown>

export type StatusReport = {
  raw: Row[]
  instruments: Row[]
  symbols: Row[]
  bars: Row[]
  corporateActions: Row[]
  tradingDays: Row[]
  computedAlgorithms: Row[]
  computed: Row[]
  unresolved: Row[]
  runs: Row[]
}

export type InstrumentDetail = {
  instrument: Row
  symbols: Row[]
  identifiers: Row[]
  corporateActions: Row[]
  barsSummary: Row
}

export type Bar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  cum_price_factor: number
  symbol_as_traded: string
}

export type BarsResponse = {
  policy: string
  asOf: string | null
  bars: Bar[]
}

export type MinuteBar = {
  // Epoch seconds UTC (may arrive as a string for BIGINT columns).
  time: number | string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  cum_price_factor: number
  symbol_as_traded: string
}

export type MinuteBarsResponse = {
  policy: string
  date: string
  asOf: string | null
  bars: MinuteBar[]
}

export type ViewAtMetric = {
  id: string
  family: string
  value: number | string | boolean | null
  bars_available: number
  reason: string | null
  unit: string
}

export type ForwardReturnRow = {
  horizon: number
  date: string | null
  ret: number | null
  mae: number | null
  mfe: number | null
  delisted: boolean
  stale: boolean
  bars_used: number
  reason?: string
}

export type ViewAtResponse = {
  t: string
  available_at: 'close'
  metrics: ViewAtMetric[]
  context_baselines: null | {
    spy: string | null
    tracking: string | null
  }
  forward?: {
    hindsight: true
    entry_basis: 'next_open' | 't_close'
    rows: ForwardReturnRow[]
  }
}

export type RankAtRow = {
  instrument_id: string
  symbol: string
  name: string
  ret_1d: number | null
  resid_z: number | null
  ret_z: number | null
  ret_z_vadj: number | null
  range_surprise: number | null
  rvol_21d: number | null
  ret_pctile_252d: number | null
  dollar_adv21: number | null
  xs_rank: number
}

export type RankAtResponse = {
  t: string
  scope: string
  baseline: 'SPY' | null
  sort: string
  min_dollar_adv: number
  universe: {
    traded_at_t: number
    qualifying: number
    excluded_liquidity: number
    excluded_window: number
  }
  gauges: {
    median_abs_ret_z: number | null
    share_abs_ret_z_gt2: number | null
  }
  rows: RankAtRow[]
}

export type ViewAtMinuteResponse = {
  t: { date: string; minute: string }
  available_at: 'minute'
  visible_bars: number
  prior_sessions: number
  prev_close_date: string | null
  metrics: ViewAtResponse['metrics']
  // The full daily view as of the previous close — knowable at any minute T.
  daily: ViewAtResponse | null
  forward?: {
    hindsight: true
    entry_basis: string
    rows: Array<Omit<ForwardReturnRow, 'horizon'> & { horizon: string }>
  }
}

// Retries transient failures: the dev API takes a few seconds to open the
// database (and tsx watch restarts it), during which the proxy returns
// 502/ECONNREFUSED.
export async function getJson<T>(url: string): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= 4; attempt++) {
    let response: Response | null = null

    try {
      response = await fetch(url)
    } catch (cause) {
      lastError = cause as Error
    }

    if (response) {
      if (response.ok) {
        return response.json() as Promise<T>
      }

      if (response.status !== 502 && response.status !== 503) {
        const body = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(
          body?.error ?? `${response.status} ${response.statusText}`,
        )
      }

      lastError = new Error(`${response.status} ${response.statusText}`)
    }

    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
    }
  }

  throw lastError ?? new Error('request failed')
}
