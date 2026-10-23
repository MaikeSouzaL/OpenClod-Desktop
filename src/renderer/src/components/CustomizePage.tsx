import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { AppSettings, CapabilityReport, HookEvent, McpServerSettings, SkillInfo } from '../../../shared/types'
import type { McpPresetEntry } from '../../../shared/api'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'
import type { SettingsTab } from './SettingsDialog'

type CustomizeTab = 'skills' | 'connectors' | 'hooks'

const HOOK_LABELS: Partial<Record<HookEvent, string>> = {
  PreToolUse: 'Antes de cada ferramenta',
  PostToolUse: 'Depois de cada ferramenta',
  UserPromptSubmit: 'Ao enviar uma mensagem',
  Stop: 'Ao terminar a resposta',
  SubagentStop: 'Ao terminar um subagente',
  SessionStart: 'Ao iniciar a sessão',
  PreCompact: 'Antes de compactar',
  PostCompact: 'Depois de compactar',
  SessionEnd: 'Ao encerrar a sessão',
  Notification: 'Notificações'
}

function NewSkillForm({ onCreated, onCancel }: { onCreated(skill: SkillInfo): void; onCancel(): void }): ReactElement {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      onCreated(await unwrap(window.forja.app.createSkill(name.trim(), description.trim(), body)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="skill-form">
      {error ? <div className="inline-error">{error}</div> : null}
      <label>
        Nome (letras minúsculas e hífens)
        <input value={name} onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="revisar-pr" />
      </label>
      <label>
        Quando usar (descrição que o agente lê para decidir)
        <input value={description} maxLength={400} onChange={(event) => setDescription(event.target.value)} placeholder="Use ao revisar um pull request: checa testes, segurança e estilo." />
      </label>
      <label>
        Instruções
        <textarea value={body} rows={8} onChange={(event) => setBody(event.target.value)} placeholder={'1. Leia o diff completo.\n2. Rode os testes.\n3. Liste os problemas por gravidade.'} />
      </label>
      <div className="skill-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancelar
        </button>
        <button type="button" className="btn primary" disabled={saving || name.length < 2 || !description.trim()} onClick={() => void save()}>
          {saving ? 'Criando…' : 'Criar skill'}
        </button>
      </div>
    </div>
  )
}

interface CustomizePageProps {
  settings: AppSettings | null
  capabilities: CapabilityReport | null
  onOpenSettings(tab: SettingsTab): void
  onRestartMcp(): Promise<void>
  onSaveMcpServers(servers: McpServerSettings[]): Promise<void>
}

export function CustomizePage({ settings, capabilities, onOpenSettings, onRestartMcp, onSaveMcpServers }: CustomizePageProps): ReactElement {
  const [presets, setPresets] = useState<McpPresetEntry[]>([])
  const [tab, setTab] = useState<CustomizeTab>('skills')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'usuario' | 'projeto'>('all')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [restarting, setRestarting] = useState(false)

  const loadSkills = useCallback(async (): Promise<void> => {
    try {
      setSkills(await unwrap(window.forja.app.skills()))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    void window.forja.app.mcpPresets().then((result) => result.ok && setPresets(result.value))
  }, [])

  const addPreset = async (preset: McpPresetEntry): Promise<void> => {
    if (!preset.server) return
    try {
      await onSaveMcpServers([...(settings?.mcpServers ?? []).filter((server) => server.name !== preset.server!.name), preset.server])
      setNotice(`"${preset.label}" adicionado. As ferramentas ficam disponíveis nas próximas mensagens (modos Código, Depurar, Autônomo, Web e Computador).`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills
      .filter((skill) => source === 'all' || skill.source === source)
      .filter((skill) => !q || skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [skills, query, source])

  const servers = settings?.mcpServers ?? []
  const status = capabilities?.mcp ?? []
  const hooks = settings?.hooks ?? {}
  const hookEvents = Object.entries(hooks).filter(([, matchers]) => Array.isArray(matchers) && matchers.length) as Array<[HookEvent, NonNullable<AppSettings['hooks']>[HookEvent]]>

  return (
    <div className="page">
      <header className="page-head">
        <h1>Personalização</h1>
      </header>
      <div className="page-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>
          <Icon name="sparkles" size={14} /> Skills
        </button>
        <button type="button" role="tab" aria-selected={tab === 'connectors'} className={tab === 'connectors' ? 'active' : ''} onClick={() => setTab('connectors')}>
          <Icon name="plug" size={14} /> Conectores
        </button>
        <button type="button" role="tab" aria-selected={tab === 'hooks'} className={tab === 'hooks' ? 'active' : ''} onClick={() => setTab('hooks')}>
          <Icon name="hammer" size={14} /> Hooks
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {notice ? <div className="panel-note">{notice}</div> : null}

      {tab === 'skills' ? (
        <>
          <p className="page-lead">
            Skills são instruções reutilizáveis (um <code>SKILL.md</code> por pasta). O agente vê o nome e a descrição de cada uma e carrega o conteúdo com{' '}
            <code>use_skill</code> quando a tarefa pede. Elas ficam na pasta de skills do usuário (botão Pasta); skills por projeto ainda não são carregadas.
          </p>
          <div className="page-tools">
            <div className="page-search">
              <Icon name="search" size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Procurar skills" spellCheck={false} />
            </div>
            <label className="page-sort">
              Origem
              <select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
                <option value="all">Todas</option>
                <option value="usuario">Minhas</option>
              </select>
            </label>
            <button type="button" className="btn subtle" onClick={() => void window.forja.app.openSkillsFolder()}>
              <Icon name="folderOpen" size={13} /> Pasta
            </button>
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={13} /> Adicionar
            </button>
          </div>
          {creating ? (
            <NewSkillForm
              onCancel={() => setCreating(false)}
              onCreated={(skill) => {
                setCreating(false)
                setNotice(`Skill "${skill.name}" criada. Ela já aparece para o agente nas próximas mensagens.`)
                void loadSkills()
              }}
            />
          ) : null}
          {visibleSkills.length ? (
            <div className="card-grid">
              {visibleSkills.map((skill) => (
                <div key={`${skill.source}:${skill.name}`} className="info-card">
                  <div className="info-card-head">
                    <Icon name="sparkles" size={14} />
                    <strong>{skill.name}</strong>
                    <span className="badge">{skill.source === 'projeto' ? 'projeto' : 'minha'}</span>
                  </div>
                  <p>{skill.description || 'Sem descrição.'}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="page-empty compact">
              <Icon name="sparkles" size={24} />
              <p>{skills.length ? 'Nenhuma skill corresponde ao filtro.' : 'Nenhuma skill instalada. Crie a primeira com "Adicionar".'}</p>
            </div>
          )}
        </>
      ) : null}

      {tab === 'connectors' ? (
        <>
          <p className="page-lead">
            Conectores são servidores MCP locais. Cada ferramenta que eles expõem passa pela mesma política de permissões das ferramentas nativas.
          </p>
          <div className="page-tools">
            <span className="page-tools-spacer" />
            <button
              type="button"
              className="btn subtle"
              disabled={restarting}
              onClick={() => {
                setRestarting(true)
                void onRestartMcp().finally(() => setRestarting(false))
              }}
            >
              <Icon name="refresh" size={13} /> {restarting ? 'Reconectando…' : 'Reconectar todos'}
            </button>
            <button type="button" className="btn primary" onClick={() => onOpenSettings('mcp')}>
              <Icon name="plus" size={13} /> Adicionar
            </button>
          </div>
          <div className="card-grid">
            <div className="info-card">
              <div className="info-card-head">
                <span className={`dot ${capabilities?.computer.available ? 'on' : 'off'}`} />
                <strong>Computer Use</strong>
                <span className="badge">nativo</span>
              </div>
              <p>{capabilities?.computer.available ? `Controle do Windows via ${capabilities.computer.backend}.` : 'Indisponível nesta máquina.'}</p>
            </div>
            <div className="info-card">
              <div className="info-card-head">
                <span className={`dot ${capabilities?.browser.available ? 'on' : 'off'}`} />
                <strong>Navegador do agente</strong>
                <span className="badge">nativo</span>
              </div>
              <p>{capabilities?.browser.available ? `Automação via ${capabilities.browser.engine ?? 'Playwright'}.` : 'Indisponível nesta máquina.'}</p>
            </div>
            {servers.map((server) => {
              const live = status.find((item) => item.name === server.name)
              return (
                <div key={server.name} className="info-card">
                  <div className="info-card-head">
                    <span className={`dot ${live?.state === 'ready' ? 'on' : live?.state === 'error' ? 'off' : 'idle'}`} />
                    <strong>{server.name}</strong>
                    <span className="badge">{server.enabled ? live?.state ?? 'parado' : 'desativado'}</span>
                  </div>
                  <p>
                    <code>{[server.command, ...server.args].join(' ').slice(0, 160)}</code>
                  </p>
                  <p className="muted">{live?.tools.length ? `${live.tools.length} ferramentas` : live?.error ?? 'sem ferramentas carregadas'}</p>
                </div>
              )
            })}
          </div>
          {!servers.length ? <p className="muted">Nenhum servidor MCP configurado ainda.</p> : null}
          {presets
            .filter((preset) => !servers.some((server) => server.name === preset.server?.name))
            .map((preset) => (
              <div key={preset.id} className="info-card preset-card">
                <div className="info-card-head">
                  <Icon name="plug" size={14} />
                  <strong>{preset.label}</strong>
                  <span className="badge">preset</span>
                </div>
                <p>{preset.description}</p>
                {preset.server ? (
                  <button type="button" className="btn small primary" onClick={() => void addPreset(preset)}>
                    <Icon name="plus" size={12} /> Adicionar
                  </button>
                ) : (
                  <p className="muted">{preset.unavailableReason}</p>
                )}
              </div>
            ))}
        </>
      ) : null}

      {tab === 'hooks' ? (
        <>
          <p className="page-lead">
            Hooks rodam comandos seus (ou chamam uma URL com <code>{'"type": "http"'}</code>) em eventos do agente, no formato do Claude Code: código de saída 2
            bloqueia; JSON com <code>permissionDecision</code>, <code>updatedInput</code> e <code>additionalContext</code>. Também são lidos de{' '}
            <code>.forja/settings.json</code> do projeto.
          </p>
          <div className="page-tools">
            <span className="page-tools-spacer" />
            <button type="button" className="btn primary" onClick={() => onOpenSettings('policy')}>
              <Icon name="pencil" size={13} /> Editar hooks
            </button>
          </div>
          {hookEvents.length ? (
            <div className="card-grid">
              {hookEvents.map(([event, matchers]) => (
                <div key={event} className="info-card">
                  <div className="info-card-head">
                    <Icon name="hammer" size={14} />
                    <strong>{event}</strong>
                    <span className="badge">{HOOK_LABELS[event] ?? 'evento'}</span>
                  </div>
                  {(matchers ?? []).map((matcher, index) => (
                    <p key={index}>
                      {matcher.matcher ? <em>{matcher.matcher}: </em> : null}
                      <code>{matcher.hooks.map((hook) => ('command' in hook ? hook.command : 'url' in hook ? String((hook as { url?: string }).url) : '')).join(' · ').slice(0, 200)}</code>
                    </p>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="page-empty compact">
              <Icon name="hammer" size={24} />
              <p>Nenhum hook configurado.</p>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
