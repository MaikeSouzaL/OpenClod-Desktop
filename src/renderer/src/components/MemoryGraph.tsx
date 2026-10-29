import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type { Project } from '../../../shared/types'
import type { MemoryGraphEdgeInfo, MemoryGraphInfo, MemoryGraphNodeInfo, MemoryPageContent } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { circularLayout } from '../lib/graph-layout'
import { Icon } from './Icons'
import { Markdown } from './Markdown'

interface MemoryGraphProps {
  project: Project
}

interface Point {
  x: number
  y: number
  vx: number
  vy: number
  fixed?: boolean
}

const WIDTH = 1000
const HEIGHT = 680
const COLORS: Record<MemoryGraphNodeInfo['kind'], string> = {
  session: '#6ea8fe',
  page: '#f0b35a',
  fact: '#8fe388'
}

const KIND_LABELS: Record<MemoryGraphNodeInfo['kind'], string> = {
  session: 'sessão',
  page: 'página',
  fact: 'fato'
}

function initialPositions(nodes: MemoryGraphNodeInfo[]): Record<string, Point> {
  const out: Record<string, Point> = {}
  const radius = Math.min(WIDTH, HEIGHT) * 0.33
  const ring = circularLayout(nodes.length, WIDTH / 2, HEIGHT / 2, radius)
  nodes.forEach((node, index) => {
    const point = ring[index] ?? { x: WIDTH / 2, y: HEIGHT / 2 }
    out[node.id] = { x: point.x, y: point.y, vx: 0, vy: 0 }
  })
  return out
}

/** Small force-directed layout, inspired by Obsidian's graph and ai-memory's graph view. */
function step(positions: Record<string, Point>, edges: MemoryGraphEdgeInfo[], dragging: string | null): Record<string, Point> {
  const ids = Object.keys(positions)
  const next: Record<string, Point> = {}
  for (const id of ids) next[id] = { ...positions[id], vx: positions[id].vx * 0.82, vy: positions[id].vy * 0.82 }

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = next[ids[i]]
      const b = next[ids[j]]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let dist2 = dx * dx + dy * dy
      if (dist2 < 1) {
        dx = 0.5
        dy = 0.5
        dist2 = 0.5
      }
      const dist = Math.sqrt(dist2)
      const force = Math.min(900, 52000 / dist2)
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }

  for (const edge of edges) {
    const a = next[edge.source]
    const b = next[edge.target]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const desired = edge.kind === 'link' ? 120 : 170
    const strength = edge.kind === 'link' ? 0.035 : 0.018
    const force = (dist - desired) * strength
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  for (const id of ids) {
    const p = next[id]
    p.vx += (WIDTH / 2 - p.x) * 0.0018
    p.vy += (HEIGHT / 2 - p.y) * 0.0018
    if (id === dragging) continue
    p.x = Math.max(30, Math.min(WIDTH - 30, p.x + p.vx * 0.05))
    p.y = Math.max(30, Math.min(HEIGHT - 30, p.y + p.vy * 0.05))
  }
  return next
}

export function MemoryGraph({ project }: MemoryGraphProps): ReactElement {
  const [graph, setGraph] = useState<MemoryGraphInfo | null>(null)
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MemoryGraphNodeInfo | null>(null)
  const [content, setContent] = useState<MemoryPageContent | null>(null)
  const [reading, setReading] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const frameRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await unwrap(window.openclod.memory.graph(project.id))
      setGraph(result)
      setPositions(initialPositions(result.nodes))
      frameRef.current = 0
      setSelected(null)
      setContent(null)
    } catch (err) {
      setError(errorMessage(err))
      setGraph(null)
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    void load()
  }, [load])

  // Animate the layout for a moment, then stop so the graph can be explored.
  useEffect(() => {
    if (!graph?.nodes.length) return
    let raf = 0
    const tick = (): void => {
      frameRef.current++
      setPositions((current) => step(current, graph.edges, dragRef.current?.id ?? null))
      if (frameRef.current < 160) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [graph])

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of graph?.edges ?? []) {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)!.add(edge.target)
      map.get(edge.target)!.add(edge.source)
    }
    return map
  }, [graph])

  const openNode = async (node: MemoryGraphNodeInfo): Promise<void> => {
    setSelected(node)
    setReading(true)
    setContent(null)
    try {
      // Native nodes are identified by their wiki slug; only extra sidecar
      // nodes use the `ai:` prefix. Do not infer this from the graph's global
      // source, because a merged graph contains both kinds at once.
      const slug = node.path === node.id ? node.path : /^pages\/.+\.md$/i.test(node.path)
        ? `ai:${node.path}`
        : `ai:${node.path}`
      const page = await unwrap(window.openclod.memory.read(project.id, slug))
      setContent(page)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setReading(false)
    }
  }

  const svgPoint = (event: ReactPointerEvent): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT
    }
  }

  const onNodePointerDown = (event: ReactPointerEvent, node: MemoryGraphNodeInfo): void => {
    event.stopPropagation()
    const point = svgPoint(event)
    const current = positions[node.id]
    if (!current) return
    dragRef.current = { id: node.id, dx: point.x - current.x, dy: point.y - current.y }
    setDragging(node.id)
    ;(event.currentTarget as SVGGElement).setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent): void => {
    if (dragRef.current) {
      const point = svgPoint(event)
      const { id, dx, dy } = dragRef.current
      setPositions((current) => ({
        ...current,
        [id]: { ...current[id], x: point.x - dx, y: point.y - dy, vx: 0, vy: 0 }
      }))
      return
    }
    if (panRef.current) {
      const point = svgPoint(event)
      setPan({
        x: panRef.current.px + (point.x - panRef.current.x),
        y: panRef.current.py + (point.y - panRef.current.y)
      })
    }
  }

  const endPointer = (): void => {
    dragRef.current = null
    panRef.current = null
    setDragging(null)
  }

  const startPan = (event: ReactPointerEvent): void => {
    if (event.button !== 0) return
    const point = svgPoint(event)
    panRef.current = { x: point.x, y: point.y, px: pan.x, py: pan.y }
  }

  const filtered = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!filtered) return new Set(graph?.nodes.map((node) => node.id) ?? [])
    return new Set(
      (graph?.nodes ?? [])
        .filter(
          (node) =>
            node.title.toLowerCase().includes(filtered) ||
            node.tags.some((tag) => tag.toLowerCase().includes(filtered)) ||
            node.terms.some((term) => term.includes(filtered)) ||
            Boolean(node.summary?.toLowerCase().includes(filtered))
        )
        .map((node) => node.id)
    )
  }, [filtered, graph])

  const highlight = selected?.id ?? (dragging ?? null)
  const highlighted = useMemo(() => {
    if (!highlight) return null
    const set = new Set(neighbours.get(highlight) ?? [])
    set.add(highlight)
    return set
  }, [highlight, neighbours])

  return (
    <div className="memory-graph-wrap">
      <div className="memory-graph-summary">
        <Icon name="share" size={14} />
        <span>
          Wiki markdown + índice AI-Memory. Links explícitos vêm de <code>[[wikilinks]]</code>; tags e termos
          conectam páginas sem link escrito. Clique em qualquer nó para abrir a memória completa.
        </span>
      </div>
      <div className="memory-graph-tools">
        <div className="page-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filtrar nós por título, tag ou termo"
            spellCheck={false}
          />
        </div>
        <span className="page-tools-spacer" />
        <span className="muted">
          {graph?.nodes.length ?? 0} nós · {graph?.edges.length ?? 0} conexões
          {graph?.source === 'native' ? ' · wiki nativa' : ''}
        </span>
        <button type="button" className="btn ghost small" onClick={() => setZoom((value) => Math.min(2.5, value + 0.2))} title="Aproximar">
          +
        </button>
        <button type="button" className="btn ghost small" onClick={() => setZoom((value) => Math.max(0.4, value - 0.2))} title="Afastar">
          −
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
            setPositions(initialPositions(graph?.nodes ?? []))
            frameRef.current = 0
          }}
        >
          Recentralizar
        </button>
        <button type="button" className="btn ghost small" onClick={() => void load()}>
          <Icon name="refresh" size={13} /> Atualizar
        </button>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}
      {loading ? <div className="page-empty compact">Carregando grafo da memória…</div> : null}

      {!loading && graph && !graph.nodes.length ? (
        <div className="page-empty">
          <Icon name="share" size={30} />
          <p>Nenhuma página indexada ainda. Converse no projeto; o grafo cresce a cada turno.</p>
        </div>
      ) : null}

      {graph && graph.nodes.length ? (
        <div className="memory-graph-stage">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="memory-graph"
            onPointerDown={startPan}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerLeave={endPointer}
            onWheel={(event) => {
              event.preventDefault()
              setZoom((value) => Math.max(0.4, Math.min(2.5, value + (event.deltaY < 0 ? 0.1 : -0.1))))
            }}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {graph.edges.map((edge, index) => {
                const a = positions[edge.source]
                const b = positions[edge.target]
                if (!a || !b) return null
                const dim =
                  (highlighted && (!highlighted.has(edge.source) || !highlighted.has(edge.target))) ||
                  (filtered && (!visible.has(edge.source) || !visible.has(edge.target)))
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${index}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={`memory-edge ${edge.kind} ${dim ? 'dim' : ''}`}
                    strokeWidth={edge.kind === 'link' ? 1.8 : edge.weight > 3 ? 1.2 : 0.8}
                  />
                )
              })}
              {graph.nodes.map((node) => {
                const point = positions[node.id]
                if (!point) return null
                const radius = 5 + Math.min(6, node.degree * 0.8)
                const dim =
                  (highlighted && !highlighted.has(node.id)) ||
                  (filtered && !visible.has(node.id))
                return (
                  <g
                    key={node.id}
                    className={`memory-node ${dim ? 'dim' : ''} ${selected?.id === node.id ? 'selected' : ''}`}
                    transform={`translate(${point.x} ${point.y})`}
                    onPointerDown={(event) => onNodePointerDown(event, node)}
                    onClick={(event) => {
                      event.stopPropagation()
                      void openNode(node)
                    }}
                  >
                    <circle r={radius + 6} className="memory-node-halo" />
                    <circle r={radius} fill={COLORS[node.kind]} className="memory-node-dot" />
                    <text y={radius + 14} textAnchor="middle" className="memory-node-label">
                      {node.title.length > 42 ? `${node.title.slice(0, 41)}…` : node.title}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>

          <div className="memory-graph-legend">
            {(Object.keys(COLORS) as Array<MemoryGraphNodeInfo['kind']>).map((kind) => (
              <span key={kind}>
                <i style={{ background: COLORS[kind] }} /> {KIND_LABELS[kind]}
              </span>
            ))}
            <span><i className="line solid" /> link</span>
            <span><i className="line dashed" /> tag</span>
            <span><i className="line dotted" /> termo</span>
          </div>

          {selected ? (
            <aside className="memory-graph-detail">
              <div className="memory-graph-detail-head">
                <span className="badge" style={{ borderColor: COLORS[selected.kind] }}>
                  {KIND_LABELS[selected.kind]}
                </span>
                <span className="muted">{selected.degree} conexões</span>
                <button type="button" className="icon-btn small" onClick={() => setSelected(null)} title="Fechar">
                  <Icon name="x" size={14} />
                </button>
              </div>
              <h3>{selected.title}</h3>
              <div className="memory-detail-tags">
                {selected.tags.map((tag) => (
                  <span key={tag} className="badge">{tag}</span>
                ))}
              </div>
              {selected.terms.length ? (
                <p className="memory-graph-terms">Termos: {selected.terms.slice(0, 8).join(', ')}</p>
              ) : null}
              <div className="memory-graph-detail-body">
                {reading ? <span className="muted">Lendo página…</span> : null}
                {content ? <Markdown text={content.body} /> : null}
                {!reading && !content ? <span className="muted">Conteúdo indisponível.</span> : null}
              </div>
            </aside>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
