import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import { z, ZodError } from 'zod'
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api'
import { adjustmentPolicies } from '../core/adjustments.ts'
import { openDatabase, SCHEMA_VERSION } from './db.ts'
import { collectStatus } from './inspect.ts'
import { logger } from './log.ts'
import {
  createOperationsController,
  type OperationStep,
} from './operations.ts'
import { createReadPool, type ReadPool } from './read-pool.ts'
import { abortStaleRuns } from './runs.ts'
import { metricsAt } from './metrics-at.ts'
import { forwardReturns, ViewAtTDateError } from './forward-returns.ts'

// JSON API over facts + computed, and the owner of the database write lock:
// UI queries run on a pool of reader connections while pipeline operations
// (ingest / facts build / cache refresh) run one at a time on the writer
// connection through the operations queue. DuckDB allows one writer process,
// so CLI write scripts require this server to be stopped — or just click
// the Pipeline page instead. Market selection is a query parameter — the
// data layer holds the whole world; slicing happens here and in the UI.

const readPoolSize = 3

export type ApiServer = {
  app: express.Express
  dbPath: string
  closeSync(): void
}

async function readRows(
  connection: DuckDBConnection,
  sql: string,
  params?: Record<string, DuckDBValue>,
): Promise<Array<Record<string, unknown>>> {
  const result = await connection.runAndReadAll(sql, params)
  return result.getRowObjectsJson() as Array<Record<string, unknown>>
}

const searchQuerySchema = z.object({
  scope: z.string().default('us_stocks'),
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(200).default(30),
})

const barsQuerySchema = z.object({
  policy: z.enum(adjustmentPolicies).default('split_dividend'),
  as_of: z.iso.date().optional(),
})

const minuteBarsQuerySchema = z.object({
  policy: z.enum(adjustmentPolicies).default('split_dividend'),
  date: z.iso.date(),
  as_of: z.iso.date().optional(),
})

const viewAtQuerySchema = z.object({
  t: z.iso.date(),
  forward: z.enum(['0', '1']).default('0'),
  entry: z.enum(['next_open', 't_close']).default('next_open'),
})

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

// Our deterministic ids are hash-derived; validate the hex shape only —
// z.uuid() enforces RFC version bits and must not gate lookups.
const instrumentIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

const docsDir = fileURLToPath(new URL('../docs', import.meta.url))
const docNamePattern = /^[a-z0-9][a-z0-9-]*$/

export async function createApiServer(
  options: {
    dbPath?: string
    dataDir?: string
    operationSteps?: OperationStep[]
  } = {},
): Promise<ApiServer> {
  const db = await openDatabase({
    dbPath: options.dbPath,
    dataDir: options.dataDir,
  })
  // db.connection is reserved as the WRITER (operations queue); queries run
  // on sibling reader connections of the same instance.
  const readers: DuckDBConnection[] = []

  for (let index = 0; index < readPoolSize; index++) {
    readers.push(await db.instance.connect())
  }

  const pool: ReadPool = createReadPool(readers)
  await abortStaleRuns(db.connection)
  const operations = createOperationsController(db, options.operationSteps)
  const app = express()
  app.use(cors())
  app.use(express.json())

  app.get('/api/health', async (_request, response) => {
    response.json({ ok: true, dbPath: db.dbPath, schemaVersion: SCHEMA_VERSION })
  })

  // Market scopes present in the data — the UI's market selector is fed by
  // the data, not by configuration.
  app.get('/api/scopes', async (_request, response) => {
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `select distinct market_scope as scope from facts.symbols
         order by market_scope`,
      ),
    )
    response.json(rows)
  })

  app.get('/api/status', async (_request, response) => {
    const status = await pool.run((connection) => collectStatus(connection))
    response.json(status)
  })

  // Historical ticker usages match too — searching FB must surface Meta
  // (FB until 2022-06-09) alongside the ETF that reused the ticker, each
  // labeled with its usage window. A ticker is a time-ranged handle.
  app.get('/api/instruments', async (request, response) => {
    const query = searchQuerySchema.parse(request.query)
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select
            cast(i.instrument_id as varchar) as instrument_id,
            s.symbol,
            case when s.valid_to is null then 'current'
                 else coalesce(cast(s.valid_from as varchar), '…')
                      || ' → ' || cast(s.valid_to as varchar)
            end as symbol_usage,
            i.name,
            i.instrument_type,
            i.security_form,
            i.is_clean_common_stock,
            i.active,
            s.exchange_mic
          from facts.symbols s
          join facts.instruments i using (instrument_id)
          where s.market_scope = $scope
            and (
              upper(s.symbol) like upper($q) || '%'
              or i.name ilike '%' || $q || '%'
            )
          order by
            (upper(s.symbol) = upper($q)) desc,
            (s.valid_to is null) desc,
            length(s.symbol),
            s.symbol,
            s.valid_to desc nulls first
          limit $limit
        `,
        { scope: query.scope, q: query.q, limit: query.limit },
      ),
    )
    response.json(rows)
  })

  app.get('/api/instruments/:id', async (request, response) => {
    const instrumentId = instrumentIdSchema.parse(request.params.id)
    const detail = await pool.run(async (connection) => {
      const params = { id: instrumentId }
      const instrument = await readRows(
        connection,
        `
          select
            cast(instrument_id as varchar) as instrument_id,
            asset_class, instrument_type, security_form,
            is_clean_common_stock, name, primary_market_scope,
            primary_exchange_mic, currency, active,
            cast(delisted_date as varchar) as delisted_date,
            cast(first_seen_date as varchar) as first_seen_date
          from facts.instruments
          where instrument_id = cast($id as uuid)
        `,
        params,
      )

      if (instrument.length === 0) {
        return null
      }

      return {
        instrument: instrument[0],
        symbols: await readRows(
          connection,
          `
            select symbol, market_scope, exchange_mic,
                   cast(valid_from as varchar) as valid_from,
                   cast(valid_to as varchar) as valid_to,
                   cast(evidence as varchar) as evidence
            from facts.symbols
            where instrument_id = cast($id as uuid)
            order by valid_from nulls first
          `,
          params,
        ),
        identifiers: await readRows(
          connection,
          `
            select identifier_type, identifier_value,
                   cast(valid_from as varchar) as valid_from
            from facts.instrument_identifiers
            where instrument_id = cast($id as uuid)
            order by identifier_type
          `,
          params,
        ),
        corporateActions: await readRows(
          connection,
          `
            select action_type, cast(ex_date as varchar) as ex_date,
                   symbol_as_stated, split_from, split_to, cash_amount,
                   cash_amount_post_tax, bonus_ratio, conversion_ratio,
                   currency, dividend_type,
                   cast(pay_date as varchar) as pay_date
            from facts.corporate_actions
            where instrument_id = cast($id as uuid)
            order by ex_date desc
            limit 200
          `,
          params,
        ),
        barsSummary: (
          await readRows(
            connection,
            `
              select count(*) as bars,
                     cast(min(market_date) as varchar) as first_date,
                     cast(max(market_date) as varchar) as last_date,
                     count(distinct symbol_as_traded) as tape_lines
              from facts.bars_daily
              where instrument_id = cast($id as uuid)
            `,
            params,
          )
        )[0],
      }
    })

    if (detail === null) {
      response.status(404).json({ error: 'instrument not found' })
      return
    }

    response.json(detail)
  })

  // Adjusted series straight from the algorithm — policy and as-of T are
  // caller choices; nothing here reads the cache.
  app.get('/api/instruments/:id/bars', async (request, response) => {
    const instrumentId = instrumentIdSchema.parse(request.params.id)
    const query = barsQuerySchema.parse(request.query)
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select
            cast(market_date as varchar) as date,
            open, high, low, close, volume,
            cum_price_factor, symbol_as_traded
          from computed.adjusted_bars_for(
            cast($id as uuid), $policy, as_of := cast($as_of as date)
          )
          order by market_date
        `,
        {
          id: instrumentId,
          policy: query.policy,
          as_of: query.as_of ?? null,
        },
      ),
    )
    response.json({ policy: query.policy, asOf: query.as_of ?? null, bars: rows })
  })

  app.get('/api/instruments/:id/view-at', async (request, response) => {
    const instrumentId = instrumentIdSchema.parse(request.params.id)
    const query = viewAtQuerySchema.parse(request.query)
    const report = await pool.run(async (connection) => {
      const scopeResult = await connection.runAndReadAll(
        `select primary_market_scope as market_scope
         from facts.instruments
         where instrument_id = cast($instrument_id as uuid)`,
        { instrument_id: instrumentId },
      )
      const scope = scopeResult.getRowObjectsJson()[0]?.market_scope
      if (scope === undefined) return null

      const backward = await metricsAt(connection, {
        instrumentId,
        marketScope: String(scope),
        t: query.t,
      })
      const forward = query.forward === '1'
        ? await forwardReturns(connection, {
            instrumentId,
            marketScope: String(scope),
            t: query.t,
            entryBasis: query.entry,
            policy: 'split_dividend',
          })
        : null
      return {
        ...backward,
        ...(forward
          ? {
              forward: {
                hindsight: true,
                entry_basis: query.entry,
                rows: forward,
              },
            }
          : {}),
      }
    })

    if (report === null) {
      response.status(404).json({ error: 'instrument not found' })
      return
    }
    response.json(report)
  })

  // Intraday coverage for one instrument: one summary row per day with
  // minute data (recent first).
  app.get('/api/instruments/:id/minute-days', async (request, response) => {
    const instrumentId = instrumentIdSchema.parse(request.params.id)
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select
            cast(market_date as varchar) as date,
            count(*) as bars,
            strftime(min(window_start_utc) at time zone 'America/New_York',
                     '%H:%M') as first_et,
            strftime(max(window_start_utc) at time zone 'America/New_York',
                     '%H:%M') as last_et,
            round(min(low), 4) as low,
            round(max(high), 4) as high,
            cast(sum(volume) as bigint) as volume
          from facts.bars_minute
          where instrument_id = cast($id as uuid)
          group by market_date
          order by market_date desc
          limit 30
        `,
        { id: instrumentId },
      ),
    )
    response.json({ days: rows })
  })

  // Minute drill-down for one instrument-day, through the same adjustment
  // policies as the daily chart. Times are epoch seconds (UTC).
  app.get('/api/instruments/:id/minute-bars', async (request, response) => {
    const instrumentId = instrumentIdSchema.parse(request.params.id)
    const query = minuteBarsQuerySchema.parse(request.query)
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select
            cast(epoch(window_start_utc) as bigint) as time,
            open, high, low, close, volume,
            cum_price_factor, symbol_as_traded
          from computed.adjusted_bars_minute_for(
            cast($id as uuid), $policy, as_of := cast($as_of as date)
          )
          where market_date = cast($date as date)
          order by window_start_utc
        `,
        {
          id: instrumentId,
          policy: query.policy,
          date: query.date,
          as_of: query.as_of ?? null,
        },
      ),
    )
    response.json({
      policy: query.policy,
      date: query.date,
      asOf: query.as_of ?? null,
      bars: rows,
    })
  })

  // Project docs served into the UI — the tool documents its own gotchas
  // (docs/market-data-phenomena.md is the field-notes catalog).
  app.get('/api/docs', async (_request, response) => {
    const files = (await readdir(docsDir))
      .filter((file) => file.endsWith('.md'))
      .sort()
    const docs = await Promise.all(
      files.map(async (file) => {
        const content = await readFile(path.join(docsDir, file), 'utf8')
        return {
          name: file.replace(/\.md$/, ''),
          title: content.match(/^#\s+(.+)$/m)?.[1] ?? file,
        }
      }),
    )
    response.json(docs)
  })

  app.get('/api/docs/:name', async (request, response) => {
    const name = String(request.params.name)

    if (!docNamePattern.test(name)) {
      response.status(400).json({ error: 'invalid doc name' })
      return
    }

    const files = await readdir(docsDir)

    if (!files.includes(`${name}.md`)) {
      response.status(404).json({ error: 'doc not found' })
      return
    }

    response.json({
      name,
      markdown: await readFile(path.join(docsDir, `${name}.md`), 'utf8'),
    })
  })

  // The daily-replenish pipeline: step definitions, live queue state, and
  // the last durable run per job from ops.runs.
  app.get('/api/operations', async (_request, response) => {
    // Step ids are code-defined constants — safe to inline.
    const jobList = operations.steps
      .map((step) => `'${step.id.replaceAll("'", "''")}'`)
      .join(', ')
    const lastRuns = await pool.run((connection) =>
      readRows(
        connection,
        `
          select job, status,
                 strftime(started_at, '%Y-%m-%d %H:%M:%S') as started_utc,
                 cast(round(epoch(finished_at - started_at)) as integer)
                   as seconds,
                 error
          from ops.runs
          where job in (${jobList})
          qualify row_number() over (
            partition by job order by started_at desc
          ) = 1
        `,
      ),
    )
    const lastByJob = Object.fromEntries(
      lastRuns.map((row) => [String(row.job), row]),
    )
    const status = operations.status()
    response.json({
      steps: operations.steps.map((step) => ({
        ...step,
        live: status[step.id],
        lastRun: lastByJob[step.id] ?? null,
      })),
    })
  })

  app.post('/api/operations/run-all', (_request, response) => {
    response.json({ queued: operations.enqueueAll() })
  })

  app.post('/api/operations/:id/run', (request, response) => {
    const outcome = operations.enqueue(String(request.params.id))

    if (!outcome.queued && outcome.reason === 'unknown operation') {
      response.status(404).json({ error: outcome.reason })
      return
    }

    response.json(outcome)
  })

  app.get('/api/runs', async (request, response) => {
    const query = limitQuerySchema.parse(request.query)
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select cast(run_id as varchar) as run_id, job, status,
                 strftime(started_at, '%Y-%m-%d %H:%M:%S') as started_utc,
                 cast(round(epoch(finished_at - started_at)) as integer)
                   as seconds,
                 error
          from ops.runs
          order by started_at desc
          limit $limit
        `,
        { limit: query.limit },
      ),
    )
    response.json(rows)
  })

  app.get('/api/unresolved', async (_request, response) => {
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select dataset, reason, count(*) as entries,
                 cast(min(market_date) as varchar) as first_date,
                 cast(max(market_date) as varchar) as last_date
          from ops.unresolved
          group by dataset, reason
          order by dataset, reason
        `,
      ),
    )
    response.json(rows)
  })

  app.use(
    (error: unknown, _request: Request, response: Response, next: NextFunction) => {
      if (response.headersSent) {
        next(error)
        return
      }

      if (error instanceof ZodError) {
        response.status(400).json({ error: z.prettifyError(error) })
        return
      }

      if (error instanceof ViewAtTDateError) {
        response.status(404).json({
          error: error.message,
          previous_date: error.previousDate,
          next_date: error.nextDate,
        })
        return
      }

      logger.error({ err: error }, 'api request failed')
      response.status(500).json({
        error: error instanceof Error ? error.message : 'internal error',
      })
    },
  )

  return {
    app,
    dbPath: db.dbPath,
    closeSync() {
      pool.closeSync()
      db.instance.closeSync()
    },
  }
}
