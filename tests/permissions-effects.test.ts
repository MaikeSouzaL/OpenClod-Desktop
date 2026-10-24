import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { effectOf, evaluateTool } from '../src/core/security/permissions'
import type { ToolDef } from '../src/core/tools/types'
import type { PolicyConfig, RiskLevel } from '../src/shared/types'

function tool(name: string, risk: RiskLevel): ToolDef {
  return {
    name,
    description: name,
    schema: z.object({}),
    risk,
    parallelSafe: true,
    describe: () => ({ title: name, detail: '' }),
    execute: async () => ({ ok: true, text: '' })
  }
}

const policy = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
  mode: 'auto',
  blockedCommands: [],
  allowedRoots: [],
  allowNetwork: true,
  allowComputerControl: true,
  shellTimeoutSec: 120,
  ...overrides
})

describe('permission engine: action + resource + effect', () => {
  it('classifies each action by its real effect', () => {
    expect(effectOf(tool('read_file', 'read'))).toBe('read')
    expect(effectOf(tool('write_file', 'write'))).toBe('write')
    expect(effectOf(tool('run_command', 'exec'))).toBe('execute')
    expect(effectOf(tool('web_search', 'network'))).toBe('network')
    expect(effectOf(tool('computer_click', 'exec'))).toBe('control')
    expect(effectOf(tool('delete_path', 'destructive'))).toBe('destructive')
  })

  it('reports the concrete resource and the effect with the decision', () => {
    const result = evaluateTool(tool('run_command', 'exec'), 'npm test', policy(), 'C:\\projeto')
    expect(result).toMatchObject({
      decision: 'allow',
      action: 'run_command',
      resource: 'npm test',
      effect: 'execute'
    })
  })

  it('lets a deny rule win over the automatic mode and names the rule', () => {
    const result = evaluateTool(
      tool('run_command', 'exec'),
      'git push origin main',
      policy({ rules: { allow: ['Bash(*)'], ask: [], deny: ['Bash(git push:*)'] } }),
      'C:\\projeto'
    )
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('Bash(git push:*)')
  })

  it('keeps destructive actions asking even in automatic mode', () => {
    const result = evaluateTool(tool('delete_path', 'destructive'), 'C:\\projeto\\src', policy(), 'C:\\projeto')
    expect(result.decision).toBe('ask')
    expect(result.effect).toBe('destructive')
  })
})
