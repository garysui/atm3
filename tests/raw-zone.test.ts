import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import {
  fetchExists,
  fetchManifestSchema,
  landRawFile,
  reindexRawZone,
} from '../server/raw-zone.ts'
import { withTempDatabase } from './helpers.ts'

const payload = new TextEncoder().encode(
  '{"status":"OK","results":[{"T":"AAPL","c":123.45}]}',
)

test('landRawFile stores verbatim payload, manifest, and index row', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-raw-'))

  try {
    await withTempDatabase(async (db) => {
      const manifest = await landRawFile({
        connection: db.connection,
        dataDir,
        runId: null,
        sourceId: 'polygon',
        dataset: 'grouped_daily',
        requestUrl: 'https://api.polygon.io/v2/aggs/grouped/x/2026-07-07',
        requestParams: { adjusted: false },
        marketScope: 'us_stocks',
        marketDate: '2026-07-07',
        httpStatus: 200,
        relativeFilePath: 'raw/polygon/grouped_daily/date=2026-07-07/us_stocks.json.gz',
        payload,
        rowCount: 1,
      })

      // Payload on disk gunzips back to the exact original bytes.
      const stored = await readFile(path.join(dataDir, manifest.file_path))
      assert.deepEqual(new Uint8Array(gunzipSync(stored)), payload)
      assert.equal(
        manifest.content_sha256,
        createHash('sha256').update(payload).digest('hex'),
      )

      // Manifest sidecar parses with the shared schema.
      const sidecar = fetchManifestSchema.parse(
        JSON.parse(
          await readFile(
            path.join(dataDir, `${manifest.file_path}.meta.json`),
            'utf8',
          ),
        ),
      )
      assert.deepEqual(sidecar, manifest)

      // Indexed and queryable by (source, dataset, market_date).
      assert.equal(
        await fetchExists(db.connection, {
          sourceId: 'polygon',
          dataset: 'grouped_daily',
          marketDate: '2026-07-07',
        }),
        true,
      )

      // Re-landing the same file path replaces the row, never duplicates.
      await landRawFile({
        connection: db.connection,
        dataDir,
        sourceId: 'polygon',
        dataset: 'grouped_daily',
        requestUrl: 'https://api.polygon.io/v2/aggs/grouped/x/2026-07-07',
        marketScope: 'us_stocks',
        marketDate: '2026-07-07',
        httpStatus: 200,
        relativeFilePath: 'raw/polygon/grouped_daily/date=2026-07-07/us_stocks.json.gz',
        payload,
        rowCount: 1,
      })
      const countResult = await db.connection.runAndReadAll(
        'select count(*) as fetch_rows from raw.fetches',
      )
      assert.equal(Number(countResult.getRowObjectsJson()[0]?.fetch_rows), 1)
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('reindexRawZone rebuilds raw.fetches from manifests alone', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-raw-reindex-'))

  try {
    await withTempDatabase(async (db) => {
      const landed = [
        await landRawFile({
          connection: db.connection,
          dataDir,
          sourceId: 'polygon',
          dataset: 'grouped_daily',
          requestUrl: 'https://api.polygon.io/a',
          marketDate: '2026-07-06',
          httpStatus: 200,
          relativeFilePath: 'raw/polygon/grouped_daily/date=2026-07-06/us_stocks.json.gz',
          payload,
          rowCount: 1,
        }),
        await landRawFile({
          connection: db.connection,
          dataDir,
          sourceId: 'polygon',
          dataset: 'splits',
          requestUrl: 'https://api.polygon.io/b',
          httpStatus: 200,
          relativeFilePath: 'raw/polygon/splits/snapshot_date=2026-07-08/page-00001.json.gz',
          payload,
          rowCount: 1,
        }),
      ]

      // Simulate losing the database index entirely.
      await db.connection.run('delete from raw.fetches')

      const manifests = await reindexRawZone(db.connection, dataDir)
      assert.equal(manifests, 2)

      const rowsResult = await db.connection.runAndReadAll(
        'select cast(fetch_id as varchar) as fetch_id, file_path from raw.fetches order by file_path',
      )
      const rows = rowsResult.getRowObjectsJson()
      assert.deepEqual(
        rows.map((row) => ({
          fetch_id: String(row.fetch_id),
          file_path: String(row.file_path),
        })),
        landed
          .map((manifest) => ({
            fetch_id: manifest.fetch_id,
            file_path: manifest.file_path,
          }))
          .sort((a, b) => (a.file_path < b.file_path ? -1 : 1)),
      )
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
