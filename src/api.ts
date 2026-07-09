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
