import { existsSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { env } from './env.ts'

// Bump when db/schema.sql changes in a way `create ... if not exists` cannot
// express (column or key changes). The database file is a disposable index
// over data/raw/ — on a version mismatch it is deleted and rebuilt, never
// migrated.
// v2: facts.bars_daily key gained symbol_as_traded (concurrent tape lines).
// v3: computed layer became algorithm-first — adjusted bars are the
//     computed.adjusted_bars(policy, as_of) table macro over facts; the only
//     table is the optional bars_daily_adjusted_cache snapshot.
export const SCHEMA_VERSION = 3

const defaultSchemaPath = fileURLToPath(
  new URL('../db/schema.sql', import.meta.url),
)

export type Atm3Db = {
  connection: DuckDBConnection
  dbPath: string
  instance: DuckDBInstance
  closeSync(): void
}

export type OpenDatabaseOptions = {
  dbPath?: string
  schemaPath?: string
  // Root of the local data tree; the schema's file-backed views (minute
  // parquet) are bound to it at apply time. Defaults to ATM3_DATA_DIR.
  dataDir?: string
  // Read-only opens never apply the schema and cannot write — used by
  // inspection tools (npm run status / npm run sql).
  readOnly?: boolean
}

export function resolveDbPath(dbPath?: string) {
  return path.resolve(dbPath ?? env.ATM3_DUCKDB_PATH)
}

export async function openDatabase(
  options: OpenDatabaseOptions = {},
): Promise<Atm3Db> {
  const dbPath = resolveDbPath(options.dbPath)

  if (!options.readOnly) {
    await mkdir(path.dirname(dbPath), { recursive: true })
  }

  let instance: DuckDBInstance

  try {
    instance = options.readOnly
      ? await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' })
      : await DuckDBInstance.create(dbPath)
  } catch (error) {
    if (options.readOnly) {
      throw new Error(
        `Cannot open ${dbPath} read-only — does it exist? Run: npm run db:init`,
        { cause: error },
      )
    }
    throw error
  }

  const connection = await instance.connect()

  try {
    if (options.readOnly) {
      await checkSchemaVersion(connection, dbPath)
    } else {
      await applySchema(connection, {
        schemaPath: options.schemaPath,
        dbPath,
        dataDir: options.dataDir,
      })
    }

    return {
      connection,
      dbPath,
      instance,
      closeSync() {
        connection.closeSync()
        instance.closeSync()
      },
    }
  } catch (error) {
    connection.closeSync()
    instance.closeSync()
    throw error
  }
}

async function checkSchemaVersion(
  connection: DuckDBConnection,
  dbPath: string,
): Promise<void> {
  let stored: number | null

  try {
    const result = await connection.runAndReadAll(
      `select value from ops.meta where key = 'schema_version'`,
    )
    const row = result.getRowObjectsJson()[0]
    stored = row === undefined ? null : Number(row.value)
  } catch {
    stored = null
  }

  if (stored === null) {
    throw new Error(`${dbPath} is not initialized. Run: npm run db:init`)
  }

  if (stored !== SCHEMA_VERSION) {
    throw new Error(
      `${dbPath} has schema version ${stored}; this code expects ` +
        `${SCHEMA_VERSION}. The database is a disposable index over the raw ` +
        `zone: delete the file and rerun to rebuild it from data/raw/.`,
    )
  }
}

async function ensureMinuteSentinel(
  connection: DuckDBConnection,
  dataDir: string,
): Promise<void> {
  const sentinelPath = path.join(
    dataDir,
    'facts',
    'bars_minute',
    '_sentinel',
    'sentinel.parquet',
  )

  if (existsSync(sentinelPath)) {
    return
  }

  await mkdir(path.dirname(sentinelPath), { recursive: true })
  // Concurrent opens may race here: write to a unique temp name and rename
  // (identical zero-row content — last writer wins harmlessly).
  const tempPath = `${sentinelPath}.${process.pid}.tmp`
  await connection.run(`
    copy (
      select
        cast(null as date) as market_date,
        cast(null as varchar) as symbol,
        cast(null as timestamptz) as window_start_utc,
        cast(null as double) as open,
        cast(null as double) as high,
        cast(null as double) as low,
        cast(null as double) as close,
        cast(null as double) as volume,
        cast(null as bigint) as transactions
      where false
    ) to '${tempPath.replaceAll("'", "''")}' (format parquet)
  `)
  await rename(tempPath, sentinelPath)
}

// db/schema.sql is declarative and idempotent: running it at every open
// brings a fresh or existing database to the current shape. It never alters
// existing tables — the database holds nothing that data/raw/ cannot
// reproduce, so incompatible schema changes rebuild the file instead of
// migrating it.
export async function applySchema(
  connection: DuckDBConnection,
  options: { schemaPath?: string; dbPath?: string; dataDir?: string } = {},
): Promise<void> {
  const dataDir = path.resolve(options.dataDir ?? env.ATM3_DATA_DIR)
  // File-backed views (minute parquet) validate their glob at CREATE VIEW
  // time — a zero-row sentinel guarantees the glob always binds, even on a
  // machine with no minute data yet.
  await ensureMinuteSentinel(connection, dataDir)

  const sql = (
    await readFile(options.schemaPath ?? defaultSchemaPath, 'utf8')
  ).replaceAll('__ATM3_DATA_DIR__', dataDir.replaceAll("'", "''"))
  await connection.run(sql)

  const versionResult = await connection.runAndReadAll(
    `select value from ops.meta where key = 'schema_version'`,
  )
  const storedRow = versionResult.getRowObjectsJson()[0]

  if (storedRow === undefined) {
    await connection.run(
      `insert into ops.meta (key, value) values ('schema_version', $value)`,
      { value: String(SCHEMA_VERSION) },
    )
    return
  }

  const storedVersion = Number(storedRow.value)

  if (storedVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${options.dbPath ?? 'The database'} has schema version ${storedVersion}; ` +
        `this code expects ${SCHEMA_VERSION}. The database is a disposable ` +
        `index over the raw zone: delete the file and rerun to rebuild it ` +
        `from data/raw/.`,
    )
  }
}
