import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { adjustedReturnSeries } from '../server/return-series.ts'
import { buildAllFacts } from '../server/facts-build.ts'
import { landRawFile } from '../server/raw-zone.ts'
import type { Atm3Db } from '../server/db.ts'
import { withTempDatabase } from './helpers.ts'

const encoder = new TextEncoder()
const instrument = '358eb3ad-54bb-3799-aa09-2e23e6bb2494'

function payload(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

async function land(
  db: Atm3Db,
  dataDir: string,
  options: {
    dataset: string
    file: string
    value: unknown
    marketDate?: string
    rows: number
  },
): Promise<void> {
  await landRawFile({
    connection: db.connection,
    dataDir,
    sourceId: 'polygon',
    dataset: options.dataset,
    requestUrl: 'https://api.polygon.io/view-at-t-fixture',
    marketScope: 'us_stocks',
    marketDate: options.marketDate,
    httpStatus: 200,
    relativeFilePath: options.file,
    payload: payload(options.value),
    rowCount: options.rows,
  })
}

test('backward view at T is byte-equal after post-T raw lands and facts rebuild', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-view-at-t-'))
  try {
    await withTempDatabase(async (db) => {
      await land(db, dataDir, {
        dataset: 'reference_tickers',
        file: 'raw/polygon/reference_tickers/snapshot_date=2025-01-03/active=true/page-00001.json.gz',
        value: { results: [{
          ticker: 'VTST', name: 'View At T Fixture', market: 'stocks',
          locale: 'us', primary_exchange: 'XNAS', type: 'CS', active: true,
          currency_name: 'usd', composite_figi: 'VIEWATT0001',
          last_updated_utc: '2025-01-03T00:00:00Z',
        }] },
        rows: 1,
      })
      for (const [date, close] of [
        ['2025-01-02', 100],
        ['2025-01-03', 101],
      ] as const) {
        await land(db, dataDir, {
          dataset: 'grouped_daily', marketDate: date,
          file: `raw/polygon/grouped_daily/date=${date}/us_stocks.json.gz`,
          value: { results: [{
            T: 'VTST', o: close, h: close + 1, l: close - 1, c: close,
            v: 1000, vw: close, n: 10,
          }] },
          rows: 1,
        })
      }
      await buildAllFacts(db.connection, { dataDir })

      const before = await adjustedReturnSeries(db.connection, {
        instrumentId: instrument,
        marketScope: 'us_stocks',
        observations: 2,
        policy: 'split_dividend',
        asOf: '2025-01-03',
      })
      assert.equal(before.length, 2)

      // Land only post-T truth: a later bar and a later split statement.
      await land(db, dataDir, {
        dataset: 'grouped_daily', marketDate: '2025-01-06',
        file: 'raw/polygon/grouped_daily/date=2025-01-06/us_stocks.json.gz',
        value: { results: [{
          T: 'VTST', o: 51, h: 52, l: 50, c: 51, v: 2000, vw: 51, n: 20,
        }] },
        rows: 1,
      })
      await land(db, dataDir, {
        dataset: 'splits',
        file: 'raw/polygon/splits/snapshot_date=2025-01-06/page-00001.json.gz',
        value: { results: [{
          id: 'post-t-split', ticker: 'VTST', execution_date: '2025-01-06',
          split_from: 1, split_to: 2,
        }] },
        rows: 1,
      })
      await buildAllFacts(db.connection, { dataDir })

      const after = await adjustedReturnSeries(db.connection, {
        instrumentId: instrument,
        marketScope: 'us_stocks',
        observations: 2,
        policy: 'split_dividend',
        asOf: '2025-01-03',
      })
      assert.equal(JSON.stringify(after), JSON.stringify(before))

      const current = await adjustedReturnSeries(db.connection, {
        instrumentId: instrument,
        marketScope: 'us_stocks',
        observations: 3,
        policy: 'split_dividend',
      })
      assert.equal(current.length, 3)
      assert.notEqual(JSON.stringify(current.slice(0, 2)), JSON.stringify(before))
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
