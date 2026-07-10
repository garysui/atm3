import assert from 'node:assert/strict'
import test from 'node:test'
import { metricsCatalog } from '../core/metrics-catalog.ts'
import { metricsAt, type MetricAt } from '../server/metrics-at.ts'
import { withTempDatabase } from './helpers.ts'

const US = '11111111-1111-4111-8111-111111111111'
const CN = '22222222-2222-4222-8222-222222222222'

type Bar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type AdjustedBar = Bar & {
  ao: number
  ah: number
  al: number
  ac: number
}

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

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleStd(values: number[]): number {
  const average = mean(values)
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function byId(metrics: MetricAt[]): Map<string, MetricAt> {
  return new Map(metrics.map((metric) => [metric.id, metric]))
}

function closeTo(actual: unknown, expected: number): void {
  assert.ok(
    Math.abs(Number(actual) - expected) < 1e-9,
    `${String(actual)} !~ ${expected}`,
  )
}

test('catalog declares every explicitly listed metric exactly once', () => {
  // The plan tables contain 40 non-context + 13 context ids = 53; VT-P6
  // added 9; the owner removed ret_intraday (same-bar open-to-close,
  // 2026-07-10) = 61. Changes are deliberate, never silent.
  assert.equal(metricsCatalog.length, 61)
  assert.equal(new Set(metricsCatalog.map(({ id }) => id)).size, 61)
  for (const metric of metricsCatalog) {
    assert.ok(metric.id)
    assert.ok(metric.family)
    assert.notEqual(metric.window, undefined)
    assert.ok(Number.isInteger(metric.min_bars) && metric.min_bars >= 1)
    assert.ok(metric.available_at === 'open' || metric.available_at === 'close')
    assert.ok(metric.basis)
    assert.ok(metric.unit)
    assert.ok(metric.description)
  }
})

test('all non-context formulas match visible independent arithmetic', async () => {
  await withTempDatabase(async (db) => {
    const dates = openDates(270)
    const t = dates[259]
    const splitDate = dates[100]
    const dividendDate = dates[200]
    const knownExDate = dates[264]
    const omitted = new Set([dates[230], dates[240]])
    const bars: Bar[] = []

    for (let index = 0; index < 260; index++) {
      if (omitted.has(dates[index])) continue
      const economicClose = 100 + index * 0.5
      const close = index < 100 ? economicClose : economicClose / 2
      const open = close * (1 + ((index % 5) - 2) * 0.001)
      bars.push({
        date: dates[index],
        open,
        high: Math.max(open, close) * 1.01,
        low: Math.min(open, close) * 0.99,
        close,
        volume: (1_000_000 * (1 + index / 1000)) / close,
      })
    }

    const calendarValues = dates
      .map((date) => `('us_equities', date '${date}', true, 'fixture')`)
      .join(',')
    const barValues = bars
      .map((bar) =>
        `('polygon', cast('${US}' as uuid), date '${bar.date}', ` +
        `'us_stocks', 'VTST', ${bar.open}, ${bar.high}, ${bar.low}, ` +
        `${bar.close}, ${bar.volume})`,
      )
      .join(',')

    await db.connection.run(`
      insert into facts.exchanges (
        exchange_mic, name, market_scope, calendar_id, timezone, currency
      ) values (
        'XNAS', 'NASDAQ', 'us_stocks', 'us_equities', 'America/New_York', 'USD'
      );
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, name,
        primary_market_scope, currency, active
      ) values (
        cast('${US}' as uuid), 'equity', 'common_stock', 'Metric Fixture',
        'us_stocks', 'USD', true
      );
      insert into facts.symbols (
        symbol_id, instrument_id, market_scope, symbol, valid_from, is_primary
      ) values (
        cast('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as uuid),
        cast('${US}' as uuid), 'us_stocks', 'VTST', date '2020-01-01', true
      );
      insert into facts.trading_days (
        calendar_id, market_date, is_open, source_id
      ) values ${calendarValues};
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values ${barValues};
      insert into facts.corporate_actions (
        source_id, source_action_id, instrument_id, market_scope,
        symbol_as_stated, action_type, ex_date, declaration_date,
        split_from, split_to, cash_amount, currency
      ) values
        ('polygon', 'split', cast('${US}' as uuid), 'us_stocks', 'VTST',
         'split', date '${splitDate}', null, 1, 2, null, null),
        ('polygon', 'dividend', cast('${US}' as uuid), 'us_stocks', 'VTST',
         'cash_dividend', date '${dividendDate}', date '${dates[190]}',
         null, null, 1, 'USD'),
        ('polygon', 'future-known', cast('${US}' as uuid), 'us_stocks', 'VTST',
         'cash_dividend', date '${knownExDate}', date '${dates[255]}',
         null, null, 1, 'USD'),
        ('polygon', 'future-unknown', cast('${US}' as uuid), 'us_stocks', 'VTST',
         'cash_dividend', date '${dates[261]}', date '${dates[260]}',
         null, null, 1, 'USD')
    `)

    const previousDividendBar = bars.find((bar) => bar.date === dates[199])!
    const cashFactor = 1 - 1 / previousDividendBar.close
    const adjusted: AdjustedBar[] = bars.map((bar) => {
      const factor =
        (bar.date < splitDate ? 0.5 : 1) *
        (bar.date < dividendDate ? cashFactor : 1)
      return {
        ...bar,
        ao: bar.open * factor,
        ah: bar.high * factor,
        al: bar.low * factor,
        ac: bar.close * factor,
      }
    })
    const x = [...adjusted].reverse()
    const returns = (index: number) => x[index].ac / x[index + 1].ac - 1
    const logReturns = (index: number) =>
      Math.log(x[index].ac / x[index + 1].ac)
    const gaps = (index: number) => x[index].ao / x[index + 1].ac - 1
    const dv = (index: number) => x[index].close * x[index].volume
    const sma = (count: number) => mean(x.slice(0, count).map((bar) => bar.ac))
    const r21 = Array.from({ length: 21 }, (_, index) => returns(index))
    const lr21 = Array.from({ length: 21 }, (_, index) => logReturns(index))
    const lr63 = Array.from({ length: 63 }, (_, index) => logReturns(index))
    const gaps63 = Array.from({ length: 63 }, (_, index) => gaps(index))
    const firstDirection = Math.sign(returns(0))
    let streak = 0
    while (
      streak < x.length - 1 &&
      Math.sign(returns(streak)) === firstDirection
    ) streak++
    streak *= firstDirection

    // Each expression below is an independent transcription of the plan's
    // visible arithmetic. This is intentionally repetitive: a window-boundary
    // bug must fail by metric id, not hide behind one shared implementation.
    const expected: Record<string, number | boolean> = {
      close_raw: x[0].close,
      dollar_adv21_log10: Math.log10(mean(Array.from({ length: 21 }, (_, i) => dv(i + 1)))),
      listed_bars: x.length,
      active_at_t: true,
      ret_1d: x[0].ac / x[1].ac - 1,
      ret_5d: x[0].ac / x[5].ac - 1,
      ret_21d: x[0].ac / x[21].ac - 1,
      ret_63d: x[0].ac / x[63].ac - 1,
      ret_126d: x[0].ac / x[126].ac - 1,
      ret_252d: x[0].ac / x[252].ac - 1,
      mom_12_1: x[21].ac / x[252].ac - 1,
      gap: x[0].ao / x[1].ac - 1,
      gap_freq_63d: gaps63.filter((value) => Math.abs(value) > 0.02).length / 63,
      abs_gap_med_63d: median(gaps63.map(Math.abs)),
      close_vs_sma20: x[0].ac / sma(20) - 1,
      close_vs_sma50: x[0].ac / sma(50) - 1,
      close_vs_sma200: x[0].ac / sma(200) - 1,
      sma50_vs_sma200: sma(50) / sma(200) - 1,
      high_252_dist: x[0].ac / Math.max(...x.slice(0, 252).map((bar) => bar.ah)) - 1,
      low_252_dist: x[0].ac / Math.min(...x.slice(0, 252).map((bar) => bar.al)) - 1,
      drawdown_252: x[0].ac / Math.max(...x.slice(0, 252).map((bar) => bar.ac)) - 1,
      up_streak: streak,
      up_days_21d: r21.filter((value) => value > 0).length / 21,
      vol_21d: sampleStd(lr21) * Math.sqrt(252),
      vol_63d: sampleStd(lr63) * Math.sqrt(252),
      vol_ratio_21_63: sampleStd(lr21) / sampleStd(lr63),
      parkinson_21d: Math.sqrt(
        mean(x.slice(0, 21).map((bar) => Math.log(bar.high / bar.low) ** 2)) /
          (4 * Math.log(2)),
      ) * Math.sqrt(252),
      atr_pct_14: mean(Array.from({ length: 14 }, (_, i) =>
        Math.max(x[i].ah, x[i + 1].ac) - Math.min(x[i].al, x[i + 1].ac),
      )) / x[0].ac,
      max_abs_ret_21d: Math.max(...r21.map(Math.abs)),
      range_pct: (x[0].high - x[0].low) / x[0].close,
      clv: (2 * x[0].close - x[0].high - x[0].low) /
        (x[0].high - x[0].low),
      rvol_21d: dv(0) / mean(Array.from({ length: 21 }, (_, i) => dv(i + 1))),
      volume_trend_5_63: mean(Array.from({ length: 5 }, (_, i) => dv(i))) /
        mean(Array.from({ length: 63 }, (_, i) => dv(i))),
      amihud_21d: mean(r21.map((value, i) => Math.abs(value) / dv(i))) * 1e6,
      suspended_days_63d: 2 / 63,
      days_since_split: bars.filter((bar) => bar.date > splitDate && bar.date <= t).length,
      days_since_dividend: bars.filter((bar) => bar.date > dividendDate && bar.date <= t).length,
      declared_ex_days: dates.filter((date) => date > t && date <= knownExDate).length,
      div_yield_ttm: 1 / previousDividendBar.close,
      // VT-P6 surprise layer. Yang-Zhang over idx 0..20 with n = 21:
      // sigma^2 = var(overnight) + k var(open-close) + (1-k) mean(RS),
      // k = 0.34 / (1.34 + 22/20).
      yz_vol_21d: (() => {
        const on = Array.from({ length: 21 }, (_, i) => Math.log(x[i].ao / x[i + 1].ac))
        const oc = Array.from({ length: 21 }, (_, i) => Math.log(x[i].ac / x[i].ao))
        const rs = Array.from({ length: 21 }, (_, i) =>
          Math.log(x[i].ah / x[i].ac) * Math.log(x[i].ah / x[i].ao) +
          Math.log(x[i].al / x[i].ac) * Math.log(x[i].al / x[i].ao))
        const k = 0.34 / (1.34 + 22 / 20)
        return Math.sqrt(
          sampleStd(on) ** 2 + k * sampleStd(oc) ** 2 + (1 - k) * mean(rs),
        ) * Math.sqrt(252)
      })(),
      range_med_21d: median(Array.from({ length: 21 }, (_, i) =>
        (x[i + 1].ah - x[i + 1].al) / x[i + 2].ac)),
      range_surprise: ((x[0].ah - x[0].al) / x[1].ac) /
        median(Array.from({ length: 21 }, (_, i) =>
          (x[i + 1].ah - x[i + 1].al) / x[i + 2].ac)),
      // Yesterday-anchored daily Parkinson sigma (raw h/l, bars 1..21).
      ret_z_21d: logReturns(0) / Math.sqrt(
        mean(Array.from({ length: 21 }, (_, i) =>
          Math.log(x[i + 1].high / x[i + 1].low) ** 2)) / (4 * Math.log(2))),
      ret_z_vadj_21d: (logReturns(0) / Math.sqrt(
        mean(Array.from({ length: 21 }, (_, i) =>
          Math.log(x[i + 1].high / x[i + 1].low) ** 2)) / (4 * Math.log(2)))) /
        Math.sqrt(dv(0) / mean(Array.from({ length: 21 }, (_, i) => dv(i + 1)))),
      ret_pctile_252d: (() => {
        const previous = Array.from({ length: 252 }, (_, i) => logReturns(i + 1))
        const lr0 = logReturns(0)
        return (previous.filter((value) => value < lr0).length +
          0.5 * previous.filter((value) => value === lr0).length) / 252
      })(),
      // Adjusted Fisher-Pearson excess kurtosis (DuckDB kurtosis()).
      ret_kurt_252d: (() => {
        const previous = Array.from({ length: 252 }, (_, i) => logReturns(i + 1))
        const n = previous.length
        const center = mean(previous)
        const s = sampleStd(previous)
        const fourth = previous.reduce(
          (sum, value) => sum + ((value - center) / s) ** 4, 0)
        return (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * fourth -
          (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
      })(),
    }
    assert.equal(Object.keys(expected).length, 46)

    const report = await metricsAt(db.connection, {
      instrumentId: US,
      marketScope: 'us_stocks',
      t,
    })
    assert.equal(report.metrics.length, metricsCatalog.length)
    const actual = byId(report.metrics)
    for (const [id, value] of Object.entries(expected)) {
      const metric = actual.get(id)
      assert.ok(metric, id)
      assert.equal(metric.reason, null, id)
      if (typeof value === 'boolean') assert.equal(metric.value, value, id)
      else closeTo(metric.value, value)
    }

    // Split-day sanity: naive raw gap is about -50%, but adjusted gap uses
    // split-day open / (previous raw close * 1/2) - 1.
    const splitBar = bars.find((bar) => bar.date === splitDate)!
    const previousSplitBar = bars.find((bar) => bar.date === dates[99])!
    const naiveGap = splitBar.open / previousSplitBar.close - 1
    const trueGap = splitBar.open / (previousSplitBar.close * 0.5) - 1
    assert.ok(naiveGap < -0.49)
    const splitReport = await metricsAt(db.connection, {
      instrumentId: US,
      marketScope: 'us_stocks',
      t: splitDate,
    })
    closeTo(byId(splitReport.metrics).get('gap')?.value, trueGap)

    // Every family has an honest short-window null path.
    const short = byId((await metricsAt(db.connection, {
      instrumentId: US,
      marketScope: 'us_stocks',
      t: dates[2],
    })).metrics)
    for (const id of [
      'dollar_adv21_log10', 'ret_21d', 'gap_freq_63d',
      'close_vs_sma20', 'vol_21d', 'rvol_21d', 'div_yield_ttm',
      'beta_63_spy',
    ]) {
      assert.equal(short.get(id)?.value, null, id)
      assert.equal(short.get(id)?.reason, 'insufficient_window', id)
    }

    // Guarded denominator: a zero range is undefined, never infinity/NaN.
    await db.connection.run(`
      update facts.bars_daily set high = close, low = close
      where instrument_id = cast('${US}' as uuid) and market_date = date '${t}'
    `)
    const flat = byId((await metricsAt(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t,
    })).metrics).get('clv')
    assert.equal(flat?.value, null)
    assert.equal(flat?.reason, 'undefined_input')

    // A nearer ex date declared after T remains unknowable at T. Removing the
    // farther known event leaves the metric null despite that future row.
    await db.connection.run(`
      delete from facts.corporate_actions where source_action_id = 'future-known'
    `)
    const hidden = byId((await metricsAt(db.connection, {
      instrumentId: US, marketScope: 'us_stocks', t,
    })).metrics).get('declared_ex_days')
    assert.equal(hidden?.value, null)
    assert.equal(hidden?.reason, 'no_known_event')

    const cnCalendar = dates.slice(196, 260)
    const cnBars = cnCalendar.filter((date) => date !== dates[230])
    await db.connection.run(`
      insert into facts.exchanges (
        exchange_mic, name, market_scope, calendar_id, timezone, currency
      ) values (
        'XSHG', 'Shanghai', 'cn_stocks', 'cn_equities', 'Asia/Shanghai', 'CNY'
      );
      insert into facts.instruments (
        instrument_id, asset_class, instrument_type, name,
        primary_market_scope, currency, active
      ) values (
        cast('${CN}' as uuid), 'equity', 'common_stock', 'CN Metric Fixture',
        'cn_stocks', 'CNY', true
      );
      insert into facts.symbols (
        symbol_id, instrument_id, market_scope, symbol, valid_from, is_primary
      ) values (
        cast('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as uuid),
        cast('${CN}' as uuid), 'cn_stocks', '600519', date '2020-01-01', true
      );
      insert into facts.trading_days (
        calendar_id, market_date, is_open, source_id
      ) values ${cnCalendar.map((date) =>
        `('cn_equities', date '${date}', true, 'fixture')`,
      ).join(',')};
      insert into facts.bars_daily (
        source_id, instrument_id, market_date, market_scope, symbol_as_traded,
        open, high, low, close, volume
      ) values ${cnBars.map((date, index) =>
        `('baostock', cast('${CN}' as uuid), date '${date}', 'cn_stocks', ` +
        `'600519', ${100 + index}, ${101 + index}, ${99 + index}, ` +
        `${100 + index}, 1000)`,
      ).join(',')}
    `)
    const cnReport = await metricsAt(db.connection, {
      instrumentId: CN,
      marketScope: 'cn_stocks',
      t,
    })
    assert.deepEqual(
      cnReport.metrics.map((metric) => metric.id),
      report.metrics.map((metric) => metric.id),
    )
    assert.deepEqual(
      cnReport.metrics.map((metric) => Object.keys(metric)),
      report.metrics.map((metric) => Object.keys(metric)),
    )
    closeTo(byId(cnReport.metrics).get('suspended_days_63d')?.value, 1 / 63)
    for (const metric of cnReport.metrics.filter(({ family }) => family === 'context')) {
      assert.equal(metric.value, null)
      assert.equal(metric.reason, 'no_market_baseline')
    }
  })
})
