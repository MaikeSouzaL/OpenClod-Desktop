import { useMemo, useState, type ReactElement } from 'react'
import type { ContentPart, SessionState } from '../../../shared/types'
import { Icon } from './Icons'

function messageText(parts: ContentPart[]): string {
  const text = parts.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'tool_call') return `[ferramenta ${part.name}]`
    if (part.type === 'tool_result') return `[${part.ok ? 'resultado' : 'falha'} ${part.name}] ${part.text}`
    if (part.type === 'reasoning') return '[raciocínio]'
    if (part.type === 'image') return `[imagem ${part.label ?? part.mediaType}]`
    return ''
  }).filter(Boolean).join(' ')
  return text.replace(/\s+/g, ' ').trim()
}

export function RewindDialog({
  session,
  onClose,
  onRewind,
  onFork
}: {
  session: SessionState
  onClose(): void
  onRewind(messageId: string, restoreFiles?: boolean): Promise<boolean>
  onFork(messageId: string): Promise<boolean>
}): ReactElement {
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [restoreFiles, setRestoreFiles] = useState(false)
  const messages = useMemo(() => {
    const q = query.trim().toLowerCase()
    return session.messages
      .filter((message) => !message.hidden && message.role !== 'system' && message.role !== 'tool')
      .map((message, index) => ({ message, index, text: messageText(message.parts) }))
      .filter((entry) => !q || entry.text.toLowerCase().includes(q))
  }, [session.messages, query])

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal rewind-modal" role="dialog" aria-modal="true" aria-label="Voltar conversa a uma mensagem">
        <header className="modal-head">
          <div>
            <h2>Voltar conversa a uma mensagem</h2>
            <p>Volte a este ponto ou crie um chat lateral. Arquivos alterados não são revertidos.</p>
          </div>
          <button type="button" className="icon-btn small" onClick={onClose} title="Fechar"><Icon name="x" size={14} /></button>
        </header>
        <div className="modal-body rewind-body">
          <div className="panel-search">
            <Icon name="search" size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar mensagens por texto" spellCheck={false} />
          </div>
          <label className="rewind-restore-option">
            <input type="checkbox" checked={restoreFiles} onChange={(event) => setRestoreFiles(event.target.checked)} />
            Restaurar também os arquivos do checkpoint Git, quando disponível
          </label>
          {!messages.length ? <div className="page-empty compact">Nenhuma mensagem visível para voltar.</div> : null}
          <div className="rewind-list">
            {messages.map(({ message, index, text }) => (
              <div key={message.id} className={`rewind-row role-${message.role}`}>
                <span className="rewind-index">{index + 1}</span>
                <span className="rewind-copy">
                  <strong>{message.role === 'user' ? 'Você' : 'Openclod'}</strong>
                  <small>{text || '(sem texto)'}</small>
                </span>
                <span className="rewind-actions">
                  {busy === message.id ? <span className="spinner tiny" /> : (
                    <>
                      <button type="button" className="btn tiny ghost" disabled={busy !== null} onClick={async () => {
                        if (!window.confirm(restoreFiles
                          ? 'Voltar e restaurar os arquivos deste checkpoint? Um backup do estado atual será criado antes da restauração.'
                          : 'Voltar a esta mensagem? As mensagens posteriores serão removidas. Os arquivos atuais permanecerão no disco.')) return
                        setBusy(message.id)
                        await onRewind(message.id, restoreFiles)
                        setBusy(null)
                      }}><Icon name="rotate" size={11} /> Voltar</button>
                      <button type="button" className="btn tiny ghost" disabled={busy !== null} onClick={async () => {
                        setBusy(message.id)
                        await onFork(message.id)
                        setBusy(null)
                      }}><Icon name="gitBranch" size={11} /> Chat lateral</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
