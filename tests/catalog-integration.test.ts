import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../src/core/agents/definitions'
import { importClaudeCatalog } from '../src/main/claude-import'
import { makeTempDir, removeTempDir } from './helpers'

let dir: string

beforeEach(async () => {
  dir = await makeTempDir('openclod-catalog-')
})

afterEach(async () => {
  await removeTempDir(dir)
})

describe('Claude catalog integration', () => {
  it('ships the QA specialist team', () => {
    const byName = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, agent]))
    for (const name of ['computer-operator', 'strategist', 'verifier', 'web-qa', 'mobile-qa', 'qa-lead']) {
      const agent = byName.get(name)
      expect(agent, name).toBeTruthy()
      expect(agent?.model, name).toBe('best')
    }
    expect(byName.get('computer-operator')?.tools).toContain('computer_mouse_button')
    expect(byName.get('computer-operator')?.tools).toContain('computer_drag')
    expect(byName.get('web-qa')?.tools).toContain('browser_snapshot')
    expect(byName.get('mobile-qa')?.tools).toContain('run_command')
  })

  it('ships the full qa-total skill with scripts and the Openclod note', () => {
    const skill = path.join(process.cwd(), 'resources', 'skills', 'qa-total')
    expect(fs.existsSync(path.join(skill, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(skill, 'OPENCLOD.md'))).toBe(true)
    expect(fs.existsSync(path.join(skill, 'scripts', 'cobertura.py'))).toBe(true)
    expect(fs.existsSync(path.join(skill, 'scripts', 'gerar_pdf.py'))).toBe(true)
  })

  it('imports skills, agents and MCPs without overwriting existing work', () => {
    const home = path.join(dir, 'home')
    const userData = path.join(dir, 'userData')
    const appData = path.join(dir, 'appData')
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'minha-skill'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'minha-skill', 'SKILL.md'), '---\nname: minha-skill\ndescription: teste\n---\n\n# Minha skill\n')
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'meu-agente.md'), '---\nname: meu-agente\ndescription: teste\n---\n\nPrompt.\n')
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'orchestrator.md'), '---\nname: orchestrator\ndescription: conflito\n---\n\nPrompt.\n')
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          jira: {
            command: 'uvx',
            args: ['mcp-atlassian'],
            env: { JIRA_URL: 'https://example.atlassian.net', JIRA_API_TOKEN: 'x' }
          },
          remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } }
        }
      })
    )

    const { report, servers } = importClaudeCatalog({ userData, homeDir: home, appData })
    expect(report.skills).toBe(1)
    expect(report.agents).toBe(1)
    expect(report.mcp).toBe(2)
    expect(fs.existsSync(path.join(userData, 'skills', 'minha-skill', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'agents', 'meu-agente.md'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'agents', 'orchestrator.md'))).toBe(false)
    expect(servers.find((server) => server.name === 'jira')).toMatchObject({ command: 'uvx', args: ['mcp-atlassian'] })
    expect(servers.find((server) => server.name === 'remote')).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer x' }
    })

    // A second import never overwrites a file the user already changed.
    fs.writeFileSync(path.join(userData, 'agents', 'meu-agente.md'), 'meu ajuste')
    const second = importClaudeCatalog({ userData, homeDir: home, appData })
    expect(second.report.agents).toBe(0)
    expect(fs.readFileSync(path.join(userData, 'agents', 'meu-agente.md'), 'utf8')).toBe('meu ajuste')
  })
})
