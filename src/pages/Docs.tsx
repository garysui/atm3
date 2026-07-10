import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'
import { getJson } from '../api.ts'

type DocEntry = { name: string; title: string }

// Mermaid is ~1 MB — loaded on demand the first time a doc actually
// contains a diagram, not on app startup (review finding #8).
let mermaidLoader: Promise<typeof import('mermaid').default> | null = null

function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidLoader ??= import('mermaid').then((module) => {
    module.default.initialize({ startOnLoad: false, theme: 'neutral' })
    return module.default
  })

  return mermaidLoader
}

// In-doc relative markdown links must stay inside the SPA: `tech-stack.md`
// becomes `#docs/tech-stack` (a path navigation would leave the app and 404
// on refresh). External links open in a new tab.
function rewriteDocLinks(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''

    if (/^(https?:)?\/\//.test(href)) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noreferrer')
      continue
    }

    // Section anchors are not supported (marked emits no heading ids) and a
    // raw #foo would hash-route to the wrong page — unwrap to plain text.
    if (href.startsWith('#') && !href.startsWith('#docs/')) {
      anchor.replaceWith(...anchor.childNodes)
      continue
    }

    const match = href.match(/^(?:\.\/)?(?:docs\/)?([a-z0-9-]+)\.md(?:#.*)?$/i)

    if (match) {
      anchor.setAttribute('href', `#docs/${match[1]}`)
    }
  }
}

let diagramRenderSequence = 0

// marked leaves ```mermaid blocks as <pre><code class="language-mermaid">;
// render each into an SVG in place. A diagram that fails to parse keeps its
// code block with the error shown, never a blank hole.
async function renderMermaidBlocks(
  container: HTMLElement,
  isCancelled: () => boolean,
): Promise<void> {
  const blocks = [...container.querySelectorAll('code.language-mermaid')]

  if (blocks.length === 0) {
    return
  }

  const mermaid = await loadMermaid()

  for (const block of blocks) {
    // Doc switched mid-pass: stop wasting renders on an abandoned container.
    // Ids are globally unique so overlapping passes can never collide.
    if (isCancelled()) {
      return
    }

    const source = block.textContent ?? ''
    const host = block.closest('pre') ?? block

    try {
      const { svg } = await mermaid.render(
        `doc-diagram-${diagramRenderSequence++}`,
        source,
      )
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

  // The full transform (markdown -> html -> link rewrite -> mermaid SVGs)
  // happens in a DETACHED container and is committed through state in one
  // shot. Never mutate React-rendered DOM after the fact: a later re-render
  // (e.g. opening the lightbox) re-applies dangerouslySetInnerHTML and wipes
  // any post-render mutations.
  const [rendered, setRendered] = useState<{
    forDoc: string
    html: string
  } | null>(null)

  useEffect(() => {
    if (!doc) {
      return
    }

    let cancelled = false

    void (async () => {
      const container = document.createElement('div')
      container.innerHTML = marked.parse(doc.markdown) as string
      rewriteDocLinks(container)
      await renderMermaidBlocks(container, () => cancelled)

      if (!cancelled) {
        setRendered({ forDoc: doc.name, html: container.innerHTML })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [doc])

  const html = rendered?.forDoc === selected ? rendered.html : null

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
      {!html && !error && <p className="muted">loading…</p>}
      {html && (
        <article
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
