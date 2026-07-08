import {
  cursorFromUrl,
  polygonGet,
  polygonListPages,
} from '../connectors/polygon.ts'
import { addDays, addYears, weekdaysBetween } from '../core/dates.ts'
import type { Atm3Db } from './db.ts'
import { env } from './env.ts'
import { logger } from './log.ts'
import { clearRawSubtree, fetchExists, landRawFile } from './raw-zone.ts'
import { isSyncComplete, markSyncComplete } from './sync-state.ts'

const sourceId = 'polygon'
const usStocks = 'us_stocks'

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

// Owner decision 2026-07-08: default backfill window is 2 years, ending
// yesterday (grouped daily for a date is published after that session ends).
export function backfillWindow(): { from: string; to: string } {
  const today = todayUtc()

  return {
    from: env.ATM3_BACKFILL_FROM ?? addYears(today, -2),
    to: env.ATM3_BACKFILL_TO ?? addDays(today, -1),
  }
}

type SnapshotSweepOptions = {
  runId: string | null
  dataset: string
  scope: string
  firstUrl: string
  requestParams: Record<string, unknown>
  relativeDir: string
}

export type SnapshotSweepResult = {
  dataset: string
  scope: string
  pages: number
  rows: number
  skipped: boolean
}

// Land a full cursor-paginated sweep as one dated snapshot. A completed scope
// is skipped on rerun; an incomplete one is cleared first, because a partial
// snapshot is not a fact and stale trailing pages must not survive.
async function ingestPaginatedSnapshot(
  db: Atm3Db,
  options: SnapshotSweepOptions,
): Promise<SnapshotSweepResult> {
  const job = `ingest:polygon:${options.dataset}`

  if (await isSyncComplete(db.connection, job, options.scope)) {
    logger.info(
      { dataset: options.dataset, scope: options.scope },
      'snapshot already complete, skipping',
    )
    return {
      dataset: options.dataset,
      scope: options.scope,
      pages: 0,
      rows: 0,
      skipped: true,
    }
  }

  await clearRawSubtree(db.connection, options.relativeDir)

  let pages = 0
  let rows = 0

  for await (const page of polygonListPages(options.firstUrl)) {
    pages++
    rows += page.rowCount
    await landRawFile({
      connection: db.connection,
      runId: options.runId,
      sourceId,
      dataset: options.dataset,
      requestUrl: page.requestUrl,
      requestParams: options.requestParams,
      marketScope: usStocks,
      pageCursor: cursorFromUrl(page.requestUrl),
      httpStatus: page.httpStatus,
      relativeFilePath: `${options.relativeDir}/page-${String(pages).padStart(5, '0')}.json.gz`,
      payload: page.payload,
      rowCount: page.rowCount,
    })

    if (pages % 10 === 0) {
      logger.info({ dataset: options.dataset, pages, rows }, 'snapshot progress')
    }
  }

  await markSyncComplete(db.connection, job, options.scope, todayUtc())

  return {
    dataset: options.dataset,
    scope: options.scope,
    pages,
    rows,
    skipped: false,
  }
}

// All listed US-stock tickers Polygon knows, active and delisted, as a dated
// point-in-time snapshot.
export async function ingestReferenceTickers(
  db: Atm3Db,
  options: { runId: string | null; snapshotDate?: string },
): Promise<SnapshotSweepResult[]> {
  const snapshotDate = options.snapshotDate ?? todayUtc()
  const results: SnapshotSweepResult[] = []

  for (const active of [true, false]) {
    results.push(
      await ingestPaginatedSnapshot(db, {
        runId: options.runId,
        dataset: 'reference_tickers',
        scope: `${snapshotDate}:active=${active}`,
        firstUrl: `/v3/reference/tickers?market=stocks&active=${active}&order=asc&sort=ticker&limit=1000`,
        requestParams: { market: 'stocks', active, limit: 1000, sort: 'ticker' },
        relativeDir: `raw/polygon/reference_tickers/snapshot_date=${snapshotDate}/active=${active}`,
      }),
    )
  }

  return results
}

export async function ingestSplits(
  db: Atm3Db,
  options: { runId: string | null; from: string; snapshotDate?: string },
): Promise<SnapshotSweepResult> {
  const snapshotDate = options.snapshotDate ?? todayUtc()

  return ingestPaginatedSnapshot(db, {
    runId: options.runId,
    dataset: 'splits',
    scope: `${snapshotDate}:from=${options.from}`,
    firstUrl: `/v3/reference/splits?execution_date.gte=${options.from}&order=asc&sort=execution_date&limit=1000`,
    requestParams: { 'execution_date.gte': options.from, limit: 1000 },
    relativeDir: `raw/polygon/splits/snapshot_date=${snapshotDate}`,
  })
}

export async function ingestDividends(
  db: Atm3Db,
  options: { runId: string | null; from: string; snapshotDate?: string },
): Promise<SnapshotSweepResult> {
  const snapshotDate = options.snapshotDate ?? todayUtc()

  return ingestPaginatedSnapshot(db, {
    runId: options.runId,
    dataset: 'dividends',
    scope: `${snapshotDate}:from=${options.from}`,
    firstUrl: `/v3/reference/dividends?ex_dividend_date.gte=${options.from}&order=asc&sort=ex_dividend_date&limit=1000`,
    requestParams: { 'ex_dividend_date.gte': options.from, limit: 1000 },
    relativeDir: `raw/polygon/dividends/snapshot_date=${snapshotDate}`,
  })
}

async function ingestSingleSnapshotFile(
  db: Atm3Db,
  options: {
    runId: string | null
    dataset: string
    url: string
    relativeFilePath: string
    rowCount: (body: unknown) => number
  },
): Promise<{ dataset: string; rows: number; skipped: boolean }> {
  if (
    await fetchExists(db.connection, {
      sourceId,
      dataset: options.dataset,
      filePath: options.relativeFilePath,
    })
  ) {
    logger.info({ dataset: options.dataset }, 'snapshot file exists, skipping')
    return { dataset: options.dataset, rows: 0, skipped: true }
  }

  const response = await polygonGet(options.url)
  const rows = options.rowCount(response.body)
  await landRawFile({
    connection: db.connection,
    runId: options.runId,
    sourceId,
    dataset: options.dataset,
    requestUrl: response.requestUrl,
    httpStatus: response.httpStatus,
    relativeFilePath: options.relativeFilePath,
    payload: response.payload,
    rowCount: rows,
  })

  return { dataset: options.dataset, rows, skipped: false }
}

// All exchanges Polygon describes (unfiltered — the complete reference set).
export async function ingestExchanges(
  db: Atm3Db,
  options: { runId: string | null; snapshotDate?: string },
) {
  const snapshotDate = options.snapshotDate ?? todayUtc()

  return ingestSingleSnapshotFile(db, {
    runId: options.runId,
    dataset: 'exchanges',
    url: '/v3/reference/exchanges',
    relativeFilePath: `raw/polygon/exchanges/snapshot_date=${snapshotDate}/exchanges.json.gz`,
    rowCount: (body) => {
      const results = (body as { results?: unknown[] } | null)?.results
      return Array.isArray(results) ? results.length : 0
    },
  })
}

// Upcoming market holidays/half-days. Historical closures are not served by
// this endpoint; they become facts later, derived from grouped-daily presence.
export async function ingestMarketHolidays(
  db: Atm3Db,
  options: { runId: string | null; snapshotDate?: string },
) {
  const snapshotDate = options.snapshotDate ?? todayUtc()

  return ingestSingleSnapshotFile(db, {
    runId: options.runId,
    dataset: 'market_holidays',
    url: '/v1/marketstatus/upcoming',
    relativeFilePath: `raw/polygon/market_holidays/snapshot_date=${snapshotDate}/upcoming.json.gz`,
    rowCount: (body) => (Array.isArray(body) ? body.length : 0),
  })
}

export type GroupedDailyResult = {
  dataset: string
  from: string
  to: string
  candidateDates: number
  fetched: number
  skipped: number
  emptyDates: number
}

// One verbatim whole-market file per calendar weekday. Zero-row responses are
// stored too: they are the evidence that the market was closed that day.
export async function ingestGroupedDaily(
  db: Atm3Db,
  options: {
    runId: string | null
    from: string
    to: string
    adjusted: boolean
  },
): Promise<GroupedDailyResult> {
  const dataset = options.adjusted ? 'grouped_daily_adjusted' : 'grouped_daily'
  const dates = weekdaysBetween(options.from, options.to)
  let fetched = 0
  let skipped = 0
  let emptyDates = 0

  for (const date of dates) {
    if (
      await fetchExists(db.connection, { sourceId, dataset, marketDate: date })
    ) {
      skipped++
      continue
    }

    const response = await polygonGet(
      `/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=${options.adjusted}&include_otc=false`,
    )
    const results = (response.body as { results?: unknown[] } | null)?.results
    const rowCount = Array.isArray(results) ? results.length : 0
    await landRawFile({
      connection: db.connection,
      runId: options.runId,
      sourceId,
      dataset,
      requestUrl: response.requestUrl,
      requestParams: { adjusted: options.adjusted, include_otc: false },
      marketScope: usStocks,
      marketDate: date,
      httpStatus: response.httpStatus,
      relativeFilePath: `raw/polygon/${dataset}/date=${date}/us_stocks.json.gz`,
      payload: response.payload,
      rowCount,
    })
    fetched++

    if (rowCount === 0) {
      emptyDates++
    }

    if (fetched % 25 === 0) {
      logger.info(
        { dataset, fetched, skipped, lastDate: date },
        'grouped daily progress',
      )
    }
  }

  return {
    dataset,
    from: options.from,
    to: options.to,
    candidateDates: dates.length,
    fetched,
    skipped,
    emptyDates,
  }
}

// Ticker events (name/symbol changes) for specific tickers of interest.
export async function ingestTickerEvents(
  db: Atm3Db,
  options: { runId: string | null; tickers: string[]; snapshotDate?: string },
) {
  const snapshotDate = options.snapshotDate ?? todayUtc()
  const results: Array<{ ticker: string; rows: number; skipped: boolean }> = []

  for (const ticker of options.tickers) {
    const normalized = ticker.trim().toUpperCase()
    const relativeFilePath = `raw/polygon/ticker_events/snapshot_date=${snapshotDate}/${normalized}.json.gz`

    if (
      await fetchExists(db.connection, {
        sourceId,
        dataset: 'ticker_events',
        filePath: relativeFilePath,
      })
    ) {
      results.push({ ticker: normalized, rows: 0, skipped: true })
      continue
    }

    const response = await polygonGet(
      `/vX/reference/tickers/${encodeURIComponent(normalized)}/events`,
    )
    const events = (
      response.body as { results?: { events?: unknown[] } } | null
    )?.results?.events
    const rowCount = Array.isArray(events) ? events.length : 0
    await landRawFile({
      connection: db.connection,
      runId: options.runId,
      sourceId,
      dataset: 'ticker_events',
      requestUrl: response.requestUrl,
      marketScope: usStocks,
      httpStatus: response.httpStatus,
      relativeFilePath,
      payload: response.payload,
      rowCount,
    })
    results.push({ ticker: normalized, rows: rowCount, skipped: false })
  }

  return results
}
