import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { backfillWindow, ingestDividends } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const { from } = backfillWindow()
  const result = await withRun(
    db.connection,
    'ingest:polygon:dividends',
    { from },
    (runId) => ingestDividends(db, { runId, from }),
  )
  logger.info({ result }, 'dividends ingested')
} finally {
  db.closeSync()
}
