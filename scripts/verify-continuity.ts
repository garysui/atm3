import { formatTable } from '../core/format.ts'
import { openDatabase } from '../server/db.ts'
import { intradayBackfillWindow } from '../server/flatfiles.ts'
import { backfillWindow } from '../server/polygon-ingest.ts'
import {
  continuitySummary,
  verifyContinuity,
} from '../server/verify-continuity.ts'

// Asserts the coverage contract; exits 1 when any trading day is missing so
// schedulers can alarm. Closures (zero-row days) are evidence, not gaps.
const db = await openDatabase()

try {
  const { from, to } = backfillWindow()
  const report = await verifyContinuity(db.connection, {
    dailyFrom: from,
    intradayFrom: intradayBackfillWindow().from,
    to,
  })

  console.log(`Coverage contract — ${continuitySummary(report)}\n`)
  console.log(
    formatTable([
      {
        window: `${report.daily.from} → ${report.daily.to}`,
        weekdays: report.daily.expectedWeekdays,
        open_days: report.daily.coveredDays,
        closures: report.daily.closedDays,
        missing_raw: report.daily.missingRaw.length,
        missing_facts: report.daily.openDaysMissingFacts.length,
        contradicted_closures: report.daily.contradictedClosures.length,
      },
    ]),
  )
  console.log('\nIntraday')
  console.log(
    formatTable([
      {
        window: `${report.intraday.from} → ${report.intraday.to}`,
        open_days: report.intraday.openDays,
        missing_raw: report.intraday.missingRaw.length,
        missing_parquet: report.intraday.missingParquet.length,
      },
    ]),
  )

  const gaps = [
    ...report.daily.missingRaw.map((date) => ({ date, problem: 'daily raw missing' })),
    ...report.daily.openDaysMissingFacts.map((date) => ({ date, problem: 'facts bars missing' })),
    ...report.daily.contradictedClosures.map((date) => ({ date, problem: 'closure contradicted by minute data' })),
    ...report.intraday.missingRaw.map((date) => ({ date, problem: 'minute flat file missing' })),
    ...report.intraday.missingParquet.map((date) => ({ date, problem: 'minute parquet missing' })),
  ]

  if (gaps.length > 0) {
    console.log('\nGaps (the next replenish run fills raw holes automatically)')
    console.log(formatTable(gaps.slice(0, 40)))
    process.exitCode = 1
  }
} finally {
  db.closeSync()
}
