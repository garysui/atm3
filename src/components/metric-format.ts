export function formatValue(value: number | string | boolean | null): string {
  if (value === null) return '-'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '-'
    if (value === 0) return '0'
    return Math.abs(value) >= 1000 || Math.abs(value) < 0.0001
      ? value.toExponential(5)
      : value.toPrecision(7)
  }
  return value
}

export function formatPercent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(3)}%`
}
