import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../server/db.ts'

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
  'ops.runs',
  'ops.schema_migrations',
  'ops.sync_state',
  'ops.unresolved',
  'raw.fetches',
  'raw.sources',
]

test('fresh database applies migrations and reopening is idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-migrations-'))
  const dbPath = path.join(dir, 'atm3.duckdb')

  try {
    const first = await openDatabase({ dbPath })

    try {
      assert.deepEqual(first.appliedMigrations, ['0001_init'])

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
      assert.deepEqual(second.appliedMigrations, [])

      const ledgerResult = await second.connection.runAndReadAll(
        'select migration_id from ops.schema_migrations order by migration_id',
      )
      assert.deepEqual(
        ledgerResult
          .getRowObjectsJson()
          .map((row) => String(row.migration_id)),
        ['0001_init'],
      )

      // Tables stay usable after reopen: write and read back one instrument.
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

test('a failing migration rolls back and leaves no ledger row', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-migrations-bad-'))
  const dbPath = path.join(dir, 'atm3.duckdb')
  const migrationsDir = path.join(dir, 'migrations')

  const emptyMigrationsDir = path.join(dir, 'empty-migrations')

  try {
    await mkdir(migrationsDir, { recursive: true })
    await mkdir(emptyMigrationsDir, { recursive: true })
    await writeFile(
      path.join(migrationsDir, '0001_bad.sql'),
      'create table ops.will_roll_back (id integer); select * from missing_table;',
    )

    await assert.rejects(
      openDatabase({ dbPath, migrationsDir }),
      /Migration 0001_bad failed/,
    )

    const db = await openDatabase({ dbPath, migrationsDir: emptyMigrationsDir })

    try {
      const ledgerResult = await db.connection.runAndReadAll(
        'select migration_id from ops.schema_migrations',
      )
      assert.deepEqual(ledgerResult.getRowObjectsJson(), [])

      const tablesResult = await db.connection.runAndReadAll(`
        select count(*) as table_count
        from information_schema.tables
        where table_schema = 'ops' and table_name = 'will_roll_back'
      `)
      assert.equal(Number(tablesResult.getRowObjectsJson()[0]?.table_count), 0)
    } finally {
      db.closeSync()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
