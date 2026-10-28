import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

/**
 * A Python for the tests of the Colab notebook module (resources/colab/openclod_llm_server.py, standard library only).
 * Order: OPENCLOD_TEST_PYTHON, the interpreter embedded in resources/runtime, then `python` / `python3` on PATH.
 * Tests that need it are skipped (not failed) when the computer has none.
 */
const ROOT = path.resolve(__dirname, '..', '..')

function works(command: string): boolean {
  const probe = spawnSync(command, ['-I', '-c', 'import sys; print(sys.version_info[:2] >= (3, 9))'], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  return probe.status === 0 && probe.stdout.trim() === 'True'
}

let cached: string | null | undefined

export function findPython(): string | null {
  if (cached !== undefined) return cached
  const candidates = [
    process.env.OPENCLOD_TEST_PYTHON,
    path.join(ROOT, 'resources', 'runtime', 'python', 'python.exe'),
    'python',
    'python3'
  ].filter((item): item is string => Boolean(item))
  cached = candidates.find((candidate) => (candidate.includes(path.sep) ? fs.existsSync(candidate) : true) && works(candidate)) ?? null
  return cached
}

/** The first Python (same order as `findPython`) that can import `moduleName`, or null: the embedded runtime has no extra packages. */
export function findPythonWith(moduleName: string): string | null {
  const candidates = [
    process.env.OPENCLOD_TEST_PYTHON,
    path.join(ROOT, 'resources', 'runtime', 'python', 'python.exe'),
    'python',
    'python3'
  ].filter((item): item is string => Boolean(item))
  return (
    candidates.find((candidate) => {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) return false
      return spawnSync(candidate, ['-I', '-c', `import ${moduleName}`], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).status === 0
    }) ?? null
  )
}

export const SERVER_MODULE = path.join(ROOT, 'resources', 'colab', 'openclod_llm_server.py')

/** `python -I <args>` (isolated: nothing from the working directory or the environment can shadow the standard library). */
export function runPython(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): SpawnSyncReturns<string> {
  const python = findPython()
  if (!python) throw new Error('nenhum Python encontrado')
  // -I ignores PYTHON* variables (PYTHONIOENCODING included), so UTF-8 mode is asked for on the command line.
  // -B: no __pycache__ next to resources/colab/openclod_llm_server.py (it ships with the app).
  return spawnSync(python, ['-X', 'utf8', '-B', '-I', ...args], {
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...options.env },
    timeout: options.timeoutMs ?? 60_000,
    windowsHide: true
  })
}

/** Runs one subcommand of the module CLI and parses its JSON line. */
export function moduleJson<T = unknown>(args: string[]): T {
  const result = runPython([SERVER_MODULE, ...args])
  if (result.status !== 0 && result.status !== 2) throw new Error(`python falhou (${result.status}): ${result.stderr}`)
  return JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as T
}
