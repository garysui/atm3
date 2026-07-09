import type { Atm3Db } from './db.ts'
import { logger } from './log.ts'
import { withRun } from './runs.ts'
import { buildAllFacts } from './facts-build.ts'
import { buildMinuteParquet } from './facts-minute.ts'
import { refreshAdjustedBarsCache } from './computed-build.ts'
import { ingestMinuteAggs, intradayBackfillWindow } from './flatfiles.ts'
import {
  backfillWindow,
  ingestDividends,
  ingestExchanges,
  ingestGroupedDaily,
  ingestMarketHolidays,
  ingestReferenceTickers,
  ingestSplits,
} from './polygon-ingest.ts'

// The daily-replenish pipeline as clickable operations. One queue, one job
// at a time, executed on the server's writer connection. Job ids double as
// ops.runs job names, so button runs and CLI runs share one history.
// Every step is idempotent by design: re-running fetches only what is
// missing and rebuilds deterministically.

export type OperationStep = {
  id: string
  label: string
  stage: 'raw' | 'facts' | 'computed'
  description: string
  run: (context: { db: Atm3Db; runId: string }) => Promise<unknown>
}

export type OperationState = {
  state: 'idle' | 'queued' | 'running' | 'ok' | 'failed'
  startedAt?: string
  finishedAt?: string
  result?: unknown
  error?: string
}

export const dailyReplenishSteps: OperationStep[] = [
  {
    id: 'ingest:polygon:exchanges',
    label: 'exchanges',
    stage: 'raw',
    description: 'exchange reference snapshot (1 request)',
    run: ({ db, runId }) => ingestExchanges(db, { runId }),
  },
  {
    id: 'ingest:polygon:market_holidays',
    label: 'market holidays',
    stage: 'raw',
    description: 'upcoming holidays / half days (1 request)',
    run: ({ db, runId }) => ingestMarketHolidays(db, { runId }),
  },
  {
    id: 'ingest:polygon:reference_tickers',
    label: 'reference tickers',
    stage: 'raw',
    description: 'full ticker universe snapshot, active + delisted (~37 pages)',
    run: ({ db, runId }) => ingestReferenceTickers(db, { runId }),
  },
  {
    id: 'ingest:polygon:splits',
    label: 'splits',
    stage: 'raw',
    description: 'splits sweep over the backfill window',
    run: ({ db, runId }) => ingestSplits(db, { runId, from: backfillWindow().from }),
  },
  {
    id: 'ingest:polygon:dividends',
    label: 'dividends',
    stage: 'raw',
    description: 'dividends sweep over the backfill window (~400 pages)',
    run: ({ db, runId }) =>
      ingestDividends(db, { runId, from: backfillWindow().from }),
  },
  {
    id: 'ingest:polygon:grouped_daily',
    label: 'grouped daily bars',
    stage: 'raw',
    description: 'whole-market bars for missing dates (both variants)',
    run: async ({ db, runId }) => {
      const { from, to } = backfillWindow()
      const unadjusted = await ingestGroupedDaily(db, {
        runId,
        from,
        to,
        adjusted: false,
      })
      const adjusted = await ingestGroupedDaily(db, {
        runId,
        from,
        to,
        adjusted: true,
      })
      return { unadjusted, adjusted }
    },
  },
  {
    id: 'ingest:polygon:minute_aggs',
    label: 'minute flat files',
    stage: 'raw',
    description:
      'whole-market minute bars, one vendor csv.gz per missing day (S3)',
    run: ({ db, runId }) => {
      const { from, to } = intradayBackfillWindow()
      return ingestMinuteAggs(db, { runId, from, to })
    },
  },
  {
    id: 'build:facts',
    label: 'build facts',
    stage: 'facts',
    description: 'identity, calendars, corporate actions, bars — full refresh from raw',
    run: ({ db }) => buildAllFacts(db.connection),
  },
  {
    id: 'build:facts:minute',
    label: 'build minute facts',
    stage: 'facts',
    description:
      'parse-only parquet per day from raw flat files, row-count verified',
    run: ({ db }) => buildMinuteParquet(db.connection),
  },
  {
    id: 'computed:cache',
    label: 'refresh adjusted cache',
    stage: 'computed',
    description: 'snapshot of adjusted_bars(policy); skipped when watermark is fresh',
    run: ({ db }) => refreshAdjustedBarsCache(db.connection),
  },
]

export type OperationsController = {
  steps: Array<Omit<OperationStep, 'run'>>
  status(): Record<string, OperationState>
  enqueue(id: string): { queued: boolean; reason?: string }
  enqueueAll(): string[]
}

export function createOperationsController(
  db: Atm3Db,
  steps: OperationStep[] = dailyReplenishSteps,
): OperationsController {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const states = new Map<string, OperationState>(
    steps.map((step) => [step.id, { state: 'idle' }]),
  )
  const queue: string[] = []
  let draining = false

  async function drain(): Promise<void> {
    if (draining) {
      return
    }

    draining = true

    try {
      while (queue.length > 0) {
        const id = queue.shift() as string
        const step = byId.get(id) as OperationStep
        const startedAt = new Date().toISOString()
        states.set(id, { state: 'running', startedAt })

        try {
          const result = await withRun(db.connection, id, null, (runId) =>
            step.run({ db, runId }),
          )
          states.set(id, {
            state: 'ok',
            startedAt,
            finishedAt: new Date().toISOString(),
            result,
          })
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause)
          states.set(id, {
            state: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error,
          })
          logger.error({ id, error }, 'operation failed')
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    steps: steps.map(({ id, label, stage, description }) => ({
      id,
      label,
      stage,
      description,
    })),
    status() {
      return Object.fromEntries(states)
    },
    enqueue(id) {
      if (!byId.has(id)) {
        return { queued: false, reason: 'unknown operation' }
      }

      const current = states.get(id)?.state

      if (current === 'queued' || current === 'running') {
        return { queued: false, reason: `already ${current}` }
      }

      states.set(id, { state: 'queued' })
      queue.push(id)
      void drain()
      return { queued: true }
    },
    enqueueAll() {
      const queued: string[] = []

      for (const step of steps) {
        if (this.enqueue(step.id).queued) {
          queued.push(step.id)
        }
      }

      return queued
    },
  }
}
