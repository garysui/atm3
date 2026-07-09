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
      figure.title = 'click to zoom'
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

// Fullscreen diagram viewer: wheel to zoom, drag to pan — the part GitHub
// does not give you.
function DiagramLightbox({
  svg,
  onClose,
}: {
  svg: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 48, y: 48 })
  const dragRef = useRef<{
    startX: number
    startY: number
    baseX: number
    baseY: number
  } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="lightbox" onClick={onClose}>
      <div
        className="lightbox-toolbar"
        onClick={(event) => event.stopPropagation()}
      >
        <button onClick={() => setScale((s) => Math.min(6, s * 1.25))}>
          zoom in
        </button>
        <button onClick={() => setScale((s) => Math.max(0.2, s / 1.25))}>
          zoom out
        </button>
        <button
          onClick={() => {
            setScale(1)
            setOffset({ x: 48, y: 48 })
          }}
        >
          reset
        </button>
        <span className="muted">{Math.round(scale * 100)}% · wheel zooms, drag pans</span>
        <button onClick={onClose}>close (esc)</button>
      </div>
      <div
        className="lightbox-canvas"
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) =>
          setScale((s) =>
            Math.min(6, Math.max(0.2, s * (event.deltaY < 0 ? 1.12 : 0.9))),
          )
        }
        onMouseDown={(event) => {
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            baseX: offset.x,
            baseY: offset.y,
          }
        }}
        onMouseMove={(event) => {
          const drag = dragRef.current

          if (drag) {
            setOffset({
              x: drag.baseX + event.clientX - drag.startX,
              y: drag.baseY + event.clientY - drag.startY,
            })
          }
        }}
        onMouseUp={() => {
          dragRef.current = null
        }}
        onMouseLeave={() => {
          dragRef.current = null
        }}
      >
        <div
          className="lightbox-content"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  )
}

// Project docs rendered in-app with GitHub's markdown styling; Mermaid
// diagrams render inline and open in the zoomable viewer on click.
export function Docs({ docName }: { docName: string | null }) {
  const [list, setList] = useState<DocEntry[] | null>(null)
  const [docState, setDocState] = useState<{
    name: string
    markdown: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Keyed by doc so switching docs implicitly closes it — no effect resets.
  const [lightbox, setLightbox] = useState<{
    forDoc: string
    svg: string
  } | null>(null)

  const selected = docName ?? 'market-data-phenomena'
  const lightboxSvg = lightbox?.forDoc === selected ? lightbox.svg : null

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
          onClick={(event) => {
            const figure = (event.target as HTMLElement).closest('.diagram')
            const svg = figure?.querySelector('svg')

            if (svg) {
              setLightbox({ forDoc: selected, svg: svg.outerHTML })
            }
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {lightboxSvg && (
        <DiagramLightbox svg={lightboxSvg} onClose={() => setLightbox(null)} />
      )}
    </div>
  )
}
