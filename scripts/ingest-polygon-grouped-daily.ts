import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { backfillWindow, ingestGroupedDaily } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const { from, to } = backfillWindow()
  const result = await withRun(
    db.connection,
    'ingest:polygon:grouped_daily',
    { from, to },
    async (runId) => {
      const unadjusted = await ingestGroupedDaily(db, {
        runId,
        from,
        to,
        adjusted: false,
      })
      // Vendor-adjusted variant is landed for parity checks only; it never
      // feeds facts.
      const adjusted = await ingestGroupedDaily(db, {
        runId,
        from,
        to,
        adjusted: true,
      })
      return { unadjusted, adjusted }
    },
  )
  logger.info({ result }, 'grouped daily ingested')
} finally {
  db.closeSync()
}
