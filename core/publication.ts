import { addDays } from './dates.ts'

// Publication-aware window cutoffs (review finding #1): "UTC yesterday"
// rolls to the CURRENT US trading day at 20:00 ET, before vendors have
// published anything for it — and minute flat files for day D only appear
// around 04:30 UTC on D+1. Cutoffs are therefore computed in exchange time
// with per-dataset publication lags, as pure functions of `now`.

const etDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const etHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hour12: false,
})

// Grouped daily bars for day D are published the same evening; the safe,
// simple cutoff is "yesterday in ET" — never the still-running/just-closed
// session.
export function latestCompletedTradingDate(now: Date): string {
  return addDays(etDate.format(now), -1)
}

// Minute flat files for day D publish ~00:30 ET on D+1; before 06:00 ET we
// only require D-1 so a nightly run does not demand a file that cannot
// exist yet (it is still fetched opportunistically once published).
export function latestPublishedMinuteDate(now: Date): string {
  const today = etDate.format(now)
  const hour = Number(etHour.format(now)) % 24
  return addDays(today, hour >= 6 ? -1 : -2)
}
