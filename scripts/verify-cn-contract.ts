import { formatTable } from '../core/format.ts'
import { openDatabase } from '../server/db.ts'
import {
  adjustedReturnSeries,
  type AdjustedReturnPoint,
} from '../server/return-series.ts'

const db = await openDatabase({ readOnly: true })

async function resolve(scope: string, symbol: string): Promise<string> {
  const result = await db.connection.runAndReadAll(
    `select cast(instrument_id as varchar) as instrument_id
     from facts.symbols
     where market_scope = $scope and symbol = $symbol and valid_to is null`,
    { scope, symbol },
  )
  const id = result.getRowObjectsJson()[0]?.instrument_id
  if (id === undefined) throw new Error(`Cannot resolve ${scope}:${symbol}`)
  return String(id)
}

function columnSchema(row: AdjustedReturnPoint): string {
  return Object.keys(row).join('|')
}

try {
  const cases = [
    { marketScope: 'us_stocks', symbol: 'AAPL' },
    { marketScope: 'cn_stocks', symbol: '600519' },
  ]
  const reports: Array<Record<string, unknown>> = []
  let expectedSchema: string | null = null

  for (const item of cases) {
    const instrumentId = await resolve(item.marketScope, item.symbol)
    const series = await adjustedReturnSeries(db.connection, {
      instrumentId,
      marketScope: item.marketScope,
      observations: 20,
      policy: 'split_dividend',
    })
    if (series.length !== 20) {
      throw new Error(`${item.symbol} returned ${series.length} observations`)
    }

    const schema = columnSchema(series[0])
    expectedSchema ??= schema
    if (schema !== expectedSchema) {
      throw new Error(
        `${item.symbol} schema ${schema} differs from ${expectedSchema}`,
      )
    }

    reports.push({
      market_scope: item.marketScope,
      symbol: item.symbol,
      observations: series.length,
      first_date: series[0].date,
      last_date: series.at(-1)?.date,
      return_from_start: Number(
        series.at(-1)?.return_from_start ?? 0,
      ).toFixed(9),
      columns: schema,
    })
  }

  console.log('Source-neutral split_dividend return-series contract\n')
  console.log(formatTable(reports))
} finally {
  db.closeSync()
}
