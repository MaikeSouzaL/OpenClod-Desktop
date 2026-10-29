import path from 'node:path'

/** What one llama-server run uses: the model, its vision projector and the values chosen on the options screen. */
export interface LlamaProfile {
  /** Absolute path of the .gguf model. */
  model: string
  /** Vision projector (mmproj) of the model, when it has one. */
  mmproj?: string
  /** Name the API reports for the model (`--alias`); the file name when unset. */
  alias?: string
  /** Context window in tokens (`--ctx-size`). */
  ctxSize?: number
  /** Requests served at once (`--parallel`); each one gets ctxSize / parallel tokens. */
  parallel?: number
  /**
   * Values from the options screen, by flag: `true` passes the flag alone, a non-empty string passes `flag value`,
   * anything else leaves llama.cpp's default (the flag is not sent).
   */
  values?: Record<string, string | boolean | null>
  /** Arguments the options screen has no field for, as typed. */
  extraArgs?: string[]
}

/** Openclod's defaults: the prompt base of the harness is ~9k tokens, so 32k is the floor for agent work. */
export const DEFAULT_CTX = 32_768
export const DEFAULT_PARALLEL = 1

/**
 * Flags Openclod sets itself. A value for one of them from the options screen or the extra arguments is dropped: the
 * port is the one Openclod connects to, the host must stay 127.0.0.1 (never the network), the key travels in the
 * environment, and the model, projector, context and slots come from the profile.
 */
export const MANAGED_FLAGS = new Set([
  '-m', '--model', '-mm', '--mmproj', '-a', '--alias', '--host', '--port', '--api-key', '--api-key-file',
  '--log-colors', '-c', '--ctx-size', '-np', '--parallel'
])

/** The model name the API reports: the alias, or the file name without `.gguf`. */
export function modelAlias(profile: { model?: string; alias?: string }): string {
  const alias = profile.alias?.trim()
  if (alias) return alias
  return (profile.model ? path.basename(profile.model).replace(/\.gguf$/i, '') : '') || 'local'
}

const flagOf = (token: string): string => token.split('=')[0]

/** Extra arguments without the managed flags (and the value that follows a managed flag). */
export function cleanExtraArgs(extra: string[] | undefined, blocked: Set<string> = MANAGED_FLAGS): string[] {
  const out: string[] = []
  const list = extra ?? []
  for (let index = 0; index < list.length; index++) {
    const token = list[index].trim()
    if (!token) continue
    if (MANAGED_FLAGS.has(flagOf(token)) || blocked.has(flagOf(token))) {
      // `--port 9000` drops the value too; `--port=9000` is one token.
      if (!token.includes('=') && index + 1 < list.length && !list[index + 1].startsWith('-')) index++
      continue
    }
    out.push(token)
  }
  return out
}

/**
 * The llama-server command line for a profile (the executable is not included). `optionArgs` are the options screen's
 * values already checked against this build's help (options.ts); without them the values pass as they are. `blocked` is
 * every spelling of the options Openclod controls, from the same help.
 */
export function serverArgs(profile: LlamaProfile, options: { port: number; optionArgs?: string[]; blocked?: Set<string> }): string[] {
  const blocked = options.blocked ?? MANAGED_FLAGS
  const args = ['--model', profile.model]
  if (profile.mmproj) args.push('--mmproj', profile.mmproj)
  args.push(
    '--alias', modelAlias(profile),
    '--host', '127.0.0.1',
    '--port', String(options.port),
    '--ctx-size', String(positiveOr(profile.ctxSize, DEFAULT_CTX)),
    '--parallel', String(positiveOr(profile.parallel, DEFAULT_PARALLEL)),
    '--log-colors', 'off',
    // Level 3 (the default) hides the device, the memory fit and the layers put on the GPU; the options screen can lower it.
    '--log-verbosity', '4'
  )
  if (options.optionArgs) {
    args.push(...cleanExtraArgs(options.optionArgs, blocked))
  } else {
    for (const [flag, value] of Object.entries(profile.values ?? {})) {
      if (MANAGED_FLAGS.has(flag) || blocked.has(flag) || !flag.startsWith('-')) continue
      if (value === true) args.push(flag)
      else if (typeof value === 'string' && value.trim() !== '') args.push(flag, value.trim())
    }
  }
  args.push(...cleanExtraArgs(profile.extraArgs, blocked))
  return args
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

/**
 * The server's environment: the user's, minus every `LLAMA_ARG_*` variable already set on the system (each one is a
 * hidden command-line flag — `LLAMA_ARG_HOST=0.0.0.0` would open the server to the network), plus the API key and the
 * Hugging Face token, which never go on the command line (anyone can read a process's command line).
 */
export function serverEnv(base: Record<string, string | undefined>, secrets: { apiKey: string; hfToken?: string }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper.startsWith('LLAMA_ARG_') || upper === 'LLAMA_API_KEY' || upper === 'HF_TOKEN') continue
    env[key] = value
  }
  env.LLAMA_API_KEY = secrets.apiKey
  if (secrets.hfToken) env.HF_TOKEN = secrets.hfToken
  return env
}
