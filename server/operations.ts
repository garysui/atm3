import type { Atm3Db } from './db.ts'
import { logger } from './log.ts'
import { withRun } from './runs.ts'
import { buildAllFacts } from './facts-build.ts'
import {
  cnSourceEnabled,
  ingestBaoStockAdjustmentFactors,
  ingestBaoStockBasics,
  ingestBaoStockCalendar,
  ingestBaoStockDaily,
  ingestBaoStockDividends,
  ingestBaoStockUniverse,
} from './baostock-ingest.ts'
import { buildMinuteParquet } from './facts-minute.ts'
import { refreshAdjustedBarsCache } from './computed-build.ts'
import { ingestMinuteAggs, intradayBackfillWindow } from './flatfiles.ts'
import { continuitySummary, verifyContinuity } from './verify-continuity.ts'
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
  stage: 'raw' | 'facts' | 'computed' | 'verify'
  description: string
  run: (context: { db: Atm3Db; runId: string }) => Promise<unknown>
}

export type OperationState = {
  state: 'idle' | 'queued' | 'running' | 'ok' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  result?: unknown
  error?: string
}

export type OperationSkipped = { skipped: true; reason: string }

export function skipOperation(reason: string): OperationSkipped {
  return { skipped: true, reason }
}

function isOperationSkipped(value: unknown): value is OperationSkipped {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { skipped?: unknown }).skipped === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  )
}

function cnOperation(
  run: OperationStep['run'],
): OperationStep['run'] {
  return (context) =>
    cnSourceEnabled()
      ? run(context)
      : Promise.resolve(skipOperation('CN source not enabled'))
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
    id: 'ingest:baostock:trade_cal',
    label: 'CN calendar',
    stage: 'raw',
    description: 'BaoStock cn_equities calendar snapshot',
    run: cnOperation(({ db, runId }) => ingestBaoStockCalendar(db, { runId })),
  },
  {
    id: 'ingest:baostock:universe',
    label: 'CN universe',
    stage: 'raw',
    description: 'BaoStock listed-security snapshot for identity evidence',
    run: cnOperation(({ db, runId }) => ingestBaoStockUniverse(db, { runId })),
  },
  {
    id: 'ingest:baostock:stock_basic',
    label: 'CN instrument basics',
    stage: 'raw',
    description: 'metadata for the owner-vetoable prototype code list',
    run: cnOperation(({ db, runId }) => ingestBaoStockBasics(db, { runId })),
  },
  {
    id: 'ingest:baostock:daily_k',
    label: 'CN daily bars',
    stage: 'raw',
    description: 'unadjusted per-code daily windows for the prototype',
    run: cnOperation(({ db, runId }) => ingestBaoStockDaily(db, { runId })),
  },
  {
    id: 'ingest:baostock:dividend',
    label: 'CN distributions',
    stage: 'raw',
    description: 'per-code implemented cash and stock distributions',
    run: cnOperation(({ db, runId }) => ingestBaoStockDividends(db, { runId })),
  },
  {
    id: 'ingest:baostock:adj_factor',
    label: 'CN vendor factors',
    stage: 'raw',
    description: 'BaoStock price-change factors for diagnostics only',
    run: cnOperation(({ db, runId }) =>
      ingestBaoStockAdjustmentFactors(db, { runId }),
    ),
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
  {
    id: 'verify:continuity',
    label: 'verify continuity',
    stage: 'verify',
    description:
      'contract: every trading day covered from the fixed start; closures uncontradicted',
    run: async ({ db }) => {
      const { from, to } = backfillWindow()
      const report = await verifyContinuity(db.connection, {
        dailyFrom: from,
        intradayFrom: intradayBackfillWindow().from,
        to,
      })

      if (!report.ok) {
        throw new Error(continuitySummary(report))
      }

      return { summary: continuitySummary(report) }
    },
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
  const queue: Array<{ id: string; chainId: string | null }> = []
  let draining = false

  // A failed step cancels the rest of its chain: rebuilding facts and
  // caches from a failed ingest would spend minutes laundering stale input
  // (review finding #4). Individually queued steps are unaffected.
  function skipChain(chainId: string, failedId: string): void {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].chainId === chainId) {
        const [{ id }] = queue.splice(index, 1)
        states.set(id, {
          state: 'skipped',
          error: `skipped: upstream step ${failedId} failed`,
        })
      }
    }
  }

  function enqueueOne(
    id: string,
    chainId: string | null,
  ): { queued: boolean; reason?: string } {
    if (!byId.has(id)) {
      return { queued: false, reason: 'unknown operation' }
    }

    const current = states.get(id)?.state

    if (current === 'queued' || current === 'running') {
      return { queued: false, reason: `already ${current}` }
    }

    states.set(id, { state: 'queued' })
    queue.push({ id, chainId })
    void drain()
    return { queued: true }
  }

  async function drain(): Promise<void> {
    if (draining) {
      return
    }

    draining = true

    try {
      while (queue.length > 0) {
        const item = queue.shift() as { id: string; chainId: string | null }
        const step = byId.get(item.id) as OperationStep
        const startedAt = new Date().toISOString()
        states.set(item.id, { state: 'running', startedAt })

        try {
          const result = await withRun(db.connection, item.id, null, (runId) =>
            step.run({ db, runId }),
          )
          if (isOperationSkipped(result)) {
            states.set(item.id, {
              state: 'skipped',
              startedAt,
              finishedAt: new Date().toISOString(),
              result,
              error: `skipped: ${result.reason}`,
            })
            continue
          }
          states.set(item.id, {
            state: 'ok',
            startedAt,
            finishedAt: new Date().toISOString(),
            result,
          })
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause)
          states.set(item.id, {
            state: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            error,
          })
          logger.error({ id: item.id, error }, 'operation failed')

          if (item.chainId) {
            skipChain(item.chainId, item.id)
          }
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
      return enqueueOne(id, null)
    },
    enqueueAll() {
      const chainId = `chain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const queued: string[] = []

      for (const step of steps) {
        if (enqueueOne(step.id, chainId).queued) {
          queued.push(step.id)
        }
      }

      return queued
    },
  }
}
