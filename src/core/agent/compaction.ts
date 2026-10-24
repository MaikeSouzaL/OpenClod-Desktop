import type { Message, Provider } from '../../shared/types.js'
import { estimateTokens } from '../util/ids.js'

export interface CompactionResult {
  messages: Message[]
  compacted: boolean
  note?: string
}

function messageToText(message: Message, maxPerPart = 1200): string {
  const chunks: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text') chunks.push(part.text.slice(0, maxPerPart))
    else if (part.type === 'tool_call') chunks.push(`[chamou ${part.name} ${JSON.stringify(part.args).slice(0, 300)}]`)
    else if (part.type === 'tool_result')
      chunks.push(`[resultado ${part.name}${part.ok ? '' : ' ERRO'}: ${part.text.slice(0, maxPerPart)}]`)
  }
  return `${message.role.toUpperCase()}: ${chunks.join(' ')}`
}

export function estimateContextTokens(system: string, messages: Message[]): number {
  let total = estimateTokens(system)
  for (const message of messages) total += estimateTokens(messageToText(message, 1e9)) + 4
  return total
}

/**
 * Keeps the tail of the conversation and replaces the rest with a summary.
 * The cut point is moved back to a user message so a tool_call is never
 * separated from its tool_result.
 */
function findCut(messages: Message[], keep: number): number {
  let cut = Math.max(0, messages.length - keep)
  while (cut < messages.length && messages[cut].role !== 'user') cut++
  if (cut >= messages.length) cut = Math.max(0, messages.length - keep)
  // The fallback can land on a tool result with no later user turn; walk back
  // so its assistant tool_call stays in the kept tail.
  while (cut > 0 && messages[cut]?.role === 'tool') cut--
  return cut
}

/** Header of the hidden message that carries a summary; also how a later compaction recognises it. */
const SUMMARY_HEADER = '[Contexto compactado'
/** A previous summary is kept almost whole when it is summarised again (its tail holds Next Move and Relevant Files). */
const PREVIOUS_SUMMARY_CHARS = 8000

/**
 * Section names are stable English markers (the summary is read by a model,
 * not shown to the user); the content is requested in Portuguese. Template
 * shape inspired by opencode's compaction checkpoint, reworded for Openclod.
 */
export const SUMMARY_SECTIONS = [
  'Objective',
  'Requirements / Constraints',
  'Decisions',
  'Work State',
  'Next Move',
  'Relevant Files'
] as const

export const SUMMARY_SYSTEM_PROMPT = [
  'Você compacta o contexto de um agente de programação para que outro agente retome o trabalho sem perder o fio.',
  'Resuma SOMENTE o que o usuário e o agente disseram e fizeram no transcript; não invente nada. Não repita instruções de sistema nem convenções do projeto (AGENTS.md): o próximo agente as recebe à parte.',
  'Responda em português, em Markdown, exatamente neste formato, sem prefácio nem comentário final:',
  [
    '## Objective',
    '- [em uma ou duas frases, o que o usuário quer alcançar]',
    '',
    '## Requirements / Constraints',
    '- [requisitos, preferências, restrições e limites de escopo dados pelo usuário; "(nenhum)" se não houver]',
    '',
    '## Decisions',
    '- [decisões já tomadas e o porquê; "(nenhuma)" se não houver]',
    '',
    '## Work State',
    '### Done',
    '- [o que já foi concluído e verificado, com comandos executados e resultados relevantes; "(nada)" se não houver]',
    '### In progress',
    '- [o que está em andamento, pendente ou bloqueado (diga o que bloqueia); "(nada)" se não houver]',
    '',
    '## Next Move',
    '1. [próximas ações, em ordem; "(nenhuma)" se não houver]',
    '',
    '## Relevant Files',
    '- `caminho`: [por que importa] (no máximo 15, os mais importantes primeiro; "(nenhum)" se não houver)'
  ].join('\n'),
  [
    'Regras:',
    '- Mantenha as seis seções, nessa ordem, mesmo quando vazias. Use bullets curtos de uma linha, não parágrafos.',
    '- Preserve exatamente caminhos de arquivo, comandos, símbolos, URLs, identificadores e mensagens de erro.',
    '- Carregue adiante apenas pedidos do usuário que continuam sem resposta ou exigem ação, com as palavras originais.',
    '- Registre o estado que afeta o fluxo: alterações não commitadas, commitadas, enviadas ou em revisão.',
    `- Se o transcript começar com um resumo anterior ("${SUMMARY_HEADER}..."), atualize-o em vez de empilhar outro: mantenha o que continua válido, mova para Done o que foi concluído desde então, remova o que ficou obsoleto e devolva UM resumo consolidado.`,
    '- No máximo 450 palavras. Não continue a tarefa e não chame ferramentas.'
  ].join('\n')
].join('\n\n')

function isCompactionSummary(message: Message): boolean {
  if (message.role !== 'user' || !message.hidden) return false
  const first = message.parts[0]
  return first?.type === 'text' && first.text.startsWith(SUMMARY_HEADER)
}

async function summarize(
  provider: Provider,
  config: { contextWindow: number },
  transcript: string,
  signal?: AbortSignal
): Promise<string | null> {
  const request = {
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [
      {
        id: 'compact',
        role: 'user' as const,
        ts: Date.now(),
        parts: [{ type: 'text' as const, text: `Transcript a resumir:\n\n${transcript}` }]
      }
    ],
    tools: [],
    maxTokens: Math.min(1500, Math.floor(config.contextWindow * 0.05)),
    signal
  }

  let text = ''
  try {
    for await (const event of provider.stream(request)) {
      if (event.type === 'text_delta') text += event.text
      if (event.type === 'end' && event.stopReason === 'error') return null
    }
  } catch {
    return null
  }
  return text.trim() || null
}

export async function compactIfNeeded(options: {
  system: string
  messages: Message[]
  provider: Provider
  contextWindow: number
  keepRecent?: number
  signal?: AbortSignal
  /** Manual compaction ignores the budget check (the UI asks for it explicitly). */
  force?: boolean
  onNote?: (note: string) => void
}): Promise<CompactionResult> {
  const { system, messages, provider, contextWindow } = options
  const budget = contextWindow * 0.75
  const used = estimateContextTokens(system, messages)
  if (!options.force && used < budget) return { messages, compacted: false }

  const keep = options.keepRecent ?? 8
  if (messages.length <= keep + 2) return { messages, compacted: false }

  const cut = findCut(messages, keep)
  if (cut <= 0) return { messages, compacted: false }

  const older = messages.slice(0, cut)
  const transcript = older
    .map((m) => messageToText(m, isCompactionSummary(m) ? PREVIOUS_SUMMARY_CHARS : undefined))
    .join('\n\n')
    .slice(0, 60_000)
  const summary = await summarize(provider, { contextWindow }, transcript, options.signal)

  const header = summary
    ? `${SUMMARY_HEADER} automaticamente — resumo das ${older.length} mensagens anteriores]\n\n${summary}`
    : `${SUMMARY_HEADER}: ${older.length} mensagens antigas removidas por limite de janela. Arquivos e decisões devem ser reconferidos com as ferramentas.]`

  options.onNote?.(summary ? 'Contexto compactado com resumo.' : 'Contexto compactado sem resumo (fallback).')

  const summaryMessage: Message = {
    id: `compact_${Date.now().toString(36)}`,
    role: 'user',
    hidden: true,
    ts: Date.now(),
    parts: [{ type: 'text', text: header }]
  }

  return {
    // Thinking blocks are signed over the earlier transcript; the summary replaces it, so the
    // retained turns replay without them (text and tool calls stay).
    messages: [summaryMessage, ...messages.slice(cut).map(({ providerBlocks: _dropped, ...rest }) => rest as Message)],
    compacted: true,
    note: summary ? 'resumo gerado' : 'fallback determinístico'
  }
}
