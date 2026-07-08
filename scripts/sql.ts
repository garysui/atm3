import { formatTable } from '../core/format.ts'
import { assertReadOnlySql } from '../core/sql-guard.ts'
import { openDatabase } from '../server/db.ts'

// One-shot read-only query against the database, e.g.:
//   npm run sql -- "select * from facts.instruments limit 5"
//   npm run sql -- --limit 100 "from facts.trading_days order by market_date desc"
// Raw payload files are queryable too (read_json/read_csv/read_parquet).
const args = process.argv.slice(2)
let limit = 50
const parts: string[] = []

for (let index = 0; index < args.length; index++) {
  if (args[index] === '--limit') {
    limit = Math.max(1, Math.min(10_000, Number(args[index + 1]) || 50))
    index++
  } else {
    parts.push(args[index])
  }
}

const query = assertReadOnlySql(parts.join(' '))
const db = await openDatabase({ readOnly: true })

try {
  const result = await db.connection.streamAndReadUntil(query, limit + 1)
  const rows = result.getRowObjectsJson() as Array<Record<string, unknown>>
  const truncated = rows.length > limit || !result.done

  console.log(formatTable(rows.slice(0, limit)))
  console.log(
    `\n${Math.min(rows.length, limit)} row(s)${truncated ? ` (truncated at ${limit}; use --limit)` : ''}`,
  )
} finally {
  db.closeSync()
}
