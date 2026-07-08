// Plain-text table formatting for CLI inspection output.

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toLocaleString('en-US')
  }

  return String(value)
}

function isNumeric(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'bigint'
}

export function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return '(no rows)'
  }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const rightAligned = new Set(
    columns.filter((column) =>
      rows.some((row) => isNumeric(row[column])),
    ),
  )
  const table = [
    columns,
    ...rows.map((row) => columns.map((column) => cell(row[column]))),
  ]
  const widths = columns.map((_, index) =>
    Math.max(...table.map((line) => line[index].length)),
  )

  return table
    .map((line, lineIndex) =>
      line
        .map((text, index) => {
          const width = widths[index]
          const alignRight = lineIndex > 0 && rightAligned.has(columns[index])
          return alignRight ? text.padStart(width) : text.padEnd(width)
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
