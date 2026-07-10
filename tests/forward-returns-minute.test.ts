import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { openDatabase, type Atm3Db } from '../server/db.ts'
import { buildMinuteParquet } from '../server/facts-minute.ts'
import { forwardReturnsFromMinute } from '../server/forward-returns-minute.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { A, seedFacts } from './fixtures.ts'

// Forward from an intraday entry. seedFacts: A closes 100 on 2025-01-02 and
// 51 on 2025-01-03 across a 2-for-1 split ex 2025-01-03 — the next_open
// horizon must report the economic +2%, never the raw −49%.
const encoder = new TextEncoder()

function closeTo(actual: number | null, expected: number): void {
  assert.notEqual(actual, null)
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-9,
    `${actual} !~ ${expected}`,
  )
}

function epochNs(date: string, utcHour: number, utcMinute: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${Date.UTC(y, m - 1, d, utcHour, utcMinute) / 1000}000000000`
}

async function landMinuteDay(
  db: Atm3Db,
  dataDir: string,
  date: string,
  rows: string[][],
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
    payload: new Uint8Array(
      gzipSync(
        encoder.encode(
          [
            'ticker,volume,open,close,high,low,window_start,transactions',
            ...rows.map((row) => row.join(',')),
          ].join('\n'),
        ),
      ),
    ),
    storeVerbatim: true,
  })
}

test('minute-entry forward returns: split crossing, paths, edges', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-minute-fwd-'))
  const db = await openDatabase({
    dbPath: path.join(dir, 'atm3.duckdb'),
    dataDir: dir,
  })

  try {
    await seedFacts(db)
    // Calendar: four open days after 2025-01-02 — the 1d target resolves,
    // the 5d target is beyond the known calendar.
    await db.connection.run(`
      insert into facts.exchanges (
        exchange_mic, name, market_scope, calendar_id, timezone, currency
      ) values
        ('XNAS', 'NASDAQ', 'us_stocks', 'us_equities', 'America/New_York', 'USD');
      insert into facts.trading_days (calendar_id, market_date, is_open, source_id)
      select 'us_equities', d, true, 'fixture'
      from unnest([date '2025-01-02', date '2025-01-03', date '2025-01-06',
                   date '2025-01-07', date '2025-01-08']) dates(d)
    `)

    await landMinuteDay(db, dir, '2025-01-02', [
      ['AAA', '1000', '100', '100', '100.5', '99.5', epochNs('2025-01-02', 14, 30), '10'],
      ['AAA', '500', '100', '101', '101', '100', epochNs('2025-01-02', 14, 31), '5'],
      ['AAA', '400', '101', '100.5', '101.5', '99.8', epochNs('2025-01-02', 14, 32), '4'],
    ])
    await landMinuteDay(db, dir, '2025-01-03', [
      ['AAA', '2000', '51', '51', '51.5', '50.5', epochNs('2025-01-03', 14, 30), '20'],
    ])
    await buildMinuteParquet(db.connection, { dataDir: dir })

    const rows = await forwardReturnsFromMinute(db.connection, {
      instrumentId: A,
      marketScope: 'us_stocks',
      date: '2025-01-02',
      minute: '09:31',
    })
    assert.deepEqual(
      rows.map((row) => row.horizon),
      ['to_close', 'next_open', '1d', '5d'],
    )
    const [toClose, nextOpen, d1, d5] = rows

    // Entry = adjusted 09:31 open = 100 * 0.5 = 50 under the 01-03 anchor —
    // identical to raw arithmetic, proving anchor invariance in practice.
    assert.equal(toClose.date, '2025-01-02')
    closeTo(toClose.ret, 100 / 100 - 1) // close(D)=100 vs entry open 100
    closeTo(toClose.mae, 99.8 / 100 - 1) // 09:32 low
    closeTo(toClose.mfe, 101.5 / 100 - 1) // 09:32 high
    assert.equal(toClose.bars_used, 2) // 09:31 entry + 09:32

    // next_open crosses the 2-for-1 split: raw would say 51/100-1 = -49%.
    assert.equal(nextOpen.date, '2025-01-03')
    closeTo(nextOpen.ret, 51 / 50 - 1)
    assert.equal(nextOpen.mae, null)

    // 1d: valuation at the 01-03 close; the path spans the rest of D's
    // session (adjusted lows/highs 49.9/50.75) plus 01-03's flat daily bar
    // (seedFacts writes o=h=l=c=51 there).
    assert.equal(d1.date, '2025-01-03')
    closeTo(d1.ret, 51 / 50 - 1)
    closeTo(d1.mae, 49.9 / 50 - 1) // min(99.8*0.5, 51) = 49.9
    closeTo(d1.mfe, 51 / 50 - 1) // max(101.5*0.5, 51) = 51
    assert.equal(d1.bars_used, 3)
    assert.equal(d1.stale, false)
    assert.equal(d1.delisted, false)

    assert.equal(d5.reason, 'beyond_calendar')
    assert.equal(d5.date, null)

    // T after the session's last bar start: no entry exists.
    const noEntry = await forwardReturnsFromMinute(db.connection, {
      instrumentId: A,
      marketScope: 'us_stocks',
      date: '2025-01-03',
      minute: '09:31',
    })
    assert.ok(noEntry.every((row) => row.reason === 'no_entry_bar'))
  } finally {
    db.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
