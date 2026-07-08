import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { ingestReferenceTickers } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const result = await withRun(
    db.connection,
    'ingest:polygon:reference_tickers',
    null,
    (runId) => ingestReferenceTickers(db, { runId }),
  )
  logger.info({ result }, 'reference tickers ingested')
} finally {
  db.closeSync()
}
