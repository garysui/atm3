import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { ingestExchanges } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const result = await withRun(
    db.connection,
    'ingest:polygon:exchanges',
    null,
    (runId) => ingestExchanges(db, { runId }),
  )
  logger.info({ result }, 'exchanges ingested')
} finally {
  db.closeSync()
}
