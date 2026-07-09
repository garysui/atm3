import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'
import { getJson } from '../api.ts'

type DocEntry = { name: string; title: string }

// Project docs rendered in-app: the tool explains its own domain, starting
// with docs/market-data-phenomena.md (renames, reuse, splits, quarantine…).
export function Docs({ docName }: { docName: string | null }) {
  const [list, setList] = useState<DocEntry[] | null>(null)
  const [docState, setDocState] = useState<{
    name: string
    markdown: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = docName ?? 'market-data-phenomena'

  useEffect(() => {
    let cancelled = false

    getJson<DocEntry[]>('/api/docs')
      .then((docs) => {
        if (!cancelled) setList(docs)
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    getJson<{ name: string; markdown: string }>(`/api/docs/${selected}`)
      .then((doc) => {
        if (!cancelled) {
          setDocState(doc)
          setError(null)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message)
      })

    return () => {
      cancelled = true
    }
  }, [selected])

  const doc = docState?.name === selected ? docState : null
  const html = useMemo(
    () => (doc ? (marked.parse(doc.markdown) as string) : ''),
    [doc],
  )

  return (
    <div>
      <nav className="doc-list">
        {list?.map((entry) => (
          <a
            key={entry.name}
            href={`#docs/${entry.name}`}
            className={entry.name === selected ? 'active' : undefined}
          >
            {entry.name}
          </a>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}
      {!doc && !error && <p className="muted">loading…</p>}
      {doc && (
        <article className="doc" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}
