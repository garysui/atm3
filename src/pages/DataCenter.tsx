import { useEffect, useState } from 'react'
import { getJson, type StatusReport } from '../api.ts'
import { DataTable } from '../components/DataTable.tsx'

export function DataCenter() {
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    getJson<StatusReport>('/api/status')
      .then((report) => {
        if (!cancelled) setStatus(report)
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message)
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return <p className="error">{error}</p>
  }

  if (!status) {
    return <p className="muted">loading…</p>
  }

  return (
    <div>
      <h2>RAW — verbatim vendor files</h2>
      <DataTable rows={status.raw} />
      <h2>FACTS — instruments by type</h2>
      <DataTable rows={status.instruments} />
      <h2>FACTS — symbols</h2>
      <DataTable rows={status.symbols} />
      <h2>FACTS — daily bars</h2>
      <DataTable rows={status.bars} />
      <h2>FACTS — corporate actions</h2>
      <DataTable rows={status.corporateActions} />
      <h2>FACTS — trading days</h2>
      <DataTable rows={status.tradingDays} />
      <h2>COMPUTED — algorithms (views/macros over facts)</h2>
      <DataTable rows={status.computedAlgorithms} />
      <h2>COMPUTED — cache snapshots (droppable)</h2>
      <DataTable rows={status.computed} />
      <h2>OPS — unresolved (quarantine)</h2>
      <DataTable rows={status.unresolved} />
      <h2>OPS — recent runs</h2>
      <DataTable rows={status.runs} />
    </div>
  )
}
