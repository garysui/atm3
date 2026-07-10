import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseBaoStockFrame } from '../server/baostock-frame.ts'
import { withTempDatabase } from './helpers.ts'

const fixtureDir = fileURLToPath(
  new URL('./fixtures/baostock', import.meta.url),
)

const expectedRows: Record<string, number> = {
  query_trade_dates: 10,
  query_all_stock: 5662,
  query_stock_basic: 1,
  query_history_k_data_plus: 8,
  query_dividend_data: 2,
  query_adjust_factor: 3,
}

test('BaoStock raw protocol fixtures parse and stage in DuckDB offline', async () => {
  const files = (await readdir(fixtureDir)).filter((file) => file.endsWith('.txt'))
  assert.equal(files.length, 17)

  const counts = new Map<string, number>()
  const hashes = new Map<string, string>()

  for (const file of files.sort()) {
    const bytes = new Uint8Array(await readFile(path.join(fixtureDir, file)))
    const frame = parseBaoStockFrame(bytes)
    assert.equal(frame.errorCode, '0')
    assert.equal(frame.errorMessage, 'success')
    counts.set(frame.method, (counts.get(frame.method) ?? 0) + frame.records.length)
    hashes.set(
      file,
      createHash('sha256').update(bytes).digest('hex'),
    )
  }

  assert.deepEqual(Object.fromEntries(counts), expectedRows)
  assert.equal(
    hashes.get('stock_basic-frame-0001.txt'),
    '0c8cf8181b356d33adcfd1121e161a8a9ac861712eda688d820b180092220548',
  )

  await withTempDatabase(async (db) => {
    await db.connection.run(
      'create temp table fixture_counts (method varchar, rows integer)',
    )
    for (const [method, rows] of counts) {
      await db.connection.run(
        'insert into fixture_counts values ($method, $rows)',
        { method, rows },
      )
    }
    const result = await db.connection.runAndReadAll(
      'select count(*) as methods, sum(rows) as rows from fixture_counts',
    )
    assert.deepEqual(result.getRowObjectsJson()[0], {
      methods: '6',
      rows: '5686',
    })
  })
})

test('BaoStock frame parser rejects truncated body data', async () => {
  const bytes = new Uint8Array(
    await readFile(path.join(fixtureDir, 'stock_basic-frame-0001.txt')),
  )
  const text = new TextDecoder().decode(bytes)
  const invalidLength = new TextEncoder().encode(
    `${text.slice(0, 11)}0000009999${text.slice(21)}`,
  )
  assert.throws(() => parseBaoStockFrame(invalidLength), /body length/)
})

test('BaoStock successful empty data field means zero records', () => {
  const separator = '\u0001'
  const body = [
    '0',
    'success',
    'query_dividend_data',
    'anonymous',
    '1',
    '500',
    '',
    'sh.600900',
    '2025',
    'operate',
    'code,dividOperateDate',
  ].join(separator)
  const header = `00.9.00${separator}14${separator}${String(body.length).padStart(10, '0')}`
  const frame = new TextEncoder().encode(
    `${header}${body}${separator}1234567890<![CDATA[]]>\n`,
  )
  assert.deepEqual(parseBaoStockFrame(frame).records, [])
})
