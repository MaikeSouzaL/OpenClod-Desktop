import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceGuard } from '../src/core/security/policy'
import { makeTempDir, removeTempDir } from './helpers'

let project: string
let outside: string

beforeEach(async () => {
  project = await makeTempDir('openclod-ws-in-')
  outside = await makeTempDir('openclod-ws-out-')
})
afterEach(async () => {
  await removeTempDir(project)
  await removeTempDir(outside)
})

/** Creating links needs a privilege on some Windows setups; the check is skipped (not faked) when it is missing. */
function tryLink(target: string, link: string, type: 'file' | 'junction' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, link, type)
    return true
  } catch {
    return false
  }
}

describe('WorkspaceGuard and links', () => {
  it('refuses a write path that goes through a link to a folder outside the project', (ctx) => {
    if (!tryLink(outside, path.join(project, 'atalho'), 'junction')) return ctx.skip()
    const guard = new WorkspaceGuard([project])
    expect(() => guard.resolve('atalho/novo.txt', project)).toThrow(/fora dos diretórios/)
    expect(() => guard.resolve('docs/novo.txt', project)).not.toThrow()
  })

  it('refuses a dangling file link whose target would be created outside the project', (ctx) => {
    const target = path.join(outside, 'ainda-nao-existe.txt')
    if (!tryLink(target, path.join(project, 'ponte.txt'), 'file')) return ctx.skip()
    const guard = new WorkspaceGuard([project])
    expect(() => guard.resolve('ponte.txt', project)).toThrow(/fora dos diretórios/)
  })

  it('still allows a link that stays inside the project', (ctx) => {
    fs.mkdirSync(path.join(project, 'real'))
    fs.writeFileSync(path.join(project, 'real', 'a.txt'), 'x')
    if (!tryLink(path.join(project, 'real'), path.join(project, 'apelido'), 'junction')) return ctx.skip()
    const guard = new WorkspaceGuard([project])
    expect(() => guard.resolve('apelido/a.txt', project)).not.toThrow()
  })
})
