import type { Message } from '../../shared/types.js'

/** Keeps the selected visible message and everything before it. */
export function rewindMessages(messages: Message[], messageId: string): Message[] {
  const index = messages.findIndex((message) => message.id === messageId && !message.hidden)
  if (index < 0) throw new Error('mensagem não encontrada')
  return messages.slice(0, index + 1)
}
