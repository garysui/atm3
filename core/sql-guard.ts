// Guard for SQL that reaches the database through inspection tools: one
// statement, read-only verbs only. Writes belong in builders and ingestion
// jobs, never in ad-hoc queries.

const readablePattern =
  /^\s*(select|with|show|describe|desc|summarize|from|explain|pivot|unpivot)\b/i
const writablePattern =
  /\b(insert|update|delete|drop|create|alter|copy|attach|detach|install|load|call|export|import|vacuum|checkpoint|set|reset|merge|truncate|begin|commit|rollback)\b/i

export function assertReadOnlySql(sql: string): string {
  const query = sql.trim().replace(/;+\s*$/, '').trim()

  if (!query) {
    throw new Error('Enter a SQL query.')
  }

  if (query.includes(';')) {
    throw new Error('Only one SQL statement is allowed.')
  }

  if (!readablePattern.test(query)) {
    throw new Error(
      'Only read-only SQL is allowed (select / with / from / show / describe / summarize / explain).',
    )
  }

  if (writablePattern.test(query)) {
    throw new Error('Write and database-admin statements are not allowed here.')
  }

  return query
}
