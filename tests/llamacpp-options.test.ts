import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { serverArgs } from '../src/core/llamacpp/args'
import { BLOCKED, OptionError, blockedFlags, commandLine, optionArgs, optionGroups, parseHelp, splitExtra } from '../src/core/llamacpp/options'

// The real `llama-server --help` of the bundled build (b11972).
const help = fs.readFileSync(path.join(__dirname, 'fixtures', 'llamacpp-help-b11972.txt'), 'utf8')
const options = parseHelp(help)
const byKey = new Map(options.map((option) => [option.key, option]))

describe('llama-server --help', () => {
  it('reads every option of b11972 once, by its first long name', () => {
    expect(options.length).toBeGreaterThan(200)
    expect(new Set(options.map((option) => option.key)).size).toBe(options.length)
    expect(byKey.get('--gpu-layers')).toMatchObject({ flags: ['-ngl', '--gpu-layers', '--n-gpu-layers'], value: 'N', kind: 'number', env: 'LLAMA_ARG_N_GPU_LAYERS' })
    expect(byKey.has('--help')).toBe(false)
  })

  it('takes each field type from the help format', () => {
    expect(byKey.get('--flash-attn')).toMatchObject({ kind: 'choice', choices: ['on', 'off', 'auto'], default: 'auto' })
    expect(byKey.get('--cache-type-k')).toMatchObject({ kind: 'choice', default: 'f16' })
    expect(byKey.get('--cache-type-k')?.choices).toContain('q8_0')
    expect(byKey.get('--split-mode')).toMatchObject({ kind: 'choice', choices: ['none', 'layer', 'row', 'tensor'] })
    expect(byKey.get('--models-autoload')).toMatchObject({ kind: 'tri', on: '--models-autoload', off: '--no-models-autoload' })
    expect(byKey.get('--chat-template-file')?.kind).toBe('file')
    expect(byKey.get('--slot-save-path')?.kind).toBe('dir')
    expect(byKey.get('--reasoning-effort')?.choices).toContain('high')
  })

  it('groups the options for the screen, with Portuguese labels, and never offers the blocked ones', () => {
    const groups = optionGroups(options)
    expect(groups[0]).toMatchObject({ id: 'modelo', name: 'Modelo' })
    const fields = groups.flatMap((group) => group.fields)
    const gpu = groups.find((group) => group.id === 'gpu')
    expect(gpu?.fields[0]).toMatchObject({ key: '--gpu-layers', label: 'Camadas na GPU', curated: true })
    for (const key of ['--host', '--port', '--api-key', '--model', '--connect', '--tools', '--agent', '--path', '--media-path', '--hf-repo', '--models-dir']) {
      expect(fields.some((field) => field.key === key)).toBe(false)
    }
    // Presets that download weights stay out too.
    expect(fields.some((field) => /-(default|spec)$/.test(field.key))).toBe(false)
  })
})

describe('the options screen values → command line', () => {
  it('builds flags by kind and leaves defaults out', () => {
    expect(
      optionArgs(
        { '--gpu-layers': '28', '--flash-attn': 'on', '--cache-type-k': 'q8_0', '--kv-offload': 'off', '--top-k': '', '--threads': null, '--kv-unified': 'on' },
        options
      )
    ).toEqual(['--gpu-layers', '28', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--no-kv-offload', '--kv-unified'])
  })

  it('refuses unknown options, blocked ones and values in the wrong format, in Portuguese', () => {
    expect(() => optionArgs({ '--not-a-flag': '1' }, options)).toThrow(/não existe nesta versão/)
    expect(() => optionArgs({ '--host': '0.0.0.0' }, options)).toThrow(/controlada pelo Openclod/)
    expect(() => optionArgs({ '--connect': true }, options)).toThrow(OptionError)
    expect(() => optionArgs({ '--flash-attn': 'maybe' }, options)).toThrow(/aceita só/)
    expect(() => optionArgs({ '--threads': 'many' }, options)).toThrow(/precisa de um número/)
    expect(optionArgs({ '--gpu-layers': 'all', '--tensor-split': '3,1' }, options)).toEqual(['--gpu-layers', 'all', '--tensor-split', '3,1'])
  })

  it('blocks every spelling of a blocked option in the extra arguments', () => {
    const blocked = blockedFlags(options)
    for (const flag of ['-hf', '-hfr', '--hf-repo', '-mu', '--host', '--no-agent', '-ag', '--connect']) expect(blocked.has(flag)).toBe(true)
    for (const key of BLOCKED) expect(blocked.has(key)).toBe(true)
    const args = serverArgs(
      { model: 'C:\\m\\a.gguf', extraArgs: ['-hf', 'someone/model', '--host=0.0.0.0', '-ag', '--temp', '0.6'] },
      { port: 5000, optionArgs: optionArgs({ '--flash-attn': 'on' }, options), blocked }
    )
    expect(args.filter((arg) => arg === '--host')).toHaveLength(1)
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1')
    expect(args).not.toContain('-hf')
    expect(args).not.toContain('someone/model')
    expect(args).not.toContain('-ag')
    expect(args.slice(-4)).toEqual(['--flash-attn', 'on', '--temp', '0.6'])
  })

  it('splits extra arguments like a terminal, without a shell', () => {
    expect(splitExtra('--temp 0.7  --chat-template-kwargs "{\\"a\\": 1}" --system-prompt \'oi mundo\'')).toEqual([
      '--temp',
      '0.7',
      '--chat-template-kwargs',
      '{\\a\\: 1}',
      '--system-prompt',
      'oi mundo'
    ])
    expect(splitExtra('--x ""')).toEqual(['--x', ''])
    expect(() => splitExtra('--x "open')).toThrow(/aspas abertas/)
  })

  it('shows the command line with quotes where needed', () => {
    expect(commandLine('C:\\Program Files\\llama-server.exe', ['--model', 'C:\\m\\a b.gguf', '--port', '1'])).toBe('"C:\\Program Files\\llama-server.exe" --model "C:\\m\\a b.gguf" --port 1')
  })
})
