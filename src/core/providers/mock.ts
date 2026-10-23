import type { ModelRequest, Provider, ProviderErrorKind, ProviderEvent, ToolCall, Usage } from '../../shared/types.js'
import { estimateTokens, sleep } from '../util/ids.js'

export interface MockTurn {
  text?: string
  reasoning?: string
  toolCalls?: ToolCall[]
  stopReason?: 'stop' | 'tool_use' | 'length' | 'error'
  error?: string
  retryable?: boolean
  errorKind?: ProviderErrorKind
  usage?: Usage
  /** Artificial per-chunk delay, useful for streaming UI tests. */
  delayMs?: number
  /** Throw instead of streaming, to exercise retry/error paths. */
  throw?: string
}

/**
 * Deterministic provider used by automated tests and by the "Autoteste" mode.
 * It never contacts the network, so it cannot be mistaken for a real model.
 */
export class ScriptedProvider implements Provider {
  readonly id = 'mock'
  readonly label = 'Scripted (teste)'
  readonly supportsVision = true
  readonly contextWindow = 128_000
  readonly requests: ModelRequest[] = []

  constructor(
    private queue: MockTurn[],
    private readonly chunkSize = 24
  ) {}

  push(...turns: MockTurn[]): void {
    this.queue.push(...turns)
  }

  get remaining(): number {
    return this.queue.length
  }

  countTokens(text: string): number {
    return estimateTokens(text)
  }

  async *stream(req: ModelRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    this.requests.push(structuredClone(req))

    if (this.queue.length === 0) {
      yield {
        type: 'text_delta',
        text:
          'Provedor "Scripted" sem roteiro. Ele só existe para autoteste e **não é um modelo real**.\n\n' +
          'Abra Configurações → Provedores e configure OpenAI, Anthropic, DeepSeek, Kimi, Qwen, Ollama ou LM Studio.'
      }
      yield { type: 'end', stopReason: 'stop', toolCalls: [] }
      return
    }

    const turn = this.queue.shift()!

    if (turn.throw) throw new Error(turn.throw)

    if (turn.reasoning) {
      for (const piece of chunk(turn.reasoning, this.chunkSize)) {
        yield { type: 'reasoning_delta', text: piece }
        if (turn.delayMs) await sleep(turn.delayMs, req.signal)
      }
    }

    if (turn.text) {
      for (const piece of chunk(turn.text, this.chunkSize)) {
        yield { type: 'text_delta', text: piece }
        if (turn.delayMs) await sleep(turn.delayMs, req.signal)
      }
    }

    for (const call of turn.toolCalls ?? []) {
      yield { type: 'tool_call_start', id: call.id, name: call.name }
    }

    const usage: Usage = turn.usage ?? {
      input: Math.ceil((JSON.stringify(req.messages).length + req.system.length) / 3.4),
      output: Math.ceil(((turn.text ?? '').length + JSON.stringify(turn.toolCalls ?? []).length) / 3.4)
    }
    yield { type: 'usage', usage }

    if (turn.error) {
      yield {
        type: 'end',
        stopReason: 'error',
        toolCalls: [],
        error: turn.error,
        retryable: turn.retryable,
        errorKind: turn.errorKind ?? (turn.retryable ? 'server' : 'unknown')
      }
      return
    }

    const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'stop')
    yield { type: 'end', stopReason, toolCalls: turn.toolCalls ?? [] }
  }
}

function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
