import { openDatabase } from '../server/db.ts'
import { ingestMinuteAggs, intradayBackfillWindow } from '../server/flatfiles.ts'
import { logger } from '../server/log.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const { from, to } = intradayBackfillWindow()
  const result = await withRun(
    db.connection,
    'ingest:polygon:minute_aggs',
    { from, to },
    (runId) => ingestMinuteAggs(db, { runId, from, to }),
  )
  logger.info({ result }, 'minute flat files ingested')
} finally {
  db.closeSync()
}
