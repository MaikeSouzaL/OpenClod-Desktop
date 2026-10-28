import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// start() kills stale native hosts with taskkill; a test must never touch the user's real Chrome connection.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  // The callback must still run: start() awaits taskkill's completion.
  const execFile = vi.fn((_command: string, _args: unknown, _options: unknown, callback?: (error: null, stdout: string, stderr: string) => void) => {
    callback?.(null, '', '')
    return { on: vi.fn() }
  })
  return { ...actual, execFile }
})

import { ChromeBridge } from '../src/main/chrome/bridge'

let dir = ''
let bridge: ChromeBridge
let base = ''

async function post(message: unknown): Promise<number> {
  const response = await fetch(`${base}&path=from-extension`, { method: 'POST', body: JSON.stringify(message) })
  return response.status
}

/** What the native host does: long-polls the app and gets the queued commands. */
async function poll(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}&path=to-extension&wait_ms=5000`)
  return (await response.json()) as Array<Record<string, unknown>>
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-bridge-'))
  bridge = new ChromeBridge(dir)
  bridge.appVersion = '9.9.9'
  await bridge.start()
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'chrome-bridge', 'bridge.json'), 'utf8')) as { port: number; token: string }
  base = `http://127.0.0.1:${config.port}/?token=${config.token}`
})

afterEach(async () => {
  await bridge.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ChromeBridge', () => {
  it('rejects requests without the token', async () => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'chrome-bridge', 'bridge.json'), 'utf8')) as { port: number }
    const response = await fetch(`http://127.0.0.1:${config.port}/?path=to-extension`)
    expect(response.status).toBe(403)
  })

  it('answers hello and heartbeat with a single hello_ack so the extension knows the app is up', async () => {
    expect(bridge.isAttached()).toBe(false)
    await post({ type: 'hello', browser: 'Chrome/130', version: '0.2.0' })
    expect(bridge.isAttached()).toBe(true)
    expect(bridge.version).toBe('0.2.0')

    // Several heartbeats while nobody polls must not pile up acknowledgements.
    await post({ type: 'heartbeat' })
    await post({ type: 'heartbeat' })
    const messages = await poll()
    expect(messages.filter((message) => message.type === 'hello_ack')).toEqual([{ type: 'hello_ack', appVersion: '9.9.9' }])
  })

  it('tells the app when the user presses Stop in Chrome', async () => {
    const stopped: string[] = []
    bridge.onStop((sessionId) => stopped.push(sessionId))
    await post({ type: 'stop', sessionId: 'ses_a' })
    await post({ type: 'stop' }) // no session: ignored
    expect(stopped).toEqual(['ses_a'])
  })

  it('is not hurt by a listener that throws', async () => {
    bridge.onStop(() => {
      throw new Error('boom')
    })
    expect(await post({ type: 'stop', sessionId: 'ses_a' })).toBe(204)
    expect(await post({ type: 'hello', version: '0.2.0' })).toBe(204)
  })

  it('collects the page console through the extension and keeps it for the synchronous readers', async () => {
    await post({ type: 'hello', version: '0.2.0' })
    expect(bridge.consoleEntries('ses_a')).toEqual([])

    const pending = bridge.refreshConsole({ sessionId: 'ses_a', groupName: 'Openclod · ses_a' })
    const commands = (await poll()).filter((command) => command.type === 'console')
    expect(commands).toHaveLength(1)
    await post({
      id: commands[0].id,
      type: 'result',
      result: { installed: true, entries: [{ type: 'error', text: 'quebrou', ts: 1 }], errors: ['404 GET https://x.test/a'] }
    })
    await pending

    expect(bridge.consoleEntries('ses_a')).toEqual([{ type: 'error', text: 'quebrou', ts: 1 }])
    expect(bridge.errors('ses_a')).toEqual(['404 GET https://x.test/a'])
    expect(bridge.consoleEntries('ses_other')).toEqual([])
  })
})
