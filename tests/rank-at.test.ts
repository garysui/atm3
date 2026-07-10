import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshAdjustedBarsCache } from '../server/computed-build.ts'
import { metricsAt } from '../server/metrics-at.ts'
import type { Atm3Db } from '../server/db.ts'
import { rankAt, RankAtDateError } from '../server/rank-at.ts'
import { withTempDatabase } from './helpers.ts'

const SPY = '00000000-0000-4000-8000-00000000000f'
const MOVR = '00000000-0000-4000-8000-000000000001'
const BETA = '00000000-0000-4000-8000-000000000002'
const THIN = '00000000-0000-4000-8000-000000000003'
const QUIET = '00000000-0000-4000-8000-000000000004'

function openDates(count: number): string[] {
  const dates: string[] = []
  const cursor = new Date('2024-01-02T00:00:00Z')
  while (dates.length < count) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function closesFromReturns(returns: readonly number[]): number[] {
  const closes = [100]
  for (const value of returns) closes.push(closes.at(-1)! * Math.exp(value))
  return closes
}

async function seed(
  db: Atm3Db,
  dates: readonly string[],
  entries: Array<{
    id: string
    symbol: string
    closes: readonly number[]
    volume: number
    type?: string
  }>,
): Promise<void> {
  const instruments = entries.map((entry) =>
    `(cast('${entry.id}' as uuid), 'equity', '${entry.type ?? 'common_stock'}', ` +
    `'${entry.symbol} Name', 'us_stocks', 'USD', true)`,
  ).join(',')
  const symbols = entries.map((entry, index) =>
    `(cast('${String(index + 1).padStart(8, '0')}-0000-4000-8000-0000000000ff' as uuid), ` +
    `cast('${entry.id}' as uuid), 'us_stocks', '${entry.symbol}', ` +
    `date '2020-01-01', true)`,
  ).join(',')
  const bars = entries.flatMap((entry) =>
    dates.map((date, index) => {
      const close = entry.closes[index]
      return `('polygon', cast('${entry.id}' as uuid), date '${date}', ` +
        `'us_stocks', '${entry.symbol}', ${close}, ${close * 1.01}, ` +
        `${close * 0.99}, ${close}, ${entry.volume})`
    }),
  ).join(',')
  await db.connection.run(`
    insert into facts.exchanges (
      exchange_mic, name, market_scope, calendar_id, timezone, currency
    ) values (
      'XNAS', 'NASDAQ', 'us_stocks', 'us_equities', 'America/New_York', 'USD'
    );
    insert into facts.instruments (
      instrument_id, asset_class, instrument_type, name,
      primary_market_scope, currency, active
    ) values ${instruments};
    insert into facts.symbols (
      symbol_id, instrument_id, market_scope, symbol, valid_from, is_primary
    ) values ${symbols};
    insert into facts.trading_days (calendar_id, market_date, is_open, source_id)
    select 'us_equities', d, true, 'fixture'
    from unnest([${dates.map((date) => `date '${date}'`).join(',')}]) dates(d);
    insert into facts.bars_daily (
      source_id, instrument_id, market_date, market_scope, symbol_as_traded,
      open, high, low, close, volume
    ) values ${bars}
  `)
}

test('rank-at: residual sort finds the idiosyncratic mover, not the beta', async () => {
  await withTempDatabase(async (db) => {
    // 65 returns: a sine market with a BIG final day (+3%). MOVR carries a
    // planted +2% idiosyncratic jump at T (10x its 0.2% noise sigma); BETA
    // is a nearly pure 2x follower — huge raw move, no own movement; THIN
    // jumps hugely on negligible dollar volume; QUIET is quiet.
    const n = 65
    const market = Array.from(
      { length: n - 1 },
      (_, index) => 0.01 * Math.sin((2 * Math.PI * index) / 63),
    ).concat([0.03])
    const noise = (scale: number) =>
      Array.from(
        { length: n },
        (_, index) => scale * Math.cos((4 * Math.PI * index) / 63),
      )
    const movrNoise = noise(0.002)
    movrNoise[n - 1] = 0.02
    const betaNoise = noise(0.0001)
    const quietNoise = noise(0.001)
    const dates = openDates(n + 1)
    const t = dates.at(-1)!

    await seed(db, dates, [
      { id: SPY, symbol: 'SPY', type: 'etf',
        closes: closesFromReturns(market), volume: 1_000_000 },
      { id: MOVR, symbol: 'MOVR',
        closes: closesFromReturns(market.map((value, index) => value + movrNoise[index])),
        volume: 10_000 },
      { id: BETA, symbol: 'BETA',
        closes: closesFromReturns(market.map((value, index) => 2 * value + betaNoise[index])),
        volume: 10_000 },
      { id: THIN, symbol: 'THIN',
        closes: closesFromReturns(market.map((_, index) => (index === n - 1 ? 0.05 : 0.0005 * ((index % 3) - 1)))),
        volume: 1 },
      { id: QUIET, symbol: 'QUIET',
        closes: closesFromReturns(market.map((value, index) => 0.5 * value + quietNoise[index])),
        volume: 10_000 },
    ])
    await refreshAdjustedBarsCache(db.connection)

    // Residual sort (with a liquidity floor — THIN's 5% jump on a dollar a
    // day is the floor's job, not the residual math's): the planted
    // idiosyncratic event wins; the pure beta name — the day's biggest RAW
    // mover — is nowhere near the top.
    const byResid = await rankAt(db.connection, {
      t, scope: 'us_stocks', minDollarAdv: 1000,
    })
    assert.equal(byResid.baseline, 'SPY')
    assert.equal(byResid.sort, 'resid_z')
    assert.equal(byResid.rows[0]?.symbol, 'MOVR')
    assert.ok(Math.abs(byResid.rows[0]!.resid_z!) > 5)
    const betaRow = byResid.rows.find((row) => row.symbol === 'BETA')
    assert.ok(betaRow && Math.abs(betaRow.resid_z!) < 2)
    assert.ok(Math.abs(betaRow.ret_z!) > Math.abs(byResid.rows[0]!.ret_z!))

    // Engine parity: the ranking pass must reproduce the metric engine's
    // resid_z for the same instrument and T exactly.
    const metric = (await metricsAt(db.connection, {
      instrumentId: MOVR, marketScope: 'us_stocks', t,
    })).metrics.find((entry) => entry.id === 'resid_z_spy')
    assert.ok(
      Math.abs(Number(metric?.value) - byResid.rows[0]!.resid_z!) < 1e-9,
      `${metric?.value} !~ ${byResid.rows[0]!.resid_z}`,
    )

    // Raw-z sort ranks the beta name first: that contrast IS the reason the
    // default removes the market before ranking.
    const byRaw = await rankAt(db.connection, {
      t, scope: 'us_stocks', sort: 'ret_z', minDollarAdv: 1000,
    })
    assert.equal(byRaw.rows[0]?.symbol, 'BETA')

    // Liquidity floor: the thin name appears without a floor (and, having
    // near-zero beta and near-zero noise, tops even the residual sort — the
    // floor exists precisely because z-scores explode on empty tapes).
    const unfloored = await rankAt(db.connection, { t, scope: 'us_stocks' })
    assert.equal(unfloored.rows[0]?.symbol, 'THIN')
    assert.ok(!byResid.rows.some((row) => row.symbol === 'THIN'))
    assert.ok(byResid.universe.excluded_liquidity >= 1)
    assert.ok(byResid.gauges.median_abs_ret_z !== null)

    // Omitting T resolves to the scope's data frontier — the Movers page
    // loads the latest day without asking.
    const latest = await rankAt(db.connection, {
      scope: 'us_stocks', minDollarAdv: 1000,
    })
    assert.equal(latest.t, t)
    assert.equal(latest.rows[0]?.symbol, 'MOVR')

    // Truncation invariance extends to the cross-section: landing a post-T
    // day and refreshing the cache must not change the ranking at T.
    const nextDate = openDates(n + 2).at(-1)!
    await db.connection.run(`
      insert into facts.trading_days (calendar_id, market_date, is_open, source_id)
      values ('us_equities', date '${nextDate}', true, 'fixture');
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      )
      select source_id, instrument_id, date '${nextDate}', market_scope,
             symbol_as_traded, close, close * 1.02, close * 0.98,
             close * 1.001, volume
      from facts.bars_daily where market_date = date '${t}'
    `)
    await refreshAdjustedBarsCache(db.connection, { force: true })
    const after = await rankAt(db.connection, {
      t, scope: 'us_stocks', minDollarAdv: 1000,
    })
    assert.deepEqual(after, byResid)

    // Scopes without a market baseline cannot silently rank by residuals.
    await assert.rejects(
      rankAt(db.connection, { t, scope: 'cn_stocks', sort: 'resid_z' }),
      /no market baseline/,
    )
    // A non-bar date names its neighbors.
    await assert.rejects(
      rankAt(db.connection, { t: '2024-01-01', scope: 'us_stocks' }),
      (error: unknown) =>
        error instanceof RankAtDateError && error.nextDate === dates[0],
    )
  })
})
