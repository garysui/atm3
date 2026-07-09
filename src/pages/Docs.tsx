import { marked } from 'marked'
import mermaid from 'mermaid'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getJson } from '../api.ts'

type DocEntry = { name: string; title: string }

mermaid.initialize({ startOnLoad: false, theme: 'neutral' })

// marked leaves ```mermaid blocks as <pre><code class="language-mermaid">;
// render each into an SVG in place. A diagram that fails to parse keeps its
// code block with the error shown, never a blank hole.
async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = [...container.querySelectorAll('code.language-mermaid')]

  for (const [index, block] of blocks.entries()) {
    const source = block.textContent ?? ''
    const host = block.closest('pre') ?? block

    try {
      const { svg } = await mermaid.render(`doc-diagram-${index}`, source)
      const figure = document.createElement('div')
      figure.className = 'diagram'
      figure.innerHTML = svg
      host.replaceWith(figure)
    } catch (cause) {
      const note = document.createElement('p')
      note.className = 'error'
      note.textContent = `diagram failed to render: ${(cause as Error).message}`
      host.before(note)
    }
  }
}

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
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const article = articleRef.current

    if (article && html) {
      void renderMermaidBlocks(article)
    }
  }, [html])

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
        <article
          ref={articleRef}
          className="doc"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}
