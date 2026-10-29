import { describe, expect, it } from 'vitest'
import { imageCaption, imageSeal } from '../src/renderer/src/lib/seen-images'
import type { ImagePart } from '../src/shared/types'

const image = (over: Partial<ImagePart> = {}): ImagePart => ({ type: 'image', mediaType: 'image/png', data: 'AAAA', ...over })

describe('what a picture in the chat is', () => {
  it('names the source from the tool that produced it', () => {
    expect(imageCaption('computer_click', [image()])).toBe('Tela do computador')
    expect(imageCaption('browser_navigate', [image({ label: 'página' })])).toBe('Página do navegador')
    expect(imageCaption('image_ocr', [image()], { path: 'C:\\fotos\\nota.png' })).toBe('Imagem · nota.png')
    expect(imageCaption('document_extract', [image({ label: 'página 1' })], { path: 'docs/contrato.pdf' })).toBe('Documento · contrato.pdf')
    expect(imageCaption('mcp__figma__shot', [image({ label: 'frame Login' })])).toBe('frame Login')
    expect(imageCaption('mcp__x__y', [image(), image()])).toBe('Imagens')
  })

  it('tells contact sheets and frames of a video apart, also in the hidden context message (no tool)', () => {
    expect(imageCaption('media_view', [image({ label: 'frame #3 00:12' })])).toBe('Quadro do vídeo')
    expect(imageCaption('media_ingest', [image({ label: 'folha a.jpg (00:00–00:30)' })])).toBe('Folha de contato do vídeo')
    expect(imageCaption(undefined, [image({ label: 'folha a.jpg' }), image({ label: 'folha b.jpg' })])).toBe('Folhas de contato do vídeo')
    expect(imageCaption(undefined, [image()])).toBe('Imagem')
  })
})

describe('whether the model saw it', () => {
  it('received by a model that reads images', () => {
    expect(imageSeal(image({ delivery: 'model' }), false)).toMatchObject({ tone: 'seen', text: 'O modelo recebeu esta imagem' })
  })

  it('described by another model: says who, and carries what the model read', () => {
    const seal = imageSeal(image({ delivery: 'relay', description: 'um botão azul', describedBy: 'Groq/llama-vision' }), false)
    expect(seal).toMatchObject({ tone: 'described', description: 'um botão azul' })
    expect(seal?.text).toContain('Groq/llama-vision')
  })

  it('waiting for the relay while the turn runs, NOT seen once it ended undescribed', () => {
    expect(imageSeal(image({ delivery: 'relay' }), true)?.tone).toBe('waiting')
    expect(imageSeal(image({ delivery: 'relay' }), false)).toMatchObject({ tone: 'unseen' })
  })

  it('a model without vision and no relay never saw it', () => {
    expect(imageSeal(image({ delivery: 'none' }), false)).toMatchObject({ tone: 'unseen', text: expect.stringContaining('NÃO viu') })
  })

  it('a preview is shown to the user only: the model read the extracted text', () => {
    expect(imageSeal(image(), false, true)).toMatchObject({ tone: 'text', text: 'O modelo recebeu o texto extraído, não a imagem' })
  })

  it('pictures stored before the seal existed get none (no claim either way)', () => {
    expect(imageSeal(image(), false)).toBeNull()
  })
})
