import { formatTable } from '../core/format.ts'
import { metricsCatalog, type MetricId } from '../core/metrics-catalog.ts'
import { openDatabase } from '../server/db.ts'
import { forwardReturns } from '../server/forward-returns.ts'
import { metricsAt, type MetricAt } from '../server/metrics-at.ts'

const t = '2025-06-30'
const db = await openDatabase({ readOnly: true })

async function resolve(
  marketScope: string,
  symbol: string,
): Promise<string> {
  const result = await db.connection.runAndReadAll(
    `select cast(instrument_id as varchar) as instrument_id
     from facts.symbols
     where market_scope = $market_scope
       and symbol = $symbol
       and (valid_from is null or valid_from <= cast($t as date))
       and (valid_to is null or valid_to > cast($t as date))`,
    { market_scope: marketScope, symbol, t },
  )
  const id = result.getRowObjectsJson()[0]?.instrument_id
  if (id === undefined) throw new Error(`Cannot resolve ${marketScope}:${symbol}`)
  return String(id)
}

function metricMap(metrics: MetricAt[]): Map<MetricId, MetricAt> {
  const expected = metricsCatalog.map(({ id }) => id).sort()
  const actual = metrics.map(({ id }) => id).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('View-at metric ids differ from the catalog')
  }
  return new Map(metrics.map((metric) => [metric.id, metric]))
}

function shownMetric(
  metrics: Map<MetricId, MetricAt>,
  id: MetricId,
): string | number | boolean | null {
  const metric = metrics.get(id)
  if (!metric) throw new Error(`Missing metric ${id}`)
  return metric.value ?? metric.reason
}

try {
  const aaplId = await resolve('us_stocks', 'AAPL')
  const aaplResult = await metricsAt(db.connection, {
    instrumentId: aaplId,
    marketScope: 'us_stocks',
    t,
  })
  const aapl = metricMap(aaplResult.metrics)
  const forward = await forwardReturns(db.connection, {
    instrumentId: aaplId,
    marketScope: 'us_stocks',
    t,
    policy: 'split_dividend',
  })

  const cnId = await resolve('cn_stocks', '600519')
  const cnResult = await metricsAt(db.connection, {
    instrumentId: cnId,
    marketScope: 'cn_stocks',
    t,
  })
  const cn = metricMap(cnResult.metrics)
  const cnContext = cnResult.metrics.filter(({ family }) => family === 'context')
  if (
    cnContext.length !== 13 ||
    cnContext.some(
      ({ value, reason }) => value !== null || reason !== 'no_market_baseline',
    )
  ) {
    throw new Error('600519 context rows do not expose no_market_baseline')
  }

  console.log(`View at T contract (${t}; ${metricsCatalog.length} catalog ids)\n`)
  console.log(
    formatTable([
      {
        market_scope: 'us_stocks',
        symbol: 'AAPL',
        close_raw: shownMetric(aapl, 'close_raw'),
        ret_1d: shownMetric(aapl, 'ret_1d'),
        gap: shownMetric(aapl, 'gap'),
        beta_63_spy: shownMetric(aapl, 'beta_63_spy'),
        tracking_etf: shownMetric(aapl, 'tracking_etf'),
        suspended_days_63d: shownMetric(aapl, 'suspended_days_63d'),
      },
      {
        market_scope: 'cn_stocks',
        symbol: '600519',
        close_raw: shownMetric(cn, 'close_raw'),
        ret_1d: shownMetric(cn, 'ret_1d'),
        gap: shownMetric(cn, 'gap'),
        beta_63_spy: shownMetric(cn, 'beta_63_spy'),
        tracking_etf: shownMetric(cn, 'tracking_etf'),
        suspended_days_63d: shownMetric(cn, 'suspended_days_63d'),
      },
    ]),
  )
  console.log('\nAAPL hindsight (next open; split + dividend)')
  console.log(
    formatTable(
      forward.map(({ horizon, date, ret, mae, mfe, stale, delisted }) => ({
        horizon,
        date,
        ret,
        mae,
        mfe,
        stale,
        delisted,
      })),
    ),
  )
} finally {
  db.closeSync()
}
