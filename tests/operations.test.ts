import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import {
  createOperationsController,
  skipOperation,
  type OperationStep,
} from '../server/operations.ts'
import { withTempDatabase } from './helpers.ts'

// Stub steps — the queue/state machinery is under test, not the jobs.
function stubSteps(log: string[]): OperationStep[] {
  return [
    {
      id: 'op:slow',
      label: 'slow',
      stage: 'raw',
      description: 'slow step',
      run: async () => {
        await sleep(120)
        log.push('slow')
        return { did: 'slow' }
      },
    },
    {
      id: 'op:fast',
      label: 'fast',
      stage: 'facts',
      description: 'fast step',
      run: async () => {
        log.push('fast')
        return { did: 'fast' }
      },
    },
    {
      id: 'op:boom',
      label: 'boom',
      stage: 'computed',
      description: 'always fails',
      run: async () => {
        throw new Error('boom')
      },
    },
  ]
}

async function waitForIdle(
  controller: ReturnType<typeof createOperationsController>,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const states = Object.values(controller.status())

    if (states.every((s) => s.state !== 'running' && s.state !== 'queued')) {
      return
    }

    await sleep(50)
  }

  throw new Error('operations never went idle')
}

test('operations queue: serialization, order, results, failures, history', async () => {
  await withTempDatabase(async (db) => {
    const log: string[] = []
    const controller = createOperationsController(db, stubSteps(log))

    assert.deepEqual(
      controller.steps.map((step) => step.id),
      ['op:slow', 'op:fast', 'op:boom'],
    )

    // Unknown id is rejected.
    assert.equal(controller.enqueue('op:nope').queued, false)

    // Enqueue slow then fast: fast must wait (one at a time) and run second.
    assert.equal(controller.enqueue('op:slow').queued, true)
    assert.equal(controller.enqueue('op:fast').queued, true)
    // Double-enqueue while queued/running is refused.
    assert.equal(controller.enqueue('op:slow').queued, false)

    await waitForIdle(controller)
    assert.deepEqual(log, ['slow', 'fast'])

    const status = controller.status()
    assert.equal(status['op:slow']?.state, 'ok')
    assert.deepEqual(status['op:slow']?.result, { did: 'slow' })
    assert.equal(status['op:fast']?.state, 'ok')

    // Failure is captured, not thrown out of the queue.
    controller.enqueue('op:boom')
    await waitForIdle(controller)
    assert.equal(controller.status()['op:boom']?.state, 'failed')
    assert.equal(controller.status()['op:boom']?.error, 'boom')

    // enqueueAll queues every step in pipeline order.
    const queued = controller.enqueueAll()
    assert.deepEqual(queued, ['op:slow', 'op:fast', 'op:boom'])
    await waitForIdle(controller)

    // Every execution left a durable ops.runs row under the step id.
    // (Note: op:boom is LAST in the registry, so enqueueAll above completed
    // op:slow and op:fast before it failed.)
    const runs = await db.connection.runAndReadAll(`
      select job, status, count(*) as n
      from ops.runs
      where job like 'op:%'
      group by job, status
      order by job, status
    `)
    assert.deepEqual(
      runs.getRowObjectsJson().map((row) => ({
        job: row.job,
        status: row.status,
        n: Number(row.n),
      })),
      [
        { job: 'op:boom', status: 'failed', n: 2 },
        { job: 'op:fast', status: 'ok', n: 2 },
        { job: 'op:slow', status: 'ok', n: 2 },
      ],
    )
  })
})

test('run-all fails fast: a failed step skips the rest of its chain', async () => {
  await withTempDatabase(async (db) => {
    const log: string[] = []
    const steps: OperationStep[] = [
      {
        id: 'op:boom-first',
        label: 'boom',
        stage: 'raw',
        description: 'fails immediately',
        run: async () => {
          throw new Error('ingest failed')
        },
      },
      {
        id: 'op:downstream-a',
        label: 'a',
        stage: 'facts',
        description: 'must not run after upstream failure',
        run: async () => {
          log.push('downstream-a')
        },
      },
      {
        id: 'op:downstream-b',
        label: 'b',
        stage: 'computed',
        description: 'must not run after upstream failure',
        run: async () => {
          log.push('downstream-b')
        },
      },
    ]
    const controller = createOperationsController(db, steps)

    controller.enqueueAll()
    await waitForIdle(controller)

    const status = controller.status()
    assert.equal(status['op:boom-first']?.state, 'failed')
    assert.equal(status['op:downstream-a']?.state, 'skipped')
    assert.equal(status['op:downstream-b']?.state, 'skipped')
    assert.match(
      String(status['op:downstream-a']?.error),
      /upstream step op:boom-first failed/,
    )
    assert.deepEqual(log, []) // nothing downstream executed

    // Individually queued steps are NOT chained to prior failures.
    controller.enqueue('op:downstream-a')
    await waitForIdle(controller)
    assert.equal(controller.status()['op:downstream-a']?.state, 'ok')
    assert.deepEqual(log, ['downstream-a'])
  })
})

test('operation can report an intentional skip with a reason', async () => {
  await withTempDatabase(async (db) => {
    const controller = createOperationsController(db, [
      {
        id: 'op:disabled',
        label: 'disabled',
        stage: 'raw',
        description: 'disabled by configuration',
        run: async () => skipOperation('source not enabled'),
      },
    ])

    controller.enqueue('op:disabled')
    await waitForIdle(controller)
    assert.deepEqual(controller.status()['op:disabled'], {
      state: 'skipped',
      startedAt: controller.status()['op:disabled']?.startedAt,
      finishedAt: controller.status()['op:disabled']?.finishedAt,
      result: { skipped: true, reason: 'source not enabled' },
      error: 'skipped: source not enabled',
    })
  })
})
