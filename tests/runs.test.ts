import assert from 'node:assert/strict'
import test from 'node:test'
import { withRun } from '../server/runs.ts'
import { withTempDatabase } from './helpers.ts'

test('withRun records a successful run', async () => {
  await withTempDatabase(async (db) => {
    const result = await withRun(
      db.connection,
      'test:ok',
      { sample: 1 },
      async () => 'done',
    )
    assert.equal(result, 'done')

    const rowsResult = await db.connection.runAndReadAll(
      `
        select job, status, params, finished_at is not null as finished
        from ops.runs
        where job = $job
      `,
      { job: 'test:ok' },
    )
    const rows = rowsResult.getRowObjectsJson()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'ok')
    assert.equal(rows[0]?.finished, true)
    assert.deepEqual(JSON.parse(String(rows[0]?.params)), { sample: 1 })
  })
})

test('withRun records a failed run and rethrows', async () => {
  await withTempDatabase(async (db) => {
    await assert.rejects(
      withRun(db.connection, 'test:fail', null, async () => {
        throw new Error('boom')
      }),
      /boom/,
    )

    const rowsResult = await db.connection.runAndReadAll(
      `
        select status, error, finished_at is not null as finished
        from ops.runs
        where job = $job
      `,
      { job: 'test:fail' },
    )
    const rows = rowsResult.getRowObjectsJson()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, 'failed')
    assert.equal(rows[0]?.error, 'boom')
    assert.equal(rows[0]?.finished, true)
  })
})
