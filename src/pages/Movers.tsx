import { useEffect, useState } from 'react'
import { getJson, type RankAtResponse } from '../api.ts'
import { formatPercent, formatValue } from '../components/metric-format.ts'

const sortKeys = ['resid_z', 'ret_z', 'ret_z_vadj', 'range_surprise'] as const
type SortKey = (typeof sortKeys)[number]

// Cross-sectional unusual movement at T: every name's surprise against its
// OWN history, ranked across the day. The default sort removes the market
// (residual z) so a high-beta day does not read as a list of high betas.
export function Movers({ scope }: { scope: string }) {
  const [t, setT] = useState('')
  const [sort, setSort] = useState<SortKey>('resid_z')
  const [minAdv, setMinAdv] = useState('1000000')
  const [state, setState] = useState<{
    key: string
    data: RankAtResponse
  } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  )

  // An empty T ranks the scope's latest data date (the server resolves it);
  // the input adopts the resolved date so the page is never blank.
  const key = `${scope}|${t || 'latest'}|${sort}|${minAdv}`

  useEffect(() => {
    let cancelled = false
    const tParam = t ? `t=${t}&` : ''
    getJson<RankAtResponse>(
      `/api/rank-at?${tParam}scope=${scope}&sort=${sort}` +
        `&min_adv=${encodeURIComponent(minAdv || '0')}&limit=100`,
    )
      .then((data) => {
        if (cancelled) return
        setError(null)
        if (!t) {
          // Store under the resolved date's key, then adopt it into the
          // input — the re-render finds the data already present.
          setState({
            key: `${scope}|${data.t}|${sort}|${minAdv}`,
            data,
          })
          setT(data.t)
        } else {
          setState({ key, data })
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError({ key, message: cause.message })
      })

    return () => {
      cancelled = true
    }
  }, [t, key, scope, sort, minAdv])

  const report = state?.key === key ? state.data : null

  return (
    <div>
      <h2>Movers at T</h2>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          T{' '}
          <input
            type="date"
            value={t}
            onChange={(event) => setT(event.target.value)}
          />
        </label>
        <label>
          sort{' '}
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
          >
            {sortKeys.map((keyName) => (
              <option key={keyName} value={keyName}>
                {keyName.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          min $ADV{' '}
          <input
            type="number"
            min="0"
            step="100000"
            value={minAdv}
            onChange={(event) => setMinAdv(event.target.value)}
          />
        </label>
        {report && (
          <span className="muted">
            baseline {report.baseline ?? 'none'} · {report.universe.qualifying}{' '}
            qualifying of {report.universe.traded_at_t} traded ·{' '}
            {report.universe.excluded_liquidity} below floor ·{' '}
            {report.universe.excluded_window} short window
          </span>
        )}
      </form>

      {error?.key === key && <p className="error">{error.message}</p>}
      {!report && error?.key !== key && <p className="muted">ranking…</p>}

      {report && (
        <div>
          <p className="muted">
            day context: median |ret z|{' '}
            {formatValue(report.gauges.median_abs_ret_z)} · share beyond 2σ{' '}
            {formatPercent(report.gauges.share_abs_ret_z_gt2)} — a 3σ name
            means more on a quiet day than on a wild one
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>symbol</th>
                <th>name</th>
                <th>ret 1d</th>
                <th>resid z</th>
                <th>ret z</th>
                <th>z vol-adj</th>
                <th>range surprise</th>
                <th>rvol</th>
                <th>pctile</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr
                  key={row.instrument_id}
                  className="clickable"
                  onClick={() => {
                    window.location.hash = `#instruments/${row.instrument_id}`
                  }}
                >
                  <td className="num">{row.xs_rank}</td>
                  <td>{row.symbol}</td>
                  <td>{row.name}</td>
                  <td className="num">{formatPercent(row.ret_1d)}</td>
                  <td className="num">{formatValue(row.resid_z)}</td>
                  <td className="num">{formatValue(row.ret_z)}</td>
                  <td className="num">{formatValue(row.ret_z_vadj)}</td>
                  <td className="num">{formatValue(row.range_surprise)}</td>
                  <td className="num">{formatValue(row.rvol_21d)}</td>
                  <td className="num">{formatValue(row.ret_pctile_252d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
