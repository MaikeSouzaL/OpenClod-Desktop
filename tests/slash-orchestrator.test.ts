import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/main/orchestrator'

let dir = ''
let projectDir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-slash-'))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-slash-proj-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
})

async function boot(): Promise<{ orchestrator: Orchestrator; sessionId: string }> {
  const orchestrator = new Orchestrator({ userData: dir, broadcast: () => undefined, log: () => undefined })
  await orchestrator.settings.init()
  await orchestrator.store.init()
  const project = await orchestrator.store.addProject(projectDir, 'Comandos')
  const meta = await orchestrator.store.createSession({ projectId: project.id, cwd: projectDir, mode: 'code', providerId: 'ollama', model: 'qualquer', title: 'Comandos' })
  return { orchestrator, sessionId: meta.id }
}

describe('slash commands before the model', () => {
  it('expands a bundled command with its tools, and @files of the project', async () => {
    const { orchestrator, sessionId } = await boot()
    fs.writeFileSync(path.join(projectDir, 'notas.md'), 'texto das notas')
    const result = orchestrator.expandSlash(sessionId, '/revisar só o @notas.md')
    expect(result.text).toContain('Revise a mudança atual')
    expect(result.text).toContain('<arquivo path="notas.md">\ntexto das notas\n</arquivo>')
    expect(result.allowedTools).toContain('git_diff')
    expect(result.allowedTools).not.toContain('run_command')
  })

  it('lets a project command replace the bundled one of the same name', async () => {
    const { orchestrator, sessionId } = await boot()
    fs.mkdirSync(path.join(projectDir, '.openclod', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.openclod', 'commands', 'commit.md'), 'commit do projeto: $ARGUMENTS')
    expect(orchestrator.expandSlash(sessionId, '/commit rápido')).toEqual({ text: 'commit do projeto: rápido' })
    expect(orchestrator.commandsFor(projectDir).find((command) => command.name === 'commit')?.source).toBe('projeto')
  })

  it('turns /skill into a request for that skill', async () => {
    const { orchestrator, sessionId } = await boot()
    const skills = path.join(dir, 'skills-extra', 'docx')
    fs.mkdirSync(skills, { recursive: true })
    fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: docx\ndescription: Documentos Word\n---\nReceita.')
    orchestrator.skills.addRoot(path.dirname(skills), 'usuario')
    await orchestrator.skills.reload()
    expect(orchestrator.expandSlash(sessionId, '/docx relatório mensal').text).toBe('Use a skill "docx" para esta tarefa: relatório mensal')
  })

  it('refuses an unknown /word instead of sending it, and leaves paths and plain text alone', async () => {
    const { orchestrator, sessionId } = await boot()
    expect(() => orchestrator.expandSlash(sessionId, '/naoexiste agora')).toThrow(/comando desconhecido: \/naoexiste.*\/commit/s)
    expect(orchestrator.expandSlash(sessionId, '/usr/bin/python não roda')).toEqual({ text: '/usr/bin/python não roda' })
    expect(orchestrator.expandSlash(sessionId, 'oi')).toEqual({ text: 'oi' })
    await expect(orchestrator.startSend(sessionId, '/naoexiste')).rejects.toThrow(/comando desconhecido/)
  })
})
