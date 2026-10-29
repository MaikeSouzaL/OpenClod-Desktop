import { describe, expect, it } from 'vitest'
import {
  SERVER_FILES,
  assetNames,
  kindRuns,
  parseBuildId,
  parseNvidiaHeader,
  parseNvidiaQuery,
  recommendKind
} from '../src/core/llamacpp/builds'
import { DEFAULT_CTX, cleanExtraArgs, modelAlias, serverArgs, serverEnv } from '../src/core/llamacpp/args'
import { createLogStats, readLogLine } from '../src/core/llamacpp/log'
import { GgufError, bufferSource, kvCache, readGgufMetadata, summarize } from '../src/core/llamacpp/gguf'

/**
 * The pure half of the embedded llama.cpp: which build to suggest, the exact command line and environment of the server
 * (the safety rules live here: 127.0.0.1 only, the key never on the command line), what the log means, and the GGUF
 * header reader the model screens and the "fits on this GPU" math use.
 */

describe('builds', () => {
  it('reads driver and CUDA ceiling from the nvidia-smi header', () => {
    const header = '| NVIDIA-SMI 576.02    Driver Version: 576.02    CUDA Version: 12.9     |'
    expect(parseNvidiaHeader(header)).toEqual({ driver: '576.02', cudaMax: [12, 9] })
    // What driver 610.88 prints (this machine): the same numbers under new names.
    const newer = '| NVIDIA-SMI 610.88                 KMD Version: 610.88        CUDA UMD Version: 13.3     |'
    expect(parseNvidiaHeader(newer)).toEqual({ driver: '610.88', cudaMax: [13, 3] })
    expect(parseNvidiaHeader('no nvidia here')).toEqual({})
  })

  it('reads one GPU per csv line and skips junk', () => {
    expect(parseNvidiaQuery('NVIDIA GeForce RTX 2060, 6144, 5310\n\nbroken line\n')).toEqual([{ name: 'NVIDIA GeForce RTX 2060', vramMiB: 6144, freeMiB: 5310 }])
  })

  it('suggests the newest CUDA the driver runs, and Vulkan otherwise', () => {
    // The real case on this machine: driver 610.88 tops out at CUDA 13.3, so CUDA 13.4 would fail with "PTX ... unsupported toolchain".
    expect(recommendKind({ nvidia: true, cudaMax: [13, 3] })).toBe('cuda-12.4')
    expect(recommendKind({ nvidia: true, cudaMax: [13, 4] })).toBe('cuda-13.4')
    expect(recommendKind({ nvidia: true, cudaMax: [14, 0] })).toBe('cuda-13.4')
    expect(recommendKind({ nvidia: true, cudaMax: [11, 8] })).toBe('vulkan')
    expect(recommendKind({ nvidia: false })).toBe('vulkan')
    expect(kindRuns('cuda-13.4', [13, 3])).toBe(false)
    expect(kindRuns('vulkan', undefined)).toBe(true)
  })

  it('names builds and their release assets', () => {
    expect(parseBuildId('b11972-cuda-12.4')).toEqual({ tag: 'b11972', kind: 'cuda-12.4' })
    expect(parseBuildId('not-a-build')).toBeNull()
    expect(assetNames('b11972', 'cuda-12.4')).toEqual(['llama-b11972-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'])
  })

  it('keeps only what llama-server loads from a release', () => {
    for (const name of ['llama-server.exe', 'llama-server-impl.dll', 'ggml-vulkan.dll', 'ggml-cpu-haswell.dll', 'mtmd.dll', 'libomp.dll', 'cudart64_12.dll', 'cublasLt64_12.dll', 'LICENSE-LLVM-OpenMP']) {
      expect(SERVER_FILES.test(name), name).toBe(true)
    }
    for (const name of ['llama-cli.exe', 'llama-bench.exe', 'llama-quantize.exe', 'ggml-rpc-server.exe', 'llama-connect.exe']) {
      expect(SERVER_FILES.test(name), name).toBe(false)
    }
  })
})

describe('server command line and environment', () => {
  const profile = { model: 'C:\\models\\Qwen3.5-4B-Q4_K_M.gguf' }

  it('binds 127.0.0.1 only, on the chosen port, with the default context', () => {
    const args = serverArgs(profile, { port: 41234 })
    expect(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1'])
    expect(args.slice(args.indexOf('--port'), args.indexOf('--port') + 2)).toEqual(['--port', '41234'])
    expect(args.slice(args.indexOf('--ctx-size'), args.indexOf('--ctx-size') + 2)).toEqual(['--ctx-size', String(DEFAULT_CTX)])
    expect(args).toContain('--log-colors')
  })

  it('never lets the options screen or extra arguments override host, port, key or model', () => {
    const args = serverArgs(
      {
        ...profile,
        values: { '--host': '0.0.0.0', '--api-key': 'leak', '--flash-attn': 'on', '--no-mmap': true, '--threads': '', '--top-k': null },
        extraArgs: ['--port', '80', '--host=0.0.0.0', '-c', '999', '--temp', '0.2']
      },
      { port: 41234 }
    )
    expect(args.filter((token) => token === '--host')).toHaveLength(1)
    expect(args).not.toContain('0.0.0.0')
    expect(args).not.toContain('--host=0.0.0.0')
    expect(args).not.toContain('leak')
    expect(args).not.toContain('80')
    expect(args).not.toContain('999')
    expect(args).toEqual(expect.arrayContaining(['--flash-attn', 'on', '--no-mmap', '--temp', '0.2']))
    expect(args).not.toContain('--threads') // empty value = llama.cpp default
  })

  it('drops the value that follows a managed flag in the extra arguments', () => {
    expect(cleanExtraArgs(['--port', '80', '--temp', '0.7', '--alias', 'x', '--verbose'])).toEqual(['--temp', '0.7', '--verbose'])
  })

  it('names the model after the file unless an alias is set', () => {
    expect(modelAlias(profile)).toBe('Qwen3.5-4B-Q4_K_M')
    expect(modelAlias({ ...profile, alias: '  meu-modelo ' })).toBe('meu-modelo')
  })

  it('passes the key and the HF token in the environment and drops every inherited LLAMA_ARG_*', () => {
    const env = serverEnv(
      { PATH: 'C:\\Windows', llama_arg_host: '0.0.0.0', LLAMA_ARG_PORT: '1', LLAMA_API_KEY: 'old', HF_TOKEN: 'old', HOME: 'h' },
      { apiKey: 'k-123', hfToken: 'hf-9' }
    )
    expect(env).toEqual({ PATH: 'C:\\Windows', HOME: 'h', LLAMA_API_KEY: 'k-123', HF_TOKEN: 'hf-9' })
    expect(serverArgs(profile, { port: 1 })).not.toContain('k-123')
  })
})

describe('server log', () => {
  it('reads speed, the device and GPU offload (lines as b11972 prints them at --log-verbosity 4)', () => {
    const stats = createLogStats()
    readLogLine(stats, '0.00.822.122 I common_params_fit_impl: projected to use 2927 MiB of device memory vs. 5395 MiB of free device memory')
    readLogLine(stats, '0.00.915.962 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 2060) (0000:09:00.0) - 5395 MiB free')
    readLogLine(stats, '0.01.777.863 I load_tensors: offloaded 33/33 layers to GPU')
    readLogLine(stats, 'prompt eval time =     120.50 ms /   200 tokens (    0.60 ms per token,  1659.75 tokens per second)')
    readLogLine(stats, '       eval time =    1500.00 ms /   100 tokens (   15.00 ms per token,    66.67 tokens per second)')
    expect(stats).toMatchObject({ offload: '33/33', device: 'NVIDIA GeForce RTX 2060', deviceMiB: 2927, speed: { prompt: 1659.8, gen: 66.7 }, error: '' })
  })

  it('turns a known failure into what to do, in Portuguese', () => {
    const stats = createLogStats()
    readLogLine(stats, '0.00.512.003 E ggml_cuda_compute_forward: PTX was compiled with an unsupported toolchain')
    expect(stats.error).toMatch(/driver da NVIDIA é mais antigo/)
    const other = createLogStats()
    readLogLine(other, 'error: something nobody has seen before')
    expect(other.error).toBe('error: something nobody has seen before')
  })
})

/* ------------------------------------------------------------- a GGUF written by hand ------------------------------------------------------------- */

type Value = { u32: number } | { u64: number } | { str: string } | { u32s: number[] } | { strs: string[] }

const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value)
  return out
}
const u64 = (value: number): Buffer => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(BigInt(value))
  return out
}
const str = (value: string): Buffer => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value, 'utf8')])

function gguf(pairs: Array<[string, Value]>): Buffer {
  const parts = [Buffer.from('GGUF'), u32(3), u64(0), u64(pairs.length)]
  for (const [key, value] of pairs) {
    parts.push(str(key))
    if ('u32' in value) parts.push(u32(4), u32(value.u32))
    else if ('u64' in value) parts.push(u32(10), u64(value.u64))
    else if ('str' in value) parts.push(u32(8), str(value.str))
    else if ('u32s' in value) parts.push(u32(9), u32(4), u64(value.u32s.length), ...value.u32s.map(u32))
    else parts.push(u32(9), u32(8), u64(value.strs.length), ...value.strs.map(str))
  }
  return Buffer.concat(parts)
}

describe('GGUF header', () => {
  // A vocabulary big enough to cross the reader's 1 MiB block, with the chat template AFTER it, as in real files.
  const vocab = Array.from({ length: 60_000 }, (_, index) => `token-${index}-${'x'.repeat(12)}`)
  const file = gguf([
    ['general.architecture', { str: 'llama' }],
    ['general.name', { str: 'Llama 3.1 8B Instruct' }],
    ['general.size_label', { str: '8B' }],
    ['general.file_type', { u32: 15 }],
    ['llama.block_count', { u32: 32 }],
    ['llama.context_length', { u32: 131_072 }],
    ['llama.embedding_length', { u32: 4096 }],
    ['llama.attention.head_count', { u32: 32 }],
    ['llama.attention.head_count_kv', { u32: 8 }],
    ['tokenizer.ggml.tokens', { strs: vocab }],
    ['tokenizer.ggml.token_type', { u32s: vocab.map(() => 1) }],
    ['tokenizer.chat_template', { str: '{% if tools %}...{% endif %}{% if enable_thinking %}<think>{% endif %}' }]
  ])

  it('keeps the keys the app uses, skips the vocabulary, and still finds the template behind it', () => {
    expect(file.length).toBeGreaterThan(1 << 20)
    const meta = readGgufMetadata(bufferSource(file))
    expect(meta['general.architecture']).toBe('llama')
    expect(meta['llama.block_count']).toBe(32)
    expect(meta['tokenizer.ggml.tokens']).toBeUndefined()
    expect(String(meta['tokenizer.chat_template'])).toContain('enable_thinking')
  })

  it('summarizes quantization, context and what the template supports', () => {
    const summary = summarize(readGgufMetadata(bufferSource(file)))
    expect(summary).toMatchObject({ arch: 'llama', name: 'Llama 3.1 8B Instruct', quant: 'Q4_K_M', context: 131_072, layers: 32, tools: true, thinking: true, mmproj: false })
  })

  it('computes the KV cache exactly as the Colab catalog does (Llama 3.1 8B = 128 KiB per token)', () => {
    expect(kvCache(readGgufMetadata(bufferSource(file)))).toMatchObject({ kibPerToken: 128, fixedMiB: 0, maxContext: 131_072, arch: 'llama', moe: false })
  })

  it('recognizes a vision projector', () => {
    expect(summarize(readGgufMetadata(bufferSource(gguf([['general.architecture', { str: 'clip' }]])))).mmproj).toBe(true)
  })

  it('refuses what is not a GGUF and a header cut short', () => {
    expect(() => readGgufMetadata(bufferSource(Buffer.from('definitely not a gguf file')))).toThrow(GgufError)
    expect(() => readGgufMetadata(bufferSource(file.subarray(0, 200)))).toThrow(/cortado/)
  })
})
