import assert from 'node:assert/strict'
import test from 'node:test'
import {
  residualize,
  type DatedClose,
} from '../core/residualization.ts'
import { loadUsContextEtfs } from '../server/context-at.ts'
import { metricsAt, type MetricAt } from '../server/metrics-at.ts'
import type { Atm3Db } from '../server/db.ts'
import { withTempDatabase } from './helpers.ts'

const STOCK = '11111111-1111-4111-8111-111111111111'
const SPY = '22222222-2222-4222-8222-222222222222'
const QQQ = '33333333-3333-4333-8333-333333333333'

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

function closesFromReturns(returns: readonly number[], first = 100): number[] {
  const closes = [first]
  for (const value of returns) {
    closes.push(closes.at(-1)! * Math.exp(value))
  }
  return closes
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleStd(values: readonly number[]): number {
  const average = mean(values)
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  )
}

function compound(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + value, 0)) - 1
}

function metricMap(metrics: MetricAt[]): Map<string, MetricAt> {
  return new Map(metrics.map((metric) => [metric.id, metric]))
}

function closeTo(actual: unknown, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(Number(actual) - expected) < epsilon,
    `${String(actual)} !~ ${expected}`,
  )
}

async function seedSeries(
  db: Atm3Db,
  dates: readonly string[],
  entries: Array<{
    id: string
    symbol: string
    closes: readonly number[]
    type?: 'common_stock' | 'etf'
  }>,
): Promise<void> {
  const instruments = entries.map((entry) =>
    `(cast('${entry.id}' as uuid), 'equity', '${entry.type ?? 'common_stock'}', ` +
    `'${entry.symbol}', 'us_stocks', 'USD', true)`,
  ).join(',')
  const symbols = entries.map((entry, index) =>
    `(cast('${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000' as uuid), ` +
    `cast('${entry.id}' as uuid), 'us_stocks', '${entry.symbol}', ` +
    `date '2020-01-01', true)`,
  ).join(',')
  const bars = entries.flatMap((entry) =>
    dates.map((date, index) => {
      const close = entry.closes[index]
      return `('polygon', cast('${entry.id}' as uuid), date '${date}', ` +
        `'us_stocks', '${entry.symbol}', ${close}, ${close}, ${close}, ` +
        `${close}, 1000000)`
    }),
  ).join(',')

  await db.connection.run(`
    insert into facts.instruments (
      instrument_id, asset_class, instrument_type, name,
      primary_market_scope, currency, active
    ) values ${instruments};
    insert into facts.symbols (
      symbol_id, instrument_id, market_scope, symbol, valid_from, is_primary
    ) values ${symbols};
    insert into facts.bars_daily (
      source_id, instrument_id, market_date, market_scope, symbol_as_traded,
      open, high, low, close, volume
    ) values ${bars}
  `)
}

test('curated context ETF list is explicit and owner-vetoable', async () => {
  const list = await loadUsContextEtfs()
  assert.equal(list.length, 19)
  assert.deepEqual(list.slice(0, 4).map(({ symbol }) => symbol), [
    'SPY', 'QQQ', 'IWM', 'DIA',
  ])
  assert.ok(list.every(({ rationale }) => rationale.length > 10))
})

test('synthetic 1.5 beta recovers injected residual noise for all context ids', async () => {
  await withTempDatabase(async (db) => {
    const n = 63
    const baseline = Array.from(
      { length: n },
      (_, index) => 0.01 * Math.sin((2 * Math.PI * index) / n),
    )
    const noise = Array.from(
      { length: n },
      (_, index) => 0.002 * Math.cos((4 * Math.PI * index) / n),
    )
    const stock = baseline.map((value, index) => 1.5 * value + noise[index])
    const dates = openDates(n + 1)
    const stockCloses = closesFromReturns(stock)
    const spyCloses = closesFromReturns(baseline)
    await seedSeries(db, dates, [
      { id: STOCK, symbol: 'SYN', closes: stockCloses },
      { id: SPY, symbol: 'SPY', closes: spyCloses, type: 'etf' },
    ])

    const report = await metricsAt(db.connection, {
      instrumentId: STOCK,
      marketScope: 'us_stocks',
      t: dates.at(-1)!,
    })
    const metrics = metricMap(report.metrics)
    assert.deepEqual(report.context_baselines, { spy: 'SPY', tracking: 'SPY' })

    // cov(1.5*b + noise, b) / var(b) = 1.5 because the injected cosine
    // noise is mean-zero and orthogonal to the sine baseline over 63 points.
    closeTo(metrics.get('beta_63_spy')?.value, 1.5)
    closeTo(metrics.get('tracking_beta_63')?.value, 1.5)

    const baselineMean = mean(baseline)
    const stockMean = mean(stock)
    const covariance = stock.reduce(
      (sum, value, index) =>
        sum + (value - stockMean) * (baseline[index] - baselineMean),
      0,
    )
    const correlation = covariance / Math.sqrt(
      stock.reduce((sum, value) => sum + (value - stockMean) ** 2, 0) *
      baseline.reduce((sum, value) => sum + (value - baselineMean) ** 2, 0),
    )
    closeTo(metrics.get('corr_63_spy')?.value, correlation)
    closeTo(metrics.get('tracking_corr_63')?.value, correlation)

    // The engine indexes backward from T, so 21-period residual return is
    // exp(sum(last 21 injected noises)) - 1; the 63-period form uses all.
    const latestNoise = [...noise].reverse()
    const latestStock = [...stock].reverse()
    const latestBaseline = [...baseline].reverse()
    closeTo(
      metrics.get('resid_ret_21_spy')?.value,
      compound(latestNoise.slice(0, 21)),
    )
    closeTo(metrics.get('resid_ret_63_spy')?.value, compound(latestNoise))
    closeTo(
      metrics.get('idio_vol_63_spy')?.value,
      sampleStd(noise) * Math.sqrt(252),
    )
    closeTo(
      metrics.get('rel_ret_21')?.value,
      compound(latestStock.slice(0, 21)) -
        compound(latestBaseline.slice(0, 21)),
    )
    closeTo(
      metrics.get('rel_ret_63')?.value,
      compound(stock) - compound(baseline),
    )
    assert.equal(metrics.get('tracking_etf')?.value, 'SPY')
    for (const pair of [
      ['resid_ret_21_tracking', 'resid_ret_21_spy'],
      ['resid_ret_63_tracking', 'resid_ret_63_spy'],
      ['idio_vol_63_tracking', 'idio_vol_63_spy'],
    ] as const) {
      closeTo(metrics.get(pair[0])?.value, Number(metrics.get(pair[1])?.value))
    }
    const residZIds = new Set(['resid_z_spy', 'resid_z_vadj_spy'])
    for (const metric of report.metrics.filter(
      ({ family, id }) => family === 'context' && !residZIds.has(id),
    )) {
      assert.equal(metric.reason, null, metric.id)
      assert.equal(metric.bars_available, 64, metric.id)
    }
    // The yesterday-anchored z needs a 64th aligned pair; with exactly 64
    // closes it stays honestly insufficient.
    assert.equal(metrics.get('resid_z_spy')?.reason, 'insufficient_window')
    assert.equal(
      metrics.get('resid_z_vadj_spy')?.reason,
      'insufficient_window',
    )

    const constant = dates.map((date) => ({ date, close: 100 }))
    const stockSeries: DatedClose[] = dates.map((date, index) => ({
      date,
      close: stockCloses[index],
    }))
    const undefinedBaseline = residualize(stockSeries, constant)
    assert.equal(undefinedBaseline.result, null)
    assert.equal(undefinedBaseline.reason, 'undefined_input')
  })
})

test('tracking ETF selection flips only when trailing-at-T data says so', async () => {
  await withTempDatabase(async (db) => {
    const count = 128
    const spy: number[] = []
    const qqq: number[] = []
    const stock: number[] = []
    for (let index = 0; index < count; index++) {
      const a = 0.01 * Math.sin((2 * Math.PI * index) / 63)
      const b = 0.01 * Math.cos((4 * Math.PI * index) / 63)
      if (index < 64) {
        spy.push(a)
        qqq.push(b)
        stock.push(a)
      } else {
        spy.push(b)
        qqq.push(a)
        stock.push(a)
      }
    }
    const dates = openDates(count + 1)
    await seedSeries(db, dates, [
      { id: STOCK, symbol: 'FLIP', closes: closesFromReturns(stock) },
      { id: SPY, symbol: 'SPY', closes: closesFromReturns(spy), type: 'etf' },
      { id: QQQ, symbol: 'QQQ', closes: closesFromReturns(qqq), type: 'etf' },
    ])

    const early = await metricsAt(db.connection, {
      instrumentId: STOCK,
      marketScope: 'us_stocks',
      t: dates[63],
    })
    const late = await metricsAt(db.connection, {
      instrumentId: STOCK,
      marketScope: 'us_stocks',
      t: dates.at(-1)!,
    })
    assert.equal(early.context_baselines?.tracking, 'SPY')
    assert.equal(metricMap(early.metrics).get('tracking_etf')?.value, 'SPY')
    assert.equal(late.context_baselines?.tracking, 'QQQ')
    assert.equal(metricMap(late.metrics).get('tracking_etf')?.value, 'QQQ')
  })
})

test('residual z scores today against the window ending yesterday', async () => {
  await withTempDatabase(async (db) => {
    // 63 sine-baseline returns with orthogonal cosine noise, PLUS one new
    // day. The prior 63-pair window is then exactly the original arrays:
    // beta_prev = 1.5 and sigma_prev = sampleStd(noise), so
    // resid_z = newNoise / sampleStd(noise) by construction.
    const n = 63
    const baseline = Array.from(
      { length: n },
      (_, index) => 0.01 * Math.sin((2 * Math.PI * index) / n),
    )
    const noise = Array.from(
      { length: n },
      (_, index) => 0.002 * Math.cos((4 * Math.PI * index) / n),
    )
    const newBaseline = 0.004
    const newNoise = 0.009 // an outsized idiosyncratic day
    const stock = [
      ...baseline.map((value, index) => 1.5 * value + noise[index]),
      1.5 * newBaseline + newNoise,
    ]
    const dates = openDates(n + 2)
    const stockCloses = closesFromReturns(stock)
    const spyCloses = closesFromReturns([...baseline, newBaseline])
    await seedSeries(db, dates, [
      { id: STOCK, symbol: 'SYN', closes: stockCloses },
      { id: SPY, symbol: 'SPY', closes: spyCloses, type: 'etf' },
    ])

    const metrics = metricMap((await metricsAt(db.connection, {
      instrumentId: STOCK,
      marketScope: 'us_stocks',
      t: dates.at(-1)!,
    })).metrics)

    const expectedZ = newNoise / sampleStd(noise)
    closeTo(metrics.get('resid_z_spy')?.value, expectedZ)
    // vadj divides by sqrt(relative dollar volume); volume is constant, so
    // dv is proportional to close and rvol = close_0 / mean(close_1..21).
    const closesDesc = [...stockCloses].reverse()
    const rvol = closesDesc[0] /
      (closesDesc.slice(1, 22).reduce((sum, value) => sum + value, 0) / 21)
    closeTo(
      metrics.get('resid_z_vadj_spy')?.value,
      expectedZ / Math.sqrt(rvol),
    )
  })
})
