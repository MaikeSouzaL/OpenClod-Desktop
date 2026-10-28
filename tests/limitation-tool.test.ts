import { describe, expect, it } from 'vitest'
import { reportLimitationTool } from '../src/core/tools/limitations'
import type { ToolContext } from '../src/core/tools/types'

const args = {
  title: 'Janela do Explorer não expõe os arquivos',
  goal: 'Abrir o .md da pasta teste',
  error: 'computer_snapshot mostrou 53 panes e nenhum ListItem',
  difficulty: 'Sem element_index não dá para clicar no arquivo pelo harness',
  suggestion: 'Fazer fallback por MSAA/DirectUIHWND e devolver element_index',
  workaround: 'Cliquei por coordenada calculada',
  severity: 'degraded'
}

describe('report_limitation tool', () => {
  it('returns a durable, readable report and flags the severity', async () => {
    const result = await reportLimitationTool.execute(args, {} as ToolContext)
    expect(result.ok).toBe(true)
    expect(result.summary).toBe(args.title)
    expect(result.text).toContain(`Objetivo: ${args.goal}`)
    expect(result.text).toContain(`Erro observado: ${args.error}`)
    expect(result.text).toContain(`Solução sugerida: ${args.suggestion}`)
    expect(result.data).toMatchObject({ limitation: { ...args, severity: 'degraded' } })
  })

  it('defaults severity to blocked and omits an empty workaround', async () => {
    const result = await reportLimitationTool.execute({ ...args, severity: undefined, workaround: undefined }, {} as ToolContext)
    expect(result.text).toContain('Severidade: blocked')
    expect(result.text).not.toContain('Contorno:')
    expect(result.data).toMatchObject({ limitation: { severity: 'blocked' } })
  })

  it('is core so it works even when discovery is unavailable', async () => {
    const { CORE_TOOL_NAMES } = await import('../src/core/tools/lazy')
    expect(CORE_TOOL_NAMES.has('report_limitation')).toBe(true)
  })

  it('is available in every agent mode, including read-only ones', async () => {
    const { toolsForMode } = await import('../src/core/security/permissions')
    for (const mode of ['ask', 'plan', 'code', 'debug', 'review', 'computer', 'web', 'autonomous'] as const) {
      expect(toolsForMode(mode)).toContain('report_limitation')
    }
  })
})
