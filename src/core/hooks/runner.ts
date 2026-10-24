import { spawn } from 'node:child_process'
import type { HookCommand, HookDefinition, HookEvent, HookHttp, HooksConfig } from '../../shared/types.js'
import { sanitizedEnv } from '../security/policy.js'
import { toolAliases } from '../security/rules.js'
import { killTree } from '../tools/shell.js'

const DEFAULT_TIMEOUT_SEC = 60
const MAX_OUTPUT = 64_000
const MAX_URL_LENGTH = 2000
const MAX_HTTP_HEADERS = 20

/** Every event a hook may subscribe to; the settings sanitizer reuses this list. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Notification'
]

export interface HookRunResult {
  /** Shell command, or "POST <url without query>" for http hooks. */
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Present for http hooks: response status (null when no response arrived) and a network error, if any. */
  http?: { status: number | null; error?: string }
}

export interface HookOutcome {
  /** Exit code 2, `decision: "block"` or `permissionDecision: "deny"`. */
  blocked: boolean
  reason?: string
  permissionDecision?: 'allow' | 'deny' | 'ask'
  updatedInput?: Record<string, unknown>
  /** Text to add to the model context (UserPromptSubmit / SessionStart / PostToolUse). */
  additionalContext: string[]
  /** `continue: false` — stop the whole turn. */
  stop?: string
  /** Non-blocking failures worth showing to the user. */
  warnings: string[]
  results: HookRunResult[]
}

function emptyOutcome(): HookOutcome {
  return { blocked: false, additionalContext: [], warnings: [], results: [] }
}

/** Claude Code matchers are full-match regexes over the tool name ("Edit|Write"). */
export function matcherHits(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*' || !toolName) return true
  const names = toolAliases(toolName)
  try {
    const re = new RegExp(`^(?:${matcher})$`)
    return names.some((name) => re.test(name))
  } catch {
    return names.includes(matcher)
  }
}

/** Mirrors Claude Code field names so existing hook scripts keep working. */
export function claudeToolInput(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args
  const input = { ...(args as Record<string, unknown>) }
  if (typeof input.path === 'string' && input.file_path === undefined) input.file_path = input.path
  if (typeof input.timeout_ms === 'number' && input.timeout === undefined) input.timeout = input.timeout_ms
  return input
}

function runCommand(hook: HookCommand, payload: string, cwd: string, signal?: AbortSignal): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...sanitizedEnv(), FORJA_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd }
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, (hook.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000)
    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8')
    })
    const finish = (exitCode: number | null, extra = ''): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ command: hook.command, exitCode, stdout, stderr: stderr + extra, timedOut })
    }
    child.on('error', (err) => finish(-1, err.message))
    child.on('close', (code) => finish(code))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(payload)
  })
}

/** http(s) URLs only, no embedded credentials (fetch rejects them and they would leak in logs). */
function parseHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/** Shown in warnings and audit lines; the query string may carry a token, so it is dropped. */
function describeUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

/** Headers the runner owns; a hook cannot override them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection'])
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]{0,2000}$/

function cleanHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_HTTP_HEADERS)) {
    if (typeof value !== 'string' || !HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) continue
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue
    out[name] = value
  }
  return Object.keys(out).length ? out : undefined
}

function cleanTimeout(raw: unknown): number | undefined {
  const timeout = Number(raw)
  return timeout > 0 ? Math.min(600, timeout) : undefined
}

function parseHttpHook(raw: unknown): { hook: HookHttp; url: URL } | null {
  const h = raw as { type?: unknown; url?: unknown; timeout?: unknown; headers?: unknown } | null
  if (!h || h.type !== 'http') return null
  const url = parseHttpUrl(h.url)
  if (!url) return null
  return { hook: { type: 'http', url: url.toString(), timeout: cleanTimeout(h.timeout), headers: cleanHeaders(h.headers) }, url }
}

/**
 * Validates one hook entry coming from untrusted JSON (settings file or the
 * settings dialog) and returns the safe, size-capped shape, or null to drop it.
 */
export function normalizeHookDefinition(raw: unknown): HookDefinition | null {
  const h = raw as { type?: unknown; command?: unknown; timeout?: unknown } | null
  if (h?.type === 'command') {
    if (typeof h.command !== 'string' || !h.command.trim()) return null
    return { type: 'command', command: h.command.slice(0, 2000), timeout: cleanTimeout(h.timeout) }
  }
  return parseHttpHook(raw)?.hook ?? null
}

/** Reads at most `max` characters of the body, then drops the rest of the stream. */
async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < max) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return text.slice(0, max)
}

/**
 * POSTs the payload. Nothing from process.env is added to the request, and
 * redirects are not followed: a 307/308 would replay the payload (prompts,
 * tool inputs) to a host the user never configured.
 */
async function runHttp(hook: HookHttp, url: URL, payload: string, signal?: AbortSignal): Promise<HookRunResult> {
  const base: HookRunResult = { command: `POST ${describeUrl(url)}`, exitCode: null, stdout: '', stderr: '', timedOut: false }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, (hook.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000)
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(hook.headers ?? {})) headers.set(name, value)
    headers.set('content-type', 'application/json')
    if (!headers.has('user-agent')) headers.set('user-agent', 'Openclod-Hooks/1')
    const response = await fetch(url, { method: 'POST', headers, body: payload, redirect: 'manual', signal: controller.signal })
    const stdout = await readCapped(response, MAX_OUTPUT)
    return { ...base, exitCode: response.ok ? 0 : response.status, stdout, http: { status: response.status } }
  } catch (err) {
    if (timedOut) return { ...base, timedOut: true, http: { status: null } }
    if (signal?.aborted) return { ...base, http: { status: null, error: 'cancelado' } }
    const cause = (err as { cause?: { message?: string } }).cause?.message
    return { ...base, http: { status: null, error: cause || (err as Error).message || 'erro de rede' } }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

interface HookJson {
  decision?: string
  reason?: string
  continue?: boolean
  stopReason?: string
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    additionalContext?: string
  }
}

function parseJson(stdout: string): HookJson | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as HookJson
  } catch {
    return null
  }
}

const RANK = { allow: 0, ask: 1, deny: 2 } as const

/**
 * Runs lifecycle hooks configured in the Claude Code settings format. A hook
 * receives the event payload as JSON (stdin for command hooks, the request
 * body for http hooks). For commands, exit code 2 blocks and any other
 * non-zero code is a non-blocking error; for http hooks a non-2xx status or a
 * network failure is a non-blocking warning. Either way a JSON object in the
 * output can decide permissions, rewrite tool input or add context.
 */
export class HookRunner {
  constructor(
    private readonly config: HooksConfig,
    private readonly cwd: string,
    private readonly sessionId: string
  ) {}

  has(event: HookEvent, toolName?: string): boolean {
    return (this.config[event] ?? []).some((m) => m.hooks?.length && matcherHits(m.matcher, toolName))
  }

  /**
   * Fires an event that only notifies (SessionEnd, PostCompact...). Returns
   * null when no hook is configured, so callers can skip the reporting.
   */
  async notify(event: HookEvent, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<HookOutcome | null> {
    if (!this.has(event)) return null
    return this.run(event, payload, undefined, signal)
  }

  async run(
    event: HookEvent,
    payload: Record<string, unknown>,
    toolName?: string,
    signal?: AbortSignal
  ): Promise<HookOutcome> {
    const outcome = emptyOutcome()
    const hooks = (this.config[event] ?? [])
      .filter((m) => matcherHits(m.matcher, toolName))
      .flatMap((m) => m.hooks ?? [])
    const body = JSON.stringify({
      session_id: this.sessionId,
      cwd: this.cwd,
      hook_event_name: event,
      ...(toolName ? { tool_name: toolAliases(toolName)[1] ?? toolName, forja_tool_name: toolName } : {}),
      ...payload
    })

    // Project settings reach this point unsanitized, so every entry is checked here too.
    const runs: Array<Promise<HookRunResult>> = []
    for (const hook of hooks) {
      if (!hook || typeof hook !== 'object') continue
      if (hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim()) {
        runs.push(runCommand(hook, body, this.cwd, signal))
      } else if (hook.type === 'http') {
        const parsed = parseHttpHook(hook)
        if (parsed) runs.push(runHttp(parsed.hook, parsed.url, body, signal))
        else outcome.warnings.push(`hook ${event}: URL inválida ou protocolo não permitido (somente http/https); hook ignorado`)
      }
    }
    if (!runs.length) return outcome

    const results = await Promise.all(runs)
    outcome.results = results

    for (const result of results) {
      if (result.timedOut) {
        outcome.warnings.push(`hook ${event} excedeu o tempo: ${result.command}`)
        continue
      }
      if (result.http) {
        const { status, error } = result.http
        if (error) {
          outcome.warnings.push(`hook ${event} falhou (${result.command}): ${error.slice(0, 300)}`)
        } else if (status !== null && status >= 300 && status < 400) {
          outcome.warnings.push(`hook ${event}: ${result.command} respondeu HTTP ${status}; redirecionamentos não são seguidos`)
        } else if (status === null || status < 200 || status >= 300) {
          outcome.warnings.push(`hook ${event}: ${result.command} respondeu HTTP ${status ?? '?'}`)
        } else {
          this.interpret(outcome, event, result.stdout)
        }
        continue
      }
      if (result.exitCode === 2) {
        outcome.blocked = true
        outcome.reason = [outcome.reason, result.stderr.trim() || `bloqueado pelo hook ${result.command}`]
          .filter(Boolean)
          .join('\n')
        continue
      }
      if (result.exitCode !== 0) {
        outcome.warnings.push(`hook ${event} falhou (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`)
        continue
      }
      this.interpret(outcome, event, result.stdout)
    }
    return outcome
  }

  /** Reads a successful hook's output (command stdout or http body): plain text becomes context, JSON can decide. */
  private interpret(outcome: HookOutcome, event: HookEvent, output: string): void {
    const json = parseJson(output)
    if (!json) {
      if ((event === 'UserPromptSubmit' || event === 'SessionStart') && output.trim()) {
        outcome.additionalContext.push(output.trim())
      }
      return
    }
    if (json.continue === false) outcome.stop = json.stopReason || 'interrompido por hook'
    const specific = json.hookSpecificOutput ?? {}
    const decision = specific.permissionDecision ?? (json.decision === 'approve' ? 'allow' : json.decision === 'block' ? 'deny' : undefined)
    if (decision === 'allow' || decision === 'ask' || decision === 'deny') {
      if (outcome.permissionDecision === undefined || RANK[decision] > RANK[outcome.permissionDecision]) {
        outcome.permissionDecision = decision
      }
      if (decision === 'deny') {
        outcome.blocked = true
        outcome.reason = specific.permissionDecisionReason || json.reason || outcome.reason || 'negado por hook'
      }
    }
    if (specific.updatedInput && typeof specific.updatedInput === 'object') outcome.updatedInput = specific.updatedInput
    if (specific.additionalContext) outcome.additionalContext.push(specific.additionalContext)
  }
}
