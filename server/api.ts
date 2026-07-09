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
import { createReadPool, type ReadPool } from './read-pool.ts'

// Read-only JSON API over facts + computed. It opens the database with
// access_mode=READ_ONLY: it cannot write, and it must be stopped before
// running jobs that write (DuckDB allows one writer OR concurrent readers).
// Market selection is a query parameter — the data layer holds the whole
// world; slicing happens here and in the UI.

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

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

const instrumentIdSchema = z.uuid()

export async function createApiServer(
  options: { dbPath?: string } = {},
): Promise<ApiServer> {
  const db = await openDatabase({ dbPath: options.dbPath, readOnly: true })
  const readers: DuckDBConnection[] = [db.connection]

  for (let index = 1; index < readPoolSize; index++) {
    readers.push(await db.instance.connect())
  }

  const pool: ReadPool = createReadPool(readers)
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

  app.get('/api/instruments', async (request, response) => {
    const query = searchQuerySchema.parse(request.query)
    const rows = await pool.run((connection) =>
      readRows(
        connection,
        `
          select
            cast(i.instrument_id as varchar) as instrument_id,
            s.symbol,
            i.name,
            i.instrument_type,
            i.security_form,
            i.is_clean_common_stock,
            i.active,
            s.exchange_mic
          from facts.symbols s
          join facts.instruments i using (instrument_id)
          where s.market_scope = $scope
            and s.valid_to is null
            and (
              upper(s.symbol) like upper($q) || '%'
              or i.name ilike '%' || $q || '%'
            )
          order by
            (upper(s.symbol) = upper($q)) desc,
            length(s.symbol),
            s.symbol
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
