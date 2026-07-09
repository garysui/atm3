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

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
  }

  return response.json() as Promise<T>
}
