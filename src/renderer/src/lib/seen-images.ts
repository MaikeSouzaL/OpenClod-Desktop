import type { ImagePart } from '../../../shared/types'

/**
 * Every picture the agent looks at is shown in the chat, with a seal that says whether the model really saw it: a
 * model without vision never receives the picture, and the relay may describe it for that model instead.
 */

export type SealTone = 'seen' | 'described' | 'waiting' | 'unseen' | 'text'

export interface ImageSeal {
  tone: SealTone
  text: string
  /** What the text-only model read in place of the picture. */
  description?: string
}

function fileName(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const value = record.path ?? record.file ?? record.image ?? record.source
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.split(/[\\/]/).pop() || undefined
}

/** Caption of the card: what the picture is, from the tool that produced it (or the hidden media message). */
export function imageCaption(toolName: string | undefined, images: ImagePart[], args?: unknown): string {
  const label = images[0]?.label?.trim() ?? ''
  const name = toolName ?? ''
  if (name.startsWith('computer_')) return 'Tela do computador'
  if (name.startsWith('browser_')) return 'Página do navegador'
  if (name.startsWith('media_') || !name) {
    if (/^folha\b/i.test(label)) return images.length > 1 ? 'Folhas de contato do vídeo' : 'Folha de contato do vídeo'
    if (/^frame\b/i.test(label)) return 'Quadro do vídeo'
    if (name) return 'Mídia'
  }
  if (name.startsWith('image_')) {
    const file = fileName(args)
    return file ? `Imagem · ${file}` : 'Imagem'
  }
  if (name.startsWith('document_')) {
    const file = fileName(args)
    return file ? `Documento · ${file}` : 'Documento'
  }
  return label || (images.length > 1 ? 'Imagens' : 'Imagem')
}

/**
 * Whether the model saw the picture. `busy`: the turn is still running, so a picture waiting for the relay may still
 * be described before the next request. `preview`: a picture shown to the user only (ToolResult.preview), whose
 * text the tool extracted for the model. Pictures stored before `delivery` existed get no seal.
 */
export function imageSeal(image: ImagePart, busy: boolean, preview = false): ImageSeal | null {
  if (preview) return { tone: 'text', text: 'O modelo recebeu o texto extraído, não a imagem' }
  if (image.delivery === 'model') return { tone: 'seen', text: 'O modelo recebeu esta imagem' }
  if (image.description) {
    return {
      tone: 'described',
      text: `Descrita por ${image.describedBy ?? 'um modelo com visão'}; o modelo leu a descrição`,
      description: image.description
    }
  }
  if (image.delivery === 'none') return { tone: 'unseen', text: 'O modelo NÃO viu esta imagem (sem visão)' }
  if (image.delivery === 'relay') {
    return busy
      ? { tone: 'waiting', text: 'Aguardando descrição por um modelo com visão…' }
      : { tone: 'unseen', text: 'Não foi descrita; o modelo não viu esta imagem' }
  }
  return null
}
