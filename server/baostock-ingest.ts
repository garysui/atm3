import { setTimeout as sleep } from 'node:timers/promises'
import type { DuckDBConnection } from '@duckdb/node-api'
import {
  runBaoStockRelay,
  type BaoStockJob,
  type BaoStockRelayResult,
} from '../connectors/baostock.ts'
import { addDays, addYears } from '../core/dates.ts'
import { latestCompletedCnTradingDate } from '../core/publication.ts'
import type { Atm3Db } from './db.ts'
import { env } from './env.ts'
import { logger } from './log.ts'
import { parseBaoStockFrame } from './baostock-frame.ts'
import { loadCnPrototypeUniverse } from './cn-universe.ts'
import { clearRawSubtree, landRawFile } from './raw-zone.ts'

const sourceId = 'baostock'
const marketScope = 'cn_stocks'
const throttleMs = 150
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function cnSourceEnabled(): boolean {
  return env.ATM3_CN_SOURCE === sourceId
}

export function cnBackfillWindow(now = new Date()): { from: string; to: string } {
  return {
    from:
      env.ATM3_CN_BACKFILL_FROM ??
      addYears(latestCompletedCnTradingDate(now), -2),
    // Conservative until a publication-hour contract is measured live.
    to: latestCompletedCnTradingDate(now),
  }
}

type RawJobOptions = {
  runId: string | null
  dataset: string
  relativeDir: string
  job: BaoStockJob
  marketDate?: string | null
  relay?: typeof runBaoStockRelay
  dataDir?: string
}

export type RawJobResult = {
  dataset: string
  scope: string
  frames: number
  rows: number
  skipped: boolean
}

async function rawScopeComplete(
  connection: DuckDBConnection,
  relativeDir: string,
): Promise<boolean> {
  const result = await connection.runAndReadAll(
    `
      select count(*) as actual,
             max(try_cast(json_extract_string(request_params, '$.frame_count')
                          as integer)) as expected
      from raw.fetches
      where source_id = 'baostock'
        and starts_with(file_path, $prefix)
    `,
    { prefix: `${relativeDir.replace(/\/$/, '')}/` },
  )
  const row = result.getRowObjectsJson()[0]
  const actual = Number(row?.actual ?? 0)
  const expected = Number(row?.expected ?? 0)
  return expected > 0 && actual === expected
}

export async function ingestBaoStockRawJob(
  db: Atm3Db,
  options: RawJobOptions,
): Promise<RawJobResult> {
  if (await rawScopeComplete(db.connection, options.relativeDir)) {
    return {
      dataset: options.dataset,
      scope: options.relativeDir,
      frames: 0,
      rows: 0,
      skipped: true,
    }
  }

  await clearRawSubtree(db.connection, options.relativeDir, options.dataDir)
  const relay = options.relay ?? runBaoStockRelay
  const result: BaoStockRelayResult = await relay(options.job)
  let rows = 0

  for (const frame of result.frames) {
    const parsed = parseBaoStockFrame(frame.payload)
    if (parsed.method !== options.job.api) {
      throw new Error(
        `BaoStock expected ${options.job.api}, received ${parsed.method}`,
      )
    }
    rows += parsed.records.length
    await landRawFile({
      connection: db.connection,
      dataDir: options.dataDir,
      runId: options.runId,
      sourceId,
      dataset: options.dataset,
      requestUrl: `baostock://${options.job.api}`,
      requestParams: {
        api: options.job.api,
        ...options.job.params,
        client_version: result.clientVersion,
        login_code: result.loginCode,
        frame_count: result.frames.length,
      },
      marketScope,
      marketDate: options.marketDate ?? null,
      pageCursor: String(frame.seq),
      httpStatus: 200,
      relativeFilePath:
        `${options.relativeDir}/frame-${String(frame.seq).padStart(4, '0')}.frame`,
      payload: frame.payload,
      rowCount: parsed.records.length,
      storeVerbatim: true,
    })
  }

  return {
    dataset: options.dataset,
    scope: options.relativeDir,
    frames: result.frames.length,
    rows,
    skipped: false,
  }
}

function snapshotDate(now = new Date()): string {
  return shanghaiDate.format(now)
}

async function latestWindowEnd(
  connection: DuckDBConnection,
  dataset: string,
  code: string,
): Promise<string | null> {
  const result = await connection.runAndReadAll(
    `
      with windows as (
        select
          json_extract_string(request_params, '$.end_date') as end_date,
          count(*) as actual_frames,
          max(try_cast(json_extract_string(request_params, '$.frame_count')
                       as integer)) as expected_frames
        from raw.fetches
        where source_id = 'baostock'
          and dataset = $dataset
          and json_extract_string(request_params, '$.code') = $code
        group by
          json_extract_string(request_params, '$.start_date'),
          json_extract_string(request_params, '$.end_date')
      )
      select max(end_date) as end_date
      from windows
      where expected_frames > 0 and actual_frames = expected_frames
    `,
    { dataset, code },
  )
  const value = result.getRowObjectsJson()[0]?.end_date
  return value === null || value === undefined ? null : String(value)
}

async function runSequential(
  jobs: Array<() => Promise<RawJobResult>>,
): Promise<RawJobResult[]> {
  const results: RawJobResult[] = []
  for (const [index, job] of jobs.entries()) {
    results.push(await job())
    if (index < jobs.length - 1) {
      await sleep(throttleMs)
    }
    if ((index + 1) % 10 === 0) {
      logger.info({ completed: index + 1, total: jobs.length }, 'BaoStock ingest progress')
    }
  }
  return results
}

function summarize(dataset: string, results: RawJobResult[]) {
  return {
    dataset,
    requests: results.length,
    fetched: results.filter((result) => !result.skipped).length,
    skipped: results.filter((result) => result.skipped).length,
    frames: results.reduce((sum, result) => sum + result.frames, 0),
    rows: results.reduce((sum, result) => sum + result.rows, 0),
  }
}

export async function ingestBaoStockCalendar(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
) {
  const date = snapshotDate(options.now)
  const window = cnBackfillWindow(options.now)
  return ingestBaoStockRawJob(db, {
    runId: options.runId,
    dataset: 'trade_cal',
    relativeDir: `raw/baostock/trade_cal/snapshot_date=${date}`,
    job: {
      api: 'query_trade_dates',
      params: { start_date: window.from, end_date: addYears(date, 1) },
    },
  })
}

export async function ingestBaoStockUniverse(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
) {
  const date = snapshotDate(options.now)
  const { to } = cnBackfillWindow(options.now)
  return ingestBaoStockRawJob(db, {
    runId: options.runId,
    dataset: 'universe',
    relativeDir: `raw/baostock/universe/snapshot_date=${date}`,
    marketDate: to,
    job: { api: 'query_all_stock', params: { day: to } },
  })
}

export async function ingestBaoStockBasics(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
) {
  const universe = await loadCnPrototypeUniverse()
  const date = snapshotDate(options.now)
  const jobs = universe.securities.map(({ code }) => () =>
    ingestBaoStockRawJob(db, {
      runId: options.runId,
      dataset: 'stock_basic',
      relativeDir: `raw/baostock/stock_basic/snapshot_date=${date}/code=${code}`,
      job: { api: 'query_stock_basic', params: { code } },
    }),
  )
  return { ...summarize('stock_basic', await runSequential(jobs)), warning: universe.warning }
}

async function incrementalJobs(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
  dataset: 'daily_k' | 'adj_factor',
): Promise<RawJobResult[]> {
  const universe = await loadCnPrototypeUniverse()
  const window = cnBackfillWindow(options.now)
  const jobs: Array<() => Promise<RawJobResult>> = []

  for (const { code } of universe.securities) {
    const latest = await latestWindowEnd(db.connection, dataset, code)
    const from = latest ? addDays(latest, 1) : window.from
    if (from > window.to) {
      continue
    }
    const params = { code, start_date: from, end_date: window.to }
    const api = dataset === 'daily_k'
      ? 'query_history_k_data_plus'
      : 'query_adjust_factor'
    const jobParams = dataset === 'daily_k'
      ? {
          ...params,
          fields:
            'date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST',
          frequency: 'd',
          adjustflag: '3',
        }
      : params
    jobs.push(() =>
      ingestBaoStockRawJob(db, {
        runId: options.runId,
        dataset,
        relativeDir:
          `raw/baostock/${dataset}/code=${code}/window=${from}_${window.to}`,
        job: { api, params: jobParams } as BaoStockJob,
      }),
    )
  }

  return runSequential(jobs)
}

export async function ingestBaoStockDaily(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
) {
  return summarize('daily_k', await incrementalJobs(db, options, 'daily_k'))
}

export async function ingestBaoStockAdjustmentFactors(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
) {
  return summarize('adj_factor', await incrementalJobs(db, options, 'adj_factor'))
}

export async function ingestBaoStockDividends(
  db: Atm3Db,
  options: { runId: string | null; now?: Date },
) {
  const universe = await loadCnPrototypeUniverse()
  const window = cnBackfillWindow(options.now)
  const firstYear = Number(window.from.slice(0, 4))
  const lastYear = Number(window.to.slice(0, 4))
  const jobs: Array<() => Promise<RawJobResult>> = []

  for (const { code } of universe.securities) {
    for (let year = firstYear; year <= lastYear; year++) {
      jobs.push(() =>
        ingestBaoStockRawJob(db, {
          runId: options.runId,
          dataset: 'dividend',
          relativeDir: `raw/baostock/dividend/code=${code}/year=${year}`,
          job: {
            api: 'query_dividend_data',
            params: { code, year: String(year), yearType: 'operate' },
          },
        }),
      )
    }
  }

  return summarize('dividend', await runSequential(jobs))
}
