import { describe, expect, it } from 'vitest'
import { renderSuggestions, scoreCandidate, suggest, type Candidate } from '../src/core/agent/suggest'
import { significantStems } from '../src/core/memory/pack'
import { listAgentsTool, listSkillsTool } from '../src/core/tools/plan'
import type { ToolContext } from '../src/core/tools/types'

const catalogue: Candidate[] = [
  { kind: 'skill', name: 'svg-master', description: 'Desenha SVG, ícones, logos e ilustrações vetoriais com viewBox e animação SMIL.' },
  { kind: 'skill', name: 'qa-total', description: 'QA total de qualquer projeto: testa tudo com prova, corrige defeito e só termina quando o gate de cobertura passa.' },
  { kind: 'skill', name: 'pdf-entrega-affinitas', description: 'Monta o PDF de provas que o time da Affinitas recebe.' },
  { kind: 'agente', name: 'svg-designer', description: 'Cria ícones, logos e pictogramas em SVG.' },
  { kind: 'agente', name: 'explorer', description: 'Busca em muitos arquivos e devolve só a conclusão.' },
  { kind: 'agente', name: 'security-auditor', description: 'Revisa código quanto a vulnerabilidades: injeção, autenticação, segredos.' },
  { kind: 'ferramenta', name: 'mcp__jira__search_issues', description: 'Search Jira issues using JQL.' },
  { kind: 'ferramenta', name: 'mcp__jira__create_issue', description: 'Create a Jira issue in a project.' },
  { kind: 'ferramenta', name: 'browser_screenshot', description: 'Captura a tela da aba atual do navegador.' }
]

describe('list_skills and list_agents with a query', () => {
  const skills = catalogue.filter((item) => item.kind === 'skill').map((item) => ({ ...item, source: 'usuario' as const, dir: '', body: '' }))
  const agents = catalogue.filter((item) => item.kind === 'agente').map((item) => ({ name: item.name, description: item.description, canCall: [] as string[], mode: 'code' }))
  const skillCtx = { services: { skills: { list: () => skills } } } as unknown as ToolContext
  const agentCtx = { agents: { depth: 0, maxDepth: 3, callable: () => agents } } as unknown as ToolContext

  it('return only what matches, instead of the whole roster', async () => {
    const some = await listSkillsTool.execute({ query: 'preciso desenhar um ícone svg' }, skillCtx)
    expect(some.text).toContain('svg-master')
    expect(some.text).not.toContain('qa-total')
    expect(some.summary).toBe('1 de 3 skills')
    const all = await listSkillsTool.execute({}, skillCtx)
    expect(all.text).toContain('qa-total')
    const found = await listAgentsTool.execute({ query: 'revisar vulnerabilidades de segurança' }, agentCtx)
    expect(found.text).toContain('security-auditor')
    expect(found.text).not.toContain('svg-designer')
  })

  it('say so when nothing matches, and how to see everything', async () => {
    const none = await listSkillsTool.execute({ query: 'quantum blockchain' }, skillCtx)
    expect(none.text).toContain('nenhuma skill casa')
    expect(none.text).toContain('chame sem query')
    expect((await listAgentsTool.execute({ query: 'quantum blockchain' }, agentCtx)).text).toContain('nenhum agente casa')
  })
})

describe('suggest', () => {
  it('suggests nothing for a greeting or a request that names nothing in the catalogue', () => {
    expect(suggest('ola', catalogue)).toEqual([])
    expect(suggest('tente novamente', catalogue)).toEqual([])
    expect(suggest('renomeie a variável contador para total', catalogue)).toEqual([])
  })

  it('finds the skill, the agent and the tool a request is about, by their names and descriptions', () => {
    const names = suggest('crie um ícone SVG para o logo do app', catalogue).map((item) => `${item.kind}:${item.name}`)
    expect(names).toContain('skill:svg-master')
    expect(names).toContain('agente:svg-designer')
    expect(names).not.toContain('skill:qa-total')

    const jira = suggest('busque as issues do Jira com JQL', catalogue).map((item) => item.name)
    expect(jira[0]).toBe('mcp__jira__search_issues')
    expect(jira).not.toContain('mcp__jira__create_issue')
  })

  it('knows "memória" and "arquivo" are memory and file: a request to keep pictures in the memory brings memory_file', () => {
    const tools: Candidate[] = [
      ...catalogue,
      { kind: 'ferramenta', name: 'memory_file', description: 'Guarda arquivos na memória do projeto: imagens com descrição e OCR, PDFs, documentos, pastas.' }
    ]
    expect(suggest('pegue todas as memórias, conversas e imagens e coloque na ai memory', tools).map((item) => item.name)).toContain('memory_file')
    expect(suggest('salve esse arquivo na memória do projeto', tools).map((item) => item.name)).toContain('memory_file')
    expect(suggest('corrija o bug do login', tools)).toEqual([])
  })

  it('needs more than a stray word: one description hit among many words is not a suggestion', () => {
    const stems = significantStems('quero um relatório mensal de vendas com gráfico e tabela de provas')
    expect(scoreCandidate(stems, catalogue[2])).toBe(0)
  })

  it('caps each kind and does not repeat a name that was already suggested', () => {
    const many: Candidate[] = Array.from({ length: 8 }, (_, index) => ({ kind: 'skill', name: `deploy-${index}`, description: 'Faz deploy em staging.' }))
    expect(suggest('deploy', many)).toHaveLength(3)
    const skip = new Set(['skill:deploy-0', 'skill:deploy-1', 'skill:deploy-2'])
    expect(suggest('deploy', many, { skip }).map((item) => item.name)).not.toContain('deploy-0')
  })

  it('renders one short line per suggestion, saying how to bring it in', () => {
    const text = renderSuggestions(suggest('crie um ícone SVG para o logo do app', catalogue))
    expect(text).toContain('- skill svg-master — Desenha SVG')
    expect(text).toContain('(carregue com use_skill)')
    expect(text).toContain('(chame com agent)')
    expect(text.split('\n').every((line) => line.length < 220)).toBe(true)
  })
})
