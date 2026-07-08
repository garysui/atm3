import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertReadOnlySql } from '../core/sql-guard.ts'
import { formatTable } from '../core/format.ts'
import { openDatabase } from '../server/db.ts'
import { collectStatus } from '../server/inspect.ts'

test('assertReadOnlySql accepts read verbs and rejects writes', () => {
  assert.equal(assertReadOnlySql('select 1;'), 'select 1')
  assert.ok(assertReadOnlySql('with x as (select 1) select * from x'))
  assert.ok(assertReadOnlySql('from facts.instruments limit 1'))
  assert.ok(assertReadOnlySql('summarize facts.bars_daily'))

  assert.throws(() => assertReadOnlySql(''), /Enter a SQL query/)
  assert.throws(
    () => assertReadOnlySql('select 1; select 2'),
    /one SQL statement/,
  )
  assert.throws(
    () => assertReadOnlySql('delete from facts.instruments'),
    /read-only/,
  )
  assert.throws(
    () => assertReadOnlySql('select * from x where true or drop table y'),
    /not allowed/,
  )
})

test('formatTable aligns columns and handles empty input', () => {
  assert.equal(formatTable([]), '(no rows)')
  const text = formatTable([
    { name: 'a', n: 1 },
    { name: 'bb', n: 12345 },
  ])
  assert.ok(text.includes('name'))
  assert.ok(text.includes('12,345'))
})

test('read-only open works, blocks writes, and status collects on empty db', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-readonly-'))
  const dbPath = path.join(dir, 'atm3.duckdb')

  try {
    // Initialize, then release the write handle before opening read-only —
    // DuckDB allows one writer OR concurrent readers, never both.
    const writer = await openDatabase({ dbPath })
    writer.closeSync()

    const readOnly = await openDatabase({ dbPath, readOnly: true })

    try {
      const status = await collectStatus(readOnly.connection)
      assert.deepEqual(status.raw, [])
      assert.deepEqual(status.bars, [])
      assert.equal(status.computed.length, 3)

      await assert.rejects(
        readOnly.connection.run(
          "insert into raw.sources (source_id, display_name) values ('x', 'X')",
        ),
        /read-only/i,
      )
    } finally {
      readOnly.closeSync()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('read-only open of a missing database fails with guidance', async () => {
  const missing = path.join(os.tmpdir(), 'atm3-missing-dir', 'atm3.duckdb')
  await assert.rejects(openDatabase({ dbPath: missing, readOnly: true }), /db:init/)
})
