import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandCommand, loadCustomCommands, matchCustomCommand } from '../src/core/commands/library'
import { makeTempDir, removeTempDir } from './helpers'

let root: string
const write = (relative: string, content: string): void => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

beforeEach(async () => {
  root = await makeTempDir('openclod-commands-')
})
afterEach(async () => removeTempDir(root))

describe('custom slash commands', () => {
  it('loads templates with frontmatter, namespaces from subfolders, and lets project files win', () => {
    write('user/review.md', '---\ndescription: do usuário\n---\nRevise $ARGUMENTS (versão do usuário)')
    write('proj/review.md', '---\ndescription: Revisa um arquivo\nargument-hint: <arquivo>\n---\nRevise $ARGUMENTS com cuidado.')
    write('proj/frontend/Lint Fix.md', 'Rode o lint e corrija os avisos de $1.')
    write('proj/vazio.md', '   ')
    write('proj/notas.txt', 'ignorado')
    const commands = loadCustomCommands([
      { dir: path.join(root, 'user'), source: 'usuario' },
      { dir: path.join(root, 'proj'), source: 'projeto' }
    ])
    expect(commands.map((command) => command.name)).toEqual(['frontend:lint-fix', 'review'])
    const review = commands.find((command) => command.name === 'review')!
    expect(review).toMatchObject({ source: 'projeto', description: 'Revisa um arquivo', argumentHint: '<arquivo>' })
    expect(commands.find((command) => command.name === 'frontend:lint-fix')!.description).toBe('Rode o lint e corrija os avisos de $1.')
  })

  it('expands $ARGUMENTS and positional words, quotes included; appends arguments when the template ignores them', () => {
    write('c/deploy.md', 'Publique $1 em $2 (tudo: $ARGUMENTS)')
    write('c/plain.md', 'Faça a revisão final.')
    const [deploy, plain] = loadCustomCommands([{ dir: path.join(root, 'c'), source: 'projeto' }])
    expect(expandCommand(deploy, 'app "ambiente de teste"')).toBe('Publique app em ambiente de teste (tudo: app "ambiente de teste")')
    expect(expandCommand(plain, '')).toBe('Faça a revisão final.')
    expect(expandCommand(plain, 'só o backend')).toBe('Faça a revisão final.\n\nArgumentos: só o backend')
  })

  it('matches only real commands and keeps built-in or unknown slashes untouched', () => {
    write('c/review.md', 'Revise $ARGUMENTS')
    const commands = loadCustomCommands([{ dir: path.join(root, 'c'), source: 'projeto' }])
    expect(matchCustomCommand('/review src/a.ts', commands)).toMatchObject({ args: 'src/a.ts', command: { name: 'review' } })
    expect(matchCustomCommand('/REVIEW', commands)?.args).toBe('')
    expect(matchCustomCommand('/compactar', commands)).toBeNull()
    expect(matchCustomCommand('revise /review', commands)).toBeNull()
    expect(matchCustomCommand('/review\nlinha 2', commands)?.args).toBe('linha 2')
  })
})
