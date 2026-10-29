import { describe, expect, it } from 'vitest'
import { protectionsFor } from '../src/renderer/src/lib/protections'

/**
 * The Proteções card says what really protects the session. It used to show four fixed ✓ — also in `unrestricted`
 * ("Ignorar permissões"), the mode that turns the confirmations, the command blocklist, the secret-file guard and the
 * folder restriction off. Each case below mirrors what permissions.ts, policy.ts and the orchestrator do in that mode.
 */
const on = (mode: Parameters<typeof protectionsFor>[0]): string[] => protectionsFor(mode).filter((item) => item.on).map((item) => item.text)
const off = (mode: Parameters<typeof protectionsFor>[0]): string[] => protectionsFor(mode).filter((item) => !item.on).map((item) => item.text)

describe('protectionsFor', () => {
  it('"Ignorar permissões" turns every harness protection off and says so', () => {
    expect(off({ mode: 'unrestricted' })).toEqual([
      'Sem confirmações do harness',
      'Acesso a qualquer pasta do computador',
      'Comandos destrutivos não são bloqueados',
      'Arquivos de segredo podem ser lidos'
    ])
    // Storage and logging do not depend on the mode.
    expect(on({ mode: 'unrestricted' })).toEqual(['Chaves do app cifradas com DPAPI', 'Trilha de auditoria da sessão'])
  })

  it('every other mode keeps the blocklist, the secret guard and the folder restriction', () => {
    for (const mode of ['readonly', 'ask', 'accept-edits', 'auto'] as const) {
      expect(off({ mode })).toEqual([])
      expect(on({ mode })).toContain('Comandos destrutivos bloqueados')
      expect(on({ mode })).toContain('Arquivos de segredo protegidos')
      expect(on({ mode })).toContain('Raiz restrita à pasta do projeto')
    }
  })

  it('describes the confirmations of each mode as the permission engine applies them', () => {
    expect(protectionsFor({ mode: 'readonly' })[0].text).toMatch(/negado/)
    expect(protectionsFor({ mode: 'ask' })[0].text).toMatch(/aprovação/)
    expect(protectionsFor({ mode: 'accept-edits' })[0].text).toMatch(/comandos pedem aprovação/)
    expect(protectionsFor({ mode: 'auto' })[0].text).toMatch(/destrutivos pedem confirmação/)
  })

  it('full access opens every folder even in a mode that still asks', () => {
    expect(off({ mode: 'ask', fullAccess: true })).toEqual(['Acesso a qualquer pasta do computador'])
  })

  it('no policy yet reads as the default "ask" mode, not as unprotected', () => {
    expect(off(undefined)).toEqual([])
  })
})
