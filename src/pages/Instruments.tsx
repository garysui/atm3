import { useEffect, useMemo, useState } from 'react'
import {
  getJson,
  type BarsResponse,
  type InstrumentDetail,
  type MinuteBarsResponse,
  type Row,
  type ViewAtMinuteResponse,
  type ViewAtResponse,
} from '../api.ts'
import {
  StockChart,
  type ChartBar,
  type ChartEvent,
} from '../components/StockChart.tsx'
import { DataTable } from '../components/DataTable.tsx'
import { ViewAtPanel } from '../components/ViewAtPanel.tsx'
import { ViewAtMinutePanel } from '../components/ViewAtMinutePanel.tsx'

const policies = ['none', 'split', 'split_dividend'] as const

// Clicking a minute bar places T just AFTER that bar completes: the bar the
// user clicked is the last visible one, matching "stand at 10:31 having seen
// the 10:30 minute".
const etDateOfEpoch = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const etMinuteOfEpoch = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

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
  const [viewAtSelection, setViewAtSelection] = useState<{
    id: string
    date: string
  } | null>(null)
  const [includeForward, setIncludeForward] = useState(false)
  const [entryBasis, setEntryBasis] = useState<'next_open' | 't_close'>(
    'next_open',
  )
  const [viewAtState, setViewAtState] = useState<{
    key: string
    data: ViewAtResponse
  } | null>(null)
  const [viewAtError, setViewAtError] = useState<{
    key: string
    message: string
  } | null>(null)
  const [minuteViewAt, setMinuteViewAt] = useState<{
    id: string
    date: string
    minute: string
    markerTime: number | null
  } | null>(null)
  const [includeMinuteForward, setIncludeMinuteForward] = useState(false)
  const [minuteViewAtState, setMinuteViewAtState] = useState<{
    key: string
    data: ViewAtMinuteResponse
  } | null>(null)
  const [minuteViewAtError, setMinuteViewAtError] = useState<{
    key: string
    message: string
  } | null>(null)

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
  const viewAtDate =
    viewAtSelection?.id === instrumentId ? viewAtSelection.date : ''
  const viewAtKey = instrumentId && viewAtDate
    ? `${instrumentId}|${viewAtDate}|${includeForward}|${entryBasis}`
    : null
  // The minute-T selection is tied to the charted session day.
  const minuteT =
    minuteViewAt &&
    minuteViewAt.id === instrumentId &&
    minuteViewAt.date === minuteDay
      ? minuteViewAt
      : null
  const minuteViewAtKey =
    instrumentId && minuteDay && minuteT
      ? `${instrumentId}|${minuteDay}|${minuteT.minute}|${includeMinuteForward}`
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

  useEffect(() => {
    if (!instrumentId || !viewAtDate || !viewAtKey) return

    let cancelled = false
    const forward = includeForward
      ? `&forward=1&entry=${entryBasis}`
      : ''
    getJson<ViewAtResponse>(
      `/api/instruments/${instrumentId}/view-at?t=${viewAtDate}${forward}`,
    )
      .then((data) => {
        if (!cancelled) {
          setViewAtState({ key: viewAtKey, data })
          setViewAtError(null)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) {
          setViewAtError({ key: viewAtKey, message: cause.message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    instrumentId,
    viewAtDate,
    viewAtKey,
    includeForward,
    entryBasis,
  ])

  useEffect(() => {
    if (!instrumentId || !minuteDay || !minuteT || !minuteViewAtKey) return

    let cancelled = false
    const forward = includeMinuteForward ? '&forward=1' : ''
    getJson<ViewAtMinuteResponse>(
      `/api/instruments/${instrumentId}/view-at-minute?date=${minuteDay}` +
        `&minute=${encodeURIComponent(minuteT.minute)}${forward}`,
    )
      .then((data) => {
        if (!cancelled) {
          setMinuteViewAtState({ key: minuteViewAtKey, data })
          setMinuteViewAtError(null)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) {
          setMinuteViewAtError({ key: minuteViewAtKey, message: cause.message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    instrumentId,
    minuteDay,
    minuteT,
    minuteViewAtKey,
    includeMinuteForward,
  ])

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

    return detail.corporateActions.flatMap((action): ChartEvent[] => {
      if (action.action_type === 'split') {
        return [{
          date: String(action.ex_date),
          kind: 'split',
          text: `S ${action.split_from}:${action.split_to}`,
        }]
      }
      if (action.action_type === 'stock_dividend') {
        const ratio =
          Number(action.bonus_ratio ?? 0) +
          Number(action.conversion_ratio ?? 0)
        return [{
          date: String(action.ex_date),
          kind: 'stockDividend',
          text: `SD +${ratio}`,
        }]
      }
      if (action.action_type === 'cash_dividend') {
        return [{
          date: String(action.ex_date),
          kind: 'dividend',
          text: `D ${String(action.currency ?? '')} ${action.cash_amount}`.trim(),
        }]
      }
      return []
    })
  }, [detail])

  const firstBarFactor = bars?.bars[0]?.cum_price_factor

  const dailyChartBars = useMemo<ChartBar[]>(
    () =>
      (bars?.bars ?? []).map((bar) => ({
        date: String(bar.date),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: bar.volume === null ? null : Number(bar.volume),
      })),
    [bars],
  )

  // Ticker changes drawn on the chart: the identity model made the series
  // continuous, the marker shows where the label changed (SATS → ECHO).
  const renameEvents = useMemo<ChartEvent[]>(() => {
    const rows = bars?.bars ?? []
    const out: ChartEvent[] = []

    for (let index = 1; index < rows.length; index++) {
      if (rows[index].symbol_as_traded !== rows[index - 1].symbol_as_traded) {
        out.push({
          date: String(rows[index].date),
          kind: 'rename',
          text: `→${String(rows[index].symbol_as_traded)}`,
        })
      }
    }

    return out
  }, [bars])

  const minuteChartBars = useMemo<ChartBar[]>(
    () =>
      (minuteBars?.bars ?? []).map((bar) => ({
        date: Number(bar.time),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: bar.volume === null ? null : Number(bar.volume),
      })),
    [minuteBars],
  )

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
          <StockChart
            mode="daily"
            bars={dailyChartBars}
            events={[...chartEvents, ...renameEvents]}
            resetKey={`${instrumentId}|${asOf}`}
            selectedDate={viewAtDate}
            onDateSelect={(date) =>
              setViewAtSelection({
                id: String(instrument.instrument_id),
                date,
              })
            }
          />
          {!bars && <p className="muted">loading bars…</p>}

          <ViewAtPanel
            t={viewAtDate}
            dates={dailyChartBars.map((bar) => String(bar.date))}
            report={
              viewAtKey && viewAtState?.key === viewAtKey
                ? viewAtState.data
                : null
            }
            loading={Boolean(
              viewAtKey &&
              viewAtState?.key !== viewAtKey &&
              viewAtError?.key !== viewAtKey,
            )}
            error={
              viewAtKey && viewAtError?.key === viewAtKey
                ? viewAtError.message
                : null
            }
            includeForward={includeForward}
            entryBasis={entryBasis}
            onTChange={(date) =>
              setViewAtSelection({
                id: String(instrument.instrument_id),
                date,
              })
            }
            onForwardChange={setIncludeForward}
            onEntryBasisChange={setEntryBasis}
          />

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
                  <StockChart
                    mode="intraday"
                    bars={minuteChartBars}
                    events={[]}
                    resetKey={`${instrumentId}|${minuteDay}|${asOf}`}
                    selectedTime={minuteT?.markerTime ?? null}
                    onMinuteSelect={(time) =>
                      setMinuteViewAt({
                        id: String(instrument.instrument_id),
                        date: etDateOfEpoch.format(new Date(time * 1000)),
                        minute: etMinuteOfEpoch.format(
                          new Date((time + 60) * 1000),
                        ),
                        markerTime: time,
                      })
                    }
                  />
                  <ViewAtMinutePanel
                    date={minuteDay}
                    minute={minuteT?.minute ?? ''}
                    report={
                      minuteViewAtKey &&
                      minuteViewAtState?.key === minuteViewAtKey
                        ? minuteViewAtState.data
                        : null
                    }
                    loading={Boolean(
                      minuteViewAtKey &&
                      minuteViewAtState?.key !== minuteViewAtKey &&
                      minuteViewAtError?.key !== minuteViewAtKey,
                    )}
                    error={
                      minuteViewAtKey &&
                      minuteViewAtError?.key === minuteViewAtKey
                        ? minuteViewAtError.message
                        : null
                    }
                    includeForward={includeMinuteForward}
                    onMinuteChange={(minute) =>
                      setMinuteViewAt({
                        id: String(instrument.instrument_id),
                        date: minuteDay,
                        minute,
                        markerTime: null,
                      })
                    }
                    onForwardChange={setIncludeMinuteForward}
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
