import path from 'node:path'
import type { DuckDBConnection } from '@duckdb/node-api'
import { env } from './env.ts'

export type BuildOptions = {
  dataDir?: string
  // buildAllFacts wraps every builder in one transaction. Standalone
  // builder calls manage their own transaction unless this is false.
  transactional?: boolean
}

export type BuildContext = {
  connection: DuckDBConnection
  rawRoot: string
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function context(
  connection: DuckDBConnection,
  options: BuildOptions,
): BuildContext {
  return {
    connection,
    rawRoot: path.join(path.resolve(options.dataDir ?? env.ATM3_DATA_DIR), 'raw'),
  }
}

export function glob(ctx: BuildContext, relative: string): string {
  return sqlString(path.join(ctx.rawRoot, relative))
}

export async function datasetHasFiles(
  ctx: BuildContext,
  dataset: string,
  sourceId?: string,
): Promise<boolean> {
  const result = sourceId === undefined
    ? await ctx.connection.runAndReadAll(
        'select 1 from raw.fetches where dataset = $dataset limit 1',
        { dataset },
      )
    : await ctx.connection.runAndReadAll(
        `select 1 from raw.fetches
         where dataset = $dataset and source_id = $source_id
         limit 1`,
        { dataset, source_id: sourceId },
      )
  return result.getRowObjectsJson().length > 0
}

export async function count(ctx: BuildContext, sql: string): Promise<number> {
  const result = await ctx.connection.runAndReadAll(sql)
  return Number(result.getRowObjectsJson()[0]?.n ?? 0)
}

export async function inTransaction(
  ctx: BuildContext,
  fn: () => Promise<void>,
  ownTransaction = true,
): Promise<void> {
  if (!ownTransaction) {
    await fn()
    return
  }

  await ctx.connection.run('begin transaction')

  try {
    await fn()
    await ctx.connection.run('commit')
  } catch (error) {
    try {
      await ctx.connection.run('rollback')
    } catch {
      // The failed statement may have already aborted the transaction.
    }
    throw error
  }
}
