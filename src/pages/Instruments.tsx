import { useEffect, useMemo, useState } from 'react'
import {
  getJson,
  type BarsResponse,
  type InstrumentDetail,
  type Row,
} from '../api.ts'
import { BarsChart, type ChartEvent } from '../components/BarsChart.tsx'
import { DataTable } from '../components/DataTable.tsx'

const policies = ['none', 'split', 'split_dividend'] as const

export function Instruments({
  scope,
  instrumentId,
}: {
  scope: string
  instrumentId: string | null
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Row[] | null>(null)
  const [policy, setPolicy] = useState<(typeof policies)[number]>('split_dividend')
  const [asOf, setAsOf] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Fetched data is keyed by its request, so switching instruments/policies
  // derives "loading" instead of resetting state inside effects.
  const [detailState, setDetailState] = useState<{
    id: string
    data: InstrumentDetail
  } | null>(null)
  const [barsState, setBarsState] = useState<{
    key: string
    data: BarsResponse
  } | null>(null)

  const barsKey = instrumentId ? `${instrumentId}|${policy}|${asOf}` : null

  const search = async (event?: { preventDefault(): void }) => {
    event?.preventDefault()

    if (!query.trim()) {
      return
    }

    try {
      setResults(
        await getJson<Row[]>(
          `/api/instruments?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(query.trim())}`,
        ),
      )
      setError(null)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  useEffect(() => {
    if (!instrumentId) {
      return
    }

    let cancelled = false
    getJson<InstrumentDetail>(`/api/instruments/${instrumentId}`)
      .then((data) => {
        if (!cancelled) {
          setDetailState({ id: instrumentId, data })
          setError(null)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message)
      })

    return () => {
      cancelled = true
    }
  }, [instrumentId])

  useEffect(() => {
    if (!instrumentId || !barsKey) {
      return
    }

    let cancelled = false
    const asOfParam = asOf ? `&as_of=${asOf}` : ''
    getJson<BarsResponse>(
      `/api/instruments/${instrumentId}/bars?policy=${policy}${asOfParam}`,
    )
      .then((data) => {
        if (!cancelled) {
          setBarsState({ key: barsKey, data })
          setError(null)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message)
      })

    return () => {
      cancelled = true
    }
  }, [instrumentId, barsKey, policy, asOf])

  const detail =
    instrumentId && detailState?.id === instrumentId ? detailState.data : null
  const bars = barsKey && barsState?.key === barsKey ? barsState.data : null
  const instrument = detail?.instrument

  // Corporate actions as chart markers: splits above the bar, dividends
  // below, at their ex dates.
  const chartEvents = useMemo<ChartEvent[]>(() => {
    if (!detail) {
      return []
    }

    return detail.corporateActions.map((action) =>
      action.action_type === 'split'
        ? {
            date: String(action.ex_date),
            kind: 'split' as const,
            text: `S ${action.split_from}:${action.split_to}`,
          }
        : {
            date: String(action.ex_date),
            kind: 'dividend' as const,
            text: `D ${action.cash_amount}`,
          },
    )
  }, [detail])

  const firstBarFactor = bars?.bars[0]?.cum_price_factor

  return (
    <div>
      <form onSubmit={search}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="symbol or name"
          autoFocus
        />
        <button type="submit">Search {scope}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {results && (
        <DataTable
          rows={results}
          onRowClick={(row) => {
            window.location.hash = `#instruments/${row.instrument_id}`
          }}
        />
      )}

      {instrumentId && !instrument && !error && <p className="muted">loading…</p>}

      {instrument && (
        <div>
          <h2>
            {String(instrument.name)}{' '}
            <span className="muted">
              {String(instrument.instrument_type)} ·{' '}
              {String(instrument.primary_market_scope)} ·{' '}
              {instrument.active ? 'active' : 'delisted'} ·{' '}
              {String(instrument.instrument_id)}
            </span>
          </h2>

          {detail && (
            <p className="muted">
              bars: {String(detail.barsSummary.bars)} (
              {String(detail.barsSummary.first_date)} →{' '}
              {String(detail.barsSummary.last_date)}, tape lines:{' '}
              {String(detail.barsSummary.tape_lines)})
            </p>
          )}

          <form onSubmit={(event) => event.preventDefault()}>
            <label>
              policy{' '}
              <select
                value={policy}
                onChange={(event) =>
                  setPolicy(event.target.value as (typeof policies)[number])
                }
              >
                {policies.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              as of{' '}
              <input
                type="date"
                value={asOf}
                max={detail ? String(detail.barsSummary.last_date) : undefined}
                onChange={(event) => setAsOf(event.target.value)}
              />
            </label>
            {bars && (
              <span className="muted">
                {bars.bars.length} bars · policy {bars.policy}
                {bars.asOf ? ` · as of ${bars.asOf}` : ''}
                {firstBarFactor !== undefined &&
                  ` · first-bar factor ×${Number(firstBarFactor).toFixed(6)}`}
              </span>
            )}
          </form>
          <BarsChart
            bars={bars?.bars ?? []}
            events={chartEvents}
            resetKey={`${instrumentId}|${asOf}`}
          />
          {!bars && <p className="muted">loading bars…</p>}

          {detail && (
            <div>
              <h3>Symbol history</h3>
              <DataTable rows={detail.symbols} />
              <h3>Identifiers</h3>
              <DataTable rows={detail.identifiers} />
              <h3>Corporate actions (latest 200)</h3>
              <DataTable rows={detail.corporateActions} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
