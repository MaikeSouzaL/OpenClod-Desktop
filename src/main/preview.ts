import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { DevServerCandidate, DevServerDetection, DevServerStart } from '../shared/api.js'
import type { TerminalManager } from './terminal.js'

/**
 * Dev-server detection for the browser pane, compatible with the
 * `.claude/launch.json` shape ({version, configurations:[{name,
 * runtimeExecutable, runtimeArgs, port, url}]}). The user's choice is saved
 * to `.openclod/launch.json`; `.claude/launch.json` is only read.
 */

interface LaunchConfiguration {
  name: string
  runtimeExecutable: string
  runtimeArgs?: string[]
  port?: number
  url?: string
}

interface LaunchFile {
  version: string
  configurations: LaunchConfiguration[]
}

const SCRIPT_NAMES = /^(dev|start|serve|preview|storybook|web|frontend|client)(:.+)?$/i
const URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s'"<>\x1b]*/i
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const START_TIMEOUT_MS = 45_000

export function launchFilePath(root: string): string {
  return path.join(root, '.openclod', 'launch.json')
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readLaunch(file: string): LaunchConfiguration[] {
  const data = readJson(file) as Partial<LaunchFile> | null
  if (!data || !Array.isArray(data.configurations)) return []
  return data.configurations.flatMap((entry) => {
    const item = entry as Partial<LaunchConfiguration>
    if (typeof item?.name !== 'string' || typeof item.runtimeExecutable !== 'string') return []
    return [
      {
        name: item.name.slice(0, 80),
        runtimeExecutable: item.runtimeExecutable.slice(0, 200),
        runtimeArgs: Array.isArray(item.runtimeArgs) ? item.runtimeArgs.filter((arg): arg is string => typeof arg === 'string').slice(0, 30) : [],
        port: Number.isInteger(item.port) ? item.port : undefined,
        url: typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : undefined
      }
    ]
  })
}

function packageManager(root: string): string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** Best-effort port from the script body; the real URL is read from the output. */
export function guessPort(script: string): number | undefined {
  const explicit = script.match(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/)
  if (explicit) return Number(explicit[1])
  if (/\bnext\b/.test(script)) return 3000
  if (/react-scripts|\bnuxt\b|\bremix\b(?!.*vite)/.test(script)) return 3000
  if (/\bastro\b/.test(script)) return 4321
  if (/\bng serve\b|@angular/.test(script)) return 4200
  if (/\bgatsby\b/.test(script)) return 8000
  if (/\bparcel\b/.test(script)) return 1234
  if (/storybook/.test(script)) return 6006
  if (/webpack(-dev-server| serve)/.test(script)) return 8080
  if (/\bexpo\b/.test(script)) return 8081
  if (/\bvite\b|svelte-kit|electron-vite/.test(script)) return 5173
  return undefined
}

function quoteArg(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

function commandOf(config: LaunchConfiguration): string {
  return [config.runtimeExecutable, ...(config.runtimeArgs ?? [])].map(quoteArg).join(' ')
}

function configurations(root: string): { configs: LaunchConfiguration[]; saved?: string } {
  const own = readLaunch(launchFilePath(root))
  const claude = readLaunch(path.join(root, '.claude', 'launch.json'))
  const configs = [...own, ...claude.filter((item) => !own.some((mine) => mine.name === item.name))]
  return { configs, saved: own[0]?.name }
}

function scriptConfigurations(root: string): LaunchConfiguration[] {
  const pkg = readJson(path.join(root, 'package.json')) as { scripts?: Record<string, unknown> } | null
  if (!pkg?.scripts || typeof pkg.scripts !== 'object') return []
  const manager = packageManager(root)
  return Object.entries(pkg.scripts)
    .filter(([name, body]) => SCRIPT_NAMES.test(name) && typeof body === 'string')
    .map(([name, body]) => ({
      name,
      runtimeExecutable: manager,
      runtimeArgs: manager === 'yarn' ? [name] : ['run', name],
      port: guessPort(body as string)
    }))
}

export function detectDevServers(root: string): DevServerDetection {
  const { configs, saved } = configurations(root)
  const fromScripts = scriptConfigurations(root).filter((script) => !configs.some((config) => config.name === script.name))
  const candidates: DevServerCandidate[] = [
    ...configs.map((config) => ({ name: config.name, command: commandOf(config), port: config.port, url: config.url, source: 'launch.json' as const })),
    ...fromScripts.map((config) => ({ name: config.name, command: commandOf(config), port: config.port, source: 'package.json' as const }))
  ]
  return { candidates, saved, launchFile: launchFilePath(root) }
}

function findConfiguration(root: string, name: string): LaunchConfiguration | undefined {
  return [...configurations(root).configs, ...scriptConfigurations(root)].find((config) => config.name === name)
}

/** Saves the chosen configuration first in .openclod/launch.json (atomic write). */
export function saveLaunchChoice(root: string, config: LaunchConfiguration): void {
  const file = launchFilePath(root)
  const others = readLaunch(file).filter((item) => item.name !== config.name)
  const data: LaunchFile = { version: '0.0.1', configurations: [config, ...others] }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(600)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function findServerUrl(output: string): string | null {
  const match = output.replace(ANSI, '').match(URL_PATTERN)
  if (!match) return null
  return match[0].replace(/0\.0\.0\.0/, 'localhost').replace(/[.,;)\]]+$/, '')
}

/**
 * Runs the configuration in a visible terminal of the session (cmd.exe, so
 * PowerShell's script execution policy cannot block npm.ps1) and waits for
 * the server URL in its output or for the expected port to accept connections.
 */
export async function startDevServer(
  terminals: TerminalManager,
  root: string,
  name: string,
  sessionId: string
): Promise<DevServerStart> {
  const config = findConfiguration(root, name)
  if (!config) throw new Error(`configuração "${name}" não encontrada`)
  saveLaunchChoice(root, config)
  const info = terminals.create({ cwd: root, cols: 120, rows: 30, shell: process.platform === 'win32' ? 'cmd' : undefined, sessionId })
  terminals.write(info.id, `${commandOf(config)}\r`)

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    let output = ''
    try {
      output = terminals.snapshot(info.id)
    } catch {
      break
    }
    const url = findServerUrl(output)
    if (url) return { url: config.url ?? url, terminalId: info.id }
    if (config.port && (await portOpen(config.port))) {
      return { url: config.url ?? `http://localhost:${config.port}`, terminalId: info.id }
    }
    if (terminals.list().find((item) => item.id === info.id)?.exited) break
  }
  return { url: config.url ?? null, terminalId: info.id }
}
