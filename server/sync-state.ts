import type { DuckDBConnection } from '@duckdb/node-api'

export async function isSyncComplete(
  connection: DuckDBConnection,
  job: string,
  scope: string,
): Promise<boolean> {
  const result = await connection.runAndReadAll(
    `
      select 1
      from ops.sync_state
      where job = $job and scope = $scope and last_success_date is not null
      limit 1
    `,
    { job, scope },
  )

  return result.getRowObjectsJson().length > 0
}

export async function markSyncComplete(
  connection: DuckDBConnection,
  job: string,
  scope: string,
  successDate: string,
): Promise<void> {
  await connection.run(
    `
      insert or replace into ops.sync_state (
        job, scope, last_success_date, updated_at
      ) values ($job, $scope, cast($success_date as date), now())
    `,
    { job, scope, success_date: successDate },
  )
}
