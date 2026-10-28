import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, ProviderConfig } from '../shared/types.js'
import type {
  ColabConnectResult,
  ColabInspectResult,
  ColabPrepareInfo,
  ColabPreview,
  ColabStateName,
  ColabStatusInfo
} from '../shared/api.js'
import { COLAB_NOTEBOOK_VERSION, decodeColabCode, type ColabConnection } from '../core/colab/connection-code.js'
import { checkColabLink, type ColabLinkCheck } from '../core/colab/link.js'
import { COLAB_NOTEBOOK_FILE, COLAB_URL, colabNotebookJson } from '../core/colab/notebook.js'
import { colabServerHash, readColabServerSource } from '../core/colab/resource.js'
import type { ProviderHealth } from '../core/providers/health.js'

/** The provider this feature owns. One Colab connection at a time: connecting again replaces it. */
export const COLAB_PROVIDER_ID = 'colab'
export const COLAB_PROVIDER_LABEL = 'Google Colab (GPU)'

/** What only the Electron side can do. Tests hand in fakes; the app hands in `shell` and `clipboard`. */
export interface ColabHost {
  /** Folder the notebook is written to: visible to the user (Documents\Openclod\Colab). */
  notebookDir: string
  openUrl(url: string): void | Promise<void>
  revealFile(file: string): void
  copyText(text: string): void
}

/** The slice of SettingsStore this service uses. */
export interface ColabSettings {
  get(): AppSettings
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  setSecret(providerId: string, value: string): Promise<void>
  clearSecret(providerId: string): Promise<void>
  resolver(): { get(key: string): string | undefined }
}

export interface ColabServiceDeps {
  settings: ColabSettings
  health: ProviderHealth
  host: ColabHost
  emitChanged(): void
  log?: (message: string) => void
  fetch?: typeof fetch
  readServerSource?: () => string
  serverHash?: () => string | null
  now?: () => number
  /** How long "connect" keeps trying while the new tunnel name reaches this computer's DNS. Tests shorten it. */
  connectWaitMs?: number
  retryDelayMs?: number
}

const STEPS = [
  'No Colab que abriu: Arquivo → Fazer upload de notebook, e arraste para a janela o arquivo mostrado acima (ou clique em Procurar e cole o caminho, que já está copiado).',
  'Ambiente de execução → Executar tudo (Ctrl+F9). O notebook já pede uma GPU; se o Colab mostrar um aviso de segurança sobre o notebook, confirme (o código está legível na 3ª célula).',
  'Espere: na primeira vez leva de 5 a 15 minutos (baixa o motor e o modelo). O progresso aparece no próprio notebook. Na etapa 2 ele para até 2 minutos numa caixa de seleção para você escolher o modelo (botão "Usar este modelo"); se você não escolher, segue com o automático.',
  'No fim aparece o CÓDIGO DE CONEXÃO. Clique em Copiar.',
  'Cole o código aqui no Openclod, confira o que aparece e clique em Conectar. Deixe a aba do Colab aberta.'
]

function plainState(check: ColabLinkCheck): ColabStateName {
  return check.state === 'conectado' ? 'conectado' : check.state
}

/** Settings → Provedores → Google Colab (GPU): prepares the notebook, reads the connection code, keeps the provider honest. */
export class ColabService {
  private lastStatus: { at: number; value: ColabStatusInfo } | null = null
  /** The notebook the button wrote: the only file the user may drag out of the app (the page never names a path). */
  private notebookPath = ''

  constructor(private readonly deps: ColabServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private provider(): ProviderConfig | undefined {
    return this.deps.settings.get().providers.find((provider) => provider.id === COLAB_PROVIDER_ID)
  }

  /* ------------------------------ the button ------------------------------ */

  /**
   * Writes the notebook in a visible folder, selects it in Explorer, copies its path, and opens Colab in the user's browser.
   * Nothing is published anywhere: the user uploads the file themselves (File → Upload notebook).
   */
  async prepare(): Promise<ColabPrepareInfo> {
    const source = (this.deps.readServerSource ?? readColabServerSource)()
    const json = colabNotebookJson({ serverSource: source })
    const folder = this.deps.host.notebookDir
    await fs.promises.mkdir(folder, { recursive: true })
    const file = path.join(folder, COLAB_NOTEBOOK_FILE)
    const tmp = `${file}.tmp`
    await fs.promises.writeFile(tmp, json, 'utf8')
    await fs.promises.rename(tmp, file)
    this.notebookPath = file

    const opened = { colab: false, folder: false, clipboard: false }
    try {
      this.deps.host.copyText(file)
      opened.clipboard = true
    } catch (err) {
      this.deps.log?.(`Colab: não consegui copiar o caminho do notebook: ${(err as Error).message}`)
    }
    try {
      this.deps.host.revealFile(file)
      opened.folder = true
    } catch (err) {
      this.deps.log?.(`Colab: não consegui abrir a pasta do notebook: ${(err as Error).message}`)
    }
    try {
      await this.deps.host.openUrl(COLAB_URL)
      opened.colab = true
    } catch (err) {
      this.deps.log?.(`Colab: não consegui abrir o navegador: ${(err as Error).message}`)
    }
    this.deps.log?.(`Colab: notebook ${COLAB_NOTEBOOK_VERSION} gravado em ${file}`)
    return {
      path: file,
      fileName: COLAB_NOTEBOOK_FILE,
      sizeBytes: Buffer.byteLength(json, 'utf8'),
      folder,
      url: COLAB_URL,
      version: COLAB_NOTEBOOK_VERSION,
      steps: STEPS,
      opened
    }
  }

  /** The notebook written by `prepare`, if it is still on disk: what the tile in the card hands to the drag. */
  notebookFile(): string | null {
    return this.notebookPath && fs.existsSync(this.notebookPath) ? this.notebookPath : null
  }

  /** Shows that notebook in Explorer again. False when nothing was prepared (or the file is gone). */
  revealNotebook(): boolean {
    const file = this.notebookFile()
    if (!file) return false
    this.deps.host.revealFile(file)
    return true
  }

  /* ----------------------------- the pasted code ---------------------------- */

  private verified(connection: ColabConnection): boolean {
    const mine = (this.deps.serverHash ?? colabServerHash)()
    return Boolean(mine && connection.moduleHash && mine === connection.moduleHash)
  }

  /** What the confirmation shows BEFORE anything is saved or contacted. Never includes the key. */
  inspect(pasted: string): ColabInspectResult {
    const decoded = decodeColabCode(pasted, this.now())
    if (!decoded.ok) return { ok: false, error: decoded.error }
    const { connection, warnings } = decoded
    const verified = this.verified(connection)
    const all = [...warnings]
    if (!verified) {
      all.push('O servidor deste notebook não é idêntico ao que esta versão do Openclod gera (o notebook foi editado, ou é de outra versão). Só continue se foi você que o montou.')
    }
    const preview: ColabPreview = {
      host: connection.host,
      hostKind: connection.hostKind,
      model: connection.model,
      gpu: connection.gpu,
      vramMiB: connection.vramMiB,
      vision: connection.vision,
      tools: connection.tools,
      contextWindow: connection.contextWindow,
      notebookVersion: connection.notebookVersion,
      engine: connection.engine,
      createdAt: connection.createdAt,
      verified,
      replacesExisting: Boolean(this.provider()),
      warnings: all
    }
    return { ok: true, preview }
  }

  /** Tries the server until it answers or the wait runs out: a tunnel name that is minutes old may not have reached this DNS yet. */
  private async reach(connection: ColabConnection): Promise<ColabLinkCheck> {
    // The wait budget runs on the real clock: `now` is only for the timestamps the app shows (tests freeze it).
    const deadline = Date.now() + (this.deps.connectWaitMs ?? 25_000)
    let check: ColabLinkCheck
    for (;;) {
      check = await checkColabLink({ baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model, timeoutMs: 10_000, fetch: this.deps.fetch })
      if (check.state !== 'caiu' || Date.now() >= deadline) return check
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? 3000))
    }
  }

  /** Validates the code again (never trusts the preview), asks the server, stores the key in the vault and creates the provider. */
  async connect(pasted: string): Promise<ColabConnectResult> {
    const decoded = decodeColabCode(pasted, this.now())
    if (!decoded.ok) return { ok: false, error: decoded.error }
    const { connection } = decoded
    const check = await this.reach(connection)
    if (check.state !== 'conectado') return { ok: false, error: check.detail, status: this.describe(undefined, check) }

    const document = check.document
    const vision = document?.vision ?? connection.vision
    const tools = document?.tools ?? connection.tools
    const contextWindow = document?.contextWindow ?? connection.contextWindow

    // The key goes to the vault first: if the OS cannot encrypt, nothing else is saved.
    try {
      await this.deps.settings.setSecret(COLAB_PROVIDER_ID, connection.apiKey)
    } catch (err) {
      return { ok: false, error: `Não consegui guardar a chave no cofre do Windows: ${(err as Error).message}` }
    }
    const config: ProviderConfig = {
      id: COLAB_PROVIDER_ID,
      kind: 'openai',
      label: COLAB_PROVIDER_LABEL,
      baseUrl: connection.baseUrl,
      model: connection.model,
      apiKeyRef: `secret:${COLAB_PROVIDER_ID}`,
      contextWindow,
      supportsVision: vision,
      supportsTools: tools,
      models: [connection.model],
      visionModels: vision ? [connection.model] : undefined,
      colab: {
        host: connection.host,
        gpu: document?.gpu || connection.gpu,
        vramMiB: connection.vramMiB,
        notebookVersion: document?.notebook || connection.notebookVersion,
        engine: connection.engine,
        connectedAt: this.now(),
        verified: this.verified(connection)
      }
    }
    const current = this.deps.settings.get().providers
    const providers = current.some((provider) => provider.id === COLAB_PROVIDER_ID)
      ? current.map((provider) => (provider.id === COLAB_PROVIDER_ID ? config : provider))
      : [...current, config]
    await this.deps.settings.update({ providers })
    this.deps.health.clear(COLAB_PROVIDER_ID)
    this.lastStatus = null
    this.deps.log?.(`Colab conectado: ${connection.host} (${connection.model}, ${config.colab?.gpu || 'GPU não informada'})`)
    this.deps.emitChanged()
    return { ok: true, status: this.describe(config, check) }
  }

  /* -------------------------------- the link -------------------------------- */

  private describe(config: ProviderConfig | undefined, check: ColabLinkCheck | undefined): ColabStatusInfo {
    if (!config) {
      return { state: check ? plainState(check) : 'nao-conectado', detail: check?.detail ?? 'Nenhum servidor do Colab conectado.', checkedAt: this.now(), providerId: COLAB_PROVIDER_ID }
    }
    return {
      state: check ? plainState(check) : 'erro',
      detail: check?.detail ?? '',
      checkedAt: this.now(),
      providerId: COLAB_PROVIDER_ID,
      host: config.colab?.host,
      model: config.model,
      gpu: config.colab?.gpu,
      notebookVersion: config.colab?.notebookVersion,
      vision: config.supportsVision,
      contextWindow: config.contextWindow,
      connectedAt: config.colab?.connectedAt,
      latencyMs: check?.ms
    }
  }

  /** Live check of the connected server (cached for 4 s so a polling screen does not hammer the tunnel). */
  async status(options: { fresh?: boolean } = {}): Promise<ColabStatusInfo> {
    const config = this.provider()
    if (!config) return this.describe(undefined, undefined)
    if (!options.fresh && this.lastStatus && this.now() - this.lastStatus.at < 4000) return this.lastStatus.value
    const apiKey = this.deps.settings.resolver().get(COLAB_PROVIDER_ID) ?? ''
    const check: ColabLinkCheck = apiKey
      ? await checkColabLink({ baseUrl: config.baseUrl, apiKey, model: config.model, timeoutMs: 8000, fetch: this.deps.fetch })
      : { state: 'chave', detail: 'A chave deste servidor não está no cofre do Windows. Cole o código de conexão de novo.', ms: 0 }
    // What the check found is what the sessions would find: tell the reserve, so it skips a dead server (and comes back by itself).
    if (check.state === 'caiu') this.deps.health.mark(config, 'network')
    else if (check.state === 'chave') this.deps.health.mark(config, 'auth')
    else if (check.state === 'conectado') this.deps.health.clear(COLAB_PROVIDER_ID)
    const value = this.describe(config, check)
    this.lastStatus = { at: this.now(), value }
    return value
  }

  /** Removes the provider and its key. Sessions that used it start on the default provider the next time. */
  async disconnect(): Promise<ColabStatusInfo> {
    const settings = this.deps.settings.get()
    if (settings.providers.some((provider) => provider.id === COLAB_PROVIDER_ID)) {
      const providers = settings.providers.filter((provider) => provider.id !== COLAB_PROVIDER_ID)
      const patch: Partial<AppSettings> = {
        providers,
        fallbackOrder: (settings.fallbackOrder ?? []).filter((id) => id !== COLAB_PROVIDER_ID),
        fallbackExclude: (settings.fallbackExclude ?? []).filter((id) => id !== COLAB_PROVIDER_ID)
      }
      if (settings.defaultProviderId === COLAB_PROVIDER_ID) {
        patch.defaultProviderId = providers.find((provider) => provider.id === 'deepseek')?.id ?? providers[0]?.id ?? settings.defaultProviderId
      }
      if (settings.visionModel?.providerId === COLAB_PROVIDER_ID) patch.visionModel = undefined
      if (settings.lastModel?.providerId === COLAB_PROVIDER_ID) patch.lastModel = undefined
      await this.deps.settings.update(patch)
    }
    await this.deps.settings.clearSecret(COLAB_PROVIDER_ID)
    this.deps.health.clear(COLAB_PROVIDER_ID)
    this.lastStatus = null
    this.deps.log?.('Colab desconectado')
    this.deps.emitChanged()
    return this.describe(undefined, undefined)
  }
}
