import type { Atm3Db } from '../server/db.ts'

// Shared facts fixture: instrument A exercises the adjustment math
// (split + same-day dividends + duplicate statements + skips), instrument B
// exercises the canonical-line choice. Seeded directly into facts — the
// computed layer's and API's contract is facts, not raw.
export const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

export async function seedFacts(db: Atm3Db): Promise<void> {
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

  const symbols: Array<[string, string, string, string | null, string | null]> =
    [
      // [symbol_id, instrument, symbol, valid_from, valid_to]
      ['11111111-1111-4111-8111-111111111111', A, 'AAA', null, null],
      ['22222222-2222-4222-8222-222222222222', B, 'BBBW', null, null],
      // Historical usage: A traded as AAAOLD before renaming (searching a
      // past ticker must still surface the instrument, labeled with dates).
      ['33333333-3333-4333-8333-333333333333', A, 'AAAOLD', '2020-01-01', '2022-01-01'],
    ]

  for (const [symbolId, instrument, symbol, validFrom, validTo] of symbols) {
    await db.connection.run(
      `
        insert into facts.symbols (
          symbol_id, instrument_id, market_scope, symbol, valid_from, valid_to
        ) values (cast($symbol_id as uuid), cast($instrument as uuid),
                  'us_stocks', $symbol, cast($valid_from as date),
                  cast($valid_to as date))
      `,
      {
        symbol_id: symbolId,
        instrument,
        symbol,
        valid_from: validFrom,
        valid_to: validTo,
      },
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
