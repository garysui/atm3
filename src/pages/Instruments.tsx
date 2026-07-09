import { useEffect, useMemo, useState } from 'react'
import {
  getJson,
  type BarsResponse,
  type InstrumentDetail,
  type MinuteBarsResponse,
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
  // Picking an instrument collapses the result list to one line so the
  // detail starts right under the search box.
  const [resultsOpen, setResultsOpen] = useState(true)
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
  const [minuteDaysState, setMinuteDaysState] = useState<{
    id: string
    days: Row[]
  } | null>(null)
  const [minuteDaySelection, setMinuteDaySelection] = useState<{
    id: string
    date: string
  } | null>(null)
  const [minuteBarsState, setMinuteBarsState] = useState<{
    key: string
    data: MinuteBarsResponse
  } | null>(null)

  const barsKey = instrumentId ? `${instrumentId}|${policy}|${asOf}` : null
  const minuteDay =
    minuteDaySelection?.id === instrumentId ? minuteDaySelection.date : null
  const minuteBarsKey =
    instrumentId && minuteDay
      ? `${instrumentId}|${minuteDay}|${policy}|${asOf}`
      : null

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
      setResultsOpen(true)
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

  useEffect(() => {
    if (!instrumentId) {
      return
    }

    let cancelled = false
    getJson<{ days: Row[] }>(`/api/instruments/${instrumentId}/minute-days`)
      .then((data) => {
        if (!cancelled) {
          setMinuteDaysState({ id: instrumentId, days: data.days })
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
    if (!instrumentId || !minuteDay || !minuteBarsKey) {
      return
    }

    let cancelled = false
    const asOfParam = asOf ? `&as_of=${asOf}` : ''
    getJson<MinuteBarsResponse>(
      `/api/instruments/${instrumentId}/minute-bars?date=${minuteDay}&policy=${policy}${asOfParam}`,
    )
      .then((data) => {
        if (!cancelled) {
          setMinuteBarsState({ key: minuteBarsKey, data })
          setError(null)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message)
      })

    return () => {
      cancelled = true
    }
  }, [instrumentId, minuteDay, minuteBarsKey, policy, asOf])

  const detail =
    instrumentId && detailState?.id === instrumentId ? detailState.data : null
  const bars = barsKey && barsState?.key === barsKey ? barsState.data : null
  const minuteDays =
    instrumentId && minuteDaysState?.id === instrumentId
      ? minuteDaysState.days
      : null
  const minuteBars =
    minuteBarsKey && minuteBarsState?.key === minuteBarsKey
      ? minuteBarsState.data
      : null
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
      {results &&
        (resultsOpen ? (
          <DataTable
            rows={results}
            onRowClick={(row) => {
              window.location.hash = `#instruments/${row.instrument_id}`
              setResultsOpen(false)
            }}
          />
        ) : (
          <p className="muted">
            <button onClick={() => setResultsOpen(true)}>
              show {results.length} search result(s)
            </button>
          </p>
        ))}

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

          <h3>Intraday (minute bars)</h3>
          {!minuteDays && <p className="muted">loading…</p>}
          {minuteDays && minuteDays.length === 0 && (
            <p className="muted">
              no minute data for this instrument in the ingested window yet
            </p>
          )}
          {minuteDays && minuteDays.length > 0 && (
            <div>
              <p className="muted">
                {minuteDays.length} day(s) ·{' '}
                {String(minuteDays[minuteDays.length - 1]?.date)} →{' '}
                {String(minuteDays[0]?.date)} · click a day to chart its
                minutes
              </p>
              <DataTable
                rows={minuteDays}
                onRowClick={(row) =>
                  setMinuteDaySelection({
                    id: instrumentId as string,
                    date: String(row.date),
                  })
                }
              />
              {minuteDay && (
                <div>
                  <p className="muted">
                    {minuteDay} · policy {policy}
                    {minuteBars
                      ? ` · ${minuteBars.bars.length} minute bars` +
                        (minuteBars.bars[0]
                          ? ` · factor ×${Number(minuteBars.bars[0].cum_price_factor).toFixed(6)}`
                          : '')
                      : ' · loading…'}
                  </p>
                  <BarsChart
                    bars={(minuteBars?.bars ?? []).map((bar) => ({
                      date: Number(bar.time),
                      open: Number(bar.open),
                      high: Number(bar.high),
                      low: Number(bar.low),
                      close: Number(bar.close),
                    }))}
                    events={[]}
                    resetKey={`${instrumentId}|${minuteDay}|${asOf}`}
                  />
                </div>
              )}
            </div>
          )}

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
