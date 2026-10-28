import { describe, expect, it } from 'vitest'
import { redactDiagnosticText } from '../src/core/observability/service'

describe('Revisão de melhorias → nota da Atividade', () => {
  it('redacts keys and personal paths from the project name before it reaches the Activity list', () => {
    // src/main/improvement.ts builds the note detail from redactDiagnosticText(info.projectName, 120)
    const projectName = String.raw`Projeto sk-ABCDEFGHIJKLMNOP1234 em C:\Users\maike\segredo`
    const detail = `${redactDiagnosticText(projectName, 120)} · 3 achados`
    expect(detail).not.toContain('sk-ABCDEFGHIJKLMNOP1234')
    expect(detail.toLowerCase()).not.toContain('maike')
    expect(detail).toContain('3 achados')
  })

  it('keeps an ordinary project name readable and short', () => {
    expect(redactDiagnosticText('Loja online', 120)).toBe('Loja online')
    expect(redactDiagnosticText('x'.repeat(500), 120).length).toBeLessThanOrEqual(130)
  })
})
