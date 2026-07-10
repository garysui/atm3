import assert from 'node:assert/strict'
import test from 'node:test'
import { adjustedReturnSeries } from '../server/return-series.ts'
import { A, seedFacts } from './fixtures.ts'
import { withTempDatabase } from './helpers.ts'

test('one return-series function serves US and CN with the same schema', async () => {
  await withTempDatabase(async (db) => {
    await seedFacts(db)
    const cn = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    await db.connection.run(`
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, name,
        primary_market_scope, currency
      ) values (
        cast('${cn}' as uuid), 'equity', 'common_stock', 'CN Fixture',
        'cn_stocks', 'CNY'
      );
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values
        ('baostock', cast('${cn}' as uuid), date '2025-01-02',
         'cn_stocks', '300001', 10, 10, 10, 10, 100),
        ('baostock', cast('${cn}' as uuid), date '2025-01-03',
         'cn_stocks', '300001', 11, 11, 11, 11, 100),
        ('baostock', cast('${cn}' as uuid), date '2025-01-06',
         'cn_stocks', '300001', 12, 12, 12, 12, 100)
    `)

    const common = { observations: 3, policy: 'split_dividend' as const }
    const us = await adjustedReturnSeries(db.connection, {
      ...common,
      instrumentId: A,
      marketScope: 'us_stocks',
    })
    const china = await adjustedReturnSeries(db.connection, {
      ...common,
      instrumentId: cn,
      marketScope: 'cn_stocks',
    })

    assert.deepEqual(Object.keys(us[0]), Object.keys(china[0]))
    assert.equal(us.length, 3)
    assert.equal(china.length, 3)
    assert.equal(china[0].return_from_start, 0)
    assert.ok(Math.abs(china[2].return_from_start - 0.2) < 1e-12)
    assert.deepEqual(
      await adjustedReturnSeries(db.connection, {
        ...common,
        instrumentId: cn,
        marketScope: 'us_stocks',
      }),
      [],
    )
  })
})
