import type { DuckDBConnection } from '@duckdb/node-api'
import { weekdaysBetween } from '../core/dates.ts'

// The coverage contract (owner, 2026-07-09): every trading day from the
// FIXED window start through yesterday has raw grouped-daily evidence and
// market-wide daily bars in facts; every open day inside the intraday
// window has the minute flat file and its parquet. Ingestion self-heals
// holes (each run rescans the whole window, presence-skipped), and THIS
// check is where the contract is asserted rather than assumed.
//
// Closures are not gaps: a stored zero-row grouped file is evidence the
// market was closed. But a claimed closure contradicted by minute data
// (bars exist for that day) is a hard failure — the silent failure mode
// where one bad fetch would otherwise masquerade as a holiday forever.
//
// Instrument-level gaps are deliberately NOT checked: an individual name
// missing a day (halt, no trades) is a market fact, not a data hole. The
// contract is market-level.

export type ContinuityReport = {
  ok: boolean
  daily: {
    from: string
    to: string
    expectedWeekdays: number
    coveredDays: number
    closedDays: number
    missingRaw: string[]
    openDaysMissingFacts: string[]
    contradictedClosures: string[]
  }
  intraday: {
    from: string
    to: string
    openDays: number
    missingRaw: string[]
    missingParquet: string[]
  }
}

async function dateSet(
  connection: DuckDBConnection,
  sql: string,
): Promise<Set<string>> {
  const result = await connection.runAndReadAll(sql)
  return new Set(
    result.getRowObjectsJson().map((row) => String(row.market_date)),
  )
}

export async function verifyContinuity(
  connection: DuckDBConnection,
  options: { dailyFrom: string; intradayFrom: string; to: string },
): Promise<ContinuityReport> {
  const weekdays = weekdaysBetween(options.dailyFrom, options.to)

  const fetched = await dateSet(
    connection,
    `select cast(market_date as varchar) as market_date
     from raw.fetches
     where source_id = 'polygon' and dataset = 'grouped_daily'`,
  )
  const closed = await dateSet(
    connection,
    `select cast(market_date as varchar) as market_date
     from raw.fetches
     where source_id = 'polygon' and dataset = 'grouped_daily'
       and coalesce(row_count, 0) = 0`,
  )
  const factsDays = await dateSet(
    connection,
    `select distinct cast(market_date as varchar) as market_date
     from facts.bars_daily`,
  )
  const minuteRaw = await dateSet(
    connection,
    `select cast(market_date as varchar) as market_date
     from raw.fetches
     where source_id = 'polygon' and dataset = 'minute_aggs'`,
  )
  const minuteParquet = await dateSet(
    connection,
    `select distinct cast(market_date as varchar) as market_date
     from facts.bars_minute_parsed`,
  )

  const missingRaw = weekdays.filter((date) => !fetched.has(date))
  const openDays = weekdays.filter(
    (date) => fetched.has(date) && !closed.has(date),
  )
  const openDaysMissingFacts = openDays.filter((date) => !factsDays.has(date))
  const contradictedClosures = weekdays.filter(
    (date) => closed.has(date) && minuteParquet.has(date),
  )

  // The intraday window can start after the daily one (adopted later) —
  // a not-yet-started window is simply empty, not an error.
  const intradayWeekdays = (
    options.intradayFrom > options.to
      ? []
      : weekdaysBetween(options.intradayFrom, options.to)
  ).filter((date) => fetched.has(date) && !closed.has(date))
  const intradayMissingRaw = intradayWeekdays.filter(
    (date) => !minuteRaw.has(date),
  )
  const intradayMissingParquet = intradayWeekdays.filter(
    (date) => minuteRaw.has(date) && !minuteParquet.has(date),
  )

  return {
    ok:
      missingRaw.length === 0 &&
      openDaysMissingFacts.length === 0 &&
      contradictedClosures.length === 0 &&
      intradayMissingRaw.length === 0 &&
      intradayMissingParquet.length === 0,
    daily: {
      from: options.dailyFrom,
      to: options.to,
      expectedWeekdays: weekdays.length,
      coveredDays: openDays.length,
      closedDays: weekdays.filter((date) => closed.has(date)).length,
      missingRaw,
      openDaysMissingFacts,
      contradictedClosures,
    },
    intraday: {
      from: options.intradayFrom,
      to: options.to,
      openDays: intradayWeekdays.length,
      missingRaw: intradayMissingRaw,
      missingParquet: intradayMissingParquet,
    },
  }
}

export function continuitySummary(report: ContinuityReport): string {
  const problems = [
    report.daily.missingRaw.length &&
      `${report.daily.missingRaw.length} weekday(s) missing raw grouped data ` +
        `(${report.daily.missingRaw.slice(0, 5).join(', ')}…)`,
    report.daily.openDaysMissingFacts.length &&
      `${report.daily.openDaysMissingFacts.length} open day(s) missing facts bars`,
    report.daily.contradictedClosures.length &&
      `${report.daily.contradictedClosures.length} claimed closure(s) contradicted by minute data`,
    report.intraday.missingRaw.length &&
      `${report.intraday.missingRaw.length} open day(s) missing minute flat files`,
    report.intraday.missingParquet.length &&
      `${report.intraday.missingParquet.length} minute day(s) missing parquet`,
  ].filter(Boolean)

  return problems.length === 0
    ? `continuous: ${report.daily.coveredDays} open days + ` +
        `${report.daily.closedDays} closures cover all ` +
        `${report.daily.expectedWeekdays} weekdays ${report.daily.from} → ` +
        `${report.daily.to}; intraday complete for ${report.intraday.openDays} ` +
        `open days since ${report.intraday.from}`
    : problems.join('; ')
}
