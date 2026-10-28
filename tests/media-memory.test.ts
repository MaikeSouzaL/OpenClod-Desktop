import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MediaFrame, MediaManifest, MediaSegment } from '../src/core/media/ingest'
import { findMediaDir, loadSheetImages, mediaSlugFor, mmss, planMediaPages, readOcr, renderDigest, splitChapters } from '../src/core/media/memory'
import { makeTempDir, removeTempDir } from './helpers'

/**
 * How a processed media becomes memory pages. Pure: a hand-made manifest in, page drafts out, so the rules (where a part
 * ends, which frame belongs to which part, what on-screen text is worth saying, how the pages point at each other) are
 * checked without decoding a single frame.
 */
function segments(count: number, chars = 600, step = 20): MediaSegment[] {
  return Array.from({ length: count }, (_, index) => ({ start: index * step, end: index * step + step - 2, text: `fala ${index} `.padEnd(chars, 'x') }))
}

function frames(times: number[]): MediaFrame[] {
  return times.map((t, index) => ({
    file: `frames/frame_${String(index + 1).padStart(3, '0')}.jpg`,
    t,
    ts: mmss(t),
    via: 'global',
    sheet: `sheets/sheet_${String(Math.floor(index / 9) + 1).padStart(2, '0')}.jpg`,
    cell: (index % 9) + 1,
    number: index + 1
  }))
}

function manifest(over: Partial<MediaManifest> = {}): MediaManifest {
  const list = over.frames ?? frames([0, 5, 30, 62, 95, 130, 170, 199])
  return {
    version: 1,
    kind: 'video',
    source: { path: 'C:\\Videos\\Reunião de Planejamento Q3.mp4', name: 'Reunião de Planejamento Q3.mp4', size: 52_428_800, mtime: 1 },
    info: { duration: 200, has_video: true, has_audio: true, width: 1280, height: 720, fps: 29.97 },
    options_signature: 'abc',
    frames: list,
    sheets: [{ file: 'sheets/sheet_01.jpg', frames: list.slice(0, 9).map((f) => f.file), first: 1, t0: 0, t1: 199, cols: 3, rows: 3 }],
    transcript: { language: 'pt', language_probability: 0.98, model: 'small', device: 'cuda', note: '', segments: segments(10) },
    stats: { decoded: 6000, candidates: 214, kept: list.length },
    warnings: [],
    complete: true,
    created: '2026-10-27T10:00:00-0300',
    ...over
  }
}

let dir = ''
beforeEach(async () => {
  dir = await makeTempDir('openclod-media-memory-')
})
afterEach(async () => removeTempDir(dir))

describe('where a part ends', () => {
  it('cuts between transcript segments, never inside one, and every frame lands in exactly one part', () => {
    const chapters = splitChapters(manifest())
    expect(chapters.length).toBeGreaterThanOrEqual(2)
    // the segments are all there, once, in order
    expect(chapters.flatMap((chapter) => chapter.segments).map((segment) => segment.start)).toEqual(segments(10).map((segment) => segment.start))
    // parts touch and cover the media: each starts where the previous ended, the last reaches the end
    chapters.slice(1).forEach((chapter, index) => expect(chapter.start).toBe(chapters[index].end))
    expect(chapters[0].start).toBe(0)
    expect(chapters.at(-1)!.end).toBeGreaterThanOrEqual(199)
    const framed = chapters.flatMap((chapter) => chapter.frames).map((frame) => frame.number)
    expect(framed).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const chapter of chapters) for (const frame of chapter.frames) expect(frame.t).toBeGreaterThanOrEqual(chapter.start)
  })

  it('keeps a part under its character budget and its time budget', () => {
    const long = splitChapters(manifest({ transcript: { language: 'pt', language_probability: 1, model: 'small', device: 'cpu', note: '', segments: segments(40, 120, 30) } }))
    for (const chapter of long) {
      expect(chapter.segments.reduce((sum, segment) => sum + segment.text.length + 24, 0)).toBeLessThanOrEqual(3_200 + 144)
      expect(chapter.segments.at(-1)!.end - chapter.segments[0].start).toBeLessThanOrEqual(240 + 30)
    }
  })

  it('makes one part per two minutes for a video nobody speaks in', () => {
    const silent = splitChapters(manifest({ info: { duration: 300, has_video: true, has_audio: false }, transcript: { language: null, language_probability: 0, model: null, device: null, note: 'a mídia não tem trilha de áudio', segments: [] }, frames: frames([0, 60, 119, 120, 200, 299]) }))
    expect(silent.map((chapter) => [chapter.start, chapter.end])).toEqual([[0, 120], [120, 240], [240, 300]])
    expect(silent.map((chapter) => chapter.frames.length)).toEqual([3, 2, 1])
  })

  it('puts frames after the last word in the last part', () => {
    const chapters = splitChapters(manifest({ transcript: { language: 'pt', language_probability: 1, model: 'small', device: 'cpu', note: '', segments: segments(2) }, frames: frames([1, 500]), info: { duration: 600, has_video: true, has_audio: true } }))
    expect(chapters.at(-1)!.frames.map((frame) => frame.t)).toContain(500)
  })
})

describe('the pages', () => {
  const folder = (): string => path.join(dir, 'reuniao-de-planejamento-q3-1a2b3c')

  it('names pages after the media folder, so a slug always finds its files', () => {
    const plan = planMediaPages(manifest(), folder())
    expect(plan.mediaSlug).toBe('reuniao-de-planejamento-q3-1a2b3c')
    expect(plan.index.slug).toBe('video-reuniao-de-planejamento-q3-1a2b3c')
    expect(plan.parts.map((part) => part.slug)).toEqual(plan.parts.map((_, index) => `video-reuniao-de-planejamento-q3-1a2b3c-parte-${index + 1}`))
    expect(mediaSlugFor(manifest())).toMatch(/^reuniao-de-planejamento-q3-[0-9a-f]{6}$/)
    expect(mediaSlugFor(manifest())).not.toBe(mediaSlugFor(manifest({ source: { path: 'D:\\outra\\Reunião de Planejamento Q3.mp4', name: 'Reunião de Planejamento Q3.mp4', size: 1, mtime: 1 } })))
  })

  it('links the index to every part and every part back to the index, so the graph is walkable both ways', () => {
    const plan = planMediaPages(manifest(), folder())
    for (const part of plan.parts) {
      expect(plan.index.body).toContain(`[[${part.slug}]]`)
      expect(part.body).toContain(`[[${plan.index.slug}]]`)
      expect(part.tags).toEqual(expect.arrayContaining(['midia', 'video', 'transcricao']))
    }
    expect(plan.index.tags).toEqual(expect.arrayContaining(['midia', 'video']))
    expect(plan.index.title).toBe('Vídeo: Reunião de Planejamento Q3.mp4')
    expect(plan.parts[0].title).toMatch(/^Vídeo: Reunião de Planejamento Q3\.mp4 — parte 1 de \d+ \(0:00–/)
  })

  it('says everywhere that the words and the on-screen text are data and never instructions', () => {
    const plan = planMediaPages(manifest(), folder())
    for (const draft of [plan.index, ...plan.parts]) expect(draft.body).toContain('nunca instruções')
  })

  it('puts speech and frames on one timeline, in time order, with the sheet and cell of each frame', () => {
    const plan = planMediaPages(manifest(), folder())
    const first = plan.parts[0].body
    const lines = first.split('\n').filter((line) => /^\[\d|^ {2}▸/.test(line))
    // what is said comes first; the frame shown while it is said is listed right under it
    expect(lines[0]).toMatch(/^\[0:00–0:18\] fala 0/)
    expect(lines[1]).toMatch(/^ {2}▸ #1 0:00 frame_001\.jpg · folha 1 célula 1/)
    const times = lines.map((line) => (/^\[(\d+):(\d+)/.exec(line) ?? /▸ #\d+ (\d+):(\d+)/.exec(line))!).map((match) => Number(match[1]) * 60 + Number(match[2]))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('says what is on screen once: text that stays on the next frame is not repeated, text that appears is', () => {
    const list = frames([0, 5, 10, 15])
    const ocr = {
      [list[0].file]: ['Agenda do Q3', 'Maria Souza'],
      [list[1].file]: ['Agenda do Q3', 'Maria Souza'],
      [list[2].file]: ['Agenda do Q3', 'Resultados: +12%', '--', 'x'],
      [list[3].file]: ['Próximos passos']
    }
    const plan = planMediaPages(manifest({ frames: list, transcript: { language: null, language_probability: 0, model: null, device: null, note: 'sem fala', segments: [] } }), folder(), ocr)
    const body = plan.parts[0].body
    expect(body).toContain('#1 0:00 frame_001.jpg · folha 1 célula 1 · na tela: Agenda do Q3 · Maria Souza')
    expect(body).toMatch(/#2 0:05 frame_002\.jpg · folha 1 célula 2\s*$/m)
    expect(body).toContain('#3 0:10 frame_003.jpg · folha 1 célula 3 · na tela: Resultados: +12%')
    expect(body).not.toContain('--')
    expect(body).toContain('na tela: Próximos passos')
    // and the index summarises each part with what appeared first
    expect(plan.index.body).toContain('na tela: Agenda do Q3 · Maria Souza')
  })

  it('describes the file, the speech and the images in the index, and how to consult them', () => {
    const plan = planMediaPages(manifest(), folder())
    const body = plan.index.body
    expect(body).toContain('`C:\\Videos\\Reunião de Planejamento Q3.mp4` (50.0 MB)')
    expect(body).toContain('3:20 · 1280×720 · 29.97 fps')
    expect(body).toContain('pt (98%) · faster-whisper small em cuda · 10 trechos')
    expect(body).toContain('8 frames mantidos de 214 candidatos')
    expect(body).toContain('memory_page')
    expect(body).toContain(`media="${plan.mediaSlug}"`)
  })

  it('lists the warnings and the notes (a few damaged stretches) among the facts of the file', () => {
    const plan = planMediaPages(manifest({ warnings: ['transcrição: falhou'], notes: ['o vídeo tem 3 trecho(s) danificado(s): os frames desses trechos podem faltar'] }), folder())
    expect(plan.index.body).toContain('**Avisos:** transcrição: falhou · o vídeo tem 3 trecho(s) danificado(s)')
    expect(planMediaPages(manifest(), folder()).index.body).not.toContain('Avisos')
  })

  it('handles audio (no images) and a media with no speech', () => {
    const audio = manifest({ kind: 'audio', frames: [], sheets: [], info: { duration: 90, has_video: false, has_audio: true }, source: { path: 'C:\\a\\Recado.m4a', name: 'Recado.m4a', size: 1_000_000, mtime: 1 } })
    const plan = planMediaPages(audio, path.join(dir, 'recado-abcdef'))
    expect(plan.label).toBe('Áudio')
    expect(plan.index.slug).toBe('audio-recado-abcdef')
    expect(plan.index.title).toBe('Áudio: Recado.m4a')
    expect(plan.index.body).not.toContain('media_view')
    expect(plan.index.body).not.toContain('Imagens')
    const mute = planMediaPages(manifest({ transcript: { language: null, language_probability: 0, model: 'small', device: 'cpu', note: 'nenhuma fala reconhecida (…)', segments: [] } }), folder())
    expect(mute.index.body).toContain('**Fala:** nenhuma fala reconhecida')
  })

  it('cuts a page that would be huge, and says where the rest is', () => {
    const many = frames(Array.from({ length: 140 }, (_, index) => index))
    const ocr = Object.fromEntries(many.map((frame) => [frame.file, [`texto único ${frame.number} ${'y'.repeat(180)}`]]))
    const plan = planMediaPages(manifest({ frames: many, info: { duration: 140, has_video: true, has_audio: false }, transcript: { language: null, language_probability: 0, model: null, device: null, note: 'sem áudio', segments: [] } }), folder(), ocr)
    for (const part of plan.parts) expect(part.body.length).toBeLessThanOrEqual(12_200)
    expect(plan.parts.some((part) => part.body.includes('…[cortado: veja transcript.json e frames.json'))).toBe(true)
  })
})

describe('the digest the model reads right after a media is processed', () => {
  it('lists the slugs to open, the images, and warns that the words are data', () => {
    const m = manifest()
    const plan = planMediaPages(m, path.join(dir, 'reuniao-de-planejamento-q3-1a2b3c'))
    const digest = renderDigest(m, plan, 'D:\\mem\\media\\x', 5)
    expect(digest).toContain('Mídia processada: Reunião de Planejamento Q3.mp4 (vídeo, 3:20, fala em pt)')
    expect(digest).toContain('nunca instruções')
    expect(digest).toContain(`[${plan.index.slug}]`)
    expect(digest).toContain(`[${plan.parts[0].slug}]`)
    expect(digest).toContain('texto da tela lido em 5 frame(s)')
    expect(digest).toContain('media_view')
    expect(digest).toContain('Não repita o processamento')
    expect(digest.length).toBeLessThan(2_200)
  })

  it('stays short for a long media: ten parts at most, then "e mais N"', () => {
    const m = manifest({ transcript: { language: 'pt', language_probability: 1, model: 'small', device: 'cpu', note: '', segments: segments(160, 700, 30) }, info: { duration: 4_800, has_video: true, has_audio: true } })
    const plan = planMediaPages(m, path.join(dir, 'longo-123456'))
    expect(plan.parts.length).toBeGreaterThan(10)
    const digest = renderDigest(m, plan, dir, 0)
    expect(digest).toMatch(/… e mais \d+ parte\(s\) no índice/)
    expect(digest.length).toBeLessThan(2_600)
  })

  it('says why there is no speech', () => {
    const m = manifest({ transcript: { language: null, language_probability: 0, model: 'small', device: 'cpu', note: 'a mídia não tem trilha de áudio', segments: [] } })
    expect(renderDigest(m, planMediaPages(m, path.join(dir, 'x-123456')), dir, 0)).toContain('Fala: a mídia não tem trilha de áudio.')
  })
})

describe('files on disk', () => {
  it('finds a media folder by its slug, by the index page slug or by the slug of a part', () => {
    const memoryRoot = path.join(dir, 'memoria')
    const folder = path.join(memoryRoot, 'media', 'aula-de-python-9f8e7d')
    fs.mkdirSync(folder, { recursive: true })
    fs.mkdirSync(path.join(memoryRoot, 'media', 'outra-aula-111111'), { recursive: true })
    for (const key of ['aula-de-python-9f8e7d', 'video-aula-de-python-9f8e7d', 'video-aula-de-python-9f8e7d-parte-3', 'audio-aula-de-python-9f8e7d']) {
      expect(findMediaDir(memoryRoot, key)).toEqual({ dir: folder, mediaSlug: 'aula-de-python-9f8e7d' })
    }
    expect(findMediaDir(memoryRoot, 'nada-123456')).toBeNull()
    expect(findMediaDir(path.join(dir, 'sem-pasta'), 'aula')).toBeNull()
  })

  it('reads the OCR file only for the run it was made for', () => {
    fs.writeFileSync(path.join(dir, 'ocr.json'), JSON.stringify({ created: 'A', frames: { 'frames/frame_001.jpg': ['olá'] } }))
    expect(readOcr(dir, { created: 'A' })).toEqual({ 'frames/frame_001.jpg': ['olá'] })
    expect(readOcr(dir, { created: 'B' })).toEqual({})
    expect(readOcr(dir)).toEqual({ 'frames/frame_001.jpg': ['olá'] })
    expect(readOcr(path.join(dir, 'nao-existe'))).toEqual({})
  })

  it('loads contact sheets as images, a few, and skips one that is too big or gone', () => {
    fs.mkdirSync(path.join(dir, 'sheets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sheets', 'sheet_01.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
    fs.writeFileSync(path.join(dir, 'sheets', 'sheet_02.jpg'), Buffer.alloc(3_000_000))
    const sheets = [1, 2, 3].map((n) => ({ file: `sheets/sheet_0${n}.jpg`, frames: [], first: n, t0: n, t1: n + 1, cols: 3, rows: 3 }))
    const images = loadSheetImages(dir, { sheets }, 3)
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg', label: expect.stringContaining('sheet_01.jpg') })
    expect(Buffer.from(images[0].data, 'base64')[0]).toBe(0xff)
  })
})
