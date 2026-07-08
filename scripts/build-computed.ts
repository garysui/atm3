import { buildComputed } from '../server/computed-build.ts'
import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { withRun } from '../server/runs.ts'

// Usage: npm run computed:build [-- --force]
const force = process.argv.includes('--force')
const db = await openDatabase()

try {
  const result = await withRun(db.connection, 'build:computed', { force }, () =>
    buildComputed(db.connection, { force }),
  )
  logger.info({ result }, 'computed layer ready')
} finally {
  db.closeSync()
}
