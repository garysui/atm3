import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { env } from './env.ts'

// Bump when db/schema.sql changes in a way `create ... if not exists` cannot
// express (column or key changes). The database file is a disposable index
// over data/raw/ — on a version mismatch it is deleted and rebuilt, never
// migrated.
// v2: facts.bars_daily key gained symbol_as_traded (concurrent tape lines).
export const SCHEMA_VERSION = 2

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
}

export function resolveDbPath(dbPath?: string) {
  return path.resolve(dbPath ?? env.ATM3_DUCKDB_PATH)
}

export async function openDatabase(
  options: OpenDatabaseOptions = {},
): Promise<Atm3Db> {
  const dbPath = resolveDbPath(options.dbPath)
  await mkdir(path.dirname(dbPath), { recursive: true })

  const instance = await DuckDBInstance.create(dbPath)
  const connection = await instance.connect()

  try {
    await applySchema(connection, {
      schemaPath: options.schemaPath,
      dbPath,
    })

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

// db/schema.sql is declarative and idempotent: running it at every open
// brings a fresh or existing database to the current shape. It never alters
// existing tables — the database holds nothing that data/raw/ cannot
// reproduce, so incompatible schema changes rebuild the file instead of
// migrating it.
export async function applySchema(
  connection: DuckDBConnection,
  options: { schemaPath?: string; dbPath?: string } = {},
): Promise<void> {
  const sql = await readFile(options.schemaPath ?? defaultSchemaPath, 'utf8')
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
