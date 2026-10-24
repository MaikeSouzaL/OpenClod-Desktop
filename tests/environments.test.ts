import { describe, expect, it } from 'vitest'
import { environmentSpawn } from '../src/core/tools/shell'

describe('execution environments', () => {
  it('runs local commands in the project shell', () => {
    expect(environmentSpawn('npm test', 'C:\\projeto', { id: 'local', label: 'Local', kind: 'local' })).toEqual({
      file: 'npm test',
      args: [],
      shell: true
    })
  })

  it('routes WSL through wsl.exe with the Windows cwd and bash -lc', () => {
    const spec = environmentSpawn('pwd && ls', 'C:\\projeto', {
      id: 'wsl',
      label: 'WSL',
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect(spec).toEqual({
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', 'C:\\projeto', 'bash', '-lc', 'pwd && ls'],
      shell: false
    })
  })

  it('wraps SSH commands in a single-quoted remote shell string', () => {
    const spec = environmentSpawn('npm run build', 'C:\\projeto', {
      id: 'prod',
      label: 'Produção',
      kind: 'ssh',
      command: 'ssh deploy@host',
      remoteCwd: '/srv/app'
    })
    expect(spec.shell).toBe(true)
    expect(spec.file).toContain('ssh deploy@host')
    expect(spec.file).toContain('/srv/app')
    expect(spec.file).toContain('npm run build')
  })

  it('routes cloud profiles through their command prefix', () => {
    const spec = environmentSpawn('go test ./...', 'C:\\projeto', {
      id: 'cloud',
      label: 'Nuvem',
      kind: 'cloud',
      command: 'docker exec -i builder bash -lc',
      remoteCwd: '/workspace'
    })
    expect(spec.file).toContain('docker exec -i builder bash -lc')
    expect(spec.file).toContain('/workspace')
    expect(spec.file).toContain('go test ./...')
  })

  it('refuses an SSH/cloud profile without a command prefix', () => {
    expect(() =>
      environmentSpawn('ls', 'C:\\projeto', { id: 'broken', label: 'Broken', kind: 'ssh' })
    ).toThrow(/configure o comando/)
  })
})
