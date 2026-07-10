import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildAllFacts } from '../server/facts-build.ts'
import { landRawFile } from '../server/raw-zone.ts'
import type { Atm3Db } from '../server/db.ts'
import { withTempDatabase } from './helpers.ts'

const soh = '\u0001'

const fields = {
  tradeCal: 'calendar_date, is_trading_day',
  universe: 'code,tradeStatus,code_name',
  basic: 'code, code_name, ipoDate, outDate, type, status',
  daily:
    'date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST',
  dividend:
    'code, dividPreNoticeDate, dividAgmPumDate, dividPlanAnnounceDate, dividPlanDate, dividRegistDate, dividOperateDate, dividPayDate, dividStockMarketDate, dividCashPsBeforeTax, dividCashPsAfterTax, dividStocksPs, dividCashStock, dividReserveToStockPs',
}

function frame(
  method: string,
  records: string[][],
  trailingFields: string[],
): Uint8Array {
  const body = [
    '0',
    '',
    method,
    'anonymous',
    '1',
    '500',
    JSON.stringify({ record: records }),
    ...trailingFields,
  ].join(soh)
  const header = `00.9.20${soh}97${soh}${String(body.length).padStart(10, '0')}`
  assert.equal(header.length, 21)
  return new TextEncoder().encode(header + body)
}

async function landCnFrame(
  db: Atm3Db,
  dataDir: string,
  options: {
    dataset: string
    relativeFilePath: string
    payload: Uint8Array
    marketDate?: string
  },
) {
  await landRawFile({
    connection: db.connection,
    dataDir,
    sourceId: 'baostock',
    dataset: options.dataset,
    requestUrl: `baostock://fixture/${options.dataset}`,
    requestParams: { fixture: true, frame_count: 1 },
    marketScope: 'cn_stocks',
    marketDate: options.marketDate,
    httpStatus: 200,
    relativeFilePath: options.relativeFilePath,
    payload: options.payload,
    rowCount: 1,
    storeVerbatim: true,
  })
}

async function landCnFixture(db: Atm3Db, dataDir: string) {
  await landCnFrame(db, dataDir, {
    dataset: 'trade_cal',
    relativeFilePath:
      'raw/baostock/trade_cal/snapshot_date=2026-07-10/frame-0001.frame',
    payload: frame(
      'query_trade_dates',
      [
        ['2025-01-02', '1'],
        ['2025-01-03', '1'],
        ['2025-01-04', '0'],
        ['2025-01-06', '1'],
      ],
      ['2025-01-02', '2025-01-06', fields.tradeCal],
    ),
  })
  await landCnFrame(db, dataDir, {
    dataset: 'universe',
    marketDate: '2025-01-03',
    relativeFilePath:
      'raw/baostock/universe/snapshot_date=2026-07-10/frame-0001.frame',
    payload: frame(
      'query_all_stock',
      [
        ['sh.600519', '1', 'Moutai'],
        ['sz.300001', '0', 'ST Growth'],
        ['sz.002665', '0', 'Delisted Corp'],
      ],
      ['2025-01-03', fields.universe],
    ),
  })

  const basics = [
    ['sh.600519', 'Moutai', '2001-08-27', '', '1', '1'],
    ['sz.300001', 'ST Growth', '2010-01-01', '', '1', '1'],
    ['sz.002665', 'Delisted Corp', '2012-06-01', '2025-01-04', '1', '0'],
  ]
  for (const row of basics) {
    await landCnFrame(db, dataDir, {
      dataset: 'stock_basic',
      relativeFilePath:
        `raw/baostock/stock_basic/snapshot_date=2026-07-10/code=${row[0]}/frame-0001.frame`,
      payload: frame('query_stock_basic', [row], [row[0]!, '', fields.basic]),
    })
  }
  await landCnFrame(db, dataDir, {
    dataset: 'stock_basic',
    relativeFilePath:
      'raw/baostock/stock_basic/snapshot_date=2026-07-09/code=sz.300001/frame-0001.frame',
    payload: frame(
      'query_stock_basic',
      [['sz.300001', 'Growth Tech', '2010-01-01', '', '1', '1']],
      ['sz.300001', '', fields.basic],
    ),
  })

  const dailyRows = [
    ['2025-01-02', 'sh.600519', '100', '102', '99', '101', '100', '1000', '100500', '3', '1', '1', '1', '0'],
    ['2025-01-03', 'sh.600519', '101', '103', '100', '102', '101', '1100', '112200', '3', '1', '1', '1', '0'],
    ['2025-01-02', 'sz.300001', '10', '10.2', '9.8', '10', '9.9', '2000', '20000', '3', '2', '1', '1', '1'],
    ['2025-01-03', 'sz.300001', '', '', '', '', '10', '0', '0', '3', '', '0', '0', '1'],
    ['2025-01-06', 'sz.300001', '6.5', '6.7', '6.4', '6.6', '10', '3000', '19800', '3', '3', '1', '-34', '1'],
    ['2025-01-02', 'sz.002665', '5', '5.1', '4.9', '5', '5', '500', '2500', '3', '1', '1', '0', '0'],
    ['2025-01-03', 'sz.002665', '5', '5', '4.8', '4.9', '5', '400', '1960', '3', '1', '1', '-2', '0'],
    ['2025-01-02', 'sh.999999', '8', '8.1', '7.9', '8', '8', '100', '800', '3', '1', '1', '0', '0'],
  ]
  await landCnFrame(db, dataDir, {
    dataset: 'daily_k',
    relativeFilePath:
      'raw/baostock/daily_k/code=fixture/window=2025-01-02_2025-01-06/frame-0001.frame',
    payload: frame(
      'query_history_k_data_plus',
      dailyRows,
      ['fixture', fields.daily, '2025-01-02', '2025-01-06', 'd', '3'],
    ),
  })

  const dividendRows = [
    ['sz.300001', '', '2024-12-01', '2024-12-02', '2024-12-10', '2025-01-02', '2025-01-03', '2025-01-03', '2025-01-06', '0.15', '0.12or0.15', '0.2', 'cash+stock', '0.3'],
    ['sh.600519', '', '2024-12-01', '2024-12-02', '2024-12-10', '2025-01-02', '2025-01-03', '2025-01-03', '', '1.0', '0.9or1.0', '0', 'cash', '0'],
    ['sh.999999', '', '2024-12-01', '2024-12-02', '2024-12-10', '2025-01-02', '2025-01-03', '2025-01-03', '', '0.2', '0.18', '0', 'cash', '0'],
  ]
  await landCnFrame(db, dataDir, {
    dataset: 'dividend',
    relativeFilePath:
      'raw/baostock/dividend/code=fixture/year=2025/frame-0001.frame',
    payload: frame(
      'query_dividend_data',
      dividendRows,
      ['fixture', '2025', 'operate', fields.dividend],
    ),
  })
}

test('CN facts rebuild from raw frames with identity, gaps, actions, and quarantine', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-cn-facts-'))
  try {
    await withTempDatabase(async (db) => {
      await landCnFixture(db, dataDir)
      const summary = await buildAllFacts(db.connection, { dataDir })

      assert.equal(summary.cnExchanges, 2)
      assert.equal(summary.cnInstruments, 3)
      assert.equal(summary.cnSymbols, 3)
      assert.equal(summary.cnIdentifiers, 3)
      assert.equal(summary.cnTradingDays, 4)
      assert.equal(summary.cnCorporateActions, 3)
      assert.equal(summary.cnBars, 6)

      const instruments = await db.connection.runAndReadAll(`
        select name, active, cast(delisted_date as varchar) as delisted_date
        from facts.instruments
        where primary_market_scope = 'cn_stocks'
        order by name
      `)
      assert.deepEqual(instruments.getRowObjectsJson(), [
        { name: 'Delisted Corp', active: false, delisted_date: '2025-01-04' },
        { name: 'Moutai', active: true, delisted_date: null },
        { name: 'ST Growth', active: true, delisted_date: null },
      ])

      const nameEvents = await db.connection.runAndReadAll(`
        select event_type, cast(event_date as varchar) as event_date
        from facts.instrument_events where source_id = 'baostock'
      `)
      assert.deepEqual(nameEvents.getRowObjectsJson(), [
        { event_type: 'name_change', event_date: '2026-07-10' },
      ])

      const growthBars = await db.connection.runAndReadAll(`
        select cast(market_date as varchar) as market_date
        from facts.bars_daily
        where market_scope = 'cn_stocks' and symbol_as_traded = '300001'
        order by market_date
      `)
      assert.deepEqual(growthBars.getRowObjectsJson(), [
        { market_date: '2025-01-02' },
        { market_date: '2025-01-06' },
      ])

      const actions = await db.connection.runAndReadAll(`
        select action_type, cash_amount, cash_amount_post_tax,
               bonus_ratio, conversion_ratio, currency
        from facts.corporate_actions
        where market_scope = 'cn_stocks' and symbol_as_stated = '300001'
        order by action_type
      `)
      assert.deepEqual(actions.getRowObjectsJson(), [
        {
          action_type: 'cash_dividend', cash_amount: 0.15,
          cash_amount_post_tax: 0.12, bonus_ratio: null,
          conversion_ratio: null, currency: 'CNY',
        },
        {
          action_type: 'stock_dividend', cash_amount: null,
          cash_amount_post_tax: null, bonus_ratio: 0.2,
          conversion_ratio: 0.3, currency: 'CNY',
        },
      ])

      const unresolved = await db.connection.runAndReadAll(`
        select dataset, symbol, reason
        from ops.unresolved
        where market_scope = 'cn_stocks'
        order by dataset, symbol
      `)
      assert.deepEqual(unresolved.getRowObjectsJson(), [
        { dataset: 'daily_k', symbol: 'sh.999999', reason: 'no_symbol_match' },
        { dataset: 'dividend', symbol: 'sh.999999', reason: 'no_symbol_match' },
      ])

      const before = await db.connection.runAndReadAll(`
        select cast(instrument_id as varchar) as id
        from facts.instruments where primary_market_scope = 'cn_stocks'
        order by id
      `)
      const summaryAgain = await buildAllFacts(db.connection, { dataDir })
      const after = await db.connection.runAndReadAll(`
        select cast(instrument_id as varchar) as id
        from facts.instruments where primary_market_scope = 'cn_stocks'
        order by id
      `)
      assert.deepEqual(after.getRowObjectsJson(), before.getRowObjectsJson())
      assert.deepEqual(summaryAgain, summary)
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
