import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import type { LlamaBuildDownloadInfo, LlamaCppBuildInfo, LlamaMachineInfo } from '../../shared/llamacpp.js'
import {
  BUILD_KINDS,
  BUILD_MANIFEST,
  BUNDLED_TAG,
  LLAMACPP_REPO,
  SERVER_FILES,
  assetNames,
  buildId,
  isBuildTag,
  kindRuns,
  parseBuildId,
  parseNvidiaHeader,
  parseNvidiaQuery,
  recommendKind,
  type BuildKind
} from '../../core/llamacpp/builds.js'
import { Cancelled, USER_AGENT, downloadVerified, ensureSpace } from './download.js'

const GITHUB_API = `https://api.github.com/repos/${LLAMACPP_REPO}`

interface GithubAsset {
  name: string
  size: number
  digest?: string | null
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GithubAsset[]
}

export interface LlamaBuildsDeps {
  /** `<userData>`: downloaded builds go to llamacpp/builds/<tag>-<kind>/. */
  userData: string
  /** Folder of the Vulkan build shipped with the app (null when it is not there). */
  bundledDir(): string | null
  fetch?: typeof fetch
  log?(message: string): void
}

const IDLE: LlamaBuildDownloadInfo = { active: false, id: '', file: '', done: 0, total: 0, error: '', finished: '' }

/**
 * Configurações → Provedores → llama.cpp → Versões: the bundled Vulkan build and the official ones downloaded from
 * GitHub (CUDA for NVIDIA is the fastest there). Every asset is checked against the SHA-256 GitHub publishes, and only
 * what llama-server loads is kept.
 */
export class LlamaBuilds {
  private download: LlamaBuildDownloadInfo = { ...IDLE }
  private abort: AbortController | null = null
  private releases: { at: number; list: GithubRelease[] } | null = null
  private nvidia: { at: number; info: Awaited<ReturnType<LlamaBuilds['readNvidia']>> } | null = null

  constructor(private readonly deps: LlamaBuildsDeps) {}

  dir(): string {
    return path.join(this.deps.userData, 'llamacpp', 'builds')
  }

  /** The bundled build first, then the downloaded ones, newest first. */
  list(): LlamaCppBuildInfo[] {
    const out: LlamaCppBuildInfo[] = []
    const bundled = this.deps.bundledDir()
    if (bundled && fs.existsSync(path.join(bundled, 'llama-server.exe'))) {
      out.push({ id: buildId(BUNDLED_TAG, 'vulkan'), tag: BUNDLED_TAG, kind: 'vulkan', label: `${BUILD_KINDS.vulkan.label} · ${BUNDLED_TAG}`, exe: path.join(bundled, 'llama-server.exe'), bundled: true })
    }
    let folders: string[] = []
    try {
      folders = fs.readdirSync(this.dir())
    } catch {
      return out
    }
    const installed: LlamaCppBuildInfo[] = []
    for (const folder of folders) {
      const parsed = parseBuildId(folder)
      const exe = path.join(this.dir(), folder, 'llama-server.exe')
      if (!parsed || !fs.existsSync(exe) || !fs.existsSync(path.join(this.dir(), folder, BUILD_MANIFEST))) continue
      installed.push({ id: folder, tag: parsed.tag, kind: parsed.kind, label: `${BUILD_KINDS[parsed.kind].label} · ${parsed.tag}`, exe, bundled: false })
    }
    installed.sort((a, b) => Number(b.tag.slice(1)) - Number(a.tag.slice(1)) || a.kind.localeCompare(b.kind))
    return [...out, ...installed]
  }

  find(id: string | undefined): LlamaCppBuildInfo | undefined {
    const all = this.list()
    return all.find((build) => build.id === id) ?? all[0]
  }

  private async readNvidia(): Promise<{ driver?: string; cudaMax?: [number, number]; gpus: Array<{ name: string; vramMiB: number; freeMiB?: number }> }> {
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve) => execFile('nvidia-smi', args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? '' : String(stdout))))
    const [header, query] = await Promise.all([run([]), run(['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'])])
    return { ...parseNvidiaHeader(header), gpus: parseNvidiaQuery(query) }
  }

  /** What this computer can run: the NVIDIA cards and the CUDA their driver accepts, the build to suggest, and each kind. */
  async machine(): Promise<LlamaMachineInfo> {
    if (!this.nvidia || Date.now() - this.nvidia.at > 60_000) this.nvidia = { at: Date.now(), info: await this.readNvidia() }
    const info = this.nvidia.info
    const nvidia = info.gpus.length > 0
    return {
      gpus: info.gpus,
      ...(info.driver ? { driver: info.driver } : {}),
      ...(info.cudaMax ? { cudaMax: `${info.cudaMax[0]}.${info.cudaMax[1]}` } : {}),
      suggested: recommendKind({ nvidia, cudaMax: info.cudaMax }),
      kinds: (Object.keys(BUILD_KINDS) as BuildKind[]).map((kind) => ({
        kind,
        label: BUILD_KINDS[kind].label,
        note: BUILD_KINDS[kind].note,
        runs: BUILD_KINDS[kind].cuda ? nvidia && kindRuns(kind, info.cudaMax) : true
      }))
    }
  }

  private async get(url: string): Promise<unknown> {
    const response = await (this.deps.fetch ?? fetch)(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  /** The newest `bNNNNN` releases (GitHub's "latest" can be a `vX.Y.Z` tag), kept for an hour. */
  private async recent(): Promise<GithubRelease[]> {
    if (this.releases && Date.now() - this.releases.at < 3_600_000) return this.releases.list
    const list = ((await this.get(`${GITHUB_API}/releases?per_page=20`)) as GithubRelease[]).filter(
      (release) => release && isBuildTag(release.tag_name) && !release.draft
    )
    this.releases = { at: Date.now(), list }
    return list
  }

  /** The newest tag with this kind's assets for Windows x64. */
  async newest(kind: BuildKind): Promise<string> {
    for (const release of await this.recent()) {
      const names = new Set((release.assets ?? []).map((asset) => asset.name))
      if (assetNames(release.tag_name, kind).every((name) => names.has(name))) return release.tag_name
    }
    return BUNDLED_TAG
  }

  status(): LlamaBuildDownloadInfo {
    return { ...this.download }
  }

  /** Downloads and installs a build in the background. `tag` = "newest" picks the newest release that has it. */
  start(kind: BuildKind, tag: string): LlamaBuildDownloadInfo {
    if (this.download.active) throw new Error('Já há uma versão baixando.')
    if (!(kind in BUILD_KINDS)) throw new Error('Tipo de versão desconhecido.')
    if (tag !== 'newest' && !isBuildTag(tag)) throw new Error('Versão inválida.')
    this.abort = new AbortController()
    this.download = { ...IDLE, active: true, id: tag === 'newest' ? kind : buildId(tag, kind), file: 'procurando a versão…' }
    void this.install(kind, tag, this.abort.signal)
    return this.status()
  }

  cancel(): LlamaBuildDownloadInfo {
    this.abort?.abort()
    return this.status()
  }

  private async install(kind: BuildKind, wanted: string, signal: AbortSignal): Promise<void> {
    try {
      const tag = wanted === 'newest' ? await this.newest(kind) : wanted
      const id = buildId(tag, kind)
      this.download.id = id
      const target = path.join(this.dir(), id)
      if (fs.existsSync(path.join(target, BUILD_MANIFEST)) && fs.existsSync(path.join(target, 'llama-server.exe'))) {
        this.download = { ...this.download, active: false, file: '', finished: id }
        return
      }
      let release: GithubRelease
      try {
        release = (await this.get(`${GITHUB_API}/releases/tags/${tag}`)) as GithubRelease
      } catch (err) {
        throw new Error(`Não consegui ler a versão ${tag} no GitHub (${(err as Error).message}).`)
      }
      const assets = assetNames(tag, kind).map((name) => {
        const asset = release.assets?.find((item) => item.name === name)
        if (!asset) throw new Error(`A versão ${tag} não tem ${name}.`)
        const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]
        if (!sha) throw new Error(`O GitHub não publicou o SHA-256 de ${name}: não instalo sem conferir.`)
        return { ...asset, sha }
      })
      const staging = path.join(this.dir(), `.${id}.download`)
      fs.mkdirSync(staging, { recursive: true })
      const total = assets.reduce((sum, asset) => sum + asset.size, 0)
      // The zips, plus what comes out of them (about twice).
      ensureSpace(staging, total * 3)
      this.download.total = total
      let done = 0
      for (const asset of assets) {
        this.download.file = asset.name
        await downloadVerified({
          url: asset.browser_download_url,
          dest: path.join(staging, asset.name),
          bytes: asset.size,
          sha256: asset.sha,
          label: asset.name,
          signal,
          fetch: this.deps.fetch,
          onProgress: (bytes) => (this.download.done = done + bytes)
        })
        done += asset.size
      }
      this.download.file = 'extraindo…'
      const unpacked = path.join(staging, 'files')
      fs.rmSync(unpacked, { recursive: true, force: true })
      fs.mkdirSync(unpacked, { recursive: true })
      const files: Array<{ name: string; size: number }> = []
      for (const asset of assets) files.push(...(await extractServerFiles(path.join(staging, asset.name), unpacked, signal)))
      if (!fs.existsSync(path.join(unpacked, 'llama-server.exe'))) throw new Error(`${assets[0].name} não tem o llama-server.exe.`)
      fs.writeFileSync(
        path.join(unpacked, BUILD_MANIFEST),
        `${JSON.stringify({ tag, kind, assets: assets.map((asset) => ({ name: asset.name, sha256: asset.sha })), source: `https://github.com/${LLAMACPP_REPO}/releases/tag/${tag}`, files }, null, 2)}\n`
      )
      fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(unpacked, target)
      fs.rmSync(staging, { recursive: true, force: true })
      this.download = { ...this.download, active: false, file: '', finished: id }
      this.deps.log?.(`llama.cpp: instalei a versão ${id}`)
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
    }
  }

  /** Removes a downloaded build (the bundled one stays). */
  remove(id: string): void {
    const build = this.list().find((item) => item.id === id)
    if (!build) throw new Error('Versão não encontrada.')
    if (build.bundled) throw new Error('A versão embutida não pode ser removida.')
    fs.rmSync(path.join(this.dir(), id), { recursive: true, force: true })
  }
}

/**
 * Streams a release zip and writes only the files llama-server loads (by base name: the official zips are flat). The
 * zip is never held in memory whole: the CUDA runtime package is ~400 MB.
 */
function extractServerFiles(zip: string, outDir: string, signal: AbortSignal): Promise<Array<{ name: string; size: number }>> {
  return new Promise((resolve, reject) => {
    const written: Array<{ name: string; size: number }> = []
    const open = new Set<number>()
    let failed = false
    const fail = (err: Error): void => {
      if (failed) return
      failed = true
      for (const fd of open) fs.closeSync(fd)
      reject(err)
    }
    const unzip = new Unzip((file) => {
      const name = path.basename(file.name.replace(/\\/g, '/'))
      if (file.name.endsWith('/') || !SERVER_FILES.test(name)) return
      const fd = fs.openSync(path.join(outDir, name), 'w')
      open.add(fd)
      let size = 0
      file.ondata = (err, data, final) => {
        if (failed) return
        if (err) return fail(new Error(`${path.basename(zip)}: ${err.message}`))
        fs.writeSync(fd, data)
        size += data.byteLength
        if (final) {
          fs.closeSync(fd)
          open.delete(fd)
          written.push({ name, size })
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    unzip.register(UnzipPassThrough)
    const input = fs.createReadStream(zip, { highWaterMark: 1 << 20 })
    signal.addEventListener('abort', () => input.destroy(new Cancelled()), { once: true })
    input.on('data', (chunk) => {
      try {
        unzip.push(chunk as Buffer)
      } catch (err) {
        fail(err as Error)
        input.destroy()
      }
    })
    input.on('error', (err) => fail(err))
    input.on('end', () => {
      try {
        unzip.push(new Uint8Array(0), true)
      } catch (err) {
        return fail(err as Error)
      }
      if (!failed) resolve(written)
    })
  })
}
