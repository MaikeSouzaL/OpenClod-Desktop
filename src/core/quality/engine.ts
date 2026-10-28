import fs from 'node:fs'
import path from 'node:path'
import type { EnvironmentProfile } from '../../shared/types.js'
import { runShellCommand } from '../tools/shell.js'
import { analyzeFailureOutput, type QualityIssue } from '../code-intelligence/index.js'

export interface QualityCheck {
  id: string
  label: string
  command: string
  source: string
  kind: 'test' | 'typecheck' | 'lint' | 'build'
}

export interface QualityRunResult {
  check: QualityCheck
  status: 'passed' | 'failed' | 'not-run' | 'inconclusive'
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  issues: QualityIssue[]
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function scriptChecks(root: string): QualityCheck[] {
  const pkg = readJson(path.join(root, 'package.json'))
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts as Record<string, unknown> : {}
  const out: QualityCheck[] = []
  const candidates: Array<[RegExp, QualityCheck['kind']]> = [
    [/^(test|test:unit|test:all|vitest|jest)$/i, 'test'],
    [/^(typecheck|type-check|check:types|tsc)$/i, 'typecheck'],
    [/^(lint|check:lint|eslint)$/i, 'lint'],
    [/^(build|compile)$/i, 'build']
  ]
  for (const [pattern, kind] of candidates) {
    const name = Object.keys(scripts).find((candidate) => pattern.test(candidate))
    if (!name || typeof scripts[name] !== 'string') continue
    out.push({ id: `npm:${name}`, label: `npm run ${name}`, command: `npm run ${name}`, source: 'package.json', kind })
  }
  return out
}

export async function discoverQualityChecks(root: string): Promise<QualityCheck[]> {
  const checks = scriptChecks(root)
  const has = (name: string): boolean => exists(path.join(root, name))
  const add = (check: QualityCheck): void => {
    if (!checks.some((item) => item.id === check.id)) checks.push(check)
  }
  if (has('pyproject.toml') || has('setup.cfg') || has('pytest.ini') || has('tests')) {
    add({ id: 'python:pytest', label: 'pytest', command: 'python -m pytest -q', source: 'Python project', kind: 'test' })
  }
  if (has('go.mod')) add({ id: 'go:test', label: 'go test', command: 'go test ./...', source: 'go.mod', kind: 'test' })
  if (has('Cargo.toml')) add({ id: 'rust:test', label: 'cargo test', command: 'cargo test', source: 'Cargo.toml', kind: 'test' })
  if (has('tsconfig.json')) {
    add({ id: 'ts:typecheck', label: 'tsc --noEmit', command: 'npx tsc --noEmit', source: 'tsconfig.json', kind: 'typecheck' })
  }
  const solution = fs.readdirSync(root).find((name) => name.toLowerCase().endsWith('.sln'))
  if (solution) add({ id: 'dotnet:test', label: 'dotnet test', command: `dotnet test "${solution.replace(/"/g, '""')}"`, source: solution, kind: 'test' })
  return checks
}

function cleanOutput(text: string, max = 40_000): string {
  return text.trim().length > max ? `${text.trim().slice(0, max)}\n…[saída truncada]` : text.trim()
}

export async function runQualityChecks(args: {
  root: string
  checks: QualityCheck[]
  sessionId: string
  signal: AbortSignal
  environment?: EnvironmentProfile
  timeoutMs?: number
}): Promise<QualityRunResult[]> {
  const results: QualityRunResult[] = []
  for (const check of args.checks) {
    if (args.signal.aborted) {
      results.push({ check, status: 'not-run', exitCode: null, timedOut: false, durationMs: 0, stdout: '', stderr: 'cancelado', issues: [] })
      continue
    }
    const started = Date.now()
    const result = await runShellCommand(
      check.command,
      args.root,
      args.timeoutMs ?? 15 * 60_000,
      args.sessionId,
      args.signal,
      args.environment
    )
    const durationMs = Date.now() - started
    const combined = `${result.stdout}\n${result.stderr}`
    const noRunner = /command not found|could not determine executable|não é reconhecido|is not recognized as an internal or external command/i.test(
      combined
    )
    const status: QualityRunResult['status'] = result.timedOut
      ? 'inconclusive'
      : noRunner || result.code === -1
        ? 'not-run'
        : result.code === 0
          ? 'passed'
          : 'failed'
    results.push({
      check,
      status,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs,
      stdout: cleanOutput(result.stdout),
      stderr: cleanOutput(result.stderr),
      issues: analyzeFailureOutput(combined)
    })
  }
  return results
}
