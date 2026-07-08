import { openDatabase, SCHEMA_VERSION } from '../server/db.ts'
import { logger } from '../server/log.ts'

const db = await openDatabase()

const tables = await db.connection.runAndReadAll(`
  select table_schema, count(*) as table_count
  from information_schema.tables
  where table_schema in ('raw', 'facts', 'computed', 'ops')
    and table_type = 'BASE TABLE'
  group by table_schema
  order by table_schema
`)

logger.info(
  {
    dbPath: db.dbPath,
    schemaVersion: SCHEMA_VERSION,
    schemas: tables.getRowObjectsJson(),
  },
  'database ready',
)

db.closeSync()
