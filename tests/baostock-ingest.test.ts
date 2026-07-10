import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BaoStockRelayResult } from '../connectors/baostock.ts'
import { ingestBaoStockRawJob } from '../server/baostock-ingest.ts'
import { loadCnPrototypeUniverse } from '../server/cn-universe.ts'
import { reindexRawZone } from '../server/raw-zone.ts'
import { withTempDatabase } from './helpers.ts'

test('CN prototype universe is explicit, bounded, and owner-vetoable', async () => {
  const universe = await loadCnPrototypeUniverse()
  assert.equal(universe.securities.length, 42)
  assert.match(universe.warning, /never use/i)
  assert.ok(universe.securities.some(({ code }) => code === 'sh.600519'))
  assert.ok(universe.securities.some(({ code }) => code.startsWith('sh.688')))
  assert.ok(universe.securities.some(({ code }) => code.startsWith('sz.300')))
  assert.ok(universe.securities.some(({ code }) => code.startsWith('sz.301')))
})

test('BaoStock raw job lands exact frames and skips from reindexed manifests', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-baostock-raw-'))
  const payload = new Uint8Array(
    await readFile('tests/fixtures/baostock/stock_basic-frame-0001.txt'),
  )
  let calls = 0
  const relay = async (): Promise<BaoStockRelayResult> => {
    calls++
    return {
      frames: [{ seq: 1, request: 'fixture-request', payload }],
      clientVersion: '00.9.20',
      loginCode: '0',
      stderr: '',
    }
  }

  try {
    await withTempDatabase(async (db) => {
      const options = {
        runId: null,
        dataset: 'stock_basic',
        relativeDir:
          'raw/baostock/stock_basic/snapshot_date=2026-07-10/code=sh.600519',
        job: {
          api: 'query_stock_basic' as const,
          params: { code: 'sh.600519' },
        },
        relay,
        dataDir,
      }
      const first = await ingestBaoStockRawJob(db, options)
      assert.deepEqual(first, {
        dataset: 'stock_basic',
        scope: options.relativeDir,
        frames: 1,
        rows: 1,
        skipped: false,
      })

      const storedPath = path.join(
        dataDir,
        options.relativeDir,
        'frame-0001.frame',
      )
      assert.deepEqual(new Uint8Array(await readFile(storedPath)), payload)

      const second = await ingestBaoStockRawJob(db, options)
      assert.equal(second.skipped, true)
      assert.equal(calls, 1)

      await db.connection.run('delete from raw.fetches')
      assert.equal(await reindexRawZone(db.connection, dataDir), 1)
      const afterReindex = await ingestBaoStockRawJob(db, options)
      assert.equal(afterReindex.skipped, true)
      assert.equal(calls, 1)

      const manifestResult = await db.connection.runAndReadAll(`
        select json_extract_string(request_params, '$.client_version') as client,
               json_extract_string(request_params, '$.frame_count') as frames
        from raw.fetches
      `)
      assert.deepEqual(manifestResult.getRowObjectsJson()[0], {
        client: '00.9.20',
        frames: '1',
      })
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
