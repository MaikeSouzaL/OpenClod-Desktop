import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeChild extends EventEmitter {
  pid: number
  command: string
  args: string[]
  stdout: EventEmitter
  stderr: EventEmitter
  kill: () => void
}

const fake = vi.hoisted(() => ({ spawned: [] as unknown[], nextPid: 4000 }))

// Real processes are not started: the python bridge and PowerShell are fakes that the test closes by hand, and
// taskkill ends its victim with exit code 1, exactly like the real one does.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        pid: fake.nextPid++,
        command,
        args,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => undefined
      }) as FakeChild
      fake.spawned.push(child)
      if (command === 'taskkill') {
        const victim = (fake.spawned as FakeChild[]).find((item) => String(item.pid) === args[1])
        setImmediate(() => victim?.emit('close', 1))
      }
      return child
    })
  }
})

const { TtsService } = await import('../src/main/tts')

const spawned = (): FakeChild[] => fake.spawned as FakeChild[]
const synths = (): FakeChild[] => spawned().filter((child) => child.args.includes('--synthesize'))
const windowsVoices = (): FakeChild[] => spawned().filter((child) => /powershell/i.test(child.command))

/** The bridge wrote an MP3 and exited 0. */
function finishSynthesis(child: FakeChild): void {
  fs.writeFileSync(child.args[child.args.length - 1], Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]))
  child.emit('close', 0)
}

function service(): { tts: InstanceType<typeof TtsService>; logs: string[] } {
  const logs: string[] = []
  const tts = new TtsService({ emit: () => undefined, log: (scope, message) => logs.push(`${scope}: ${String(message)}`) })
  return { tts, logs }
}

afterEach(() => {
  fake.spawned.length = 0
})

/**
 * The log of the user's app showed "Edge Neural TTS falhou: motor neural terminou com código 1" twice, 24 s apart,
 * with nothing on stderr: the neural voice was not failing, a second click on the button killed the synthesis that
 * was still being made (taskkill ends the process with code 1) and the old request then fell back to the Windows
 * voice, which read the answer the user had just replaced.
 */
describe('a voice request replaced or stopped while the neural voice is being made', () => {
  it('is cancelled, with no Windows voice, and the newer request finishes normally', async () => {
    const { tts, logs } = service()
    const first = tts.speak({ text: 'primeira resposta', provider: 'edge' })
    expect(synths()).toHaveLength(1)
    const second = tts.speak({ text: 'segunda resposta', provider: 'edge' })
    expect(synths()).toHaveLength(2)

    expect(await first).toEqual({ provider: 'edge', cancelled: true })
    finishSynthesis(synths()[1])
    const result = await second
    expect(result).toMatchObject({ provider: 'edge', mediaType: 'audio/mpeg' })
    expect(result.audioBase64).toBeTruthy()
    expect(windowsVoices()).toHaveLength(0)
    expect(logs.join('\n')).not.toContain('Edge Neural TTS falhou')
    expect(tts.status().phase).toBe('idle')
  })

  it('keeps the newer request reachable by stop() when the cancelled one ends late', async () => {
    const { tts } = service()
    const first = tts.speak({ text: 'primeira resposta', provider: 'edge' })
    const second = tts.speak({ text: 'segunda resposta', provider: 'edge' })
    await first
    // The cancelled request has finished; the process of the newer one must still be the one stop() ends.
    expect(tts.stop()).toBe(true)
    const kills = spawned().filter((child) => child.command === 'taskkill')
    expect(kills.at(-1)?.args).toContain(String(synths()[1].pid))
    expect(await second).toEqual({ provider: 'edge', cancelled: true })
  })

  it('stop() while the voice is being made cancels it without the Windows fallback', async () => {
    const { tts } = service()
    const pending = tts.speak({ text: 'uma resposta', provider: 'edge' })
    expect(tts.stop()).toBe(true)
    expect(await pending).toEqual({ provider: 'edge', cancelled: true })
    expect(windowsVoices()).toHaveLength(0)
    expect(tts.status().phase).toBe('idle')
  })

  it('still falls back to the Windows voice when the neural voice really fails', async () => {
    const { tts, logs } = service()
    const pending = tts.speak({ text: 'uma resposta', provider: 'edge' })
    synths()[0].stderr.emit('data', Buffer.from('ConnectionError: sem rede'))
    synths()[0].emit('close', 1)
    const result = await pending
    expect(result).toMatchObject({ provider: 'windows' })
    expect(result.fallbackReason).toContain('sem rede')
    expect(windowsVoices()).toHaveLength(1)
    expect(logs.join('\n')).toContain('Edge Neural TTS falhou')
    tts.dispose()
  })
})
