import { describe, expect, it } from 'vitest'
import { buildStatePage, parseNext, stateSlug, summarySection, type StateInput } from '../src/core/memory/state-page'

const base: StateInput = {
  sessionTitle: 'Exportador CSV',
  sessionId: 'ses_1',
  sessionSlug: 'sessao-exportador-csv',
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  runState: 'done',
  firstRequest: 'Implemente o parser, o validador e o exportador CSV da biblioteca. Use ponto e vírgula como separador.',
  lastRequest: 'Agora faça o validador.',
  result: 'Validador pronto, 4 testes passando.',
  plan: [
    { id: 'p1', text: 'parser', status: 'done' },
    { id: 'p2', text: 'validador', status: 'done' },
    { id: 'p3', text: 'exportador CSV com ponto e vírgula', status: 'pending' }
  ],
  files: ['src/parser.ts', 'src/validador.ts'],
  now: new Date('2026-10-27T11:40:00Z')
}

describe('buildStatePage', () => {
  it('records where the work stands: objective, last request and result, plan, next step and files', () => {
    const page = buildStatePage(base)
    expect(page.status).toBe('em-aberto')
    expect(page.slug).toBe('estado-exportador-csv')
    expect(page.title).toBe('Estado: Exportador CSV')
    expect(page.tags).toEqual(['estado', 'em-aberto'])
    expect(page.memoryType).toBe('pending')
    expect(page.next).toBe('exportador CSV com ponto e vírgula')
    for (const expected of ['**Situação:** em aberto', 'deepseek-flash', '[[sessao-exportador-csv]]', '## Objetivo', 'ponto e vírgula como separador', '- [pending] exportador CSV', '## Arquivos mexidos', '- src/parser.ts']) {
      expect(page.body).toContain(expected)
    }
    expect(parseNext(page.body)).toBe('exportador CSV com ponto e vírgula')
  })

  it('is concluded, and no longer open work, once the plan is finished and the turn ended normally', () => {
    const page = buildStatePage({ ...base, plan: base.plan.map((item) => ({ ...item, status: 'done' as const })) })
    expect(page.status).toBe('concluido')
    expect(page.memoryType).toBe('fact')
    expect(page.tags).toEqual(['estado', 'concluido'])
    expect(page.next).toBe('')
    expect(parseNext(page.body)).toBe('')
  })

  it('a plain question with no plan is concluded too', () => {
    expect(buildStatePage({ ...base, plan: [] }).status).toBe('concluido')
  })

  it('marks a turn that ended in error or was cancelled as interrupted and says how to resume', () => {
    const page = buildStatePage({ ...base, plan: [], runState: 'error' })
    expect(page.status).toBe('interrompido')
    expect(page.tags).toEqual(['estado', 'interrompido'])
    expect(page.next).toBe('retomar o último pedido: Agora faça o validador.')
    const withPlan = buildStatePage({ ...base, runState: 'cancelled' })
    expect(withPlan.status).toBe('interrompido')
    expect(withPlan.next).toBe('exportador CSV com ponto e vírgula')
  })

  it('points at the blocked step when nothing is pending', () => {
    const page = buildStatePage({ ...base, plan: [{ id: 'p', text: 'publicar o pacote', status: 'blocked' }] })
    expect(page.status).toBe('em-aberto')
    expect(page.next).toBe('destravar: publicar o pacote')
  })

  it('takes the objective and the next move from a compaction summary when the plan has none', () => {
    const summary = '## Objective\n- Migrar o banco para Postgres\n\n## Decisions\n- usar pg\n\n## Next Move\n1. rodar as migrações em staging\n2. validar\n\n## Relevant Files\n- `db.ts`'
    expect(summarySection(summary, 'Objective')).toBe('- Migrar o banco para Postgres')
    const page = buildStatePage({ ...base, plan: [], runState: 'error', summary })
    expect(page.body).toContain('Migrar o banco para Postgres')
    expect(page.next).toBe('rodar as migrações em staging')
  })

  it('stays bounded however long the texts are', () => {
    const huge = 'palavra '.repeat(2_000)
    const page = buildStatePage({ ...base, firstRequest: huge, lastRequest: huge, result: huge, files: Array.from({ length: 40 }, (_, index) => `arquivo-${index}.ts`) })
    expect(page.body.length).toBeLessThanOrEqual(6_000)
  })

  it('derives one slug per session', () => {
    expect(stateSlug('sessao-exportador-csv')).toBe('estado-exportador-csv')
    expect(stateSlug('sessao-x'.repeat(30)).length).toBeLessThanOrEqual(80)
  })
})
