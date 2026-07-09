import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DuckDBConnection } from '@duckdb/node-api'
import { env } from './env.ts'
import { logger } from './log.ts'

// Minute facts: a PARSE-ONLY parquet per trading day, built deterministically
// from that day's raw flat file. Typed columns and nothing else — identity
// stays a query-time join in the facts.bars_minute view, so no interpretation
// is ever baked into these files. Each day is verified (parquet row count ==
// raw csv row count) before it is accepted; a mismatch deletes the output and
// fails loudly. Files under <dataDir>/facts/ are derived and rebuildable.

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function count(
  connection: DuckDBConnection,
  sql: string,
): Promise<number> {
  const result = await connection.runAndReadAll(sql)
  return Number(result.getRowObjectsJson()[0]?.n ?? 0)
}

export type MinuteFactsResult = {
  rawDays: number
  built: number
  skippedFresh: number
  rowsBuilt: number
}

export async function buildMinuteParquet(
  connection: DuckDBConnection,
  options: { dataDir?: string; force?: boolean } = {},
): Promise<MinuteFactsResult> {
  const dataDir = path.resolve(options.dataDir ?? env.ATM3_DATA_DIR)
  const rawFiles = await connection.runAndReadAll(`
    select cast(market_date as varchar) as market_date, file_path
    from raw.fetches
    where source_id = 'polygon' and dataset = 'minute_aggs'
    order by market_date
  `)
  const days = rawFiles.getRowObjectsJson() as Array<{
    market_date: string
    file_path: string
  }>

  let built = 0
  let skippedFresh = 0
  let rowsBuilt = 0

  for (const day of days) {
    const date = String(day.market_date)
    const rawPath = path.join(dataDir, String(day.file_path))
    const parquetDir = path.join(dataDir, 'facts', 'bars_minute', `date=${date}`)
    const parquetPath = path.join(parquetDir, 'us_stocks.parquet')

    if (existsSync(parquetPath) && !options.force) {
      skippedFresh++
      continue
    }

    await mkdir(parquetDir, { recursive: true })
    const tempPath = `${parquetPath}.tmp`

    // window_start is epoch NANOseconds; integer floor-division keeps exact
    // minute boundaries (a double would lose precision at 1e18).
    await connection.run(`
      copy (
        select
          date ${sqlString(date)} as market_date,
          ticker as symbol,
          to_timestamp(window_start // 1000000000) as window_start_utc,
          cast(open as double) as open,
          cast(high as double) as high,
          cast(low as double) as low,
          cast(close as double) as close,
          cast(volume as double) as volume,
          cast(transactions as bigint) as transactions
        from read_csv(${sqlString(rawPath)}, header = true)
        order by ticker, window_start
      ) to ${sqlString(tempPath)} (format parquet)
    `)

    const rawRows = await count(
      connection,
      `select count(*) as n from read_csv(${sqlString(rawPath)}, header = true)`,
    )
    const parquetRows = await count(
      connection,
      `select count(*) as n from read_parquet(${sqlString(tempPath)})`,
    )

    if (rawRows !== parquetRows) {
      await rm(tempPath, { force: true })
      throw new Error(
        `minute parquet for ${date} lost rows: raw=${rawRows} parquet=${parquetRows}`,
      )
    }

    await rename(tempPath, parquetPath)
    built++
    rowsBuilt += parquetRows

    if (built % 10 === 0) {
      logger.info({ built, lastDate: date }, 'minute parquet progress')
    }
  }

  const result = { rawDays: days.length, built, skippedFresh, rowsBuilt }
  logger.info(result, 'built minute parquet facts')
  return result
}
