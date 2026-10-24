import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InboxStore } from '../src/main/inbox'

let root: string
let inbox: InboxStore

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-inbox-'))
  inbox = new InboxStore(root)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('durable session inbox', () => {
  it('persists queued prompts across instances', () => {
    const item = inbox.add('ses_1', { text: 'rode os testes', origin: 'ui' })
    expect(item.mode).toBe('queue')
    expect(item.origin).toBe('ui')

    const reopened = new InboxStore(root)
    const items = reopened.list('ses_1')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('rode os testes')
    expect(items[0].id).toBe(item.id)
  })

  it('keeps steer and queue separate and removes by id', () => {
    const steer = inbox.add('ses_1', { text: 'pare de mexer no CSS', mode: 'steer', origin: 'agent' })
    const queued = inbox.add('ses_1', { text: 'depois rode o build', mode: 'queue', origin: 'agent' })
    expect(inbox.list('ses_1').map((item) => item.mode)).toEqual(['steer', 'queue'])
    expect(inbox.remove('ses_1', steer.id)).toBe(true)
    expect(inbox.list('ses_1').map((item) => item.id)).toEqual([queued.id])
    expect(inbox.remove('ses_1', 'missing')).toBe(false)
  })

  it('clears a session without touching another one', () => {
    inbox.add('ses_1', { text: 'a' })
    inbox.add('ses_2', { text: 'b' })
    inbox.clear('ses_1')
    expect(inbox.list('ses_1')).toEqual([])
    expect(inbox.list('ses_2')).toHaveLength(1)
  })
})
