import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRunner, type RunnerDeps } from '../src/core/agent/runner'
import { FileTracker } from '../src/core/session/tracker'
import { commandDeletesFiles } from '../src/core/security/deletion'
import { evaluateTool } from '../src/core/security/permissions'
import { WorkspaceGuard } from '../src/core/security/policy'
import { buildRegistry } from '../src/core/tools/registry'
import { runCommandTool, startProcessTool } from '../src/core/tools/shell'
import { DEFAULT_LIMITS, type ApprovalRequest, type PolicyConfig } from '../src/shared/types'
import { ScriptedProvider } from './support/scripted-provider'
import { makeTempDir, removeTempDir } from './helpers'

// Cowork asks before permanently deleting files, in any mode ("Deletion protection"). The delete_path tool already asks
// (it is `destructive`); a shell command that deletes must ask too, or the automatic mode would be a way around it.

const policy = (mode: PolicyConfig['mode']): PolicyConfig => ({
  mode,
  blockedCommands: [],
  allowedRoots: [],
  allowNetwork: true,
  allowComputerControl: true,
  shellTimeoutSec: 120
})

const DELETING = [
  'del vendas.csv',
  'del /q "C:\\Users\\ana\\Downloads\\*.tmp"',
  'erase antigo.txt',
  'rd /s /q build',
  'rmdir /s /q "pasta antiga"',
  'rm notas.txt',
  'rm -rf dist',
  'cd pasta && del *.log',
  'Remove-Item -Recurse -Force .\\cache',
  'powershell -Command "Remove-Item \'a.txt\'"',
  'ri a.txt',
  'git clean -fd',
  'python -c "import shutil; shutil.rmtree(\'tmp\')"',
  'python -c "import os; os.remove(\'a.txt\')"',
  'node -e "require(\'fs\').rmSync(\'tmp\', { recursive: true })"',
  'powershell -Command "[System.IO.File]::Delete(\'a.txt\')"',
  // The Recycle Bin routes a model reaches for when it wants a "safe" deletion: still a deletion, still asks.
  'powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(\'a.csv\',\'OnlyErrorDialogs\',\'SendToRecycleBin\')"',
  'powershell -Command "(New-Object -ComObject Shell.Application).Namespace(0).ParseName(\'a.csv\').InvokeVerb(\'delete\')"',
  'python -c "from send2trash import send2trash; send2trash(\'a.csv\')"',
  'robocopy origem destino /MIR',
  'dir & del a.txt'
]

const HARMLESS = [
  'npm test',
  'dir',
  'echo hello',
  'move "nota fiscal.txt" notas\\2026-03-10-nota.txt',
  'copy a.txt b.txt',
  'ren "a b.txt" a-b.txt',
  'git status',
  'python script.py',
  'mkdir contratos',
  'type form.txt',
  'npm run firmware',
  'Get-ChildItem -Recurse',
  'Move-Item a.txt pasta\\',
  'grep -r "remove" src',
  'echo "model" > model.txt'
]

describe('deletion protection for shell commands', () => {
  it.each(DELETING)('recognises a deleting command: %s', (command) => {
    expect(commandDeletesFiles(command)).toBe(true)
  })

  it.each(HARMLESS)('does not flag a harmless command: %s', (command) => {
    expect(commandDeletesFiles(command)).toBe(false)
  })

  it('makes run_command ask in automatic mode when the command deletes', () => {
    const result = evaluateTool(runCommandTool, 'del vendas.csv', policy('auto'), 'C:\\projeto', { command: 'del vendas.csv' })
    expect(result.decision).toBe('ask')
    expect(result.effect).toBe('destructive')
  })

  it('does the same for start_process', () => {
    const result = evaluateTool(startProcessTool, 'rm -rf dist', policy('auto'), 'C:\\projeto', { command: 'rm -rf dist' })
    expect(result.decision).toBe('ask')
  })

  it('keeps ordinary commands running without a prompt in automatic mode', () => {
    for (const command of HARMLESS) {
      const result = evaluateTool(runCommandTool, command, policy('auto'), 'C:\\projeto', { command })
      expect(result.decision, command).toBe('allow')
    }
  })

  it('still asks in the manual and accept-edits modes', () => {
    for (const mode of ['ask', 'accept-edits'] as const) {
      expect(evaluateTool(runCommandTool, 'del a.txt', policy(mode), 'C:\\projeto', { command: 'del a.txt' }).decision).toBe('ask')
    }
  })

  it('respects the explicit opt-in of the unrestricted mode', () => {
    expect(evaluateTool(runCommandTool, 'del a.txt', policy('unrestricted'), 'C:\\projeto', { command: 'del a.txt' }).decision).toBe('allow')
  })
})

// The same thing through the real agent loop and the real shell: in automatic mode the approval request reaches the user, and
// the file is deleted only if the user says yes (the model is a scripted stand-in; the loop, the permission engine and the
// shell are the real ones).
describe('deletion protection in the agent loop (automatic mode)', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await makeTempDir('openclod-deletion-')
    fs.writeFileSync(path.join(cwd, 'duplicada.txt'), 'conteúdo')
  })

  afterEach(async () => {
    await removeTempDir(cwd)
  })

  function run(approve: (request: ApprovalRequest) => boolean): { runner: SessionRunner; asked: ApprovalRequest[] } {
    const asked: ApprovalRequest[] = []
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'del duplicada.txt' } }] },
      { text: 'ok' }
    ])
    const deps: RunnerDeps = {
      sessionId: 'ses_del',
      cwd,
      mode: 'autonomous',
      surface: 'cowork',
      provider,
      providerConfig: { id: 'mock', kind: 'openai', label: 'Scripted', baseUrl: 'http://localhost:0/v1', model: 'scripted', contextWindow: 128_000, supportsVision: false, supportsTools: true },
      registry: buildRegistry(runCommandTool),
      policy: policy('auto'),
      limits: { ...DEFAULT_LIMITS, maxIterations: 4 },
      tracker: new FileTracker(cwd),
      workspace: new WorkspaceGuard([cwd]),
      services: { browser: {}, computer: {}, skills: { list: () => [] }, memory: { all: async () => [] } } as unknown as RunnerDeps['services'],
      project: { name: 'Teste', isGitRepo: false },
      emit: () => undefined,
      approve: async (request) => {
        asked.push(request)
        return approve(request)
      },
      retryBaseMs: 1
    }
    return { runner: new SessionRunner(deps), asked }
  }

  it('asks first and does not delete when the user refuses', async () => {
    const { runner, asked } = run(() => false)
    await runner.send('apague a cópia duplicada')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tool: 'run_command', risk: 'destructive', effect: 'destructive' })
    expect(asked[0].resource ?? asked[0].preview ?? '').toContain('del duplicada.txt')
    expect(fs.existsSync(path.join(cwd, 'duplicada.txt'))).toBe(true)
  })

  it('deletes only after the user approves', async () => {
    const { runner, asked } = run(() => true)
    await runner.send('apague a cópia duplicada')
    expect(asked).toHaveLength(1)
    expect(fs.existsSync(path.join(cwd, 'duplicada.txt'))).toBe(false)
  })
})
