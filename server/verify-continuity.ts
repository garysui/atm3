import type { DuckDBConnection } from '@duckdb/node-api'
import { weekdaysBetween } from '../core/dates.ts'
import { stageCnDailyCoverage } from './facts-build-cn.ts'

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
// US instrument-level gaps are deliberately NOT checked: an individual name
// missing a day (halt, no trades) is a market fact, not a data hole. CN raw is
// requested per code and carries explicit suspension rows, so its contract can
// assert every listed code/day without treating suspensions as missing bars.

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
  cn: null | {
    from: string
    to: string
    prototypeCodes: number
    calendarDays: number
    openDays: number
    rawRows: number
    tradedRows: number
    suspendedRows: number
    invalidRawRows: number
    calendarMissingDates: string[]
    rawWindowGaps: Array<Record<string, unknown>>
    missingRawOpenRows: Array<Record<string, unknown>>
    factsMissingBars: Array<Record<string, unknown>>
    contradictedClosures: Array<Record<string, unknown>>
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
  options: {
    dailyFrom: string
    intradayFrom: string
    to: string
    cn?: { from: string; to: string; dataDir?: string }
  },
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
     from facts.bars_daily
     where source_id = 'polygon' and market_scope = 'us_stocks'`,
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

  const cn = options.cn
    ? await verifyCnContinuity(connection, options.cn)
    : null
  const cnOk =
    cn === null ||
    (cn.invalidRawRows === 0 &&
      cn.calendarMissingDates.length === 0 &&
      cn.rawWindowGaps.length === 0 &&
      cn.missingRawOpenRows.length === 0 &&
      cn.factsMissingBars.length === 0 &&
      cn.contradictedClosures.length === 0)

  return {
    ok:
      missingRaw.length === 0 &&
      openDaysMissingFacts.length === 0 &&
      contradictedClosures.length === 0 &&
      intradayMissingRaw.length === 0 &&
      intradayMissingParquet.length === 0 &&
      cnOk,
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
    cn,
  }
}

async function rows(
  connection: DuckDBConnection,
  sql: string,
  parameters?: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const result = parameters
    ? await connection.runAndReadAll(sql, parameters)
    : await connection.runAndReadAll(sql)
  return result.getRowObjectsJson() as Array<Record<string, unknown>>
}

async function scalar(
  connection: DuckDBConnection,
  sql: string,
  parameters?: Record<string, string>,
): Promise<number> {
  const result = await rows(connection, sql, parameters)
  return Number(result[0]?.n ?? 0)
}

async function verifyCnContinuity(
  connection: DuckDBConnection,
  options: { from: string; to: string; dataDir?: string },
): Promise<NonNullable<ContinuityReport['cn']>> {
  const staged = await stageCnDailyCoverage(connection, {
    dataDir: options.dataDir,
  })
  const parameters = { from: options.from, to: options.to }

  await connection.run(`
    create or replace temp table t_cn_contract_dates as
    select cast(unnest(generate_series(
      cast($from as date), cast($to as date), interval 1 day
    )) as date) as market_date
  `, parameters)

  const calendarMissingDates = await rows(
    connection,
    `select cast(d.market_date as varchar) as market_date
     from t_cn_contract_dates d
     left join facts.trading_days t
       on t.calendar_id = 'cn_equities' and t.market_date = d.market_date
     where t.market_date is null
     order by d.market_date`,
    undefined,
  )
  const rawWindowGaps = await rows(
    connection,
    `with codes as (
       select identifier_value as vendor_code
       from facts.instrument_identifiers
       where identifier_type = 'baostock_code' and source_id = 'baostock'
     ),
     missing as (
       select c.vendor_code, d.market_date
       from codes c cross join t_cn_contract_dates d
       where not exists (
         select 1 from t_cn_daily_raw_windows w
         where w.vendor_code = c.vendor_code
           and d.market_date between w.window_start and w.window_end
       )
     )
     select vendor_code, count(*) as missing_dates,
            cast(min(market_date) as varchar) as first_missing,
            cast(max(market_date) as varchar) as last_missing
     from missing group by vendor_code order by vendor_code`,
    undefined,
  )
  const missingRawOpenRows = await rows(
    connection,
    `with expected as (
       select id.identifier_value as vendor_code, t.market_date
       from facts.instrument_identifiers id
       join facts.symbols s using (instrument_id)
       join facts.trading_days t
         on t.calendar_id = 'cn_equities' and t.is_open
       where id.identifier_type = 'baostock_code'
         and id.source_id = 'baostock'
         and s.market_scope = 'cn_stocks'
         and t.market_date between cast($from as date) and cast($to as date)
         and (s.valid_from is null or t.market_date >= s.valid_from)
         and (s.valid_to is null or t.market_date < s.valid_to)
     ),
     missing as (
       select e.* from expected e
       left join t_cn_daily_coverage r using (vendor_code, market_date)
       where r.vendor_code is null
     )
     select vendor_code, count(*) as missing_dates,
            cast(min(market_date) as varchar) as first_missing,
            cast(max(market_date) as varchar) as last_missing
     from missing group by vendor_code order by vendor_code`,
    parameters,
  )
  const factsMissingBars = await rows(
    connection,
    `with expected as (
       select r.vendor_code, r.market_date, id.instrument_id
       from t_cn_daily_coverage r
       left join facts.instrument_identifiers id
         on id.identifier_type = 'baostock_code'
        and id.identifier_value = r.vendor_code
        and r.market_date >= id.valid_from
        and (id.valid_to is null or r.market_date < id.valid_to)
       where r.is_traded
         and r.market_date between cast($from as date) and cast($to as date)
     ),
     missing as (
       select e.vendor_code, e.market_date
       from expected e
       left join facts.bars_daily b
         on b.source_id = 'baostock'
        and b.instrument_id = e.instrument_id
        and b.market_date = e.market_date
       where b.instrument_id is null
     )
     select vendor_code, count(*) as missing_dates,
            cast(min(market_date) as varchar) as first_missing,
            cast(max(market_date) as varchar) as last_missing
     from missing group by vendor_code order by vendor_code`,
    parameters,
  )
  const contradictedClosures = await rows(
    connection,
    `select r.vendor_code, cast(r.market_date as varchar) as market_date
     from t_cn_daily_coverage r
     join facts.trading_days t
       on t.calendar_id = 'cn_equities' and t.market_date = r.market_date
     where r.is_traded and not t.is_open
       and r.market_date between cast($from as date) and cast($to as date)
     order by r.market_date, r.vendor_code`,
    parameters,
  )

  return {
    from: options.from,
    to: options.to,
    prototypeCodes: await scalar(
      connection,
      `select count(*) as n from facts.instrument_identifiers
       where identifier_type = 'baostock_code' and source_id = 'baostock'`,
      undefined,
    ),
    calendarDays: await scalar(
      connection,
      `select count(*) as n from facts.trading_days
       where calendar_id = 'cn_equities'
         and market_date between cast($from as date) and cast($to as date)`,
      parameters,
    ),
    openDays: await scalar(
      connection,
      `select count(*) as n from facts.trading_days
       where calendar_id = 'cn_equities' and is_open
         and market_date between cast($from as date) and cast($to as date)`,
      parameters,
    ),
    rawRows: await scalar(
      connection,
      `select count(*) as n from t_cn_daily_coverage
       where market_date between cast($from as date) and cast($to as date)`,
      parameters,
    ),
    tradedRows: await scalar(
      connection,
      `select count(*) as n from t_cn_daily_coverage
       where is_traded
         and market_date between cast($from as date) and cast($to as date)`,
      parameters,
    ),
    suspendedRows: await scalar(
      connection,
      `select count(*) as n from t_cn_daily_coverage
       where is_suspended
         and market_date between cast($from as date) and cast($to as date)`,
      parameters,
    ),
    invalidRawRows: staged.invalidRows,
    calendarMissingDates: calendarMissingDates.map((row) =>
      String(row.market_date),
    ),
    rawWindowGaps,
    missingRawOpenRows,
    factsMissingBars,
    contradictedClosures,
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
    report.cn?.calendarMissingDates.length &&
      `${report.cn.calendarMissingDates.length} CN calendar date(s) missing`,
    report.cn?.rawWindowGaps.length &&
      `${report.cn.rawWindowGaps.length} CN code(s) have raw window gaps`,
    report.cn?.missingRawOpenRows.length &&
      `${report.cn.missingRawOpenRows.length} CN code(s) miss open-day raw rows`,
    report.cn?.factsMissingBars.length &&
      `${report.cn.factsMissingBars.length} CN code(s) miss traded facts bars`,
    report.cn?.contradictedClosures.length &&
      `${report.cn.contradictedClosures.length} CN traded row(s) contradict closures`,
    report.cn?.invalidRawRows &&
      `${report.cn.invalidRawRows} invalid CN raw coverage row(s)`,
  ].filter(Boolean)

  return problems.length === 0
    ? `continuous: ${report.daily.coveredDays} US open days + ` +
        `${report.daily.closedDays} closures cover all ` +
        `${report.daily.expectedWeekdays} weekdays ${report.daily.from} → ` +
        `${report.daily.to}; intraday complete for ${report.intraday.openDays} ` +
        `open days since ${report.intraday.from}` +
        (report.cn
          ? `; CN ${report.cn.prototypeCodes} codes / ${report.cn.tradedRows} ` +
            `traded rows complete ${report.cn.from} → ${report.cn.to}`
          : '')
    : problems.join('; ')
}
