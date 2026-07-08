import { openDatabase } from '../server/db.ts'
import { buildAllFacts } from '../server/facts-build.ts'
import { logger } from '../server/log.ts'
import { withRun } from '../server/runs.ts'

const db = await openDatabase()

try {
  const result = await withRun(db.connection, 'build:facts', null, () =>
    buildAllFacts(db.connection),
  )
  logger.info({ result }, 'facts built')
} finally {
  db.closeSync()
}
