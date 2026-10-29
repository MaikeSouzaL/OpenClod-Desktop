import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resourcePath } from './resources.js'

/**
 * The document runtime: the embedded Python (resources/runtime/python) carries python-docx, openpyxl, python-pptx,
 * XlsxWriter, Pillow and lxml (scripts/embed-office.mjs), so Cowork can create .docx / .xlsx / .pptx on a computer
 * that has no Python, or whose Python lacks these libraries. The agent reaches it through commands that
 * `run_command` puts on PATH (resources/office/bin):
 *
 *   openclod-python   the embedded interpreter
 *   openclod-office   check / inspect / pdf / recalc (resources/office/openclod_office_cli.py)
 *
 * `python` and `python3` are only redirected when the computer has no working Python at all (resources/office/bin-fallback):
 * a developer's `python` must keep meaning their own Python.
 */

export interface OfficeRuntime {
  python: string
  binDir: string
  fallbackDir: string
  engine: string
  sitePackages: string
}

/** distribution name -> top-level module; the three libraries below are the ones the skills rely on. */
export const OFFICE_DISTS: Array<[string, string]> = [
  ['python-docx', 'docx'],
  ['openpyxl', 'openpyxl'],
  ['python-pptx', 'pptx'],
  ['XlsxWriter', 'xlsxwriter'],
  ['Pillow', 'PIL'],
  ['lxml', 'lxml']
]
const REQUIRED_MODULES = ['docx', 'openpyxl', 'pptx']

/** The embedded document runtime, or null when it is not there (not Windows, resources not built, libraries not installed). */
export function officeRuntime(): OfficeRuntime | null {
  if (process.platform !== 'win32') return null
  const python = resourcePath('runtime', 'python', 'python.exe')
  const binDir = resourcePath('office', 'bin')
  const fallbackDir = resourcePath('office', 'bin-fallback')
  const engine = resourcePath('office', 'openclod_office_cli.py')
  const sitePackages = resourcePath('runtime', 'python', 'Lib', 'site-packages')
  if (!python || !binDir || !fallbackDir || !engine || !sitePackages) return null
  if (!REQUIRED_MODULES.every((module) => fs.existsSync(path.join(sitePackages, module)))) return null
  return { python, binDir, fallbackDir, engine, sitePackages }
}

/** Versions of the embedded libraries, read from the dist-info folders (no process is started). */
export function officeLibraries(runtime: OfficeRuntime | null = officeRuntime()): Record<string, string> {
  const found: Record<string, string> = {}
  if (!runtime) return found
  let entries: string[] = []
  try {
    entries = fs.readdirSync(runtime.sitePackages)
  } catch {
    return found
  }
  for (const [dist] of OFFICE_DISTS) {
    const prefix = `${dist.replace(/-/g, '_').toLowerCase()}-`
    const info = entries.find((name) => name.toLowerCase().startsWith(prefix) && name.endsWith('.dist-info'))
    const version = info ? /^[^-]+-(.+)\.dist-info$/.exec(info)?.[1] : undefined
    if (version) found[dist] = version
  }
  return found
}

// ------------------------------------------------------------------------------------------ system Python

export interface SystemPython {
  /** `python` on PATH starts and prints a version (the Microsoft Store stub does not). */
  found: boolean
  version?: string
  /** python-docx, openpyxl and python-pptx can all be imported by it. */
  hasOfficeLibs: boolean
}

const PROBE_COMMAND =
  `python -c "import sys,importlib.util as u;print(sys.version.split()[0],*[int(u.find_spec(m) is not None) for m in ('docx','openpyxl','pptx')])"`
const PROBE_TTL_MS = 10 * 60_000

export function parseSystemProbe(stdout: string): SystemPython {
  const match = /^(\d+\.\d+\.\d+\S*) ([01]) ([01]) ([01])\s*$/m.exec(stdout)
  if (!match) return { found: false, hasOfficeLibs: false }
  return { found: true, version: match[1], hasOfficeLibs: match[2] === '1' && match[3] === '1' && match[4] === '1' }
}

/** Value of PATH in `env` whatever the spelling of the key (Windows keeps `Path`). */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}

let probeCache: { key: string; at: number; value: SystemPython } | null = null
let probePending: { key: string; promise: Promise<SystemPython> } | null = null

/** Test hook: forget what was learned about the machine's Python. */
export function resetOfficeRuntimeCache(): void {
  probeCache = null
  probePending = null
}

function runProbe(env: NodeJS.ProcessEnv): Promise<SystemPython> {
  return new Promise((resolve) => {
    // A neutral working folder: cmd.exe looks for `python` in the current folder first, and that must never be the user's folder.
    exec(PROBE_COMMAND, { env, cwd: os.tmpdir(), timeout: 20_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? { found: false, hasOfficeLibs: false } : parseSystemProbe(String(stdout)))
    })
  })
}

/** What `python` means on this machine for the given environment; learned once per PATH and kept for ten minutes. */
export function probeSystemPython(env: NodeJS.ProcessEnv): Promise<SystemPython> {
  const key = env[pathKey(env)] ?? ''
  if (probeCache && probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL_MS) return Promise.resolve(probeCache.value)
  if (probePending && probePending.key === key) return probePending.promise
  const promise = runProbe(env).then((value) => {
    probeCache = { key, at: Date.now(), value }
    if (probePending?.promise === promise) probePending = null
    return value
  })
  probePending = { key, promise }
  return promise
}

/** The last probe for this PATH, if any (the environment of a command is built synchronously from it). */
export function knownSystemPython(env: NodeJS.ProcessEnv): SystemPython | null {
  const key = env[pathKey(env)] ?? ''
  return probeCache && probeCache.key === key && Date.now() - probeCache.at < PROBE_TTL_MS ? probeCache.value : null
}

/** Learns about the machine's Python before a command starts. Never throws; does nothing when there is no embedded runtime. */
export async function warmOfficeEnv(env: NodeJS.ProcessEnv): Promise<void> {
  if (!officeRuntime()) return
  await probeSystemPython(env).catch(() => undefined)
}

/**
 * Environment of a local command: `openclod-python` and `openclod-office` on PATH, `OPENCLOD_PYTHON`, and - only when the
 * computer has no working Python - `python` / `python3` pointing at the embedded one. `env` is returned untouched when the
 * runtime is not there.
 */
export function officeEnvPatch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = officeRuntime()
  if (!runtime) return env
  const system = knownSystemPython(env)
  const dirs = [runtime.binDir, ...(system && !system.found ? [runtime.fallbackDir] : [])]
  const key = pathKey(env)
  return { ...env, [key]: [...dirs, env[key] ?? ''].filter(Boolean).join(path.delimiter), OPENCLOD_PYTHON: runtime.python }
}

// ------------------------------------------------------------------------------------------ command inspection

const OFFICE_PACKAGES = new Set(['python-docx', 'docx', 'openpyxl', 'python-pptx', 'pptx', 'xlsxwriter', 'pillow', 'pil', 'lxml', 'et-xmlfile'])
const INSTALL_SEGMENT = /\b(?:pip3?(?:\.exe)?|uv|poetry|conda|mamba|pipx)\b[^\n]*?\b(?:install|add)\b(.*)$/i

/** Document libraries a shell command would install (`pip install python-docx openpyxl`); empty when it installs none of them. */
export function commandInstallsOfficeLibs(command: string): string[] {
  const hits = new Set<string>()
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const match = INSTALL_SEGMENT.exec(segment)
    if (!match) continue
    for (const token of match[1].split(/\s+/)) {
      if (!token || token.startsWith('-')) continue
      const name = token
        .replace(/^["']+|["']+$/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/(?:==|>=|<=|~=|!=|<|>|@).*$/, '')
        .toLowerCase()
        .replace(/_/g, '-')
      if (OFFICE_PACKAGES.has(name)) hits.add(name)
    }
  }
  return [...hits]
}

/** Message for a `pip install` of document libraries that the embedded runtime already has; null when it does not apply. */
export function officeInstallRefusal(command: string): string | null {
  const names = commandInstallsOfficeLibs(command)
  if (!names.length || !officeRuntime()) return null
  return (
    `Não instale ${names.join(', ')}: o Openclod já traz essas bibliotecas no Python embutido ` +
    '(python-docx, openpyxl, python-pptx, XlsxWriter, Pillow, lxml). Rode o script com `openclod-python script.py` ' +
    'e confira o resultado com `openclod-office inspect arquivo`. Instalar pacotes muda o computador do usuário e só se faz com a aprovação dele.'
  )
}

const MISSING_MODULE = /No module named ['"](docx|openpyxl|pptx|xlsxwriter|PIL|lxml|et_xmlfile)\b/i

/** A command failed because a document library is missing from the interpreter it ran under: say which one to use instead. */
export function missingOfficeModuleHint(output: string): string | null {
  const match = MISSING_MODULE.exec(output)
  if (!match || !officeRuntime()) return null
  return (
    `Dica: o módulo "${match[1]}" não existe no Python que rodou o comando, mas o Openclod traz as bibliotecas de documentos no Python embutido. ` +
    'Rode o mesmo script com `openclod-python script.py`. Não instale pacotes.'
  )
}
