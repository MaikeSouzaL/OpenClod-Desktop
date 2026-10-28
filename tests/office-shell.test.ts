import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { FileTracker } from '../src/core/session/tracker'
import { WorkspaceGuard } from '../src/core/security/policy'
import { buildRegistry } from '../src/core/tools/registry'
import { runCommandTool } from '../src/core/tools/shell'
import { officeRuntime, resetOfficeRuntimeCache } from '../src/core/util/office-runtime'
import { DEFAULT_LIMITS, type PolicyConfig, type SessionSurface } from '../src/shared/types'
import { ScriptedProvider } from './support/scripted-provider'
import { makeTempDir, removeTempDir } from './helpers'

// The real agent loop and the real shell, on the real embedded runtime (skipped where it is not built): what run_command
// does for a script that needs python-docx / openpyxl / python-pptx when the computer's own Python lacks them, or does not
// exist. The model is the scripted test double; everything else (permissions, PATH, processes) is the real thing.

const available = process.platform === 'win32' && Boolean(officeRuntime())
const run = available ? describe : describe.skip

const policy: PolicyConfig = { mode: 'unrestricted', blockedCommands: [], allowedRoots: [], allowNetwork: true, allowComputerControl: false, shellTimeoutSec: 120 }

let cwd: string
let previousPath: string | undefined

beforeEach(async () => {
  cwd = await makeTempDir('openclod-office-shell-')
  previousPath = process.env.PATH ?? process.env.Path
  resetOfficeRuntimeCache()
})

afterEach(async () => {
  process.env.PATH = previousPath
  resetOfficeRuntimeCache()
  await removeTempDir(cwd)
})

/**
 * A `python` that behaves like a real interpreter without the document libraries: the probe (`python -c ...`) is answered with a
 * version and "no libraries", and any other call runs `body` (the output of the script that needed python-docx, for instance).
 */
const computerPython = (body: string): string => ['@echo off', 'if "%~1"=="-c" goto probe', body, 'exit /b 0', ':probe', 'echo 3.10.0 0 0 0', ''].join('\r\n')

/** PATH with only the Windows folders (cmd builtins keep working) and, optionally, a fake `python`. */
function hidePython(fake?: string): void {
  const system = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
  if (fake !== undefined) {
    const dir = path.join(cwd, 'sistema')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'python.cmd'), fake)
    process.env.PATH = `${dir};${system}`
  } else process.env.PATH = system
  resetOfficeRuntimeCache()
}

/** Runs one run_command call through the agent loop and returns the text the model got back. */
async function ask(command: string, surface: SessionSurface = 'cowork'): Promise<string> {
  const provider = new ScriptedProvider([{ toolCalls: [{ id: 'c1', name: 'run_command', args: { command } }] }, { text: 'feito' }])
  const deps: RunnerDeps = {
    sessionId: 'ses_office',
    cwd,
    mode: 'autonomous',
    surface,
    provider,
    providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
    registry: buildRegistry(runCommandTool),
    policy,
    limits: { ...DEFAULT_LIMITS, maxIterations: 4 },
    tracker: new FileTracker(cwd),
    workspace: new WorkspaceGuard([cwd], true),
    services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: { all: async () => [] } } as unknown as RunnerDeps['services'],
    project: { name: 'Teste', isGitRepo: false },
    emit: () => undefined,
    approve: async () => true,
    retryBaseMs: 1
  }
  const runner = new SessionRunner(deps)
  await runner.send('rode o comando')
  const tool = runner.messages.find((message) => message.role === 'tool')
  return JSON.stringify(tool?.parts ?? [])
}

run('run_command and the embedded document runtime', () => {
  const imports = 'import docx, openpyxl, pptx, xlsxwriter, PIL, lxml; print(\\"libs-ok\\")'

  it('openclod-python has the libraries even when the computer Python lacks them', async () => {
    hidePython(computerPython("echo ModuleNotFoundError: No module named 'docx' 1>&2\r\nexit /b 1"))
    const text = await ask(`openclod-python -c "${imports}"`)
    expect(text).toContain('libs-ok')
    expect(text).toContain('exit=0')
  }, 60_000)

  it('openclod-python works on a computer with no Python at all', async () => {
    hidePython()
    expect(await ask(`openclod-python -c "${imports}"`)).toContain('libs-ok')
  }, 60_000)

  it('plain `python` becomes the embedded one only when the computer has no Python', async () => {
    hidePython()
    const text = await ask(`python -c "${imports}"`)
    expect(text).toContain('libs-ok')
    // with a Python of its own (even one without the libraries) `python` keeps meaning that Python
    hidePython(computerPython('echo python-do-computador'))
    const own = await ask('python gerar.py')
    expect(own).toContain('python-do-computador')
    expect(own).not.toContain('libs-ok')
  }, 60_000)

  it('a script that fails on the computer Python for a missing document library is told to use openclod-python', async () => {
    hidePython(computerPython("echo Traceback (most recent call last): 1>&2\r\necho ModuleNotFoundError: No module named 'docx' 1>&2\r\nexit /b 1"))
    const text = await ask('python gerar.py')
    expect(text).toContain('No module named')
    expect(text).toContain('Dica')
    expect(text).toContain('openclod-python')
  }, 60_000)

  it('openclod-office check reports the libraries', async () => {
    hidePython()
    const text = await ask('openclod-office check')
    expect(text).toContain('Tudo pronto')
    expect(text).toContain('python-docx')
  }, 60_000)

  it('Cowork refuses to pip-install what is embedded, and nothing runs; Code leaves it alone', async () => {
    hidePython()
    const marker = path.join(cwd, 'marcador.txt')
    const command = 'echo pip install python-docx > marcador.txt'
    const blocked = await ask(command, 'cowork')
    expect(blocked).toContain('BLOQUEADO')
    expect(blocked).toContain('openclod-python')
    expect(fs.existsSync(marker)).toBe(false)
    await ask(command, 'code')
    expect(fs.existsSync(marker)).toBe(true)
  }, 60_000)
})
