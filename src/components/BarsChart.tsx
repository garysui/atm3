import { CandlestickSeries, createChart } from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { Bar } from '../api.ts'

export function BarsChart({ bars }: { bars: Bar[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current

    if (!container || bars.length === 0) {
      return
    }

    const chart = createChart(container, { autoSize: true })
    const series = chart.addSeries(CandlestickSeries)
    series.setData(
      bars.map((bar) => ({
        time: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    )
    chart.timeScale().fitContent()

    return () => chart.remove()
  }, [bars])

  if (bars.length === 0) {
    return <p className="muted">(no bars)</p>
  }

  return <div ref={containerRef} className="chart" />
}
