import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, type Atm3Db } from '../server/db.ts'

export async function withTempDatabase<T>(
  fn: (db: Atm3Db) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-test-'))
  const db = await openDatabase({ dbPath: path.join(dir, 'test.duckdb') })

  try {
    return await fn(db)
  } finally {
    db.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
}
