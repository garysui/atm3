import { useEffect, useState } from 'react'
import { getJson } from '../api.ts'

// The daily replenish, visual and clickable: each step is a card in its
// pipeline stage with a Run button, live state, and last durable run from
// ops.runs. "Run all" queues the whole chain in dependency order. All steps
// are idempotent — re-running fetches only what is missing.

type OperationView = {
  id: string
  label: string
  stage: 'raw' | 'facts' | 'computed'
  description: string
  live?: {
    state: 'idle' | 'queued' | 'running' | 'ok' | 'failed'
    startedAt?: string
    finishedAt?: string
    result?: unknown
    error?: string
  }
  lastRun: {
    status?: string
    started_utc?: string
    seconds?: number
    error?: string
  } | null
}

const stages: Array<{ id: OperationView['stage']; title: string }> = [
  { id: 'raw', title: '1 · raw — ingest verbatim vendor files' },
  { id: 'facts', title: '2 · facts — rebuild organized facts' },
  { id: 'computed', title: '3 · computed — refresh cache' },
]

function elapsedSeconds(startedAt?: string): number | null {
  if (!startedAt) {
    return null
  }

  return Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000))
}

function summarize(result: unknown): string {
  if (result === null || result === undefined) {
    return ''
  }

  const text = JSON.stringify(result)
  return text.length > 220 ? `${text.slice(0, 220)}…` : text
}

function StateBadge({ step }: { step: OperationView }) {
  const live = step.live

  if (live?.state === 'running') {
    return (
      <span className="op-state running">
        running… {elapsedSeconds(live.startedAt)}s
      </span>
    )
  }

  if (live?.state === 'queued') {
    return <span className="op-state queued">queued</span>
  }

  if (live?.state === 'failed') {
    return <span className="op-state failed">failed</span>
  }

  if (live?.state === 'ok') {
    return <span className="op-state ok">ok</span>
  }

  return <span className="op-state idle">idle</span>
}

export function Pipeline() {
  const [steps, setSteps] = useState<OperationView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = () => {
      getJson<{ steps: OperationView[] }>('/api/operations')
        .then((data) => {
          if (!cancelled) {
            setSteps(data.steps)
            setError(null)
          }
        })
        .catch((cause: Error) => {
          if (!cancelled) setError(cause.message)
        })
    }

    load()
    const timer = setInterval(load, 1500)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const busy =
    steps?.some(
      (step) =>
        step.live?.state === 'running' || step.live?.state === 'queued',
    ) ?? false

  const post = (url: string) => {
    void fetch(url, { method: 'POST' }).catch(() => undefined)
  }

  return (
    <div>
      <h2>Pipeline — daily replenish</h2>
      <p className="muted">
        Raw is append-only; every step is idempotent and safe to re-run. One
        operation runs at a time on the writer connection; the rest queue.
      </p>
      <form onSubmit={(event) => event.preventDefault()}>
        <button
          onClick={() => post('/api/operations/run-all')}
          disabled={busy}
        >
          ▶ run full daily replenish
        </button>
        {busy && <span className="muted">pipeline is working…</span>}
      </form>
      {error && <p className="error">{error}</p>}
      {!steps && !error && <p className="muted">loading…</p>}
      {steps && (
        <div className="pipeline">
          {stages.map((stage, index) => (
            <div key={stage.id} className="pipeline-stage-wrap">
              {index > 0 && <div className="pipeline-arrow">→</div>}
              <div className="pipeline-stage">
                <h3>{stage.title}</h3>
                {steps
                  .filter((step) => step.stage === stage.id)
                  .map((step) => (
                    <div key={step.id} className="op-card">
                      <div className="op-head">
                        <strong>{step.label}</strong>
                        <StateBadge step={step} />
                        <button
                          onClick={() =>
                            post(
                              `/api/operations/${encodeURIComponent(step.id)}/run`,
                            )
                          }
                          disabled={
                            step.live?.state === 'running' ||
                            step.live?.state === 'queued'
                          }
                        >
                          run
                        </button>
                      </div>
                      <div className="muted">{step.description}</div>
                      {step.lastRun && (
                        <div className="muted">
                          last: {step.lastRun.status} ·{' '}
                          {step.lastRun.started_utc} UTC
                          {step.lastRun.seconds !== null &&
                            ` · ${step.lastRun.seconds}s`}
                        </div>
                      )}
                      {step.live?.state === 'failed' && (
                        <div className="error">{step.live.error}</div>
                      )}
                      {step.live?.state === 'ok' && (
                        <div className="op-result">
                          {summarize(step.live.result)}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
