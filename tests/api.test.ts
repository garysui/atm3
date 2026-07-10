import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApiServer } from '../server/api.ts'
import { gzipSync } from 'node:zlib'
import { refreshAdjustedBarsCache } from '../server/computed-build.ts'
import { openDatabase, SCHEMA_VERSION } from '../server/db.ts'
import { buildMinuteParquet } from '../server/facts-minute.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { A, seedFacts } from './fixtures.ts'
import {
  metricsCatalog,
  sessionMetricsCatalog,
} from '../core/metrics-catalog.ts'

const CN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test('api serves health, scopes, search, detail, and policy bars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm3-api-'))
  const dbPath = path.join(dir, 'atm3.duckdb')

  // Seed with a writer, then release it — the API opens read-only. One extra
  // instrument uses a REAL macro-minted id so the API is exercised with
  // production id shapes, not just handcrafted fixture uuids.
  const writer = await openDatabase({ dbPath, dataDir: dir })
  const encoder = new TextEncoder()
  const landMinutes = async (date: string, rows: string[][]) =>
    landRawFile({
      connection: writer.connection,
      dataDir: dir,
      sourceId: 'polygon',
      dataset: 'minute_aggs',
      requestUrl: `https://files.massive.com/flatfiles/${date}`,
      marketScope: 'us_stocks',
      marketDate: date,
      httpStatus: 200,
      relativeFilePath: `raw/polygon/minute_aggs/date=${date}/us_stocks.csv.gz`,
      payload: new Uint8Array(
        gzipSync(
          encoder.encode(
            [
              'ticker,volume,open,close,high,low,window_start,transactions',
              ...rows.map((row) => row.join(',')),
            ].join('\n'),
          ),
        ),
      ),
      storeVerbatim: true,
    })
  const mintedId = await (async () => {
    try {
      await seedFacts(writer)
      // Two sessions of AAA minutes so view-at-minute serves real data.
      // 2025-01-02T14:30:00Z = 09:30 ET.
      await landMinutes('2025-01-02', [
        ['AAA', '1000', '100', '100', '100.5', '99.5', '1735828200000000000', '10'],
        ['AAA', '500', '100', '101', '101', '100', '1735828260000000000', '5'],
      ])
      await landMinutes('2025-01-03', [
        ['AAA', '2000', '51', '51', '51.5', '50.5', '1735914600000000000', '20'],
      ])
      await buildMinuteParquet(writer.connection, { dataDir: dir })
      await refreshAdjustedBarsCache(writer.connection)
      await writer.connection.run(`
        insert into facts.exchanges (
          exchange_mic, name, market_scope, calendar_id, timezone, currency
        ) values
          ('XNAS', 'NASDAQ', 'us_stocks', 'us_equities', 'America/New_York', 'USD'),
          ('XSHG', 'Shanghai', 'cn_stocks', 'cn_equities', 'Asia/Shanghai', 'CNY');
        insert into facts.trading_days (
          calendar_id, market_date, is_open, source_id
        )
        select 'us_equities', d, true, 'fixture'
        from generate_series(date '2025-01-02', date '2026-12-31', interval 1 day) t(d)
        where dayofweek(d) not in (0, 6)
        union all
        select 'cn_equities', d, true, 'fixture'
        from generate_series(date '2025-01-02', date '2026-12-31', interval 1 day) t(d)
        where dayofweek(d) not in (0, 6);
        insert into facts.instruments (
          instrument_id, asset_class, instrument_type, name,
          primary_market_scope, primary_exchange_mic, currency
        ) values (
          cast('${CN}' as uuid), 'equity', 'common_stock', '贵州茅台',
          'cn_stocks', 'XSHG', 'CNY'
        );
        insert into facts.symbols (
          symbol_id, instrument_id, market_scope, symbol, exchange_mic,
          valid_from, is_primary
        ) values (
          cast('dddddddd-dddd-4ddd-8ddd-dddddddddddd' as uuid),
          cast('${CN}' as uuid), 'cn_stocks', '600519', 'XSHG',
          date '2001-08-27', true
        );
        insert into facts.bars_daily (
          source_id, instrument_id, market_date, market_scope, symbol_as_traded,
          open, high, low, close, volume
        ) values
          ('baostock', cast('${CN}' as uuid), date '2025-01-02',
           'cn_stocks', '600519', 100, 100, 100, 100, 1000),
          ('baostock', cast('${CN}' as uuid), date '2025-01-03',
           'cn_stocks', '600519', 99, 99, 99, 99, 1100);
        insert into facts.corporate_actions (
          source_id, source_action_id, instrument_id, market_scope,
          symbol_as_stated, action_type, ex_date, cash_amount,
          cash_amount_post_tax, currency
        ) values (
          'baostock', 'cn-cash', cast('${CN}' as uuid), 'cn_stocks',
          '600519', 'cash_dividend', date '2025-01-03', 1, 0.9, 'CNY'
        )
      `)
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

  const server = await createApiServer({
    dbPath,
    dataDir: dir,
    operationSteps: [
      {
        id: 'op:test',
        label: 'test op',
        stage: 'raw',
        description: 'stub operation for endpoint tests',
        run: async () => ({ ok: true }),
      },
    ],
  })
  const listener = server.app.listen(0)
  await new Promise((resolve) => listener.once('listening', resolve))
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`

  try {
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      ok: boolean
      schemaVersion: number
    }
    assert.equal(health.ok, true)
    assert.equal(health.schemaVersion, SCHEMA_VERSION)

    const scopes = (await (await fetch(`${base}/api/scopes`)).json()) as Array<{
      scope: string
    }>
    assert.deepEqual(scopes, [{ scope: 'cn_stocks' }, { scope: 'us_stocks' }])

    const cnByCode = (await (
      await fetch(`${base}/api/instruments?scope=cn_stocks&q=600519`)
    ).json()) as Array<Record<string, unknown>>
    assert.equal(cnByCode[0]?.instrument_id, CN)
    const cnByName = (await (
      await fetch(
        `${base}/api/instruments?scope=cn_stocks&q=${encodeURIComponent('贵州茅台')}`,
      )
    ).json()) as Array<Record<string, unknown>>
    assert.equal(cnByName[0]?.symbol, '600519')

    const found = (await (
      await fetch(`${base}/api/instruments?scope=us_stocks&q=AAA`)
    ).json()) as Array<Record<string, unknown>>
    assert.equal(found.length, 2) // current AAA first, historical AAAOLD after
    assert.equal(found[0]?.symbol, 'AAA')
    assert.equal(found[0]?.symbol_usage, 'current')
    assert.equal(found[0]?.name, 'Alpha Corp')
    assert.equal(found[0]?.instrument_id, A)
    assert.equal(found[1]?.symbol, 'AAAOLD')
    assert.equal(found[1]?.symbol_usage, '2020-01-01 → 2022-01-01')

    // Searching a PAST ticker surfaces the instrument that used it, with the
    // usage window labeled (the FB→Meta case).
    const historical = (await (
      await fetch(`${base}/api/instruments?scope=us_stocks&q=AAAOLD`)
    ).json()) as Array<Record<string, unknown>>
    assert.equal(historical.length, 1)
    assert.equal(historical[0]?.instrument_id, A)
    assert.equal(historical[0]?.symbol_usage, '2020-01-01 → 2022-01-01')

    const detail = (await (
      await fetch(`${base}/api/instruments/${A}`)
    ).json()) as {
      instrument: Record<string, unknown>
      symbols: unknown[]
      corporateActions: unknown[]
      barsSummary: Record<string, unknown>
    }
    assert.equal(detail.instrument.name, 'Alpha Corp')
    assert.equal(detail.symbols.length, 2) // AAAOLD (historical) + AAA (current)
    assert.equal(detail.corporateActions.length, 7)
    assert.equal(Number(detail.barsSummary.bars), 3)

    const cnDetail = (await (
      await fetch(`${base}/api/instruments/${CN}`)
    ).json()) as { corporateActions: Array<Record<string, unknown>> }
    assert.equal(cnDetail.corporateActions[0]?.cash_amount_post_tax, 0.9)

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

    const viewAt = (await (
      await fetch(`${base}/api/instruments/${A}/view-at?t=2025-01-03`)
    ).json()) as {
      t: string
      metrics: Array<{ id: string }>
      forward?: unknown
    }
    assert.equal(viewAt.t, '2025-01-03')
    assert.deepEqual(
      viewAt.metrics.map(({ id }) => id),
      metricsCatalog.map(({ id }) => id),
    )
    assert.equal(viewAt.forward, undefined)

    const withForward = (await (
      await fetch(
        `${base}/api/instruments/${A}/view-at?t=2025-01-02&forward=1&entry=t_close`,
      )
    ).json()) as {
      forward: { hindsight: boolean; entry_basis: string; rows: unknown[] }
    }
    assert.equal(withForward.forward.hindsight, true)
    assert.equal(withForward.forward.entry_basis, 't_close')
    assert.equal(withForward.forward.rows.length, 6)

    const cnViewAt = (await (
      await fetch(`${base}/api/instruments/${CN}/view-at?t=2025-01-03`)
    ).json()) as { metrics: Array<{ family: string; reason: string }> }
    assert.ok(
      cnViewAt.metrics
        .filter(({ family }) => family === 'context')
        .every(({ reason }) => reason === 'no_market_baseline'),
    )
    const invalidT = await fetch(
      `${base}/api/instruments/${A}/view-at?t=2025-01-04`,
    )
    assert.equal(invalidT.status, 404)
    assert.match(
      String(((await invalidT.json()) as { error: string }).error),
      /previous: 2025-01-03, next: 2025-01-06/,
    )

    // The intraday view at minute T: exact session catalog, the daily view
    // as of the previous close, and labeled hindsight horizons.
    const minuteView = (await (
      await fetch(
        `${base}/api/instruments/${A}/view-at-minute?date=2025-01-03&minute=09:31&forward=1`,
      )
    ).json()) as {
      t: { date: string; minute: string }
      visible_bars: number
      metrics: Array<{ id: string }>
      daily: { t: string; metrics: Array<{ id: string }> } | null
      forward: { hindsight: boolean; rows: Array<{ horizon: string }> }
    }
    assert.deepEqual(minuteView.t, { date: '2025-01-03', minute: '09:31' })
    assert.equal(minuteView.visible_bars, 1)
    assert.deepEqual(
      minuteView.metrics.map(({ id }) => id),
      sessionMetricsCatalog.map(({ id }) => id),
    )
    assert.equal(minuteView.daily?.t, '2025-01-02')
    assert.deepEqual(
      minuteView.daily?.metrics.map(({ id }) => id),
      metricsCatalog.map(({ id }) => id),
    )
    assert.equal(minuteView.forward.hindsight, true)
    assert.deepEqual(
      minuteView.forward.rows.map(({ horizon }) => horizon),
      ['to_close', 'next_open', '1d', '5d'],
    )

    // Cross-sectional ranking: valid shape on a real bar date (windows are
    // too short here for any name to qualify — honesty, not absence), 404
    // with neighbors on a non-bar date.
    const rank = (await (
      await fetch(`${base}/api/rank-at?t=2025-01-03&scope=us_stocks`)
    ).json()) as {
      baseline: null
      sort: string
      universe: { traded_at_t: number; qualifying: number }
      rows: unknown[]
    }
    assert.equal(rank.baseline, null) // no SPY in this fixture
    assert.equal(rank.sort, 'ret_z')
    assert.ok(rank.universe.traded_at_t >= 1)
    assert.equal(rank.universe.qualifying, 0)
    assert.deepEqual(rank.rows, [])
    const rankBadDate = await fetch(
      `${base}/api/rank-at?t=2025-01-04&scope=us_stocks`,
    )
    assert.equal(rankBadDate.status, 404)

    const noMinutes = await fetch(
      `${base}/api/instruments/${A}/view-at-minute?date=2025-01-06&minute=10:00`,
    )
    assert.equal(noMinutes.status, 404)
    assert.match(
      String(((await noMinutes.json()) as { error: string }).error),
      /previous: 2025-01-03/,
    )

    // Intraday endpoints serve the fixture's two minute sessions; bad dates
    // are rejected.
    const minuteDays = (await (
      await fetch(`${base}/api/instruments/${A}/minute-days`)
    ).json()) as { days: Array<{ date: string; bars: string }> }
    assert.deepEqual(
      minuteDays.days.map(({ date, bars }) => ({ date, bars })),
      [
        { date: '2025-01-03', bars: '1' },
        { date: '2025-01-02', bars: '2' },
      ],
    )
    const minuteBars = (await (
      await fetch(
        `${base}/api/instruments/${A}/minute-bars?date=2025-01-02&policy=split`,
      )
    ).json()) as { bars: Array<{ close: number }>; date: string }
    assert.equal(minuteBars.bars.length, 2)
    // Split policy halves the pre-split session's prices.
    assert.equal(minuteBars.bars[0]?.close, 50)
    assert.equal(minuteBars.date, '2025-01-02')
    assert.equal(
      (await fetch(`${base}/api/instruments/${A}/minute-bars?date=nope`))
        .status,
      400,
    )

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

    // Docs are served into the UI; names are allowlisted from docs/*.md.
    const docs = (await (await fetch(`${base}/api/docs`)).json()) as Array<{
      name: string
      title: string
    }>
    assert.ok(docs.some((doc) => doc.name === 'market-data-phenomena'))

    const phenomena = (await (
      await fetch(`${base}/api/docs/market-data-phenomena`)
    ).json()) as { markdown: string }
    assert.ok(phenomena.markdown.includes('Tickers change'))

    assert.equal((await fetch(`${base}/api/docs/no-such-doc`)).status, 404)
    assert.equal(
      (await fetch(`${base}/api/docs/..%2Fpackage`)).status, 400)

    // Operations endpoints (stub step injected by this test).
    const operations = (await (await fetch(`${base}/api/operations`)).json()) as {
      steps: Array<{ id: string; live: { state: string }; lastRun: unknown }>
    }
    assert.equal(operations.steps.length, 1)
    assert.equal(operations.steps[0]?.id, 'op:test')
    assert.equal(operations.steps[0]?.live.state, 'idle')

    const enqueue = await fetch(`${base}/api/operations/op:test/run`, {
      method: 'POST',
    })
    assert.equal(((await enqueue.json()) as { queued: boolean }).queued, true)

    for (let i = 0; i < 40; i++) {
      const now = (await (await fetch(`${base}/api/operations`)).json()) as {
        steps: Array<{ live: { state: string }; lastRun: { status?: string } | null }>
      }

      if (now.steps[0]?.live.state === 'ok') {
        assert.equal(now.steps[0]?.lastRun?.status, 'ok')
        break
      }

      assert.notEqual(now.steps[0]?.live.state, 'failed')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    assert.equal(
      (await fetch(`${base}/api/operations/nope/run`, { method: 'POST' }))
        .status,
      404,
    )
  } finally {
    await new Promise((resolve) => listener.close(resolve))
    server.closeSync()
    await rm(dir, { recursive: true, force: true })
  }
})
