import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { ingestMarketHolidays } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const result = await withRun(
    db.connection,
    'ingest:polygon:market_holidays',
    null,
    (runId) => ingestMarketHolidays(db, { runId }),
  )
  logger.info({ result }, 'market holidays ingested')
} finally {
  db.closeSync()
}
