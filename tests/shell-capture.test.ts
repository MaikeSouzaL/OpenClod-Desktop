import { describe, expect, it } from 'vitest'
import { OutputCapture } from '../src/core/util/output-capture'
import { StreamDecoder, decodeLine } from '../src/core/util/oem-decode'
import { runShellCommand } from '../src/core/tools/shell'

describe('OutputCapture', () => {
  it('keeps everything while small', () => {
    const capture = new OutputCapture(10, 10)
    capture.push('abcd')
    capture.push('efgh')
    expect(capture.toString()).toBe('abcdefgh')
  })

  it('keeps the start and the END of a huge stream, saying how much was left out', () => {
    const capture = new OutputCapture(100, 200)
    for (let i = 0; i < 1000; i++) capture.push(`linha-${String(i).padStart(4, '0')}\n`)
    capture.push('RESULTADO FINAL: 3 falhas\n')
    const text = capture.toString()
    expect(text.startsWith('linha-0000')).toBe(true)
    expect(text.endsWith('RESULTADO FINAL: 3 falhas\n')).toBe(true)
    expect(text).toMatch(/\d+ caracteres omitidos/)
    expect(text.length).toBeLessThan(100 + 200 + 120)
  })

  it('does not break a multi-byte character split between two chunks', () => {
    const capture = new OutputCapture()
    const bytes = Buffer.from('ação', 'utf8') // á, ç and ã take two bytes each
    capture.push(bytes.subarray(0, 1))
    capture.push(bytes.subarray(1, 3))
    capture.push(bytes.subarray(3))
    const text = capture.toString()
    expect(text).toBe('ação')
    expect(text.includes('�')).toBe(false)
  })
})

describe('OEM-aware decoding (Windows consoles mix UTF-8 and the OEM code page)', () => {
  // "não ação" followed by CR LF, exactly as cmd.exe prints it in code page 850
  const cp850 = Buffer.from([0x6e, 0xc6, 0x6f, 0x20, 0x61, 0x87, 0xc6, 0x6f, 0x0d, 0x0a])

  it('decodes a CP850 line and leaves a valid UTF-8 line alone', () => {
    expect(decodeLine(cp850, 850)).toBe('não ação\r\n')
    expect(decodeLine(Buffer.from('não ação', 'utf8'), 850)).toBe('não ação')
    expect(decodeLine(Buffer.from([0x63, 0x61, 0x66, 0x82]), 437)).toBe('café')
  })

  it('handles a stream that mixes both encodings, split at arbitrary byte positions', () => {
    const decoder = new StreamDecoder(850)
    const input = Buffer.concat([cp850, Buffer.from('linha utf-8: ação\n', 'utf8'), Buffer.from('sem quebra final', 'utf8')])
    let out = ''
    for (let i = 0; i < input.length; i += 3) out += decoder.write(input.subarray(i, i + 3))
    out += decoder.end()
    expect(out).toBe('não ação\r\nlinha utf-8: ação\nsem quebra final')
  })

  it('is a plain UTF-8 decoder when there is no OEM page (non-Windows)', () => {
    const decoder = new StreamDecoder(undefined)
    const bytes = Buffer.from('ação', 'utf8')
    expect(decoder.write(bytes.subarray(0, 2)) + decoder.write(bytes.subarray(2)) + decoder.end()).toBe('ação')
  })
})

const run = (command: string, timeoutMs = 20_000, controller = new AbortController()) =>
  runShellCommand(command, process.cwd(), timeoutMs, 'ses_shell_capture', controller.signal)

describe('runShellCommand', () => {
  it('returns the last line of a command that prints far more than the buffer', async () => {
    const result = await run(`node -e "for(let i=0;i<30000;i++)console.log('linha '+i+' '+'x'.repeat(40)); console.log('ULTIMA-LINHA')"`)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('linha 0 ')
    expect(result.stdout.trimEnd().endsWith('ULTIMA-LINHA')).toBe(true)
    expect(result.stdout).toMatch(/caracteres omitidos/)
  }, 30_000)

  it('prints accents correctly from the shell itself and from node', async () => {
    const echoed = await run('echo ação çãõ')
    expect(echoed.stdout).toContain('ação çãõ')
    const node = await run(`node -e "console.log('ação çãõ')"`)
    expect(node.stdout).toContain('ação çãõ')
  })

  it('closes stdin, so a program that waits for input ends instead of hanging', async () => {
    const started = Date.now()
    const result = await run(`node -e "process.stdin.on('end',()=>console.log('EOF'));process.stdin.resume()"`, 15_000)
    expect(result.stdout).toContain('EOF')
    expect(result.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('answers soon after the timeout even when a detached grandchild keeps the pipes open', async () => {
    const started = Date.now()
    const command = `node -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},40000)'],{detached:true,stdio:'inherit'});setTimeout(()=>{},40000)"`
    const result = await run(command, 1_000)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(6_000)
  }, 15_000)
})

describe('run_command timeouts', () => {
  it('explains a silent timeout so the model does not just retry the same call', async () => {
    const { runCommandTool } = await import('../src/core/tools/shell')
    const { policy } = await import('./helpers')
    const ctx = {
      cwd: process.cwd(),
      sessionId: 'ses_shell_timeout',
      policy: policy({ shellTimeoutSec: 30 }),
      signal: new AbortController().signal,
      log: () => undefined,
      emit: () => undefined,
      progress: () => undefined,
      workspace: { resolve: (target: string) => target }
    } as never
    const result = await runCommandTool.execute({ command: 'node -e "setTimeout(() => {}, 20000)"', timeout_ms: 1000 }, ctx)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('TIMEOUT')
    expect(result.text).toMatch(/sem nenhuma saída/)
    expect(result.text).toMatch(/Não repita o mesmo comando/)
    expect(result.text).toContain('run_in_background=true')
  }, 20_000)
})
