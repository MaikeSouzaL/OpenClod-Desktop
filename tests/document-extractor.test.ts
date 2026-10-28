import fs from 'node:fs'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chunkDocument, extractDocument, looksLikeText, searchDocumentChunks } from '../src/core/documents/extractor'
import { makeTempDir, removeTempDir } from './helpers'

describe('document extractor', () => {
  let root: string
  beforeEach(async () => { root = await makeTempDir('openclod-docs-') })
  afterEach(async () => removeTempDir(root))

  it('extracts DOCX paragraphs and tables', async () => {
    const target = path.join(root, 'brief.docx')
    fs.writeFileSync(target, Buffer.from(zipSync({
      'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Arquitetura</w:t></w:r></w:p><w:p><w:r><w:t>Teste real &amp; validado</w:t></w:r></w:p></w:body></w:document>')
    })))
    const result = await extractDocument(target)
    expect(result.format).toBe('docx')
    expect(result.text).toContain('Arquitetura')
    expect(result.text).toContain('Teste real & validado')
    expect(result.chunks[0]).toMatchObject({ source: target, page: 1 })
  })

  it('extracts PPTX slides and XLSX sheets in source order', async () => {
    const pptx = path.join(root, 'deck.pptx')
    fs.writeFileSync(pptx, Buffer.from(zipSync({
      'ppt/slides/slide2.xml': strToU8('<p:sld><a:p><a:r><a:t>Segundo</a:t></a:r></a:p></p:sld>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>Primeiro</a:t></a:r></a:p></p:sld>')
    })))
    const deck = await extractDocument(pptx)
    expect(deck.pages.map((page) => page.text)).toEqual(['Primeiro', 'Segundo'])

    const xlsx = path.join(root, 'data.xlsx')
    fs.writeFileSync(xlsx, Buffer.from(zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Nome</t></si><si><t>Ana</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>')
    })))
    const sheet = await extractDocument(xlsx)
    expect(sheet.text).toContain('A2: Ana')
    expect(sheet.text).toContain('B2: 42')
  })

  it('extracts text from a simple PDF and warns when no text exists', async () => {
    const pdf = path.join(root, 'sample.pdf')
    const content = 'BT /F1 12 Tf (Relatório de testes) Tj T* (Tudo aprovado) Tj ET'
    fs.writeFileSync(pdf, Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`, 'latin1'))
    const result = await extractDocument(pdf)
    expect(result.text).toContain('Relatório de testes')
    expect(result.text).toContain('Tudo aprovado')
  })

  it('refuses a PDF whose text is glyph-id noise instead of returning it as a success', async () => {
    const pdf = path.join(root, 'fontes-embutidas.pdf')
    const noise = Array.from({ length: 200 }, (_, i) => String.fromCharCode(1 + (i * 7) % 30)).join('').replace(/[()\\]/g, '')
    const content = `BT /F1 12 Tf (${noise}) Tj ET`
    fs.writeFileSync(pdf, Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`, 'latin1'))
    await expect(extractDocument(pdf)).rejects.toThrow(/fontes embutidas/)
  })

  it('tells prose from noise', () => {
    expect(looksLikeText('O relatório de testes mostra que todos os casos passaram sem falhas e o build terminou.')).toBe(true)
    expect(looksLikeText('A1: 42 | B2: ok | total = 3,5%')).toBe(true)
    expect(looksLikeText('\u0001\u0002\u0003\u0004ÿÿ\u0010\u0011 \u0012\u0013')).toBe(false)
    expect(looksLikeText('xkqzt wvbnm qwrtp zxcvb hjklm pqrst fghjk')).toBe(false)
  })

  it('refuses a zip bomb disguised as a DOCX before inflating it', async () => {
    const bomb = path.join(root, 'bomba.docx')
    // ~100 MB of zeros compresses to a few hundred KB.
    fs.writeFileSync(bomb, Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(100 * 1024 * 1024) }, { level: 9 })))
    expect(fs.statSync(bomb).size).toBeLessThan(2 * 1024 * 1024)
    await expect(extractDocument(bomb)).rejects.toThrow(/expande para/)
  })

  it('chunks with overlap and ranks relevant chunks with citations', () => {
    const chunks = chunkDocument('doc.md', 'A memória usa índice e grafo.\n\nO navegador usa Chrome existente.\n\nOs testes validam a memória e o grafo.', { chunkSize: 80, overlap: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    const hits = searchDocumentChunks(chunks, 'grafo memória')
    expect(hits[0].text).toContain('memória')
    expect(hits[0].source).toBe('doc.md')
  })
})
