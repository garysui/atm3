import type { Row } from '../api.ts'

const literalStringColumns = new Set([
  'symbol',
  'symbol_as_stated',
  'symbol_as_traded',
  'identifier_value',
  'vendor_code',
  'old_symbol',
  'new_symbol',
])

function formatCell(
  column: string,
  value: unknown,
): { text: string; numeric: boolean } {
  if (value === null || value === undefined) {
    return { text: '', numeric: false }
  }

  if (typeof value === 'number') {
    return { text: value.toLocaleString('en-US'), numeric: true }
  }

  if (
    typeof value === 'string' &&
    !literalStringColumns.has(column) &&
    /^-?\d+$/.test(value)
  ) {
    // DuckDB bigints arrive as strings; render them as numbers.
    return { text: Number(value).toLocaleString('en-US'), numeric: true }
  }

  if (typeof value === 'boolean') {
    return { text: value ? 'true' : 'false', numeric: false }
  }

  return { text: String(value), numeric: false }
}

export function DataTable({
  rows,
  onRowClick,
}: {
  rows: Row[]
  onRowClick?: (row: Row) => void
}) {
  if (rows.length === 0) {
    return <p className="muted">(no rows)</p>
  }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]

  return (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={index}
            className={onRowClick ? 'click' : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            {columns.map((column) => {
              const cell = formatCell(column, row[column])
              return (
                <td key={column} className={cell.numeric ? 'num' : undefined}>
                  {cell.text}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
