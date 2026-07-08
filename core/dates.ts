// Pure date helpers over ISO `YYYY-MM-DD` strings. All math is UTC-based so
// results never depend on the machine's timezone.

function toUtcMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * 86_400_000)
}

export function addYears(date: string, years: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return fromUtcMs(Date.UTC(year + years, month - 1, day))
}

export function isWeekend(date: string): boolean {
  const dayOfWeek = new Date(toUtcMs(date)).getUTCDay()
  return dayOfWeek === 0 || dayOfWeek === 6
}

// Inclusive on both ends. Weekdays only — holidays are a fact learned from
// data, not something this helper guesses.
export function weekdaysBetween(from: string, to: string): string[] {
  if (from > to) {
    throw new Error(`Invalid date range: ${from} > ${to}`)
  }

  const dates: string[] = []

  for (let ms = toUtcMs(from); ms <= toUtcMs(to); ms += 86_400_000) {
    const date = fromUtcMs(ms)

    if (!isWeekend(date)) {
      dates.push(date)
    }
  }

  return dates
}
