import { openDatabase } from '../server/db.ts'
import { buildMinuteParquet } from '../server/facts-minute.ts'
import { logger } from '../server/log.ts'
import { withRun } from '../server/runs.ts'

// Usage: npm run facts:minute [-- --force]
const force = process.argv.includes('--force')
const db = await openDatabase()

try {
  const result = await withRun(db.connection, 'build:facts:minute', { force }, () =>
    buildMinuteParquet(db.connection, { force }),
  )
  logger.info({ result }, 'minute facts ready')
} finally {
  db.closeSync()
}
