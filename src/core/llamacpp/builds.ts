/**
 * The llama.cpp builds Openclod can run: the Vulkan one that ships inside the app (scripts/embed-llamacpp.mjs) and the
 * official ones downloaded from github.com/ggml-org/llama.cpp/releases (CUDA for NVIDIA, CPU only). Pure: the main
 * process does the downloading, unzipping and running.
 */

/** The build bundled with the app (keep in sync with scripts/embed-llamacpp.mjs). */
export const BUNDLED_TAG = 'b11972'
export const LLAMACPP_REPO = 'ggml-org/llama.cpp'
/** Written next to the binaries of every build Openclod installs: tag, kind and the hash of each file. */
export const BUILD_MANIFEST = 'openclod-build.json'

export type BuildKind = 'vulkan' | 'cuda-13.4' | 'cuda-12.4' | 'cpu'

export interface BuildKindInfo {
  label: string
  note: string
  /** Release assets that make up the build (`{tag}` is replaced); CUDA needs its runtime package too. */
  assets: string[]
  /** CUDA version the build was compiled with: the NVIDIA driver must accept at least this one. */
  cuda?: [number, number]
}

export const BUILD_KINDS: Record<BuildKind, BuildKindInfo> = {
  vulkan: {
    label: 'Vulkan',
    note: 'qualquer GPU (NVIDIA, AMD, Intel) e a CPU — vem embutido',
    assets: ['llama-{tag}-bin-win-vulkan-x64.zip']
  },
  'cuda-13.4': {
    label: 'CUDA 13.4',
    note: 'NVIDIA cujo driver aceita CUDA 13.4 ou mais: o mais rápido nessas placas',
    assets: ['llama-{tag}-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip'],
    cuda: [13, 4]
  },
  'cuda-12.4': {
    label: 'CUDA 12.4',
    note: 'NVIDIA com driver mais antigo (aceita CUDA 12.4 a 13.3)',
    assets: ['llama-{tag}-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
    cuda: [12, 4]
  },
  cpu: {
    label: 'Só CPU',
    note: 'sem GPU',
    assets: ['llama-{tag}-bin-win-cpu-x64.zip']
  }
}

/**
 * The files `llama-server` loads: the server and its DLLs, every ggml backend, OpenMP, the CUDA runtime and cuBLAS of the
 * CUDA builds, and the licenses. The rest of a release (llama-cli, llama-bench, the quantizer...) is left out.
 */
export const SERVER_FILES =
  /^(llama-server\.exe|llama-server-impl\.dll|llama-common\.dll|llama\.dll|mtmd\.dll|ggml[\w.-]*\.dll|libomp\.dll|cudart64_\d+\.dll|cublas64_\d+\.dll|cublasLt64_\d+\.dll|LICENSE[\w.-]*)$/i

const TAG = /^b\d{3,6}$/

export function isBuildTag(tag: string): boolean {
  return TAG.test(tag)
}

export function buildId(tag: string, kind: BuildKind): string {
  return `${tag}-${kind}`
}

/** "b11972-cuda-12.4" → tag and kind; null when the folder name is not one of ours. */
export function parseBuildId(id: string): { tag: string; kind: BuildKind } | null {
  const dash = id.indexOf('-')
  if (dash < 0) return null
  const tag = id.slice(0, dash)
  const kind = id.slice(dash + 1)
  if (!isBuildTag(tag) || !(kind in BUILD_KINDS)) return null
  return { tag, kind: kind as BuildKind }
}

export function assetNames(tag: string, kind: BuildKind): string[] {
  return BUILD_KINDS[kind].assets.map((asset) => asset.replace('{tag}', tag))
}

export interface GpuInfo {
  name: string
  /** Total memory, MiB. */
  vramMiB: number
  /** Free memory right now, MiB, when the tool reports it. */
  freeMiB?: number
}

export interface NvidiaInfo {
  driver?: string
  /** Highest CUDA version the installed driver runs ("CUDA Version" in the nvidia-smi header). */
  cudaMax?: [number, number]
  gpus: GpuInfo[]
}

/**
 * The header of a plain `nvidia-smi` run: "Driver Version: 576.02   CUDA Version: 12.9", or on newer drivers
 * "KMD Version: 610.88   CUDA UMD Version: 13.3".
 */
export function parseNvidiaHeader(text: string): Pick<NvidiaInfo, 'driver' | 'cudaMax'> {
  const driver = /(?:Driver|KMD) Version:\s*([\d.]+)/i.exec(text)?.[1]
  const cuda = /CUDA (?:UMD )?Version:\s*(\d+)\.(\d+)/i.exec(text)
  return { ...(driver ? { driver } : {}), ...(cuda ? { cudaMax: [Number(cuda[1]), Number(cuda[2])] as [number, number] } : {}) }
}

/** `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` → one GPU per line. */
export function parseNvidiaQuery(csv: string): GpuInfo[] {
  const gpus: GpuInfo[] = []
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 2 || !parts[0]) continue
    const vramMiB = Number(parts[1])
    if (!Number.isFinite(vramMiB) || vramMiB <= 0) continue
    const free = Number(parts[2])
    gpus.push({ name: parts[0], vramMiB, ...(Number.isFinite(free) && parts[2] !== undefined && parts[2] !== '' ? { freeMiB: free } : {}) })
  }
  return gpus
}

const atLeast = (have: [number, number], need: [number, number]): boolean => have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1])

/**
 * The build to suggest: on an NVIDIA card, the newest CUDA build the driver can run (a CUDA newer than the driver fails
 * with "PTX was compiled with an unsupported toolchain"); everywhere else — and when the driver is too old for any CUDA
 * build — the bundled Vulkan one, which also runs on AMD, Intel and the CPU.
 */
export function recommendKind(info: { nvidia: boolean; cudaMax?: [number, number] }): BuildKind {
  if (!info.nvidia || !info.cudaMax) return 'vulkan'
  for (const kind of ['cuda-13.4', 'cuda-12.4'] as const) {
    const need = BUILD_KINDS[kind].cuda
    if (need && atLeast(info.cudaMax, need)) return kind
  }
  return 'vulkan'
}

/** Whether a CUDA build can run with this driver; Vulkan and CPU always can. */
export function kindRuns(kind: BuildKind, cudaMax: [number, number] | undefined): boolean {
  const need = BUILD_KINDS[kind].cuda
  return !need || (cudaMax ? atLeast(cudaMax, need) : false)
}
