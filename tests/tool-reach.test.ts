import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/orchestrator'
import { toolsForMode } from '../src/core/security/permissions'
import type { AgentMode } from '../src/shared/types'

/**
 * A tool registered in the app but listed in no mode can never be called: tool_search and tool_load only see what the
 * session's mode allows. design_sheet and memory_file shipped like that (the app had them; no agent could find them).
 * Every tool of the real registry must be reachable from at least one mode, and these from the coding modes.
 */
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-reach-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

const MODES: AgentMode[] = ['ask', 'plan', 'code', 'debug', 'review', 'computer', 'web', 'autonomous', 'loop', 'rea']

describe('every tool of the app is reachable', () => {
  it('lists each registered tool in at least one mode', async () => {
    const orchestrator = new Orchestrator({ userData: dir, broadcast: () => undefined })
    await orchestrator.settings.init()
    const registry = (orchestrator as unknown as { baseRegistry: { names(): string[] } }).baseRegistry
    // The runner grants these itself, outside the mode lists: discovery always, the MCP fallbacks in the MCP modes.
    const reachable = new Set([...MODES.flatMap((mode) => toolsForMode(mode)), 'tool_search', 'tool_list', 'tool_load', 'mcp_catalog', 'mcp_call'])
    const orphans = registry.names().filter((name) => !reachable.has(name))
    expect(orphans).toEqual([])
  })

  it('gives memory_file to every mode and design_sheet to the modes that write files', () => {
    for (const mode of MODES) {
      const tools = toolsForMode(mode)
      expect(tools, mode).toContain('memory_file')
      expect(tools.includes('design_sheet'), mode).toBe(tools.includes('write_file'))
    }
    expect(toolsForMode('code')).toContain('design_sheet')
    expect(toolsForMode('ask')).not.toContain('design_sheet')
  })
})
