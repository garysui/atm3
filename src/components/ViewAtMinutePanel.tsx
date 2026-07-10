import type { ViewAtMinuteResponse } from '../api.ts'
import {
  HindsightTable,
  MetricFamilyTables,
} from './ViewAtPanel.tsx'

// The intraday view at minute T: session metrics from complete RTH bars
// strictly before T, the full daily catalog as of the previous close, and
// an optional hindsight block from a next-minute-open entry.
export function ViewAtMinutePanel({
  date,
  minute,
  report,
  loading,
  error,
  includeForward,
  onMinuteChange,
  onForwardChange,
}: {
  date: string
  minute: string
  report: ViewAtMinuteResponse | null
  loading: boolean
  error: string | null
  includeForward: boolean
  onMinuteChange(minute: string): void
  onForwardChange(enabled: boolean): void
}) {
  return (
    <section className="view-at">
      <h3>View at T (intraday)</h3>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          T{' '}
          <input
            type="time"
            value={minute}
            min="09:31"
            max="16:01"
            onChange={(event) => onMinuteChange(event.target.value)}
          />
        </label>
        <span className="muted">
          {date} · ET · click a minute bar to set T just after it
        </span>
        <label>
          <input
            type="checkbox"
            checked={includeForward}
            onChange={(event) => onForwardChange(event.target.checked)}
          />{' '}
          hindsight
        </label>
      </form>

      {!minute && <p className="muted">select T</p>}
      {loading && <p className="muted">loading view…</p>}
      {error && <p className="error">{error}</p>}

      {report && (
        <div>
          <p className="muted">
            {report.visible_bars} complete bar(s) before {report.t.minute} ·
            pace history {report.prior_sessions} session(s)
            {report.prev_close_date
              ? ` · prev close ${report.prev_close_date}`
              : ''}
          </p>
          <MetricFamilyTables metrics={report.metrics} />
          {report.daily && (
            <details className="view-at-daily" open={false}>
              <summary>
                daily view as of {report.daily.t} (fully knowable at T)
              </summary>
              <MetricFamilyTables metrics={report.daily.metrics} />
            </details>
          )}
          {report.forward && (
            <HindsightTable horizonLabel="horizon" forward={report.forward} />
          )}
        </div>
      )}
    </section>
  )
}
