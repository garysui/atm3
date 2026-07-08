import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase, SCHEMA_VERSION } from '../server/db.ts'

const expectedTables = [
  'computed.adjustment_factors',
  'computed.bars_daily_adjusted',
  'computed.build_state',
  'facts.bars_daily',
  'facts.corporate_actions',
  'facts.exchanges',
  'facts.instrument_events',
  'facts.instrument_identifiers',
  'facts.instruments',
  'facts.symbol_events',
  'facts.symbols',
  'facts.trading_days',
  'ops.meta',
  'ops.runs',
  'ops.sync_state',
  'ops.unresolved',
  'raw.fetches',
  'raw.sources',
]

test('fresh database gets the full schema and reopening is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-schema-'))
  const dbPath = path.join(dir, 'atm3.duckdb')

  try {
    const first = await openDatabase({ dbPath })

    try {
      const tablesResult = await first.connection.runAndReadAll(`
        select table_schema || '.' || table_name as table_id
        from information_schema.tables
        where table_schema in ('raw', 'facts', 'computed', 'ops')
          and table_type = 'BASE TABLE'
        order by table_id
      `)
      const tableIds = tablesResult
        .getRowObjectsJson()
        .map((row) => String(row.table_id))
      assert.deepEqual(tableIds, expectedTables)

      const versionResult = await first.connection.runAndReadAll(
        `select value from ops.meta where key = 'schema_version'`,
      )
      assert.equal(
        Number(versionResult.getRowObjectsJson()[0]?.value),
        SCHEMA_VERSION,
      )

      const sourcesResult = await first.connection.runAndReadAll(
        'select source_id from raw.sources order by source_id',
      )
      assert.deepEqual(
        sourcesResult.getRowObjectsJson().map((row) => String(row.source_id)),
        ['benzinga', 'cboe', 'polygon', 'sec', 'tushare'],
      )
    } finally {
      first.closeSync()
    }

    const second = await openDatabase({ dbPath })

    try {
      // Reopen re-runs the idempotent schema: still one version row, seeds
      // not duplicated, tables usable.
      const metaResult = await second.connection.runAndReadAll(
        'select count(*) as meta_rows from ops.meta',
      )
      assert.equal(Number(metaResult.getRowObjectsJson()[0]?.meta_rows), 1)

      const sourcesResult = await second.connection.runAndReadAll(
        'select count(*) as source_rows from raw.sources',
      )
      assert.equal(Number(sourcesResult.getRowObjectsJson()[0]?.source_rows), 5)

      await second.connection.run(
        `
          insert into facts.instruments (
            instrument_id, asset_class, instrument_type, name,
            primary_market_scope
          )
          values (
            cast($instrument_id as uuid), 'equity', 'common_stock',
            'Test Instrument', 'us_stocks'
          )
        `,
        { instrument_id: '00000000-0000-0000-0000-000000000001' },
      )
      const instrumentsResult = await second.connection.runAndReadAll(
        'select count(*) as instrument_count from facts.instruments',
      )
      assert.equal(
        Number(instrumentsResult.getRowObjectsJson()[0]?.instrument_count),
        1,
      )
    } finally {
      second.closeSync()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a database from a different schema version refuses to open', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-schema-version-'))
  const dbPath = path.join(dir, 'atm3.duckdb')

  try {
    const db = await openDatabase({ dbPath })

    try {
      await db.connection.run(
        `update ops.meta set value = '999' where key = 'schema_version'`,
      )
    } finally {
      db.closeSync()
    }

    await assert.rejects(
      openDatabase({ dbPath }),
      /schema version 999.*expects 1.*disposable/s,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
