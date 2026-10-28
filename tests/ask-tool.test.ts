import { describe, expect, it, vi } from 'vitest'
import { askUserTool } from '../src/core/tools/ask'
import type { ToolContext } from '../src/core/tools/types'

const args = {
  questions: [
    {
      header: 'Backend',
      question: 'Qual backend devo usar?',
      options: [{ label: 'Node', description: 'TypeScript no mesmo processo' }, { label: 'Go' }]
    },
    {
      header: 'Recursos',
      question: 'Quais recursos entram?',
      options: [{ label: 'Login' }, { label: 'Relatórios' }],
      multi: true
    }
  ]
}

function context(ask: ToolContext['ask']): ToolContext {
  return { ask } as ToolContext
}

describe('ask_user tool', () => {
  it('formats the answers for the model and keeps them in data', async () => {
    const ask = vi.fn(async () => [
      { header: 'Backend', answers: ['Node'] },
      { header: 'Recursos', answers: ['Login', 'Relatórios'] }
    ])
    const result = await askUserTool.execute(args, context(ask))
    expect(ask).toHaveBeenCalledWith({
      questions: [
        {
          header: 'Backend',
          question: 'Qual backend devo usar?',
          options: [{ label: 'Node', description: 'TypeScript no mesmo processo' }, { label: 'Go' }]
        },
        {
          header: 'Recursos',
          question: 'Quais recursos entram?',
          options: [{ label: 'Login' }, { label: 'Relatórios' }],
          multi: true
        }
      ]
    })
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('respostas: 2/2')
    expect(result.text).toContain('1. Backend')
    expect(result.text).toContain('Resposta: Node')
    expect(result.text).toContain('Resposta: Login; Relatórios')
    expect(result.data).toEqual({
      answers: [
        { header: 'Backend', answers: ['Node'] },
        { header: 'Recursos', answers: ['Login', 'Relatórios'] }
      ]
    })
  })

  it('forwards attached file paths to the model', async () => {
    const ask = vi.fn(async () => [
      {
        header: 'Referência visual',
        answers: [],
        attachments: [{ name: 'mock.png', path: 'C:\\temp\\mock.png', kind: 'file' as const }]
      }
    ])
    const result = await askUserTool.execute(
      { questions: [{ header: 'Referência visual', question: 'Como é a barra?', allow_other: false }] },
      context(ask)
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('respostas: 1/1')
    expect(result.text).toContain('Anexos:')
    expect(result.text).toContain('arquivo "mock.png"')
    expect(result.text).toContain('C:\\temp\\mock.png')
    expect(result.data).toEqual({
      answers: [
        {
          header: 'Referência visual',
          answers: [],
          attachments: [{ name: 'mock.png', path: 'C:\\temp\\mock.png', kind: 'file' }]
        }
      ]
    })
  })

  it('lets the agent continue when the user skips', async () => {
    const result = await askUserTool.execute(args, context(async () => []))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('optou por não responder')
    expect(result.summary).toBe('perguntas puladas')
  })

  it('reports a timeout/cancel as a failure instead of inventing an answer', async () => {
    const result = await askUserTool.execute(args, context(async () => null))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('não respondeu')
  })

  it('is unavailable in isolated/subagent contexts without an ask channel', async () => {
    const result = await askUserTool.execute(args, context(undefined))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('não estão disponíveis')
  })

  it('is core and available in every mode', async () => {
    const { CORE_TOOL_NAMES } = await import('../src/core/tools/lazy')
    const { toolsForMode } = await import('../src/core/security/permissions')
    expect(CORE_TOOL_NAMES.has('ask_user')).toBe(true)
    for (const mode of ['ask', 'plan', 'code', 'debug', 'review', 'computer', 'web', 'autonomous'] as const) {
      expect(toolsForMode(mode)).toContain('ask_user')
    }
  })
})
