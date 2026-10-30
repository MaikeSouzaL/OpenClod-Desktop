import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type { Project } from '../../../shared/types'
import type { MemoryGraphInfo, MemoryGraphNodeInfo, MemoryPageContent } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { Icon } from './Icons'
import { Markdown } from './Markdown'

interface MemoryGraphProps {
  project: Project
}

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

/** Rest length and pull of each kind of edge: written links hold pages closest. */
const EDGE_KINDS = { link: 0, tag: 1, term: 2 } as const
const EDGE_LENGTH = [42, 64, 84]
const EDGE_PULL = [0.7, 0.3, 0.15]
/** Pages farther apart than this do not push each other (a grid finds the near ones: no pass over every pair). */
const CELL = 90
const REPULSION = 1600
/** Physics per frame: the page stays responsive however big the graph is. */
const FRAME_BUDGET_MS = 6
const ALPHA_MIN = 0.004

/** The layout lives outside React: typed arrays moved in place, drawn on a canvas, nothing re-rendered per frame. */
interface Sim {
  nodes: MemoryGraphNodeInfo[]
  index: Map<string, number>
  x: Float32Array
  y: Float32Array
  vx: Float32Array
  vy: Float32Array
  radius: Float32Array
  edgeA: Int32Array
  edgeB: Int32Array
  edgeKind: Uint8Array
  edgePull: Float32Array
  neighbours: Array<number[]>
  alpha: number
  dragged: number
}

function createSim(graph: MemoryGraphInfo): Sim {
  const nodes = graph.nodes
  const n = nodes.length
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const edges = graph.edges.filter((edge) => index.has(edge.source) && index.has(edge.target))
  const edgeA = new Int32Array(edges.length)
  const edgeB = new Int32Array(edges.length)
  const edgeKind = new Uint8Array(edges.length)
  const neighbours: Array<number[]> = nodes.map(() => [])
  edges.forEach((edge, e) => {
    edgeA[e] = index.get(edge.source)!
    edgeB[e] = index.get(edge.target)!
    edgeKind[e] = EDGE_KINDS[edge.kind] ?? 2
    neighbours[edgeA[e]].push(edgeB[e])
    neighbours[edgeB[e]].push(edgeA[e])
  })
  // A hub would drag its whole neighbourhood into one point: each edge pulls in proportion to its less connected end.
  const edgePull = new Float32Array(edges.length)
  for (let e = 0; e < edges.length; e++) {
    edgePull[e] = EDGE_PULL[edgeKind[e]] / Math.max(1, Math.min(neighbours[edgeA[e]].length, neighbours[edgeB[e]].length))
  }
  // Sunflower start, the most connected pages in the middle: an even spread the layout only has to relax.
  const order = nodes.map((_, i) => i).sort((a, b) => neighbours[b].length - neighbours[a].length)
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  order.forEach((i, rank) => {
    const r = 16 * Math.sqrt(rank + 0.5)
    const angle = rank * 2.399963
    x[i] = Math.cos(angle) * r
    y[i] = Math.sin(angle) * r
  })
  const radius = new Float32Array(n)
  nodes.forEach((node, i) => {
    radius[i] = 3 + Math.min(7, Math.sqrt(neighbours[i].length) * 1.5)
  })
  return { nodes, index, x, y, vx: new Float32Array(n), vy: new Float32Array(n), radius, edgeA, edgeB, edgeKind, edgePull, neighbours, alpha: 1, dragged: -1 }
}

/** One step of the force layout (d3-force's model): springs on edges, short-range repulsion, a weak pull to the centre. */
function tick(sim: Sim): void {
  const { x, y, vx, vy, edgeA, edgeB, edgeKind, edgePull } = sim
  const n = x.length
  const alpha = sim.alpha
  for (let e = 0; e < edgeA.length; e++) {
    const a = edgeA[e]
    const b = edgeB[e]
    const dx = x[b] + vx[b] - x[a] - vx[a] || 0.01
    const dy = y[b] + vy[b] - y[a] - vy[a] || 0.01
    const dist = Math.sqrt(dx * dx + dy * dy)
    const pull = ((dist - EDGE_LENGTH[edgeKind[e]]) / dist) * alpha * edgePull[e]
    vx[b] -= dx * pull * 0.5
    vy[b] -= dy * pull * 0.5
    vx[a] += dx * pull * 0.5
    vy[a] += dy * pull * 0.5
  }
  const grid = new Map<number, number[]>()
  const cellOf = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768)
  for (let i = 0; i < n; i++) {
    const key = cellOf(Math.floor(x[i] / CELL), Math.floor(y[i] / CELL))
    const cell = grid.get(key)
    if (cell) cell.push(i)
    else grid.set(key, [i])
  }
  const reach = CELL * CELL
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i] / CELL)
    const cy = Math.floor(y[i] / CELL)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cell = grid.get(cellOf(cx + ox, cy + oy))
        if (!cell) continue
        for (const j of cell) {
          if (j <= i) continue
          let dx = x[i] - x[j]
          let dy = y[i] - y[j]
          let d2 = dx * dx + dy * dy
          if (d2 > reach) continue
          if (d2 < 1) {
            dx = (i % 7) - 3 || 1
            dy = (j % 5) - 2 || 1
            d2 = dx * dx + dy * dy
          }
          const push = (REPULSION * alpha) / d2
          vx[i] += dx * push
          vy[i] += dy * push
          vx[j] -= dx * push
          vy[j] -= dy * push
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    vx[i] -= x[i] * 0.012 * alpha
    vy[i] -= y[i] * 0.012 * alpha
    if (i === sim.dragged) {
      vx[i] = 0
      vy[i] = 0
      continue
    }
    vx[i] *= 0.6
    vy[i] *= 0.6
    x[i] += vx[i]
    y[i] += vy[i]
  }
  sim.alpha += (0 - sim.alpha) * 0.0228
}

interface Camera {
  x: number
  y: number
  k: number
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 2)

export function MemoryGraph({ project }: MemoryGraphProps): ReactElement {
  const [graph, setGraph] = useState<MemoryGraphInfo | null>(null)
  // The search the graph on screen answers (the box may already hold a newer one, still on its way).
  const [graphQuery, setGraphQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MemoryGraphNodeInfo | null>(null)
  const [content, setContent] = useState<MemoryPageContent | null>(null)
  const [reading, setReading] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const simRef = useRef<Sim | null>(null)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 1 })
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 })
  const hoverRef = useRef(-1)
  const selectedRef = useRef(-1)
  const matchRef = useRef<Uint8Array | null>(null)
  const frameRef = useRef(0)
  const pointerRef = useRef<{ mode: 'node' | 'pan'; node: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  const requestRef = useRef(0)
  const autoFitRef = useRef(true)

  const load = useCallback(
    async (search: string): Promise<void> => {
      setLoading(true)
      setError('')
      try {
        const result = await unwrap(window.openclod.memory.graph(project.id, search))
        setGraph(result)
        setGraphQuery(search)
        setSelected(null)
        setContent(null)
      } catch (err) {
        setError(errorMessage(err))
        setGraph(null)
      } finally {
        setLoading(false)
      }
    },
    [project.id]
  )

  // The search goes to the whole memory (the graph shows only part of a big one): a moment after the typing stops.
  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim()), query.trim() ? 350 : 0)
    return () => clearTimeout(timer)
  }, [load, query])

  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    const sim = simRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = sizeRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (!sim) return
    const css = getComputedStyle(canvas)
    const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
    const camera = cameraRef.current
    const k = camera.k
    ctx.translate(width / 2 + camera.x, height / 2 + camera.y)
    ctx.scale(k, k)
    const { x, y, edgeA, edgeB, edgeKind, radius, nodes, neighbours } = sim
    const focus = selectedRef.current >= 0 ? selectedRef.current : hoverRef.current
    const near = focus >= 0 ? new Set([focus, ...neighbours[focus]]) : null
    const match = matchRef.current

    // Edges: one path per kind, the ones around the page in focus drawn last and brighter.
    // Written links in the link colour; tags and words in the text colour of the theme, fainter.
    const edgeColors = [COLORS.page, color('--text-2', '#bbb'), color('--text-2', '#bbb')]
    const edgeAlpha = [0.7, 0.3, 0.14]
    ctx.lineWidth = 1 / k
    for (let kind = 2; kind >= 0; kind--) {
      ctx.beginPath()
      for (let e = 0; e < edgeA.length; e++) {
        if (edgeKind[e] !== kind) continue
        if (near && (edgeA[e] === focus || edgeB[e] === focus)) continue
        ctx.moveTo(x[edgeA[e]], y[edgeA[e]])
        ctx.lineTo(x[edgeB[e]], y[edgeB[e]])
      }
      ctx.globalAlpha = edgeAlpha[kind] * (near ? 0.3 : 1)
      ctx.strokeStyle = edgeColors[kind]
      ctx.stroke()
    }
    if (near) {
      ctx.lineWidth = 1.6 / k
      for (let kind = 2; kind >= 0; kind--) {
        ctx.beginPath()
        for (let e = 0; e < edgeA.length; e++) {
          if (edgeKind[e] !== kind || (edgeA[e] !== focus && edgeB[e] !== focus)) continue
          ctx.moveTo(x[edgeA[e]], y[edgeA[e]])
          ctx.lineTo(x[edgeB[e]], y[edgeB[e]])
        }
        ctx.globalAlpha = kind === 0 ? 0.95 : 0.75
        ctx.strokeStyle = edgeColors[kind]
        ctx.stroke()
      }
    }

    // Pages: one path per colour; the ones out of focus (or not matching the search) faded.
    const minRadius = 1.6 / k
    for (const faded of [true, false]) {
      for (const kind of Object.keys(COLORS) as Array<MemoryGraphNodeInfo['kind']>) {
        ctx.beginPath()
        let any = false
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i].kind !== kind) continue
          const dim = (near !== null && !near.has(i)) || (match !== null && !match[i])
          if (dim !== faded) continue
          const r = Math.max(minRadius, radius[i])
          ctx.moveTo(x[i] + r, y[i])
          ctx.arc(x[i], y[i], r, 0, Math.PI * 2)
          any = true
        }
        if (!any) continue
        ctx.globalAlpha = faded ? 0.18 : 1
        ctx.fillStyle = COLORS[kind]
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    if (focus >= 0) {
      ctx.beginPath()
      ctx.arc(x[focus], y[focus], radius[focus] + 4 / k, 0, Math.PI * 2)
      ctx.strokeStyle = color('--text', '#eee')
      ctx.lineWidth = 1.5 / k
      ctx.stroke()
    }

    // Names: the page in focus and its neighbours, else the most connected ones as the zoom allows.
    const labels: number[] = []
    if (near) labels.push(focus, ...[...near].filter((i) => i !== focus).slice(0, 30))
    else {
      const room = nodes.length <= 60 ? nodes.length : Math.min(80, Math.floor(18 * k * k))
      if (room > 0) {
        const byDegree = nodes.map((_, i) => i).sort((a, b) => neighbours[b].length - neighbours[a].length)
        for (const i of byDegree) {
          if (labels.length >= room) break
          if (match && !match[i]) continue
          labels.push(i)
        }
      }
    }
    if (labels.length) {
      ctx.font = `${12 / k}px ${color('--sans', 'system-ui, sans-serif')}`
      ctx.textAlign = 'center'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3 / k
      ctx.strokeStyle = color('--bg', '#141413')
      for (const i of labels) {
        const title = nodes[i].title.length > 42 ? `${nodes[i].title.slice(0, 41)}…` : nodes[i].title
        const ty = y[i] + radius[i] + 13 / k
        ctx.fillStyle = i === focus ? color('--text', '#eee') : color('--text-2', '#bbb')
        ctx.strokeText(title, x[i], ty)
        ctx.fillText(title, x[i], ty)
      }
    }
  }, [])

  /** Frames the whole graph in the view. */
  const frameAll = useCallback((): void => {
    const sim = simRef.current
    const { width, height } = sizeRef.current
    if (!sim || !sim.x.length || !width) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < sim.x.length; i++) {
      minX = Math.min(minX, sim.x[i])
      maxX = Math.max(maxX, sim.x[i])
      minY = Math.min(minY, sim.y[i])
      maxY = Math.max(maxY, sim.y[i])
    }
    const k = Math.max(0.05, Math.min(2.5, Math.min(width / (maxX - minX + 80), height / (maxY - minY + 80))))
    cameraRef.current = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k }
  }, [])

  /** Runs the layout while it still moves (a few ms of physics per frame) and draws; idle when it has settled. */
  const wake = useCallback((): void => {
    if (requestRef.current) return
    const frame = (): void => {
      requestRef.current = 0
      const sim = simRef.current
      if (sim && (sim.alpha > ALPHA_MIN || sim.dragged >= 0)) {
        const started = performance.now()
        do tick(sim)
        while (performance.now() - started < FRAME_BUDGET_MS && sim.alpha > ALPHA_MIN && sim.dragged < 0)
        frameRef.current++
        // Until the user moves the view, it follows the layout as it opens up.
        if (autoFitRef.current && frameRef.current % 6 === 0) frameAll()
        draw()
        requestRef.current = requestAnimationFrame(frame)
        return
      }
      draw()
    }
    requestRef.current = requestAnimationFrame(frame)
  }, [draw, frameAll])

  const fit = useCallback((): void => {
    frameAll()
    wake()
  }, [frameAll, wake])

  // The canvas follows the size of its box, sharp on high-DPI screens.
  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const resize = (): void => {
      const width = stage.clientWidth
      const height = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width, height, dpr }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      wake()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [graph, wake])

  // A new graph: new layout, framed in the view.
  useEffect(() => {
    simRef.current = graph?.nodes.length ? createSim(graph) : null
    hoverRef.current = -1
    selectedRef.current = -1
    frameRef.current = 0
    autoFitRef.current = true
    fit()
  }, [graph, fit])

  // Which of the shown pages match the search (the others are the pages linked to them).
  useEffect(() => {
    const sim = simRef.current
    const wanted = words(query)
    if (!sim || !wanted.length) matchRef.current = null
    else {
      matchRef.current = Uint8Array.from(sim.nodes, (node) => {
        const text = words(`${node.title} ${node.tags.join(' ')} ${node.summary ?? ''}`).join(' ')
        return wanted.every((word) => text.includes(word) || node.terms.includes(word)) ? 1 : 0
      })
    }
    wake()
  }, [graph, query, wake])

  useEffect(() => {
    selectedRef.current = selected && simRef.current ? (simRef.current.index.get(selected.id) ?? -1) : -1
    wake()
  }, [selected, wake])

  useEffect(
    () => () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
      requestRef.current = 0
    },
    []
  )

  const toWorld = (clientX: number, clientY: number): { x: number; y: number; sx: number; sy: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const { width, height } = sizeRef.current
    const camera = cameraRef.current
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    return { x: (sx - width / 2 - camera.x) / camera.k, y: (sy - height / 2 - camera.y) / camera.k, sx, sy }
  }

  const hit = (wx: number, wy: number): number => {
    const sim = simRef.current
    if (!sim) return -1
    const slack = 4 / cameraRef.current.k
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < sim.x.length; i++) {
      const dx = sim.x[i] - wx
      const dy = sim.y[i] - wy
      const d = dx * dx + dy * dy
      const r = Math.max(sim.radius[i], 1.6 / cameraRef.current.k) + slack
      if (d <= r * r && d < bestD) {
        best = i
        bestD = d
      }
    }
    return best
  }

  // Zoom around the cursor; a native listener, since React's wheel handler cannot stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const { width, height } = sizeRef.current
      const camera = cameraRef.current
      const sx = event.clientX - rect.left - width / 2
      const sy = event.clientY - rect.top - height / 2
      const k = Math.max(0.05, Math.min(6, camera.k * Math.exp(-event.deltaY * 0.0015)))
      const wx = (sx - camera.x) / camera.k
      const wy = (sy - camera.y) / camera.k
      cameraRef.current = { k, x: sx - wx * k, y: sy - wy * k }
      autoFitRef.current = false
      wake()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [graph, wake])

  const zoomBy = (factor: number): void => {
    const camera = cameraRef.current
    const k = Math.max(0.05, Math.min(6, camera.k * factor))
    cameraRef.current = { k, x: (camera.x / camera.k) * k, y: (camera.y / camera.k) * k }
    autoFitRef.current = false
    wake()
  }

  const openNode = async (node: MemoryGraphNodeInfo): Promise<void> => {
    setSelected(node)
    setReading(true)
    setContent(null)
    try {
      // Native nodes are wiki slugs; a page only the AI-Memory index has comes as `ai:<path>`.
      setContent(await unwrap(window.openclod.memory.read(project.id, node.id)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setReading(false)
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    const point = toWorld(event.clientX, event.clientY)
    const node = hit(point.x, point.y)
    pointerRef.current = { mode: node >= 0 ? 'node' : 'pan', node, startX: point.sx, startY: point.sy, lastX: point.sx, lastY: point.sy, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = toWorld(event.clientX, event.clientY)
    const pointer = pointerRef.current
    const sim = simRef.current
    if (pointer && sim) {
      if (!pointer.moved && Math.hypot(point.sx - pointer.startX, point.sy - pointer.startY) > 4) pointer.moved = true
      if (!pointer.moved) return
      autoFitRef.current = false
      if (pointer.mode === 'node') {
        sim.dragged = pointer.node
        sim.x[pointer.node] = point.x
        sim.y[pointer.node] = point.y
        sim.alpha = Math.max(sim.alpha, 0.25)
      } else {
        cameraRef.current = { ...cameraRef.current, x: cameraRef.current.x + point.sx - pointer.lastX, y: cameraRef.current.y + point.sy - pointer.lastY }
      }
      pointer.lastX = point.sx
      pointer.lastY = point.sy
      wake()
      return
    }
    const over = hit(point.x, point.y)
    if (over !== hoverRef.current) {
      hoverRef.current = over
      if (canvasRef.current) canvasRef.current.style.cursor = over >= 0 ? 'pointer' : 'grab'
      wake()
    }
  }

  const onPointerUp = (): void => {
    const pointer = pointerRef.current
    const sim = simRef.current
    pointerRef.current = null
    if (sim) sim.dragged = -1
    if (!pointer || pointer.moved || !sim) {
      wake()
      return
    }
    if (pointer.node >= 0) void openNode(sim.nodes[pointer.node])
    else {
      setSelected(null)
      setContent(null)
    }
  }

  const relayout = (): void => {
    if (graph?.nodes.length) simRef.current = createSim(graph)
    autoFitRef.current = true
    fit()
  }

  const shown = graph?.nodes.length ?? 0
  const total = graph?.total ?? shown
  const searching = Boolean(query.trim())
  const pending = query.trim() !== graphQuery
  const legend = Object.keys(COLORS) as Array<MemoryGraphNodeInfo['kind']>

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
            placeholder="Procurar na memória inteira (título, tag ou termo)"
            spellCheck={false}
          />
        </div>
        <span className="page-tools-spacer" />
        <span className="muted" data-graph-count>
          {shown} nós · {graph?.edges.length ?? 0} conexões
          {pending
            ? ' · procurando…'
            : graph?.truncated
            ? searching
              ? ` · ${total} páginas casam com a busca; mostrando as mais ligadas`
              : ` · mostrando as ${shown} mais ligadas de ${total}; procure para ver outras`
            : searching && graph
              ? ` · ${total} páginas casam com a busca`
              : ''}
          {graph?.source === 'native' ? ' · wiki nativa' : ''}
        </span>
        <button type="button" className="btn ghost small" onClick={() => zoomBy(1.25)} title="Aproximar">
          +
        </button>
        <button type="button" className="btn ghost small" onClick={() => zoomBy(0.8)} title="Afastar">
          −
        </button>
        <button type="button" className="btn ghost small" onClick={relayout}>
          Recentralizar
        </button>
        <button type="button" className="btn ghost small" onClick={() => void load(query.trim())}>
          <Icon name="refresh" size={13} /> Atualizar
        </button>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}
      {loading && !graph ? <div className="page-empty compact">Carregando grafo da memória…</div> : null}

      {!loading && graph && !graph.nodes.length ? (
        <div className="page-empty">
          <Icon name="share" size={30} />
          <p>{searching ? 'Nenhuma página casa com a busca.' : 'Nenhuma página indexada ainda. Converse no projeto; o grafo cresce a cada turno.'}</p>
        </div>
      ) : null}

      {graph && graph.nodes.length ? (
        <div className="memory-graph-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="memory-graph"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (!pointerRef.current && hoverRef.current >= 0) {
                hoverRef.current = -1
                wake()
              }
            }}
          />
          {loading ? <div className="memory-graph-busy">Atualizando…</div> : null}

          <div className="memory-graph-legend">
            {legend.map((kind) => (
              <span key={kind}>
                <i style={{ background: COLORS[kind] }} /> {KIND_LABELS[kind]}
              </span>
            ))}
            <span><i className="line link" /> link</span>
            <span><i className="line" /> tag</span>
            <span><i className="line faint" /> termo</span>
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
