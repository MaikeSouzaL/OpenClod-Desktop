import type {
  Message,
  ModelRequest,
  Provider,
  ProviderEvent,
  ProviderConfig,
  ToolCall
} from '../../shared/types.js'
import { classifyProviderError, isRetryableKind, postStream, readSse } from './http.js'
import { normalizeToolCallSequence } from './messages.js'
import { resolveCompat } from './compat.js'
import { isDeepSeekV4Model, openaiReasoningEffort } from './reasoning.js'
import { estimateTokens } from '../util/ids.js'
import { modelSeesImages } from './order.js'

/**
 * Silêncio tolerado entre pedaços do stream antes de abandonar o pedido. 10 min era alto demais: um túnel do Colab
 * que cai no meio ficava "aberto" por 10 min, indistinguível de um modelo lento. 3 min dão folga para o prefill de
 * contextos grandes em GPU lenta, mas um stream morto dá erro bem mais rápido.
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000

type OpenAIContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
    >

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: OpenAIContent | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  reasoning_content?: string
}

/**
 * Converts our internal messages to the OpenAI chat format. With
 * `echoReasoning`, reasoning of assistant messages after the last real user
 * turn (the current tool loop) is sent back as `reasoning_content`.
 */
export function toOpenAIMessages(
  system: string,
  messages: Message[],
  echoReasoning = false,
  echoAllReasoning = false,
  /** Whether the model accepts images; only then do tool-result images (screenshots) go out. */
  vision = false
): OpenAIMessage[] {
  const normalized = normalizeToolCallSequence(messages)
  const out: OpenAIMessage[] = []
  if (system.trim()) out.push({ role: 'system', content: system })
  let lastUser = -1
  normalized.forEach((m, i) => {
    if (m.role === 'user' && !m.hidden) lastUser = i
  })

  for (const [index, message] of normalized.entries()) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      const images = message.parts.filter((p) => p.type === 'image')
      const text = message.parts
        .map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? (p.label ? `[imagem: ${p.label}]` : '[imagem]') : ''))
        .join('\n')
        .trim()
      if (images.length === 0) {
        if (text) out.push({ role: 'user', content: text })
      } else {
        const content: OpenAIContent = []
        if (text) content.push({ type: 'text', text })
        for (const img of images) {
          if (img.type !== 'image') continue
          content.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'auto' }
          })
        }
        out.push({ role: 'user', content })
      }
      continue
    }

    if (message.role === 'assistant') {
      const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      const calls = message.parts.filter((p) => p.type === 'tool_call')
      // OpenAI-compatible APIs reject an assistant message with content null and
      // no tool_call (DeepSeek: "invalid message content type"). Empty turns
      // happen when a model returns no text/calls; drop them from the replay.
      if (!text.trim() && !calls.length) continue
      const msg: OpenAIMessage = { role: 'assistant', content: text || null }
      if (echoReasoning) {
        const reasoning = message.parts.map((p) => (p.type === 'reasoning' ? p.text : '')).join('')
        // DeepSeek V4 requires reasoning_content on every previous assistant
        // turn when the request carries tools, even when it is empty. Other
        // thinking providers only need the current tool loop.
        if (echoAllReasoning) msg.reasoning_content = reasoning
        else if (index > lastUser && reasoning) msg.reasoning_content = reasoning
      }
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.type === 'tool_call' ? c.id : '',
          type: 'function' as const,
          function: {
            name: c.type === 'tool_call' ? c.name : '',
            arguments: JSON.stringify(c.type === 'tool_call' ? c.args ?? {} : {})
          }
        }))
      }
      out.push(msg)
      continue
    }

    // role === 'tool'
    const toolImages: Array<{ tool: string; mediaType: string; data: string }> = []
    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue
      out.push({
        role: 'tool',
        tool_call_id: part.toolCallId,
        content: part.ok ? (part.text || '(sem saída)') : `ERRO: ${part.text || 'falhou'}`
      })
      if (vision) for (const image of part.images ?? []) toolImages.push({ tool: part.name, mediaType: image.mediaType, data: image.data })
    }
    // Chat Completions tool messages are text-only, so the pictures a tool returned
    // (Computer Use / browser screenshots) follow as one user message after ALL of
    // the tool messages, which must stay contiguous right after the assistant's calls.
    if (toolImages.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: `[imagens retornadas pelas ferramentas acima: ${[...new Set(toolImages.map((image) => image.tool))].join(', ')}]` },
          ...toolImages.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: 'auto' as const }
          }))
        ] satisfies Exclude<OpenAIContent, string>
      })
    }
  }

  return out
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string
  readonly label: string
  readonly supportsVision: boolean
  readonly contextWindow: number
  /** Stable for this provider instance; OpenCode Go uses it for routing/cache. */
  private readonly opencodeSession = `openclod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  constructor(
    private readonly config: ProviderConfig,
    private readonly secret?: string
  ) {
    this.id = config.id
    this.label = config.label
    // Per model when the server told which ones read images, the provider flag otherwise.
    this.supportsVision = modelSeesImages(config)
    this.contextWindow = config.contextWindow
  }

  countTokens(text: string): number {
    return estimateTokens(text)
  }

  async *stream(req: ModelRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const ref = this.config.apiKeyRef ?? ''
    const apiKey = this.secret ?? (ref.startsWith('env:') ? (process.env[ref.slice(4)] ?? '') : ref)
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey || 'local'}`,
      ...(this.config.baseUrl.includes('openrouter.ai')
        ? { 'http-referer': 'https://forja.local', 'x-title': 'Openclod' }
        : {}),
      ...(this.config.baseUrl.includes('/inference/go/')
        ? { 'x-opencode-session': this.opencodeSession }
        : {})
    }

    const compat = resolveCompat(this.config)
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toOpenAIMessages(
        req.system,
        req.messages,
        compat.echoReasoning,
        compat.echoReasoning && isDeepSeekV4Model(this.config.model),
        this.supportsVision
      ),
      stream: true,
      stream_options: { include_usage: true }
    }
    const temperature = req.temperature ?? this.config.temperature
    if (!compat.omitTemperature && temperature !== undefined) body.temperature = temperature
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
      body.tool_choice = req.toolChoice ?? 'auto'
    }
    const maxTokens = req.maxTokens ?? this.config.maxOutputTokens
    if (maxTokens) body[compat.maxTokensField] = maxTokens
    if (req.effort && compat.reasoningEffort) {
      body.reasoning_effort = openaiReasoningEffort(req.effort, this.config.model)
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const response = await postStream({ url, headers, body, signal: req.signal, fastFail: req.fastFail })

    if (!response.body) {
      yield { type: 'end', stopReason: 'error', toolCalls: [], error: 'resposta sem corpo', errorKind: 'server', retryable: true }
      return
    }

    const pending = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop'
    let sawUsage = false
    let textChars = 0

    for await (const frame of readSse(response.body, STREAM_IDLE_TIMEOUT_MS)) {
      if (frame.data === '[DONE]') break
      let chunk: any
      try {
        chunk = JSON.parse(frame.data)
      } catch {
        continue
      }
      if (chunk.error) {
        const error = chunk.error.message ?? JSON.stringify(chunk.error)
        const kind = classifyProviderError(Number(chunk.error.code) || undefined, `${error} ${chunk.error.type ?? ''}`)
        yield {
          type: 'end',
          stopReason: 'error',
          toolCalls: [],
          error,
          errorKind: kind,
          retryable: isRetryableKind(kind)
        }
        return
      }

      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'reasoning_delta', text: reasoning }
        }
        if (typeof delta.content === 'string' && delta.content) {
          textChars += delta.content.length
          yield { type: 'text_delta', text: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === 'number' ? tc.index : 0
            const entry = pending.get(index) ?? { id: '', name: '', args: '' }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name = tc.function.name
            if (typeof tc.function?.arguments === 'string') entry.args += tc.function.arguments
            if (!pending.has(index) && entry.name) {
              yield { type: 'tool_call_start', id: entry.id || `call_${index}`, name: entry.name }
            }
            pending.set(index, entry)
          }
        }
      }

      if (choice?.finish_reason) {
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') stopReason = 'tool_use'
        else if (choice.finish_reason === 'length') stopReason = 'length'
        else stopReason = 'stop'
      }

      if (chunk.usage) {
        sawUsage = true
        yield {
          type: 'usage',
          usage: {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            // OpenAI-style details; DeepSeek reports cache hits at the top level.
            cachedInput:
              chunk.usage.prompt_tokens_details?.cached_tokens ??
              (chunk.usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.name)
      .map(([index, v]) => ({
        id: v.id || `call_${index}`,
        name: v.name,
        args: parseArgs(v.args)
      }))

    if (!sawUsage) {
      const inputChars = JSON.stringify(req.messages).length + req.system.length
      yield {
        type: 'usage',
        usage: { input: Math.ceil(inputChars / 3.4), output: Math.ceil(textChars / 3.4) }
      }
    }

    if (stopReason === 'stop' && toolCalls.length) stopReason = 'tool_use'
    yield { type: 'end', stopReason, toolCalls }
  }
}

export function parseArgs(raw: string): unknown {
  if (!raw || !raw.trim()) return {}
  const attempts = [
    raw,
    // Local models often wrap arguments in a markdown fence or leave text around them.
    raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''),
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  ]
  for (const candidate of attempts) {
    if (!candidate.trim()) continue
    for (const text of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(text)
        // Some models double-encode: "{\"path\":\"a\"}"
        if (typeof parsed === 'string' && parsed.trim().startsWith('{')) return JSON.parse(parsed)
        return parsed
      } catch {
        /* next */
      }
    }
  }
  return { __raw: raw }
}
