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
import { A, seedFacts } from './fixtures.ts'

const encoder = new TextEncoder()
const soh = '\u0001'

function dailyFrame(records: string[][]): Uint8Array {
  const body = [
    '0', '', 'query_history_k_data_plus', 'anonymous', '1', '500',
    JSON.stringify({ record: records }),
    'sz.300001',
    'date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST',
  ].join(soh)
  const header = `00.9.20${soh}97${soh}${String(body.length).padStart(10, '0')}`
  return encoder.encode(header + body)
}

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

    // A CN fact on the same date must not satisfy the US market-level check.
    await db.connection.run(`
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values (
        'baostock', cast('${A}' as uuid), date '2025-01-08',
        'cn_stocks', '300001', 10, 10, 10, 10, 100
      )
    `)

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

test('CN continuity accepts suspensions and rejects missing traded facts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-cn-continuity-'))
  const db = await openDatabase({
    dbPath: path.join(dir, 'atm3.duckdb'),
    dataDir: dir,
  })
  const instrument = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  try {
    // Keep the US side of this combined contract clean: every weekday is a
    // stored closure and the intraday window has not started.
    await landGrouped(db, dir, '2025-01-02', 0)
    await landGrouped(db, dir, '2025-01-03', 0)
    await landGrouped(db, dir, '2025-01-06', 0)

    await db.connection.run(`
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, name,
        primary_market_scope, currency
      ) values (
        cast('${instrument}' as uuid), 'equity', 'common_stock', 'CN Fixture',
        'cn_stocks', 'CNY'
      );
      insert into facts.symbols (
        symbol_id, instrument_id, market_scope, symbol, exchange_mic,
        valid_from, is_primary
      ) values (
        cast('dddddddd-dddd-4ddd-8ddd-dddddddddddd' as uuid),
        cast('${instrument}' as uuid), 'cn_stocks', '300001', 'XSHE',
        date '2020-01-01', true
      );
      insert into facts.instrument_identifiers (
        identifier_type, identifier_value, valid_from, instrument_id, source_id
      ) values (
        'baostock_code', 'sz.300001', date '2020-01-01',
        cast('${instrument}' as uuid), 'baostock'
      );
      insert into facts.trading_days (
        calendar_id, market_date, is_open, source_id
      ) values
        ('cn_equities', date '2025-01-02', true, 'baostock'),
        ('cn_equities', date '2025-01-03', true, 'baostock'),
        ('cn_equities', date '2025-01-04', false, 'baostock'),
        ('cn_equities', date '2025-01-05', false, 'baostock'),
        ('cn_equities', date '2025-01-06', true, 'baostock');
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values (
        'baostock', cast('${instrument}' as uuid), date '2025-01-02',
        'cn_stocks', '300001', 10, 10, 10, 10, 100
      )
    `)

    await landRawFile({
      connection: db.connection,
      dataDir: dir,
      sourceId: 'baostock',
      dataset: 'daily_k',
      requestUrl: 'baostock://fixture/query_history_k_data_plus',
      requestParams: {
        code: 'sz.300001',
        start_date: '2025-01-02',
        end_date: '2025-01-06',
        frame_count: 2,
      },
      marketScope: 'cn_stocks',
      httpStatus: 200,
      relativeFilePath:
        'raw/baostock/daily_k/code=sz.300001/window=2025-01-02_2025-01-06/frame-0001.frame',
      payload: dailyFrame([
        ['2025-01-02', 'sz.300001', '10', '10', '10', '10', '10', '100', '1000', '3', '1', '1', '0', '0'],
        ['2025-01-03', 'sz.300001', '', '', '', '', '10', '0', '0', '3', '', '0', '0', '0'],
        ['2025-01-06', 'sz.300001', '11', '11', '11', '11', '10', '120', '1320', '3', '1', '1', '10', '0'],
      ]),
      rowCount: 3,
      storeVerbatim: true,
    })

    const options = {
      dailyFrom: '2025-01-02',
      intradayFrom: '2025-01-07',
      to: '2025-01-06',
      cn: { from: '2025-01-02', to: '2025-01-06', dataDir: dir },
    }
    const report = await verifyContinuity(db.connection, options)
    assert.equal(report.ok, false)
    assert.equal(report.cn?.suspendedRows, 1)
    assert.equal(report.cn?.invalidRawRows, 1)
    assert.equal(report.cn?.rawWindowGaps.length, 1)
    assert.deepEqual(report.cn?.missingRawOpenRows, [])
    assert.deepEqual(report.cn?.factsMissingBars, [
      {
        vendor_code: 'sz.300001',
        missing_dates: '1',
        first_missing: '2025-01-06',
        last_missing: '2025-01-06',
      },
    ])

    await landRawFile({
      connection: db.connection,
      dataDir: dir,
      sourceId: 'baostock',
      dataset: 'daily_k',
      requestUrl: 'baostock://fixture/query_history_k_data_plus',
      requestParams: {
        code: 'sz.300001',
        start_date: '2025-01-02',
        end_date: '2025-01-06',
        frame_count: 2,
      },
      marketScope: 'cn_stocks',
      httpStatus: 200,
      relativeFilePath:
        'raw/baostock/daily_k/code=sz.300001/window=2025-01-02_2025-01-06/frame-0002.frame',
      payload: dailyFrame([]),
      rowCount: 0,
      storeVerbatim: true,
    })
    await db.connection.run(`
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values (
        'baostock', cast('${instrument}' as uuid), date '2025-01-06',
        'cn_stocks', '300001', 11, 11, 11, 11, 120
      )
    `)
    const clean = await verifyContinuity(db.connection, options)
    assert.equal(clean.ok, true)
    assert.equal(clean.cn?.tradedRows, 2)
    assert.equal(clean.cn?.invalidRawRows, 0)
    assert.deepEqual(clean.cn?.rawWindowGaps, [])
    assert.deepEqual(clean.cn?.factsMissingBars, [])
  } finally {
    db.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
