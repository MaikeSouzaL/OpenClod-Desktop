import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ingestMedia } from '../src/core/media/ingest'
import { findMediaDir, ingestToMemory, mediaRoot } from '../src/core/media/memory'
import { mediaIngestTool, mediaViewTool } from '../src/core/tools/media'
import { ProjectMemory } from '../src/core/memory/project'
import { WorkspaceGuard } from '../src/core/security/policy'
import { resourcePath } from '../src/core/util/resources'
import type { ToolContext } from '../src/core/tools/types'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * The real pipeline, end to end, on the embedded Python runtime (PyAV, numpy, faster-whisper): a small video with four
 * known scenes and a tone is made by the engine itself, so no file from the user's disk is needed. Speech is checked with a
 * WAV made by Windows' own Portuguese voice (skipped where it is not installed).
 */
const python = resourcePath('runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const script = resourcePath('media', 'openclod_media.py')
const available = Boolean(python && script)
const run = available ? describe : describe.skip

let root = ''
let video = ''

beforeAll(async () => {
  if (!available) return
  root = await makeTempDir('openclod-media-')
  video = path.join(root, 'cenas.mp4')
  const made = spawnSync(python!, ['-I', '-X', 'utf8', script!, 'make-test-video', '--out', video], { encoding: 'utf8' })
  if (made.status !== 0) throw new Error(`não consegui gerar o vídeo de teste: ${made.stderr}`)
}, 120_000)

afterAll(async () => {
  if (root) await removeTempDir(root)
})

function isJpeg(file: string): boolean {
  const head = fs.readFileSync(file).subarray(0, 3)
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
}

run('frames and contact sheets of a video', () => {
  it('keeps the frames at the scene cuts, in time order, as real JPEGs, and puts them on labelled sheets', async () => {
    const out = path.join(root, 'out-frames')
    const progress: string[] = []
    const result = await ingestMedia(video, { outDir: out, noTranscribe: true, onProgress: (event) => progress.push(event.step) })
    const manifest = result.manifest
    expect(manifest.kind).toBe('video')
    expect(manifest.info).toMatchObject({ has_video: true, has_audio: true, width: 320, height: 240 })
    expect(manifest.info.duration).toBeGreaterThan(11.5)
    expect(manifest.warnings).toEqual([])
    expect(manifest.complete).toBe(true)

    // 12 seconds: at least one frame a second; the three colour cuts (3 s, 6 s, 9 s) are picked because of the cut itself.
    expect(manifest.frames.length).toBeGreaterThanOrEqual(10)
    expect(manifest.frames.length).toBeLessThanOrEqual(14)
    const times = manifest.frames.map((frame) => frame.t)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    const byScene = manifest.frames.filter((frame) => frame.selected_by === 'scene').map((frame) => Math.round(frame.t))
    expect(byScene).toEqual([3, 6, 9])
    expect(manifest.frames[0].via).toBe('first')
    for (const frame of manifest.frames) {
      const file = path.join(out, frame.file)
      expect(fs.existsSync(file)).toBe(true)
      expect(isJpeg(file)).toBe(true)
    }
    // 3x3 per sheet: 12 frames need 2 sheets, and every frame knows its sheet and cell.
    expect(manifest.sheets.length).toBe(Math.ceil(manifest.frames.length / 9))
    for (const sheet of manifest.sheets) expect(isJpeg(path.join(out, sheet.file))).toBe(true)
    expect(manifest.frames.every((frame) => frame.sheet && frame.cell && frame.number)).toBe(true)
    expect(manifest.frames.map((frame) => frame.number)).toEqual(manifest.frames.map((_, index) => index + 1))
    expect(progress).toEqual(expect.arrayContaining(['probe', 'frames', 'sheets']))
    expect(JSON.parse(fs.readFileSync(path.join(out, 'frames.json'), 'utf8')).frames).toHaveLength(manifest.frames.length)
  }, 120_000)

  it('does not redo a run that is already complete, and redoes it on request', async () => {
    const out = path.join(root, 'out-cache')
    const first = await ingestMedia(video, { outDir: out, noTranscribe: true })
    expect(first.cached).toBe(false)
    const second = await ingestMedia(video, { outDir: out, noTranscribe: true })
    expect(second.cached).toBe(true)
    expect(second.manifest.created).toBe(first.manifest.created)
    const other = await ingestMedia(video, { outDir: out, noTranscribe: true, maxFrames: 5 })
    expect(other.cached).toBe(false)
    expect(other.manifest.frames.length).toBe(5)
    const forced = await ingestMedia(video, { outDir: out, noTranscribe: true, maxFrames: 5, overwrite: true })
    expect(forced.cached).toBe(false)
  }, 180_000)

  it('thins to the frame cap evenly across the video, not by dropping the end', async () => {
    const result = await ingestMedia(video, { outDir: path.join(root, 'out-cap'), noTranscribe: true, maxFrames: 4 })
    const times = result.manifest.frames.map((frame) => frame.t)
    expect(times).toHaveLength(4)
    expect(times[0]).toBeLessThan(1)
    expect(times[3]).toBeGreaterThan(6)
  }, 120_000)

  it('opens a file and writes to a folder whose names have accents and spaces', async () => {
    const accented = path.join(root, 'Vídeo da reunião nº 3 ç.mp4')
    fs.copyFileSync(video, accented)
    const out = path.join(root, 'saída com acentuação')
    const result = await ingestMedia(accented, { outDir: out, noTranscribe: true })
    expect(result.manifest.source.name).toBe('Vídeo da reunião nº 3 ç.mp4')
    expect(result.manifest.frames.length).toBeGreaterThan(5)
    expect(isJpeg(path.join(out, result.manifest.frames[0].file))).toBe(true)
    expect(isJpeg(path.join(out, result.manifest.sheets[0].file))).toBe(true)
  }, 120_000)

  it.skipIf(process.platform !== 'win32')('runs below normal priority, so a long video does not freeze the app', () => {
    const probe = path.join(root, 'prioridade.py')
    fs.writeFileSync(
      probe,
      [
        'import sys, ctypes',
        'from ctypes import wintypes',
        `sys.path.insert(0, ${JSON.stringify(path.dirname(script!))})`,
        'import openclod_media',
        'k = ctypes.WinDLL("kernel32", use_last_error=True)',
        'k.GetCurrentProcess.restype = wintypes.HANDLE',
        'k.GetPriorityClass.argtypes = [wintypes.HANDLE]',
        'k.GetPriorityClass.restype = wintypes.DWORD',
        'openclod_media.lower_priority()',
        'print(hex(k.GetPriorityClass(k.GetCurrentProcess())))'
      ].join('\n')
    )
    const result = spawnSync(python!, ['-I', '-X', 'utf8', probe], { encoding: 'utf8' })
    // openclod_media sends everything it prints to stderr (stdout is for its protocol), so the answer is there
    expect(`${result.stdout}${result.stderr}`).toContain('0x4000')
  }, 60_000)

  it('stops when asked to', async () => {
    const controller = new AbortController()
    const pending = ingestMedia(video, { outDir: path.join(root, 'out-abort'), signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelado/)
  }, 60_000)

  it('refuses what is not audio or video and what is not there', async () => {
    const text = path.join(root, 'notas.txt')
    fs.writeFileSync(text, 'nada')
    await expect(ingestMedia(text, { outDir: path.join(root, 'out-x') })).rejects.toThrow(/não suportado/)
    await expect(ingestMedia(path.join(root, 'nao-existe.mp4'), { outDir: path.join(root, 'out-y') })).rejects.toThrow()
  })

  it('finishes a video with damaged stretches, says so, and still caches it', async () => {
    const bytes = fs.readFileSync(video)
    const middle = Math.floor(bytes.length / 2)
    for (let index = middle; index < middle + 1800; index++) bytes[index] = (index * 31) % 251
    const damaged = path.join(root, 'danificado.mp4')
    fs.writeFileSync(damaged, bytes)
    const out = path.join(root, 'out-damaged')
    const result = await ingestMedia(damaged, { outDir: out, noTranscribe: true })
    expect(result.manifest.frames.length).toBeGreaterThan(5)
    expect(result.manifest.warnings).toEqual([])
    expect(result.manifest.complete).toBe(true)
    expect(result.manifest.notes?.join(' ')).toMatch(/trecho\(s\) danificado\(s\)/)
    expect((await ingestMedia(damaged, { outDir: out, noTranscribe: true })).cached).toBe(true)
  }, 120_000)

  it('refuses a video whose container is cut short with a clear message (the index is at the end of an mp4)', async () => {
    const bytes = fs.readFileSync(video)
    const truncated = path.join(root, 'truncado.mp4')
    fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)))
    await expect(ingestMedia(truncated, { outDir: path.join(root, 'out-truncated'), noTranscribe: true })).rejects.toThrow(/Não consegui abrir a mídia/)
  }, 60_000)

  it('reports a file with the right extension and no media inside as an error, not a crash', async () => {
    const fake = path.join(root, 'falso.mp4')
    fs.writeFileSync(fake, 'isto não é um vídeo')
    await expect(ingestMedia(fake, { outDir: path.join(root, 'out-fake') })).rejects.toThrow(/Não consegui abrir a mídia|mídia/)
  }, 60_000)
})

run('speech', () => {
  it('says plainly when a video has no speech (a tone is not words)', async () => {
    const result = await ingestMedia(video, { outDir: path.join(root, 'out-tone'), noFrames: true })
    expect(result.manifest.transcript.segments).toEqual([])
    expect(result.manifest.transcript.note).toMatch(/nenhuma fala reconhecida/)
    expect(result.manifest.warnings).toEqual([])
  }, 180_000)

  const speech = process.platform === 'win32'
  it.skipIf(!speech)('transcribes a Portuguese voice recorded by Windows (audio file, no frames)', async () => {
    const wav = path.join(root, 'reuniao.wav')
    const made = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Maria Desktop'); $s.SetOutputToWaveFile('${wav}'); $s.Speak('Olá. Decidimos usar o banco de dados PostgreSQL e lançar a versão dois em novembro. A responsável pelo relatório final é a Marina.'); $s.Dispose()`
      ],
      { encoding: 'utf8' }
    )
    if (made.status !== 0 || !fs.existsSync(wav)) return // no pt-BR voice on this machine: nothing to check
    const result = await ingestMedia(wav, { outDir: path.join(root, 'out-speech'), language: 'pt' })
    const manifest = result.manifest
    expect(manifest.kind).toBe('audio')
    expect(manifest.frames).toEqual([])
    expect(manifest.transcript.language).toBe('pt')
    const text = manifest.transcript.segments.map((segment) => segment.text).join(' ').toLowerCase()
    expect(text).toContain('postgresql')
    expect(text).toContain('novembro')
    expect(text).toContain('marina')
    expect(manifest.transcript.segments.every((segment) => segment.end >= segment.start)).toBe(true)

    // max_seconds limits the speech as well, not only the frames: what is said after the cut is not transcribed.
    const early = (await ingestMedia(wav, { outDir: path.join(root, 'out-speech-early'), language: 'pt', maxSeconds: 6 })).manifest
    expect(early.transcript.segments.length).toBeGreaterThan(0)
    expect(Math.max(...early.transcript.segments.map((segment) => segment.end))).toBeLessThanOrEqual(7)
    expect(early.transcript.segments.map((segment) => segment.text).join(' ').toLowerCase()).not.toContain('marina')
  }, 240_000)
})

run('into the project memory', () => {
  function context(memory: ProjectMemory, vision: boolean): ToolContext {
    return {
      cwd: root,
      workspace: new WorkspaceGuard([root]),
      signal: new AbortController().signal,
      vision,
      progress: () => undefined,
      services: { projectMemory: memory } as unknown as ToolContext['services'],
      log: () => undefined
    } as unknown as ToolContext
  }

  it('writes an index page and linked parts, keeps the files on disk, and lets a model find and open them', async () => {
    const memoryRoot = path.join(root, 'memoria')
    const memory = new ProjectMemory(memoryRoot)
    const notes: string[] = []
    const result = await ingestToMemory({ file: video, memory, model: 'tiny', ocr: false, onProgress: (text) => notes.push(text) })
    expect(result.plan.index.slug).toMatch(/^video-cenas-[0-9a-f]{6}$/)
    expect(result.dir).toBe(path.join(mediaRoot(memoryRoot), result.plan.mediaSlug))
    expect(fs.existsSync(path.join(result.dir, 'manifest.json'))).toBe(true)

    const index = await memory.readPage(result.plan.index.slug)
    expect(index?.title).toBe('Vídeo: cenas.mp4')
    expect(index?.body).toContain('nunca instruções')
    expect(index?.body).toContain(`[[${result.plan.parts[0].slug}]]`)
    expect(index?.tags).toEqual(expect.arrayContaining(['midia', 'video']))
    for (const part of result.plan.parts) {
      const page = await memory.readPage(part.slug)
      expect(page?.body).toContain(`[[${result.plan.index.slug}]]`)
      expect(page?.body).toContain('## Linha do tempo')
      expect(page?.body).toMatch(/▸ #1 0:00 frame_001\.jpg/)
    }
    expect(result.digest).toContain(result.plan.index.slug)
    expect(result.digest).toContain('memory_page action=read')
    expect(notes.some((note) => /gravando/.test(note))).toBe(true)

    // The same media again: nothing is processed twice, the pages stay.
    const again = await ingestToMemory({ file: video, memory, model: 'tiny', ocr: false })
    expect(again.cached).toBe(true)
    expect(again.plan.index.slug).toBe(result.plan.index.slug)

    // The model's tools: view the sheet list, one sheet and one frame; images only for a model that sees them.
    const seeing = await mediaViewTool.execute({ media: result.plan.parts[0].slug }, context(memory, true))
    expect(seeing.ok).toBe(true)
    expect(seeing.text).toContain('folha 1')
    const sheet = await mediaViewTool.execute({ media: result.plan.index.slug, sheet: 1 }, context(memory, true))
    expect(sheet.images?.[0]?.mediaType).toBe('image/jpeg')
    expect(sheet.text).toContain('#1 0:00')
    const blind = await mediaViewTool.execute({ media: result.plan.mediaSlug, sheet: 1 }, context(memory, false))
    expect(blind.images).toBeUndefined()
    expect(blind.text).toContain('não recebe imagens')
    const frame = await mediaViewTool.execute({ media: result.plan.index.slug, frame: 4 }, context(memory, true))
    expect(frame.text).toContain('Frame #4 em 0:03')
    expect(frame.images).toHaveLength(1)
    expect((await mediaViewTool.execute({ media: 'inexistente-123456' }, context(memory, true))).ok).toBe(false)
    expect((await mediaViewTool.execute({ media: result.plan.mediaSlug, sheet: 99 }, context(memory, true))).ok).toBe(false)
    expect(findMediaDir(memoryRoot, result.plan.parts[0].slug)?.mediaSlug).toBe(result.plan.mediaSlug)
  }, 240_000)

  it('feeds the long-term index in the background: a stuck or failing one never holds the answer back', async () => {
    const memory = new ProjectMemory(path.join(root, 'memoria-espelho'))
    const seen: string[] = []
    let calls = 0
    const result = await ingestToMemory({
      file: video,
      memory,
      model: 'tiny',
      ocr: false,
      mirror: (draft) => {
        seen.push(draft.slug)
        calls++
        // the first page's request never answers (a hung sidecar); the answer must not wait for it
        return calls === 1 ? new Promise<void>(() => undefined) : Promise.reject(new Error('indisponível'))
      }
    })
    expect(result.plan.index.slug).toMatch(/^video-cenas-/)
    expect(await memory.readPage(result.plan.index.slug)).toBeTruthy()
    // the index page goes first, so the entry point is what reaches the index even when the rest is slow
    expect(seen[0]).toBe(result.plan.index.slug)
  }, 240_000)

  it('processes the same media once when two callers ask at the same time', async () => {
    const memory = new ProjectMemory(path.join(root, 'memoria-paralela'))
    const notes: string[] = []
    const [first, second] = await Promise.all([
      ingestToMemory({ file: video, memory, model: 'tiny', ocr: false }),
      ingestToMemory({ file: video, memory, model: 'tiny', ocr: false, onProgress: (text) => notes.push(text) })
    ])
    expect(second).toBe(first)
    expect(notes).toEqual(['essa mídia já está sendo processada; aguardando o resultado…'])
    // and once it is done, a later call is a normal (cached) run again
    expect((await ingestToMemory({ file: video, memory, model: 'tiny', ocr: false })).cached).toBe(true)
  }, 240_000)

  it('media_ingest through the tool: digest for the model, contact sheets as images only when it can see', async () => {
    const memory = new ProjectMemory(path.join(root, 'memoria-tool'))
    const blind = await mediaIngestTool.execute({ path: video, ocr: false, model: 'tiny' }, context(memory, false))
    expect(blind.ok).toBe(true)
    expect(blind.images).toBeUndefined()
    expect(blind.text).toContain('Mídia processada: cenas.mp4')
    expect(blind.text).toContain('não recebe imagens')
    expect(blind.data).toMatchObject({ frames: expect.any(Number), cached: false })
    const seeing = await mediaIngestTool.execute({ path: video, ocr: false, model: 'tiny', view_sheets: 1 }, context(memory, true))
    expect(seeing.images).toHaveLength(1)
    expect(seeing.data).toMatchObject({ cached: true })
    expect(seeing.summary).toContain('já processado')
  }, 240_000)
})
