import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectMemory } from '../src/core/memory/project'
import {
  addMemoryFile,
  collectFiles,
  countMemoryFiles,
  describeMemoryFile,
  fileKindOf,
  fileSlugFor,
  findFilePaths,
  findMemoryFile,
  listMemoryFiles,
  memoryFileIndex,
  memoryFileThumb,
  removeMemoryFile,
  splitText
} from '../src/core/memory/files'

let root = ''
let memory: ProjectMemory

const png = async (file: string, color = '#3366ff'): Promise<string> => {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  await sharp({ create: { width: 640, height: 400, channels: 3, background: color } }).png().toFile(full)
  return full
}

const text = (file: string, body: string): string => {
  const full = path.join(root, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  return full
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-memory-files-'))
  memory = new ProjectMemory(path.join(root, 'memoria'))
  await memory.init()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('files in the project memory', () => {
  it('keeps a picture with its copy, thumbnail, description and a linked, indexed page', async () => {
    const file = await png('telas/pedido.png')
    const asked: string[] = []
    const result = await addMemoryFile(file, {
      memory,
      ocr: false,
      tags: ['Pedidos'],
      links: ['guia-visual-das-telas-de-pedido'],
      question: 'telas de pedido',
      describe: async (image, question) => {
        asked.push(`${image.mediaType} ${question}`)
        return { text: 'Tela de pedido do CRM com a coluna Data de faturamento.', via: 'Teste/visão' }
      }
    })
    expect(result.cached).toBe(false)
    expect(result.meta).toMatchObject({ kind: 'imagem', name: 'pedido.png', width: 640, height: 400, describedBy: 'Teste/visão', tags: ['pedidos'] })
    expect(asked).toEqual(['image/jpeg telas de pedido'])
    const found = findMemoryFile(memory.root, result.meta.slug)
    expect(fs.existsSync(path.join(found!.dir, 'original.png'))).toBe(true)
    expect(memoryFileThumb(memory.root, result.meta.slug)?.mediaType).toBe('image/jpeg')

    const page = await memory.readPage(result.meta.slug)
    expect(page?.title).toBe('Imagem: pedido.png')
    expect(page?.tags).toEqual(expect.arrayContaining(['arquivo', 'imagem', 'pedidos']))
    expect(page?.body).toContain('Data de faturamento')
    expect(page?.body).toContain('[[guia-visual-das-telas-de-pedido]]')
    // Found by what is in the picture, not by its name.
    const hits = await memory.search('data de faturamento', 5)
    expect(hits.map((hit) => hit.slug)).toContain(result.meta.slug)
    expect(countMemoryFiles(memory.root)).toEqual({ imagem: 1 })
  })

  it('is the same page for the same content; tags, links and a later description update it', async () => {
    const file = await png('a.png')
    const first = await addMemoryFile(file, { memory, ocr: false })
    expect(first.meta.description).toBeUndefined()
    expect((await memory.readPage(first.meta.slug))?.body).toContain('Ainda sem descrição')
    const again = await addMemoryFile(file, { memory, ocr: false })
    expect(again).toMatchObject({ cached: true })
    expect(again.line).toContain('já estava')
    const tagged = await addMemoryFile(file, { memory, ocr: false, tags: ['vault'] })
    expect(tagged.meta.tags).toEqual(['vault'])
    const described = await describeMemoryFile(memory, first.meta.slug, 'Um quadrado azul.', 'agente')
    expect(described.description).toBe('Um quadrado azul.')
    expect((await memory.readPage(first.meta.slug))?.body).toContain('Um quadrado azul.')
    expect(listMemoryFiles(memory.root)).toHaveLength(1)
  })

  it('reads the text of documents and splits a long one into linked parts', async () => {
    const long = Array.from({ length: 40 }, (_, index) => `Parágrafo ${index}: ${'conteúdo do relatório '.repeat(30)}`).join('\n\n')
    const result = await addMemoryFile(text('docs/relatorio.md', long), { memory })
    expect(result.meta).toMatchObject({ kind: 'texto' })
    expect(result.meta.parts).toBeGreaterThan(2)
    const main = await memory.readPage(result.meta.slug)
    expect(main?.body).toContain(`[[${result.meta.slug}-parte-2]]`)
    const part = await memory.readPage(`${result.meta.slug}-parte-2`)
    expect(part?.body).toContain(`[[${result.meta.slug}]]`)
    expect(await removeMemoryFile(memory, result.meta.slug)).toBe(true)
    expect(await memory.readPage(`${result.meta.slug}-parte-2`)).toBeNull()
    expect(await memory.readPage(result.meta.slug)).toBeNull()
    expect(listMemoryFiles(memory.root)).toHaveLength(0)
  })

  it('knows a WhatsApp attachment without extension by its content', async () => {
    const file = await png('whatsapp/IMG-SEM-EXTENSAO.png')
    const bare = path.join(root, 'whatsapp', 'IMG-SEM-EXTENSAO')
    fs.renameSync(file, bare)
    expect(fileKindOf(bare, fs.readFileSync(bare).subarray(0, 64))).toBe('imagem')
    const result = await addMemoryFile(bare, { memory, ocr: false })
    expect(result.meta.kind).toBe('imagem')
    expect(result.meta.stored).toBe('original.png')
  })

  it('collects a folder by kind, and counts the media the pipeline keeps too', async () => {
    await png('vault/imagens/1.png')
    await png('vault/imagens/sub/2.png', '#ff0000')
    text('vault/imagens/notas.txt', 'notas')
    expect(await collectFiles(path.join(root, 'vault'), { kinds: ['imagem'] })).toHaveLength(0)
    expect(await collectFiles(path.join(root, 'vault'), { kinds: ['imagem'], recursive: true })).toHaveLength(2)
    expect(await collectFiles(path.join(root, 'vault'), { recursive: true })).toHaveLength(3)
    const media = path.join(memory.root, 'media', 'aula-abc')
    fs.mkdirSync(media, { recursive: true })
    fs.writeFileSync(path.join(media, 'manifest.json'), JSON.stringify({ kind: 'video' }))
    await addMemoryFile(path.join(root, 'vault', 'imagens', '1.png'), { memory, ocr: false })
    expect(countMemoryFiles(memory.root)).toEqual({ imagem: 1, video: 1 })
  })

  it('tells, by kind, how many files the agent can find by their text or description, and which lost the file', async () => {
    // A picture without OCR or description: kept, but nothing of it is searchable yet.
    await addMemoryFile(await png('docs/tela.png'), { memory, ocr: false })
    const described = await addMemoryFile(await png('docs/pedido.png', '#00aa00'), { memory, ocr: false, description: 'Tela do pedido com o botão Faturar.' })
    text('docs/regras.md', '# Regras\n\nO pedido só fatura com o contrato assinado.')
    await addMemoryFile(path.join(root, 'docs', 'regras.md'), { memory })
    const transcribed = path.join(memory.root, 'media', 'reuniao-abc')
    fs.mkdirSync(transcribed, { recursive: true })
    fs.writeFileSync(path.join(transcribed, 'manifest.json'), JSON.stringify({ kind: 'audio', source: { path: path.join(root, 'sumiu.ogg'), name: 'sumiu.ogg' }, transcript: { segments: [{ start: 0, end: 1, text: 'oi' }] } }))
    const pending = path.join(memory.root, 'media', 'video-xyz')
    fs.mkdirSync(pending, { recursive: true })
    fs.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ kind: 'video', transcript: { segments: [] }, frames: [] }))
    // The copy of the described picture is gone, and so is its original: only its text is left.
    const found = findMemoryFile(memory.root, described.meta.slug)!
    fs.rmSync(path.join(found.dir, found.meta.stored!))
    fs.rmSync(path.join(root, 'docs', 'pedido.png'))

    expect(await memoryFileIndex(memory.root)).toEqual({
      imagem: { total: 2, indexed: 1, missing: 1 },
      texto: { total: 1, indexed: 1, missing: 0 },
      audio: { total: 1, indexed: 1, missing: 1 },
      video: { total: 1, indexed: 0, missing: 0 }
    })
  })

  it('keeps a pasted picture under the name and origin given (its temporary path says nothing)', async () => {
    const file = await png('tmp/imagem-1.png')
    const result = await addMemoryFile(file, {
      memory,
      ocr: false,
      name: 'imagem da conversa 2026-10-29-15-00.png',
      origin: 'colada na conversa "Telas de pedido" em 2026-10-29-15-00',
      description: 'Print da tela de pedidos.',
      describedBy: 'Relé/visão',
      links: ['turno-x', 'sessao-y']
    })
    expect(result.meta).toMatchObject({ name: 'imagem da conversa 2026-10-29-15-00.png', source: 'colada na conversa "Telas de pedido" em 2026-10-29-15-00', describedBy: 'Relé/visão' })
    const body = (await memory.readPage(result.meta.slug))?.body ?? ''
    expect(body).toContain('[[turno-x]]')
    expect(body).toContain('[[sessao-y]]')
    expect(body).toContain('Print da tela de pedidos.')
  })

  it('finds the files the user named in a message, but not audio or video', () => {
    const text = 'Guarde `C:\\urmob\\vault\\guia-telas.pdf`, "D:\\fotos\\tela 1.png" e C:\\x\\planilha.xlsx. O vídeo C:\\x\\aula.mp4 e https://a.b/c.pdf não.'
    expect(findFilePaths(text)).toEqual(['C:\\urmob\\vault\\guia-telas.pdf', 'D:\\fotos\\tela 1.png', 'C:\\x\\planilha.xlsx'])
  })

  it('names files by content and splits text at paragraphs', () => {
    expect(fileSlugFor('Guia telas de pedido.pdf', 'abcdef0123456789')).toBe('arquivo-guia-telas-de-pedido-abcdef01')
    expect(fileKindOf('C:\\x\\planilha.xlsx')).toBe('planilha')
    expect(fileKindOf('C:\\x\\audio.opus')).toBe('audio')
    expect(fileKindOf('C:\\x\\coisa.zip')).toBe('arquivo')
    const parts = splitText(`${'a'.repeat(5000)}\n\n${'b'.repeat(5000)}`, 6000)
    expect(parts).toEqual(['a'.repeat(5000), 'b'.repeat(5000)])
  })
})
