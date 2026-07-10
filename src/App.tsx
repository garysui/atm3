import { useEffect, useState } from 'react'
import { getJson, type Row } from './api.ts'
import { DataCenter } from './pages/DataCenter.tsx'
import { Docs } from './pages/Docs.tsx'
import { Instruments } from './pages/Instruments.tsx'
import { Movers } from './pages/Movers.tsx'
import { Pipeline } from './pages/Pipeline.tsx'

type Route = {
  page: 'data' | 'instruments' | 'movers' | 'docs' | 'pipeline'
  instrumentId: string | null
  docName: string | null
}

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '')
  const [page, detail] = hash.split('/')

  if (page === 'instruments') {
    return { page: 'instruments', instrumentId: detail || null, docName: null }
  }

  if (page === 'docs') {
    return { page: 'docs', instrumentId: null, docName: detail || null }
  }

  if (page === 'movers') {
    return { page: 'movers', instrumentId: null, docName: null }
  }

  if (page === 'pipeline') {
    return { page: 'pipeline', instrumentId: null, docName: null }
  }

  return { page: 'data', instrumentId: null, docName: null }
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
          <a
            href="#movers"
            className={route.page === 'movers' ? 'active' : undefined}
          >
            Movers
          </a>
          <a
            href="#pipeline"
            className={route.page === 'pipeline' ? 'active' : undefined}
          >
            Pipeline
          </a>
          <a href="#docs" className={route.page === 'docs' ? 'active' : undefined}>
            Docs
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
      {route.page === 'data' && <DataCenter />}
      {route.page === 'instruments' && (
        <Instruments scope={scope} instrumentId={route.instrumentId} />
      )}
      {route.page === 'movers' && <Movers scope={scope} />}
      {route.page === 'docs' && <Docs docName={route.docName} />}
      {route.page === 'pipeline' && <Pipeline />}
    </div>
  )
}
