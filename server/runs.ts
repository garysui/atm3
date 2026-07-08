import { randomUUID } from 'node:crypto'
import type { DuckDBConnection } from '@duckdb/node-api'
import { logger } from './log.ts'

// Every job runs inside withRun so ops.runs is a complete history of what
// touched the database, when, and how it ended.
export async function withRun<T>(
  connection: DuckDBConnection,
  job: string,
  params: unknown,
  fn: (runId: string) => Promise<T>,
): Promise<T> {
  const runId = randomUUID()
  await connection.run(
    `
      insert into ops.runs (run_id, job, status, params)
      values (cast($run_id as uuid), $job, 'running', cast($params as json))
    `,
    { run_id: runId, job, params: JSON.stringify(params ?? null) },
  )

  const log = logger.child({ job, runId })
  log.info('run started')

  try {
    const result = await fn(runId)
    await connection.run(
      `
        update ops.runs
        set status = 'ok', finished_at = now()
        where run_id = cast($run_id as uuid)
      `,
      { run_id: runId },
    )
    log.info('run finished')
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await connection.run(
      `
        update ops.runs
        set status = 'failed', finished_at = now(), error = $error
        where run_id = cast($run_id as uuid)
      `,
      { run_id: runId, error: message },
    )
    log.error({ err: error }, 'run failed')
    throw error
  }
}
