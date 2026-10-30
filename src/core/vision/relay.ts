import type { ImagePart, Message, Provider, ProviderConfig, ProviderErrorKind } from '../../shared/types.js'
import { errorKindOf } from '../providers/http.js'

/**
 * The vision relay: a model that cannot read images is never handed one. A model that can reads it first and writes
 * down what it sees; the text goes into the conversation in place of the picture. The description is stored with the
 * image, so each picture is described once, however many requests (and models) the conversation goes through.
 */

/** One model able to read images, as the relay can call it. */
export interface DescribeCandidate {
  provider: Provider
  config: ProviderConfig
}

const DESCRIBE_SYSTEM = [
  'Você é os olhos de um agente de programação que NÃO consegue ver imagens. Descreva a imagem para que ele trabalhe só com o seu texto.',
  'Regras:',
  '- Transcreva literalmente TODO o texto legível (títulos, botões, menus, mensagens de erro, código, números, URLs, nomes de arquivo).',
  '- Diga o que a imagem é (captura de tela de qual programa ou site, foto, gráfico, diagrama, documento) e como está organizada: regiões, posições aproximadas, ordem de leitura.',
  '- Para interfaces: janelas e abas abertas, campo em foco, controles marcados ou desativados, itens selecionados, indicadores de erro ou carregamento.',
  '- Para gráficos e tabelas: leia títulos, eixos, legendas e os valores visíveis.',
  '- Cores e formas só quando importam para a tarefa. Não invente nada que não esteja visível; se algo está ilegível, diga.',
  '- Responda apenas com a descrição, em português, sem introdução.'
].join('\n')

/** Longest description kept; a screenshot full of text is the worst case. */
const MAX_DESCRIPTION_CHARS = 6_000
/** The description is a few hundred tokens; the rest is room for a model that thinks before it answers. */
const MAX_DESCRIBE_TOKENS = 3_000
/** A local model reading a picture on a CPU can take minutes; a cloud one takes seconds. */
const DESCRIBE_TIMEOUT_MS = 150_000

export interface DescribeFailure {
  config: ProviderConfig
  kind: ProviderErrorKind
  message: string
}

export interface DescribeOptions {
  /** Tried in order; the first that answers wins. */
  candidates: DescribeCandidate[]
  image: ImagePart
  /** What the user asked, so the description stresses what matters for it. */
  question?: string
  signal?: AbortSignal
  onFailure?: (failure: DescribeFailure) => void
}

export interface Described {
  text: string
  /** `provider/model` that wrote it. */
  via: string
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const timer = setTimeout(abort, ms)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}

/** Asks one model to describe one picture. Throws on any failure so the caller can try the next model. */
async function describeWith(candidate: DescribeCandidate, image: ImagePart, question: string | undefined, signal?: AbortSignal): Promise<string> {
  const guard = withTimeout(signal, DESCRIBE_TIMEOUT_MS)
  let text = ''
  try {
    const ask = question?.trim()
      ? `Descreva esta imagem. O usuário pediu: "${question.trim().slice(0, 600)}". Dê ênfase ao que ajuda nisso, sem deixar de transcrever o texto visível.`
      : 'Descreva esta imagem.'
    const stream = candidate.provider.stream({
      system: DESCRIBE_SYSTEM,
      messages: [
        {
          id: 'vision_relay',
          role: 'user',
          ts: Date.now(),
          parts: [
            { type: 'text', text: ask },
            { type: 'image', mediaType: image.mediaType, data: image.data }
          ]
        }
      ],
      tools: [],
      maxTokens: MAX_DESCRIBE_TOKENS,
      // Describing is not a puzzle: models that think are asked to think little, or not at all where the server allows it
      // (the rest ignore both).
      effort: 'low',
      thinking: false,
      signal: guard.signal
    })
    for await (const event of stream) {
      if (event.type === 'text_delta') text += event.text
      else if (event.type === 'end' && event.stopReason === 'error') throw new Error(event.error ?? 'falha do provedor de visão')
    }
  } finally {
    guard.done()
  }
  const clean = text.trim()
  if (!clean) throw new Error('o modelo de visão respondeu sem texto')
  return clean.length > MAX_DESCRIPTION_CHARS ? `${clean.slice(0, MAX_DESCRIPTION_CHARS)}\n[descrição cortada]` : clean
}

/** Describes one picture with the first model that can. Returns null when none of them answered. */
export async function describeImage(options: DescribeOptions): Promise<Described | null> {
  for (const candidate of options.candidates) {
    if (options.signal?.aborted) return null
    try {
      const text = await describeWith(candidate, options.image, options.question, options.signal)
      return { text, via: `${candidate.config.label}/${candidate.config.model}` }
    } catch (err) {
      if (options.signal?.aborted) return null
      options.onFailure?.({
        config: candidate.config,
        kind: errorKindOf(err),
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return null
}

/** The text that stands in for a picture inside a message. */
export function descriptionNote(
  description: string | undefined,
  options: { label?: string; via?: string; index?: number } = {}
): string {
  const name = `${options.index ? ` ${options.index}` : ''}${options.label ? ` (${options.label})` : ''}`
  if (!description) {
    return `[imagem${name}: este modelo não lê imagens e nenhum modelo com visão pôde descrevê-la. Peça o conteúdo em texto ou use image_ocr em um arquivo de imagem.]`
  }
  return (
    `[imagem${name} — descrição feita por ${options.via ?? 'um modelo com visão'}, porque o modelo atual não lê imagens. ` +
    `Trabalhe com esta descrição; não tente capturar a tela nem abrir a imagem para vê-la:\n${description}\n]`
  )
}

/**
 * The conversation as a model that cannot read images must receive it: every picture removed, every description
 * in its place. Works on copies. Tool results whose pictures are no longer stored (the session was reloaded) still
 * carry their descriptions in `imageDescriptions`; they are written out even for a model that reads images.
 */
export function inlineImageDescriptions(messages: Message[], options: { vision: boolean }): Message[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      if (options.vision || !message.parts.some((part) => part.type === 'image')) return message
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'image'
            ? { type: 'text' as const, text: descriptionNote(part.description, { label: part.label, via: part.describedBy }) }
            : part
        )
      }
    }
    if (message.role !== 'tool') return message
    let changed = false
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool_result') return part
      const live = part.images ?? []
      const notes: string[] = []
      if (live.length && !options.vision) {
        live.forEach((image, index) => {
          notes.push(
            descriptionNote(image.description ?? part.imageDescriptions?.[index], {
              label: image.label,
              via: image.describedBy,
              index: live.length > 1 ? index + 1 : undefined
            })
          )
        })
      } else if (!live.length && part.imageDescriptions?.length) {
        part.imageDescriptions.forEach((description, index) => {
          if (description) notes.push(`[imagem ${index + 1} desta ferramenta — descrição guardada:\n${description}\n]`)
        })
      }
      if (!notes.length) return part
      changed = true
      return { ...part, images: undefined, text: `${part.text}\n${notes.join('\n')}` }
    })
    return changed ? { ...message, parts } : message
  })
}

/** Where the pictures of a history that still lack a description are. */
export interface PendingImage {
  image: ImagePart
  /** The tool result the picture belongs to (absent for a picture the user attached). */
  result?: Extract<Message['parts'][number], { type: 'tool_result' }>
  index: number
}

export function pendingImages(messages: Message[]): PendingImage[] {
  const out: PendingImage[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'image' && !part.description) out.push({ image: part, index: 0 })
      else if (part.type === 'tool_result' && part.images?.length) {
        part.images.forEach((image, index) => {
          if (!image.description) out.push({ image, result: part, index })
        })
      }
    }
  }
  return out
}

/** Writes a description onto the picture (and, for a tool result, onto the copy that outlives the picture). */
export function recordDescription(pending: PendingImage, described: Described): void {
  pending.image.description = described.text
  pending.image.describedBy = described.via
  if (pending.result) {
    const list = pending.result.imageDescriptions ?? []
    list[pending.index] = described.text
    pending.result.imageDescriptions = list
  }
}
