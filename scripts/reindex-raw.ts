import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { reindexRawZone } from '../server/raw-zone.ts'

const db = await openDatabase()

try {
  const manifests = await reindexRawZone(db.connection)
  const countResult = await db.connection.runAndReadAll(
    'select count(*) as fetch_rows from raw.fetches',
  )
  logger.info(
    {
      manifests,
      fetchRows: Number(countResult.getRowObjectsJson()[0]?.fetch_rows),
    },
    'raw zone reindexed from manifests',
  )
} finally {
  db.closeSync()
}
