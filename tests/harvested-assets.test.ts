import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../src/core/agents/definitions'
import { loadAgents, parseAgentMarkdown } from '../src/core/agents/loader'
import { parseFrontmatter } from '../src/core/skills/library'

const root = path.resolve(__dirname, '..')
const harvested = path.join(root, 'resources', 'harvested')
const manifest = JSON.parse(fs.readFileSync(path.join(harvested, 'manifest.json'), 'utf8')) as {
  totals: { skills: number; agents: number; commands: number; prompts: number; all: number; tools: number }
  items: Array<{
    kind: string
    dest: string
    source: string
    repo: string
    license: string
    files?: string[]
  }>
  tools: Array<{
    id: string
    dest: string
    source: string
    license: string
    status: string
  }>
}

describe('harvested research assets', () => {
  it('has a complete, licensed archive that survives deleting the clones', () => {
    expect(manifest.totals.all).toBeGreaterThan(500)
    expect(manifest.totals.skills).toBeGreaterThan(300)
    expect(manifest.totals.agents).toBeGreaterThan(10)
    expect(manifest.totals.commands).toBeGreaterThan(10)
    expect(manifest.totals.tools).toBeGreaterThan(20)

    for (const item of manifest.items) {
      expect(['MIT', 'Apache-2.0', 'BSD', 'ISC'], `${item.source} (${item.license})`).toContain(item.license)
      expect(fs.existsSync(path.join(root, item.dest)), item.dest).toBe(true)
      for (const file of item.files ?? []) {
        expect(fs.existsSync(path.join(path.dirname(path.join(root, item.dest)), file)), file).toBe(true)
      }
    }
    for (const tool of manifest.tools) {
      expect(['MIT', 'Apache-2.0', 'BSD', 'ISC'], `${tool.source} (${tool.license})`).toContain(tool.license)
      expect(fs.existsSync(path.join(root, tool.dest)), tool.dest).toBe(true)
      expect(['ported', 'queued']).toContain(tool.status)
    }
    expect(fs.existsSync(path.join(harvested, 'LICENSES'))).toBe(true)
    expect(fs.existsSync(path.join(harvested, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(harvested, 'tools', 'catalog.json'))).toBe(true)
  })

  it('keeps every curated skill parseable and uniquely named', () => {
    const dir = path.join(root, 'resources', 'skills')
    const names = new Set<string>()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(dir, entry.name, 'SKILL.md')
      expect(fs.existsSync(file), file).toBe(true)
      const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
      expect(meta.name, file).toBeTruthy()
      expect(meta.description, file).toBeTruthy()
      expect(names.has(meta.name), `skill duplicada: ${meta.name}`).toBe(false)
      names.add(meta.name)
    }
    expect(names.size).toBeGreaterThanOrEqual(10)
  })

  it('loads the bundled agents without overriding a built-in', () => {
    const dir = path.join(root, 'resources', 'agents')
    const builtin = new Set(BUILTIN_AGENTS.map((agent) => agent.name))
    const names = new Set<string>()
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const parsed = parseAgentMarkdown(
        fs.readFileSync(path.join(dir, file), 'utf8'),
        path.basename(file, '.md'),
        'builtin'
      )
      expect(parsed.error, file).toBeUndefined()
      expect(parsed.agent, file).toBeTruthy()
      if (!parsed.agent) continue
      expect(builtin.has(parsed.agent.name), `conflito com builtin: ${parsed.agent.name}`).toBe(false)
      expect(names.has(parsed.agent.name), `agente duplicado: ${parsed.agent.name}`).toBe(false)
      names.add(parsed.agent.name)
    }
    expect([...names]).toEqual(
      expect.arrayContaining(['css-specialist', 'test-engineer', 'playwright-test-generator'])
    )

    const loaded = loadAgents({ bundledDir: dir })
    const loadedNames = loaded.agents.map((agent) => agent.name)
    expect(loadedNames).toEqual(expect.arrayContaining([...names]))
    expect(loaded.warnings.filter((warning) => warning.file === dir)).toEqual([])
  })
})
