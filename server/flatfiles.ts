import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { weekdaysBetween } from '../core/dates.ts'
import { latestPublishedMinuteDate } from '../core/publication.ts'
import type { Atm3Db } from './db.ts'
import { env } from './env.ts'
import { logger } from './log.ts'
import { backfillWindow } from './polygon-ingest.ts'
import { fetchExists, landRawFile } from './raw-zone.ts'

// Polygon/Massive intraday flat files: one vendor csv.gz per trading day
// covering the whole market's minute aggregates. Downloaded via the AWS CLI
// (S3-compatible endpoint; credentials are an aws profile, NOT the REST
// key) and landed byte-identical in the raw zone.

const execFileAsync = promisify(execFile)
const endpoint = 'https://files.massive.com'
const bucket = 'flatfiles'
const sourceId = 'polygon'
const dataset = 'minute_aggs'

// Minute flat files lag a session by hours — the window ends at the latest
// PUBLISHED date, so a nightly run never demands a file that cannot exist
// yet (review finding #1).
export function intradayBackfillWindow(): { from: string; to: string } {
  const shared = backfillWindow()
  const published = latestPublishedMinuteDate(new Date())

  return {
    from: env.ATM3_INTRADAY_BACKFILL_FROM ?? shared.from,
    to: published < shared.to ? published : shared.to,
  }
}

function minuteKey(date: string): string {
  const [year, month] = date.split('-')
  return `us_stocks_sip/minute_aggs_v1/${year}/${month}/${date}.csv.gz`
}

async function downloadFlatFile(key: string, targetPath: string): Promise<
  'ok' | 'not_available'
> {
  try {
    await execFileAsync(
      'aws',
      [
        's3',
        'cp',
        `s3://${bucket}/${key}`,
        targetPath,
        '--endpoint-url',
        endpoint,
        '--profile',
        env.ATM3_POLYGON_FLATFILES_AWS_PROFILE,
        '--only-show-errors',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    return 'ok'
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)

    // A missing object is expected for closures not yet known and for days
    // the vendor has not published yet — skipped, retried next run.
    if (/404|Not Found|NoSuchKey/i.test(message)) {
      return 'not_available'
    }

    throw new Error(`flat file download failed for ${key}: ${message}`, {
      cause,
    })
  }
}

export type MinuteAggsResult = {
  dataset: string
  from: string
  to: string
  candidateDates: number
  fetched: number
  skippedExisting: number
  skippedClosed: number
  notAvailable: string[]
}

export async function ingestMinuteAggs(
  db: Atm3Db,
  options: { runId: string | null; from: string; to: string },
): Promise<MinuteAggsResult> {
  const dates = weekdaysBetween(options.from, options.to)

  // Days the grouped-daily evidence already proves closed have no flat file
  // — skip without an S3 round trip.
  const closedResult = await db.connection.runAndReadAll(`
    select cast(market_date as varchar) as market_date
    from raw.fetches
    where source_id = 'polygon'
      and dataset = 'grouped_daily'
      and coalesce(row_count, 0) = 0
  `)
  const closed = new Set(
    closedResult.getRowObjectsJson().map((row) => String(row.market_date)),
  )

  let fetched = 0
  let skippedExisting = 0
  let skippedClosed = 0
  const notAvailable: string[] = []

  for (const date of dates) {
    if (closed.has(date)) {
      skippedClosed++
      continue
    }

    if (
      await fetchExists(db.connection, { sourceId, dataset, marketDate: date })
    ) {
      skippedExisting++
      continue
    }

    const key = minuteKey(date)
    const tempPath = path.join(os.tmpdir(), `atm3-minute-${date}.csv.gz`)
    const outcome = await downloadFlatFile(key, tempPath)

    if (outcome === 'not_available') {
      notAvailable.push(date)
      continue
    }

    try {
      const payload = new Uint8Array(await readFile(tempPath))
      await landRawFile({
        connection: db.connection,
        runId: options.runId,
        sourceId,
        dataset,
        requestUrl: `${endpoint}/${bucket}/${key}`,
        requestParams: {
          profile: env.ATM3_POLYGON_FLATFILES_AWS_PROFILE,
        },
        marketScope: 'us_stocks',
        marketDate: date,
        httpStatus: 200,
        relativeFilePath: `raw/polygon/${dataset}/date=${date}/us_stocks.csv.gz`,
        payload,
        storeVerbatim: true,
      })
    } finally {
      await rm(tempPath, { force: true })
    }

    fetched++

    if (fetched % 10 === 0) {
      logger.info({ dataset, fetched, lastDate: date }, 'minute aggs progress')
    }
  }

  return {
    dataset,
    from: options.from,
    to: options.to,
    candidateDates: dates.length,
    fetched,
    skippedExisting,
    skippedClosed,
    notAvailable,
  }
}
