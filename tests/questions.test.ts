import { describe, expect, it } from 'vitest'
import type { QuestionSpec } from '../src/shared/types'
import {
  buildAnswers,
  chooseOption,
  emptySelection,
  emptySelections,
  isComplete,
  parseAnswerText,
  typeOther
} from '../src/renderer/src/lib/questions'
import { pathAttachment } from '../src/renderer/src/lib/path-attachments'

const questions: QuestionSpec[] = [
  {
    header: 'Backend',
    question: 'Qual backend devo usar?',
    options: [{ label: 'Node' }, { label: 'Go' }]
  },
  {
    header: 'Recursos',
    question: 'Quais recursos entram nesta entrega?',
    options: [{ label: 'Login' }, { label: 'Relatórios' }, { label: 'Exportação' }],
    multi: true
  }
]

describe('question selections', () => {
  it('replaces the choice in single-select and clears free text', () => {
    const first = chooseOption(questions[0], { selected: [], other: 'texto', attachments: [] }, 'Node')
    expect(first).toEqual({ selected: ['Node'], other: '', attachments: [] })
    expect(chooseOption(questions[0], first, 'Go')).toEqual({ selected: ['Go'], other: '', attachments: [] })
  })

  it('toggles options in multi-select and keeps free text', () => {
    const one = chooseOption(questions[1], emptySelection(), 'Login')
    const two = chooseOption(questions[1], one, 'Relatórios')
    expect(two.selected).toEqual(['Login', 'Relatórios'])
    expect(chooseOption(questions[1], two, 'Login').selected).toEqual(['Relatórios'])
  })

  it('typing free text clears a single choice but not a multi choice', () => {
    const single = typeOther(questions[0], { selected: ['Node'], other: '', attachments: [] }, 'Outro')
    expect(single).toEqual({ selected: [], other: 'Outro', attachments: [] })
    const multi = typeOther(questions[1], { selected: ['Login'], other: '', attachments: [] }, 'SSO')
    expect(multi).toEqual({ selected: ['Login'], other: 'SSO', attachments: [] })
  })

  it('requires an answer for every question and builds the payload', () => {
    const selections = emptySelections(questions)
    expect(isComplete(questions, selections)).toBe(false)
    selections[0] = chooseOption(questions[0], selections[0], 'Node')
    selections[1] = typeOther(questions[1], selections[1], 'SSO e Login')
    expect(isComplete(questions, selections)).toBe(true)
    expect(buildAnswers(questions, selections)).toEqual([
      { header: 'Backend', answers: ['Node'] },
      { header: 'Recursos', answers: ['SSO e Login'] }
    ])
  })

  it('accepts a file as the answer and keeps its absolute path', () => {
    const selections = emptySelections(questions)
    const mock = pathAttachment('C:\\temp\\tela.png', 'file')
    expect(mock).not.toBeNull()
    selections[0] = { ...selections[0], attachments: [mock!] }
    selections[1] = { ...selections[1], other: 'só o anexo importa' }

    expect(isComplete(questions, selections)).toBe(true)
    expect(buildAnswers(questions, selections)[0]).toMatchObject({
      header: 'Backend',
      answers: [],
      attachments: [{ name: 'tela.png', path: 'C:\\temp\\tela.png', kind: 'file' }]
    })
  })
})

describe('answer text parsing', () => {
  it('reads the persisted Q&A format and keeps headers with spaces', () => {
    const rows = parseAnswerText(
      [
        'O usuário respondeu:',
        '1. Backend',
        '   Resposta: Node',
        '2. Formato de entrega',
        '   Resposta: PDF; DOCX',
      ].join('\n')
    )
    expect(rows).toEqual([
      { header: 'Backend', answer: 'Node' },
      { header: 'Formato de entrega', answer: 'PDF; DOCX' }
    ])
  })

  it('reads attached paths from the persisted answer', () => {
    const rows = parseAnswerText(
      [
        'O usuário respondeu:',
        '1. Referência visual',
        '   Resposta: (sem resposta)',
        '   Anexos:',
        '   - arquivo "mock.png": `C:\\temp\\mock.png`',
        '   - pasta "prints": `C:\\temp\\prints`'
      ].join('\n')
    )
    expect(rows[0].attachments).toEqual([
      { name: 'mock.png', path: 'C:\\temp\\mock.png', kind: 'file' },
      { name: 'prints', path: 'C:\\temp\\prints', kind: 'folder' }
    ])
  })

  it('returns nothing for a skip message', () => {
    expect(parseAnswerText('O usuário optou por não responder.')).toEqual([])
    expect(parseAnswerText(undefined)).toEqual([])
  })
})
