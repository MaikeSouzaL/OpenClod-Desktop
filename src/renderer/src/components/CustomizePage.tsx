import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { AgentDefinition, AppSettings, CapabilityReport, HookEvent, McpServerSettings, SkillInfo } from '../../../shared/types'
import type { McpCatalogInfo, McpPresetEntry, PluginCatalogEntry } from '../../../shared/api'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'
import type { SettingsTab } from './SettingsDialog'

type CustomizeTab = 'skills' | 'connectors' | 'plugins' | 'agents' | 'hooks'

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
  const [catalog, setCatalog] = useState<McpCatalogInfo[]>([])
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [plugins, setPlugins] = useState<PluginCatalogEntry[]>([])
  const [tab, setTab] = useState<CustomizeTab>('skills')
  const [view, setView] = useState<'mine' | 'discover'>('mine')
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

  const loadCatalog = useCallback(async (): Promise<void> => {
    const result = await window.forja.app.mcpCatalog()
    if (result.ok) setCatalog(result.value)
  }, [])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  useEffect(() => {
    void window.forja.app.agents().then((result) => {
      if (result.ok) setAgents(result.value.agents)
    })
    void window.forja.app.pluginCatalog().then((result) => {
      if (result.ok) setPlugins(result.value)
    })
  }, [])

  const installCatalog = async (entry: McpCatalogInfo): Promise<void> => {
    if (entry.oauth) {
      setError(`"${entry.name}" exige login OAuth, que ainda não é automatizado. Use um token em Configurações → MCP.`)
      return
    }
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    for (const key of entry.needs) {
      const value = window.prompt(`${entry.name}: informe ${key}`)
      if (value === null) return
      if (!value.trim()) {
        setError(`${key} é obrigatório.`)
        return
      }
      if (/authorization|token|key/i.test(key) && /^authorization$/i.test(key)) headers[key] = value.trim()
      else env[key] = value.trim()
    }
    try {
      const result = await unwrap(window.forja.app.installMcp(entry.id, env, headers))
      if (!result.ok) {
        setError(result.error ?? `faltam: ${(result.missing ?? []).join(', ')}`)
        return
      }
      setNotice(`"${entry.name}" instalado${result.state === 'ready' ? ` · ${result.tools?.length ?? 0} ferramentas` : ' · conexão falhou, confira as credenciais'}.`)
      await loadCatalog()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

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
        <div className="page-actions">
          <button
            type="button"
            className="btn ghost small"
            onClick={async () => {
              try {
                const result = await unwrap(window.forja.app.importClaude())
                setNotice(
                  `Claude importado: ${result.skills} skills, ${result.agents} agentes, ${result.imported} MCPs (${result.plugins} plugins no catálogo).`
                )
                await loadSkills()
                await loadCatalog()
                await onRestartMcp()
              } catch (err) {
                setError(errorMessage(err))
              }
            }}
          >
            <Icon name="download" size={13} /> Importar do Claude
          </button>
        </div>
      </header>
      <div className="customize-tabs-row">
        <div className="page-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>
            <Icon name="sparkles" size={14} /> Skills
          </button>
          <button type="button" role="tab" aria-selected={tab === 'connectors'} className={tab === 'connectors' ? 'active' : ''} onClick={() => setTab('connectors')}>
            <Icon name="plug" size={14} /> Conectores
          </button>
          <button type="button" role="tab" aria-selected={tab === 'plugins'} className={tab === 'plugins' ? 'active' : ''} onClick={() => setTab('plugins')}>
            <Icon name="cpu" size={14} /> Plugins
          </button>
          <button type="button" role="tab" aria-selected={tab === 'agents'} className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
            <Icon name="users" size={14} /> Agentes
          </button>
          <button type="button" role="tab" aria-selected={tab === 'hooks'} className={tab === 'hooks' ? 'active' : ''} onClick={() => setTab('hooks')}>
            <Icon name="hammer" size={14} /> Hooks
          </button>
        </div>
        {tab !== 'hooks' ? (
          <div className="view-switch" role="group" aria-label="Origem">
            <button type="button" className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')}>
              Meus
            </button>
            <button type="button" className={view === 'discover' ? 'active' : ''} onClick={() => setView('discover')}>
              Descobrir
            </button>
          </div>
        ) : null}
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
        view === 'discover' ? (
          <>
            <p className="page-lead">
              Conectores MCP prontos para instalar. O agente também pode instalá-los sozinho quando a tarefa pedir
              (Jira, GitHub, banco, navegador, documentos). Os que exigem login OAuth aparecem marcados.
            </p>
            <div className="page-tools">
              <div className="page-search">
                <Icon name="search" size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Procurar conectores (Jira, GitHub, banco...)"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="connector-grid">
              {catalog
                .filter((entry) => {
                  const q = query.trim().toLowerCase()
                  return !q || `${entry.id} ${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(q)
                })
                .map((entry) => (
                  <article key={entry.id} className="connector-card">
                    <div className="connector-head">
                      <span className="connector-icon">
                        <Icon name={entry.category === 'atlassian' ? 'briefcase' : entry.category === 'database' ? 'archive' : entry.category === 'browser' ? 'globe' : 'plug'} size={18} />
                      </span>
                      <div>
                        <strong>{entry.name}</strong>
                        <span className="connector-meta">
                          {entry.transport}
                          {entry.oauth ? ' · OAuth' : ''}
                          {entry.installed ? ' · instalado' : ''}
                        </span>
                      </div>
                    </div>
                    <p>{entry.description}</p>
                    <div className="connector-foot">
                      <span className="connector-needs">
                        {entry.needs.length ? `precisa: ${entry.needs.slice(0, 3).join(', ')}` : 'sem credenciais'}
                      </span>
                      <button
                        type="button"
                        className="btn small"
                        disabled={entry.installed}
                        onClick={() => void installCatalog(entry)}
                      >
                        {entry.installed ? <Icon name="check" size={12} /> : <Icon name="plus" size={12} />}
                        {entry.installed ? 'Instalado' : 'Adicionar'}
                      </button>
                    </div>
                  </article>
                ))}
            </div>
            {!catalog.length ? <p className="muted">Carregando catálogo…</p> : null}
          </>
        ) : (
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
        )
      ) : null}

      {tab === 'plugins' ? (
        <>
          <p className="page-lead">
            Plugins empacotam skills, conectores e subagentes. O catálogo oficial da Anthropic tem 315 plugins; abaixo
            estão os mais usados. Conectores com MCP podem ser instalados direto daqui.
          </p>
          <div className="plugin-hero">
            <div>
              <span className="plugin-overline">From Anthropic</span>
              <strong>Data</strong>
              <p>Consulte, analise e visualize dados: SQL, planilhas e painéis em um só lugar.</p>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setTab('connectors')
                  setView('discover')
                  setQuery('postgres')
                }}
              >
                Explorar conectores
              </button>
            </div>
            <span className="plugin-hero-art">
              <Icon name="gauge" size={54} />
            </span>
          </div>
          <h2 className="section-title">Novos plugins</h2>
          <div className="plugin-grid">
            {[
              { id: 'data', name: 'Data', text: 'SQL, planilhas e dashboards.', icon: 'gauge' as const },
              { id: 'desktop-commander', name: 'Desktop Commander', text: 'Terminal e arquivos do computador.', icon: 'terminal' as const },
              { id: 'design', name: 'Design', text: 'Crítica, design system e UX writing.', icon: 'sparkles' as const },
              { id: 'github', name: 'GitHub', text: 'Issues, PRs e revisão de código.', icon: 'git' as const },
              { id: 'atlassian', name: 'Atlassian MCP', text: 'Jira, Confluence e Bitbucket.', icon: 'briefcase' as const },
              { id: 'playwright', name: 'Playwright', text: 'Navegador e testes end-to-end.', icon: 'globe' as const }
            ].map((plugin) => {
              const connector = catalog.find((entry) => entry.id === plugin.id)
              return (
                <article key={plugin.id} className="plugin-card">
                  <span className="plugin-icon">
                    <Icon name={plugin.icon} size={18} />
                  </span>
                  <div>
                    <strong>{plugin.name}</strong>
                    <p>{plugin.text}</p>
                    <span className="muted">Anthropic Directory</span>
                  </div>
                  <button
                    type="button"
                    className="plugin-add"
                    title={connector ? 'Adicionar conector' : 'Disponível pelo catálogo do Claude Code'}
                    onClick={() => {
                      if (connector) {
                        setTab('connectors')
                        setView('discover')
                        setQuery(plugin.name)
                      } else {
                        setNotice('Este plugin é de skills e ainda não é importado automaticamente. Use o catálogo de conectores para a parte MCP.')
                      }
                    }}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                </article>
              )
            })}
          </div>
          <h2 className="section-title">Categorias</h2>
          <div className="category-grid">
            {['Engenharia', 'Código', 'Arquivos e documentos', 'Design e mídia', 'Tickets e tarefas', 'Pipelines e jobs', 'APIs', 'Notas e memória', 'Documentos de referência'].map((category) => (
              <button
                key={category}
                type="button"
                className="category-card"
                onClick={() => {
                  setTab('connectors')
                  setView('discover')
                  setQuery(category.split(' ')[0])
                }}
              >
                <Icon name="folder" size={14} /> {category}
              </button>
            ))}
          </div>
          <h2 className="section-title">Catálogo completo ({plugins.length || 315})</h2>
          <div className="page-tools">
            <div className="page-search">
              <Icon name="search" size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Procurar plugin oficial"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="plugin-catalog">
            {plugins
              .filter((plugin) => {
                const q = query.trim().toLowerCase()
                return !q || `${plugin.name} ${plugin.description} ${plugin.category ?? ''}`.toLowerCase().includes(q)
              })
              .slice(0, 80)
              .map((plugin) => (
                <div key={plugin.name} className="plugin-catalog-row">
                  <strong>{plugin.name}</strong>
                  <span className="badge">{plugin.category ?? 'plugin'}</span>
                  <p>{plugin.description}</p>
                </div>
              ))}
          </div>
          {!plugins.length ? <p className="muted">Catálogo ainda não carregado.</p> : null}
        </>
      ) : null}

      {tab === 'agents' ? (
        <>
          <p className="page-lead">
            Agentes especialistas disponíveis para o orquestrador. Os importados do Claude usam o melhor modelo liberado
            no Openclod; os embutidos cobrem computador, web, mobile, QA, código e revisão.
          </p>
          <div className="page-tools">
            <div className="page-search">
              <Icon name="search" size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Procurar agente"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="card-grid">
            {agents
              .filter((agent) => {
                const q = query.trim().toLowerCase()
                return !q || `${agent.name} ${agent.description}`.toLowerCase().includes(q)
              })
              .map((agent) => (
                <div key={agent.name} className="info-card">
                  <div className="info-card-head">
                    <Icon name="bot" size={14} />
                    <strong>{agent.name}</strong>
                    <span className="badge">{agent.mode ?? 'code'}</span>
                  </div>
                  <p>{agent.description}</p>
                  <p className="muted">
                    {agent.source === 'builtin' ? 'embutido' : 'usuário'}
                    {agent.model ? ` · ${agent.model}` : ''}
                    {agent.canCall ? ` · pode chamar ${agent.canCall === '*' ? 'qualquer agente' : agent.canCall.join(', ')}` : ''}
                  </p>
                </div>
              ))}
          </div>
          {!agents.length ? <p className="muted">Nenhum agente carregado.</p> : null}
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
