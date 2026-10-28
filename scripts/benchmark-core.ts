import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildNativeMemoryGraph } from '../src/core/memory/graph.js'
import type { MemoryPage } from '../src/core/memory/project.js'
import { chunkDocument } from '../src/core/documents/extractor.js'
import { Scheduler } from '../src/core/scheduler/scheduler.js'
import { ObservabilityService } from '../src/core/observability/service.js'

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..')
  const out = path.join(root, 'Prints', 'benchmarks-2026-10-25')
  fs.mkdirSync(out, { recursive: true })
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openclod-bench-'))
  const memoryUsage = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024)

  const pages: MemoryPage[] = Array.from({ length: 1_000 }, (_, index) => ({
    slug: `page-${index}`,
    title: `Página ${index}`,
    body: `memória grafo conexão índice ${index % 50} [[page-${(index + 1) % 1_000}]] teste arquitetura`,
    tags: [`grupo-${index % 20}`, 'memoria'],
    pinned: false,
    created: '2026-10-25T12:00:00.000Z',
    updated: '2026-10-25T12:00:00.000Z',
    source: 'benchmark',
    status: 'active'
  }))
  let started = performance.now()
  const graph = buildNativeMemoryGraph(pages)
  const graphMs = performance.now() - started

  const largeText = Array.from({ length: 20_000 }, (_, index) => `Parágrafo ${index}: memória, documento e recuperação de conhecimento.`).join('\n')
  started = performance.now()
  const chunks = chunkDocument('large.md', largeText, { chunkSize: 2_500, overlap: 250 })
  const chunkMs = performance.now() - started

  let clock = new Date('2026-10-25T07:59:00')
  const scheduler = new Scheduler(path.join(temp, 'schedules.json'), { now: () => clock, maxConcurrent: 8 })
  for (let index = 0; index < 200; index++) {
    await scheduler.create({ name: `task-${index}`, prompt: 'noop', projectId: 'p', cwd: temp, schedule: { kind: 'daily', time: '08:00' }, enabled: true })
  }
  let runs = 0
  await scheduler.start(async () => { runs++ })
  clock = new Date('2026-10-25T08:00:10')
  await scheduler.tick()
  const schedulerMs = performance.now() - started

  const observability = new ObservabilityService(path.join(temp, 'observability'), { maxEvents: 4_000 })
  await observability.init()
  started = performance.now()
  for (let index = 0; index < 10_000; index++) observability.recordLog('benchmark', `evento ${index}`)
  await observability.flush()
  const observabilityMs = performance.now() - started
  await fs.promises.rm(temp, { recursive: true, force: true })

  const evidence = {
    ok: true,
    measuredAt: new Date().toISOString(),
    runtime: { node: process.version, platform: `${process.platform} ${process.arch}`, heapMB: memoryUsage() },
    memoryGraph: { pages: pages.length, nodes: graph.nodes.length, edges: graph.edges.length, elapsedMs: Math.round(graphMs) },
    documentChunking: { inputChars: largeText.length, chunks: chunks.length, elapsedMs: Math.round(chunkMs) },
    schedulerRegistration: { tasks: 200, runs: runs, elapsedMs: Math.round(schedulerMs) },
    observability: { eventsOffered: 10_000, retained: observability.list({ limit: 1_000 }).length, elapsedMs: Math.round(observabilityMs) },
    note: 'All measurements are local and reproducible; they are not a comparison against another product.'
  }
  await fs.promises.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  scheduler.stop()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
