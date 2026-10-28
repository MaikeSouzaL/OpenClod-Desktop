import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginManager, dependencySatisfied, validateManifest } from '../src/core/plugins/manager'
import { makeTempDir, removeTempDir } from './helpers'

describe('plugin manager', () => {
  let root: string
  let manager: PluginManager
  beforeEach(async () => { root = await makeTempDir('openclod-plugins-'); manager = new PluginManager(path.join(root, 'plugins')); await manager.init() })
  afterEach(async () => removeTempDir(root))

  function makePlugin(id: string, version = '1.0.0', dependencies?: Record<string, string>): string {
    const dir = path.join(root, 'sources', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      schemaVersion: 1, id, name: `Plugin ${id}`, version, description: 'Plugin de teste', apiVersion: '1.0',
      runtime: 'node', main: 'index.cjs', dependencies,
      contributions: { tools: [{ key: 'echo', name: 'Echo', description: 'Repete a mensagem', risk: 'read', inputSchema: { type: 'object' } }] }
    }))
    fs.writeFileSync(path.join(dir, 'index.cjs'), `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({ok:true,text:'echo '+r.args.message,summary:'echo'}))})`)
    return dir
  }

  it('installs, enables and executes a real subprocess tool', async () => {
    const source = makePlugin('echo-plugin')
    await manager.installDirectory(source)
    const disabled = manager.list()[0]
    expect(disabled).toMatchObject({ id: 'echo-plugin', installed: true, enabled: false })
    expect(manager.toolDefs()).toHaveLength(0)
    await manager.setEnabled('echo-plugin', true)
    expect(manager.toolDefs()[0].name).toBe('plugin__echo-plugin__echo')
    const result = await manager.runTool('echo-plugin', 'echo', { message: 'olá' })
    expect(result).toMatchObject({ ok: true, text: 'echo olá', summary: 'echo' })
  })

  it('validates dependencies and prevents unsafe update or removal', async () => {
    await manager.installDirectory(makePlugin('base', '1.2.0'))
    await manager.installDirectory(makePlugin('dependent', '1.0.0', { base: '>=1.0.0' }))
    await manager.setEnabled('base', true)
    await manager.setEnabled('dependent', true)
    await expect(manager.setEnabled('base', false)).rejects.toThrow(/dependentes ativos/)
    await manager.setEnabled('dependent', false)
    await manager.setEnabled('base', false)
    await expect(manager.remove('base')).rejects.toThrow(/dependentes instalados/)
    expect(dependencySatisfied('>=1.2.0', '1.3.0')).toBe(true)
    expect(dependencySatisfied('<1.2.0', '1.3.0')).toBe(false)
  })

  it('exposes skill roots only while the plugin is enabled', async () => {
    const source = makePlugin('skills-plugin')
    fs.mkdirSync(path.join(source, 'skills', 'review'), { recursive: true })
    fs.writeFileSync(path.join(source, 'skills', 'review', 'SKILL.md'), '---\nname: plugin-review\ndescription: Revisa código\n---\nRevise tudo.')
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'))
    manifest.contributions.skills = ['skills']
    fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest))
    await manager.installDirectory(source)
    expect(manager.skillRoots()).toEqual([])
    await manager.setEnabled('skills-plugin', true)
    expect(manager.skillRoots()).toHaveLength(1)
    expect(manager.skillRoots()[0]).toContain(path.join('plugins', 'skills-plugin', 'skills'))
  })

  it('preserves plugin data during update and removal', async () => {
    await manager.installDirectory(makePlugin('keeper', '1.0.0'))
    fs.mkdirSync(path.join(root, 'plugins', 'keeper', 'data'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plugins', 'keeper', 'data', 'config.json'), '{"token":"keep"}')
    await manager.installDirectory(makePlugin('keeper', '1.1.0'))
    expect(fs.readFileSync(path.join(root, 'plugins', 'keeper', 'data', 'config.json'), 'utf8')).toContain('keep')
    await manager.remove('keeper')
    const preserved = fs.readdirSync(path.join(root, 'plugins', '.data'))
    expect(preserved).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, 'plugins', '.data', preserved[0], 'config.json'), 'utf8')).toContain('keep')
  })

  it('rejects invalid manifests, duplicate ids and incompatible APIs', () => {
    expect(() => validateManifest({ schemaVersion: 1, id: 'x' })).toThrow()
    expect(() => validateManifest({
      schemaVersion: 1, id: 'valid-id', name: 'N', version: '1.0.0', description: 'D', apiVersion: '2.0', runtime: 'node', main: 'index.js', contributions: {}
    })).toThrow(/apiVersion/)
  })
})
