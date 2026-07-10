import assert from 'node:assert/strict'
import test from 'node:test'
import {
  forwardReturns,
  ViewAtTDateError,
} from '../server/forward-returns.ts'
import { withTempDatabase } from './helpers.ts'

const US = '11111111-1111-4111-8111-111111111111'
const CN = '22222222-2222-4222-8222-222222222222'
const ENDED = '33333333-3333-4333-8333-333333333333'

function closeTo(actual: number | null, expected: number): void {
  assert.notEqual(actual, null)
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-9,
    `${actual} !~ ${expected}`,
  )
}

test('forward returns are anchor-invariant and hand-check both entry bases', async () => {
  await withTempDatabase(async (db) => {
    await db.connection.run(`
      insert into facts.exchanges (
        exchange_mic, name, market_scope, calendar_id, timezone, currency
      ) values
        ('XNAS', 'NASDAQ', 'us_stocks', 'us_equities', 'America/New_York', 'USD'),
        ('XSHE', 'Shenzhen', 'cn_stocks', 'cn_equities', 'Asia/Shanghai', 'CNY');
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, name,
        primary_market_scope, currency, active, delisted_date
      ) values
        (cast('${US}' as uuid), 'equity', 'common_stock', 'US Fixture', 'us_stocks', 'USD', true, null),
        (cast('${CN}' as uuid), 'equity', 'common_stock', 'CN Fixture', 'cn_stocks', 'CNY', true, null),
        (cast('${ENDED}' as uuid), 'equity', 'common_stock', 'Ended Fixture', 'us_stocks', 'USD', false, date '2025-01-06');
      insert into facts.symbols (
        symbol_id, instrument_id, market_scope, symbol, valid_from, is_primary
      ) values
        (cast('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as uuid), cast('${US}' as uuid), 'us_stocks', 'AAA', date '2020-01-01', true),
        (cast('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as uuid), cast('${CN}' as uuid), 'cn_stocks', '300001', date '2020-01-01', true),
        (cast('cccccccc-cccc-4ccc-8ccc-cccccccccccc' as uuid), cast('${ENDED}' as uuid), 'us_stocks', 'END', date '2020-01-01', true);
      insert into facts.trading_days (calendar_id, market_date, is_open, source_id)
      select 'us_equities', d, true, 'fixture'
      from unnest([date '2025-01-02', date '2025-01-03', date '2025-01-06',
                   date '2025-01-07', date '2025-01-08', date '2025-01-09',
                   date '2025-01-10', date '2025-01-13']) dates(d)
      union all
      select 'cn_equities', d, true, 'fixture'
      from unnest([date '2025-01-02', date '2025-01-03', date '2025-01-06']) dates(d);
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values
        ('polygon', cast('${US}' as uuid), date '2025-01-02', 'us_stocks', 'AAA', 100, 102, 99, 100, 1000),
        ('polygon', cast('${US}' as uuid), date '2025-01-03', 'us_stocks', 'AAA', 51, 53, 50, 52, 2000),
        ('polygon', cast('${US}' as uuid), date '2025-01-06', 'us_stocks', 'AAA', 51, 52, 49, 50, 2100),
        ('polygon', cast('${US}' as uuid), date '2025-01-07', 'us_stocks', 'AAA', 52, 54, 51, 53, 2200),
        ('polygon', cast('${US}' as uuid), date '2025-01-08', 'us_stocks', 'AAA', 54, 55, 53, 54, 2300),
        ('polygon', cast('${US}' as uuid), date '2025-01-09', 'us_stocks', 'AAA', 27, 28, 26, 27, 4600),
        ('polygon', cast('${US}' as uuid), date '2025-01-10', 'us_stocks', 'AAA', 28, 29, 27, 28, 4700),
        ('baostock', cast('${CN}' as uuid), date '2025-01-02', 'cn_stocks', '300001', 10, 10.2, 9.8, 10, 1000),
        ('baostock', cast('${CN}' as uuid), date '2025-01-06', 'cn_stocks', '300001', 11, 11.4, 10.8, 11.2, 1200),
        ('polygon', cast('${ENDED}' as uuid), date '2025-01-02', 'us_stocks', 'END', 20, 20, 20, 20, 100),
        ('polygon', cast('${ENDED}' as uuid), date '2025-01-03', 'us_stocks', 'END', 18, 18, 18, 18, 100);
      insert into facts.corporate_actions (
        source_id, source_action_id, instrument_id, market_scope,
        symbol_as_stated, action_type, ex_date, split_from, split_to,
        cash_amount, currency
      ) values
        ('polygon', 'split-1', cast('${US}' as uuid), 'us_stocks', 'AAA', 'split', date '2025-01-03', 1, 2, null, null),
        ('polygon', 'cash-1', cast('${US}' as uuid), 'us_stocks', 'AAA', 'cash_dividend', date '2025-01-06', null, null, 1, 'USD'),
        ('polygon', 'split-2', cast('${US}' as uuid), 'us_stocks', 'AAA', 'split', date '2025-01-09', 1, 2, null, null)
    `)

    const tClose = await forwardReturns(db.connection, {
      instrumentId: US,
      marketScope: 'us_stocks',
      t: '2025-01-02',
      horizons: [1, 2],
      entryBasis: 't_close',
      policy: 'split_dividend',
      adjustmentAnchor: '2025-01-06',
    })
    // h=1: split economic return = (52 * 2) / 100 - 1 = 0.04.
    closeTo(tClose[0].ret, 0.04)
    assert.equal(tClose[0].bars_used, 2)
    // h=2: entry=100 * .5 * (51/52); exit=50.
    closeTo(tClose[1].ret, 50 / (100 * 0.5 * (51 / 52)) - 1)
    // Path is (E,D]: adjusted lows min(50*51/52, 49) = 49;
    // highs max(53*51/52, 52) = 52 against the same entry.
    closeTo(tClose[1].mae, 49 / (100 * 0.5 * (51 / 52)) - 1)
    closeTo(tClose[1].mfe, 52 / (100 * 0.5 * (51 / 52)) - 1)

    const nextOpen = await forwardReturns(db.connection, {
      instrumentId: US,
      marketScope: 'us_stocks',
      t: '2025-01-02',
      horizons: [1, 2],
      entryBasis: 'next_open',
      policy: 'split_dividend',
      adjustmentAnchor: '2025-01-06',
    })
    // Entry = 51 * 51/52; h=1 close = 52 * 51/52, so 52/51 - 1.
    closeTo(nextOpen[0].ret, 52 / 51 - 1)
    assert.equal(nextOpen[0].mae, null) // Exact path interval is (E, D].
    assert.equal(nextOpen[0].mfe, null)
    closeTo(nextOpen[1].ret, 50 / (51 * (51 / 52)) - 1)
    closeTo(nextOpen[1].mae, 49 / (51 * (51 / 52)) - 1)
    closeTo(nextOpen[1].mfe, 52 / (51 * (51 / 52)) - 1)

    const anchoredAtD = await forwardReturns(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t: '2025-01-02',
      horizons: [2], entryBasis: 'next_open', policy: 'split_dividend',
      adjustmentAnchor: '2025-01-06',
    })
    const anchoredLater = await forwardReturns(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t: '2025-01-02',
      horizons: [2], entryBasis: 'next_open', policy: 'split_dividend',
      adjustmentAnchor: '2025-01-10',
    })
    assert.deepEqual(anchoredLater, anchoredAtD)

    const cn = await forwardReturns(db.connection, {
      instrumentId: CN, marketScope: 'cn_stocks', t: '2025-01-02',
      horizons: [1, 2], entryBasis: 't_close', policy: 'split_dividend',
    })
    assert.equal(cn[0].date, '2025-01-03')
    assert.equal(cn[0].stale, true)
    assert.equal(cn[0].delisted, false)
    assert.equal(cn[1].stale, false)
    closeTo(cn[1].ret, 0.12)

    const delayedEntry = await forwardReturns(db.connection, {
      instrumentId: CN, marketScope: 'cn_stocks', t: '2025-01-02',
      horizons: [1, 2], entryBasis: 'next_open', policy: 'split_dividend',
    })
    assert.equal(delayedEntry[0].reason, 'no_entry_bar')
    closeTo(delayedEntry[1].ret, 11.2 / 11 - 1)

    // Delisted comes from identity (delisted_date <= horizon), never from
    // missing bars.
    const ended = await forwardReturns(db.connection, {
      instrumentId: ENDED, marketScope: 'us_stocks', t: '2025-01-02',
      horizons: [2], entryBasis: 't_close', policy: 'split_dividend',
    })
    assert.equal(ended[0].date, '2025-01-06')
    assert.equal(ended[0].delisted, true)
    assert.equal(ended[0].stale, false)
    closeTo(ended[0].ret, -0.1)

    // A horizon past the last KNOWN bar of a live instrument is a stale
    // carried valuation — the future has not happened; nothing is delisted.
    const beyondData = await forwardReturns(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t: '2025-01-09',
      horizons: [1, 2], entryBasis: 't_close', policy: 'split_dividend',
    })
    assert.equal(beyondData[0].date, '2025-01-10')
    assert.equal(beyondData[0].stale, false)
    assert.equal(beyondData[1].date, '2025-01-13') // covered by the calendar
    assert.equal(beyondData[1].stale, true) // valuation carried from 01-10
    assert.equal(beyondData[1].delisted, false)
    closeTo(beyondData[1].ret, 28 / 27 - 1)

    // Horizons past the known calendar are per-row results, not a wholesale
    // failure: near horizons still resolve at a recent T.
    const partial = await forwardReturns(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t: '2025-01-02',
      horizons: [1, 99], entryBasis: 't_close', policy: 'split_dividend',
      adjustmentAnchor: '2025-01-10',
    })
    closeTo(partial[0].ret, 0.04)
    assert.deepEqual(partial[1], {
      horizon: 99,
      date: null,
      ret: null,
      mae: null,
      mfe: null,
      delisted: false,
      stale: false,
      bars_used: 0,
      reason: 'beyond_calendar',
    })
    const allBeyond = await forwardReturns(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t: '2025-01-10',
      horizons: [5], entryBasis: 't_close', policy: 'split_dividend',
    })
    assert.equal(allBeyond[0].reason, 'beyond_calendar')

    const noEntry = await forwardReturns(db.connection, {
      instrumentId: ENDED, marketScope: 'us_stocks', t: '2025-01-03',
      horizons: [1], entryBasis: 'next_open', policy: 'split_dividend',
    })
    assert.deepEqual(noEntry[0], {
      horizon: 1,
      date: '2025-01-06',
      ret: null,
      mae: null,
      mfe: null,
      delisted: false,
      stale: false,
      bars_used: 0,
      reason: 'no_entry_bar',
    })

    await assert.rejects(
      forwardReturns(db.connection, {
        instrumentId: US, marketScope: 'us_stocks', t: '2025-01-04',
        horizons: [1], policy: 'split_dividend',
      }),
      (error: unknown) =>
        error instanceof ViewAtTDateError &&
        error.previousDate === '2025-01-03' &&
        error.nextDate === '2025-01-06',
    )
  })
})
