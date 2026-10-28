import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/orchestrator'

/**
 * What a brand-new session costs before the user has said a word: the real system prompt and the real tool schemas of
 * the app, measured by the same code the context meter uses. It is the floor under every conversation, so it has a
 * budget: a tool schema or a paragraph of instructions added without looking shows up here.
 */
let dir = ''
let projectDir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-budget-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-budgetproj-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

describe('the floor of a new session', () => {
  it('stays inside its budget, and says where the tokens are', async () => {
    const orchestrator = new Orchestrator({ userData: dir, broadcast: () => undefined })
    await orchestrator.settings.init()
    await orchestrator.store.init()
    const project = await orchestrator.store.addProject(projectDir, 'Projeto vazio')
    const meta = await orchestrator.store.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: 'ollama', model: 'qualquer' })
    const runner = await orchestrator.ensureRunner(meta.id)
    const meter = runner.contextBreakdown()
    const by = Object.fromEntries(meter.items.map((item) => [item.id, item.tokens]))
    // eslint-disable-next-line no-console
    console.log(`piso de uma sessão nova: ${meter.total} tokens ->`, JSON.stringify(by))

    // Was 10 300 with 31 essential tools (6 075 of schemas); 22 essentials leave about 8 200.
    expect(meter.total).toBeLessThan(8_800)
    expect(by.system).toBeLessThan(3_300)
    expect(by.tools).toBeLessThan(5_000)

    // The wiring, in the app's real registry: what waits for tool_load is not in the first request.
    const sent = (runner as unknown as { availableTools(): string[] }).availableTools()
    for (const name of ['memory_brief', 'memory_search', 'memory_handoff', 'list_skills', 'mcp_servers', 'mcp_catalog', 'mcp_call', 'list_agents', 'task']) {
      expect(sent, name).not.toContain(name)
    }
    for (const name of ['read_file', 'edit_file', 'run_command', 'update_plan', 'ask_user', 'report_limitation', 'memory_page', 'memory_recall', 'use_skill', 'agent', 'tool_search', 'tool_load']) {
      expect(sent, name).toContain(name)
    }
    // Nothing is in the history yet: no memory, no messages.
    expect(by.memory).toBeUndefined()
    expect(by.messages).toBeUndefined()
  }, 60_000)
})
