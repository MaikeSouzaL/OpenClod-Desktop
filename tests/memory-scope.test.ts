import { describe, expect, it } from 'vitest'
import { memoryScopeId } from '../src/core/memory/scope'
import { composeTurnContext, createTurnContextState } from '../src/core/agent/turn-context'
import type { SessionMeta } from '../src/shared/types'

const meta = (over: Partial<SessionMeta>): Pick<SessionMeta, 'surface' | 'projectId' | 'id'> => ({
  id: 'sess_abc',
  projectId: 'proj_desktop',
  surface: 'code',
  ...over
})

/**
 * A memória é por projeto no Code/Cowork e por sessão nos chats do Início. O escopo decide a pasta da wiki, o json
 * episódico e a chave no AI-Memory, então estas regras precisam ficar previsíveis.
 */
describe('memoryScopeId', () => {
  it('usa o projeto no modo Code', () => {
    expect(memoryScopeId(meta({ surface: 'code' }))).toBe('proj_desktop')
  })

  it('usa o projeto no Cowork (sessões do mesmo projeto compartilham a memória)', () => {
    expect(memoryScopeId(meta({ surface: 'cowork' }))).toBe('proj_desktop')
  })

  it('isola cada chat do Início pela sessão', () => {
    expect(memoryScopeId(meta({ surface: 'chat', id: 'sess_abc' }))).toBe('chat-sess_abc')
    expect(memoryScopeId(meta({ surface: 'chat', id: 'sess_xyz' }))).toBe('chat-sess_xyz')
  })

  it('dois chats diferentes nunca caem no mesmo escopo', () => {
    const a = memoryScopeId(meta({ surface: 'chat', id: 'sess_1' }))
    const b = memoryScopeId(meta({ surface: 'chat', id: 'sess_2' }))
    expect(a).not.toBe(b)
  })

  it('a mesma sessão de chat reabre no mesmo escopo (memória estável entre retomadas)', () => {
    const first = memoryScopeId(meta({ surface: 'chat', id: 'sess_keep' }))
    const second = memoryScopeId(meta({ surface: 'chat', id: 'sess_keep' }))
    expect(first).toBe(second)
  })

  it('cai no projeto quando a surface não está definida (sessões legadas)', () => {
    expect(memoryScopeId({ id: 'sess_old', projectId: 'proj_x', surface: undefined })).toBe('proj_x')
  })
})

/**
 * Nos chats a memória é sob demanda: o runner passa openWork/recall como undefined. Aqui garantimos que, sem eles,
 * o contexto do turno NÃO carrega "de onde paramos" nem páginas que casam — só o mapa fica, para o modelo saber que há
 * memória e buscar com memory_recall quando sentir que precisa.
 */
describe('contexto do turno sob demanda (chat)', () => {
  it('sem openWork/recall, nenhuma seção de retomada aparece', () => {
    const result = composeTurnContext(createTurnContextState(), {
      map: '- tópico A\n- tópico B',
      openWork: undefined,
      recall: undefined
    })
    expect(result.text).toContain('Mapa da memória do projeto')
    expect(result.text).not.toContain('Trabalho em aberto de sessões anteriores')
    expect(result.text).not.toContain('Memória que casa com este pedido')
  })

  it('no Code/Cowork, com openWork/recall, as seções de retomada aparecem', () => {
    const result = composeTurnContext(createTurnContextState(), {
      openWork: '- tarefa X [slug] — em aberto',
      recall: '[pagina] detalhe relevante'
    })
    expect(result.text).toContain('Trabalho em aberto de sessões anteriores')
    expect(result.text).toContain('Memória que casa com este pedido')
  })
})
