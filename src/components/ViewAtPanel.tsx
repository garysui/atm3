import type { ViewAtResponse } from '../api.ts'

function formatValue(value: number | string | boolean | null): string {
  if (value === null) return '-'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-'
    if (value === 0) return '0'
    return Math.abs(value) >= 1000 || Math.abs(value) < 0.0001
      ? value.toExponential(5)
      : value.toPrecision(7)
  }
  return value
}

function formatPercent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(3)}%`
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
  const families = new Map<string, ViewAtResponse['metrics']>()
  for (const metric of report?.metrics ?? []) {
    const rows = families.get(metric.family) ?? []
    rows.push(metric)
    families.set(metric.family, rows)
  }

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

      {report && (
        <div className="view-at-metrics">
          {[...families].map(([family, metrics]) => (
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
                  {metrics.map((metric) => (
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
      )}

      {report?.forward && (
        <section className="view-at-forward">
          <h3>What happened next - hindsight</h3>
          <p className="muted">entry: {report.forward.entry_basis}</p>
          <table>
            <thead>
              <tr>
                <th>open days</th>
                <th>date</th>
                <th>return</th>
                <th>MAE</th>
                <th>MFE</th>
                <th>bars</th>
                <th>flags</th>
              </tr>
            </thead>
            <tbody>
              {report.forward.rows.map((row) => (
                <tr key={row.horizon}>
                  <td className="num">{row.horizon}</td>
                  <td>{row.date}</td>
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
      )}
    </section>
  )
}
