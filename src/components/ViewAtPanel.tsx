import type { ViewAtResponse } from '../api.ts'
import { formatPercent, formatValue } from './metric-format.ts'

// One table per metric family — shared by the daily and the minute panels.
export function MetricFamilyTables({
  metrics,
}: {
  metrics: ViewAtResponse['metrics']
}) {
  const families = new Map<string, ViewAtResponse['metrics']>()
  for (const metric of metrics) {
    const rows = families.get(metric.family) ?? []
    rows.push(metric)
    families.set(metric.family, rows)
  }

  return (
    <div className="view-at-metrics">
      {[...families].map(([family, rows]) => (
        <section key={family} className="metric-family">
          <h3>{family}</h3>
          <table>
            <thead>
              <tr>
                <th>metric</th>
                <th>value</th>
                <th>bars</th>
                <th>unit</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((metric) => (
                <tr key={metric.id}>
                  <td>{metric.id}</td>
                  <td className="num">{formatValue(metric.value)}</td>
                  <td className="num">{metric.bars_available}</td>
                  <td>{metric.unit}</td>
                  <td>{metric.reason?.replaceAll('_', ' ') ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}

export function HindsightTable({
  horizonLabel,
  forward,
}: {
  horizonLabel: string
  forward: {
    entry_basis: string
    rows: Array<{
      horizon: number | string
      date: string | null
      ret: number | null
      mae: number | null
      mfe: number | null
      delisted: boolean
      stale: boolean
      bars_used: number
      reason?: string
    }>
  }
}) {
  return (
    <section className="view-at-forward">
      <h3>What happened next - hindsight</h3>
      <p className="muted">entry: {forward.entry_basis.replaceAll('_', ' ')}</p>
      <table>
        <thead>
          <tr>
            <th>{horizonLabel}</th>
            <th>date</th>
            <th>return</th>
            <th>MAE</th>
            <th>MFE</th>
            <th>bars</th>
            <th>flags</th>
          </tr>
        </thead>
        <tbody>
          {forward.rows.map((row) => (
            <tr key={row.horizon}>
              <td className="num">
                {String(row.horizon).replaceAll('_', ' ')}
              </td>
              <td>{row.date ?? '-'}</td>
              <td className="num">{formatPercent(row.ret)}</td>
              <td className="num">{formatPercent(row.mae)}</td>
              <td className="num">{formatPercent(row.mfe)}</td>
              <td className="num">{row.bars_used}</td>
              <td>
                {[
                  row.delisted && 'delisted',
                  row.stale && 'stale',
                  row.reason?.replaceAll('_', ' '),
                ].filter(Boolean).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function ViewAtPanel({
  t,
  dates,
  report,
  loading,
  error,
  includeForward,
  entryBasis,
  onTChange,
  onForwardChange,
  onEntryBasisChange,
}: {
  t: string
  dates: string[]
  report: ViewAtResponse | null
  loading: boolean
  error: string | null
  includeForward: boolean
  entryBasis: 'next_open' | 't_close'
  onTChange(t: string): void
  onForwardChange(enabled: boolean): void
  onEntryBasisChange(entry: 'next_open' | 't_close'): void
}) {
  return (
    <section className="view-at">
      <h3>View at T</h3>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          T{' '}
          <input
            type="date"
            list="view-at-bar-dates"
            value={t}
            min={dates[0]}
            max={dates.at(-1)}
            onChange={(event) => onTChange(event.target.value)}
          />
          <datalist id="view-at-bar-dates">
            {dates.map((date) => <option key={date} value={date} />)}
          </datalist>
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeForward}
            onChange={(event) => onForwardChange(event.target.checked)}
          />{' '}
          hindsight
        </label>
        {includeForward && (
          <label>
            entry{' '}
            <select
              value={entryBasis}
              onChange={(event) =>
                onEntryBasisChange(
                  event.target.value as 'next_open' | 't_close',
                )
              }
            >
              <option value="next_open">next open</option>
              <option value="t_close">T close</option>
            </select>
          </label>
        )}
        {report?.context_baselines && (
          <span className="muted">
            SPY · tracking {report.context_baselines.tracking ?? '-'}
          </span>
        )}
      </form>

      {!t && <p className="muted">select T</p>}
      {loading && <p className="muted">loading view…</p>}
      {error && <p className="error">{error}</p>}

      {report && <MetricFamilyTables metrics={report.metrics} />}
      {report?.forward && (
        <HindsightTable horizonLabel="open days" forward={report.forward} />
      )}
    </section>
  )
}
