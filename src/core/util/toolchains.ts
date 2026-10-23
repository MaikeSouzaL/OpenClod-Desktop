import { execFile } from 'node:child_process'

/**
 * Which language toolchains the machine has (Go, Rust, Python, Node…). Forja does
 * not ship these compilers — they belong to the user's projects — but the agent
 * must know what it can run, and the user what is missing.
 */

export interface Toolchain {
  id: string
  label: string
  /** First version number found in the tool's own output. */
  version: string
  command: string
}

interface Probe {
  id: string
  label: string
  commands: string[][]
  /** .cmd shims (npm, pnpm…) only start through the shell on Windows. */
  shim?: boolean
}

const PROBES: Probe[] = [
  { id: 'node', label: 'Node.js', commands: [['node', '--version']] },
  { id: 'npm', label: 'npm', commands: [['npm', '--version']], shim: true },
  { id: 'git', label: 'Git', commands: [['git', '--version']] },
  { id: 'python', label: 'Python', commands: [['python', '--version'], ['py', '--version']] },
  { id: 'go', label: 'Go', commands: [['go', 'version']] },
  { id: 'rust', label: 'Rust (rustc)', commands: [['rustc', '--version']] },
  { id: 'cargo', label: 'Cargo', commands: [['cargo', '--version']] },
  { id: 'dotnet', label: '.NET', commands: [['dotnet', '--version']] },
  { id: 'java', label: 'Java', commands: [['java', '-version']] }
]

export type ExecFn = (file: string, args: string[], options: { shim: boolean; timeoutMs: number }) => Promise<string>

const defaultExec: ExecFn = (file, args, { shim, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: shim && process.platform === 'win32', maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        // `java -version` writes to stderr; any output with a version number is good enough.
        const text = `${stdout}\n${stderr}`
        if (error && !/\d+\.\d+/.test(text)) reject(error)
        else resolve(text)
      }
    )
  })

export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output)
  return match ? match[1] : null
}

export async function detectToolchains(exec: ExecFn = defaultExec): Promise<Toolchain[]> {
  const found = await Promise.all(
    PROBES.map(async (probe): Promise<Toolchain | null> => {
      for (const [file, ...args] of probe.commands) {
        try {
          const version = parseVersion(await exec(file, args, { shim: Boolean(probe.shim), timeoutMs: 4000 }))
          if (version) return { id: probe.id, label: probe.label, version, command: file }
        } catch {
          /* not installed under this name */
        }
      }
      return null
    })
  )
  return found.filter((item): item is Toolchain => item !== null)
}

let cache: Promise<Toolchain[]> | null = null

/** Detected once per run (the probes spawn processes); `refresh` forces a new look. */
export function toolchains(refresh = false): Promise<Toolchain[]> {
  if (!cache || refresh) cache = detectToolchains().catch(() => [])
  return cache
}

/** One line for the system prompt, including what is missing. */
export function describeToolchains(found: Toolchain[]): string {
  const have = found.map((item) => `${item.label} ${item.version}`)
  const missing = PROBES.filter((probe) => !found.some((item) => item.id === probe.id)).map((probe) => probe.label)
  return `Toolchains nesta máquina: ${have.length ? have.join(', ') : 'nenhuma detectada'}.${missing.length ? ` Não encontrados: ${missing.join(', ')}.` : ''}`
}
