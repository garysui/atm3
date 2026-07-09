import { refreshAdjustedBarsCache } from '../server/computed-build.ts'
import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { withRun } from '../server/runs.ts'

// Optional accelerator refresh — the adjusted-bars ALGORITHM is the
// computed.adjusted_bars(policy, as_of) macro and needs no build step.
// Usage: npm run computed:cache [-- --force]
const force = process.argv.includes('--force')
const db = await openDatabase()

try {
  const result = await withRun(db.connection, 'computed:cache', { force }, () =>
    refreshAdjustedBarsCache(db.connection, { force }),
  )
  logger.info({ result }, 'adjusted-bars cache ready')
} finally {
  db.closeSync()
}
