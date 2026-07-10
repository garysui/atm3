import { formatTable } from '../core/format.ts'
import { openDatabase } from '../server/db.ts'
import {
  cnBackfillWindow,
  cnSourceEnabled,
} from '../server/baostock-ingest.ts'
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
  const cnWindow = cnSourceEnabled() ? cnBackfillWindow() : undefined
  const report = await verifyContinuity(db.connection, {
    dailyFrom: from,
    intradayFrom: intradayBackfillWindow().from,
    to,
    cn: cnWindow,
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
  if (report.cn) {
    console.log('\nCN prototype')
    console.log(
      formatTable([
        {
          window: `${report.cn.from} → ${report.cn.to}`,
          codes: report.cn.prototypeCodes,
          calendar_days: report.cn.calendarDays,
          open_days: report.cn.openDays,
          raw_rows: report.cn.rawRows,
          traded_rows: report.cn.tradedRows,
          suspended_rows: report.cn.suspendedRows,
          invalid_raw: report.cn.invalidRawRows,
          window_gap_codes: report.cn.rawWindowGaps.length,
          missing_raw_codes: report.cn.missingRawOpenRows.length,
          missing_fact_codes: report.cn.factsMissingBars.length,
          contradicted_closures: report.cn.contradictedClosures.length,
        },
      ]),
    )
  }

  const gaps = [
    ...report.daily.missingRaw.map((date) => ({ date, problem: 'daily raw missing' })),
    ...report.daily.openDaysMissingFacts.map((date) => ({ date, problem: 'facts bars missing' })),
    ...report.daily.contradictedClosures.map((date) => ({ date, problem: 'closure contradicted by minute data' })),
    ...report.intraday.missingRaw.map((date) => ({ date, problem: 'minute flat file missing' })),
    ...report.intraday.missingParquet.map((date) => ({ date, problem: 'minute parquet missing' })),
    ...(report.cn?.calendarMissingDates ?? []).map((date) => ({
      date,
      problem: 'CN calendar date missing',
    })),
    ...(report.cn?.rawWindowGaps ?? []).map((row) => ({
      date: String(row.first_missing),
      problem: `CN raw window gap ${String(row.vendor_code)} (${String(row.missing_dates)})`,
    })),
    ...(report.cn?.missingRawOpenRows ?? []).map((row) => ({
      date: String(row.first_missing),
      problem: `CN raw open-day gap ${String(row.vendor_code)} (${String(row.missing_dates)})`,
    })),
    ...(report.cn?.factsMissingBars ?? []).map((row) => ({
      date: String(row.first_missing),
      problem: `CN facts gap ${String(row.vendor_code)} (${String(row.missing_dates)})`,
    })),
    ...(report.cn?.contradictedClosures ?? []).map((row) => ({
      date: String(row.market_date),
      problem: `CN closure contradicted ${String(row.vendor_code)}`,
    })),
  ]

  if (gaps.length > 0) {
    console.log('\nGaps (the next replenish run fills raw holes automatically)')
    console.log(formatTable(gaps.slice(0, 40)))
    process.exitCode = 1
  }
} finally {
  db.closeSync()
}
