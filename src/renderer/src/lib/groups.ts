import { diffLines } from 'diff'
import type { Message, ToolCallPart } from '../../../shared/types'

/**
 * How a run of tool calls is summarized in the transcript, the way Claude
 * Desktop does it: "Executou 3 comandos, leu 2 arquivos e editou 1 arquivo".
 */

type Verb = { done: [string, string]; running: [string, string] }

const CATEGORIES: Array<{ id: string; test: (name: string) => boolean; verb: Verb }> = [
  { id: 'command', test: (n) => n === 'run_command' || n === 'start_process' || n === 'stop_process' || n === 'read_process_output' || n === 'list_processes' || n === 'list_ports', verb: { done: ['executou {n} comando', 'executou {n} comandos'], running: ['executando {n} comando', 'executando {n} comandos'] } },
  { id: 'read', test: (n) => n === 'read_file' || n === 'list_dir', verb: { done: ['leu {n} arquivo', 'leu {n} arquivos'], running: ['lendo {n} arquivo', 'lendo {n} arquivos'] } },
  { id: 'search', test: (n) => n === 'grep' || n === 'glob', verb: { done: ['pesquisou {n} vez', 'pesquisou {n} vezes'], running: ['pesquisando {n} vez', 'pesquisando {n} vezes'] } },
  { id: 'edit', test: (n) => n === 'write_file' || n === 'edit_file' || n === 'delete_path', verb: { done: ['editou {n} arquivo', 'editou {n} arquivos'], running: ['editando {n} arquivo', 'editando {n} arquivos'] } },
  { id: 'git', test: (n) => n.startsWith('git_'), verb: { done: ['usou o Git {n} vez', 'usou o Git {n} vezes'], running: ['usando o Git {n} vez', 'usando o Git {n} vezes'] } },
  { id: 'web', test: (n) => n === 'fetch_url' || n === 'web_search' || n === 'download_file', verb: { done: ['consultou a web {n} vez', 'consultou a web {n} vezes'], running: ['consultando a web {n} vez', 'consultando a web {n} vezes'] } },
  { id: 'browser', test: (n) => n.startsWith('browser_'), verb: { done: ['usou o navegador {n} vez', 'usou o navegador {n} vezes'], running: ['usando o navegador {n} vez', 'usando o navegador {n} vezes'] } },
  { id: 'computer', test: (n) => n.startsWith('computer_'), verb: { done: ['usou o computador {n} vez', 'usou o computador {n} vezes'], running: ['usando o computador {n} vez', 'usando o computador {n} vezes'] } },
  { id: 'agent', test: (n) => n === 'agent' || n === 'task' || n === 'list_agents' || n === 'external_agent', verb: { done: ['chamou {n} agente', 'chamou {n} agentes'], running: ['chamando {n} agente', 'chamando {n} agentes'] } },
  { id: 'mcp', test: (n) => n.startsWith('mcp__'), verb: { done: ['usou {n} ferramenta MCP', 'usou {n} ferramentas MCP'], running: ['usando {n} ferramenta MCP', 'usando {n} ferramentas MCP'] } }
]
const OTHER: { id: string; verb: Verb } = {
  id: 'other',
  verb: { done: ['usou {n} ferramenta', 'usou {n} ferramentas'], running: ['usando {n} ferramenta', 'usando {n} ferramentas'] }
}

/** The plan has its own card above the composer; the call itself is not worth a line. */
export function isPlanCall(name: string): boolean {
  return name === 'update_plan'
}

/** Calls that are shown as their own diff card instead of inside the collapsed group. */
export function isEditCall(name: string): boolean {
  return name === 'edit_file' || name === 'write_file'
}

export function summarizeCalls(names: string[], running: boolean): string {
  const counts = new Map<string, { count: number; verb: Verb }>()
  for (const name of names) {
    const category = CATEGORIES.find((item) => item.test(name)) ?? OTHER
    const entry = counts.get(category.id) ?? { count: 0, verb: category.verb }
    entry.count += 1
    counts.set(category.id, entry)
  }
  const parts = [...counts.values()].map(({ count, verb }) => {
    const pair = running ? verb.running : verb.done
    return (count === 1 ? pair[0] : pair[1]).replace('{n}', String(count))
  })
  if (!parts.length) return running ? 'Trabalhando…' : 'Sem ferramentas'
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`
  // First word capitalized: "Executou 3 comandos, leu 2 arquivos".
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export interface AssistantBlock {
  /** First message of the block: carries the text, error, usage and timestamp. */
  message: Message
  text: string
  calls: ToolCallPart[]
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim()
}

/**
 * Consecutive assistant messages that only call tools (one per loop iteration)
 * collapse into the block of the message before them, so a long run of work
 * reads as one summary line instead of a wall of cards.
 */
export function buildAssistantBlocks(messages: Message[]): Array<AssistantBlock | { message: Message; passthrough: true }> {
  const out: Array<AssistantBlock | { message: Message; passthrough: true }> = []
  for (const message of messages) {
    // Results are rendered inside the call cards, so they never interrupt a run of work.
    if (message.role === 'tool') continue
    if (message.role !== 'assistant') {
      out.push({ message, passthrough: true })
      continue
    }
    const text = textOf(message)
    const calls = message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
    const last = out[out.length - 1]
    if (last && !('passthrough' in last) && !text && calls.length && !message.error) {
      last.calls.push(...calls)
      continue
    }
    out.push({ message, text, calls: [...calls] })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Inline diffs for edit_file / write_file                             */
/* ------------------------------------------------------------------ */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  text: string
}

export interface EditPreview {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
  truncated: boolean
}

const MAX_PREVIEW_LINES = 400

function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Builds the green/red preview from the call's own arguments (no events needed). */
export function previewEdit(name: string, args: unknown): EditPreview | null {
  if (!args || typeof args !== 'object') return null
  const value = args as Record<string, unknown>
  const path = typeof value.path === 'string' ? value.path : ''
  if (!path) return null

  let before = ''
  let after = ''
  if (name === 'edit_file') {
    if (typeof value.old_string !== 'string' || typeof value.new_string !== 'string') return null
    before = value.old_string
    after = value.new_string
  } else if (name === 'write_file') {
    if (typeof value.content !== 'string') return null
    after = value.content
  } else {
    return null
  }

  const lines: DiffLine[] = []
  let additions = 0
  let deletions = 0
  for (const part of diffLines(before, after)) {
    const kind: DiffLine['kind'] = part.added ? 'add' : part.removed ? 'del' : 'ctx'
    const chunk = splitLines(part.value)
    if (kind === 'add') additions += chunk.length
    if (kind === 'del') deletions += chunk.length
    // Unchanged lines inside an edit are context; keep three on each side of a change.
    if (kind === 'ctx' && chunk.length > 6) {
      lines.push(...chunk.slice(0, 3).map((text) => ({ kind, text })), { kind: 'gap', text: `… ${chunk.length - 6} linhas iguais` }, ...chunk.slice(-3).map((text) => ({ kind, text })))
    } else {
      lines.push(...chunk.map((text) => ({ kind, text })))
    }
  }
  const truncated = lines.length > MAX_PREVIEW_LINES
  return { path, additions, deletions, lines: truncated ? lines.slice(0, MAX_PREVIEW_LINES) : lines, truncated }
}
