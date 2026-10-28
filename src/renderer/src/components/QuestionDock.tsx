import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactElement
} from 'react'
import type { QuestionAnswer, QuestionRequest } from '../../../shared/types'
import { Icon } from './Icons'
import { addPathAttachments, type IncomingPath } from '../lib/path-attachments'
import {
  buildAnswers,
  chooseOption,
  emptySelection,
  emptySelections,
  isComplete,
  typeOther,
  type QuestionSelections
} from '../lib/questions'

interface QuestionDockProps {
  request: QuestionRequest | null
  onAnswer(id: string, answers: QuestionAnswer[]): void
  onSkip(id: string): void
}

const MAX_ATTACHMENTS = 8

/**
 * Structured questions pinned above the composer. The turn stays paused until
 * the user answers (or skips), replacing the old "just reply and I'll guess".
 * Answers can carry files/images/PDFs by absolute path, so the agent can study
 * them with its own tools instead of guessing from the text.
 */
export function QuestionDock({ request, onAnswer, onSkip }: QuestionDockProps): ReactElement | null {
  const [selections, setSelections] = useState<QuestionSelections>({})
  const [attachError, setAttachError] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachIndex = useRef(0)

  useEffect(() => {
    setSelections(request ? emptySelections(request.questions) : {})
    setAttachError('')
    setDragIndex(null)
  }, [request?.id])

  if (!request) return null

  const select = (index: number, next: QuestionSelections[number]): void => {
    setSelections((current) => ({ ...current, [index]: next }))
  }

  const addPaths = (index: number, incoming: IncomingPath[]): void => {
    if (!incoming.length) return
    setAttachError('')
    setSelections((current) => {
      const selection = current[index] ?? emptySelection()
      if (selection.attachments.length >= MAX_ATTACHMENTS) {
        setAttachError(`Máximo de ${MAX_ATTACHMENTS} anexos por resposta.`)
        return current
      }
      const attachments = addPathAttachments(selection.attachments, incoming, MAX_ATTACHMENTS)
      if (attachments === selection.attachments) return current
      return { ...current, [index]: { ...selection, attachments } }
    })
  }

  const addFiles = (index: number, files: FileList | File[]): void => {
    const incoming: IncomingPath[] = []
    for (const file of Array.from(files)) {
      try {
        const path = window.forja.paths.fromFile(file)
        if (path) incoming.push({ path, kind: 'file' })
      } catch {
        /* synthetic File without an OS path */
      }
    }
    if (!incoming.length) {
      setAttachError('Não foi possível ler o caminho. Arraste o arquivo do Explorer para anexar.')
      return
    }
    addPaths(index, incoming)
  }

  const pickFiles = (index: number): void => {
    attachIndex.current = index
    setAttachError('')
    fileRef.current?.click()
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) addFiles(attachIndex.current, event.target.files)
    event.target.value = ''
  }

  const pickFolder = async (index: number): Promise<void> => {
    const result = await window.forja.paths.pickFolder()
    if (!result.ok) {
      setAttachError(result.error)
      return
    }
    if (result.value) addPaths(index, [{ path: result.value, kind: 'folder' }])
  }

  const removeAttachment = (index: number, attachmentId: string): void => {
    setSelections((current) => {
      const selection = current[index] ?? emptySelection()
      return {
        ...current,
        [index]: {
          ...selection,
          attachments: selection.attachments.filter((item) => item.id !== attachmentId)
        }
      }
    })
  }

  const onDrop = (index: number, event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragIndex(null)
    const items = Array.from(event.dataTransfer.items ?? [])
    const incoming: IncomingPath[] = []
    const files: File[] = []
    for (const item of items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      let directory = false
      try {
        directory = item.webkitGetAsEntry()?.isDirectory === true
      } catch {
        /* older Chromium: treat as a file */
      }
      if (directory) {
        try {
          const path = file ? window.forja.paths.fromFile(file) : ''
          if (path) incoming.push({ path, kind: 'folder' })
        } catch {
          setAttachError('Não foi possível ler o caminho da pasta arrastada.')
        }
        continue
      }
      if (file) files.push(file)
    }
    if (!items.length && event.dataTransfer.files.length) files.push(...Array.from(event.dataTransfer.files))
    if (incoming.length) addPaths(index, incoming)
    if (files.length) addFiles(index, files)
  }

  const complete = isComplete(request.questions, selections)

  return (
    <div className="approval-dock question-dock">
      <div className="question-card">
        <div className="question-head">
          <span className="approval-icon">
            <Icon name="message" size={15} />
          </span>
          <div className="question-title">
            <strong>Preciso de mais contexto</strong>
            <span>
              {request.questions.length} pergunta{request.questions.length > 1 ? 's' : ''} para o agente continuar
            </span>
          </div>
        </div>

        {request.questions.map((question, index) => {
          const selection = selections[index] ?? emptySelection()
          const freeText = !question.options?.length || question.allowOther !== false
          return (
            <section
              key={`${request.id}-${index}`}
              className={`question-block ${dragIndex === index ? 'is-dragging' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                setDragIndex(index)
              }}
              onDragLeave={() => setDragIndex((current) => (current === index ? null : current))}
              onDrop={(event) => onDrop(index, event)}
            >
              <span className="question-chip">{question.header}</span>
              <p className="question-text">{question.question}</p>

              {question.options?.length ? (
                <div className="question-options">
                  {question.options.map((option) => {
                    const checked = selection.selected.includes(option.label)
                    return (
                      <label key={option.label} className={`question-option ${checked ? 'is-selected' : ''}`}>
                        <input
                          type={question.multi ? 'checkbox' : 'radio'}
                          name={`q-${request.id}-${index}`}
                          checked={checked}
                          onChange={() => select(index, chooseOption(question, selection, option.label))}
                        />
                        <span>
                          <strong>{option.label}</strong>
                          {option.description ? <em>{option.description}</em> : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
              ) : null}

              {freeText ? (
                <label className="question-other">
                  <span>{question.options?.length ? 'Outra resposta' : 'Sua resposta'}</span>
                  <input
                    value={selection.other}
                    onChange={(event) => select(index, typeOther(question, selection, event.target.value))}
                    placeholder={question.options?.length ? 'Escreva se nenhuma opção serve' : 'Digite a resposta'}
                    spellCheck={false}
                  />
                </label>
              ) : null}

              <div className="question-attachments">
                {selection.attachments.map((attachment) => (
                  <span key={attachment.id} className="question-attachment" title={attachment.path}>
                    <Icon name={attachment.kind === 'folder' ? 'folder' : 'file'} size={11} />
                    <span>{attachment.name}</span>
                    <button
                      type="button"
                      className="question-attachment-remove"
                      onClick={() => removeAttachment(index, attachment.id)}
                      aria-label={`Remover ${attachment.name}`}
                      title="Remover anexo"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button type="button" className="question-attach" onClick={() => pickFiles(index)}>
                  <Icon name="paperclip" size={12} /> Anexar arquivo
                </button>
                <button type="button" className="question-attach" onClick={() => void pickFolder(index)}>
                  <Icon name="folder" size={12} /> Pasta
                </button>
              </div>
            </section>
          )
        })}

        <p className="question-attach-hint">
          Aceita imagens, PDFs, documentos, planilhas e qualquer arquivo: o agente recebe o caminho e lê sob demanda.
        </p>

        <div className="question-actions">
          {attachError ? <span className="question-error">{attachError}</span> : null}
          <button type="button" className="btn ghost" onClick={() => onSkip(request.id)}>
            Pular
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!complete}
            onClick={() => onAnswer(request.id, buildAnswers(request.questions, selections))}
          >
            <Icon name="send" size={12} /> Enviar respostas
          </button>
        </div>
        {!complete ? <span className="question-hint">Responda todas as perguntas, anexe um arquivo ou clique em Pular.</span> : null}
        <input ref={fileRef} type="file" multiple hidden onChange={onFileChange} />
      </div>
    </div>
  )
}
