import assert from 'node:assert/strict'
import test from 'node:test'
import type { Atm3Db } from '../server/db.ts'
import {
  isCacheFresh,
  refreshAdjustedBarsCache,
} from '../server/computed-build.ts'
import { withTempDatabase } from './helpers.ts'

// The unit under test is the ALGORITHM: the computed.adjusted_bars(policy,
// as_of) macro over facts. The cache is asserted only to be a faithful
// snapshot of it. Facts are seeded directly (the computed layer's contract
// is facts, not raw).
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
    // No bar before the ex date: skipped (no_prev_close).
    { id: 'd5', instrument: A, symbol: 'AAA', type: 'cash_dividend', exDate: '2025-01-02', cash: 1 },
    // Cash >= prev close (canon 11): skipped (cash_exceeds_prev_close).
    { id: 'd6', instrument: B, symbol: 'BBBW', type: 'cash_dividend', exDate: '2025-01-03', cash: 99, currency: 'USD' },
    // Only non-USD cash on this date: skipped (non_usd_only).
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

async function macroRows(
  db: Atm3Db,
  instrument: string,
  policy: string,
  asOf?: string,
) {
  const asOfArg = asOf ? `, as_of := date '${asOf}'` : ''
  const result = await db.connection.runAndReadAll(
    `
      select cast(market_date as varchar) as market_date, close, volume,
             cum_price_factor, cum_volume_factor, symbol_as_traded
      from computed.adjusted_bars('${policy}'${asOfArg})
      where instrument_id = cast($instrument as uuid)
      order by market_date
    `,
    { instrument },
  )
  return result.getRowObjectsJson()
}

test('adjusted_bars macro: factors, policies, canon line, anchor, as-of T', async () => {
  await withTempDatabase(async (db) => {
    await seedFacts(db)

    // Factor events view: duplicate statements collapsed, same-day distinct
    // dividends summed.
    const factors = await db.connection.runAndReadAll(
      `
        select action_type, cast(event_date as varchar) as event_date,
               price_factor, volume_factor
        from computed.adjustment_factor_events
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

    // Unadjustable dividends are visible as a function, with reasons.
    const gaps = await db.connection.runAndReadAll(`
      select reason, count(*) as n from computed.unadjustable_dividends
      group by reason order by reason
    `)
    assert.deepEqual(
      gaps.getRowObjectsJson().map((row) => ({
        reason: row.reason,
        n: Number(row.n),
      })),
      [
        { reason: 'cash_exceeds_prev_close', n: 1 },
        { reason: 'no_prev_close', n: 1 },
        { reason: 'non_usd_only', n: 1 },
      ],
    )

    // Policy 'none' is the raw canonical tape.
    const none = await macroRows(db, A, 'none')
    closeTo(none[0]?.close, 100)
    closeTo(none[0]?.cum_price_factor, 1)

    // split policy: only the split applies.
    const split = await macroRows(db, A, 'split')
    closeTo(split[0]?.close, 50) // 100 * 0.5
    closeTo(split[0]?.volume, 2000) // 1000 * 2
    closeTo(split[1]?.close, 51) // ex-date bar is true to tape
    closeTo(split[2]?.close, 52)

    // split_dividend: dividend factor stacks multiplicatively before its ex.
    const total = await macroRows(db, A, 'split_dividend')
    closeTo(total[0]?.close, 100 * 0.5 * (1 - 1 / 51))
    closeTo(total[0]?.volume, 2000) // dividends never touch volume
    closeTo(total[1]?.close, 51 * (1 - 1 / 51)) // exactly 50
    closeTo(total[2]?.close, 52)

    // Canonical line: B's higher-volume BBBW bar is the series.
    const beta = await macroRows(db, B, 'split')
    assert.equal(beta.length, 1)
    assert.equal(beta[0]?.symbol_as_traded, 'BBBW')
    closeTo(beta[0]?.close, 11)

    // As-of T: viewed from 2025-01-02, the 01-03 split has not happened —
    // the same facts serve every T on demand, storing none of them.
    const asOf = await macroRows(db, A, 'split_dividend', '2025-01-02')
    assert.equal(asOf.length, 1)
    closeTo(asOf[0]?.close, 100) // raw: no event applies yet
    const asOfMid = await macroRows(db, A, 'split_dividend', '2025-01-03')
    assert.equal(asOfMid.length, 2)
    closeTo(asOfMid[0]?.close, 50) // split applied, dividend not yet
    closeTo(asOfMid[1]?.close, 51)
  })
})

test('cache is a faithful, watermarked snapshot of the macro', async () => {
  await withTempDatabase(async (db) => {
    await seedFacts(db)

    const first = await refreshAdjustedBarsCache(db.connection)
    assert.equal(first.skipped, false)
    assert.equal(first.factorEvents.splits, 1)
    assert.equal(first.factorEvents.dividends, 1)
    assert.deepEqual(first.cacheRows, { split: 4, split_dividend: 4 })

    // Cache rows are exactly the macro's rows (symmetric difference empty).
    const diff = await db.connection.runAndReadAll(`
      with macro_rows as (
        select instrument_id, market_date, adjustment_policy, close, volume,
               cum_price_factor
        from computed.adjusted_bars('split')
        union all
        select instrument_id, market_date, adjustment_policy, close, volume,
               cum_price_factor
        from computed.adjusted_bars('split_dividend')
      ),
      cache_rows as (
        select instrument_id, market_date, adjustment_policy, close, volume,
               cum_price_factor
        from computed.bars_daily_adjusted_cache
      )
      select
        (select count(*) from (
          select * from cache_rows except select * from macro_rows
        ))
        +
        (select count(*) from (
          select * from macro_rows except select * from cache_rows
        )) as n
    `)
    assert.equal(Number(diff.getRowObjectsJson()[0]?.n), 0)

    // Freshness: same facts skip; new facts invalidate.
    assert.equal(await isCacheFresh(db.connection), true)
    const second = await refreshAdjustedBarsCache(db.connection)
    assert.equal(second.skipped, true)

    await db.connection.run(`
      insert into facts.corporate_actions (
        source_id, source_action_id, instrument_id, market_scope,
        symbol_as_stated, action_type, ex_date, cash_amount, currency
      ) values (
        'polygon', 'd9', cast('${A}' as uuid), 'us_stocks', 'AAA',
        'cash_dividend', date '2025-01-03', 0.51, 'USD'
      )
    `)
    assert.equal(await isCacheFresh(db.connection), false)
    const third = await refreshAdjustedBarsCache(db.connection)
    assert.equal(third.skipped, false)
    assert.equal(third.factorEvents.dividends, 2)

    const forced = await refreshAdjustedBarsCache(db.connection, {
      force: true,
    })
    assert.equal(forced.skipped, false)
  })
})
