import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  AppSettings,
  CapabilityReport,
  HooksConfig,
  McpServerSettings,
  PermissionMode,
  PolicyConfig,
  ProviderConfig
} from '../../../shared/types'
import { AGENT_MODES } from '../../../shared/types'
import type { AppVersions, ProviderPresetInfo, SttStatusInfo } from '../../../shared/api'
import { Icon } from './Icons'
import { MODE_LABELS } from '../lib/format'
import { errorMessage, unwrap } from '../lib/api'

export type SettingsTab = 'providers' | 'appearance' | 'voice' | 'policy' | 'mcp' | 'about'
type Tab = SettingsTab

const PERMISSION_CHOICES: Array<{ id: PermissionMode; title: string; detail: string; tone?: 'warn' }> = [
  { id: 'readonly', title: 'Somente leitura', detail: 'Lê e investiga. Nega escrita, execução e controle de interface.' },
  { id: 'ask', title: 'Perguntar', detail: 'Leituras passam; escrita, comandos e ações sensíveis pedem aprovação.' },
  { id: 'accept-edits', title: 'Aceitar edições', detail: 'Edita arquivos sem perguntar. Comandos e ações externas ainda pedem aprovação.' },
  {
    id: 'auto',
    title: 'Automático',
    detail: 'Padrão. Edita, executa e navega sem pedir; operações destrutivas e arquivos de segredo pedem confirmação.',
    tone: 'warn'
  }
]

interface SettingsDialogProps {
  open: boolean
  settings: AppSettings
  presets: ProviderPresetInfo[]
  capabilities: CapabilityReport | null
  versions: AppVersions | null
  onClose(): void
  onSave(patch: Partial<AppSettings>): Promise<void>
  onRefreshCapabilities(): Promise<void>
  /** Tab shown when the dialog opens (e.g. "mcp" from the Customize page). */
  initialTab?: SettingsTab
}

export function SettingsDialog({
  open,
  settings,
  presets,
  capabilities,
  versions,
  onClose,
  onSave,
  onRefreshCapabilities,
  initialTab
}: SettingsDialogProps): ReactElement | null {
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(settings.theme)
  const [policy, setPolicy] = useState<PolicyConfig>(settings.policy)
  const [limits, setLimits] = useState(settings.limits)
  const [blockedText, setBlockedText] = useState('')
  const [rootsText, setRootsText] = useState('')
  const [mcpText, setMcpText] = useState('[]')
  const [rulesText, setRulesText] = useState({ allow: '', ask: '', deny: '' })
  const [hooksText, setHooksText] = useState('{}')
  const [importClaude, setImportClaude] = useState(false)
  const [voice, setVoice] = useState({ model: 'base', language: 'pt' })
  const [voiceStatus, setVoiceStatus] = useState<SttStatusInfo | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [keyStatus, setKeyStatus] = useState<Record<string, string>>({})
  const [testStatus, setTestStatus] = useState<Record<string, { state: string; detail: string }>>({})
  const [presetKey, setPresetKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const serverIds = useMemo(() => new Set(settings.providers.map((provider) => provider.id)), [settings.providers])

  useEffect(() => {
    if (open && initialTab) setTab(initialTab)
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    setProviders(structuredClone(settings.providers))
    setDefaultId(settings.defaultProviderId)
    setTheme(settings.theme)
    setPolicy(structuredClone(settings.policy))
    setLimits(structuredClone(settings.limits))
    setBlockedText(settings.policy.blockedCommands.join('\n'))
    setRootsText(settings.policy.allowedRoots.join('\n'))
    setMcpText(JSON.stringify(settings.mcpServers ?? [], null, 2))
    setRulesText({
      allow: (settings.policy.rules?.allow ?? []).join('\n'),
      ask: (settings.policy.rules?.ask ?? []).join('\n'),
      deny: (settings.policy.rules?.deny ?? []).join('\n')
    })
    setHooksText(JSON.stringify(settings.hooks ?? {}, null, 2))
    setImportClaude(Boolean(settings.importClaudeSettings))
    setVoice({ model: settings.voice?.model ?? 'base', language: settings.voice?.language ?? 'pt' })
    void window.forja.stt.status().then((result) => setVoiceStatus(result.ok ? result.value : null))
    setKeyDrafts({})
    setKeyStatus({})
    setTestStatus({})
    setError('')
    setNotice('')
  }, [open, settings])

  if (!open) return null

  const configured = (id: string): boolean =>
    Boolean(capabilities?.providers.find((provider) => provider.id === id)?.configured)

  const updateProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setProviders((current) => current.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)))
  }

  const availablePresets = presets.filter((preset) => !providers.some((provider) => provider.id === preset.key))

  const addPreset = (): void => {
    const key = presetKey || availablePresets[0]?.key
    const preset = presets.find((item) => item.key === key)
    if (!preset) return
    setProviders((current) => [
      ...current,
      {
        id: preset.key,
        kind: preset.kind,
        label: preset.label,
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKeyRef: preset.apiKeyEnv ? `env:${preset.apiKeyEnv}` : '',
        contextWindow: preset.contextWindow,
        supportsVision: preset.supportsVision,
        supportsTools: true
      }
    ])
    setPresetKey('')
  }

  const addCustom = (): void => {
    let index = 1
    while (providers.some((provider) => provider.id === `custom-${index}`)) index++
    setProviders((current) => [
      ...current,
      {
        id: `custom-${index}`,
        kind: 'openai',
        label: `Personalizado ${index}`,
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'modelo',
        apiKeyRef: '',
        contextWindow: 32_000,
        supportsVision: false,
        supportsTools: true
      }
    ])
  }

  const removeProvider = (id: string): void => {
    if (providers.length <= 1) return
    const next = providers.filter((provider) => provider.id !== id)
    setProviders(next)
    if (defaultId === id) setDefaultId(next[0]?.id ?? '')
  }

  const saveKey = async (id: string): Promise<void> => {
    const value = (keyDrafts[id] ?? '').trim()
    if (!value) return
    setKeyStatus((current) => ({ ...current, [id]: 'salvando…' }))
    try {
      await unwrap(window.forja.app.setSecret(id, value))
      setKeyDrafts((current) => ({ ...current, [id]: '' }))
      setKeyStatus((current) => ({ ...current, [id]: 'chave salva no cofre do Windows' }))
      await onRefreshCapabilities()
    } catch (err) {
      setKeyStatus((current) => ({ ...current, [id]: errorMessage(err) }))
    }
  }

  const clearKey = async (id: string): Promise<void> => {
    try {
      await unwrap(window.forja.app.clearSecret(id))
      setKeyStatus((current) => ({ ...current, [id]: 'chave removida' }))
      await onRefreshCapabilities()
    } catch (err) {
      setKeyStatus((current) => ({ ...current, [id]: errorMessage(err) }))
    }
  }

  const testProvider = async (id: string): Promise<void> => {
    setTestStatus((current) => ({ ...current, [id]: { state: 'testando', detail: 'enviando um ping…' } }))
    try {
      const result = await unwrap(window.forja.app.testProvider(id))
      setTestStatus((current) => ({ ...current, [id]: { state: result.ok ? 'ok' : 'erro', detail: result.detail } }))
    } catch (err) {
      setTestStatus((current) => ({ ...current, [id]: { state: 'erro', detail: errorMessage(err) } }))
    }
  }

  /** Asks the provider's own endpoint which models it serves and fills the model list. */
  const detectModels = async (id: string): Promise<void> => {
    setTestStatus((current) => ({ ...current, [id]: { state: 'detectando', detail: 'consultando os modelos do servidor…' } }))
    try {
      const result = await unwrap(window.forja.app.discoverModels(id))
      if (result.error || !result.models.length) {
        setTestStatus((current) => ({ ...current, [id]: { state: 'erro', detail: result.error ?? 'o servidor não listou modelos' } }))
        return
      }
      const ids = result.models.map((model) => model.id)
      updateProvider(id, {
        models: ids,
        ...(() => {
          const current = providers.find((item) => item.id === id)
          const hit = result.models.find((model) => model.id === current?.model)
          return hit?.contextWindow ? { contextWindow: hit.contextWindow } : {}
        })()
      })
      setTestStatus((current) => ({ ...current, [id]: { state: 'ok', detail: `${ids.length} modelo(s) detectado(s) (${result.source}). Salve para aplicar.` } }))
    } catch (err) {
      setTestStatus((current) => ({ ...current, [id]: { state: 'erro', detail: errorMessage(err) } }))
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    setNotice('')
    let mcpServers: McpServerSettings[] | undefined
    const previousMcp = JSON.stringify(settings.mcpServers ?? [], null, 2)
    if (mcpText.trim() !== previousMcp.trim()) {
      try {
        const parsed = JSON.parse(mcpText) as unknown
        if (!Array.isArray(parsed)) throw new Error('a raiz deve ser um array')
        mcpServers = parsed as McpServerSettings[]
      } catch (err) {
        setError(`MCP inválido: ${errorMessage(err)}`)
        setTab('mcp')
        return
      }
    }

    let hooks: HooksConfig
    try {
      const parsed = JSON.parse(hooksText.trim() || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('a raiz deve ser um objeto')
      hooks = parsed as HooksConfig
    } catch (err) {
      setError(`Hooks inválidos: ${errorMessage(err)}`)
      setTab('policy')
      return
    }

    const lines = (text: string): string[] =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

    const nextPolicy: PolicyConfig = {
      ...policy,
      blockedCommands: lines(blockedText),
      allowedRoots: lines(rootsText),
      rules: { allow: lines(rulesText.allow), ask: lines(rulesText.ask), deny: lines(rulesText.deny) }
    }

    setSaving(true)
    try {
      await onSave({
        providers,
        defaultProviderId: defaultId,
        theme,
        policy: nextPolicy,
        limits,
        mcpServers,
        hooks,
        importClaudeSettings: importClaude,
        voice
      })
      setNotice('Configurações salvas.')
      setTimeout(() => setNotice(''), 2500)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Configurações">
        <header className="modal-head">
          <div>
            <h2>Configurações</h2>
            <p>Provedores, permissões e integrações do Forja.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Fechar">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="settings-sheet">
          <nav className="settings-nav" aria-label="Seções das configurações">
            <button type="button" className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
              <Icon name="cpu" size={15} /> Provedores
            </button>
            <button type="button" className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>
              <Icon name="image" size={15} /> Aparência
            </button>
            <button type="button" className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}>
              <Icon name="mic" size={15} /> Voz
            </button>
            <button type="button" className={tab === 'policy' ? 'active' : ''} onClick={() => setTab('policy')}>
              <Icon name="shield" size={15} /> Permissões
            </button>
            <button type="button" className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
              <Icon name="plug" size={15} /> MCP
            </button>
            <button type="button" className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>
              <Icon name="spark" size={15} /> Sobre
            </button>
            <div className="settings-nav-foot">
              <span>Forja Desktop</span>
              <em>v{versions?.app ?? '0.1.0'}</em>
            </div>
          </nav>

          <div className="modal-body">
          {error ? (
            <div className="inline-error">
              <Icon name="alert" size={14} /> {error}
            </div>
          ) : null}
          {notice ? <div className="inline-ok">{notice}</div> : null}

          {tab === 'providers' ? (
            <div className="providers">
              <p className="field-help">
                A chave é cifrada com o DPAPI do Windows e nunca volta para a interface. Provedores locais
                (Ollama/LM Studio) não precisam de chave.
              </p>

              {providers.map((provider) => (
                <div key={provider.id} className={`provider-card ${defaultId === provider.id ? 'is-default' : ''}`}>
                  <div className="provider-head">
                    <label className="radio-line" title="Usar como provedor padrão">
                      <input
                        type="radio"
                        name="default-provider"
                        checked={defaultId === provider.id}
                        onChange={() => setDefaultId(provider.id)}
                      />
                      <strong>{provider.label}</strong>
                      <span className={`badge kind-${provider.kind}`}>{provider.kind}</span>
                      {provider.kind === 'mock' ? <span className="badge warn">não é um modelo real</span> : null}
                      {configured(provider.id) ? <span className="badge ok">credencial ok</span> : null}
                    </label>
                    {providers.length > 1 ? (
                      <button type="button" className="icon-btn small" title="Remover" onClick={() => removeProvider(provider.id)}>
                        <Icon name="trash" size={13} />
                      </button>
                    ) : null}
                  </div>

                  <div className="grid-2">
                    <label className="field">
                      <span>Modelo</span>
                      <input
                        value={provider.model}
                        onChange={(event) => updateProvider(provider.id, { model: event.target.value })}
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>Janela de contexto (tokens)</span>
                      <input
                        type="number"
                        min={1000}
                        value={provider.contextWindow}
                        onChange={(event) => updateProvider(provider.id, { contextWindow: Number(event.target.value) })}
                      />
                    </label>
                  </div>

                  <label className="field">
                    <span>Base URL</span>
                    <input
                      value={provider.baseUrl}
                      onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
                      spellCheck={false}
                      disabled={provider.kind === 'mock'}
                    />
                  </label>

                  <div className="inline-fields">
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={provider.supportsVision}
                        onChange={(event) => updateProvider(provider.id, { supportsVision: event.target.checked })}
                      />
                      suporta imagens
                    </label>
                    <label className="field slim">
                      <span>custo US$/Mtok (entrada)</span>
                      <input
                        type="number"
                        step="0.01"
                        value={provider.inputCostPerMTok ?? ''}
                        onChange={(event) =>
                          updateProvider(provider.id, {
                            inputCostPerMTok: event.target.value ? Number(event.target.value) : undefined
                          })
                        }
                      />
                    </label>
                    <label className="field slim">
                      <span>custo US$/Mtok (saída)</span>
                      <input
                        type="number"
                        step="0.01"
                        value={provider.outputCostPerMTok ?? ''}
                        onChange={(event) =>
                          updateProvider(provider.id, {
                            outputCostPerMTok: event.target.value ? Number(event.target.value) : undefined
                          })
                        }
                      />
                    </label>
                  </div>

                  <div className="key-row">
                    <label className="field grow">
                      <span>
                        Chave de API {provider.apiKeyRef?.startsWith('env:') ? `(env ${provider.apiKeyRef.slice(4)})` : ''}
                      </span>
                      <input
                        type="password"
                        placeholder={configured(provider.id) ? '•••••••• (configurada)' : 'cole a chave aqui'}
                        value={keyDrafts[provider.id] ?? ''}
                        onChange={(event) =>
                          setKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))
                        }
                        spellCheck={false}
                        autoComplete="off"
                        disabled={!serverIds.has(provider.id)}
                        title={!serverIds.has(provider.id) ? 'Salve as configurações antes de gravar a chave' : undefined}
                      />
                    </label>
                    <div className="key-actions">
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => void saveKey(provider.id)}
                        disabled={!serverIds.has(provider.id) || !(keyDrafts[provider.id] ?? '').trim()}
                      >
                        <Icon name="key" size={12} /> Salvar chave
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => void clearKey(provider.id)}>
                        Limpar
                      </button>
                      <button
                        type="button"
                        className="btn small subtle"
                        onClick={() => void testProvider(provider.id)}
                        disabled={!configured(provider.id)}
                      >
                        <Icon name="plug" size={12} /> Testar
                      </button>
                      <button
                        type="button"
                        className="btn small subtle"
                        onClick={() => void detectModels(provider.id)}
                        disabled={!serverIds.has(provider.id) || provider.kind === 'mock'}
                        title="Lista os modelos que este servidor oferece (Ollama, LM Studio, OpenAI-compatível, Anthropic)"
                      >
                        <Icon name="refresh" size={12} /> Detectar modelos
                      </button>
                    </div>
                  </div>
                  {keyStatus[provider.id] ? <div className="field-note">{keyStatus[provider.id]}</div> : null}
                  {testStatus[provider.id] ? (
                    <div className={`field-note ${testStatus[provider.id].state === 'erro' ? 'bad' : testStatus[provider.id].state === 'ok' ? 'good' : ''}`}>
                      {testStatus[provider.id].state}: {testStatus[provider.id].detail}
                    </div>
                  ) : null}
                  {provider.kind === 'mock' ? (
                    <div className="field-note bad">
                      O provedor Scripted é apenas para autoteste determinístico. Ele não raciocina e não deve ser usado
                      para trabalho real.
                    </div>
                  ) : null}
                </div>
              ))}

              <div className="add-provider">
                <select value={presetKey} onChange={(event) => setPresetKey(event.target.value)}>
                  <option value="">Adicionar preset…</option>
                  {availablePresets.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn small subtle" onClick={addPreset} disabled={!availablePresets.length}>
                  <Icon name="plus" size={12} /> Preset
                </button>
                <button type="button" className="btn small ghost" onClick={addCustom}>
                  <Icon name="plus" size={12} /> OpenAI-compatível
                </button>
              </div>
            </div>
          ) : null}

          {tab === 'appearance' ? (
            <div className="appearance">
              <h3>Tema</h3>
              <p className="field-help">
                O tema vale para toda a interface e é salvo nas configurações. A prévia muda imediatamente ao salvar.
              </p>
              <div className="theme-grid">
                <button
                  type="button"
                  className={`theme-card ${theme === 'dark' ? 'active' : ''}`}
                  onClick={() => setTheme('dark')}
                  aria-pressed={theme === 'dark'}
                >
                  <span className="theme-preview dark">
                    <i className="tp-side" />
                    <i className="tp-main">
                      <b />
                      <b />
                      <b className="wide" />
                    </i>
                  </span>
                  <span className="theme-label">
                    <strong>Escuro</strong>
                    <em>Grafite e marfim</em>
                  </span>
                  {theme === 'dark' ? <Icon name="check" size={14} /> : null}
                </button>
                <button
                  type="button"
                  className={`theme-card ${theme === 'light' ? 'active' : ''}`}
                  onClick={() => setTheme('light')}
                  aria-pressed={theme === 'light'}
                >
                  <span className="theme-preview light">
                    <i className="tp-side" />
                    <i className="tp-main">
                      <b />
                      <b />
                      <b className="wide" />
                    </i>
                  </span>
                  <span className="theme-label">
                    <strong>Claro</strong>
                    <em>Papel e tinta</em>
                  </span>
                  {theme === 'light' ? <Icon name="check" size={14} /> : null}
                </button>
              </div>

              <h3>Densidade</h3>
              <p className="field-help">
                A interface usa densidade confortável, com linhas de 28 px na barra lateral e mensagens com respiro
                de leitura. Zoom: use Ctrl + + / Ctrl + − do sistema.
              </p>

              <h3>Movimento</h3>
              <p className="field-help">
                As animações respeitam a preferência “reduzir movimento” do Windows: o indicador de raciocínio e os
                spinners ficam estáticos quando ela está ativa.
              </p>
            </div>
          ) : null}

          {tab === 'voice' ? (
            <div className="appearance">
              <h3>Ditado por voz</h3>
              <p className="field-help">
                O botão de microfone do compositor escreve o que você fala enquanto você fala. O reconhecimento roda
                <strong> neste computador</strong>, com o Whisper embutido no Forja: nenhum áudio sai da máquina.
              </p>
              {voiceStatus ? (
                voiceStatus.available ? (
                  <div className="field-note good">
                    Pronto{voiceStatus.device ? ` (${voiceStatus.device})` : ''}. Modelos embutidos:{' '}
                    {voiceStatus.models.map((model) => `${model.id} (${model.sizeMB} MB)`).join(', ')}.
                  </div>
                ) : (
                  <div className="field-note bad">{voiceStatus.reason ?? 'O reconhecimento de voz não está disponível.'}</div>
                )
              ) : (
                <div className="field-note">Verificando…</div>
              )}
              <div className="field-row">
                <label className="field">
                  <span>Modelo</span>
                  <select value={voice.model} onChange={(event) => setVoice((current) => ({ ...current, model: event.target.value }))}>
                    {(voiceStatus?.models.length ? voiceStatus.models.map((model) => model.id) : [voice.model]).map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                  <small>Maior = mais preciso e mais lento. “base” é um bom ponto de partida; “small” entende melhor o português.</small>
                </label>
                <label className="field">
                  <span>Idioma</span>
                  <select value={voice.language} onChange={(event) => setVoice((current) => ({ ...current, language: event.target.value }))}>
                    <option value="pt">Português</option>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                    <option value="fr">Français</option>
                    <option value="de">Deutsch</option>
                    <option value="it">Italiano</option>
                    <option value="auto">Detectar automaticamente</option>
                  </select>
                  <small>Fixar o idioma evita erros em frases curtas.</small>
                </label>
              </div>
            </div>
          ) : null}

          {tab === 'policy' ? (
            <div className="policy">
              <h3>Modo de permissão</h3>
              <div className="permission-grid">
                {PERMISSION_CHOICES.map((choice) => (
                  <label
                    key={choice.id}
                    className={`permission-card ${policy.mode === choice.id ? 'active' : ''} ${choice.tone ?? ''}`}
                  >
                    <input
                      type="radio"
                      name="permission-mode"
                      checked={policy.mode === choice.id}
                      onChange={() => setPolicy((current) => ({ ...current, mode: choice.id }))}
                    />
                    <strong>{choice.title}</strong>
                    <span>{choice.detail}</span>
                  </label>
                ))}
              </div>

              <div className="toggles">
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={policy.allowNetwork}
                    onChange={(event) => setPolicy((current) => ({ ...current, allowNetwork: event.target.checked }))}
                  />
                  Permitir ferramentas de rede (fetch, busca, navegador)
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={policy.allowComputerControl}
                    onChange={(event) =>
                      setPolicy((current) => ({ ...current, allowComputerControl: event.target.checked }))
                    }
                  />
                  Permitir controle real de mouse e teclado
                </label>
                <p className="field-help">
                  Com o controle desligado, o agente pode listar janelas, ler a árvore de acessibilidade e capturar
                  tela, mas não pode clicar, digitar ou arrastar.
                </p>
              </div>

              <div className="grid-2">
                <label className="field">
                  <span>Comandos bloqueados (um por linha)</span>
                  <textarea
                    rows={5}
                    value={blockedText}
                    onChange={(event) => setBlockedText(event.target.value)}
                    placeholder={'git push\nnpm publish\nrm -rf'}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>Raízes extras permitidas (uma por linha)</span>
                  <textarea
                    rows={5}
                    value={rootsText}
                    onChange={(event) => setRootsText(event.target.value)}
                    placeholder={'C:\\projetos\\outro-repo'}
                    spellCheck={false}
                  />
                </label>
              </div>

              <h3>Regras de permissão</h3>
              <p className="field-help">
                Mesma sintaxe do Claude Code, uma regra por linha: <code>Bash(npm test:*)</code>,{' '}
                <code>Edit(src/**)</code>, <code>Read(.env)</code>, <code>WebFetch(domain:docs.python.org)</code>. Negar
                vence perguntar, que vence permitir; as regras valem antes do modo. "Permitir sempre" numa aprovação
                grava uma regra para o projeto.
              </p>
              <div className="grid-3">
                {(['allow', 'ask', 'deny'] as const).map((kind) => (
                  <label className="field" key={kind}>
                    <span>{kind === 'allow' ? 'Permitir' : kind === 'ask' ? 'Perguntar' : 'Negar'}</span>
                    <textarea
                      rows={6}
                      value={rulesText[kind]}
                      onChange={(event) => setRulesText((current) => ({ ...current, [kind]: event.target.value }))}
                      placeholder={kind === 'allow' ? 'Bash(npm test:*)' : kind === 'ask' ? 'Bash(git push:*)' : 'Read(secrets/**)'}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>

              <h3>Hooks</h3>
              <p className="field-help">
                Formato do Claude Code (<code>PreToolUse</code>, <code>PostToolUse</code>, <code>UserPromptSubmit</code>,{' '}
                <code>Stop</code>, <code>SessionStart</code>, <code>PreCompact</code>, <code>Notification</code>). O
                comando recebe o evento em JSON pela entrada padrão; código de saída 2 bloqueia. Hooks de projeto ficam
                em <code>.forja/settings.json</code>.
              </p>
              <label className="field">
                <span>Hooks do usuário (JSON)</span>
                <textarea
                  rows={8}
                  value={hooksText}
                  onChange={(event) => setHooksText(event.target.value)}
                  placeholder={'{\n  "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write ." }] }]\n}'}
                  spellCheck={false}
                />
              </label>
              <label className="check-line">
                <input type="checkbox" checked={importClaude} onChange={(event) => setImportClaude(event.target.checked)} />
                Ler também <code>.claude/settings.json</code> dos projetos (permissões e hooks do Claude Code)
              </label>
              <p className="field-help">
                Hooks de projeto executam comandos do repositório. Ligue só para projetos em que você confia.
              </p>

              <h3>Limites de execução</h3>
              <div className="grid-3">
                <label className="field">
                  <span>Iterações</span>
                  <input
                    type="number"
                    min={1}
                    value={limits.maxIterations}
                    onChange={(event) => setLimits({ ...limits, maxIterations: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Chamadas de ferramenta</span>
                  <input
                    type="number"
                    min={1}
                    value={limits.maxToolCalls}
                    onChange={(event) => setLimits({ ...limits, maxToolCalls: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Tempo máximo (min)</span>
                  <input
                    type="number"
                    min={1}
                    value={Math.round(limits.maxWallClockMs / 60_000)}
                    onChange={(event) => setLimits({ ...limits, maxWallClockMs: Number(event.target.value) * 60_000 })}
                  />
                </label>
                <label className="field">
                  <span>Tokens por turno</span>
                  <input
                    type="number"
                    min={10_000}
                    step={100_000}
                    value={limits.maxTokens}
                    onChange={(event) => setLimits({ ...limits, maxTokens: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Custo máximo (US$)</span>
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    value={limits.maxCostUsd}
                    onChange={(event) => setLimits({ ...limits, maxCostUsd: Number(event.target.value) })}
                  />
                </label>
                <label className="field">
                  <span>Ferramentas em paralelo</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={limits.maxParallelTools}
                    onChange={(event) => setLimits({ ...limits, maxParallelTools: Number(event.target.value) })}
                  />
                </label>
              </div>

              <p className="field-help">
                Modos de agente disponíveis no compositor:{' '}
                {AGENT_MODES.map((mode) => MODE_LABELS[mode]).join(' · ')}.
              </p>
            </div>
          ) : null}

          {tab === 'mcp' ? (
            <div className="mcp">
              <p className="field-help">
                Servidores MCP por stdio, no formato <code>{'{ name, command, args, env?, enabled }'}</code>. As
                ferramentas aparecem prefixadas com <code>mcp__servidor__ferramenta</code> e passam pela mesma política
                de permissões.
              </p>
              <label className="field">
                <span>mcpServers (JSON)</span>
                <textarea
                  className="json-editor"
                  rows={16}
                  value={mcpText}
                  onChange={(event) => setMcpText(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="inline-fields">
                <button
                  type="button"
                  className="btn small subtle"
                  onClick={() => setMcpText(JSON.stringify(settings.mcpServers ?? [], null, 2))}
                >
                  <Icon name="refresh" size={12} /> Restaurar
                </button>
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    setMcpText(
                      JSON.stringify(
                        [
                          ...(settings.mcpServers ?? []),
                          { name: 'exemplo', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\'], enabled: false }
                        ],
                        null,
                        2
                      )
                    )
                  }}
                >
                  <Icon name="plus" size={12} /> Exemplo
                </button>
              </div>
              <p className="field-help">
                Salvar com MCP alterado reinicia os servidores. Ferramentas MCP são tratadas como execução e pedem
                aprovação no modo “Perguntar”.
              </p>
            </div>
          ) : null}

          {tab === 'about' ? (
            <div className="about">
              <div className="about-mark">
                <Icon name="hammer" size={28} />
              </div>
              <h3>Forja Desktop</h3>
              <p>
                Harness próprio em TypeScript, com ferramentas de código, navegador Playwright e Computer Use real no
                Windows. Interface e marca originais; algumas partes foram adaptadas de projetos MIT/Apache-2.0 (veja THIRD_PARTY_NOTICES.md). Nenhum código proprietário foi copiado.
              </p>
              <dl className="about-grid">
                <dt>Versão</dt>
                <dd>{versions?.app ?? '—'}</dd>
                <dt>Electron</dt>
                <dd>{versions?.electron ?? '—'}</dd>
                <dt>Chromium</dt>
                <dd>{versions?.chrome ?? '—'}</dd>
                <dt>Node</dt>
                <dd>{versions?.node ?? '—'}</dd>
                <dt>Plataforma</dt>
                <dd>{versions?.platform ?? '—'}</dd>
              </dl>
              <h4>Capacidades detectadas</h4>
              <ul className="cap-list">
                <li>
                  <Icon name="monitor" size={13} /> Computer Use:{' '}
                  {capabilities?.computer.available ? capabilities.computer.backend : 'indisponível'}
                  <em>{capabilities?.computer.detail}</em>
                </li>
                <li>
                  <Icon name="globe" size={13} /> Navegador: {capabilities?.browser.available ? 'disponível' : 'indisponível'}
                  <em>{capabilities?.browser.detail}</em>
                </li>
                <li>
                  <Icon name="mic" size={13} /> Voz (Whisper embutido): {voiceStatus ? (voiceStatus.available ? `pronto${voiceStatus.device ? ` (${voiceStatus.device})` : ''}` : 'indisponível') : '…'}
                  {voiceStatus && !voiceStatus.available && voiceStatus.reason ? <em>{voiceStatus.reason}</em> : null}
                </li>
                <li>
                  <Icon name="code" size={13} /> Toolchains da máquina:{' '}
                  {capabilities?.toolchains?.length ? capabilities.toolchains.map((item) => `${item.label} ${item.version}`).join(' · ') : 'nenhuma detectada'}
                  <em>Compiladores e runtimes dos seus projetos; o Forja usa os que estiverem instalados.</em>
                </li>
                <li>
                  <Icon name="plug" size={13} /> Servidores MCP:{' '}
                  {capabilities?.mcp.length ? capabilities.mcp.map((server) => `${server.name} (${server.state})`).join(', ') : 'nenhum'}
                </li>
              </ul>
              <p className="field-help">
                Dados e sessões ficam em <code>%APPDATA%\Forja</code> (sessions, config, logs). O código-fonte do projeto
                aberto nunca é copiado para fora dele, exceto o que o modelo recebe nas ferramentas.
              </p>
            </div>
          ) : null}
          </div>
        </div>

        <footer className="modal-foot">
          <span className="footer-note">Alterações de política valem a partir do próximo turno.</span>
          <div>
            <button type="button" className="btn ghost" onClick={onClose}>
              Fechar
            </button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar alterações'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
