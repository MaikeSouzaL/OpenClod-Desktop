/**
 * Contract of the embedded llama.cpp (Configurações → Provedores → llama.cpp): the local engine Openclod starts itself,
 * instead of talking to an Ollama the user had to run. Shared by the main process, the preload and the screens.
 */

/** The provider the running server becomes in the model picker. */
export const LLAMACPP_PROVIDER_ID = 'llamacpp'
export const LLAMACPP_PROVIDER_LABEL = 'llama.cpp (local)'

export type LlamaServerState = 'parado' | 'iniciando' | 'pronto' | 'erro'

/** What the screens show about a .gguf on disk (read from its header). */
export interface LlamaModelInfo {
  path: string
  /** Shown name: the model name in the file, else the file name. */
  name: string
  arch: string
  sizeLabel: string
  quant: string
  /** Training context, tokens. */
  context: number
  layers: number
  tools: boolean
  thinking: boolean
  bytes: number
  /** The vision projector found next to the model (or paired by the source, e.g. an Ollama manifest). */
  mmproj?: string
}

/** A .gguf found on this computer (only names and sizes are read; the header is read when one is chosen). */
export interface LlamaLocalModel {
  path: string
  /** "qwen3.5:4b" for an Ollama model, "org/repo · file.gguf" in the Hugging Face cache, else the file name. */
  name: string
  /** Where it was found: Ollama, Baixados, LM Studio, Hugging Face, llama.cpp, Pasta, Downloads. */
  source: string
  bytes: number
  /** The paired projector: the one in the Ollama manifest, or the first mmproj in the same folder. */
  mmproj?: string
  /** Name the API reports when this model runs ("qwen3.5-4b"). */
  alias: string
}

/** The options of the next run. Kept in `<userData>/config/llamacpp.json`. */
export interface LlamaCppProfile {
  model?: string
  mmproj?: string
  alias?: string
  /** Name shown for the model, from where it was found ("qwen3.5:4b"); the header's name when unset. */
  label?: string
  /** Folders the user added to the model search. */
  folders: string[]
  ctxSize: number
  parallel: number
  /** Start the server when Openclod opens, so the provider is ready without a click. */
  autostart: boolean
  values: Record<string, string | boolean | null>
  extraArgs: string[]
}

export interface LlamaCppBuildInfo {
  id: string
  tag: string
  kind: string
  label: string
  exe: string
  /** Shipped inside the app (the Vulkan build). */
  bundled: boolean
}

export interface LlamaCppStatusInfo {
  /** A llama-server.exe exists to run. */
  available: boolean
  /** Why it is not available. */
  reason?: string
  build?: LlamaCppBuildInfo
  state: LlamaServerState
  error?: string
  hint?: string
  port?: number
  pid?: number
  startedAt?: number
  readyAt?: number
  /** Tokens per second of the last request. */
  speed: { prompt: number; gen: number }
  /** "33/33" layers on the GPU, when the log says it. */
  offload: string
  /** The GPU the model is on, and the device memory llama.cpp planned for it (MiB). */
  device?: string
  deviceMiB?: number
  /** Context the server really opened, per slot (from /props). */
  nCtx?: number
  slots?: number
  vision: boolean
  /** Build string the server reports. */
  serverBuild?: string
  model?: LlamaModelInfo
  /** The active profile with the shared settings (autostart, folders). */
  profile: LlamaCppProfile
  /** Names of the saved profiles, and the active one. */
  profiles: string[]
  activeProfile: string
  /** The bundled build and the downloaded ones; `build` is the one that runs. */
  builds: LlamaCppBuildInfo[]
  providerId: typeof LLAMACPP_PROVIDER_ID
}

export interface LlamaCppLogInfo {
  seq: number
  lines: string[]
}

/** What this computer can run (Versões): the NVIDIA cards, the CUDA their driver accepts and the build to suggest. */
export interface LlamaMachineInfo {
  gpus: Array<{ name: string; vramMiB: number; freeMiB?: number }>
  driver?: string
  /** Highest CUDA the NVIDIA driver runs, "13.3". */
  cudaMax?: string
  suggested: string
  kinds: Array<{ kind: string; label: string; note: string; runs: boolean }>
}

export interface LlamaBuildDownloadInfo {
  active: boolean
  /** "b11972-cuda-12.4" once the tag is known. */
  id: string
  file: string
  done: number
  total: number
  error: string
  /** The build id when the last install finished. */
  finished: string
}

export type LlamaOptionKind = 'bool' | 'tri' | 'choice' | 'multi' | 'number' | 'file' | 'dir' | 'pair' | 'text'

/** One llama-server option of the options screen (read from the running build's --help). */
export interface LlamaOptionField {
  key: string
  flags: string[]
  value: string
  kind: LlamaOptionKind
  choices: string[]
  default: string
  env: string
  help: string
  deprecated: boolean
  label: string
  tip: string
  curated: boolean
  min?: number
  max?: number
}

export interface LlamaOptionsInfo {
  /** Build whose help the fields came from. */
  build: string
  groups: Array<{ id: string; name: string; fields: LlamaOptionField[] }>
  /** The command line of the next start, as the Command Prompt shows it (the key is never in it). */
  commandLine: string
  /** Why the command line could not be built (an invalid value), in Portuguese. */
  error?: string
}

/** "gpu" (all on the GPU), "misto" (GPU + RAM, slower), "cpu" (no GPU, fits the RAM) or "nao" (does not fit). */
export type LlamaFit = 'gpu' | 'misto' | 'cpu' | 'nao'

/** What this computer has for a model: the biggest GPU and the RAM, and how much of each a model may use (MiB). */
export interface LlamaBudgetInfo {
  gpu: string
  vramMiB: number
  ramMiB: number
  vramUseMiB: number
  ramUseMiB: number
}

/** One model of the Hugging Face list, with the quantization suggested for this computer (estimated sizes). */
export interface LlamaHubRow {
  repo: string
  author: string
  name: string
  /** Billions of parameters. */
  params: number
  paramsGuess: boolean
  arch: string
  moe: boolean
  context: number
  vision: boolean
  tools: boolean
  thinking: boolean
  license: string
  /** The repository asks to accept a license on Hugging Face before downloading. */
  gated: boolean
  downloads: number
  /** Copies of the same model by other publishers. */
  sources: number
  quant: string
  bytes: number
  fit: LlamaFit
  /** Files of this repository already downloaded. */
  local: string[]
}

export interface LlamaDownloadInfo {
  active: boolean
  repo: string
  name: string
  /** The file coming now (the model, then its projector). */
  file: string
  done: number
  total: number
  error: string
  /** The model file when the last download finished. */
  finished: string
}

export interface LlamaHubListInfo {
  state: 'vazio' | 'carregando' | 'pronto' | 'erro'
  updatedAt?: number
  error?: string
  warning?: string
  budget: LlamaBudgetInfo
  /** Context the fit was computed for (the profile's). */
  ctx: number
  models: LlamaHubRow[]
  download: LlamaDownloadInfo
}

export interface LlamaHubFileRow {
  path: string
  name: string
  bytes: number
  sha256: string
  quant: string
  fit: LlamaFit
  local: boolean
}

/** The real files of a repository, with exact sizes, each one's fit, and the suggested one. */
export interface LlamaHubFilesInfo {
  repo: string
  files: LlamaHubFileRow[]
  suggested: string
  mmproj?: { name: string; bytes: number }
  vision: boolean
  gated: boolean
  ctx: number
  url: string
}
