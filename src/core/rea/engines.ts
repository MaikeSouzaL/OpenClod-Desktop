import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectRea } from '../mcp/presets.js'

/**
 * Where each external engine REA drives comes from. In order: the copy bundled by scripts/embed-rea.mjs
 * (resources/rea/engines, described in openclod-rea.json), then an install the user already has (the Desktop\REA
 * workspace, Android Studio's SDK, the system browser). Detection only reads the filesystem.
 */

export interface ReaEngineInfo {
  id: string
  label: string
  /** REA variable that points at it. */
  envVar: string
  /** What it enables, in pt-BR. */
  enables: string
  /** The variable holds a URL (a server the user runs), not a path on disk. */
  url?: boolean
  /** REA 6.8.0 refuses this engine on a Windows host (it reports unsupported_host whatever the binary). */
  linuxOnly?: boolean
}

export const REA_ENGINES: ReaEngineInfo[] = [
  { id: 'ghidra', label: 'Ghidra', envVar: 'GHIDRA_INSTALL_DIR', enables: 'descompilação e análise profunda de binários nativos' },
  { id: 'jdk', label: 'JDK (Java)', envVar: 'JAVA_HOME', enables: 'Ghidra, JADX e Apktool' },
  { id: 'jadx', label: 'JADX headless MCP', envVar: 'REA_JADX_MCP_JAR', enables: 'classes e métodos de APK/DEX' },
  { id: 'apktool', label: 'Apktool', envVar: 'REA_APKTOOL_COMMAND', enables: 'recursos e manifesto decodificados de APK' },
  { id: 'wabt', label: 'WABT', envVar: 'REA_WABT_BIN_DIRECTORY', enables: 'validação e WAT de WebAssembly' },
  { id: 'rizin', label: 'rizin', envVar: 'REA_RIZIN_COMMAND', enables: 'comandos rizin avulsos' },
  { id: 'adb', label: 'ADB (Android)', envVar: 'REA_ADB_PATH', enables: 'aparelho Android conectado' },
  { id: 'browser', label: 'Navegador Chromium', envVar: 'REA_BROWSER_EXECUTABLE', enables: 'resolução de módulos web no navegador' },
  { id: 'tshark', label: 'tshark (Wireshark)', envVar: 'REA_TSHARK_COMMAND', enables: 'resumo de capturas pcap' },
  { id: 'capinfos', label: 'capinfos (Wireshark)', envVar: 'REA_CAPINFOS_COMMAND', enables: 'resumo de capturas pcap' },
  { id: 'objdump', label: 'GNU objdump', envVar: 'REA_OBJDUMP_COMMAND', enables: 'desmontagem com objdump' },
  { id: 'ida', label: 'IDA Pro (licença do usuário)', envVar: 'REA_IDA_MCP_CONFIG', enables: 'IDA como provedor nativo' },
  { id: 'jeb', label: 'JEB (licença do usuário)', envVar: 'REA_JEB_MCP_URL', enables: 'JEB como provedor Android', url: true },
  { id: 'kuna', label: 'Kuna', envVar: 'REA_KUNA_COMMAND', enables: 'segundo descompilador nativo', linuxOnly: true },
  { id: 'nativeaot', label: 'Ghidra NativeAOT', envVar: 'REA_GHIDRA_NATIVEAOT_JAR', enables: 'adaptador NativeAOT do Ghidra', linuxOnly: true },
  { id: 'binwalk', label: 'binwalk', envVar: 'REA_BINWALK_COMMAND', enables: 'regiões de firmware', linuxOnly: true },
  { id: 'unblob', label: 'unblob', envVar: 'REA_UNBLOB_COMMAND', enables: 'extração de firmware', linuxOnly: true },
  { id: 'wakaru', label: 'wakaru', envVar: 'REA_WAKARU_COMMAND', enables: 'recuperação de fontes JavaScript', linuxOnly: true }
]

export type ReaEngineSource = 'embutido' | 'detectado' | 'ausente' | 'sem suporte no Windows'

export interface ReaEngineStatus extends ReaEngineInfo {
  source: ReaEngineSource
  version?: string
  path?: string
}

/** One part of resources/rea/openclod-rea.json. Engines carry `env`: variable -> path relative to the engine folder. */
export interface ReaStatePart {
  version?: string
  license?: string
  env?: Record<string, string>
  files?: number
  size?: number
  digest?: string
}

export interface ReaState {
  parts: Record<string, ReaStatePart>
  catalog?: { version: string; tools: number; schemaProfile?: string }
}

export function readReaState(reaDir: string): ReaState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(reaDir, 'openclod-rea.json'), 'utf8')) as Partial<ReaState>
    return raw && typeof raw.parts === 'object' && raw.parts ? { parts: raw.parts, catalog: raw.catalog } : null
  } catch {
    return null
  }
}

function exists(target: string | undefined): target is string {
  if (!target) return false
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

/** Variables pointing at the bundled engines (only those whose files are really there). */
export function bundledEngineEnv(reaDir: string, state: ReaState | null): Record<string, { value: string; engine: string; version?: string }> {
  const out: Record<string, { value: string; engine: string; version?: string }> = {}
  for (const [id, part] of Object.entries(state?.parts ?? {})) {
    if (id === 'node' || id === 'app' || !part.env) continue
    for (const [variable, relative] of Object.entries(part.env)) {
      const value = path.join(reaDir, 'engines', id, relative)
      if (exists(value)) out[variable] = { value, engine: id, version: part.version }
    }
  }
  return out
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

/** Installs the user already has: the REA workspace (rea-local.json), Android Studio's SDK and JBR, Edge/Chrome. */
export function detectedEngineEnv(options: DetectOptions = {}): Record<string, string> {
  const env = options.env ?? process.env
  const home = options.homeDir ?? os.homedir()
  const out: Record<string, string> = {}
  const workspace = detectRea({ env, homeDir: home })?.env ?? {}
  for (const engine of REA_ENGINES) {
    const value = workspace[engine.envVar] ?? env[engine.envVar]
    if (engine.url ? /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(value ?? '') : exists(value)) out[engine.envVar] = value!
  }
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  if (!out.JAVA_HOME) {
    const jbr = path.join(programFiles, 'Android', 'Android Studio', 'jbr')
    if (exists(path.join(jbr, 'bin', 'java.exe'))) out.JAVA_HOME = jbr
  }
  if (!out.REA_ADB_PATH) {
    const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || path.join(localAppData, 'Android', 'Sdk')
    const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
    if (exists(adb)) out.REA_ADB_PATH = adb
  }
  if (!out.REA_BROWSER_EXECUTABLE) {
    const browsers = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ]
    const found = browsers.find((candidate) => exists(candidate))
    if (found) out.REA_BROWSER_EXECUTABLE = found
  }
  // An installed Wireshark (REA needs both tools of the same 4.x install).
  const wireshark = path.join(programFiles, 'Wireshark')
  if (!out.REA_TSHARK_COMMAND && !out.REA_CAPINFOS_COMMAND && exists(path.join(wireshark, 'tshark.exe')) && exists(path.join(wireshark, 'capinfos.exe'))) {
    out.REA_TSHARK_COMMAND = path.join(wireshark, 'tshark.exe')
    out.REA_CAPINFOS_COMMAND = path.join(wireshark, 'capinfos.exe')
  }
  return out
}

export interface ReaEnvironment {
  env: Record<string, string>
  engines: ReaEngineStatus[]
}

/**
 * The environment of the REA server: bundled engines first, detected installs for what is not bundled, REA's own
 * settings (schema profile, Ghidra start budget, temporary folder). `REA_ANALYSIS_PROVIDER` is pinned to Ghidra when
 * Ghidra is there, so a second provider (Kuna) never makes `auto` answer "ambiguous".
 */
export function buildReaEnvironment(reaDir: string, tmpDir: string, options: DetectOptions & { state?: ReaState | null } = {}): ReaEnvironment {
  const state = options.state === undefined ? readReaState(reaDir) : options.state
  const bundled = bundledEngineEnv(reaDir, state)
  const detected = detectedEngineEnv(options)
  const env: Record<string, string> = {}
  const engines: ReaEngineStatus[] = REA_ENGINES.map((engine) => {
    if (engine.linuxOnly && process.platform === 'win32') return { ...engine, source: 'sem suporte no Windows' }
    const own = bundled[engine.envVar]
    if (own) {
      env[engine.envVar] = own.value
      return { ...engine, source: 'embutido', version: own.version, path: own.value }
    }
    const found = detected[engine.envVar]
    if (found) {
      env[engine.envVar] = found
      return { ...engine, source: 'detectado', path: found }
    }
    return { ...engine, source: 'ausente' }
  })
  if (env.GHIDRA_INSTALL_DIR) env.REA_ANALYSIS_PROVIDER = 'ghidra'
  env.REA_MCP_INPUT_SCHEMA_PROFILE = state?.catalog?.schemaProfile ?? 'compact'
  env.REA_GHIDRA_STARTUP_TIMEOUT_MS = '330000'
  env.TEMP = tmpDir
  env.TMP = tmpDir
  // Java tools find their runtime through JAVA_HOME; put its bin first so REA's `java` lookups agree with it.
  if (env.JAVA_HOME) env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
  return { env, engines }
}
