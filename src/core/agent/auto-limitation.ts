import type { LimitationReport, PlanItem } from '../../shared/types.js'

function shorten(value: string, max = 110): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const KIND_LABEL: Record<string, string> = {
  rate_limit: 'limite do provedor',
  quota: 'cota do provedor',
  bad_request: 'requisição recusada',
  auth: 'autenticação',
  context_overflow: 'contexto excedido',
  timeout: 'tempo esgotado',
  network: 'conexão',
  server: 'servidor do provedor',
  loop: 'loop de raciocínio'
}

/**
 * Structured self-analysis produced by the harness when a turn fails or the
 * agent blocks a step without calling report_limitation. It is stored as a
 * message part (never sent to the provider) and shown as a card.
 */
export function buildAutoLimitation(input: {
  goal: string
  error?: string
  errorKind?: string
  blocked?: PlanItem[]
  active?: PlanItem
  attempts?: string[]
  /** The harness stopped a repeated reasoning/text/tool chain. */
  loop?: boolean
}): LimitationReport {
  const blocked = input.blocked?.[0]
  const error = (input.error ?? '').trim()
  const kind = (input.errorKind ?? '').trim()
  const label = KIND_LABEL[kind] ?? kind
  const lower = error.toLowerCase()
  const loop = Boolean(input.loop) || kind === 'loop' || lower.includes('loop detectado')

  const title = loop
    ? 'Loop detectado e interrompido'
    : blocked
      ? `Passo bloqueado: ${shorten(blocked.text)}`
      : kind === 'rate_limit' || lower.includes('rate limit') || lower.includes('429')
        ? 'Limite do provedor atingido'
        : error
          ? `Turno interrompido: ${label || 'falha do provedor'}`
          : 'Turno interrompido sem concluir a tarefa'

  // The current plan step is more informative than a short "continue" prompt.
  const goal = shorten(
    input.active?.text || blocked?.text || input.goal || 'Concluir a tarefa atual',
    300
  )

  const failure = shorten(
    error || blocked?.text || 'O turno terminou sem concluir o trabalho e sem registrar a causa.',
    1200
  )

  const difficulty = loop
    ? 'O modelo repetiu o mesmo trecho ou a mesma chamada de ferramenta várias vezes sem produzir progresso. O harness cortou a resposta antes de gastar todo o orçamento do turno.'
    : blocked
      ? `O passo "${shorten(blocked.text, 180)}" foi marcado como bloqueado. O agente não registrou uma limitação própria com o motivo exato.`
      : `O turno parou antes de concluir ${input.active ? `o passo "${shorten(input.active.text, 180)}"` : 'a tarefa'}.`

  let suggestion: string
  if (loop) {
    suggestion =
      'Reformule o pedido em um turno novo, com escopo menor ou uma decisão explícita. Se o mesmo padrão voltar a ocorrer, reduza o esforço de raciocínio, troque de modelo ou registre a limitação para corrigir o harness. O plano e a conversa foram preservados.'
  } else if (blocked) {
    suggestion =
      'Obter a informação, credencial ou decisão que falta; se a causa for uma capacidade ausente, implementar no harness (ferramenta, permissão, fallback ou contrato) e registrar com report_limitation na próxima vez.'
  } else if (kind === 'rate_limit' || kind === 'quota' || lower.includes('rate limit') || lower.includes('429')) {
    suggestion =
      'Aguardar o limite do provedor, reduzir ferramentas em paralelo, ativar o fallback ou trocar de modelo/provedor. O plano foi preservado.'
  } else if (kind === 'context_overflow' || lower.includes('context') || lower.includes('too many tokens')) {
    suggestion =
      'Compactar o contexto ou usar um modelo com janela maior. O plano foi preservado para continuar em um novo turno.'
  } else if (kind === 'auth' || lower.includes('401') || lower.includes('403')) {
    suggestion =
      'Verificar a chave/credencial do provedor em Configurações → Provedores e testar a conexão antes de repetir.'
  } else if (kind === 'timeout' || kind === 'network' || lower.includes('econn') || lower.includes('fetch failed')) {
    suggestion =
      'Verificar conexão, proxy ou VPN e tentar novamente. Se o servidor estiver instável, ativar o fallback.'
  } else if (kind === 'bad_request' || lower.includes('invalid message content') || lower.includes('400')) {
    suggestion =
      'O provedor recusou o formato da requisição. Remover mensagens vazias e anexos não suportados, conferir o suporte a imagens do modelo e repetir.'
  } else {
    suggestion =
      'Investigar o erro exato e ajustar o harness/ferramenta. O plano e a conversa foram preservados para continuar de onde parou.'
  }

  return {
    title: shorten(title, 120),
    goal,
    error: failure,
    difficulty: shorten(difficulty, 800),
    suggestion: shorten(suggestion, 800),
    ...(input.attempts?.length ? { attempts: input.attempts.map((attempt) => shorten(attempt, 400)).slice(0, 12) } : {}),
    workaround: 'O plano e a conversa foram preservados. Use "Continuar de onde parou" ou reenvie a instrução.',
    severity: 'blocked',
    automatic: true
  }
}
