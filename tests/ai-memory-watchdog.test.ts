import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { AiMemoryService } from '../src/main/ai-memory'

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

/** A /healthz that answers while `alive` is true and drops the connection after that (a hung sidecar, quickly). */
async function healthServer(state: { alive: boolean }): Promise<number> {
  const server = http.createServer((req, res) => {
    if (state.alive) res.end('ok')
    else req.socket.destroy()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('the AI-Memory watchdog', () => {
  it('restarts a sidecar that stopped answering, only after three missed checks in a row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-aimem-watch-'))
    const state = { alive: true }
    const port = await healthServer(state)
    const service = new AiMemoryService(dir, null)
    const inner = service as unknown as { server: { port: number; token: string } | null; start: () => Promise<void> }
    inner.server = { port, token: 't' }
    let restarts = 0
    inner.start = async () => {
      restarts++
      inner.server = { port, token: 't2' }
    }

    expect(await service.selfCheck()).toBe('ok')
    state.alive = false
    expect(await service.selfCheck()).toBe('missed')
    expect(await service.selfCheck()).toBe('missed')
    expect(restarts).toBe(0)
    expect(await service.selfCheck()).toBe('restarted')
    expect(restarts).toBe(1)

    // A sidecar that answers again resets the count.
    state.alive = true
    expect(await service.selfCheck()).toBe('ok')
    state.alive = false
    expect(await service.selfCheck()).toBe('missed')
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('does nothing while no sidecar is up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-aimem-watch-'))
    expect(await new AiMemoryService(dir, null).selfCheck()).toBe('idle')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stops a sidecar left by an earlier run that does not answer (it holds the serve lock)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-aimem-watch-'))
    const stale = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: 1, token: 't', pid: stale.pid }))
    const service = new AiMemoryService(dir, null)
    const exited = new Promise<boolean>((resolve) => stale.on('exit', () => resolve(true)))
    expect(await service.releaseStale({ pid: stale.pid })).toBe(true)
    expect(await Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))])).toBe(true)
    expect(fs.existsSync(path.join(dir, 'server.json'))).toBe(false)
    // Nothing to do for a pid that is gone.
    expect(await service.releaseStale({ pid: stale.pid })).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 20_000)
})
