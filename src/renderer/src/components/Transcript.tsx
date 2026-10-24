import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Message, RunState, ToolCallPart, ToolResultPart } from '../../../shared/types'
import { Icon } from './Icons'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { EditCard } from './EditCard'
import { OpenclodMark } from './Chrome'
import { buildAssistantBlocks, isEditCall, isPlanCall, summarizeCalls, type AssistantBlock } from '../lib/groups'
import { formatDuration, type ActivityEntry } from '../lib/activity'
import type { LiveTool } from '../lib/types'

interface TranscriptProps {
  messages: Message[]
  streaming: Record<string, string>
  reasoning: Record<string, string>
  tools: Record<string, LiveTool>
  runState: RunState
  /** Agents from the activity tracker; shown as a strip that opens the tasks panel. */
  agents: ActivityEntry[]
  onOpenTasks(): void
}

/**
 * A run of tool calls as one summary line ("Executou 3 comandos, leu 2 arquivos")
 * that expands into the individual cards. Edits get their own diff card instead.
 */
function ToolGroup({
  calls,
  results,
  tools
}: {
  calls: ToolCallPart[]
  results: Map<string, ToolResultPart>
  tools: Record<string, LiveTool>
}): ReactElement {
  const edits = calls.filter((call) => isEditCall(call.name))
  const others = calls.filter((call) => !isEditCall(call.name) && !isPlanCall(call.name))
  const failed = others.filter((call) => {
    const result = results.get(call.id)
    const live = tools[call.id]
    return (result && !result.ok) || live?.ok === false
  }).length
  const running = others.some((call) => tools[call.id]?.running)
  return (
    <>
      {edits.map((call) => (
        <EditCard key={call.id} name={call.name} args={call.args} result={results.get(call.id)} live={tools[call.id]} />
      ))}
      {others.length ? (
        <details className={`tool-group ${failed ? 'has-failure' : ''} ${running ? 'is-running' : ''}`}>
          <summary>
            <span className="tool-group-icon">{running ? <span className="spinner tiny" /> : null}</span>
            <span className="tool-group-text">
              {summarizeCalls(
                others.map((call) => call.name),
                running
              )}
              {running ? '…' : ''}
            </span>
            {failed ? (
              <em className="tool-group-fail">
                {failed} falha{failed > 1 ? 's' : ''}
              </em>
            ) : null}
            <Icon name="chevronRight" size={13} className="tool-group-chevron" />
          </summary>
          <div className="tool-group-body">
            {others.map((call) => (
              <ToolCard key={call.id} name={call.name} args={call.args} result={results.get(call.id)} live={tools[call.id]} />
            ))}
          </div>
        </details>
      ) : null}
    </>
  )
}

function userParts(message: Message): { text: string; images: Message['parts'] } {
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim()
  return { text, images: message.parts.filter((part) => part.type === 'image') }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

function stamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function Transcript({ messages, streaming, reasoning, tools, runState, agents, onOpenTasks }: TranscriptProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [copied, setCopied] = useState<string | null>(null)
  const streamingText = Object.values(streaming).join('')
  const reasoningText = Object.values(reasoning).join('')

  const results = useMemo(() => {
    const map = new Map<string, ToolResultPart>()
    for (const message of messages) {
      if (message.role !== 'tool') continue
      for (const part of message.parts) {
        if (part.type === 'tool_result') map.set(part.toolCallId, part)
      }
    }
    return map
  }, [messages])

  const visible = useMemo(() => messages.filter((message) => !message.hidden && message.role !== 'system'), [messages])
  const blocks = useMemo(() => buildAssistantBlocks(visible), [visible])
  // Live label for the status line: what is running right now.
  const runningNames = Object.values(tools)
    .filter((tool) => tool.running)
    .map((tool) => tool.name)
  const workingLabel = runningNames.length ? `${summarizeCalls(runningNames, true)}…` : runState === 'tool' ? 'Executando ferramenta…' : 'Pensando…'

  useEffect(() => {
    if (!pinned.current) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, streamingText, reasoningText, runState, runningNames.length])

  const onScroll = (): void => {
    const node = scrollRef.current
    if (!node) return
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
  }

  const copy = async (id: string, text: string): Promise<void> => {
    if (await copyText(text)) {
      setCopied(id)
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    }
  }

  const renderAssistant = (block: AssistantBlock): ReactElement => {
    const { message, text, calls } = block
    return (
      <article key={message.id} className="message assistant">
        {text ? <Markdown text={text} /> : null}
        {message.error ? (
          <div className="message-error">
            <Icon name="alert" size={14} /> {message.error}
          </div>
        ) : null}
        {calls.length ? <ToolGroup calls={calls} results={results} tools={tools} /> : null}
        {text ? (
          <div className="message-tools">
            <button type="button" className="msg-action" title="Copiar" onClick={() => void copy(message.id, text)}>
              <Icon name={copied === message.id ? 'check' : 'copy'} size={13} />
            </button>
            {message.usage ? (
              <span className="msg-time" title="Tokens de entrada e saída">
                {Math.round((message.usage.input + message.usage.output) / 1000)}k tokens
              </span>
            ) : (
              <span className="msg-time">{stamp(message.ts)}</span>
            )}
          </div>
        ) : null}
      </article>
    )
  }

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="thread">
        {agents.length ? (
          <button type="button" className="subagent-strip" onClick={onOpenTasks} title="Abrir as tarefas em segundo plano">
            {agents.slice(-6).map((agent) => (
              <span key={agent.id} className={`subagent-chip status-${agent.status}`}>
                {agent.status === 'running' ? <span className="spinner tiny" /> : <Icon name="bot" size={12} />} {agent.title}
                <em>
                  {agent.status === 'running' ? formatDuration(Date.now() - agent.startedAt) : agent.status === 'failed' ? 'falhou' : 'concluído'}
                </em>
              </span>
            ))}
          </button>
        ) : null}

        {!visible.length ? (
          <div className="thread-empty">
            <span className="thread-empty-mark">
              <OpenclodMark size={26} />
            </span>
            <h2>O que vamos forjar?</h2>
            <p>Peça uma tarefa. O agente lê o projeto, edita arquivos, roda comandos, navega ou controla o Windows.</p>
            <div className="thread-examples">
              <span>Encontre por que o login falha e corrija com teste.</span>
              <span>Leia a documentação da API e gere o cliente TypeScript.</span>
              <span>Abra o Bloco de Notas e escreva uma nota de teste.</span>
            </div>
          </div>
        ) : null}

        {blocks.map((block) => {
          if (!('passthrough' in block)) return renderAssistant(block)
          const { message } = block
          if (message.role !== 'user') return null
          const { text, images } = userParts(message)
          return (
            <article key={message.id} className="message user">
              <div className="user-bubble">
                {text ? <Markdown text={text} /> : null}
                {images.length ? (
                  <div className="message-images">
                    {images.map((image, index) =>
                      image.type === 'image' ? (
                        <img key={index} src={`data:${image.mediaType};base64,${image.data}`} alt={image.label ?? 'imagem colada'} />
                      ) : null
                    )}
                  </div>
                ) : null}
              </div>
              <div className="message-tools">
                <button type="button" className="msg-action" title="Copiar mensagem" onClick={() => void copy(message.id, text)}>
                  <Icon name={copied === message.id ? 'check' : 'copy'} size={13} />
                </button>
                <span className="msg-time">{stamp(message.ts)}</span>
              </div>
            </article>
          )
        })}

        {streamingText || reasoningText ? (
          <article className="message assistant streaming">
            {reasoningText ? (
              <details className="reasoning" open>
                <summary>
                  <span className="reasoning-star spin">
                    <OpenclodMark size={13} />
                  </span>
                  Raciocinando…
                </summary>
                <pre>{reasoningText}</pre>
              </details>
            ) : null}
            {streamingText ? (
              <Markdown text={streamingText} />
            ) : (
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            )}
          </article>
        ) : null}

        {runState === 'thinking' || runState === 'tool' ? (
          <div className="status-line">
            <span className="status-mark spin">
              <OpenclodMark size={14} />
            </span>
            <span className="shimmer">{workingLabel}</span>
          </div>
        ) : null}

        <div className="transcript-end" />
      </div>
    </div>
  )
}
