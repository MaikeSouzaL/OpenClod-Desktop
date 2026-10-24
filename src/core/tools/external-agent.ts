import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { PermissionMode, ToolResult, Usage } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import { SecurityError, redactSecrets, sanitizedEnv } from '../security/policy.js'
import { truncateMiddle } from '../util/ids.js'
import { killTree } from './shell.js'

/**
 * `external_agent`: delegates a task to a coding agent CLI that is already
 * installed and logged in on this machine (Claude Code or Codex), runs it
 * non-interactively in the session's cwd and returns its final answer.
 *
 * Safety rules:
 * - The tool asks for approval like run_command (risk `exec`).
 * - The child's own permission mode follows Openclod's, and never goes beyond
 *   "accept edits": no bypassPermissions, no --dangerously-*, no full-access sandbox.
 * - The prompt travels over stdin, never argv: argv would be re-parsed by
 *   cmd.exe for the npm `.cmd` shims on Windows.
 * - The child gets the sanitized environment (no API keys/tokens from Openclod)
 *   and its whole process tree is killed on abort or timeout.
 */

export type ExternalAgentName = 'claude' | 'codex'

const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 3_600_000
const MAX_ANSWER_CHARS = 60_000
const TAIL_CHARS = 4000
/** After the final result event, how long a lingering CLI gets before being killed. */
const DEFAULT_DONE_GRACE_MS = 10_000
/** Safety net: after kill, resolve even if the 'close' event never arrives. */
const KILL_GRACE_MS = 5000
const PROGRESS_MIN_GAP_MS = 400
const PROGRESS_MAX_LINES = 40

export interface ExternalAgentOptions {
  /** CLI path per agent. Takes precedence over FORJA_CLAUDE_BIN / FORJA_CODEX_BIN and PATH. */
  bin?: Partial<Record<ExternalAgentName, string>>
  /** Extra environment for the child (on top of the sanitized one). */
  env?: Record<string, string>
  /** See DEFAULT_DONE_GRACE_MS. */
  doneGraceMs?: number
}

/* ------------------------------------------------------------------ */
/* Permission mapping                                                   */
/* ------------------------------------------------------------------ */

/** Openclod permission mode → `claude --permission-mode`. Never bypassPermissions. */
export function claudePermissionMode(mode: PermissionMode): 'plan' | 'default' | 'acceptEdits' {
  switch (mode) {
    case 'ask':
      return 'default'
    case 'accept-edits':
    case 'auto':
      return 'acceptEdits'
    default:
      return 'plan'
  }
}

/** Openclod permission mode → `codex exec -s`. Never danger-full-access. */
export function codexSandbox(mode: PermissionMode): 'read-only' | 'workspace-write' {
  return mode === 'accept-edits' || mode === 'auto' ? 'workspace-write' : 'read-only'
}

const FORBIDDEN_ARGS = /bypassPermissions|dangerously|danger-full-access|skip-permissions/i

function guardArgs(args: string[]): string[] {
  const bad = args.find((arg) => FORBIDDEN_ARGS.test(arg))
  if (bad) throw new Error(`argumento proibido para agente externo: ${bad}`)
  return args
}

/* ------------------------------------------------------------------ */
/* Stream parsers                                                       */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>

interface Outcome {
  /** Final answer text (may be a partial one when the run failed). */
  answer: string
  ok: boolean
  error?: string
  sessionId?: string
  usage?: Usage
  costUsd?: number
  turns?: number
  durationMs?: number
  denials: string[]
  /** No final result was seen: the CLI died or was cut off, so its own output matters. */
  incomplete?: boolean
}

interface StreamParser {
  push(event: Json, progress: (line: string) => void): void
  /** True once the CLI delivered its final result. */
  readonly done: boolean
  finish(): Outcome
}

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describeClaudeToolUse(block: Json): string {
  const name = str(block.name) ?? 'ferramenta'
  const input = asRecord(block.input)
  const subject = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']
    .map((key) => str(input?.[key]))
    .find(Boolean)
  return subject ? `${name}: ${oneLine(subject)}` : name
}

/** `claude -p --output-format stream-json --verbose`: system/assistant/user events, then one `result`. */
function claudeParser(): StreamParser {
  let sessionId: string | undefined
  let lastText = ''
  let result: Json | null = null
  return {
    get done() {
      return result !== null
    },
    push(event, progress) {
      if (event.type === 'system' && event.subtype === 'init') {
        sessionId = str(event.session_id) ?? sessionId
        const model = str(event.model)
        progress(model ? `sessão iniciada (${model})` : 'sessão iniciada')
      } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
        const content = asRecord(event.message)?.content
        if (!Array.isArray(content)) return
        const texts: string[] = []
        for (const entry of content) {
          const block = asRecord(entry)
          if (block?.type === 'text' && str(block.text)) texts.push(block.text as string)
          else if (block?.type === 'tool_use') progress(describeClaudeToolUse(block))
        }
        if (texts.length) lastText = texts.join('\n')
      } else if (event.type === 'result') {
        result = event
        sessionId = str(event.session_id) ?? sessionId
      }
    },
    finish() {
      if (!result) {
        return {
          answer: lastText,
          ok: false,
          error: 'o Claude Code encerrou sem enviar o resultado final',
          sessionId,
          denials: [],
          incomplete: true
        }
      }
      const text = str(result.result)?.trim() ? (result.result as string) : lastText
      const subtype = str(result.subtype)
      const failed = result.is_error === true || (subtype !== undefined && subtype !== 'success')
      const usage = asRecord(result.usage)
      const cacheRead = num(usage?.cache_read_input_tokens) ?? 0
      const cacheWrite = num(usage?.cache_creation_input_tokens) ?? 0
      const denials = Array.isArray(result.permission_denials)
        ? [...new Set(result.permission_denials.map((entry) => str(asRecord(entry)?.tool_name)).filter((name): name is string => !!name))]
        : []
      return {
        answer: text,
        ok: !failed,
        error: failed
          ? subtype === 'error_max_turns'
            ? 'o Claude Code atingiu o limite de turnos'
            : text.trim() || `o Claude Code terminou com erro${subtype ? ` (${subtype})` : ''}`
          : undefined,
        sessionId,
        usage: usage
          ? {
              // Openclod counts cached tokens as input, like the Anthropic provider does.
              input: (num(usage.input_tokens) ?? 0) + cacheRead + cacheWrite,
              output: num(usage.output_tokens) ?? 0,
              cachedInput: cacheRead || undefined,
              costUsd: num(result.total_cost_usd)
            }
          : undefined,
        costUsd: num(result.total_cost_usd),
        turns: num(result.num_turns),
        durationMs: num(result.duration_ms),
        denials
      }
    }
  }
}

/** `codex exec --json`: thread/turn/item events; the answer is the last agent_message item. */
function codexParser(): StreamParser {
  let sessionId: string | undefined
  let answer = ''
  let usage: Usage | undefined
  let turnCompleted = false
  let failure: string | undefined
  let lastError: string | undefined
  return {
    get done() {
      return turnCompleted || failure !== undefined
    },
    push(event, progress) {
      switch (event.type) {
        case 'thread.started':
          sessionId = str(event.thread_id) ?? sessionId
          progress('sessão iniciada')
          break
        case 'item.started':
        case 'item.completed': {
          const item = asRecord(event.item)
          if (!item) break
          const completed = event.type === 'item.completed'
          if (item.type === 'agent_message' && completed) {
            const text = str(item.text)
            if (text) {
              answer = text
              progress(oneLine(text, 100))
            }
          } else if (item.type === 'command_execution' && !completed) {
            progress(`$ ${oneLine(str(item.command) ?? '', 120)}`)
          } else if (item.type === 'file_change' && completed) {
            const paths = Array.isArray(item.changes)
              ? item.changes.map((change) => str(asRecord(change)?.path)).filter((p): p is string => !!p)
              : []
            if (paths.length) progress(`arquivos alterados: ${oneLine(paths.join(', '), 120)}`)
          } else if (item.type === 'mcp_tool_call' && !completed) {
            progress(`MCP ${str(item.server) ?? ''}/${str(item.tool) ?? ''}`)
          } else if (item.type === 'web_search' && !completed) {
            progress(`busca: ${oneLine(str(item.query) ?? '', 100)}`)
          } else if (item.type === 'error' && completed) {
            lastError = str(item.message) ?? lastError
          }
          break
        }
        case 'turn.completed': {
          turnCompleted = true
          const raw = asRecord(event.usage)
          if (raw) {
            usage = {
              // Codex input_tokens already includes the cached part.
              input: num(raw.input_tokens) ?? 0,
              output: num(raw.output_tokens) ?? 0,
              cachedInput: num(raw.cached_input_tokens) || undefined
            }
          }
          break
        }
        case 'turn.failed':
          failure = str(asRecord(event.error)?.message) ?? lastError ?? 'o turno falhou'
          break
        case 'error':
          // Often transient ("Reconnecting... 2/5"): only fatal if no answer follows.
          lastError = str(event.message) ?? lastError
          break
      }
    },
    finish() {
      const ok = failure === undefined && answer.trim().length > 0
      return {
        answer,
        ok,
        error: ok ? undefined : (failure ?? lastError ?? 'o Codex terminou sem resposta final'),
        sessionId,
        usage,
        denials: [],
        incomplete: !ok && failure === undefined
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Binary lookup and process launch                                     */
/* ------------------------------------------------------------------ */

interface AgentSpec {
  label: string
  binEnv: string
  binNames: string[]
  installHint: string
  args(mode: PermissionMode): string[]
  parser(): StreamParser
}

const SPECS: Record<ExternalAgentName, AgentSpec> = {
  claude: {
    label: 'Claude Code',
    binEnv: 'FORJA_CLAUDE_BIN',
    binNames: ['claude'],
    installHint: 'Instale com "npm i -g @anthropic-ai/claude-code", entre com "claude" uma vez, ou aponte FORJA_CLAUDE_BIN para o executável.',
    args: (mode) =>
      guardArgs([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        claudePermissionMode(mode),
        // Nobody can answer questions in print mode.
        '--disallowedTools=AskUserQuestion'
      ]),
    parser: claudeParser
  },
  codex: {
    label: 'Codex',
    binEnv: 'FORJA_CODEX_BIN',
    binNames: ['codex'],
    installHint: 'Instale com "npm i -g @openai/codex", entre com "codex login", ou aponte FORJA_CODEX_BIN para o executável.',
    args: (mode) =>
      guardArgs([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-s',
        codexSandbox(mode),
        // "-" makes codex read the prompt from stdin.
        '-'
      ]),
    parser: codexParser
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

function findOnPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidates =
        process.platform === 'win32'
          ? WINDOWS_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
            ? [name]
            : WINDOWS_EXTENSIONS.map((ext) => name + ext)
          : [name]
      for (const candidate of candidates) {
        const full = path.join(dir, candidate)
        if (isFile(full)) return full
      }
    }
  }
  return null
}

type BinLookup = { path: string } | { error: string }

function resolveBinary(spec: AgentSpec, override: string | undefined, env: NodeJS.ProcessEnv): BinLookup {
  const configured = override?.trim() || env[spec.binEnv]?.trim()
  if (configured) {
    if (/[\\/]/.test(configured) || path.isAbsolute(configured)) {
      return isFile(configured)
        ? { path: configured }
        : { error: `${spec.binEnv} aponta para um arquivo que não existe: ${configured}` }
    }
    const found = findOnPath([configured], env)
    return found ? { path: found } : { error: `"${configured}" (de ${spec.binEnv}) não foi encontrado no PATH.` }
  }
  const found = findOnPath(spec.binNames, env)
  return found
    ? { path: found }
    : { error: `${spec.label} não está instalado (comando "${spec.binNames[0]}" não encontrado no PATH). ${spec.installHint}` }
}

function launch(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const common = {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    // POSIX: own process group so killTree(-pid) reaches the whole tree.
    detached: process.platform !== 'win32'
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    // npm shims are batch files, which Node will not spawn directly. Everything
    // in `args` is a fixed token, so this line carries no user text.
    if (/["%\r\n]/.test(bin)) throw new Error(`caminho do executável contém caracteres não suportados: ${bin}`)
    const line = `"${bin}" ${args.join(' ')}`
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...common, windowsVerbatimArguments: true })
  }
  return spawn(bin, args, common)
}

const running = new Map<string, Set<ChildProcess>>()

/** Kills every external agent still running for a session (session close / cancel). */
export function killExternalAgentProcesses(sessionId: string): number {
  const set = running.get(sessionId)
  if (!set) return 0
  let killed = 0
  for (const child of set) {
    if (child.pid && child.exitCode === null) {
      killTree(child.pid)
      killed++
    }
  }
  running.delete(sessionId)
  return killed
}

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

interface RunResult {
  code: number | null
  timedOut: boolean
  aborted: boolean
  /** The CLI delivered its result but kept running; we ended it. */
  lingered: boolean
  spawnError?: string
  stderrTail: string
  plainTail: string
  outcome: Outcome
}

function tail(current: string, add: string): string {
  const next = current + add
  return next.length > TAIL_CHARS ? next.slice(next.length - TAIL_CHARS) : next
}

function runAgent(params: {
  spec: AgentSpec
  bin: string
  mode: PermissionMode
  prompt: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  doneGraceMs: number
  sessionId: string
  signal: AbortSignal
  progress: (line: string) => void
}): Promise<RunResult> {
  const { spec, signal } = params
  const parser = spec.parser()
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = launch(params.bin, spec.args(params.mode), params.cwd, params.env)
    } catch (err) {
      resolve({
        code: null,
        timedOut: false,
        aborted: false,
        lingered: false,
        spawnError: (err as Error).message,
        stderrTail: '',
        plainTail: '',
        outcome: parser.finish()
      })
      return
    }
    const set = running.get(params.sessionId) ?? new Set<ChildProcess>()
    set.add(child)
    running.set(params.sessionId, set)

    let timedOut = false
    let aborted = false
    let lingered = false
    let settled = false
    let stderrTail = ''
    let plainTail = ''
    let buffer = ''
    let doneTimer: NodeJS.Timeout | undefined
    let forceTimer: NodeJS.Timeout | undefined

    const kill = (): void => {
      if (child.pid) killTree(child.pid)
      // If the OS never reports the exit, do not hang the agent loop.
      forceTimer ??= setTimeout(() => settle(null), KILL_GRACE_MS)
    }

    const settle = (code: number | null, spawnError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(doneTimer)
      clearTimeout(forceTimer)
      signal.removeEventListener('abort', onAbort)
      set.delete(child)
      resolve({ code, timedOut, aborted, lingered, spawnError, stderrTail, plainTail, outcome: parser.finish() })
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, params.timeoutMs)
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const onLine = (raw: string): void => {
      const line = raw.replace(/^﻿/, '').trim()
      if (!line) return
      if (line.startsWith('{')) {
        try {
          const event = asRecord(JSON.parse(line))
          if (event) {
            parser.push(event, params.progress)
            if (parser.done && !doneTimer) {
              // Final answer is in; do not let a stuck CLI hold the tool open.
              doneTimer = setTimeout(() => {
                lingered = true
                kill()
              }, params.doneGraceMs)
            }
            return
          }
        } catch {
          /* fall through: plain text */
        }
      }
      plainTail = tail(plainTail, `${line}\n`)
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
      // A single event can be large (tool output), but never unbounded.
      if (buffer.length > 16_000_000) buffer = ''
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = tail(stderrTail, chunk)
    })
    child.on('error', (err) => settle(null, err.message))
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer)
      buffer = ''
      settle(code)
    })

    // EPIPE when the CLI exits before reading the prompt must not become an uncaught error.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(params.prompt, 'utf8')
  })
}

/* ------------------------------------------------------------------ */
/* Tool                                                                 */
/* ------------------------------------------------------------------ */

const schema = z.object({
  agent: z.enum(['claude', 'codex']).describe('Qual CLI usar: "claude" (Claude Code) ou "codex" (OpenAI Codex)'),
  prompt: z.string().min(1).max(100_000).describe('Tarefa completa e autocontida para o agente externo'),
  cwd: z.string().optional().describe('Diretório de trabalho (dentro do projeto); padrão: o da sessão'),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe('Tempo máximo em ms (padrão 600000)')
})

type Args = z.infer<typeof schema>

function money(usd: number): string {
  return `US$ ${usd.toFixed(usd < 0.01 ? 4 : 2)}`
}

function emitProgress(ctx: ToolContext, label: string): (line: string) => void {
  let last = 0
  let count = 0
  return (line) => {
    const now = Date.now()
    if (!line.trim() || count >= PROGRESS_MAX_LINES || now - last < PROGRESS_MIN_GAP_MS) return
    last = now
    count++
    try {
      ctx.emit({ type: 'notice', sessionId: ctx.sessionId, level: 'info', text: `[${label}] ${line}` })
    } catch {
      /* progress is best effort */
    }
  }
}

export function createExternalAgentTool(options: ExternalAgentOptions = {}): ToolDef {
  return {
    name: 'external_agent',
    description:
      'Delega uma tarefa de programação a um agente de código externo já instalado e autenticado nesta máquina (Claude Code ou Codex CLI). Ele roda sem interação no diretório do projeto e devolve a resposta final (com tokens/custo quando informados). Use para trabalhos grandes e independentes: investigar, implementar, revisar. Consome a conta/cota do usuário no serviço do agente e pede aprovação. O agente externo herda o modo de permissão do Openclod: em "perguntar" ele só lê; editar exige "aceitar edições" ou "automático"; nunca roda sem proteções. Escreva o prompt completo, pois ele não vê esta conversa.',
    risk: 'exec',
    parallelSafe: false,
    requires: 'network',
    schema,
    describe(raw) {
      const args = (raw ?? {}) as Partial<Args>
      const label = args.agent && SPECS[args.agent] ? SPECS[args.agent].label : 'agente externo'
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      return {
        title: `Delegar ao ${label}`,
        detail: oneLine(prompt, 300),
        // "<agent> <prompt>" so a rule like ExternalAgent(claude:*) matches every claude run.
        preview: `${args.agent ?? 'claude'} ${oneLine(prompt, 200)}`
      }
    },
    async execute(raw, ctx): Promise<ToolResult> {
      const args = schema.parse(raw)
      const spec = SPECS[args.agent]

      let cwd: string
      try {
        cwd = args.cwd ? ctx.workspace.resolve(args.cwd, ctx.cwd) : ctx.cwd
      } catch (err) {
        if (err instanceof SecurityError) return { ok: false, text: `BLOQUEADO pela política: ${err.message}` }
        throw err
      }
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { ok: false, text: `diretório de trabalho inexistente: ${cwd}` }
      }

      const lookup = resolveBinary(spec, options.bin?.[args.agent], process.env)
      if ('error' in lookup) return { ok: false, text: lookup.error, summary: `${spec.label} indisponível` }

      const mode = ctx.policy.mode
      const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS
      const progress = emitProgress(ctx, spec.label)
      ctx.log('info', `external_agent: ${spec.label} (${lookup.path}) em ${cwd}`)
      progress(`iniciando (permissões: ${args.agent === 'claude' ? claudePermissionMode(mode) : `sandbox ${codexSandbox(mode)}`})`)

      const started = Date.now()
      const run = await runAgent({
        spec,
        bin: lookup.path,
        mode,
        prompt: args.prompt,
        cwd,
        env: { ...sanitizedEnv(), ...options.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        timeoutMs,
        doneGraceMs: options.doneGraceMs ?? DEFAULT_DONE_GRACE_MS,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        progress
      })
      const elapsedMs = Date.now() - started
      const { outcome } = run
      const seconds = (elapsedMs / 1000).toFixed(1)

      // A CLI that delivered its result and then hung was ended by us: that is still a success.
      const cleanExit = run.code === 0 || run.lingered
      const ok = !run.spawnError && !run.timedOut && !run.aborted && cleanExit && outcome.ok

      const meta = [
        spec.label,
        outcome.turns !== undefined ? `${outcome.turns} turno(s)` : undefined,
        `${seconds}s`,
        outcome.costUsd !== undefined ? money(outcome.costUsd) : undefined,
        outcome.usage ? `${outcome.usage.input} tokens de entrada / ${outcome.usage.output} de saída` : undefined,
        outcome.sessionId ? `sessão ${outcome.sessionId}` : undefined
      ].filter(Boolean)

      const parts: string[] = []
      const answer = outcome.answer.trim()
      if (run.spawnError) {
        parts.push(`Não foi possível iniciar ${spec.label}: ${run.spawnError}`)
      } else if (run.aborted) {
        parts.push(`Execução do ${spec.label} cancelada pelo usuário.`)
      } else if (run.timedOut) {
        parts.push(`Tempo esgotado: ${spec.label} excedeu ${Math.round(timeoutMs / 1000)}s e foi encerrado.`)
      } else if (!ok) {
        // Prefer the CLI's own error; otherwise whatever it printed outside the JSON stream.
        const own = [run.stderrTail.trim(), run.plainTail.trim()].filter(Boolean).join('\n')
        const detail = outcome.error ?? own
        parts.push(`${spec.label} falhou${run.code !== 0 && run.code !== null ? ` (código de saída ${run.code})` : ''}: ${detail || 'sem detalhes'}`)
        // A CLI that died without a result explains itself on stderr.
        if (outcome.error && outcome.incomplete && own) parts.push(own)
      }
      if (answer && (ok || (outcome.error ?? '').trim() !== answer)) {
        parts.push(ok ? answer : `Resposta parcial:\n${answer}`)
      }
      if (outcome.denials.length) {
        parts.push(
          `Ações negadas pelo modo de permissão do agente (${claudePermissionMode(mode)}): ${outcome.denials.join(', ')}. Mude o modo do Openclod para "aceitar edições" ou "automático" se elas forem necessárias.`
        )
      }
      parts.push(`[${meta.join(' · ')}]`)

      const text = redactSecrets(truncateMiddle(parts.join('\n\n'), MAX_ANSWER_CHARS))
      return {
        ok,
        text,
        summary: `${spec.label} · ${seconds}s${outcome.costUsd !== undefined ? ` · ${money(outcome.costUsd)}` : ''}${ok ? '' : ' · falhou'}`,
        data: {
          agent: args.agent,
          exitCode: run.code,
          timedOut: run.timedOut,
          aborted: run.aborted,
          sessionId: outcome.sessionId,
          costUsd: outcome.costUsd,
          usage: outcome.usage,
          turns: outcome.turns,
          durationMs: outcome.durationMs ?? elapsedMs,
          permissionDenials: outcome.denials
        }
      }
    }
  }
}

export const externalAgentTool: ToolDef = createExternalAgentTool()

export const externalAgentTools: ToolDef[] = [externalAgentTool]
