import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { Bar } from '../api.ts'

export type ChartEvent = {
  date: string
  kind: 'split' | 'dividend'
  text: string
}

type ChartHandle = {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  markers: ISeriesMarkersPluginApi<Time>
  fittedFor: string | null
}

// Corporate-action markers snap to the first bar on/after their ex date so
// they always land on the time scale.
function toMarkers(events: ChartEvent[], bars: Bar[]): SeriesMarker<Time>[] {
  if (bars.length === 0) {
    return []
  }

  const dates = bars.map((bar) => bar.date)
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

// The chart instance is created once and data is swapped in place, so the
// visible zoom range survives policy toggles — differences between policies
// show as candles moving, not as a reset chart. The view refits only when
// resetKey (instrument / as-of) changes.
export function BarsChart({
  bars,
  events,
  resetKey,
}: {
  bars: Bar[]
  events: ChartEvent[]
  resetKey: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<ChartHandle | null>(null)

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    const chart = createChart(container, { autoSize: true })
    const series = chart.addSeries(CandlestickSeries)
    handleRef.current = {
      chart,
      series,
      markers: createSeriesMarkers(series, []),
      fittedFor: null,
    }

    return () => {
      handleRef.current = null
      chart.remove()
    }
  }, [])

  useEffect(() => {
    const handle = handleRef.current

    if (!handle) {
      return
    }

    handle.series.setData(
      bars.map((bar) => ({
        time: bar.date as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    )
    handle.markers.setMarkers(toMarkers(events, bars))

    if (bars.length > 0 && handle.fittedFor !== resetKey) {
      handle.chart.timeScale().fitContent()
      handle.fittedFor = resetKey
    }
  }, [bars, events, resetKey])

  return (
    <div>
      {bars.length === 0 && <p className="muted">(no bars)</p>}
      <div ref={containerRef} className="chart" />
    </div>
  )
}
