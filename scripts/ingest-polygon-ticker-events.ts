import { openDatabase } from '../server/db.ts'
import { logger } from '../server/log.ts'
import { ingestTickerEvents } from '../server/polygon-ingest.ts'
import { withRun } from '../server/runs.ts'

// Usage: npm run ingest:polygon:ticker-events -- META AAPL
const tickers = process.argv.slice(2)

if (tickers.length === 0) {
  tickers.push('META')
}

const db = await openDatabase()

try {
  const result = await withRun(
    db.connection,
    'ingest:polygon:ticker_events',
    { tickers },
    (runId) => ingestTickerEvents(db, { runId, tickers }),
  )
  logger.info({ result }, 'ticker events ingested')
} finally {
  db.closeSync()
}
