import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import { useEffect, useMemo, useRef, useState } from 'react'

// One comprehensive chart for daily and intraday inspection: price candles +
// a volume pane (policy-adjusted volume, up/down colored), a crosshair OHLCV
// legend, exchange-local (ET) time labels, log scale, and mode-specific
// overlays — SMA + range buttons + corporate-action/rename markers for
// daily; regular-hours filter + session VWAP for intraday. Data swaps in
// place so the visible zoom survives policy toggles; the view refits only
// when resetKey changes.

export type ChartBar = {
  // 'YYYY-MM-DD' for daily bars, epoch seconds (UTC) for minute bars.
  date: string | number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export type ChartEvent = {
  date: string
  kind: 'split' | 'dividend' | 'rename'
  text: string
}

const upColor = 'rgba(38, 166, 154, 0.55)'
const downColor = 'rgba(239, 83, 80, 0.55)'
const smaPeriods = [20, 50, 200] as const
const smaColors: Record<number, string> = {
  20: '#e08a00',
  50: '#0a66c2',
  200: '#7a3fbf',
}

const etClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const etDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const etDayShort = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
})

function minuteOfDayEt(epochSeconds: number): number {
  const [hour, minute] = etClock
    .format(new Date(epochSeconds * 1000))
    .split(':')
    .map(Number)
  return hour * 60 + minute
}

// Display rule (AGENTS.md): timestamps render in exchange-local time.
function formatBarTime(date: string | number): string {
  if (typeof date === 'string') {
    return date
  }

  const at = new Date(date * 1000)
  return `${etDay.format(at)} ${etClock.format(at)} ET`
}

function formatVolume(volume: number | null): string {
  if (volume === null || !Number.isFinite(volume)) {
    return '–'
  }

  if (volume >= 1e9) return `${(volume / 1e9).toFixed(2)}B`
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(2)}M`
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K`
  return String(Math.round(volume))
}

function sma(bars: ChartBar[], period: number): LineData<Time>[] {
  const points: LineData<Time>[] = []
  let sum = 0

  for (let index = 0; index < bars.length; index++) {
    sum += bars[index].close

    if (index >= period) {
      sum -= bars[index - period].close
    }

    if (index >= period - 1) {
      points.push({ time: bars[index].date as Time, value: sum / period })
    }
  }

  return points
}

// Session VWAP from typical price, cumulative within each ET day.
function vwap(bars: ChartBar[]): LineData<Time>[] {
  const points: LineData<Time>[] = []
  let day = ''
  let cumPv = 0
  let cumV = 0

  for (const bar of bars) {
    const barDay =
      typeof bar.date === 'number'
        ? etDay.format(new Date(bar.date * 1000))
        : bar.date

    if (barDay !== day) {
      day = barDay
      cumPv = 0
      cumV = 0
    }

    const volume = bar.volume ?? 0
    cumPv += ((bar.high + bar.low + bar.close) / 3) * volume
    cumV += volume

    if (cumV > 0) {
      points.push({ time: bar.date as Time, value: cumPv / cumV })
    }
  }

  return points
}

function toMarkers(events: ChartEvent[], bars: ChartBar[]): SeriesMarker<Time>[] {
  // Event dates are day-grained — meaningful on daily (string-dated) charts.
  if (bars.length === 0 || typeof bars[0].date !== 'string') {
    return []
  }

  const dates = bars.map((bar) => String(bar.date))
  const last = dates[dates.length - 1]
  const markers: SeriesMarker<Time>[] = []

  for (const event of events) {
    if (event.date < dates[0] || event.date > last) {
      continue
    }

    const barDate = dates.find((date) => date >= event.date)

    if (!barDate) {
      continue
    }

    if (event.kind === 'split') {
      markers.push({
        time: barDate as Time,
        position: 'aboveBar',
        color: '#f23645',
        shape: 'arrowDown',
        text: event.text,
        size: 1.4,
      })
    } else if (event.kind === 'rename') {
      markers.push({
        time: barDate as Time,
        position: 'aboveBar',
        color: '#555555',
        shape: 'square',
        text: event.text,
        size: 1,
      })
    } else {
      markers.push({
        time: barDate as Time,
        position: 'belowBar',
        color: '#2962ff',
        shape: 'circle',
        text: event.text,
        size: 0.9,
      })
    }
  }

  return markers.sort((a, b) => String(a.time).localeCompare(String(b.time)))
}

type ChartHandle = {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  volume: ISeriesApi<'Histogram'>
  markers: ISeriesMarkersPluginApi<Time>
  overlays: Map<string, ISeriesApi<'Line'>>
  fittedFor: string | null
}

function legendFor(bars: ChartBar[], index: number): string {
  const bar = bars[index]

  if (!bar) {
    return ''
  }

  const previous = bars[index - 1]
  const change = previous
    ? ` ${bar.close >= previous.close ? '+' : ''}${(((bar.close - previous.close) / previous.close) * 100).toFixed(2)}%`
    : ''
  const price = (value: number) =>
    value >= 1000 ? value.toFixed(2) : value.toPrecision(5)

  return (
    `${formatBarTime(bar.date)} · O ${price(bar.open)} H ${price(bar.high)} ` +
    `L ${price(bar.low)} C ${price(bar.close)}${change} · V ${formatVolume(bar.volume)}`
  )
}

export function StockChart({
  mode,
  bars,
  events,
  resetKey,
}: {
  mode: 'daily' | 'intraday'
  bars: ChartBar[]
  events: ChartEvent[]
  resetKey: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  const shownRef = useRef<ChartBar[]>([])
  const [legend, setLegend] = useState('')
  const [logScale, setLogScale] = useState(false)
  const [rthOnly, setRthOnly] = useState(true)
  const [showVwap, setShowVwap] = useState(true)
  const [smaOn, setSmaOn] = useState<number[]>([])

  // Regular trading hours: 09:30 through the 16:00 auction minute inclusive
  // (the official close prints there).
  const shown = useMemo(() => {
    if (mode !== 'intraday' || !rthOnly) {
      return bars
    }

    return bars.filter((bar) => {
      const minute = minuteOfDayEt(Number(bar.date))
      return minute >= 570 && minute <= 960
    })
  }, [mode, bars, rthOnly])

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    // mode is fixed per mount site (daily chart vs intraday chart).
    const intraday = mode === 'intraday'
    const chart = createChart(container, {
      autoSize: true,
      timeScale: {
        timeVisible: intraday,
        secondsVisible: false,
        tickMarkFormatter: intraday
          ? (time: Time, tickMarkType: TickMarkType) => {
              const at = new Date(Number(time) * 1000)
              return tickMarkType >= TickMarkType.Time
                ? etClock.format(at)
                : etDayShort.format(at)
            }
          : undefined,
      },
      localization: {
        timeFormatter: intraday
          ? (time: Time) => formatBarTime(Number(time))
          : undefined,
      },
    })
    const candles = chart.addSeries(CandlestickSeries, {}, 0)
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      },
      1,
    )
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.2, bottom: 0 },
    })
    const panes = chart.panes()
    panes[0]?.setStretchFactor(3)
    panes[1]?.setStretchFactor(1)

    handleRef.current = {
      chart,
      candles,
      volume,
      markers: createSeriesMarkers(candles, []),
      overlays: new Map(),
      fittedFor: null,
    }

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const current = shownRef.current

      if (param.time === undefined) {
        setLegend(legendFor(current, current.length - 1))
        return
      }

      const index = current.findIndex((bar) =>
        typeof bar.date === 'number'
          ? bar.date === Number(param.time)
          : bar.date === param.time,
      )

      if (index >= 0) {
        setLegend(legendFor(current, index))
      }
    }

    chart.subscribeCrosshairMove(onCrosshair)

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair)
      handleRef.current = null
      chart.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Data swaps in place; overlays follow their toggles.
  useEffect(() => {
    const handle = handleRef.current

    if (!handle) {
      return
    }

    shownRef.current = shown
    handle.candles.setData(
      shown.map((bar) => ({
        time: bar.date as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    )
    handle.volume.setData(
      shown.map((bar) => ({
        time: bar.date as Time,
        value: bar.volume ?? 0,
        color: bar.close >= bar.open ? upColor : downColor,
      })),
    )
    handle.markers.setMarkers(toMarkers(events, shown))

    const wanted = new Map<string, LineData<Time>[]>()

    if (mode === 'daily') {
      for (const period of smaOn) {
        wanted.set(`sma${period}`, sma(shown, period))
      }
    } else if (showVwap) {
      wanted.set('vwap', vwap(shown))
    }

    for (const [key, series] of handle.overlays) {
      if (!wanted.has(key)) {
        series.setData([])
      }
    }

    for (const [key, points] of wanted) {
      let series = handle.overlays.get(key)

      if (!series) {
        const color =
          key === 'vwap' ? '#e08a00' : smaColors[Number(key.replace('sma', ''))]
        series = handle.chart.addSeries(
          LineSeries,
          {
            color,
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          },
          0,
        )
        handle.overlays.set(key, series)
      }

      series.setData(points)
    }

    setLegend(legendFor(shown, shown.length - 1))

    const fitKey = `${resetKey}|${rthOnly}`

    if (shown.length > 0 && handle.fittedFor !== fitKey) {
      handle.chart.timeScale().fitContent()
      handle.fittedFor = fitKey
    }
  }, [shown, events, resetKey, mode, smaOn, showVwap, rthOnly])

  useEffect(() => {
    handleRef.current?.candles.priceScale().applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    })
  }, [logScale])

  const setRange = (months: number | null) => {
    const handle = handleRef.current
    const last = shown[shown.length - 1]

    if (!handle || !last || typeof last.date !== 'string') {
      return
    }

    if (months === null) {
      handle.chart.timeScale().fitContent()
      return
    }

    const to = new Date(`${last.date}T00:00:00Z`)
    const from = new Date(to)
    from.setUTCMonth(from.getUTCMonth() - months)
    handle.chart.timeScale().setVisibleRange({
      from: from.toISOString().slice(0, 10) as Time,
      to: last.date as Time,
    })
  }

  return (
    <div>
      <div className="chart-toolbar muted">
        <label>
          <input
            type="checkbox"
            checked={logScale}
            onChange={(event) => setLogScale(event.target.checked)}
          />{' '}
          log
        </label>
        {mode === 'daily' && (
          <>
            {smaPeriods.map((period) => (
              <label key={period}>
                <input
                  type="checkbox"
                  checked={smaOn.includes(period)}
                  onChange={(event) =>
                    setSmaOn((current) =>
                      event.target.checked
                        ? [...current, period].sort((a, b) => a - b)
                        : current.filter((value) => value !== period),
                    )
                  }
                />{' '}
                <span style={{ color: smaColors[period] }}>SMA {period}</span>
              </label>
            ))}
            <span>
              range: <button onClick={() => setRange(3)}>3M</button>{' '}
              <button onClick={() => setRange(12)}>1Y</button>{' '}
              <button onClick={() => setRange(null)}>All</button>
            </span>
          </>
        )}
        {mode === 'intraday' && (
          <>
            <label>
              <input
                type="checkbox"
                checked={rthOnly}
                onChange={(event) => setRthOnly(event.target.checked)}
              />{' '}
              regular hours only
            </label>
            <label>
              <input
                type="checkbox"
                checked={showVwap}
                onChange={(event) => setShowVwap(event.target.checked)}
              />{' '}
              <span style={{ color: '#e08a00' }}>VWAP</span>
            </label>
          </>
        )}
      </div>
      <div className="chart-wrap">
        <div className="chart-legend">{legend}</div>
        {shown.length === 0 && <p className="muted">(no bars)</p>}
        <div ref={containerRef} className="chart chart-tall" />
      </div>
    </div>
  )
}
