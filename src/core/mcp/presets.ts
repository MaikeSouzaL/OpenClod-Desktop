import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerSettings } from '../../shared/types.js'

/**
 * MCP server presets. A preset is a ready-made `McpServerSettings` the UI can
 * offer ("Adicionar REA"); detection only reads the filesystem and never
 * writes to (or runs anything from) the installation it finds.
 */

export interface ReaLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  /** REA package directory; REA's own tooling launches it from here. */
  cwd?: string
}

export interface DetectReaOptions {
  /** Environment to read REA_HOME, APPDATA, JAVA_HOME... from (default: process.env). */
  env?: NodeJS.ProcessEnv
  /** User home used for the default locations (default: os.homedir()). */
  homeDir?: string
}

/* ------------------------------------------------------------------ */
/* Filesystem helpers                                                   */
/* ------------------------------------------------------------------ */

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** JSON written by PowerShell often carries a BOM, which JSON.parse rejects. */
function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key && typeof entry === 'string') out[key] = entry
  }
  return out
}

/* ------------------------------------------------------------------ */
/* REA detection                                                        */
/* ------------------------------------------------------------------ */

interface ReaLocation {
  /** Directory holding scripts/rea.mjs and the compiled dist/. */
  packageDir: string
  /** Directory holding rea-local.json / configuracao-mcp.json / ferramentas, when present. */
  workspaceDir?: string
}

/**
 * `dir` may be the REA package itself (has scripts/rea.mjs) or the folder that
 * contains it as `rea/` next to rea-local.json (the layout of the user's
 * Desktop\REA workspace). The compiled MCP runtime must exist, otherwise REA
 * exits immediately with "compiled runtime is missing".
 */
function locateRea(dir: string): ReaLocation | null {
  for (const packageDir of [dir, path.join(dir, 'rea')]) {
    if (!isFile(path.join(packageDir, 'scripts', 'rea.mjs'))) continue
    if (!isFile(path.join(packageDir, 'dist', 'mcp', 'main.js'))) continue
    const workspaceDir = [dir, path.dirname(packageDir)].find(
      (candidate) =>
        isFile(path.join(candidate, 'rea-local.json')) ||
        isFile(path.join(candidate, 'configuracao-mcp.json')) ||
        isDir(path.join(candidate, 'ferramentas'))
    )
    return { packageDir, workspaceDir }
  }
  return null
}

function candidateDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dirs: string[] = []
  if (env.REA_HOME?.trim()) dirs.push(path.resolve(env.REA_HOME.trim()))
  const homes = [home, env.USERPROFILE].filter((entry): entry is string => !!entry)
  for (const base of homes) {
    dirs.push(
      path.join(base, 'Desktop', 'REA', 'rea'),
      path.join(base, 'Desktop', 'REA'),
      path.join(base, 'Desktop', 'rea'),
      path.join(base, 'OneDrive', 'Desktop', 'REA', 'rea'),
      path.join(base, 'OneDrive', 'Desktop', 'REA'),
      path.join(base, 'Documents', 'REA'),
      path.join(base, 'REA', 'rea'),
      path.join(base, 'REA'),
      path.join(base, 'rea'),
      path.join(base, '.rea')
    )
  }
  // `npm i -g rea-agents` puts the package under the global node_modules.
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm', 'node_modules', 'rea-agents'))
  return [...new Set(dirs)]
}

/**
 * The launch command must be a real Node: inside Electron `process.execPath`
 * is the app binary, which would start a second Forja instead of the script.
 */
function findNode(env: NodeJS.ProcessEnv, hint?: string): string | null {
  if (hint && isFile(hint)) return hint
  if (!process.versions.electron && /^node(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  if (process.platform === 'win32') {
    const fallback = path.join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
    if (isFile(fallback)) return fallback
  }
  return null
}

function findGhidra(workspaceDir: string | undefined): string | null {
  if (!workspaceDir) return null
  const tools = path.join(workspaceDir, 'ferramentas')
  let entries: string[] = []
  try {
    entries = fs.readdirSync(tools)
  } catch {
    return null
  }
  const found = entries
    .filter((entry) => /^ghidra_/i.test(entry) && isDir(path.join(tools, entry)))
    .sort()
    .pop()
  return found ? path.join(tools, found) : null
}

function reaEnv(location: ReaLocation, env: NodeJS.ProcessEnv): Record<string, string> {
  const workspace = location.workspaceDir
  const local = workspace ? readJson(path.join(workspace, 'rea-local.json')) : null
  const mcp = workspace ? readJson(path.join(workspace, 'configuracao-mcp.json')) : null
  const mcpRea = ((mcp?.mcpServers as Record<string, { env?: unknown }> | undefined) ?? {}).rea

  // Same precedence as REA's own launcher: the local file wins over the shell.
  const out = stringRecord(local?.env ?? mcpRea?.env)

  const ghidra = out.GHIDRA_INSTALL_DIR || env.GHIDRA_INSTALL_DIR || findGhidra(workspace)
  if (ghidra) out.GHIDRA_INSTALL_DIR = ghidra
  const provider = out.REA_ANALYSIS_PROVIDER || env.REA_ANALYSIS_PROVIDER || (ghidra ? 'ghidra' : '')
  if (provider) out.REA_ANALYSIS_PROVIDER = provider

  if (!out.JAVA_HOME) {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const java = [env.JAVA_HOME, path.join(programFiles, 'Android', 'Android Studio', 'jbr')].find(
      (candidate): candidate is string => !!candidate && isDir(candidate)
    )
    if (java) out.JAVA_HOME = java
  }

  // REA's launcher points TEMP/TMP at a folder inside the workspace; honour
  // that only while the folder exists (detection must not create anything).
  for (const key of ['TEMP', 'TMP']) {
    if (out[key] && !isDir(out[key])) delete out[key]
  }
  return out
}

/**
 * Finds an installed REA (https://github.com/morluto/rea) and returns the
 * command that starts its stdio MCP server (`node scripts/rea.mjs mcp`) with
 * the env REA's own `rea-local.json` / `configuracao-mcp.json` prescribe.
 * Search order: `REA_HOME`, then the usual folders under the user's home
 * (Desktop\REA\rea, Desktop\REA, Documents\REA, ...), then the global npm
 * package. Returns null when nothing launchable is found. Read-only.
 */
export function detectRea(options: DetectReaOptions = {}): ReaLaunch | null {
  const env = options.env ?? process.env
  const home = options.homeDir ?? os.homedir()
  for (const dir of candidateDirs(env, home)) {
    const location = locateRea(dir)
    if (!location) continue
    const workspace = location.workspaceDir
    const configured = workspace
      ? (((readJson(path.join(workspace, 'configuracao-mcp.json'))?.mcpServers as Record<string, { command?: unknown }> | undefined) ?? {}).rea?.command)
      : undefined
    const command = findNode(env, typeof configured === 'string' ? configured : undefined)
    if (!command) continue
    return {
      command,
      args: [path.join(location.packageDir, 'scripts', 'rea.mjs'), 'mcp'],
      env: reaEnv(location, env),
      cwd: location.packageDir
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* REA preset                                                           */
/* ------------------------------------------------------------------ */

/**
 * REA tools that run or attach to the analysis target, or change an attached
 * device. The first five families are the product decision; the rest come from
 * REA's own effect audit (`executesForeignCode` / `mutatesDevice`), which the
 * glob families above do not cover.
 */
export const REA_APPROVAL_TOOLS: string[] = [
  'capture_*',
  'instrument_*',
  'install_*',
  'push_*',
  'start_*',
  'uninstall_*',
  'stop_*',
  'load_frida_script',
  'resume_frida_session',
  'observe_native_calls',
  'observe_web_execution'
]

/** Floor for tool calls: Ghidra's first import of a binary takes minutes. */
const REA_MIN_CALL_TIMEOUT_MS = 300_000
/** REA exposes ~185 tools; listing them takes longer than the 20 s default. */
const REA_START_TIMEOUT_MS = 60_000

export interface ReaPresetOptions {
  /** Launch info from detectRea(); detected when omitted. */
  launch?: ReaLaunch | null
  /** Narrow the exposed tools (REA ships ~185; every one costs prompt tokens). */
  includeTools?: string[]
  excludeTools?: string[]
}

export interface McpPresetInfo {
  id: string
  label: string
  description: string
  /** Entry to save into `settings.mcpServers`; null when it cannot be built here. */
  server: McpServerSettings | null
  /** Why `server` is null, in pt-BR. */
  unavailableReason?: string
}

/** Presets the settings screen can offer ("Adicionar preset"). */
export function listMcpPresets(options: DetectReaOptions = {}): McpPresetInfo[] {
  const rea = reaMcpPreset({ launch: detectRea(options) })
  return [
    {
      id: 'rea',
      label: 'REA (engenharia reversa)',
      description:
        'Servidor MCP do REA com Ghidra/Frida/ADB. Ferramentas que executam ou alteram o alvo (capture_*, instrument_*, install_*, push_*, start_*...) sempre pedem aprovação; chamadas aguardam até 5 min.',
      server: rea,
      unavailableReason: rea
        ? undefined
        : 'REA não encontrado. Defina REA_HOME ou instale em Desktop\\REA\\rea (com a pasta dist compilada).'
    }
  ]
}

/**
 * Ready-to-save REA entry for `settings.mcpServers`, or null when REA is not
 * installed. Analysis tools are exposed as-is; the ones in REA_APPROVAL_TOOLS
 * always ask. The call timeout is 300 s, raised to REA_GHIDRA_STARTUP_TIMEOUT_MS
 * + 30 s when the install configures a longer Ghidra startup, so a first
 * `open_binary` cannot time out on Forja's side before Ghidra's.
 */
export function reaMcpPreset(options: ReaPresetOptions = {}): McpServerSettings | null {
  const launch = options.launch === undefined ? detectRea() : options.launch
  if (!launch) return null
  const env: Record<string, string> = { ...launch.env }
  // REA's documented switch to shrink the tools/list payload (about 40% smaller).
  if (!env.REA_MCP_INPUT_SCHEMA_PROFILE) env.REA_MCP_INPUT_SCHEMA_PROFILE = 'compact'
  const startup = Number(env.REA_GHIDRA_STARTUP_TIMEOUT_MS)
  const timeoutMs = Math.max(REA_MIN_CALL_TIMEOUT_MS, Number.isFinite(startup) && startup > 0 ? startup + 30_000 : 0)
  const preset: McpServerSettings = {
    name: 'rea',
    command: launch.command,
    args: launch.args,
    env,
    enabled: true,
    timeoutMs,
    startTimeoutMs: REA_START_TIMEOUT_MS,
    approvalTools: [...REA_APPROVAL_TOOLS]
  }
  if (launch.cwd) preset.cwd = launch.cwd
  if (options.includeTools?.length) preset.includeTools = [...options.includeTools]
  if (options.excludeTools?.length) preset.excludeTools = [...options.excludeTools]
  return preset
}
