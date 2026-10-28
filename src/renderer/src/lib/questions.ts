import type { QuestionAnswer, QuestionSpec } from '../../../shared/types'
import type { PathAttachment } from './path-attachments'

export interface QuestionSelection {
  /** Labels of the selected options. */
  selected: string[]
  /** Free-text answer, always available unless the question sets allowOther=false. */
  other: string
  /** Files/folders attached to this answer (absolute paths). */
  attachments: PathAttachment[]
}

export type QuestionSelections = Record<number, QuestionSelection>

export function emptySelection(): QuestionSelection {
  return { selected: [], other: '', attachments: [] }
}

export function emptySelections(questions: QuestionSpec[]): QuestionSelections {
  const next: QuestionSelections = {}
  questions.forEach((_, index) => {
    next[index] = emptySelection()
  })
  return next
}

/** Single-select replaces; multi-select toggles. Choosing an option clears free text. */
export function chooseOption(question: QuestionSpec, selection: QuestionSelection, label: string): QuestionSelection {
  if (question.multi) {
    const selected = selection.selected.includes(label)
      ? selection.selected.filter((item) => item !== label)
      : [...selection.selected, label]
    return { selected, other: selection.other, attachments: selection.attachments }
  }
  return { selected: [label], other: '', attachments: selection.attachments }
}

/** Typing free text clears a single-select choice, so only one answer is sent. */
export function typeOther(question: QuestionSpec, selection: QuestionSelection, text: string): QuestionSelection {
  return {
    selected: question.multi ? selection.selected : text.trim() ? [] : selection.selected,
    other: text,
    attachments: selection.attachments
  }
}

export function isComplete(questions: QuestionSpec[], selections: QuestionSelections): boolean {
  return questions.every((_, index) => {
    const selection = selections[index]
    return Boolean(
      selection && (selection.selected.length || selection.other.trim() || selection.attachments.length)
    )
  })
}

export function buildAnswers(questions: QuestionSpec[], selections: QuestionSelections): QuestionAnswer[] {
  return questions.map((question, index) => {
    const selection = selections[index] ?? emptySelection()
    const answers = [...selection.selected]
    const other = selection.other.trim()
    if (other) answers.push(other)
    const attachments = selection.attachments.map((item) => ({
      name: item.name,
      path: item.path,
      kind: item.kind
    }))
    return {
      header: question.header,
      answers,
      ...(attachments.length ? { attachments } : {})
    }
  })
}

export interface AnsweredAttachment {
  name: string
  path: string
  kind: 'file' | 'folder'
}

export interface AnsweredQuestion {
  header: string
  answer: string
  attachments?: AnsweredAttachment[]
}

/**
 * Reads the persisted `ask_user` result text:
 *   1. Backend
 *      Resposta: Node
 *      Anexos:
 *      - arquivo "mock.png": `C:\...`
 */
export function parseAnswerText(text: string | undefined): AnsweredQuestion[] {
  if (!text) return []
  const rows: AnsweredQuestion[] = []
  for (const line of text.split('\n')) {
    const header = /^\d+\.\s+(.+)$/.exec(line)
    if (header) {
      rows.push({ header: header[1].trim(), answer: '' })
      continue
    }
    if (!rows.length) continue
    const answer = /^\s+Resposta:\s*(.*)$/.exec(line)
    if (answer) {
      rows[rows.length - 1].answer = answer[1].trim()
      continue
    }
    const attachment = /^\s+-\s+(arquivo|pasta)\s+"([^"]+)":\s+`(.+)`\s*$/.exec(line)
    if (attachment) {
      const current = rows[rows.length - 1]
      const list = current.attachments ?? (current.attachments = [])
      list.push({
        kind: attachment[1] === 'pasta' ? 'folder' : 'file',
        name: attachment[2].trim(),
        path: attachment[3].trim()
      })
    }
  }
  return rows
}
