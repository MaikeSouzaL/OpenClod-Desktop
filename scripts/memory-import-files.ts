// Bulk import of many files into a project's memory, from a manifest: each file is copied into the memory with its text
// (OCR for pictures, the text of PDFs and Office documents), plus what the manifest brings (a ready description or
// transcript, tags, links to other pages, where it came from). Resumable: a file already in the memory is skipped, unless
// the manifest now brings a description it did not have. The app can stay open: the wiki is the source of truth, its index
// follows the files written here, and the app copies the new pages into the AI-Memory index in the background.
//
//   npx tsx scripts/memory-import-files.ts --project <prj_…> --manifest <arquivo.json> [--concurrency 4] [--from "%APPDATA%\Openclod Desktop"] [--status <arquivo.json>]
//
// Manifest: a JSON array of { path, tags?, links?, origin?, name?, description?, describedBy?, ocr?, media?, overwrite? }. `media: true`
// sends an audio or video through the media pipeline instead (local Whisper transcript, frames and their text), for the ones
// that have no transcript yet.
import fs from 'node:fs'
import path from 'node:path'
import { ProjectMemory } from '../src/core/memory/project'
import { addMemoryFile } from '../src/core/memory/files'
import { ingestToMemory } from '../src/core/media/memory'

interface Entry {
  path: string
  tags?: string[]
  links?: string[]
  origin?: string
  name?: string
  description?: string
  describedBy?: string
  ocr?: boolean
  media?: boolean
  /** Process the file again even if it is already in the memory (a kind the app learned to read since). */
  overwrite?: boolean
}

const arg = (name: string, fallback = ''): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

async function main(): Promise<void> {
  const project = arg('project')
  const manifest = arg('manifest')
  if (!/^prj_[a-z0-9-]+$/i.test(project) || !manifest) throw new Error('use --project <prj_…> --manifest <arquivo.json>')
  const from = arg('from', path.join(process.env.APPDATA ?? '', 'Openclod Desktop'))
  const root = path.join(from, 'data', 'memory', 'projects', project)
  if (!fs.existsSync(path.join(root, 'wiki'))) throw new Error(`memória do projeto não encontrada: ${root}`)
  // `--shard 2/4`: every 4th entry from the 3rd. Reading PDFs is JavaScript on one core per process; a few processes over
  // disjoint parts of the manifest use the others (each writes its own files, the index follows them by stamp).
  const [shard, shards] = (arg('shard', '0/1').match(/^(\d+)\/(\d+)$/)?.slice(1).map(Number) ?? [0, 1]) as [number, number]
  const entries = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as Entry[]).filter((_, index) => index % shards === shard)
  const concurrency = Math.max(1, Math.min(8, Number(arg('concurrency', '4')) || 4))
  const statusFile = arg('status', `${manifest.replace(/\.json$/i, '')}${shards > 1 ? `.${shard}-${shards}` : ''}.status.json`)
  const memory = new ProjectMemory(root)
  const status = {
    project,
    total: entries.length,
    done: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    described: 0,
    failed: [] as string[],
    startedAt: new Date().toISOString(),
    updatedAt: '',
    finished: false
  }
  const save = (): void => {
    status.updatedAt = new Date().toISOString()
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2))
  }
  const startedAt = Date.now()

  const importOne = async (entry: Entry): Promise<void> => {
    const fileStartedAt = Date.now()
    try {
      if (entry.media) {
        const media = await ingestToMemory({ file: entry.path, memory, language: 'pt', model: 'small' })
        if (media.cached) status.unchanged++
        else status.added++
        if (media.manifest.transcript.segments.length) status.described++
        return
      }
      const result = await addMemoryFile(entry.path, {
        memory,
        tags: entry.tags,
        links: entry.links,
        origin: entry.origin,
        name: entry.name,
        description: entry.description,
        describedBy: entry.describedBy,
        ocr: entry.ocr,
        overwrite: entry.overwrite
      })
      if (!result.cached) status.added++
      else if (/atualizado/.test(result.line)) status.updated++
      else status.unchanged++
      if (result.meta.description) status.described++
    } catch (err) {
      status.failed.push(`${entry.path}: ${(err as Error).message}`.slice(0, 300))
    } finally {
      status.done++
      const seconds = (Date.now() - fileStartedAt) / 1000
      if (seconds > 10) console.log(`  lento (${seconds.toFixed(0)} s): ${entry.path}`)
    }
  }

  // One queue for the whole manifest, a few files at a time (most of the time is OCR: a scanned PDF of 40 pages takes
  // minutes, and blocks made every other worker wait for the slowest file of the block). All of it is one batch: the index
  // is saved once at the end; if the run stops before, the wiki's pages are on disk and the index rereads them by stamp.
  const report = (): void => {
    save()
    const seconds = (Date.now() - startedAt) / 1000
    const rate = status.done / Math.max(1, seconds)
    const left = (status.total - status.done) / Math.max(rate, 0.001)
    console.log(
      `${status.done}/${status.total} · novos ${status.added} · atualizados ${status.updated} · iguais ${status.unchanged} · falhas ${status.failed.length} · ${rate.toFixed(2)}/s · faltam ~${Math.round(left / 60)} min`
    )
  }
  await memory.bulk(async () => {
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
        while (next < entries.length) {
          await importOne(entries[next++])
          if (status.done % 40 === 0) report()
        }
      })
    )
  })
  report()
  status.finished = true
  save()
  console.log(`fim: ${status.added} novos, ${status.updated} atualizados, ${status.unchanged} já estavam, ${status.failed.length} falhas (detalhes em ${statusFile})`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
