import { openDatabase } from '../server/db.ts'
import {
  cnSourceEnabled,
  ingestBaoStockAdjustmentFactors,
  ingestBaoStockBasics,
  ingestBaoStockCalendar,
  ingestBaoStockDaily,
  ingestBaoStockDividends,
  ingestBaoStockUniverse,
} from '../server/baostock-ingest.ts'
import { logger } from '../server/log.ts'
import { withRun } from '../server/runs.ts'

const jobName = process.argv[2]
const jobNames = [
  'trade_cal',
  'universe',
  'stock_basic',
  'daily_k',
  'dividend',
  'adj_factor',
] as const

if (!cnSourceEnabled()) {
  throw new Error('CN source not enabled; set ATM3_CN_SOURCE=baostock')
}

if (!jobNames.includes(jobName as (typeof jobNames)[number])) {
  throw new Error(`Unknown BaoStock job: ${jobName ?? '(missing)'}`)
}

async function runJob(
  db: Parameters<typeof ingestBaoStockCalendar>[0],
  runId: string,
): Promise<unknown> {
  const options = { runId }
  switch (jobName) {
    case 'trade_cal':
      return ingestBaoStockCalendar(db, options)
    case 'universe':
      return ingestBaoStockUniverse(db, options)
    case 'stock_basic':
      return ingestBaoStockBasics(db, options)
    case 'daily_k':
      return ingestBaoStockDaily(db, options)
    case 'dividend':
      return ingestBaoStockDividends(db, options)
    case 'adj_factor':
      return ingestBaoStockAdjustmentFactors(db, options)
    default:
      throw new Error(`Unknown BaoStock job: ${jobName}`)
  }
}

const db = await openDatabase()
try {
  const result = await withRun(
    db.connection,
    `ingest:baostock:${jobName}`,
    null,
    (runId) => runJob(db, runId),
  )
  logger.info({ result }, 'BaoStock raw job complete')
} finally {
  db.closeSync()
}
