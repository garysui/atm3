import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { diagnoseCnAdjustments } from '../server/cn-adjustment-diagnostic.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { withTempDatabase } from './helpers.ts'

test('CN vendor-factor diagnostic segments methodology without a residual gate', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-cn-diagnostic-'))
  try {
    await withTempDatabase(async (db) => {
      const instrument = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      const payload = await readFile(
        new URL('./fixtures/baostock/adj_factor-frame-0001.txt', import.meta.url),
      )
      await landRawFile({
        connection: db.connection,
        dataDir,
        sourceId: 'baostock',
        dataset: 'adj_factor',
        requestUrl: 'baostock://fixture/query_adjust_factor',
        requestParams: { fixture: true, frame_count: 1 },
        marketScope: 'cn_stocks',
        httpStatus: 200,
        relativeFilePath:
          'raw/baostock/adj_factor/code=sh.600519/window=2024-07-01_2025-12-31/frame-0001.frame',
        payload,
        rowCount: 3,
        storeVerbatim: true,
      })

      await db.connection.run(`
        insert into facts.instruments (
          instrument_id, asset_class, instrument_type, name,
          primary_market_scope, currency
        ) values (
          cast('${instrument}' as uuid), 'equity', 'common_stock', 'Moutai',
          'cn_stocks', 'CNY'
        );
        insert into facts.instrument_identifiers (
          identifier_type, identifier_value, valid_from, instrument_id,
          source_id
        ) values (
          'baostock_code', 'sh.600519', date '2001-08-27',
          cast('${instrument}' as uuid), 'baostock'
        );
        insert into facts.bars_daily (
          source_id, instrument_id, market_date, market_scope,
          symbol_as_traded, open, high, low, close, volume
        ) values
          ('baostock', cast('${instrument}' as uuid), date '2024-12-19',
           'cn_stocks', '600519', 100, 100, 100, 100, 1000),
          ('baostock', cast('${instrument}' as uuid), date '2025-06-25',
           'cn_stocks', '600519', 100, 100, 100, 100, 1000),
          ('baostock', cast('${instrument}' as uuid), date '2025-12-18',
           'cn_stocks', '600519', 100, 100, 100, 100, 1000);
        insert into facts.corporate_actions (
          source_id, source_action_id, instrument_id, market_scope,
          symbol_as_stated, action_type, ex_date, cash_amount, currency,
          bonus_ratio, conversion_ratio
        ) values
          ('baostock', 'cash-baseline', cast('${instrument}' as uuid),
           'cn_stocks', '600519', 'cash_dividend', date '2024-12-20',
           1, 'CNY', null, null),
          ('baostock', 'cash-comparable', cast('${instrument}' as uuid),
           'cn_stocks', '600519', 'cash_dividend', date '2025-06-26',
           2, 'CNY', null, null),
          ('baostock', 'local-only', cast('${instrument}' as uuid),
           'cn_stocks', '600519', 'stock_dividend', date '2025-07-01',
           null, 'CNY', 0, 0.1),
          ('baostock', 'stock-comparable', cast('${instrument}' as uuid),
           'cn_stocks', '600519', 'stock_dividend', date '2025-12-19',
           null, 'CNY', 0, 0.02)
      `)

      const report = await diagnoseCnAdjustments(db.connection, { dataDir })
      assert.deepEqual(report.staged, {
        vendorFactorRows: 3,
        invalidVendorFactorRows: 0,
      })
      assert.deepEqual(
        report.coverage.map((row) => ({
          comparison_class: row.comparison_class,
          events: Number(row.events),
        })),
        [
          { comparison_class: 'comparable', events: 2 },
          { comparison_class: 'no_vendor_event', events: 1 },
          { comparison_class: 'vendor_baseline', events: 1 },
        ],
      )
      assert.deepEqual(
        report.segments.map((row) => row.action_segment),
        ['cash_only', 'stock_only'],
      )
      assert.equal(report.largestResiduals.length, 2)
      assert.deepEqual(report.invalidVendorRows, [])
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
