import { useEffect, useState } from 'react'
import { getJson, type Row } from './api.ts'
import { DataCenter } from './pages/DataCenter.tsx'
import { Instruments } from './pages/Instruments.tsx'

type Route = { page: 'data' | 'instruments'; instrumentId: string | null }

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '')
  const [page, instrumentId] = hash.split('/')

  if (page === 'instruments') {
    return { page: 'instruments', instrumentId: instrumentId || null }
  }

  return { page: 'data', instrumentId: null }
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute)
  const [scopes, setScopes] = useState<string[]>(['us_stocks'])
  const [scope, setScope] = useState('us_stocks')

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    getJson<Row[]>('/api/scopes')
      .then((rows) => {
        const names = rows.map((row) => String(row.scope))

        if (names.length > 0) {
          setScopes(names)

          if (!names.includes(scope)) {
            setScope(names[0])
          }
        }
      })
      .catch(() => {
        // Header still renders with the default scope if the API is down.
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
  }, [])

  return (
    <div>
      <header>
        <h1>atm3</h1>
        <nav>
          <a href="#data" className={route.page === 'data' ? 'active' : undefined}>
            Data Center
          </a>
          <a
            href="#instruments"
            className={route.page === 'instruments' ? 'active' : undefined}
          >
            Instruments
          </a>
        </nav>
        <label className="muted">
          market{' '}
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            {scopes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {route.page === 'data' ? (
        <DataCenter />
      ) : (
        <Instruments scope={scope} instrumentId={route.instrumentId} />
      )}
    </div>
  )
}
