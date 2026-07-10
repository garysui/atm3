import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { sessionMetricsCatalog } from '../core/metrics-catalog.ts'
import { openDatabase, type Atm3Db } from '../server/db.ts'
import { buildMinuteParquet } from '../server/facts-minute.ts'
import {
  sessionMetricsAt,
  ViewAtMinuteDateError,
  type SessionMetricAt,
} from '../server/metrics-at-minute.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { A, seedFacts } from './fixtures.ts'

// Session view at minute T. seedFacts gives instrument A daily bars on
// 2025-01-02 (close 100), 2025-01-03 (close 51), 2025-01-06 (close 52) and a
// 2-for-1 split ex 2025-01-03 — so day 2 minutes sit ON an ex-date and the
// gap must be economic, not the raw −49%.
const encoder = new TextEncoder()

function closeTo(actual: unknown, expected: number): void {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-9,
    `${actual} !~ ${expected}`,
  )
}

function epochNs(date: string, utcHour: number, utcMinute: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${Date.UTC(y, m - 1, d, utcHour, utcMinute) / 1000}000000000`
}

function csv(rows: string[][]): string {
  return [
    'ticker,volume,open,close,high,low,window_start,transactions',
    ...rows.map((row) => row.join(',')),
  ].join('\n')
}

async function landMinuteDay(
  db: Atm3Db,
  dataDir: string,
  date: string,
  body: string,
): Promise<void> {
  await landRawFile({
    connection: db.connection,
    dataDir,
    sourceId: 'polygon',
    dataset: 'minute_aggs',
    requestUrl: `https://files.massive.com/flatfiles/${date}`,
    marketScope: 'us_stocks',
    marketDate: date,
    httpStatus: 200,
    relativeFilePath: `raw/polygon/minute_aggs/date=${date}/us_stocks.csv.gz`,
    payload: new Uint8Array(gzipSync(encoder.encode(body))),
    storeVerbatim: true,
  })
}

function byId(metrics: SessionMetricAt[]): Map<string, SessionMetricAt> {
  return new Map(metrics.map((metric) => [metric.id, metric]))
}

test('session metrics at minute T: visibility, RTH, adjusted gap, pace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-minute-t-'))
  const db = await openDatabase({
    dbPath: path.join(dir, 'atm3.duckdb'),
    dataDir: dir,
  })

  try {
    await seedFacts(db)

    // Five thin prior sessions so rvol_pace has history: one 09:30 bar each,
    // dollar volume 100 * 1000 = 100000. 09:30 ET = 14:30 UTC in winter.
    for (const date of [
      '2024-12-24', '2024-12-26', '2024-12-27', '2024-12-30', '2024-12-31',
    ]) {
      await landMinuteDay(db, dir, date, csv([
        ['AAA', '1000', '100', '100', '100.5', '99.5', epochNs(date, 14, 30), '5'],
      ]))
    }
    // Day 1 (2025-01-02): a 09:00 pre-market bar that RTH must exclude, then
    // three regular minutes. Cutoff dollar volume before 09:33:
    // 100*1000 + 101*500 + 100.5*400 = 190700.
    await landMinuteDay(db, dir, '2025-01-02', csv([
      ['AAA', '9999', '99', '99', '99', '99', epochNs('2025-01-02', 14, 0), '1'],
      ['AAA', '1000', '100', '100', '100.5', '99.5', epochNs('2025-01-02', 14, 30), '10'],
      ['AAA', '500', '100', '101', '101', '100', epochNs('2025-01-02', 14, 31), '5'],
      ['AAA', '400', '101', '100.5', '101.5', '100', epochNs('2025-01-02', 14, 32), '4'],
    ]))
    // Day 2 (2025-01-03, the split ex-date): post-split prices near 51.
    await landMinuteDay(db, dir, '2025-01-03', csv([
      ['AAA', '2000', '51', '51', '51.5', '50.5', epochNs('2025-01-03', 14, 30), '20'],
      ['AAA', '1000', '51', '51.5', '51.6', '50.9', epochNs('2025-01-03', 14, 31), '10'],
      ['AAA', '800', '51.5', '50.8', '51.7', '50.7', epochNs('2025-01-03', 14, 32), '8'],
    ]))
    await buildMinuteParquet(db.connection, { dataDir: dir })

    const at = (minute: string) =>
      sessionMetricsAt(db.connection, {
        instrumentId: A,
        marketScope: 'us_stocks',
        date: '2025-01-03',
        minute,
      })

    const report = await at('09:33')
    assert.equal(report.visible_bars, 3)
    assert.equal(report.prev_close_date, '2025-01-02')
    assert.equal(report.prior_sessions, 6)
    assert.equal(
      report.metrics.map((metric) => metric.id).join(','),
      sessionMetricsCatalog.map((definition) => definition.id).join(','),
    )
    const m = byId(report.metrics)

    closeTo(m.get('last_price')?.value, 50.8)
    closeTo(m.get('minutes_since_open')?.value, 3)
    closeTo(m.get('session_fraction')?.value, 3 / 390)
    // Previous adjusted close as of the ex-date is 100 * 0.5 = 50: the gap is
    // the economic +2%, never the raw 51/100 - 1 = -49%.
    closeTo(m.get('gap_at_open')?.value, 51 / 50 - 1)
    closeTo(m.get('ret_from_prev_close')?.value, 50.8 / 50 - 1)
    closeTo(m.get('session_ret')?.value, 50.8 / 51 - 1)
    // VWAP from typical price (h+l+c)/3, cumulative:
    // (51*2000 + (154/3)*1000 + (153.2/3)*800) / 3800.
    const vwap =
      (51 * 2000 + (154 / 3) * 1000 + (153.2 / 3) * 800) / 3800
    closeTo(m.get('vwap_dist')?.value, 50.8 / vwap - 1)
    closeTo(m.get('session_range_pos')?.value, (50.8 - 50.5) / (51.7 - 50.5))
    closeTo(m.get('session_high_dist')?.value, 50.8 / 51.7 - 1)
    closeTo(m.get('session_low_dist')?.value, 50.8 / 50.5 - 1)
    closeTo(m.get('range_pct_so_far')?.value, (51.7 - 50.5) / 50)
    closeTo(
      m.get('cum_dollar_volume')?.value,
      51 * 2000 + 51.5 * 1000 + 50.8 * 800,
    )
    // Same-cutoff pace: today 194140 versus the mean of five 100000 sessions
    // plus day 1's 190700.
    closeTo(
      m.get('rvol_pace')?.value,
      (51 * 2000 + 51.5 * 1000 + 50.8 * 800) /
        ((5 * 100000 + 190700) / 6),
    )
    // Too few visible bars for the windowed metrics — null with the reason.
    for (const id of ['ret_30m', 'ret_60m', 'session_vol', 'up_minutes_share']) {
      assert.equal(m.get(id)?.value, null)
      assert.equal(m.get(id)?.reason, 'insufficient_window')
    }

    // Visibility: at 09:32 the 09:32 bar is still in progress.
    const earlier = await at('09:32')
    assert.equal(earlier.visible_bars, 2)
    closeTo(byId(earlier.metrics).get('last_price')?.value, 51.5)

    // The pre-market bar never counts: day 1 at 09:31 sees exactly one bar.
    const day1 = await sessionMetricsAt(db.connection, {
      instrumentId: A,
      marketScope: 'us_stocks',
      date: '2025-01-02',
      minute: '09:31',
    })
    assert.equal(day1.visible_bars, 1)
    closeTo(byId(day1.metrics).get('last_price')?.value, 100)
    // Pace with fewer than five prior sessions stays honest.
    assert.equal(byId(day1.metrics).get('rvol_pace')?.reason, null)
    const paceOnDec26 = await sessionMetricsAt(db.connection, {
      instrumentId: A,
      marketScope: 'us_stocks',
      date: '2024-12-26',
      minute: '09:31',
    })
    assert.equal(
      byId(paceOnDec26.metrics).get('rvol_pace')?.reason,
      'insufficient_window',
    )

    // T at or before the session open is an explicit error.
    await assert.rejects(at('09:30'), /precedes the first complete session/)
    // A date without minute coverage names its neighbors.
    await assert.rejects(
      sessionMetricsAt(db.connection, {
        instrumentId: A,
        marketScope: 'us_stocks',
        date: '2025-01-06',
        minute: '10:00',
      }),
      (error: unknown) =>
        error instanceof ViewAtMinuteDateError &&
        error.previousDate === '2025-01-03' &&
        error.nextDate === null,
    )
    // Scopes without a minute source are explicit, not empty.
    await assert.rejects(
      sessionMetricsAt(db.connection, {
        instrumentId: A,
        marketScope: 'cn_stocks',
        date: '2025-01-03',
        minute: '10:00',
      }),
      /no minute data source/,
    )
  } finally {
    db.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
