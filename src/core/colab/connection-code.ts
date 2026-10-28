import { createHash } from 'node:crypto'

/**
 * The connection code the Colab notebook prints at the end (resources/colab/openclod_llm_server.py, `make_connection_code`):
 *
 *   OCLC1.<payload>.<check>      payload = compact JSON in base64url (no padding); check = first 8 hex of SHA-256(payload text)
 *
 * It carries the access key, so it is a secret: it is shown in the notebook, pasted once, and never logged. The check only
 * catches a truncated or mistyped paste; it is not a signature, so the app always asks the user to confirm host, model and
 * GPU before connecting (a code that points at somebody else's server would send the conversations there).
 */

export const COLAB_CODE_PREFIX = 'OCLC1'
/** Version of the notebook this build ships; must equal NOTEBOOK_VERSION in the Python module (a test checks). */
export const COLAB_NOTEBOOK_VERSION = '1.2.0'
/** Oldest notebook this build still talks to. */
export const COLAB_MIN_NOTEBOOK_VERSION = '1.0.0'
/** Colab ends a session after at most 12 h (24 h on Pro+); a code older than that is almost surely dead. */
export const COLAB_CODE_STALE_MS = 12 * 3_600_000

export type ColabHostKind = 'trycloudflare' | 'loopback' | 'other'

/** What a valid code says, already normalized. */
export interface ColabConnection {
  /** `https://<host>/v1`, no trailing slash. */
  baseUrl: string
  host: string
  hostKind: ColabHostKind
  apiKey: string
  model: string
  gpu: string
  vramMiB?: number
  vision: boolean
  tools: boolean
  contextWindow: number
  engine?: string
  notebookVersion: string
  /** Epoch ms when the notebook made the code. */
  createdAt?: number
  /** 12 hex of the SHA-256 of the notebook's server module. */
  moduleHash?: string
}

export type ColabCodeResult = { ok: true; connection: ColabConnection; warnings: string[] } | { ok: false; error: string }

const INVISIBLE = /[\s​‌‍⁠﻿]+/g
const CODE_SHAPE = /OCLC1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8})/
const DEFAULT_CONTEXT = 32_768

export function colabCodeCheck(payload: string): string {
  return createHash('sha256').update(payload, 'ascii').digest('hex').slice(0, 8)
}

/** Compact JSON with sorted keys, the same bytes as the Python side (`sort_keys=True, separators=(",", ":")`). */
function compactJson(value: Record<string, unknown>): string {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(Object.fromEntries(entries))
}

export function encodeColabCode(connection: Pick<ColabConnection, 'baseUrl' | 'apiKey' | 'model'> & Partial<ColabConnection>): string {
  const body = compactJson({
    v: 1,
    nb: connection.notebookVersion,
    u: connection.baseUrl,
    k: connection.apiKey,
    m: connection.model,
    g: connection.gpu,
    vm: connection.vramMiB,
    vi: connection.vision === undefined ? undefined : connection.vision ? 1 : 0,
    tl: connection.tools === undefined ? undefined : connection.tools ? 1 : 0,
    c: connection.contextWindow,
    e: connection.engine,
    t: connection.createdAt === undefined ? undefined : Math.floor(connection.createdAt / 1000),
    sh: connection.moduleHash
  })
  const payload = Buffer.from(body, 'utf8').toString('base64url')
  return `${COLAB_CODE_PREFIX}.${payload}.${colabCodeCheck(payload)}`
}

/** `1.2.3` style comparison; missing or non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  return 0
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
}

/** Validates the address in a code. https only (http just for this computer, used by tests), no credentials, `/v1` or nothing as path. */
export function normalizeColabUrl(raw: unknown): { ok: true; baseUrl: string; host: string; hostKind: ColabHostKind } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) return { ok: false, error: 'O código não traz um endereço válido.' }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'O endereço do código não é uma URL válida.' }
  }
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'O endereço precisa ser https:// (http só é aceito para este próprio computador).' }
  }
  if (url.username || url.password) return { ok: false, error: 'O endereço do código não pode conter usuário ou senha.' }
  if (url.search || url.hash) return { ok: false, error: 'O endereço do código tem parâmetros inesperados.' }
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== '/v1') return { ok: false, error: `O endereço do código tem um caminho inesperado (${path}).` }
  if (!loopback && (isIpLiteral(url.hostname) || !url.hostname.includes('.'))) {
    return { ok: false, error: 'O endereço do código precisa ser um nome de site (como o túnel do Colab), não um número de IP.' }
  }
  const hostKind: ColabHostKind = loopback ? 'loopback' : /\.trycloudflare\.com$/i.test(url.hostname) ? 'trycloudflare' : 'other'
  return { ok: true, baseUrl: `${url.origin}/v1`, host: url.host, hostKind }
}

function text(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * Reads what the user pasted. Tolerates spaces, line breaks (a wrapped paste) and text around the code; refuses a code that is
 * incomplete, altered, from another format version or points somewhere that cannot be the notebook's tunnel.
 */
export function decodeColabCode(pasted: string, now = Date.now()): ColabCodeResult {
  const cleaned = String(pasted ?? '').replace(INVISIBLE, '')
  const match = CODE_SHAPE.exec(cleaned)
  if (!match) {
    // It starts like a code but lacks the check at the end: the paste was cut short.
    if (new RegExp(`${COLAB_CODE_PREFIX}\\.[A-Za-z0-9_-]{8,}`).test(cleaned)) {
      return { ok: false, error: 'O código está incompleto: faltou o final. Copie a linha inteira, do OCLC1. até o último caractere.' }
    }
    return { ok: false, error: `Isto não parece um código de conexão do Openclod (ele começa com ${COLAB_CODE_PREFIX}.). Copie o código inteiro do final do notebook.` }
  }
  const [, payload, check] = match
  if (colabCodeCheck(payload) !== check) {
    return { ok: false, error: 'O código está incompleto ou foi alterado (a verificação não confere). Copie de novo, inteiro.' }
  }
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    data = parsed as Record<string, unknown>
  } catch {
    return { ok: false, error: 'O código não pôde ser lido (conteúdo corrompido).' }
  }
  if (data.v !== 1) return { ok: false, error: 'Versão do código de conexão não suportada: gere de novo com o notebook mais recente.' }

  const address = normalizeColabUrl(data.u)
  if (!address.ok) return { ok: false, error: address.error }

  const apiKey = typeof data.k === 'string' ? data.k.trim() : ''
  if (!/^[\x21-\x7e]{8,512}$/.test(apiKey)) return { ok: false, error: 'O código não traz uma chave de acesso válida.' }
  const model = typeof data.m === 'string' ? data.m.trim() : ''
  if (!/^[A-Za-z0-9._:/@+-]{1,160}$/.test(model)) return { ok: false, error: 'O código não traz um nome de modelo válido.' }
  const notebookVersion = text(data.nb, 24)
  if (!/^\d+(\.\d+){0,3}$/.test(notebookVersion)) return { ok: false, error: 'O código não informa a versão do notebook: gere de novo com o notebook do Openclod.' }
  if (compareVersions(notebookVersion, COLAB_MIN_NOTEBOOK_VERSION) < 0) {
    return { ok: false, error: `O notebook que gerou este código é antigo (${notebookVersion}). Abra o Colab pelo botão do Openclod para obter o notebook atual (${COLAB_NOTEBOOK_VERSION}).` }
  }

  const warnings: string[] = []
  const contextWindow = positive(data.c)
  if (!contextWindow) warnings.push(`O código não informa a janela de contexto; usando ${DEFAULT_CONTEXT.toLocaleString('pt-BR')} tokens até o servidor responder.`)
  const createdAt = positive(data.t) ? Number(data.t) * 1000 : undefined
  if (createdAt && now - createdAt > COLAB_CODE_STALE_MS) {
    warnings.push('Este código tem mais de 12 horas: a sessão do Colab que o gerou provavelmente já terminou. Rode o notebook de novo se a conexão falhar.')
  }
  if (address.hostKind === 'other') {
    warnings.push(`O endereço (${address.host}) não é um túnel do Colab (*.trycloudflare.com). Só continue se foi você que montou este servidor.`)
  }
  if (address.hostKind === 'loopback') warnings.push('O endereço é este próprio computador (modo de teste).')

  return {
    ok: true,
    warnings,
    connection: {
      baseUrl: address.baseUrl,
      host: address.host,
      hostKind: address.hostKind,
      apiKey,
      model,
      gpu: text(data.g, 120),
      vramMiB: positive(data.vm),
      vision: data.vi === 1 || data.vi === true,
      tools: data.tl === 1 || data.tl === true || data.tl === undefined,
      contextWindow: contextWindow ?? DEFAULT_CONTEXT,
      engine: text(data.e, 60) || undefined,
      notebookVersion,
      createdAt,
      moduleHash: /^[0-9a-f]{12}$/.test(text(data.sh, 12)) ? text(data.sh, 12) : undefined
    }
  }
}
