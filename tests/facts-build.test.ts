import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Atm3Db } from '../server/db.ts'
import { buildAllFacts } from '../server/facts-build.ts'
import { landRawFile } from '../server/raw-zone.ts'
import { withTempDatabase } from './helpers.ts'

// Synthetic raw zone exercising the canonical identity cases:
// - FIGMETA0001: FB until 2022-06-09 then META (ticker change, FIGI stable),
//   refined by a ticker_events file.
// - FIGETF00001: an ETF that reused the FB ticker afterwards (no events
//   file — its start must be inferred by chaining from the delisted usage).
// - FIGACME0001: OLDA renamed to ACME inside the bar window — bars under
//   both tickers must land on one instrument.
// - MYST: trades but has no reference row — must be quarantined.
const encoder = new TextEncoder()

function json(payload: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(payload))
}

const activeTickers = {
  results: [
    {
      ticker: 'META',
      name: 'Meta Platforms, Inc. Class A Common Stock',
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'XNAS',
      type: 'CS',
      active: true,
      currency_name: 'usd',
      cik: '0001326801',
      composite_figi: 'FIGMETA0001',
      share_class_figi: 'SCMETA00001',
      last_updated_utc: '2026-07-08T00:00:00Z',
    },
    {
      ticker: 'FB',
      name: 'ProShares Test Buffer ETF',
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'ARCX',
      type: 'ETF',
      active: true,
      currency_name: 'usd',
      composite_figi: 'FIGETF00001',
      last_updated_utc: '2026-07-08T00:00:00Z',
    },
    {
      ticker: 'ACME',
      name: 'Acme Corp Class A',
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'XNYS',
      type: 'CS',
      active: true,
      currency_name: 'usd',
      cik: '0000000002',
      composite_figi: 'FIGACME0001',
      last_updated_utc: '2026-07-08T00:00:00Z',
    },
    {
      // Concurrent when-issued tape line for the same instrument (AAP/AAPW
      // pattern): both tickers are active and can trade on the same day.
      ticker: 'ACMEW',
      name: 'Acme Corp Class A (When Issued)',
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'XNYS',
      type: 'CS',
      active: true,
      currency_name: 'usd',
      cik: '0000000002',
      composite_figi: 'FIGACME0001',
      last_updated_utc: '2026-07-07T00:00:00Z',
    },
    {
      ticker: 'NEWS',
      name: 'Newswire Inc.',
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'XNAS',
      type: 'CS',
      active: true,
      currency_name: 'usd',
      composite_figi: 'FIGNEWS0001',
      last_updated_utc: '2026-07-08T00:00:00Z',
    },
    {
      // Ticker case is significant: ACMpA (preferred) and ACMPA (a
      // different OTC security, not in this universe) must never collapse.
      ticker: 'ACMpA',
      name: 'Acme Corp 5% Series A Preferred',
      market: 'stocks',
      locale: 'us',
      primary_exchange: 'XNYS',
      type: 'PFD',
      active: true,
      currency_name: 'usd',
      composite_figi: 'FIGACMEPFD1',
      last_updated_utc: '2026-07-08T00:00:00Z',
    },
  ],
  status: 'OK',
}

const inactiveTickers = {
  results: [
    {
      ticker: 'FB',
      name: 'Meta Platforms, Inc. Class A Common Stock',
      market: 'stocks',
      locale: 'us',
      type: 'CS',
      active: false,
      cik: '0001326801',
      composite_figi: 'FIGMETA0001',
      share_class_figi: 'SCMETA00001',
      delisted_utc: '2022-06-09T00:00:00Z',
      last_updated_utc: '2022-06-09T00:00:00Z',
    },
    {
      ticker: 'OLDA',
      name: 'Acme Corp (Old Name)',
      market: 'stocks',
      locale: 'us',
      type: 'CS',
      active: false,
      cik: '0000000002',
      composite_figi: 'FIGACME0001',
      delisted_utc: '2025-01-15T00:00:00Z',
      last_updated_utc: '2025-01-15T00:00:00Z',
    },
    {
      // Rename where the vendor never stamped delisted_utc (ISDR→ACCS
      // pattern): the usage must still end, using last_updated_utc.
      ticker: 'OLDN',
      name: 'Newswire Inc. (Old Name)',
      market: 'stocks',
      locale: 'us',
      type: 'CS',
      active: false,
      composite_figi: 'FIGNEWS0001',
      last_updated_utc: '2025-02-10T00:00:00Z',
    },
  ],
  status: 'OK',
}

const metaEvents = {
  results: {
    name: 'Meta Platforms, Inc. Class A Common Stock',
    composite_figi: 'FIGMETA0001',
    cik: '0001326801',
    events: [
      { ticker_change: { ticker: 'META' }, type: 'ticker_change', date: '2022-06-09' },
      { ticker_change: { ticker: 'FB' }, type: 'ticker_change', date: '2012-05-18' },
    ],
  },
  status: 'OK',
}

const groupedByDate: Record<string, unknown> = {
  '2025-01-14': {
    status: 'OK',
    queryCount: 3,
    resultsCount: 3,
    results: [
      { T: 'OLDA', o: 10, h: 10.5, l: 9.8, c: 10.2, v: 1000, vw: 10.1, t: 1736888400000, n: 5 },
      { T: 'META', o: 600, h: 610, l: 598, c: 605, v: 9000, vw: 604, t: 1736888400000, n: 90 },
      { T: 'MYST', o: 1, h: 1.2, l: 0.9, c: 1.1, v: 50, vw: 1, t: 1736888400000, n: 2 },
    ],
  },
  '2025-01-15': {
    status: 'OK',
    queryCount: 3,
    resultsCount: 3,
    results: [
      { T: 'ACME', o: 10.2, h: 11, l: 10.1, c: 10.9, v: 1200, vw: 10.6, t: 1736974800000, n: 6 },
      { T: 'ACMEW', o: 10.1, h: 10.9, l: 10, c: 10.8, v: 100, vw: 10.5, t: 1736974800000, n: 2 },
      { T: 'ACMpA', o: 21.5, h: 21.7, l: 21.4, c: 21.6, v: 400, vw: 21.5, t: 1736974800000, n: 4 },
      { T: 'META', o: 605, h: 612, l: 604, c: 611, v: 8000, vw: 609, t: 1736974800000, n: 80 },
    ],
  },
  '2025-01-16': { status: 'OK', queryCount: 0, resultsCount: 0 },
}

const splits = {
  results: [
    { id: 'split-acme-1', ticker: 'ACME', execution_date: '2025-03-03', split_from: 1, split_to: 2 },
    { id: 'split-myst-1', ticker: 'MYST', execution_date: '2025-03-03', split_from: 1, split_to: 3 },
    // Stated under the all-caps OTC ticker: must NOT resolve to the
    // preferred ACMpA via case folding.
    { id: 'split-otc-1', ticker: 'ACMPA', execution_date: '2025-03-03', split_from: 65, split_to: 1 },
  ],
  status: 'OK',
}

const dividends = {
  results: [
    {
      id: 'div-meta-1',
      ticker: 'META',
      ex_dividend_date: '2025-02-20',
      cash_amount: 0.5,
      currency: 'USD',
      declaration_date: '2025-02-01',
      dividend_type: 'CD',
      frequency: 4,
      pay_date: '2025-03-26',
      record_date: '2025-02-21',
    },
  ],
  status: 'OK',
}

const exchanges = {
  results: [
    { id: 1, type: 'exchange', asset_class: 'stocks', locale: 'us', name: 'NASDAQ', mic: 'XNAS', operating_mic: 'XNAS' },
    { id: 2, type: 'exchange', asset_class: 'stocks', locale: 'us', name: 'NYSE Arca', mic: 'ARCX', operating_mic: 'ARCX' },
  ],
  status: 'OK',
}

const holidays = [
  { exchange: 'NYSE', name: 'Test Holiday', date: '2026-11-26', status: 'closed' },
  { exchange: 'NASDAQ', name: 'Test Holiday', date: '2026-11-26', status: 'closed' },
  {
    exchange: 'NYSE',
    name: 'Half Day',
    date: '2026-11-27',
    status: 'early-close',
    open: '2026-11-27T14:30:00.000Z',
    close: '2026-11-27T18:00:00.000Z',
  },
]

async function landFixture(db: Atm3Db, dataDir: string): Promise<void> {
  const base = {
    connection: db.connection,
    dataDir,
    sourceId: 'polygon',
    requestUrl: 'https://api.polygon.io/fixture',
    httpStatus: 200,
  }

  await landRawFile({
    ...base,
    dataset: 'reference_tickers',
    relativeFilePath:
      'raw/polygon/reference_tickers/snapshot_date=2026-07-08/active=true/page-00001.json.gz',
    payload: json(activeTickers),
    rowCount: activeTickers.results.length,
  })
  await landRawFile({
    ...base,
    dataset: 'reference_tickers',
    relativeFilePath:
      'raw/polygon/reference_tickers/snapshot_date=2026-07-08/active=false/page-00001.json.gz',
    payload: json(inactiveTickers),
    rowCount: inactiveTickers.results.length,
  })
  await landRawFile({
    ...base,
    dataset: 'ticker_events',
    relativeFilePath:
      'raw/polygon/ticker_events/snapshot_date=2026-07-08/META.json.gz',
    payload: json(metaEvents),
    rowCount: 2,
  })

  for (const [date, payload] of Object.entries(groupedByDate)) {
    const results = (payload as { results?: unknown[] }).results

    await landRawFile({
      ...base,
      dataset: 'grouped_daily',
      marketDate: date,
      relativeFilePath: `raw/polygon/grouped_daily/date=${date}/us_stocks.json.gz`,
      payload: json(payload),
      rowCount: results?.length ?? 0,
    })
  }

  await landRawFile({
    ...base,
    dataset: 'splits',
    relativeFilePath:
      'raw/polygon/splits/snapshot_date=2026-07-08/page-00001.json.gz',
    payload: json(splits),
    rowCount: splits.results.length,
  })
  await landRawFile({
    ...base,
    dataset: 'dividends',
    relativeFilePath:
      'raw/polygon/dividends/snapshot_date=2026-07-08/page-00001.json.gz',
    payload: json(dividends),
    rowCount: dividends.results.length,
  })
  await landRawFile({
    ...base,
    dataset: 'exchanges',
    relativeFilePath:
      'raw/polygon/exchanges/snapshot_date=2026-07-08/exchanges.json.gz',
    payload: json(exchanges),
    rowCount: exchanges.results.length,
  })
  await landRawFile({
    ...base,
    dataset: 'market_holidays',
    relativeFilePath:
      'raw/polygon/market_holidays/snapshot_date=2026-07-08/upcoming.json.gz',
    payload: json(holidays),
    rowCount: holidays.length,
  })
}

async function instrumentIdFor(db: Atm3Db, identityKey: string) {
  const result = await db.connection.runAndReadAll(
    `select cast(deterministic_uuid('instrument', $key) as varchar) as id`,
    { key: identityKey },
  )
  return String(result.getRowObjectsJson()[0]?.id)
}

async function resolveSymbol(db: Atm3Db, symbol: string, date: string) {
  const result = await db.connection.runAndReadAll(
    `
      select cast(instrument_id as varchar) as instrument_id
      from facts.symbols
      where market_scope = 'us_stocks'
        and symbol = $symbol
        and (valid_from is null or valid_from <= cast($date as date))
        and (valid_to is null or valid_to > cast($date as date))
    `,
    { symbol, date },
  )
  return result.getRowObjectsJson().map((row) => String(row.instrument_id))
}

test('facts builders: identity, chaining, bars, actions, calendar, determinism', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atm3-facts-'))

  try {
    await withTempDatabase(async (db) => {
      await landFixture(db, dataDir)

      const summary = await buildAllFacts(db.connection, { dataDir })
      assert.equal(summary.instruments, 5)
      assert.equal(summary.exchanges, 2)

      const metaId = await instrumentIdFor(db, 'FIGMETA0001')
      const etfId = await instrumentIdFor(db, 'FIGETF00001')
      const acmeId = await instrumentIdFor(db, 'FIGACME0001')

      // The canonical ticker-reuse case: FB resolves by date, unambiguously.
      assert.deepEqual(await resolveSymbol(db, 'FB', '2020-01-01'), [metaId])
      assert.deepEqual(await resolveSymbol(db, 'FB', '2024-01-01'), [etfId])
      // Meta's FB range is refined by ticker_events (exact IPO start).
      const metaSymbols = await db.connection.runAndReadAll(
        `
          select symbol, cast(valid_from as varchar) as valid_from,
                 cast(valid_to as varchar) as valid_to
          from facts.symbols
          where instrument_id = cast($id as uuid)
          order by valid_from nulls first
        `,
        { id: metaId },
      )
      assert.deepEqual(metaSymbols.getRowObjectsJson(), [
        { symbol: 'FB', valid_from: '2012-05-18', valid_to: '2022-06-09' },
        { symbol: 'META', valid_from: '2022-06-09', valid_to: null },
      ])
      // The ETF (no events file) starts where Meta's FB usage ended: chained.
      const etfRows = await db.connection.runAndReadAll(
        `
          select cast(valid_from as varchar) as valid_from
          from facts.symbols
          where instrument_id = cast($id as uuid) and symbol = 'FB'
        `,
        { id: etfId },
      )
      assert.deepEqual(etfRows.getRowObjectsJson(), [
        { valid_from: '2022-06-09' },
      ])

      // Bars: OLDA (01-14) and ACME (01-15) land on ONE instrument, and the
      // concurrent when-issued line ACMEW keeps its own bar on the same day.
      const acmeBars = await db.connection.runAndReadAll(
        `
          select symbol_as_traded, cast(market_date as varchar) as market_date
          from facts.bars_daily
          where instrument_id = cast($id as uuid)
          order by market_date, symbol_as_traded
        `,
        { id: acmeId },
      )
      assert.deepEqual(acmeBars.getRowObjectsJson(), [
        { symbol_as_traded: 'OLDA', market_date: '2025-01-14' },
        { symbol_as_traded: 'ACME', market_date: '2025-01-15' },
        { symbol_as_traded: 'ACMEW', market_date: '2025-01-15' },
      ])
      assert.equal(summary.bars, 6) // OLDA+META, ACME+ACMEW+ACMpA+META

      // Case-significant tickers stay separate: the preferred keeps its bar,
      // and the OTC-stated split must not contaminate it.
      const preferredId = await instrumentIdFor(db, 'FIGACMEPFD1')
      assert.deepEqual(await resolveSymbol(db, 'ACMpA', '2025-01-15'), [
        preferredId,
      ])
      assert.deepEqual(await resolveSymbol(db, 'ACMPA', '2025-01-15'), [])

      // A rename without delisted_utc still ends the old usage: OLDN
      // resolves inside its window and nowhere after last_updated_utc.
      const newsId = await instrumentIdFor(db, 'FIGNEWS0001')
      assert.deepEqual(await resolveSymbol(db, 'OLDN', '2025-01-14'), [newsId])
      assert.deepEqual(await resolveSymbol(db, 'OLDN', '2026-01-01'), [])

      // MYST traded but has no identity: quarantined, never guessed.
      const unresolvedBars = await db.connection.runAndReadAll(`
        select symbol, reason from ops.unresolved
        where dataset = 'grouped_daily'
      `)
      assert.deepEqual(unresolvedBars.getRowObjectsJson(), [
        { symbol: 'MYST', reason: 'no_symbol_match' },
      ])

      // Corporate actions resolve through symbol validity at ex date.
      const actions = await db.connection.runAndReadAll(`
        select action_type, symbol_as_stated,
               cast(instrument_id as varchar) as instrument_id
        from facts.corporate_actions
        order by action_type
      `)
      assert.deepEqual(actions.getRowObjectsJson(), [
        { action_type: 'cash_dividend', symbol_as_stated: 'META', instrument_id: metaId },
        { action_type: 'split', symbol_as_stated: 'ACME', instrument_id: acmeId },
      ])
      const unresolvedActions = await db.connection.runAndReadAll(`
        select symbol from ops.unresolved where dataset = 'splits'
        order by symbol
      `)
      assert.deepEqual(unresolvedActions.getRowObjectsJson(), [
        { symbol: 'ACMPA' },
        { symbol: 'MYST' },
      ])

      // Calendar: past days from grouped evidence, future from holidays.
      const days = await db.connection.runAndReadAll(`
        select cast(market_date as varchar) as market_date, is_open,
               is_half_day
        from facts.trading_days
        order by market_date
      `)
      assert.deepEqual(days.getRowObjectsJson(), [
        { market_date: '2025-01-14', is_open: true, is_half_day: false },
        { market_date: '2025-01-15', is_open: true, is_half_day: false },
        { market_date: '2025-01-16', is_open: false, is_half_day: false },
        { market_date: '2026-11-26', is_open: false, is_half_day: false },
        { market_date: '2026-11-27', is_open: true, is_half_day: true },
      ])

      // Classification came from the shared map.
      const types = await db.connection.runAndReadAll(
        `
          select instrument_type, is_clean_common_stock
          from facts.instruments
          where instrument_id = cast($id as uuid)
        `,
        { id: etfId },
      )
      assert.deepEqual(types.getRowObjectsJson(), [
        { instrument_type: 'etf', is_clean_common_stock: false },
      ])

      // Determinism: rebuilding from the same raw reproduces ids and counts.
      const before = await db.connection.runAndReadAll(
        'select cast(instrument_id as varchar) as id from facts.instruments order by id',
      )
      const summaryAgain = await buildAllFacts(db.connection, { dataDir })
      const after = await db.connection.runAndReadAll(
        'select cast(instrument_id as varchar) as id from facts.instruments order by id',
      )
      assert.deepEqual(after.getRowObjectsJson(), before.getRowObjectsJson())
      assert.deepEqual(summaryAgain, summary)
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
