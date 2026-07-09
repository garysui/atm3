import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { openDatabase, type Atm3Db } from '../server/db.ts'
import { buildMinuteParquet } from '../server/facts-minute.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { A, seedFacts } from './fixtures.ts'

// A synthetic vendor flat file exercises the whole minute path offline:
// raw csv.gz -> parse-only parquet -> identity at query time -> adjusted
// macro -> quarantine views -> per-day rebuild determinism.
//
// window_start values are epoch NANOSECONDS like the real files.
// 2025-01-02T14:30:00Z = 09:30 ET.
const day1Csv = [
  'ticker,volume,open,close,high,low,window_start,transactions',
  'AAA,1000,100,100,100.5,99.5,1735828200000000000,10',
  'AAA,500,100,101,101,100,1735828260000000000,5',
  // No identity at all on this date: exchange-test-ticker pattern.
  'MYST,50,1,1.1,1.2,0.9,1735828200000000000,2',
  // Symbol EXISTS in facts.symbols but its usage ended 2022 — date-scoped
  // resolution must quarantine it, not match it.
  'AAAOLD,10,9,9,9,9,1735828200000000000,1',
].join('\n')

const day2Csv = [
  'ticker,volume,open,close,high,low,window_start,transactions',
  'AAA,2000,51,51,51.5,50.5,1735914600000000000,20',
].join('\n')

const encoder = new TextEncoder()

async function landMinuteDay(
  db: Atm3Db,
  dataDir: string,
  date: string,
  csv: string,
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
    payload: new Uint8Array(gzipSync(encoder.encode(csv))),
    storeVerbatim: true,
  })
}

test('minute bars: raw -> parquet -> identity view -> adjusted macro -> quarantine', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-minute-'))
  const db = await openDatabase({
    dbPath: path.join(dir, 'atm3.duckdb'),
    dataDir: dir,
  })

  try {
    await seedFacts(db)
    await landMinuteDay(db, dir, '2025-01-02', day1Csv)
    await landMinuteDay(db, dir, '2025-01-03', day2Csv)

    const first = await buildMinuteParquet(db.connection, { dataDir: dir })
    assert.deepEqual(first, {
      rawDays: 2,
      built: 2,
      skippedFresh: 0,
      rowsBuilt: 5,
    })

    // Identity attaches at query time: AAA resolves, MYST (no identity) and
    // AAAOLD (usage ended 2022) are quarantined — visible, never guessed.
    const resolved = await db.connection.runAndReadAll(`
      select cast(instrument_id as varchar) as instrument_id,
             symbol_as_traded,
             cast(market_date as varchar) as market_date,
             strftime(window_start_utc at time zone 'UTC', '%H:%M') as minute_utc,
             close, volume
      from facts.bars_minute
      order by market_date, window_start_utc
    `)
    const rows = resolved.getRowObjectsJson()
    assert.equal(rows.length, 3)
    assert.ok(rows.every((row) => row.instrument_id === A))
    assert.deepEqual(
      rows.map((row) => [row.market_date, row.minute_utc, row.close]),
      [
        ['2025-01-02', '14:30', 100],
        ['2025-01-02', '14:31', 101],
        ['2025-01-03', '14:30', 51],
      ],
    )

    const unresolved = await db.connection.runAndReadAll(`
      select symbol, cast(market_date as varchar) as market_date, bars
      from facts.bars_minute_unresolved
      order by symbol
    `)
    assert.deepEqual(
      unresolved.getRowObjectsJson().map((row) => ({
        symbol: row.symbol,
        market_date: row.market_date,
        bars: Number(row.bars),
      })),
      [
        { symbol: 'AAAOLD', market_date: '2025-01-02', bars: 1 },
        { symbol: 'MYST', market_date: '2025-01-02', bars: 1 },
      ],
    )

    // Adjusted minutes: the day-grained split factor (2:1 ex 2025-01-03)
    // applies to every minute of 01-02, and 01-03 is true to tape.
    const adjusted = await db.connection.runAndReadAll(
      `
        select cast(market_date as varchar) as market_date, close, volume
        from computed.adjusted_bars_minute('split')
        where instrument_id = cast($a as uuid)
        order by window_start_utc
      `,
      { a: A },
    )
    assert.deepEqual(
      adjusted.getRowObjectsJson().map((row) => ({
        market_date: row.market_date,
        close: Number(row.close),
        volume: Number(row.volume),
      })),
      [
        { market_date: '2025-01-02', close: 50, volume: 2000 },
        { market_date: '2025-01-02', close: 50.5, volume: 1000 },
        { market_date: '2025-01-03', close: 51, volume: 2000 },
      ],
    )

    // Single-instrument macro returns identical rows.
    const single = await db.connection.runAndReadAll(
      `
        select count(*) as n, round(sum(close), 6) as close_sum
        from computed.adjusted_bars_minute_for(cast($a as uuid), 'split')
      `,
      { a: A },
    )
    assert.equal(Number(single.getRowObjectsJson()[0]?.n), 3)
    assert.equal(Number(single.getRowObjectsJson()[0]?.close_sum), 151.5)

    // As-of T before the split ex date: the split does not exist yet.
    const asOf = await db.connection.runAndReadAll(
      `
        select close from computed.adjusted_bars_minute('split',
          as_of := date '2025-01-02')
        where instrument_id = cast($a as uuid)
        order by window_start_utc
      `,
      { a: A },
    )
    assert.deepEqual(
      asOf.getRowObjectsJson().map((row) => Number(row.close)),
      [100, 101],
    )

    // Idempotent: nothing rebuilt when parquet exists; force rebuilds to
    // identical content.
    const second = await buildMinuteParquet(db.connection, { dataDir: dir })
    assert.deepEqual(second, {
      rawDays: 2,
      built: 0,
      skippedFresh: 2,
      rowsBuilt: 0,
    })
    const forced = await buildMinuteParquet(db.connection, {
      dataDir: dir,
      force: true,
    })
    assert.equal(forced.built, 2)
    const recheck = await db.connection.runAndReadAll(`
      select count(*) as n, round(sum(close), 6) as close_sum
      from facts.bars_minute_parsed
    `)
    assert.equal(Number(recheck.getRowObjectsJson()[0]?.n), 5)
  } finally {
    db.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
