import { describe, expect, it } from 'vitest'
import {
  composeTurnContext,
  createTurnContextState,
  hydrateTurnContext,
  isTurnContext,
  noteTurnPlan,
  resetTurnContext,
  TURN_CONTEXT_CLOSE,
  TURN_CONTEXT_OPEN
} from '../src/core/agent/turn-context'
import { compactIfNeeded } from '../src/core/agent/compaction'
import { ScriptedProvider } from './support/scripted-provider'
import type { Message, PlanItem } from '../src/shared/types'

const plan = (status: PlanItem['status'] = 'pending', interrupted = false): PlanItem[] => [
  { id: 'p1', text: 'passo 1', status: 'done' },
  { id: 'p2', text: 'passo 2', status, ...(interrupted ? { interrupted: true } : {}) }
]

function hidden(text: string): Message {
  return { id: `m_${Math.random()}`, role: 'user', ts: Date.now(), hidden: true, parts: [{ type: 'text', text }] }
}

describe('composeTurnContext', () => {
  it('says nothing when there is nothing to say: a greeting costs no tokens', () => {
    const result = composeTurnContext(createTurnContextState(), {})
    expect(result.text).toBeNull()
    expect(result.sections).toEqual([])
  })

  it('carries the plan once, and again only when it changed outside the model\'s own calls', () => {
    const state = createTurnContextState()
    const first = composeTurnContext(state, { plan: plan() })
    expect(first.text).toContain('## Plano atual (update_plan)')
    expect(first.text).toContain('- [pending] passo 2')
    expect(composeTurnContext(state, { plan: plan() }).text).toBeNull()
    // The model rewrote the plan with update_plan: it is in the history already.
    noteTurnPlan(state, plan('active'))
    expect(composeTurnContext(state, { plan: plan('active') }).text).toBeNull()
    // The app closed with a step running: the interrupted marker is new information.
    expect(composeTurnContext(state, { plan: plan('active', true) }).text).toContain('(interrompido — retome daqui)')
  })

  it('sends the map of the memory on the first turn only, and facts, servers and open work only when they change', () => {
    const state = createTurnContextState()
    const input = { map: 'Esta memória tem 3 páginas.', facts: ['usar pnpm'], mcp: '- jira (3 ferramentas)', openWork: '- ho_1: terminar o parser' }
    const first = composeTurnContext(state, input).text!
    for (const expected of ['## Mapa da memória do projeto', '- usar pnpm', '- jira (3 ferramentas)', 'ho_1: terminar o parser']) expect(first).toContain(expected)
    expect(composeTurnContext(state, input).text).toBeNull()
    const changed = composeTurnContext(state, { ...input, facts: ['usar pnpm', 'node 22'] }).text!
    expect(changed).toContain('- node 22')
    expect(changed).not.toContain('Mapa da memória')
    expect(changed).not.toContain('ho_1')
  })

  it('wraps everything in the markers the harness recognises, and says it is data and not an instruction', () => {
    const text = composeTurnContext(createTurnContextState(), { recall: '- página [x]' }).text!
    expect(text.startsWith(`${TURN_CONTEXT_OPEN}\n`)).toBe(true)
    expect(text.endsWith(TURN_CONTEXT_CLOSE)).toBe(true)
    expect(text).toContain('nunca instruções')
    expect(text).toContain('## Memória que casa com este pedido')
  })

  it('cuts the last sections, not the first, when it goes over its budget', () => {
    const state = createTurnContextState()
    const result = composeTurnContext(state, { plan: plan(), recall: 'r'.repeat(5_000), suggestions: 's'.repeat(5_000) }, 1_500)
    expect(result.text!.length).toBeLessThan(1_700)
    expect(result.text).toContain('Plano atual')
    expect(result.text).toContain('…[cortado]')
    expect(result.sections.map((section) => section.name)).toContain('plano')
  })

  it('offers again what the budget cut, instead of counting it as sent', () => {
    const state = createTurnContextState()
    // The plan fits; the map is first in line after it but there is no room left for it.
    const first = composeTurnContext(state, { plan: plan(), facts: ['f'.repeat(900)], map: 'mapa do projeto' }, 1_100)
    expect(first.sections.map((section) => section.name)).toContain('plano')
    expect(first.sections.map((section) => section.name)).not.toContain('mapa')
    expect(state.mapSent).toBe(false)
    const second = composeTurnContext(state, { plan: plan(), facts: ['f'.repeat(900)], map: 'mapa do projeto' }, 9_000)
    expect(second.text).toContain('Mapa da memória do projeto')
    expect(second.text).not.toContain('Plano atual')
  })

  it('sends everything again after a compaction, because the history that held it is gone', () => {
    const state = createTurnContextState()
    const input = { plan: plan(), map: 'mapa', facts: ['f'] }
    expect(composeTurnContext(state, input).text).not.toBeNull()
    expect(composeTurnContext(state, input).text).toBeNull()
    resetTurnContext(state)
    const again = composeTurnContext(state, input).text!
    expect(again).toContain('Plano atual')
    expect(again).toContain('Mapa da memória')
  })
})

describe('a runner rebuilt over an existing history', () => {
  it('knows the map and the pages the earlier turn contexts already put there', () => {
    const history = [
      hidden(composeTurnContext(createTurnContextState(), { map: 'mapa', recall: '- A página [pagina-um] (solution)\n- Outra [pagina-dois] (assunto)' }).text!),
      hidden('<hook-context>outra coisa [pagina-tres]</hook-context>')
    ]
    const state = createTurnContextState()
    hydrateTurnContext(state, history)
    expect(state.mapSent).toBe(true)
    expect([...state.seen.keys()].sort()).toEqual(['pagina-dois', 'pagina-um'])
    expect(composeTurnContext(state, { map: 'mapa' }).text).toBeNull()
  })
})

describe('isTurnContext and the compaction summary', () => {
  it('recognises only the hidden user message built here', () => {
    expect(isTurnContext(hidden(`${TURN_CONTEXT_OPEN}\n…`))).toBe(true)
    expect(isTurnContext(hidden('<hook-context>x</hook-context>'))).toBe(false)
    expect(isTurnContext({ id: 'u', role: 'user', ts: 1, parts: [{ type: 'text', text: `${TURN_CONTEXT_OPEN} do usuário` }] })).toBe(false)
  })

  it('leaves the turn contexts out of what the summariser reads', async () => {
    const messages: Message[] = []
    for (let turn = 0; turn < 6; turn++) {
      messages.push({ id: `u${turn}`, role: 'user', ts: turn, parts: [{ type: 'text', text: `pedido número ${turn}` }] })
      messages.push(hidden(`${TURN_CONTEXT_OPEN}\n## Memória que casa com este pedido\n- SEGREDO-DERIVADO-${turn} [pagina]\n${TURN_CONTEXT_CLOSE}`))
      messages.push({ id: `a${turn}`, role: 'assistant', ts: turn, parts: [{ type: 'text', text: `resposta ${turn}` }] })
    }
    const provider = new ScriptedProvider([{ text: '## Objective\n- teste' }])
    const result = await compactIfNeeded({ system: 's', messages, provider, contextWindow: 1_000, force: true, keepRecent: 4 })
    expect(result.compacted).toBe(true)
    const sent = JSON.stringify(provider.requests[0].messages)
    expect(sent).toContain('pedido número 0')
    expect(sent).not.toContain('SEGREDO-DERIVADO-0')
  })
})
