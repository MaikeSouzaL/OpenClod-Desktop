import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  LlamaBudgetInfo,
  LlamaDownloadInfo,
  LlamaHubFilesInfo,
  LlamaHubListInfo,
  LlamaHubRow
} from '../../shared/llamacpp.js'
import {
  CACHE_HOURS,
  FIT_ORDER,
  GENERAL_PAGES,
  HF,
  HF_API,
  REPO,
  budgetFrom,
  choose,
  fetchPages,
  fitOf,
  fixParams,
  generalListUrl,
  merge,
  normalize,
  parseListDevices,
  parseTree,
  pickMmproj,
  repoAlias,
  resolveUrl,
  searchUrl,
  slim,
  supportedArchs,
  type Device,
  type HubEntry,
  type HubFile,
  type HubGet,
  type HubItem
} from '../../core/llamacpp/hub.js'
import { Cancelled, USER_AGENT, cleanEnv, downloadVerified, ensureSpace } from './download.js'

const CHUNK_LOG = 64 << 20

export interface LlamaHubDeps {
  userData: string
  /** The llama-server.exe in use: its llama.dll says which architectures it opens, `--list-devices` which GPUs it sees. */
  exe(): string | null
  /** Context the fit is computed for. */
  ctx(): number
  /** Where downloads go (each repository in its own folder). */
  modelsDir(): string
  /** The list or a download changed (the card also polls). */
  onChanged?(): void
  /** A download finished: the profile uses the new model. */
  onDownloaded(result: { model: string; mmproj?: string; label: string; alias: string }): Promise<void>
  fetch?: typeof fetch
  log?(message: string): void
}

const IDLE: LlamaDownloadInfo = { active: false, repo: '', name: '', file: '', done: 0, total: 0, error: '', finished: '' }

/** Configurações → Provedores → llama.cpp → Baixar: the Hugging Face list for this computer and the downloads. */
export class LlamaHub {
  private items: HubItem[] | null = null
  private status: Pick<LlamaHubListInfo, 'state' | 'updatedAt' | 'error' | 'warning'> = { state: 'vazio' }
  private devices: { exe: string; list: Device[] } | null = null
  private archs: { key: string; set: Set<string> | null } | null = null
  private download: LlamaDownloadInfo = { ...IDLE }
  private abort: AbortController | null = null

  constructor(private readonly deps: LlamaHubDeps) {}

  private cacheFile(): string {
    return path.join(this.deps.userData, 'llamacpp', 'catalogo.json')
  }

  private get: HubGet = async (url) => {
    const response = await (this.deps.fetch ?? fetch)(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { body: await response.json(), link: response.headers.get('link') }
  }

  /** The list from the cache; a cache older than 12 hours (or none) is fetched again in the background. */
  private load(): void {
    if (this.items === null) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as { updatedAt?: number; items?: HubItem[] }
        if (Array.isArray(saved.items)) {
          this.items = saved.items
          this.status = { state: 'pronto', updatedAt: saved.updatedAt }
        }
      } catch {
        /* no cache yet */
      }
    }
    const age = Date.now() - (this.status.updatedAt ?? 0)
    if (this.status.state !== 'carregando' && (this.items === null || age > CACHE_HOURS * 3_600_000)) void this.refresh()
  }

  /** Fetches the list again (the "Atualizar" button). */
  async refresh(): Promise<void> {
    if (this.status.state === 'carregando') return
    this.status = { ...this.status, state: 'carregando', error: undefined }
    this.deps.onChanged?.()
    try {
      const raw = await fetchPages(generalListUrl(), GENERAL_PAGES, this.get)
      if (!raw.length) throw new Error('a lista veio vazia')
      const items = raw.map(slim)
      const updatedAt = Date.now()
      fs.mkdirSync(path.dirname(this.cacheFile()), { recursive: true })
      fs.writeFileSync(this.cacheFile(), JSON.stringify({ updatedAt, items }))
      this.items = items
      this.status = { state: 'pronto', updatedAt }
    } catch (err) {
      this.status = {
        ...this.status,
        state: this.items ? 'pronto' : 'erro',
        error: `Sem resposta do Hugging Face (${(err as Error).message}). Confira a internet e tente de novo.`
      }
    }
    this.deps.onChanged?.()
  }

  /** GPUs llama.cpp sees (`--list-devices`, any vendor), read once per llama-server.exe. */
  private async gpus(): Promise<Device[]> {
    const exe = this.deps.exe()
    if (!exe) return []
    if (this.devices?.exe === exe) return this.devices.list
    const text = await new Promise<string>((resolve) => {
      execFile(exe, ['--list-devices'], { cwd: path.dirname(exe), windowsHide: true, timeout: 20_000, env: cleanEnv() }, (_err, stdout, stderr) =>
        resolve(`${stdout ?? ''}\n${stderr ?? ''}`)
      )
    })
    this.devices = { exe, list: parseListDevices(text) }
    return this.devices.list
  }

  async budget(): Promise<LlamaBudgetInfo> {
    return budgetFrom(await this.gpus(), Math.floor(os.totalmem() / 1_048_576))
  }

  private supported(): Set<string> | null {
    const exe = this.deps.exe()
    const dll = exe ? path.join(path.dirname(exe), 'llama.dll') : ''
    let key = ''
    try {
      key = `${dll}:${fs.statSync(dll).mtimeMs}`
    } catch {
      return null
    }
    if (this.archs?.key !== key) this.archs = { key, set: supportedArchs(fs.readFileSync(dll)) }
    return this.archs.set
  }

  /** Repository folder name for downloads: "unsloth/Qwen3-8B-GGUF" → "unsloth--Qwen3-8B-GGUF". */
  private target(repo: string, name: string): string {
    return path.join(this.deps.modelsDir(), repo.replace('/', '--'), name)
  }

  private downloaded(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const root = this.deps.modelsDir()
    let folders: string[] = []
    try {
      folders = fs.readdirSync(root)
    } catch {
      return out
    }
    for (const folder of folders) {
      let names: string[] = []
      try {
        names = fs.readdirSync(path.join(root, folder)).filter((name) => /\.gguf$/i.test(name) && !/mmproj/i.test(name))
      } catch {
        continue
      }
      if (names.length) out.set(folder.replace('--', '/'), names.sort().map((name) => path.join(root, folder, name)))
    }
    return out
  }

  private rows(entries: HubEntry[], ctx: number, budget: LlamaBudgetInfo): LlamaHubRow[] {
    const have = this.downloaded()
    const rows: LlamaHubRow[] = []
    for (const entry of entries) {
      const pick = choose(entry, ctx, budget)
      if (!pick) continue
      rows.push({
        repo: entry.repo,
        author: entry.author,
        name: entry.name,
        params: entry.params,
        paramsGuess: Boolean(entry.paramsGuess),
        arch: entry.arch,
        moe: entry.moe,
        context: entry.context,
        vision: entry.vision,
        tools: entry.tools,
        thinking: entry.thinking,
        license: entry.license,
        gated: entry.gated,
        downloads: entry.downloadsTotal ?? entry.downloads,
        sources: entry.sources ?? 1,
        quant: pick.quant,
        bytes: pick.bytes,
        fit: pick.fit,
        local: have.get(entry.repo) ?? []
      })
    }
    return rows.sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit] || b.downloads - a.downloads)
  }

  private entries(items: HubItem[]): HubEntry[] {
    const archs = this.supported()
    return items.map((item) => normalize(item, archs)).filter((entry): entry is HubEntry => entry !== null && entry.supported !== false)
  }

  /** What the Baixar list shows: the machine, the list's state and each model with the suggested quantization and its fit. */
  async list(): Promise<LlamaHubListInfo> {
    this.load()
    const ctx = this.ctx()
    const budget = await this.budget()
    const models = this.items ? this.rows(merge(fixParams(this.entries(this.items))), ctx, budget) : []
    return { ...this.status, budget, ctx, models, download: { ...this.download } }
  }

  /** Free text on Hugging Face (one page), for what the list does not have. */
  async search(query: string): Promise<LlamaHubListInfo> {
    const text = query.trim()
    if (text.length < 2) throw new Error('Digite pelo menos 2 letras para procurar.')
    let found: HubItem[]
    try {
      found = await fetchPages(searchUrl(text), 1, this.get)
    } catch (err) {
      throw new Error(`Sem resposta do Hugging Face (${(err as Error).message}).`)
    }
    const entries = this.entries(found.map(slim))
    // The whole list gives each architecture's median parameter count.
    fixParams([...entries, ...this.entries(this.items ?? [])])
    const ctx = this.ctx()
    const budget = await this.budget()
    return { ...this.status, budget, ctx, models: this.rows(merge(entries), ctx, budget), download: { ...this.download } }
  }

  private ctx(): number {
    return Math.max(2048, Math.round(this.deps.ctx()) || 32_768)
  }

  /** The list's model, or read from Hugging Face when it came from outside the list. */
  private async entry(repo: string): Promise<HubEntry> {
    const archs = this.supported()
    const listed = this.items?.find((item) => item.id === repo)
    const known = listed ? normalize(listed, archs) : null
    if (known) return known
    let info: unknown
    try {
      info = (await this.get(`${HF_API}/${repo}?${['gguf', 'pipeline_tag', 'downloads', 'cardData', 'gated', 'tags'].map((field) => `expand[]=${field}`).join('&')}`)).body
    } catch (err) {
      throw new Error(`Não consegui ler ${repo} no Hugging Face (${(err as Error).message}).`)
    }
    const entry = normalize(slim(info as HubItem), archs)
    if (!entry) throw new Error(`${repo} não é um modelo de conversa em GGUF.`)
    return entry
  }

  private async tree(repo: string): Promise<HubFile[]> {
    try {
      return parseTree((await this.get(`${HF_API}/${repo}/tree/main?recursive=1`)).body)
    } catch (err) {
      throw new Error(`Não consegui ler os arquivos de ${repo} no Hugging Face (${(err as Error).message}).`)
    }
  }

  /** The repository's real files: each quantization with its exact size and fit, and the suggested one. */
  async files(repo: string): Promise<LlamaHubFilesInfo> {
    if (!REPO.test(repo)) throw new Error('Repositório inválido.')
    const ctx = this.ctx()
    const entry = await this.entry(repo)
    const found = await this.tree(repo)
    const mmproj = pickMmproj(found)
    if (mmproj) Object.assign(entry, { vision: true, mmprojBytes: mmproj.bytes })
    const budget = await this.budget()
    const files = found
      .filter((file) => !file.mmproj)
      .map((file) => ({
        path: file.path,
        name: file.name,
        bytes: file.bytes,
        sha256: file.sha256,
        quant: file.quant,
        fit: fitOf(entry, file.bytes, ctx, budget),
        local: fs.existsSync(this.target(repo, file.name))
      }))
    if (!files.length) {
      throw new Error('Este repositório só tem o modelo dividido em partes (ou nenhum .gguf inteiro): grande demais para baixar por aqui. Abra a página dele no Hugging Face.')
    }
    const pick = choose(entry, ctx, budget, found)
    const suggested = files.find((file) => pick && file.quant === pick.quant)?.name ?? files[0].name
    return {
      repo,
      files,
      suggested,
      ...(mmproj ? { mmproj: { name: mmproj.name, bytes: mmproj.bytes } } : {}),
      vision: entry.vision,
      gated: entry.gated,
      ctx,
      url: `${HF}/${repo}`
    }
  }

  downloadStatus(): LlamaDownloadInfo {
    return { ...this.download }
  }

  /** "Baixar e usar": the chosen file (and the repository's vision projector), in the background; then the profile uses it. */
  startDownload(repo: string, name: string): LlamaDownloadInfo {
    if (this.download.active) throw new Error('Já há um modelo baixando.')
    if (!REPO.test(repo) || !/\.gguf$/i.test(name) || name.includes('/') || name.includes('\\')) throw new Error('Escolha um arquivo .gguf do repositório.')
    this.abort = new AbortController()
    this.download = { ...IDLE, active: true, repo, name, file: 'lendo os arquivos…' }
    this.deps.onChanged?.()
    void this.run(repo, name, this.abort.signal)
    return this.downloadStatus()
  }

  cancelDownload(): LlamaDownloadInfo {
    this.abort?.abort()
    return this.downloadStatus()
  }

  private async run(repo: string, name: string, signal: AbortSignal): Promise<void> {
    try {
      const found = await this.tree(repo)
      const chosen = found.find((file) => file.name === name && !file.mmproj)
      if (!chosen) throw new Error(`O arquivo ${name} não está mais no repositório.`)
      if ((await this.entry(repo)).gated) throw new Error('Este modelo exige aceitar a licença no Hugging Face antes de baixar (abra a página dele).')
      const mmproj = pickMmproj(found)
      const items = mmproj ? [chosen, mmproj] : [chosen]
      const paths = await this.fetchFiles(repo, items, signal)
      await this.deps.onDownloaded({
        model: paths[0],
        ...(mmproj ? { mmproj: paths[1] } : {}),
        label: `${repo.split('/')[1].replace(/[-_.](i1-)?gguf$/i, '')} · ${chosen.quant || chosen.name}`,
        alias: repoAlias(repo)
      })
      this.download = { ...this.download, active: false, file: '', finished: paths[0] }
      this.deps.log?.(`llama.cpp: baixei ${repo}/${name}`)
    } catch (err) {
      this.download = {
        ...this.download,
        active: false,
        error:
          err instanceof Cancelled || signal.aborted
            ? 'Download cancelado. O que já veio fica guardado: clique de novo para continuar.'
            : (err as Error).message
      }
    } finally {
      this.abort = null
      this.deps.onChanged?.()
    }
  }

  /**
   * Downloads with size and SHA-256 checked (the LFS "oid" Hugging Face publishes), resuming a `.part` left behind.
   * A file already whole is not downloaded again.
   */
  private async fetchFiles(repo: string, items: HubFile[], signal: AbortSignal): Promise<string[]> {
    const folder = path.dirname(this.target(repo, items[0].name))
    fs.mkdirSync(folder, { recursive: true })
    ensureSpace(folder, items.reduce((sum, file) => sum + (fs.existsSync(this.target(repo, file.name)) ? 0 : file.bytes), 0))
    this.download.total = items.reduce((sum, file) => sum + file.bytes, 0) || 1
    let done = 0
    const paths: string[] = []
    for (const file of items) {
      const dest = this.target(repo, file.name)
      this.download = { ...this.download, file: file.name, done }
      this.deps.onChanged?.()
      let logged = 0
      await downloadVerified({
        url: resolveUrl(repo, file.path),
        dest,
        bytes: file.bytes,
        sha256: file.sha256,
        label: file.name,
        signal,
        fetch: this.deps.fetch,
        onProgress: (bytes) => {
          this.download.done = done + bytes
          if (bytes - logged > CHUNK_LOG) {
            logged = bytes
            this.deps.onChanged?.()
          }
        }
      })
      done += file.bytes
      paths.push(dest)
    }
    fs.writeFileSync(
      path.join(folder, 'openclod-origem.json'),
      `${JSON.stringify({ repo, files: Object.fromEntries(items.map((file) => [file.name, file.sha256])), baixadoEm: new Date().toISOString() }, null, 2)}\n`
    )
    return paths
  }
}
