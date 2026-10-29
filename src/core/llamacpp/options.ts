import { CURATED, GROUPS } from './options-curated.js'

/**
 * Every llama-server control, read from the help (`llama-server --help`) of the executable itself.
 *
 * The help is the source: each option it lists becomes a field, with the type taken from its format (no value = on/off;
 * `--x, --no-x` = default/on/off; `{a,b}`, `[on|off]`, "allowed values" or a "- name:" list = a choice; N = a number;
 * FNAME/PATH = a file or folder). CURATED adds a Portuguese name, tip and group to the known options; one a newer build
 * adds shows with the help's own text, in its section's group. An empty field = llama.cpp's default (the flag is not sent).
 */

export type OptionKind = 'bool' | 'tri' | 'choice' | 'multi' | 'number' | 'file' | 'dir' | 'pair' | 'text'

export interface ServerOption {
  /** First long, positive name: "--gpu-layers". */
  key: string
  /** Every spelling: ["-ngl", "--gpu-layers", "--n-gpu-layers"]. */
  flags: string[]
  /** The value placeholder of the help: "N", "TYPE", "[on|off|auto]". */
  value: string
  kind: OptionKind
  choices: string[]
  default: string
  env: string
  section: string
  /** The help's original text. */
  help: string
  deprecated: boolean
  /** The flag that turns it on, and the one that turns it off (tri). */
  on: string
  off: string
  min?: number
  max?: number
}

export interface OptionField extends ServerOption {
  group: string
  label: string
  tip: string
  curated: boolean
}

export interface OptionGroup {
  id: string
  name: string
  fields: OptionField[]
}

/** Options that are not configuration: they print something and exit. */
const META = new Set(['--help', '--version', '--cache-list', '--completion-bash', '--list-devices'])

/**
 * Options the screen never offers, in any spelling. Openclod sets the model, the projector, the name, the address, the
 * port, the key, the context and the slots itself; the rest would open the server beyond this computer (`--connect`
 * tunnels, another `--host`), let it run tools or serve local files (`--tools`, `--agent`, MCP, `--path`,
 * `--media-path`), download weights behind Openclod's back (`--hf-*`, URLs, the presets), or break the address Openclod
 * talks to (SSL, `--api-prefix`, the router mode). The key and the Hugging Face token never go on a command line.
 */
export const BLOCKED = new Set([
  '--model', '--mmproj', '--alias', '--host', '--port', '--api-key', '--api-key-file', '--log-colors', '--ctx-size', '--parallel',
  '--hf-repo', '--hf-file', '--hf-token', '--hf-repo-draft', '--hf-repo-v', '--hf-file-v', '--model-url', '--mmproj-url',
  '--docker-repo', '--path', '--api-prefix', '--media-path', '--ssl-key-file', '--ssl-cert-file', '--tools', '--tools-runtime',
  '--mcp-servers-config', '--mcp-servers-json', '--agent', '--ui-mcp-proxy', '--connect', '--connect-code', '--models-dir',
  '--models-preset', '--models-max', '--models-memory-margin', '--models-autoload', '--reuse-port'
])
/** Ready-made presets ("--fim-qwen-7b-default", "--gpt-oss-20b-spec"): they download weights from the internet. */
const PRESET = /^--[a-z0-9.-]+-(default|spec)$/

const GROUP_PREFIX: Array<[prefix: string, group: string]> = [
  ['--spec-', 'especulativa'], ['--yarn-', 'rope'], ['--rope-', 'rope'], ['--video-', 'multimodal'], ['--cors-', 'servidor'],
  ['--log-', 'registro'], ['--dry-', 'amostragem'], ['--mirostat', 'amostragem'], ['--xtc-', 'amostragem'], ['--cache-type', 'kv']
]
const SECTION_GROUP: Record<string, string> = { common: 'avancado', sampling: 'amostragem', speculative: 'especulativa', 'example-specific': 'servidor' }

const SECTION = /^-{3,}\s*(.+?)\s*params\s*-{3,}$/
const DEFAULT = /default:\s*'?([^()']*?)'?\s*\)/
const ENV = /\(env:\s*([A-Z0-9_]+)\)/
const ALLOWED = /allowed values:\s*([^\n(]+)/
const BULLET = /^\s*-\s*([a-z0-9+_.-]+):/gm
const PATH_WORDS = ['FNAME', 'FILE', 'PATH', 'DIR', 'JINJA_TEMPLATE_FILE']
const DIR_KEYS = new Set(['--slot-save-path', '--log-prompts-dir', '--video-ffmpeg-dir'])
const NUM_WORDS = new Set(['N', 'SEED', 'INDEX', 'P', 'L', 'SECONDS', 'SIMILARITY', 'MiB0,MiB1,MiB2,...'])
const NEGATIVE = /^--?no-/

/** "-ngl,  --gpu-layers, --n-gpu-layers N" → [["-ngl", "--gpu-layers", "--n-gpu-layers"], "N"]. */
function splitFlags(spec: string): [string[], string] {
  const parts = spec.trim().split(/,\s+(?=-)/).map((part) => part.trim()).filter(Boolean)
  const flags: string[] = []
  let value = ''
  parts.forEach((part, index) => {
    const space = part.indexOf(' ')
    flags.push(space < 0 ? part : part.slice(0, space))
    if (index === parts.length - 1 && space >= 0) value = part.slice(space + 1).trim()
  })
  return [flags, value]
}

function kindOf(key: string, flags: string[], value: string, desc: string, fallback: string): Pick<ServerOption, 'kind' | 'choices' | 'min' | 'max'> {
  if (!value) {
    const negative = flags.some((flag) => NEGATIVE.test(flag))
    const positive = flags.some((flag) => flag.startsWith('--') && !NEGATIVE.test(flag))
    return { kind: negative && positive ? 'tri' : 'bool', choices: [] }
  }
  let match = /^\[([a-z|]+)\]$/.exec(value) ?? /^\{([a-z0-9_,.-]+)\}$/.exec(value)
  if (match) return { kind: 'choice', choices: match[1].split(/[|,]/) }
  match = /^<(\d+)\|(\d+)>$/.exec(value)
  if (match) return { kind: 'choice', choices: [match[1], match[2]] }
  match = /^<(\d+)\.\.\.(\d+)>$/.exec(value)
  if (match) return { kind: 'number', choices: [], min: Number(match[1]), max: Number(match[2]) }
  const allowed = ALLOWED.exec(desc)
  if (allowed && value === 'TYPE') return { kind: 'choice', choices: allowed[1].split(',').map((item) => item.trim()).filter(Boolean) }
  if (key === '--reasoning-effort') return { kind: 'choice', choices: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
  if (['MODE', 'TYPE', 'FORMAT', 'LEVEL'].includes(value)) {
    const bullets = [...desc.matchAll(BULLET)].map((item) => item[1])
    if (bullets.length) {
      const choices = fallback && !bullets.includes(fallback) && /^[a-z0-9+_.-]+$/.test(fallback) ? [fallback, ...bullets] : bullets
      return { kind: 'choice', choices }
    }
  }
  if (/^[a-z0-9-]+(,[a-z0-9-]+){2,}$/.test(value)) return { kind: 'multi', choices: value.split(',') }
  if (NUM_WORDS.has(value) || /^N\d?$/.test(value)) return { kind: 'number', choices: [] }
  if (PATH_WORDS.some((word) => value.includes(word))) return { kind: DIR_KEYS.has(key) || value === 'DIR' ? 'dir' : 'file', choices: [] }
  if (DIR_KEYS.has(key)) return { kind: 'dir', choices: [] }
  if (value.includes(' ') && !value.includes('<')) return { kind: 'pair', choices: [] }
  return { kind: 'text', choices: [] }
}

/** The options of a llama-server help text, in its order. */
export function parseHelp(text: string): ServerOption[] {
  const entries: Array<{ spec: string; desc: string[]; section: string }> = []
  let section = 'common'
  let current: (typeof entries)[number] | null = null
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const header = SECTION.exec(line.trim())
    if (header) {
      section = header[1].trim()
      current = null
      continue
    }
    if (line.startsWith('-')) {
      // The help has two columns: the flags up to column 40, the description after it.
      const twoColumns = line.length > 40 && line.slice(38, 40) === '  ' && line[40] !== ' '
      current = { spec: twoColumns ? line.slice(0, 40) : line, desc: twoColumns ? [line.slice(40).trim()] : [], section }
      entries.push(current)
    } else if (current && line.startsWith(' '.repeat(20))) {
      current.desc.push(line.trim())
    }
  }
  const out: ServerOption[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const [flags, value] = splitFlags(entry.spec)
    const longs = flags.filter((flag) => flag.startsWith('--'))
    const positives = longs.filter((flag) => !NEGATIVE.test(flag))
    const key = (positives.length ? positives : longs.length ? longs : flags)[0]
    const help = entry.desc.join('\n').trim()
    const flat = help.split(/\s+/).join(' ')
    if (!key || seen.has(key) || META.has(key) || flat.includes('the argument has been removed')) continue
    seen.add(key)
    const fallback = DEFAULT.exec(flat)?.[1].trim().replace(/^['"]|['"]$/g, '') ?? ''
    const negatives = longs.filter((flag) => NEGATIVE.test(flag))
    out.push({
      key,
      flags,
      value,
      ...kindOf(key, flags, value, help, fallback),
      default: fallback,
      env: ENV.exec(flat)?.[1] ?? '',
      section: entry.section,
      help,
      deprecated: flat.includes('DEPRECATED'),
      on: positives[0] ?? key,
      off: negatives.includes(`--no-${key.slice(2)}`) ? `--no-${key.slice(2)}` : (negatives[0] ?? '')
    })
  }
  return out
}

export function isBlocked(key: string): boolean {
  return BLOCKED.has(key) || PRESET.test(key)
}

/** Every spelling of every blocked option this help lists ("-hf", "--hf-repo", "-hfr", "--no-agent"…). */
export function blockedFlags(options: ServerOption[]): Set<string> {
  const out = new Set<string>(BLOCKED)
  for (const option of options) if (isBlocked(option.key)) for (const flag of option.flags) out.add(flag)
  return out
}

function groupOf(key: string, section: string): string {
  const curated = CURATED[key]
  if (curated) return curated[0]
  for (const [prefix, group] of GROUP_PREFIX) if (key.startsWith(prefix)) return group
  return SECTION_GROUP[section] ?? 'avancado'
}

/** What the screen shows: the groups in order, each with its fields (the curated ones first, in the table's order). */
export function optionGroups(options: ServerOption[]): OptionGroup[] {
  const order = new Map(Object.keys(CURATED).map((key, index) => [key, index]))
  const byGroup = new Map<string, OptionField[]>(GROUPS.map(([id]) => [id, []]))
  for (const option of options) {
    if (isBlocked(option.key)) continue
    const curated = CURATED[option.key]
    const group = groupOf(option.key, option.section)
    const field: OptionField = { ...option, group, label: curated?.[1] ?? option.key, tip: curated?.[2] ?? '', curated: Boolean(curated) }
    ;(byGroup.get(group) ?? byGroup.get('avancado'))?.push(field)
  }
  const rank = (field: OptionField): number => order.get(field.key) ?? Number.MAX_SAFE_INTEGER
  return GROUPS.map(([id, name]) => ({ id, name, fields: (byGroup.get(id) ?? []).sort((a, b) => rank(a) - rank(b)) })).filter((group) => group.fields.length)
}

export class OptionError extends Error {}

const isNumber = (text: string): boolean => text.trim() !== '' && Number.isFinite(Number(text))

/**
 * The command line (without the executable) for the chosen values: `{key: value}`, empty/null = default. An option this
 * build does not have, a blocked one or a value in the wrong format throws OptionError (in Portuguese).
 */
export function optionArgs(values: Record<string, string | boolean | null | undefined>, options: ServerOption[]): string[] {
  const index = new Map(options.map((option) => [option.key, option]))
  const args: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined || raw === '' || raw === false) continue
    const option = index.get(key)
    if (!option) throw new OptionError(`A opção ${key} não existe nesta versão do llama.cpp.`)
    if (isBlocked(key)) throw new OptionError(`A opção ${key} é controlada pelo Openclod.`)
    if (option.kind === 'bool') {
      if (raw === true || raw === 'on' || raw === 'true' || raw === '1') args.push(option.on)
      continue
    }
    if (option.kind === 'tri') {
      if (raw === 'on' || raw === true) args.push(option.on)
      else if (raw === 'off') {
        if (!option.off) throw new OptionError(`A opção ${key} não tem forma de desligar.`)
        args.push(option.off)
      } else if (raw !== 'default') throw new OptionError(`Valor inválido para ${key}.`)
      continue
    }
    const text = String(raw).trim()
    if (!text) continue
    if (option.kind === 'choice' && !option.choices.includes(text)) throw new OptionError(`${key} aceita só: ${option.choices.join(', ')}.`)
    if (option.kind === 'multi') {
      const unknown = text.split(',').map((item) => item.trim()).filter((item) => !option.choices.includes(item))
      if (unknown.length) throw new OptionError(`${key} não conhece: ${unknown.join(', ')}.`)
    }
    if (option.kind === 'number') {
      const words = (key === '--gpu-layers' || key === '--spec-draft-ngl') && (text === 'auto' || text === 'all')
      // Some numbers are lists ("3,1", one per GPU).
      if (!words && !text.split(',').every(isNumber)) throw new OptionError(`${key} precisa de um número.`)
      if (!words && ((option.min !== undefined && Number(text) < option.min) || (option.max !== undefined && Number(text) > option.max))) {
        throw new OptionError(`${key} vai de ${option.min} a ${option.max}.`)
      }
    }
    if (option.kind === 'pair') {
      args.push(option.on, ...text.split(/\s+/))
      continue
    }
    args.push(option.on, text)
  }
  return args
}

/** Extra arguments typed by hand, split like a terminal does (quotes group words). They never go through a shell. */
export function splitExtra(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = ''
  let started = false
  for (const char of text.trim()) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || current) out.push(current)
      current = ''
      started = false
    } else {
      current += char
    }
  }
  if (quote) throw new OptionError('Argumentos extras com aspas abertas.')
  if (started || current) out.push(current)
  return out
}

/** For the screen: the command line with quotes where needed, as in the Windows Command Prompt. */
export function commandLine(exe: string, args: string[]): string {
  return [exe, ...args].map((arg) => (arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')
}
