import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Message, RunState, ToolCallPart, ToolResultPart } from '../../../shared/types'
import { Icon } from './Icons'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { EditCard } from './EditCard'
import { LimitationCard } from './LimitationCard'
import { QuestionCard } from './QuestionCard'
import { OpenclodMark } from './Chrome'
import { buildAssistantBlocks, isEditCall, isLimitationCall, isPlanCall, isQuestionCall, summarizeCalls, type AssistantBlock } from '../lib/groups'
import { formatDuration, type ActivityEntry } from '../lib/activity'
import { SPEECH_FALLBACK, speechText } from '../lib/speech'
import type { LiveTool } from '../lib/types'

interface TranscriptProps {
  /** Resets the scroll anchor when the user opens another session. */
  sessionId: string
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
/**
 * Screenshots are conversation content, not a hidden tool detail: show the
 * image inline in the transcript, even when the tool group is collapsed.
 */
function ScreenshotCard({
  result,
  onOpen
}: {
  result: ToolResultPart
  onOpen(src: string, alt: string): void
}): ReactElement | null {
  if (!result.images?.length) return null
  return (
    <figure className="chat-shot">
      <div className="chat-shot-images">
        {result.images.map((image, index) => {
          const src = `data:${image.mediaType};base64,${image.data}`
          const alt = image.label ?? 'Captura de tela'
          return (
            <button key={index} type="button" className="chat-shot-image" onClick={() => onOpen(src, alt)}>
              <img src={src} alt={alt} title={`${alt} — clique para ampliar`} loading="lazy" />
            </button>
          )
        })}
      </div>
      <figcaption>
        <Icon name="camera" size={12} />
        <span>Captura de tela</span>
        {result.detail ? <em>{result.detail}</em> : null}
      </figcaption>
    </figure>
  )
}

function ToolGroup({
  calls,
  results,
  tools,
  onOpenImage
}: {
  calls: ToolCallPart[]
  results: Map<string, ToolResultPart>
  tools: Record<string, LiveTool>
  onOpenImage(src: string, alt: string): void
}): ReactElement {
  const limitations = calls.filter((call) => isLimitationCall(call.name))
  const questions = calls.filter((call) => isQuestionCall(call.name))
  const edits = calls.filter((call) => isEditCall(call.name))
  const screenshots = calls.filter((call) => Boolean(results.get(call.id)?.images?.length))
  const screenshotIds = new Set(screenshots.map((call) => call.id))
  const others = calls.filter(
    (call) =>
      !screenshotIds.has(call.id) &&
      !isEditCall(call.name) &&
      !isPlanCall(call.name) &&
      !isLimitationCall(call.name) &&
      !isQuestionCall(call.name)
  )
  const failed = others.filter((call) => {
    const result = results.get(call.id)
    const live = tools[call.id]
    return (result && !result.ok) || live?.ok === false
  }).length
  const running = others.some((call) => tools[call.id]?.running)
  return (
    <>
      {limitations.map((call) => (
        <LimitationCard key={call.id} args={call.args} result={results.get(call.id)} />
      ))}
      {questions.map((call) => (
        <QuestionCard key={call.id} args={call.args} result={results.get(call.id)} />
      ))}
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
      {screenshots.map((call) => (
        <ScreenshotCard key={`shot-${call.id}`} result={results.get(call.id)!} onOpen={onOpenImage} />
      ))}
    </>
  )
}

/**
 * A select-like disclosure for the model's thinking. While streaming it stays
 * open and spins; once the turn is stored it collapses and clicking reveals
 * exactly what the model thought, including reasoning from earlier iterations
 * folded into the same block.
 */
function ReasoningDisclosure({ text, live = false }: { text: string; live?: boolean }): ReactElement | null {
  if (!text.trim()) return null
  return (
    <details className={`reasoning${live ? ' live' : ''}`} open={live || undefined}>
      <summary title={live ? 'O modelo está raciocinando agora' : 'Clique para ver o que o modelo pensou'}>
        <span className={`reasoning-star${live ? ' spin' : ''}`}>
          <OpenclodMark size={13} />
        </span>
        <span className="reasoning-title">{live ? 'Raciocinando' : 'Pensamento'}</span>
        {live ? <span className="reasoning-now">agora</span> : null}
        <Icon name="chevron" size={12} className="reasoning-chevron" />
      </summary>
      <pre>{text}</pre>
    </details>
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

export function Transcript({
  sessionId,
  messages,
  streaming,
  reasoning,
  tools,
  runState,
  agents,
  onOpenTasks
}: TranscriptProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  /** The message whose voice is still being made (the neural voice takes a few seconds to synthesize). */
  const ttsPendingRef = useRef<string | null>(null)
  /** True while the viewport follows the newest message. */
  const pinned = useRef(true)
  const [following, setFollowing] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null)
  const [clock, setClock] = useState(Date.now())
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

  // System messages are for the user only (a model switch, for instance) and are shown as a line in the conversation.
  const visible = useMemo(
    () => messages.filter((message) => !message.hidden && (message.role !== 'system' || Boolean(message.notice))),
    [messages]
  )
  const blocks = useMemo(() => buildAssistantBlocks(visible), [visible])
  // Live label for the status line: what is running right now.
  const runningTools = Object.values(tools).filter((tool) => tool.running)
  const runningNames = runningTools.map((tool) => tool.name)
  const oldestRunning = runningTools.reduce<LiveTool | null>(
    (oldest, tool) => (!oldest || (tool.startedAt ?? 0) < (oldest.startedAt ?? 0) ? tool : oldest),
    null
  )
  const runningFor = oldestRunning?.startedAt ? clock - oldestRunning.startedAt : 0
  const silentFor = oldestRunning ? clock - (oldestRunning.updatedAt ?? oldestRunning.startedAt ?? clock) : 0
  const workingLabel = runningNames.length
    ? `${summarizeCalls(runningNames, true)}${oldestRunning?.startedAt ? ` · ${formatDuration(runningFor)}` : ''}${
        silentFor > 5000 ? ` · sem saída há ${formatDuration(silentFor)}` : ''
      }…`
    : runState === 'tool'
      ? 'Executando ferramenta…'
      : 'Pensando…'

  useEffect(() => {
    if (!runningTools.length) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runningTools.length])

  useLayoutEffect(() => {
    if (!pinned.current) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [sessionId, messages.length, streamingText, reasoningText, runState, runningNames.length])

  // Opening another session starts at the newest message, even if the user
  // had scrolled up in the previous one.
  useLayoutEffect(() => {
    pinned.current = true
    setFollowing(true)
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [sessionId])

  // Images, code blocks and tool cards can grow after paint. Keep the view
  // anchored to the bottom only while the user is following it.
  useEffect(() => {
    const node = scrollRef.current
    const thread = threadRef.current
    if (!node || !thread || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinned.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(thread)
    return () => observer.disconnect()
  }, [])

  useEffect(() => window.forja.tts.onEvent((event) => {
    // The "idle" that ends the synthesis arrives just before the audio does: the button stays on "Parar" until then.
    if ((event.phase === 'idle' || event.phase === 'error') && !ttsPendingRef.current) setSpeakingId(null)
  }), [])

  useEffect(() => () => {
    const audio = ttsAudioRef.current
    if (audio) {
      audio.pause()
      audio.src = ''
    }
    ttsAudioRef.current = null
  }, [])

  const onScroll = (): void => {
    const node = scrollRef.current
    if (!node) return
    const next = node.scrollHeight - node.scrollTop - node.clientHeight < 48
    pinned.current = next
    setFollowing(next)
  }

  // The wheel event fires before the scroll event. Detaching here makes a
  // single upward wheel tick enough to stop the auto-follow, instead of
  // fighting the next streaming update.
  const onWheel = (event: { deltaY: number }): void => {
    if (event.deltaY < 0 && pinned.current) {
      pinned.current = false
      setFollowing(false)
    }
  }

  // Capture phase: Escape closes the image before the app closes the side panel.
  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPreview(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [preview])

  const jumpToLatest = (): void => {
    const node = scrollRef.current
    if (!node) return
    pinned.current = true
    setFollowing(true)
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
  }

  const copy = async (id: string, text: string): Promise<void> => {
    if (await copyText(text)) {
      setCopied(id)
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    }
  }

  const speak = async (id: string, text: string): Promise<void> => {
    if (speakingId === id) {
      // A second click on the message that is being read, or whose voice is still being made, stops it.
      ttsPendingRef.current = null
      ttsAudioRef.current?.pause()
      if (ttsAudioRef.current) ttsAudioRef.current.src = ''
      ttsAudioRef.current = null
      setSpeakingId(null)
      await window.forja.tts.stop()
      return
    }
    ttsAudioRef.current?.pause()
    if (ttsAudioRef.current) ttsAudioRef.current.src = ''
    ttsAudioRef.current = null
    // At once, not when the audio is ready: the button turns into "Parar leitura" so a second click means "stop"
    // instead of restarting the synthesis (which used to kill it and drop to the Windows voice).
    ttsPendingRef.current = id
    setSpeakingId(id)
    try {
      await window.forja.tts.stop()
      const settings = await window.forja.app.settings()
      const voice = settings.ok ? settings.value.voice : undefined
      const result = await window.forja.tts.speak({
        text,
        provider: voice?.ttsProvider ?? 'edge',
        voice: voice?.ttsVoice,
        rate: voice?.ttsRate,
        volume: voice?.ttsVolume
      })
      // Stopped, or replaced by another message, while the voice was being made: that request owns the button now.
      if (ttsPendingRef.current !== id) return
      if (!result.ok || result.value.cancelled) {
        setSpeakingId(null)
        return
      }
      if (result.value.audioBase64) {
        const audio = new Audio(`data:${result.value.mediaType ?? 'audio/mpeg'};base64,${result.value.audioBase64}`)
        audio.volume = Math.max(0, Math.min(1, (voice?.ttsVolume ?? 100) / 100))
        audio.onended = () => {
          if (ttsAudioRef.current === audio) {
            ttsAudioRef.current = null
            setSpeakingId(null)
          }
        }
        audio.onerror = () => {
          if (ttsAudioRef.current === audio) {
            ttsAudioRef.current = null
            setSpeakingId(null)
          }
        }
        ttsAudioRef.current = audio
        await audio.play()
      } else {
        // The Windows voice speaks on its own; an "idle" that came while this was pending was not applied, so ask.
        const status = await window.forja.tts.status()
        if (ttsPendingRef.current === id && status.ok && (status.value.phase === 'idle' || status.value.phase === 'error')) setSpeakingId(null)
      }
    } catch {
      if (ttsPendingRef.current === id) setSpeakingId(null)
    } finally {
      if (ttsPendingRef.current === id) ttsPendingRef.current = null
    }
  }

  const renderAssistant = (block: AssistantBlock): ReactElement => {
    const { message, text, calls, reasoning, limitations } = block
    return (
      <article key={message.id} className="message assistant">
        <ReasoningDisclosure text={reasoning} />
        {text ? <Markdown text={text} /> : null}
        {limitations.map((part, index) => (
          <LimitationCard key={`${message.id}-limitation-${index}`} report={part.report} recorded />
        ))}
        {message.error ? (
          <div className="message-error">
            <Icon name="alert" size={14} /> {message.error}
          </div>
        ) : null}
        {calls.length ? (
          <ToolGroup
            calls={calls}
            results={results}
            tools={tools}
            onOpenImage={(src, alt) => setPreview({ src, alt })}
          />
        ) : null}
        {text ? (
          <div className="message-tools">
            <button type="button" className="msg-action" title="Copiar" onClick={() => void copy(message.id, text)}>
              <Icon name={copied === message.id ? 'check' : 'copy'} size={13} />
            </button>
            <button
              type="button"
              className={`msg-action ${speakingId === message.id ? 'is-speaking' : ''}`}
              title={speakingId === message.id ? 'Parar leitura' : 'Ler em voz alta'}
              onClick={() => void speak(message.id, speechText(text) || SPEECH_FALLBACK)}
            >
              <Icon name={speakingId === message.id ? 'stop' : 'audioLines'} size={13} />
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
    <div className="transcript" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
      <div className="thread" ref={threadRef}>
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
          if (message.role === 'system' && message.notice) {
            return (
              <div key={message.id} className={`transcript-notice is-${message.notice.level}`} role="status" data-notice={message.notice.kind}>
                <Icon name="refresh" size={13} />
                <span>{message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(' ')}</span>
              </div>
            )
          }
          if (message.role !== 'user') return null
          const { text, images } = userParts(message)
          return (
            <article key={message.id} className="message user">
              <div className="user-bubble">
                {text ? <Markdown text={text} /> : null}
                {images.length ? (
                  <div className="message-images">
                    {images.map((image, index) => {
                      if (image.type !== 'image') return null
                      const src = `data:${image.mediaType};base64,${image.data}`
                      const alt = image.label ?? 'imagem colada'
                      return (
                        <button
                          key={index}
                          type="button"
                          className="message-image-button"
                          onClick={() => setPreview({ src, alt })}
                        >
                          <img src={src} alt={alt} title="Clique para ampliar" />
                        </button>
                      )
                    })}
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
            <ReasoningDisclosure text={reasoningText} live />
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
      {!following && visible.length ? (
        <div className="scroll-bottom-dock">
          <button
            type="button"
            className="scroll-bottom"
            onClick={jumpToLatest}
            title="Ir para as mensagens novas"
            aria-label="Ir para as mensagens novas"
          >
            <Icon name="chevronDown" size={16} />
          </button>
        </div>
      ) : null}
      {preview ? (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt}
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            className="image-lightbox-close"
            aria-label="Fechar imagem"
            onClick={() => setPreview(null)}
          >
            <Icon name="x" size={18} />
          </button>
          <img src={preview.src} alt={preview.alt} onClick={(event) => event.stopPropagation()} />
          <span className="image-lightbox-caption">{preview.alt}</span>
        </div>
      ) : null}
    </div>
  )
}
