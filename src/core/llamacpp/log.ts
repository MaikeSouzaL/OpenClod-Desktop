/**
 * What the llama-server log says about a run: generation speed, how many layers went to the GPU, and — when something
 * goes wrong — the error in plain Portuguese with what to do (the original line stays in the log).
 */

export interface ServerLogStats {
  /** Tokens per second of the last request: prompt processing and generation. */
  speed: { prompt: number; gen: number }
  /** "33/33" when llama.cpp reports the layers it put on the GPU. */
  offload: string
  /** The GPU the model was loaded on ("NVIDIA GeForce RTX 2060"); empty on CPU. */
  device: string
  /** Device memory llama.cpp planned to use for the model, the KV cache and the compute buffers, MiB. */
  deviceMiB: number
  /** What to do about the last known error, in Portuguese; empty when none matched. */
  hint: string
  /** The error to show: the hint when there is one, else the end of the error line. */
  error: string
}

/** Common llama-server failures → what to do. The needle is matched against each log line. */
export const LLAMA_HINTS: Array<[needle: string, hint: string]> = [
  [
    'PTX was compiled with an unsupported toolchain',
    'O driver da NVIDIA é mais antigo que o CUDA desta versão do llama.cpp. Atualize o driver ou use a versão Vulkan (embutida) ou uma CUDA mais antiga em Versões.'
  ],
  ['no kernel image is available', 'Esta versão CUDA do llama.cpp não tem suporte para a sua placa. Use a Vulkan (embutida) em Versões.'],
  ['out of memory', 'Faltou memória na GPU. Diminua o contexto ou as camadas na GPU, ou quantize o cache KV (q8_0).'],
  ['failed to allocate', 'Faltou memória para carregar o modelo. Diminua o contexto ou as camadas na GPU, ou quantize o cache KV (q8_0).'],
  ['unknown model architecture', 'Esta versão do llama.cpp não conhece a arquitetura deste modelo. Baixe uma mais nova em Versões.'],
  ['failed to load model', 'O llama.cpp não conseguiu abrir o modelo (arquivo incompatível, incompleto ou corrompido). Veja o log.'],
  ["couldn't bind", 'A porta escolhida está ocupada por outro programa. Inicie de novo: o Openclod procura outra porta livre.'],
  ['address already in use', 'A porta escolhida está ocupada por outro programa. Inicie de novo: o Openclod procura outra porta livre.']
]

const SPEED = /(prompt eval|eval) time\s*=.*?([\d.]+) tokens per second/g
const OFFLOAD = /offloaded (\d+)\/(\d+) layers to GPU/
const DEVICE = /using device \S+ \((.+?)\)/
const FIT = /projected to use (\d+) MiB of device memory/
/** llama.cpp's log lines start with a timestamp and a one-letter level: "0.01.234.567 E ...". */
const LEVEL = /^\S+\s+([IWE])\s/

export function createLogStats(): ServerLogStats {
  return { speed: { prompt: 0, gen: 0 }, offload: '', device: '', deviceMiB: 0, hint: '', error: '' }
}

/** Updates `stats` with one log line. Returns the hint the line matched, if any. */
export function readLogLine(stats: ServerLogStats, line: string): string | undefined {
  for (const match of line.matchAll(SPEED)) {
    const value = Math.round(Number(match[2]) * 10) / 10
    if (match[1] === 'prompt eval') stats.speed.prompt = value
    else stats.speed.gen = value
  }
  const offload = OFFLOAD.exec(line)
  if (offload) stats.offload = `${offload[1]}/${offload[2]}`
  const device = DEVICE.exec(line)
  if (device && !stats.device) stats.device = device[1]
  const fit = FIT.exec(line)
  if (fit) stats.deviceMiB = Number(fit[1])
  const hint = LLAMA_HINTS.find(([needle]) => line.includes(needle))?.[1]
  if (hint) stats.hint = hint
  if (LEVEL.exec(line)?.[1] === 'E' || /^error:/i.test(line) || line.includes('failed to load model')) {
    stats.error = stats.hint || line.slice(-300)
  }
  return hint
}
