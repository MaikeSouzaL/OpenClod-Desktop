import { describe, expect, it } from 'vitest'
import { limitationMarkdown, parseLimitation } from '../src/renderer/src/lib/limitations'

const full = {
  title: 'computer_snapshot não enumera ícones do desktop',
  goal: 'Abrir a pasta rea pelo ícone da área de trabalho',
  error: 'computer_snapshot window=7145544 devolveu 0 pane',
  difficulty: 'Sem element_index, o clique precisa de coordenadas calculadas fora do harness',
  suggestion: 'Enumerar SysListView32 por MSAA e devolver element_index/frame',
  workaround: 'Usei LVM_GETITEMCOUNT em um script externo',
  severity: 'degraded'
}

describe('limitation card parsing', () => {
  it('accepts the full report and keeps the severity', () => {
    const report = parseLimitation(full)
    expect(report).toMatchObject({
      title: full.title,
      severity: 'degraded',
      workaround: full.workaround
    })
  })

  it('defaults to blocked and trims empty optional fields', () => {
    const report = parseLimitation({ ...full, severity: undefined, workaround: '   ' })
    expect(report?.severity).toBe('blocked')
    expect(report?.workaround).toBeUndefined()
  })

  it('rejects partial args so a broken card never renders', () => {
    expect(parseLimitation(null)).toBeNull()
    expect(parseLimitation({ title: 'x', goal: 'y' })).toBeNull()
    expect(parseLimitation({ ...full, suggestion: '' })).toBeNull()
  })

  it('renders copyable markdown with the requested sections', () => {
    const markdown = limitationMarkdown(parseLimitation(full)!)
    expect(markdown).toContain('## Limitação: computer_snapshot')
    expect(markdown).toContain('- **Erro observado:** computer_snapshot window=7145544')
    expect(markdown).toContain('- **Dificuldade:** Sem element_index')
    expect(markdown).toContain('- **Solução sugerida:** Enumerar SysListView32')
    expect(markdown).toContain('- **Contorno:** Usei LVM_GETITEMCOUNT')
  })
})
