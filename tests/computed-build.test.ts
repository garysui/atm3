import assert from 'node:assert/strict'
import test from 'node:test'
import type { Atm3Db } from '../server/db.ts'
import { buildComputed } from '../server/computed-build.ts'
import { withTempDatabase } from './helpers.ts'

// Facts are seeded directly (the computed layer's contract is facts, not
// raw). Instrument A exercises the factor math; instrument B exercises the
// canonical-line choice and the skip counters.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const closeTo = (actual: unknown, expected: number) => {
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-9,
    `${actual} !~ ${expected}`,
  )
}

async function seedFacts(db: Atm3Db): Promise<void> {
  for (const [id, name] of [
    [A, 'Alpha Corp'],
    [B, 'Beta Corp'],
  ]) {
    await db.connection.run(
      `
        insert into facts.instruments (
          instrument_id, asset_class, instrument_type, name,
          primary_market_scope
        ) values (cast($id as uuid), 'equity', 'common_stock', $name,
                  'us_stocks')
      `,
      { id, name },
    )
  }

  const bars: Array<[string, string, string, number, number]> = [
    // [instrument, date, symbol, close, volume]
    [A, '2025-01-02', 'AAA', 100, 1000],
    [A, '2025-01-03', 'AAA', 51, 2000],
    [A, '2025-01-06', 'AAA', 52, 2100],
    // B trades as two concurrent lines on 01-02: canon = max volume (BBBW).
    [B, '2025-01-02', 'BBB', 10, 100],
    [B, '2025-01-02', 'BBBW', 11, 900],
  ]

  for (const [instrument, date, symbol, close, volume] of bars) {
    await db.connection.run(
      `
        insert into facts.bars_daily (
          source_id, instrument_id, market_date, market_scope,
          symbol_as_traded, open, high, low, close, volume, vwap
        ) values (
          'polygon', cast($instrument as uuid), cast($date as date),
          'us_stocks', $symbol, $close, $close, $close, $close, $volume,
          $close
        )
      `,
      { instrument, date, symbol, close, volume },
    )
  }

  type Action = {
    id: string
    instrument: string
    symbol: string
    type: string
    exDate: string
    splitFrom?: number
    splitTo?: number
    cash?: number
    currency?: string
    dividendType?: string
  }
  const actions: Action[] = [
    // 2-for-1 split on 01-03: prices before halve, volumes double.
    { id: 's1', instrument: A, symbol: 'AAA', type: 'split', exDate: '2025-01-03', splitFrom: 1, splitTo: 2 },
    // The SAME split stated again under another ticker (rename pattern):
    // must collapse to one factor, never compound to 0.25.
    { id: 's2', instrument: A, symbol: 'AAAOLD', type: 'split', exDate: '2025-01-03', splitFrom: 1, splitTo: 2 },
    // Two same-day DISTINCT dividends on 01-06 (regular + special): cash
    // SUMS to 1.0 against prev close 51 -> one factor 1 - 1/51.
    { id: 'd1', instrument: A, symbol: 'AAA', type: 'cash_dividend', exDate: '2025-01-06', cash: 0.5, currency: 'USD', dividendType: 'CD' },
    { id: 'd2', instrument: A, symbol: 'AAA', type: 'cash_dividend', exDate: '2025-01-06', cash: 0.5, dividendType: 'SC' },
    // Duplicate statement of d1 under another ticker: collapses, cash stays 1.0.
    { id: 'd8', instrument: A, symbol: 'AAAOLD', type: 'cash_dividend', exDate: '2025-01-06', cash: 0.5, currency: 'USD', dividendType: 'CD' },
    // Non-USD component on the same date: excluded from the cash sum.
    { id: 'd3', instrument: A, symbol: 'AAA', type: 'cash_dividend', exDate: '2025-01-06', cash: 5, currency: 'CAD' },
    // No bar before the ex date: skipped (noPrevClose).
    { id: 'd5', instrument: A, symbol: 'AAA', type: 'cash_dividend', exDate: '2025-01-02', cash: 1 },
    // Cash >= prev close (canon 11): skipped (nonPositiveFactor).
    { id: 'd6', instrument: B, symbol: 'BBBW', type: 'cash_dividend', exDate: '2025-01-03', cash: 99, currency: 'USD' },
    // Only non-USD cash on this date: skipped (nonUsdOnly).
    { id: 'd4', instrument: B, symbol: 'BBBW', type: 'cash_dividend', exDate: '2025-01-04', cash: 7, currency: 'CAD' },
  ]

  for (const action of actions) {
    await db.connection.run(
      `
        insert into facts.corporate_actions (
          source_id, source_action_id, instrument_id, market_scope,
          symbol_as_stated, action_type, ex_date, split_from, split_to,
          cash_amount, currency, dividend_type
        ) values (
          'polygon', $id, cast($instrument as uuid), 'us_stocks', $symbol,
          $type, cast($ex_date as date), $split_from, $split_to, $cash,
          $currency, $dividend_type
        )
      `,
      {
        id: action.id,
        instrument: action.instrument,
        symbol: action.symbol,
        type: action.type,
        ex_date: action.exDate,
        split_from: action.splitFrom ?? null,
        split_to: action.splitTo ?? null,
        cash: action.cash ?? null,
        currency: action.currency ?? null,
        dividend_type: action.dividendType ?? null,
      },
    )
  }
}

async function adjustedRows(db: Atm3Db, instrument: string, policy: string) {
  const result = await db.connection.runAndReadAll(
    `
      select cast(market_date as varchar) as market_date, close, volume,
             cum_price_factor, cum_volume_factor, symbol_as_traded
      from computed.bars_daily_adjusted
      where instrument_id = cast($instrument as uuid)
        and adjustment_policy = $policy
      order by market_date
    `,
    { instrument, policy },
  )
  return result.getRowObjectsJson()
}

test('computed layer: factors, policies, canon line, skips, freshness, rebuild', async () => {
  await withTempDatabase(async (db) => {
    await seedFacts(db)

    const first = await buildComputed(db.connection)
    assert.equal(first.skipped, false)
    assert.equal(first.splitFactors, 1)
    assert.equal(first.dividendFactors, 1)
    assert.deepEqual(first.dividendsSkipped, {
      noPrevClose: 1,
      nonPositiveFactor: 1,
      nonUsdOnly: 1,
    })
    assert.deepEqual(first.adjustedBars, { split: 4, split_dividend: 4 })

    // Factor values: split 0.5 / 2x volume; dividend 1 - 1/51.
    const factors = await db.connection.runAndReadAll(
      `
        select action_type, cast(event_date as varchar) as event_date,
               price_factor, volume_factor
        from computed.adjustment_factors
        where instrument_id = cast($a as uuid)
        order by event_date
      `,
      { a: A },
    )
    const factorRows = factors.getRowObjectsJson()
    assert.equal(factorRows.length, 2)
    closeTo(factorRows[0]?.price_factor, 0.5)
    closeTo(factorRows[0]?.volume_factor, 2)
    closeTo(factorRows[1]?.price_factor, 1 - 1 / 51)
    closeTo(factorRows[1]?.volume_factor, 1)

    // split policy: only the split applies.
    const split = await adjustedRows(db, A, 'split')
    closeTo(split[0]?.close, 50) // 100 * 0.5
    closeTo(split[0]?.volume, 2000) // 1000 * 2
    closeTo(split[1]?.close, 51) // ex-date bar is true to tape
    closeTo(split[2]?.close, 52)

    // split_dividend: dividend factor stacks multiplicatively before its ex.
    const total = await adjustedRows(db, A, 'split_dividend')
    closeTo(total[0]?.close, 100 * 0.5 * (1 - 1 / 51)) // 49.019607...
    closeTo(total[0]?.volume, 2000) // dividends never touch volume
    closeTo(total[1]?.close, 51 * (1 - 1 / 51)) // exactly 50
    closeTo(total[2]?.close, 52)

    // Canonical line: B's higher-volume BBBW bar is the series.
    const beta = await adjustedRows(db, B, 'split')
    assert.equal(beta.length, 1)
    assert.equal(beta[0]?.symbol_as_traded, 'BBBW')
    closeTo(beta[0]?.close, 11)

    // Freshness: same facts -> skip; new facts -> rebuild.
    const second = await buildComputed(db.connection)
    assert.equal(second.skipped, true)
    assert.equal(second.dividendFactors, 1)

    await db.connection.run(`
      insert into facts.corporate_actions (
        source_id, source_action_id, instrument_id, market_scope,
        symbol_as_stated, action_type, ex_date, cash_amount, currency
      ) values (
        'polygon', 'd7', cast('${A}' as uuid), 'us_stocks', 'AAA',
        'cash_dividend', date '2025-01-07', 0.52, 'USD'
      )
    `)
    const third = await buildComputed(db.connection)
    assert.equal(third.skipped, false)
    assert.equal(third.dividendFactors, 2)

    // Anchor rule: d7's ex date (01-07) is past A's last bar (01-06) — the
    // factor exists but applies to nothing until post-event bars arrive.
    const afterFuture = await adjustedRows(db, A, 'split_dividend')
    closeTo(afterFuture[1]?.close, 51 * (1 - 1 / 51))
    closeTo(afterFuture[2]?.close, 52)

    // Dropping every computed table and rebuilding yields identical data.
    const snapshot = await adjustedRows(db, A, 'split_dividend')
    await db.connection.run('delete from computed.adjustment_factors')
    await db.connection.run('delete from computed.bars_daily_adjusted')
    await db.connection.run('delete from computed.build_state')
    const rebuilt = await buildComputed(db.connection)
    assert.equal(rebuilt.skipped, false)
    assert.deepEqual(await adjustedRows(db, A, 'split_dividend'), snapshot)
  })
})
