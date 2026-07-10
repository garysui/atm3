import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { openDatabase, type Atm3Db } from '../server/db.ts'
import { buildMinuteParquet } from '../server/facts-minute.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { verifyContinuity } from '../server/verify-continuity.ts'
import { seedFacts } from './fixtures.ts'

const encoder = new TextEncoder()

async function landGrouped(
  db: Atm3Db,
  dataDir: string,
  date: string,
  rowCount: number,
): Promise<void> {
  await landRawFile({
    connection: db.connection,
    dataDir,
    sourceId: 'polygon',
    dataset: 'grouped_daily',
    requestUrl: `https://api.polygon.io/grouped/${date}`,
    marketScope: 'us_stocks',
    marketDate: date,
    httpStatus: 200,
    relativeFilePath: `raw/polygon/grouped_daily/date=${date}/us_stocks.json.gz`,
    payload: encoder.encode('{"status":"OK"}'),
    rowCount,
  })
}

test('continuity contract: holes, missing facts, contradicted closures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-continuity-'))
  const db = await openDatabase({
    dbPath: path.join(dir, 'atm3.duckdb'),
    dataDir: dir,
  })

  try {
    await seedFacts(db) // instrument A has facts bars on 01-02, 01-03, 01-06

    // Window 2025-01-02 → 2025-01-08 (five weekdays):
    // 01-02 traded, 01-03 traded, 01-06 MISSING ENTIRELY (the hole),
    // 01-07 zero-row "closure" CONTRADICTED by minute data,
    // 01-08 traded but with no facts bars (build drift).
    await landGrouped(db, dir, '2025-01-02', 100)
    await landGrouped(db, dir, '2025-01-03', 100)
    await landGrouped(db, dir, '2025-01-07', 0)
    await landGrouped(db, dir, '2025-01-08', 100)

    // Minute bars on the claimed closure day.
    await landRawFile({
      connection: db.connection,
      dataDir: dir,
      sourceId: 'polygon',
      dataset: 'minute_aggs',
      requestUrl: 'https://files.massive.com/flatfiles/2025-01-07',
      marketScope: 'us_stocks',
      marketDate: '2025-01-07',
      httpStatus: 200,
      relativeFilePath:
        'raw/polygon/minute_aggs/date=2025-01-07/us_stocks.csv.gz',
      payload: new Uint8Array(
        gzipSync(
          encoder.encode(
            'ticker,volume,open,close,high,low,window_start,transactions\n' +
              'AAA,100,10,10,10,10,1736260200000000000,1',
          ),
        ),
      ),
      storeVerbatim: true,
    })
    await buildMinuteParquet(db.connection, { dataDir: dir })

    const report = await verifyContinuity(db.connection, {
      dailyFrom: '2025-01-02',
      intradayFrom: '2025-01-02',
      to: '2025-01-08',
    })

    assert.equal(report.ok, false)
    assert.deepEqual(report.daily.missingRaw, ['2025-01-06'])
    assert.deepEqual(report.daily.openDaysMissingFacts, ['2025-01-08'])
    assert.deepEqual(report.daily.contradictedClosures, ['2025-01-07'])
    assert.equal(report.daily.expectedWeekdays, 5)
    assert.equal(report.daily.closedDays, 1)
    // Open fetched days without minute coverage are intraday gaps.
    assert.deepEqual(report.intraday.missingRaw, [
      '2025-01-02',
      '2025-01-03',
      '2025-01-08',
    ])

    // A fully covered window reports ok (intraday window not started yet).
    const clean = await verifyContinuity(db.connection, {
      dailyFrom: '2025-01-02',
      intradayFrom: '2025-01-09',
      to: '2025-01-03',
    })
    assert.equal(clean.ok, true)
    assert.equal(clean.daily.coveredDays, 2)
  } finally {
    db.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
