import type { Message, ToolCallPart, ToolResultPart } from '../../shared/types.js'

/**
 * OpenAI-compatible APIs (and Anthropic) require every assistant message with
 * `tool_calls` to be followed immediately by tool messages for every call id.
 *
 * A crash, an abort during tool execution, a steer from the user or a
 * compaction can leave a result later in the history (or missing entirely).
 * The UI keeps the original order; this function builds the provider-safe
 * sequence: assistant, one tool message with every result in call order, then
 * the rest of the conversation.
 */
export function normalizeToolCallSequence(messages: Message[]): Message[] {
  const resultByCall = new Map<string, ToolResultPart>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.parts) {
      if (part.type === 'tool_result' && !resultByCall.has(part.toolCallId)) {
        resultByCall.set(part.toolCallId, part)
      }
    }
  }

  const out: Message[] = []
  for (const message of messages) {
    // Tool messages are rebuilt under the assistant that asked for them.
    if (message.role === 'tool') continue

    if (message.role !== 'assistant') {
      out.push(message)
      continue
    }

    out.push(message)
    const calls = message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
    if (!calls.length) continue

    const parts: ToolResultPart[] = calls.map((call) => {
      const result = resultByCall.get(call.id)
      resultByCall.delete(call.id)
      return (
        result
          ? { ...result }
          : {
              type: 'tool_result',
              toolCallId: call.id,
              name: call.name,
              ok: false,
              text: 'Resultado ausente: a ferramenta não devolveu saída. O estado é desconhecido; verifique antes de repetir.'
            }
      )
    })
    out.push({
      id: `msg_tools_${message.id}`,
      role: 'tool',
      ts: message.ts,
      parts
    })
  }
  return out
}
