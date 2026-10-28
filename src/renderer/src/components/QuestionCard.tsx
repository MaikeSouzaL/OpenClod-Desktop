import type { ReactElement } from 'react'
import type { ToolResultPart } from '../../../shared/types'
import { Icon } from './Icons'
import { parseAnswerText } from '../lib/questions'

interface QuestionRow {
  header: string
  question: string
}

function readQuestions(args: unknown): QuestionRow[] {
  if (!args || typeof args !== 'object') return []
  const value = args as { questions?: unknown }
  if (!Array.isArray(value.questions)) return []
  const rows: QuestionRow[] = []
  for (const item of value.questions) {
    if (!item || typeof item !== 'object') continue
    const question = item as Record<string, unknown>
    if (typeof question.header !== 'string' || typeof question.question !== 'string') continue
    rows.push({ header: question.header, question: question.question })
  }
  return rows
}

/** Read-only Q&A shown after the user answers (pending questions use the dock). */
export function QuestionCard({ args, result }: { args: unknown; result?: ToolResultPart }): ReactElement | null {
  if (!result) return null
  const questions = readQuestions(args)
  if (!questions.length) return null

  const answers = parseAnswerText(result.text)
  return (
    <div className="qa-card">
      <div className="qa-head">
        <Icon name="message" size={14} />
        <strong>Perguntas ao usuário</strong>
        <span className="qa-count">{questions.length}</span>
      </div>
      {answers.length ? (
        <div className="qa-list">
          {answers.map((answer, index) => (
            <div key={`${answer.header}-${index}`} className="qa-row">
              <span className="qa-chip">{answer.header}</span>
              <p className="qa-question">{questions[index]?.question ?? ''}</p>
              <p className="qa-answer">
                {answer.answer || <em>sem resposta</em>}
              </p>
              {answer.attachments?.length ? (
                <div className="qa-attachments">
                  {answer.attachments.map((attachment, attachmentIndex) => (
                    <span
                      key={`${attachment.path}-${attachmentIndex}`}
                      className="qa-attachment"
                      title={attachment.path}
                    >
                      <Icon name={attachment.kind === 'folder' ? 'folder' : 'file'} size={11} /> {attachment.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="qa-skip">{result.text}</p>
      )}
    </div>
  )
}
