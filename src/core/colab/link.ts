import { isTunnelDownResponse, TUNNEL_DOWN_MESSAGE } from '../providers/tunnel.js'

/**
 * Health of the link to the Colab server: one cheap, authenticated `GET /v1/models`. The answer tells apart the four things
 * the user can act on: working, the server is gone (session ended / tunnel down), the key is not accepted (the notebook was
 * restarted and made another one) and "the server is up but something is wrong with it".
 */

export type ColabLinkState = 'conectado' | 'caiu' | 'chave' | 'erro'

export interface ColabModelDocument {
  id: string
  contextWindow?: number
  vision?: boolean
  tools?: boolean
  gpu?: string
  notebook?: string
}

export interface ColabLinkCheck {
  state: ColabLinkState
  status?: number
  detail: string
  ms: number
  /** What the server said about its model (only when it answered with a valid document). */
  document?: ColabModelDocument
}

export interface ColabLinkOptions {
  /** `https://<host>/v1` */
  baseUrl: string
  apiKey: string
  /** The model the provider is set to; the server must be serving it. */
  model?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** The first model of a `/v1/models` answer, with what Openclod needs from it. */
export function readModelDocument(body: unknown): ColabModelDocument | null {
  const list = record(body)?.data
  const first = Array.isArray(list) ? record(list[0]) : null
  if (!first || typeof first.id !== 'string') return null
  const context = [first.context_length, first.max_model_len].find((value) => typeof value === 'number' && value > 0)
  const inputs = strings(record(first.architecture)?.input_modalities)
  const params = strings(first.supported_parameters)
  const extra = record(first.openclod)
  return {
    id: first.id,
    contextWindow: typeof context === 'number' ? Math.floor(context) : undefined,
    vision: inputs.length ? inputs.includes('image') : undefined,
    tools: params.length ? params.includes('tools') : undefined,
    gpu: typeof extra?.gpu === 'string' ? extra.gpu : undefined,
    notebook: typeof extra?.notebook === 'string' ? extra.notebook : undefined
  }
}

function networkDetail(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'O servidor não respondeu a tempo.'
  const code = String((err as { cause?: { code?: unknown } })?.cause?.code ?? '')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'O endereço do túnel não existe mais (o nome expirou).'
  if (code === 'ECONNREFUSED') return 'Nada está escutando nesse endereço.'
  return 'Não consegui falar com o servidor.'
}

export async function checkColabLink(options: ColabLinkOptions): Promise<ColabLinkCheck> {
  const started = Date.now()
  const done = (check: Omit<ColabLinkCheck, 'ms'>): ColabLinkCheck => ({ ...check, ms: Date.now() - started })
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 8000)
  try {
    const response = await (options.fetch ?? fetch)(`${options.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json', 'user-agent': 'openclod-desktop' },
      signal: controller.signal
    })
    const text = await response.text().catch(() => '')
    const status = response.status
    if (isTunnelDownResponse(status, text)) return done({ state: 'caiu', status, detail: TUNNEL_DOWN_MESSAGE })
    if (status === 401 || status === 403) {
      return done({
        state: 'chave',
        status,
        detail: 'O servidor não aceita a chave. O notebook foi reiniciado e gerou outra: cole o código de conexão novo.'
      })
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (status === 200) {
      const document = json ? readModelDocument(json) : null
      if (!document) {
        // A 200 that is not the notebook's JSON (an HTML page, another service on that name).
        return done({ state: 'caiu', status, detail: 'O endereço respondeu, mas não é o servidor do notebook. Rode o notebook de novo e cole o novo código.' })
      }
      if (options.model && document.id !== options.model) {
        return done({
          state: 'erro',
          status,
          document,
          detail: `O servidor agora serve outro modelo (${document.id}). Cole o código de conexão novo para atualizar.`
        })
      }
      return done({ state: 'conectado', status, document, detail: 'Servidor respondendo.' })
    }
    const inner = record(record(json)?.error)
    const message = typeof inner?.message === 'string' ? inner.message : ''
    if (status === 503 && message) return done({ state: 'erro', status, detail: message })
    return done({ state: 'erro', status, detail: message ? `${message} (HTTP ${status})` : `O servidor respondeu HTTP ${status}.` })
  } catch (err) {
    return done({ state: 'caiu', detail: `${networkDetail(err, timedOut)} A sessão do Colab terminou ou o túnel caiu: rode o notebook de novo e cole o novo código.` })
  } finally {
    clearTimeout(timer)
  }
}
