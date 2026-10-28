import type { Message, ModelRequest, Provider, ProviderEvent, ProviderConfig, ToolCall } from '../../shared/types.js'
import { ProviderHttpError, classifyProviderError, isRetryableKind, postStream, readSse } from './http.js'
import { anthropicReasoning } from './reasoning.js'
import { resolveCompat } from './compat.js'
import { STREAM_IDLE_TIMEOUT_MS } from './openai.js'
import { normalizeToolCallSequence } from './messages.js'
import { estimateTokens } from '../util/ids.js'
import { modelSeesImages } from './order.js'

type CacheControl = { cache_control?: { type: 'ephemeral' } }

type AnthropicBlock = (
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>
      is_error?: boolean
    }
) &
  CacheControl

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export interface ToAnthropicOptions {
  /** Replay the provider's raw assistant blocks (thinking + signatures). Default true. */
  replayThinking?: boolean
  /** The model accepts images: tool-result screenshots are sent as image blocks. */
  vision?: boolean
}

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * Anthropic requires strict user/assistant alternation and tool_result blocks
 * inside a user turn. Consecutive same-role messages are merged.
 *
 * Assistant turns that carry `providerBlocks` are replayed from those blocks
 * (cloned, in the original order): thinking blocks are signed over the
 * conversation prefix and must come back unchanged.
 */
export function toAnthropicMessages(messages: Message[], options: ToAnthropicOptions = {}): AnthropicMessage[] {
  const replay = options.replayThinking !== false
  const out: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const message of normalizeToolCallSequence(messages)) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      const blocks: AnthropicBlock[] = []
      for (const part of message.parts) {
        if (part.type === 'text' && part.text.trim()) blocks.push({ type: 'text', text: part.text })
        else if (part.type === 'image')
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: part.mediaType, data: part.data }
          })
      }
      push('user', blocks)
      continue
    }

    if (message.role === 'assistant') {
      if (replay && message.providerBlocks?.kind === 'anthropic' && message.providerBlocks.blocks.length) {
        const raw = (message.providerBlocks.blocks as AnthropicBlock[])
          .filter((block) => !(block.type === 'text' && !block.text.trim()))
          .map((block) => ({ ...block }))
        push('assistant', raw)
        continue
      }
      const blocks: AnthropicBlock[] = []
      for (const part of message.parts) {
        if (part.type === 'text' && part.text.trim()) blocks.push({ type: 'text', text: part.text })
        else if (part.type === 'tool_call')
          blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.args ?? {} })
      }
      push('assistant', blocks)
      continue
    }

    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue
      const text = part.ok ? part.text || '(sem saída)' : `ERRO: ${part.text || 'falhou'}`
      // tool_result accepts image blocks next to the text (screenshots from Computer Use / browser).
      const images = options.vision && part.ok ? (part.images ?? []) : []
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: images.length
            ? [
                { type: 'text', text },
                ...images.map((image) => ({
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: image.mediaType, data: image.data }
                }))
              ]
            : text,
          is_error: !part.ok
        }
      ])
    }
  }

  return out
}

export class AnthropicProvider implements Provider {
  readonly id: string
  readonly label: string
  readonly supportsVision: boolean
  readonly contextWindow: number

  constructor(
    private readonly config: ProviderConfig,
    private readonly secret?: string
  ) {
    this.id = config.id
    this.label = config.label
    this.supportsVision = modelSeesImages(config)
    this.contextWindow = config.contextWindow
  }

  countTokens(text: string): number {
    return estimateTokens(text)
  }


  /** Body for one request; `replayThinking: false` is the recovery shape after a signature 400. */
  private buildBody(req: ModelRequest, replayThinking: boolean): Record<string, unknown> {
    const compat = resolveCompat(this.config)
    const reasoning = anthropicReasoning(this.config.model, replayThinking ? req.effort : undefined, req.maxTokens ?? this.config.maxOutputTokens)
    const messages = toAnthropicMessages(req.messages, { replayThinking, vision: this.supportsVision })
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    })) as Array<Record<string, unknown>>
    const system: Array<Record<string, unknown>> = req.system.trim() ? [{ type: 'text', text: req.system }] : []

    // Up to 4 cache breakpoints: tools, system, and the conversation tail.
    // The prefix up to each breakpoint is reused across iterations of a turn.
    if (compat.promptCaching) {
      if (tools.length) tools[tools.length - 1].cache_control = { type: 'ephemeral' }
      if (system.length) system[system.length - 1].cache_control = { type: 'ephemeral' }
      const lastMessage = messages[messages.length - 1]
      const lastBlock = lastMessage?.content[lastMessage.content.length - 1]
      // cache_control is not allowed on thinking blocks.
      if (lastBlock && !THINKING_TYPES.has(lastBlock.type)) lastBlock.cache_control = { type: 'ephemeral' }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      system,
      messages,
      max_tokens: reasoning.maxTokens,
      stream: true
    }
    if (reasoning.thinking) body.thinking = reasoning.thinking
    if (reasoning.outputConfig) body.output_config = reasoning.outputConfig
    // Models that reject sampling parameters (Opus 4.7+, Fable, Sonnet/Haiku 5.x) and any request with thinking on.
    const temperature = req.temperature ?? this.config.temperature
    if (temperature !== undefined && reasoning.allowSampling) body.temperature = temperature
    if (tools.length) {
      body.tools = tools
      if (req.toolChoice === 'none') body.tool_choice = { type: 'none' }
    }
    return body
  }

  async *stream(req: ModelRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const ref = this.config.apiKeyRef ?? ''
    const apiKey = this.secret ?? (ref.startsWith('env:') ? (process.env[ref.slice(4)] ?? '') : ref)
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/messages`
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    }

    let response: Response
    try {
      response = await postStream({ url, headers, body: this.buildBody(req, true), signal: req.signal, fastFail: req.fastFail })
    } catch (err) {
      // A thinking block whose signature no longer matches the history (an edited or
      // compacted transcript, another model's block) is rejected with a 400. Documented
      // recovery: resend once without any thinking, then carry on normally.
      if (err instanceof ProviderHttpError && err.status === 400 && /thinking|signature|effort|output_config/i.test(err.message)) {
        response = await postStream({ url, headers, body: this.buildBody(req, false), signal: req.signal, fastFail: req.fastFail })
      } else {
        throw err
      }
    }

    if (!response.body) {
      yield { type: 'end', stopReason: 'error', toolCalls: [], error: 'resposta sem corpo', errorKind: 'server', retryable: true }
      return
    }

    const toolJson = new Map<number, string>()
    /** Content blocks in stream order, reassembled for faithful replay. */
    const ordered = new Map<number, Record<string, unknown>>()
    const toolCalls: ToolCall[] = []
    let stopReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop'
    let textChars = 0
    const usage = { input: 0, output: 0, cachedInput: undefined as number | undefined }

    for await (const frame of readSse(response.body, STREAM_IDLE_TIMEOUT_MS)) {
      let ev: any
      try {
        ev = JSON.parse(frame.data)
      } catch {
        continue
      }

      switch (ev.type) {
        case 'message_start':
          if (ev.message?.usage) {
            const u = ev.message.usage
            // input_tokens excludes cached reads/writes; count them all as input.
            usage.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            usage.output = u.output_tokens ?? 0
            usage.cachedInput = u.cache_read_input_tokens || undefined
          }
          break
        case 'content_block_start': {
          const block = ev.content_block
          if (block?.type === 'tool_use') {
            toolJson.set(ev.index, '')
            ordered.set(ev.index, { type: 'tool_use', id: block.id, name: block.name, input: {} })
            yield { type: 'tool_call_start', id: block.id, name: block.name }
          } else if (block?.type === 'text') {
            ordered.set(ev.index, { type: 'text', text: block.text ?? '' })
            if (block.text) {
              textChars += block.text.length
              yield { type: 'text_delta', text: block.text }
            }
          } else if (block?.type === 'thinking') {
            ordered.set(ev.index, { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' })
            if (block.thinking) yield { type: 'reasoning_delta', text: block.thinking }
          } else if (block?.type === 'redacted_thinking') {
            ordered.set(ev.index, { type: 'redacted_thinking', data: block.data ?? '' })
          } else if (block && typeof block === 'object') {
            ordered.set(ev.index, { ...block })
          }
          break
        }
        case 'content_block_delta': {
          const delta = ev.delta
          const entry = ordered.get(ev.index)
          if (delta?.type === 'text_delta' && delta.text) {
            textChars += delta.text.length
            if (entry) entry.text = `${entry.text ?? ''}${delta.text}`
            yield { type: 'text_delta', text: delta.text }
          } else if (delta?.type === 'input_json_delta') {
            if (toolJson.has(ev.index)) toolJson.set(ev.index, `${toolJson.get(ev.index)}${delta.partial_json ?? ''}`)
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            if (entry) entry.thinking = `${entry.thinking ?? ''}${delta.thinking}`
            yield { type: 'reasoning_delta', text: delta.thinking }
          } else if (delta?.type === 'signature_delta' && delta.signature) {
            if (entry) entry.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          const entry = ordered.get(ev.index)
          if (entry?.type === 'tool_use' && toolJson.has(ev.index)) {
            const json = toolJson.get(ev.index) ?? ''
            let parsed: unknown = {}
            try {
              parsed = json ? JSON.parse(json) : {}
            } catch {
              parsed = { __raw: json }
            }
            entry.input = parsed
            toolCalls.push({ id: String(entry.id), name: String(entry.name), args: parsed })
            toolJson.delete(ev.index)
          }
          break
        }
        case 'message_delta': {
          if (ev.delta?.stop_reason === 'tool_use') stopReason = 'tool_use'
          else if (ev.delta?.stop_reason === 'max_tokens') stopReason = 'length'
          if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens
          break
        }
        case 'error': {
          const error = ev.error?.message ?? 'erro do provedor'
          const kind =
            ev.error?.type === 'overloaded_error'
              ? 'overloaded'
              : ev.error?.type === 'rate_limit_error'
                ? 'rate_limit'
                : classifyProviderError(undefined, `${error} ${ev.error?.type ?? ''}`)
          yield { type: 'end', stopReason: 'error', toolCalls: [], error, errorKind: kind, retryable: isRetryableKind(kind) }
          return
        }
        default:
          break
      }
    }

    if (toolCalls.length && stopReason !== 'length') stopReason = 'tool_use'
    if (!textChars && !toolCalls.length) {
      // nothing emitted; report rather than silently "succeeding"
      yield { type: 'end', stopReason: 'error', toolCalls: [], error: 'resposta vazia do modelo' }
      return
    }
    const blocks = [...ordered.entries()].sort(([a], [b]) => a - b).map(([, block]) => block)
    // Only worth storing when it carries something the parts cannot rebuild.
    if (blocks.some((block) => THINKING_TYPES.has(String(block.type)))) {
      yield { type: 'provider_blocks', kind: 'anthropic', model: this.config.model, blocks }
    }
    yield { type: 'usage', usage }
    yield { type: 'end', stopReason, toolCalls }
  }
}
