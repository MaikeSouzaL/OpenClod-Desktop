import { describe, expect, it } from 'vitest'
import {
  COLAB_CODE_STALE_MS,
  COLAB_MIN_NOTEBOOK_VERSION,
  COLAB_NOTEBOOK_VERSION,
  colabCodeCheck,
  compareVersions,
  decodeColabCode,
  encodeColabCode,
  normalizeColabUrl,
  type ColabConnection
} from '../src/core/colab/connection-code'
import { SERVER_MODULE, findPython, moduleJson, runPython } from './support/colab-python'
import fs from 'node:fs'

/**
 * The connection code is the only thing that carries the access key out of the notebook. These tests pin the format both
 * sides share (Python makes it, TypeScript reads it), the ways a paste goes wrong, and the checks that stop a code that points
 * somewhere it should not.
 */
const NOW = Date.UTC(2026, 9, 27, 18, 0, 0)

const SAMPLE: Pick<ColabConnection, 'baseUrl' | 'apiKey' | 'model'> & Partial<ColabConnection> = {
  baseUrl: 'https://um-dois-tres-quatro.trycloudflare.com/v1',
  apiKey: 'occ_Abc123-xyz_789',
  model: 'qwen3.5:9b-q8_0',
  gpu: 'Tesla T4 (15 GB)',
  vramMiB: 15360,
  vision: true,
  tools: true,
  contextWindow: 65536,
  engine: 'ollama 0.40.11',
  notebookVersion: '1.0.0',
  createdAt: NOW - 60_000,
  moduleHash: 'abcdef012345'
}

function ok(code: string, now = NOW): ColabConnection {
  const result = decodeColabCode(code, now)
  if (!result.ok) throw new Error(result.error)
  return result.connection
}

function error(code: string, now = NOW): string {
  const result = decodeColabCode(code, now)
  if (result.ok) throw new Error('era para recusar')
  return result.error
}

describe('connection code: round trip and paste tolerance', () => {
  it('decodes what it encodes', () => {
    const code = encodeColabCode(SAMPLE)
    expect(code.startsWith('OCLC1.')).toBe(true)
    const decoded = ok(code)
    expect(decoded).toMatchObject({
      baseUrl: 'https://um-dois-tres-quatro.trycloudflare.com/v1',
      host: 'um-dois-tres-quatro.trycloudflare.com',
      hostKind: 'trycloudflare',
      apiKey: 'occ_Abc123-xyz_789',
      model: 'qwen3.5:9b-q8_0',
      gpu: 'Tesla T4 (15 GB)',
      vramMiB: 15360,
      vision: true,
      tools: true,
      contextWindow: 65536,
      notebookVersion: '1.0.0',
      moduleHash: 'abcdef012345'
    })
    expect(decoded.createdAt).toBe(Math.floor((NOW - 60_000) / 1000) * 1000)
  })

  it('is short enough to copy by hand', () => {
    expect(encodeColabCode(SAMPLE).length).toBeLessThan(420)
  })

  it('survives spaces, wrapped lines, invisible characters and text around it', () => {
    const code = encodeColabCode(SAMPLE)
    const wrapped = code.match(/.{1,48}/g)!.join('\n')
    for (const pasted of [
      `  ${code}  `,
      wrapped,
      wrapped.replace(/\n/g, '\r\n'),
      `Código de conexão: ${code} (copie tudo)`,
      `﻿${code}​`,
      `"${code}"`,
      `\`${code}\``
    ]) {
      expect(ok(pasted).model).toBe('qwen3.5:9b-q8_0')
    }
  })

  it('detects a truncated or altered paste', () => {
    const code = encodeColabCode(SAMPLE)
    const [head, payload, check] = code.split('.')
    const changed = payload.slice(0, 12) + (payload[12] === 'A' ? 'B' : 'A') + payload.slice(13)
    // Cut at the end (the check is gone): "faltou o final". Altered or cut in the middle: the check does not match.
    expect(error(code.slice(0, -3))).toMatch(/incompleto: faltou o final/)
    for (const broken of [`${head}.${changed}.${check}`, `${head}.${payload}.00000000`, `${head}.${payload.slice(0, 40)}.${check}`]) {
      expect(error(broken)).toMatch(/incompleto ou foi alterado/)
    }
  })

  it('refuses things that are not a code', () => {
    for (const text of ['', '   ', 'olá', 'occ_apenasachave', 'OCLC1.', 'OCLC2.abc.12345678']) {
      expect(error(text)).toMatch(/não parece um código/)
    }
  })

  it('refuses another format version and a malformed payload', () => {
    const encode = (value: unknown): string => {
      const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
      return `OCLC1.${payload}.${colabCodeCheck(payload)}`
    }
    expect(error(encode({ v: 2, u: 'https://a.b.com/v1', k: 'k'.repeat(10), m: 'x', nb: '1.0.0' }))).toMatch(/Versão do código/)
    expect(error(encode(['lista']))).toMatch(/não pôde ser lido/)
    const garbage = Buffer.from('isso não é json', 'utf8').toString('base64url')
    expect(error(`OCLC1.${garbage}.${colabCodeCheck(garbage)}`)).toMatch(/não pôde ser lido/)
  })
})

describe('connection code: what a code may point at', () => {
  const withUrl = (baseUrl: string): string => encodeColabCode({ ...SAMPLE, baseUrl })

  it('normalizes the address to https://host/v1', () => {
    expect(ok(withUrl('https://abc.trycloudflare.com')).baseUrl).toBe('https://abc.trycloudflare.com/v1')
    expect(ok(withUrl('https://abc.trycloudflare.com/v1/')).baseUrl).toBe('https://abc.trycloudflare.com/v1')
  })

  it('refuses http for anything but this computer, IP numbers and hosts without a dot', () => {
    expect(error(withUrl('http://abc.trycloudflare.com/v1'))).toMatch(/https/)
    expect(error(withUrl('https://203.0.113.9/v1'))).toMatch(/nome de site/)
    expect(error(withUrl('https://servidor/v1'))).toMatch(/nome de site/)
    expect(error(withUrl('https://[2001:db8::1]/v1'))).toMatch(/nome de site/)
  })

  it('refuses credentials, parameters and other paths in the address', () => {
    expect(error(withUrl('https://user:pw@abc.trycloudflare.com/v1'))).toMatch(/usuário ou senha/)
    expect(error(withUrl('https://abc.trycloudflare.com/v1?x=1'))).toMatch(/parâmetros/)
    expect(error(withUrl('https://abc.trycloudflare.com/api/chat'))).toMatch(/caminho inesperado/)
  })

  it('refuses a missing or broken address', () => {
    expect(error(withUrl('isto não é uma url'))).toMatch(/não é uma URL/)
    expect(normalizeColabUrl(undefined).ok).toBe(false)
    expect(normalizeColabUrl('x'.repeat(400)).ok).toBe(false)
  })

  it('accepts this computer over http (the test mode) and says so', () => {
    const result = decodeColabCode(withUrl('http://127.0.0.1:8123/v1'), NOW)
    expect(result.ok && result.connection.hostKind).toBe('loopback')
    expect(result.ok && result.warnings.join(' ')).toMatch(/este próprio computador/)
  })

  it('warns when the host is not a Colab tunnel', () => {
    const result = decodeColabCode(withUrl('https://meu-servidor.exemplo.com/v1'), NOW)
    expect(result.ok && result.connection.hostKind).toBe('other')
    expect(result.ok && result.warnings.join(' ')).toMatch(/não é um túnel do Colab/)
  })

  it('has no warning for a fresh code from a tunnel', () => {
    const result = decodeColabCode(encodeColabCode(SAMPLE), NOW)
    expect(result.ok && result.warnings).toEqual([])
  })

  it('warns about a code from more than 12 hours ago', () => {
    const old = encodeColabCode({ ...SAMPLE, createdAt: NOW - COLAB_CODE_STALE_MS - 1000 })
    const result = decodeColabCode(old, NOW)
    expect(result.ok && result.warnings.join(' ')).toMatch(/mais de 12 horas/)
  })
})

describe('connection code: fields and versions', () => {
  it('requires a valid key, model and notebook version', () => {
    expect(error(encodeColabCode({ ...SAMPLE, apiKey: 'curta' }))).toMatch(/chave de acesso/)
    expect(error(encodeColabCode({ ...SAMPLE, apiKey: 'tem espaço no meio da chave' }))).toMatch(/chave de acesso/)
    expect(error(encodeColabCode({ ...SAMPLE, model: 'nome com espaço' }))).toMatch(/nome de modelo/)
    expect(error(encodeColabCode({ ...SAMPLE, notebookVersion: undefined }))).toMatch(/versão do notebook/)
    expect(error(encodeColabCode({ ...SAMPLE, notebookVersion: 'beta' }))).toMatch(/versão do notebook/)
  })

  it('refuses a notebook older than the minimum this build supports', () => {
    const [major] = (COLAB_MIN_NOTEBOOK_VERSION as string).split('.').map(Number)
    expect(major).toBeGreaterThan(0) // the first public version; raise the minimum together with a notebook that breaks the protocol
    expect(error(encodeColabCode({ ...SAMPLE, notebookVersion: `${major - 1}.9.9` }))).toMatch(/notebook que gerou este código é antigo/)
  })

  it('compares versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0', '1.9.9')).toBe(1)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })

  it('falls back to 32k with a warning when the context is missing; vision defaults to off, tools to on', () => {
    const result = decodeColabCode(encodeColabCode({ ...SAMPLE, contextWindow: undefined, vision: undefined, tools: undefined }), NOW)
    expect(result.ok && result.connection.contextWindow).toBe(32768)
    expect(result.ok && result.connection.vision).toBe(false)
    expect(result.ok && result.connection.tools).toBe(true)
    expect(result.ok && result.warnings.join(' ')).toMatch(/janela de contexto/)
  })

  it('keeps accents and symbols in the GPU label', () => {
    expect(ok(encodeColabCode({ ...SAMPLE, gpu: 'NVIDIA RTX PRO 6000 · 95,6 GB' })).gpu).toBe('NVIDIA RTX PRO 6000 · 95,6 GB')
  })

  it('ignores a malformed module hash instead of trusting it', () => {
    expect(ok(encodeColabCode({ ...SAMPLE, moduleHash: 'xyz' })).moduleHash).toBeUndefined()
  })
})

const python = findPython()
const withPython = python ? describe : describe.skip

withPython('connection code: the Python side and the TypeScript side agree', () => {
  it('the constants match', () => {
    const version = moduleJson<{ notebook: string; code_prefix: string }>(['version'])
    expect(version.notebook).toBe(COLAB_NOTEBOOK_VERSION)
    expect(version.code_prefix).toBe('OCLC1')
  })

  it('a code made by the notebook is read here', () => {
    const result = runPython([SERVER_MODULE, 'code', '--url', 'https://xyz-abc.trycloudflare.com/v1', '--key', 'occ_chave-de-teste-123', '--model', 'qwen3.8:27b-q4_K_M', '--gpu', 'NVIDIA L4 (22,5 GB)', '--ctx', '65536'])
    expect(result.status).toBe(0)
    const decoded = ok(result.stdout.trim(), Date.now())
    expect(decoded).toMatchObject({ apiKey: 'occ_chave-de-teste-123', model: 'qwen3.8:27b-q4_K_M', gpu: 'NVIDIA L4 (22,5 GB)', contextWindow: 65536, vision: true, tools: true, notebookVersion: COLAB_NOTEBOOK_VERSION })
    const expectedHash = moduleJson<{ hash: string }>(['version']).hash
    expect(decoded.moduleHash).toBe(expectedHash)
  })

  it('a code made here is read by the notebook, byte for byte the same text', () => {
    const connection = { ...SAMPLE, createdAt: 1_793_000_000_000 }
    const code = encodeColabCode(connection)
    const parsed = moduleJson<Record<string, unknown>>(['parse', code])
    expect(parsed).toMatchObject({ u: connection.baseUrl, k: connection.apiKey, m: connection.model, g: connection.gpu, c: 65536, vi: 1, tl: 1, nb: '1.0.0', sh: 'abcdef012345', t: 1_793_000_000, v: 1 })
    // Same JSON bytes: sorted keys, compact separators, UTF-8 (so the check value is identical too).
    const python = runPython(['-c', [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(SERVER_MODULE.replace(/[\\/][^\\/]+$/, ''))})`,
      'import openclod_llm_server as oc',
      `print(oc.make_connection_code(${JSON.stringify({ nb: '1.0.0', u: connection.baseUrl, k: connection.apiKey, m: connection.model, g: connection.gpu, vm: 15360, vi: 1, tl: 1, c: 65536, e: 'ollama 0.40.11', t: 1_793_000_000, sh: 'abcdef012345' })}))`
    ].join('\n')])
    expect(python.stdout.trim()).toBe(code)
  })

  it('the notebook also refuses a tampered paste', () => {
    const code = encodeColabCode(SAMPLE)
    const result = runPython([SERVER_MODULE, 'parse', `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`])
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout).error).toMatch(/incompleto ou foi alterado/)
  })

  it('the module hash is the SHA-256 of the file with normalized line endings', async () => {
    const { serverSourceHash } = await import('../src/core/colab/notebook')
    const hash = moduleJson<{ hash: string }>(['version']).hash
    expect(hash).toBe(serverSourceHash(fs.readFileSync(SERVER_MODULE, 'utf8')))
  })
})
