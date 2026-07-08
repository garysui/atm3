import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { backfillWindow, ingestSplits } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const { from } = backfillWindow()
  const result = await withRun(
    db.connection,
    'ingest:polygon:splits',
    { from },
    (runId) => ingestSplits(db, { runId, from }),
  )
  logger.info({ result }, 'splits ingested')
} finally {
  db.closeSync()
}
