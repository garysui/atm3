import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { env } from './env.ts'
import { logger } from './log.ts'

const defaultMigrationsDir = fileURLToPath(
  new URL('../db/migrations', import.meta.url),
)
const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/

export type Atm3Db = {
  connection: DuckDBConnection
  dbPath: string
  instance: DuckDBInstance
  appliedMigrations: string[]
  closeSync(): void
}

export type OpenDatabaseOptions = {
  dbPath?: string
  migrationsDir?: string
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
    const appliedMigrations = await applyMigrations(
      connection,
      options.migrationsDir ?? defaultMigrationsDir,
    )

    return {
      connection,
      dbPath,
      instance,
      appliedMigrations,
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

// Numbered run-once migrations. Each migration file runs inside a transaction
// together with its ledger insert, so a crash mid-migration rolls back to the
// pre-migration state. Never edit an applied migration; add a new one.
export async function applyMigrations(
  connection: DuckDBConnection,
  migrationsDir = defaultMigrationsDir,
): Promise<string[]> {
  await connection.run('create schema if not exists ops')
  await connection.run(`
    create table if not exists ops.schema_migrations (
      migration_id varchar primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const files = (await readdir(migrationsDir))
    .filter((file) => migrationFilePattern.test(file))
    .sort()
  const appliedResult = await connection.runAndReadAll(
    'select migration_id from ops.schema_migrations',
  )
  const applied = new Set(
    appliedResult.getRowObjectsJson().map((row) => String(row.migration_id)),
  )
  const appliedNow: string[] = []

  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, '')

    if (applied.has(migrationId)) {
      continue
    }

    const sql = await readFile(path.join(migrationsDir, file), 'utf8')
    await connection.run('begin transaction')

    try {
      await connection.run(sql)
      await connection.run(
        'insert into ops.schema_migrations (migration_id) values ($migration_id)',
        { migration_id: migrationId },
      )
      await connection.run('commit')
    } catch (error) {
      try {
        await connection.run('rollback')
      } catch {
        // The failed statement may have already aborted the transaction.
      }
      throw new Error(
        `Migration ${migrationId} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    logger.info({ migrationId }, 'applied migration')
    appliedNow.push(migrationId)
  }

  return appliedNow
}
