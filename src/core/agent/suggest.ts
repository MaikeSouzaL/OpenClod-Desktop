import { normalizeText, significantStems, stem } from '../memory/pack.js'

/**
 * Skills, agents and tools that are not in the context but fit the request. The harness looks for them itself, so the
 * system prompt does not have to carry a catalogue: a catalogue of 80 agents or 900 connectors costs thousands of tokens
 * on every call, while three lines about the ones that match cost nothing on the turns that need none.
 *
 * Deliberately strict: a suggestion is only worth its tokens when the request names the thing (a word of its name) or
 * says most of what its description says. Everything else stays one `list_skills`, `list_agents` or `tool_search` away.
 */
export type CandidateKind = 'skill' | 'agente' | 'ferramenta'

export interface Candidate {
  kind: CandidateKind
  name: string
  description: string
}

export interface Suggestion extends Candidate {
  score: number
}

export interface SuggestOptions {
  /** Most suggestions per kind. */
  perKind?: Partial<Record<CandidateKind, number>>
  /** Names already suggested earlier in the conversation: not repeated. */
  skip?: Set<string>
}

const DEFAULT_PER_KIND: Record<CandidateKind, number> = { skill: 3, agente: 2, ferramenta: 3 }

/**
 * The user writes in Portuguese and most tools are named in English (`search_issues`, `create_issue`): the verbs people
 * use to ask for something and the words tools use for it, so "busque as issues" finds `search_issues`.
 */
const SYNONYM_GROUPS: Array<[string[], string[]]> = [
  [['busque', 'buscar', 'busca', 'procure', 'procurar', 'pesquise', 'pesquisar', 'pesquisa', 'ache', 'achar', 'encontre', 'encontrar'], ['search', 'find', 'query', 'lookup']],
  [['crie', 'criar', 'cria', 'adicione', 'adicionar', 'nova', 'novo', 'gere', 'gerar'], ['create', 'add', 'new', 'make', 'generate']],
  [['apague', 'apagar', 'exclua', 'excluir', 'remova', 'remover', 'delete', 'deletar'], ['delete', 'remove', 'destroy']],
  [['atualize', 'atualizar', 'edite', 'editar', 'altere', 'alterar', 'modifique', 'modificar'], ['update', 'edit', 'modify', 'patch']],
  [['liste', 'listar', 'lista', 'mostre', 'mostrar'], ['list', 'show', 'get']],
  [['leia', 'ler', 'abra', 'abrir', 'obtenha', 'obter', 'pegue', 'pegar'], ['read', 'get', 'fetch', 'open']],
  [['envie', 'enviar', 'mande', 'mandar', 'poste', 'postar', 'publique', 'publicar'], ['send', 'post', 'publish']],
  [['baixe', 'baixar'], ['download']],
  [['execute', 'executar', 'rode', 'rodar'], ['run', 'execute']],
  [['teste', 'testar'], ['test']],
  [['comente', 'comentar'], ['comment']],
  [['mova', 'mover', 'transite', 'transitar'], ['move', 'transition']],
  [['revise', 'revisar', 'revisao', 'analise', 'analisar', 'audite', 'auditar'], ['review', 'reviewer', 'audit', 'auditor', 'analyze']],
  [['corrija', 'corrigir', 'conserte', 'consertar', 'resolva', 'resolver'], ['fix', 'debug', 'debugger', 'repair']],
  [['depure', 'depurar'], ['debug', 'debugger']],
  [['explore', 'explorar', 'investigue', 'investigar'], ['explore', 'explorer', 'search']],
  [['documente', 'documentar'], ['document', 'documentation', 'docs']],
  [['otimize', 'otimizar'], ['optimize', 'optimizer', 'performance']],
  [['implante', 'implantar'], ['deploy', 'devops']],
  [['refatore', 'refatorar'], ['refactor', 'refactoring']],
  [['planeje', 'planejar'], ['plan', 'planner', 'architect']],
  [['desenhe', 'desenhar'], ['draw', 'design', 'svg']]
]
const SYNONYMS = new Map<string, string[]>()
for (const [portuguese, english] of SYNONYM_GROUPS) {
  for (const word of portuguese) SYNONYMS.set(stem(normalizeText(word)), english.map((value) => stem(value)))
}

function tokens(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3)
      .map(stem)
  )
}

/** `mcp__jira__search_issues` -> "jira search issues": the words a person would use for it. */
function nameWords(name: string): string {
  return name.replace(/^mcp__/, '').replace(/__/g, ' ').replace(/[-_.]/g, ' ')
}

export function scoreCandidate(stems: string[], candidate: Candidate): number {
  const name = tokens(nameWords(candidate.name))
  const description = tokens(candidate.description.slice(0, 700))
  let nameHits = 0
  let intentHits = 0
  let descriptionHits = 0
  let matched = 0
  for (const value of stems) {
    // A word of the request matches when it, or an English equivalent of it, is in the name or the description.
    const forms = [value, ...(SYNONYMS.get(value) ?? [])]
    const inName = forms.some((form) => name.has(form))
    // The user asked for an ACTION ("revise", "teste") and the name carries it in English (reviewer, test-automator).
    if (!name.has(value) && inName) intentHits++
    const inDescription = forms.some((form) => description.has(form))
    if (inName) nameHits++
    if (inDescription) descriptionHits++
    if (inName || inDescription) matched++
  }
  const coverage = matched / stems.length
  // A word of the name in a short request, or a third of a longer one; or, in a longer one, the action the name stands for.
  const named = nameHits >= 1 && (stems.length <= 2 || coverage >= 0.34 || (intentHits >= 1 && coverage >= 0.25))
  const described = descriptionHits >= 3 && coverage >= 0.5
  if (!named && !described) return 0
  return nameHits * 3 + descriptionHits
}

export function suggest(query: string, candidates: Candidate[], options: SuggestOptions = {}): Suggestion[] {
  const stems = significantStems(query)
  if (!stems.length) return []
  const limits = { ...DEFAULT_PER_KIND, ...options.perKind }
  const out: Suggestion[] = []
  for (const kind of ['skill', 'agente', 'ferramenta'] as const) {
    const ranked = candidates
      .filter((candidate) => candidate.kind === kind && !options.skip?.has(`${kind}:${candidate.name}`))
      .map((candidate) => ({ ...candidate, score: scoreCandidate(stems, candidate) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    // Next to a clear winner (the tool the request is about) its siblings are noise.
    const best = ranked[0]?.score ?? 0
    out.push(...ranked.filter((item) => item.score >= best * 0.7).slice(0, limits[kind]))
  }
  return out
}

/**
 * An explicit search (`list_skills query`, `list_agents query`): looser than a suggestion, since the model asked. Any
 * candidate whose name or description says something about the query, best first. Without a query, everything.
 */
export function searchCandidates<T extends { name: string; description: string }>(query: string | undefined, items: T[], limit = 12): T[] {
  const stems = significantStems(query ?? '')
  if (!stems.length) return query?.trim() ? [] : items
  return items
    .map((item) => {
      const name = tokens(nameWords(item.name))
      const description = tokens(item.description.slice(0, 700))
      let score = 0
      for (const value of stems) {
        const forms = [value, ...(SYNONYMS.get(value) ?? [])]
        if (forms.some((form) => name.has(form))) score += 3
        if (forms.some((form) => description.has(form))) score += 1
      }
      return { item, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map((entry) => entry.item)
}

const HOW: Record<CandidateKind, string> = {
  skill: 'carregue com use_skill',
  agente: 'chame com agent',
  ferramenta: 'habilite com tool_load'
}

export function renderSuggestions(items: Suggestion[]): string {
  return items
    .map((item) => {
      const description = item.description.replace(/\s+/g, ' ').trim()
      const short = description.length > 110 ? `${description.slice(0, 109)}…` : description
      return `- ${item.kind} ${item.name}${short ? ` — ${short}` : ''} (${HOW[item.kind]})`
    })
    .join('\n')
}
