import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApiServer } from '../server/api.ts'
import { openDatabase } from '../server/db.ts'
import { A, seedFacts } from './fixtures.ts'

test('api serves health, scopes, search, detail, and policy bars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-api-'))
  const dbPath = path.join(dir, 'atm3.duckdb')

  // Seed with a writer, then release it — the API opens read-only. One extra
  // instrument uses a REAL macro-minted id so the API is exercised with
  // production id shapes, not just handcrafted fixture uuids.
  const writer = await openDatabase({ dbPath })
  const mintedId = await (async () => {
    try {
      await seedFacts(writer)
      const minted = await writer.connection.runAndReadAll(`
        select cast(deterministic_uuid('instrument', 'apitest') as varchar) as id
      `)
      const id = String(minted.getRowObjectsJson()[0]?.id)
      await writer.connection.run(
        `
          insert into facts.instruments (
            instrument_id, asset_class, instrument_type, name,
            primary_market_scope
          ) values (cast($id as uuid), 'equity', 'common_stock', 'Minted Corp',
                    'us_stocks')
        `,
        { id },
      )
      return id
    } finally {
      writer.closeSync()
    }
  })()

  const server = await createApiServer({ dbPath })
  const listener = server.app.listen(0)
  await new Promise((resolve) => listener.once('listening', resolve))
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`

  try {
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      ok: boolean
      schemaVersion: number
    }
    assert.equal(health.ok, true)
    assert.equal(health.schemaVersion, 3)

    const scopes = (await (await fetch(`${base}/api/scopes`)).json()) as Array<{
      scope: string
    }>
    assert.deepEqual(scopes, [{ scope: 'us_stocks' }])

    const found = (await (
      await fetch(`${base}/api/instruments?scope=us_stocks&q=AAA`)
    ).json()) as Array<Record<string, unknown>>
    assert.equal(found.length, 1)
    assert.equal(found[0]?.symbol, 'AAA')
    assert.equal(found[0]?.name, 'Alpha Corp')
    assert.equal(found[0]?.instrument_id, A)

    const detail = (await (
      await fetch(`${base}/api/instruments/${A}`)
    ).json()) as {
      instrument: Record<string, unknown>
      symbols: unknown[]
      corporateActions: unknown[]
      barsSummary: Record<string, unknown>
    }
    assert.equal(detail.instrument.name, 'Alpha Corp')
    assert.equal(detail.symbols.length, 1)
    assert.equal(detail.corporateActions.length, 7)
    assert.equal(Number(detail.barsSummary.bars), 3)

    const barsFor = async (query: string) =>
      (await (
        await fetch(`${base}/api/instruments/${A}/bars?${query}`)
      ).json()) as { bars: Array<{ close: number }> }

    const none = await barsFor('policy=none')
    assert.equal(none.bars.length, 3)
    assert.equal(none.bars[0]?.close, 100)

    const split = await barsFor('policy=split')
    assert.equal(split.bars[0]?.close, 50)

    // As-of T through the API: viewed from 2025-01-02 the split has not
    // happened — the tape's real price is served.
    const asOf = await barsFor('policy=split_dividend&as_of=2025-01-02')
    assert.equal(asOf.bars.length, 1)
    assert.equal(asOf.bars[0]?.close, 100)

    // Macro-minted ids must pass API validation (regression: z.uuid()
    // rejected non-RFC hash ids and 400'd most real instruments).
    const minted = await fetch(`${base}/api/instruments/${mintedId}`)
    assert.equal(minted.status, 200)
    const mintedBars = await fetch(
      `${base}/api/instruments/${mintedId}/bars?policy=none`,
    )
    assert.equal(mintedBars.status, 200)

    const missing = await fetch(
      `${base}/api/instruments/99999999-9999-4999-8999-999999999999`,
    )
    assert.equal(missing.status, 404)

    const badPolicy = await fetch(
      `${base}/api/instruments/${A}/bars?policy=bogus`,
    )
    assert.equal(badPolicy.status, 400)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    server.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
