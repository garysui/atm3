import { formatTable } from '../core/format.ts'
import { openDatabase, SCHEMA_VERSION } from '../server/db.ts'
import { collectStatus } from '../server/inspect.ts'

// Human-readable overview of what data is in the system. Read-only.
const db = await openDatabase({ readOnly: true })

try {
  const status = await collectStatus(db.connection)
  const section = (title: string, rows: Array<Record<string, unknown>>) => {
    console.log(`\n${title}`)
    console.log(formatTable(rows))
  }

  console.log(`atm3 status — ${db.dbPath} (schema v${SCHEMA_VERSION})`)
  section('RAW — verbatim vendor files (raw.fetches index)', status.raw)
  section('FACTS — instruments by type', status.instruments)
  section('FACTS — symbols', status.symbols)
  section('FACTS — daily bars', status.bars)
  section('FACTS — corporate actions', status.corporateActions)
  section('FACTS — trading days', status.tradingDays)
  section('COMPUTED — cached artifacts', status.computed)
  section('OPS — unresolved (quarantine)', status.unresolved)
  section('OPS — recent runs', status.runs)
} finally {
  db.closeSync()
}
