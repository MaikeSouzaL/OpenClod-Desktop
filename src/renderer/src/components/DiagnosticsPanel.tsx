import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DiagnosticExportInfo, ObservabilityViewInfo } from '../../../shared/api'
import { errorMessage, unwrap } from '../lib/api'
import { Icon } from './Icons'

function duration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
  return `${(value / 60_000).toFixed(1)} min`
}

function number(value: number): string {
  return new Intl.NumberFormat('pt-BR').format(value)
}

export function DiagnosticsPanel(): ReactElement {
  const [data, setData] = useState<ObservabilityViewInfo | null>(null)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('')
  const [type, setType] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exported, setExported] = useState<DiagnosticExportInfo | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setData(await unwrap(window.openclod.app.observability({
        query: query || undefined,
        level: level || undefined,
        type: type || undefined,
        limit: 500
      })))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [level, query, type])

  useEffect(() => {
    void load()
  }, [load])

  const exportBundle = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setExported(await unwrap(window.openclod.app.exportDiagnostics()))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-head">
        <div>
          <h3>Observabilidade e diagnóstico</h3>
          <p className="field-help">
            Eventos correlacionados por sessão, turno e ferramenta. Prompts, saídas de arquivos, chaves e caminhos
            pessoais não entram no pacote por padrão.
          </p>
        </div>
        <div className="diagnostics-actions">
          <button type="button" className="btn small ghost" onClick={() => void load()} disabled={busy}>
            <Icon name="refresh" size={13} /> Atualizar
          </button>
          <button type="button" className="btn small primary" onClick={() => void exportBundle()} disabled={busy}>
            <Icon name="download" size={13} /> Exportar diagnóstico
          </button>
        </div>
      </div>

      {error ? <div className="inline-error"><Icon name="alert" size={14} /> {error}</div> : null}
      {exported ? (
        <div className="diagnostics-exported">
          <Icon name="checkCircle" size={14} />
          <span>Pacote criado em {exported.path} · {number(exported.bytes)} bytes · SHA-256 {exported.sha256.slice(0, 16)}…</span>
        </div>
      ) : null}

      {!data ? <div className="field-note">{busy ? 'Coletando métricas…' : 'Sem dados de diagnóstico.'}</div> : (
        <>
          <div className="diagnostics-metrics">
            {[
              ['Sessões', number(data.snapshot.sessionCount), 'active'],
              ['Turnos', number(data.snapshot.turnCount), `${data.snapshot.failedTurns} falha(s)`],
              ['Ferramentas', number(data.snapshot.toolCalls), `${data.snapshot.failedToolCalls} falha(s)`],
              ['Tokens', number(data.snapshot.inputTokens + data.snapshot.outputTokens), `${number(data.snapshot.cachedTokens)} em cache`],
              ['Tempo ativo', duration(data.snapshot.uptimeMs), `${data.snapshot.activeTurns} tarefa(s) ativa(s)`],
              ['Custo', `US$ ${data.snapshot.costUsd.toFixed(4)}`, 'quando informado']
            ].map(([label, value, detail]) => (
              <div className="diagnostic-metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>

          <h4>Saúde dos componentes</h4>
          <div className="health-grid">
            {data.health.components.map((component) => (
              <div className={`health-card status-${component.status}`} key={component.id}>
                <span className="health-dot" />
                <div>
                  <strong>{component.label}</strong>
                  <small>{component.detail}</small>
                </div>
              </div>
            ))}
          </div>

          <h4>Ferramentas mais usadas</h4>
          <div className="tool-metrics">
            {data.snapshot.tools.length ? data.snapshot.tools.slice(0, 10).map((tool) => (
              <div className="tool-metric-row" key={tool.name}>
                <code>{tool.name}</code>
                <span>{tool.total} chamada(s)</span>
                <span>{tool.failures} falha(s)</span>
                <span>média {duration(tool.averageMs)}</span>
                <span>máx. {duration(tool.maxMs)}</span>
              </div>
            )) : <div className="field-note">Nenhuma ferramenta executada nesta instalação.</div>}
          </div>

          <h4>Eventos correlacionados</h4>
          <div className="diagnostics-filters">
            <label className="field grow">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por evento, ferramenta ou sessão" />
            </label>
            <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Nível do evento">
              <option value="">Todos os níveis</option>
              <option value="info">Info</option>
              <option value="warn">Aviso</option>
              <option value="error">Erro</option>
            </select>
            <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Tipo do evento">
              <option value="">Todos os tipos</option>
              <option value="tool_start">Início de ferramenta</option>
              <option value="tool_end">Fim de ferramenta</option>
              <option value="turn_start">Início de turno</option>
              <option value="turn_end">Fim de turno</option>
              <option value="usage">Tokens</option>
              <option value="audit">Auditoria</option>
              <option value="notice">Aviso</option>
              <option value="log">Log</option>
            </select>
            <button type="button" className="btn small subtle" onClick={() => void load()} disabled={busy}>Filtrar</button>
          </div>
          <div className="diagnostic-events">
            {data.events.length ? data.events.map((event) => (
              <div className={`diagnostic-event level-${event.level}`} key={event.id}>
                <span className="event-time">{new Date(event.ts).toLocaleTimeString('pt-BR')}</span>
                <span className="event-type">{event.type}</span>
                <span className="event-name">{event.name ?? event.sessionId ?? 'sistema'}</span>
                <span className="event-detail">{event.detail ?? event.metadata?.state as string ?? ''}</span>
                <span className="event-duration">{event.durationMs === undefined ? '' : duration(event.durationMs)}</span>
              </div>
            )) : <div className="field-note">Nenhum evento corresponde aos filtros.</div>}
          </div>
        </>
      )}
    </div>
  )
}
