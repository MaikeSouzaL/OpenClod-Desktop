import path from 'node:path'
import fs from 'node:fs'
import type { PolicyConfig } from '../../shared/types.js'

export class SecurityError extends Error {
  constructor(
    message: string,
    readonly kind: 'outside-workspace' | 'blocked-command' | 'denied' | 'invalid'
  ) {
    super(message)
    this.name = 'SecurityError'
  }
}

const WINDOWS = process.platform === 'win32'

function normalize(p: string): string {
  const resolved = path.resolve(p)
  return WINDOWS ? resolved.toLowerCase() : resolved
}

/** Prevents path traversal and writes outside the declared project roots. */
export class WorkspaceGuard {
  private readonly roots: string[]
  /** Real paths of the roots, so 8.3/symlinked roots still compare correctly. */
  private readonly realRoots: string[]

  constructor(roots: string[]) {
    this.roots = roots.map((r) => normalize(r))
    this.realRoots = roots.map((root) => {
      try {
        return normalize(fs.realpathSync.native(root))
      } catch {
        return normalize(root)
      }
    })
  }

  get rootList(): string[] {
    return [...this.roots]
  }

  isInside(candidate: string): boolean {
    const target = normalize(candidate)
    return this.roots.some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
  }

  /**
   * Resolves a possibly-relative path and rejects anything that escapes the
   * roots after symlink resolution of the deepest existing ancestor.
   */
  resolve(input: string, base?: string): string {
    if (!input || typeof input !== 'string') throw new SecurityError('caminho vazio', 'invalid')
    const absolute = path.isAbsolute(input) ? input : path.resolve(base ?? this.roots[0] ?? process.cwd(), input)

    let probe = absolute
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    let real = probe
    try {
      real = fs.realpathSync.native(probe)
    } catch {
      /* keep probe */
    }
    const normalizedReal = normalize(real)
    // Containment is decided on the resolved real ancestor only. Checking the
    // lexical target as well would let a symlink/junction inside the root point
    // anywhere while still looking "inside" by name.
    const inside = this.realRoots.some(
      (root) => normalizedReal === root || normalizedReal.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    )
    if (!inside) {
      throw new SecurityError(
        `caminho fora dos diretórios autorizados: ${input}`,
        'outside-workspace'
      )
    }
    return absolute
  }
}

/** Commands that must never run, regardless of approval mode. */
export const DEFAULT_BLOCKED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-?[a-z]*[rf][a-z]*\s+(\/|~|\*)/i, reason: 'remoção recursiva da raiz' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'formatação de disco' },
  { pattern: /\bdiskpart\b/i, reason: 'particionamento de disco' },
  { pattern: /\b(shutdown|reboot|Restart-Computer|Stop-Computer)\b/i, reason: 'desligamento/reinício' },
  { pattern: /\bbcdedit\b/i, reason: 'alteração de boot' },
  { pattern: /\breg\s+delete\b/i, reason: 'remoção de chaves de registro' },
  { pattern: /\bnet\s+user\s+\S+\s+.*\/add/i, reason: 'criação de usuário' },
  { pattern: /\bmkfs\b|\bdd\s+if=/i, reason: 'escrita em dispositivo' },
  { pattern: /\bdel\s+\/[fsq]\b.*\\$/i, reason: 'exclusão forçada de diretório' },
  { pattern: /\brd\s+\/s\s+\/q\s+[a-z]:\\?$/i, reason: 'exclusão de unidade' },
  { pattern: /(curl|wget|irm|Invoke-WebRequest|iwr)[^|]*\|\s*(bash|sh|iex|Invoke-Expression)/i, reason: 'execução de script remoto' },
  { pattern: /\biex\s*\(/i, reason: 'Invoke-Expression arbitrário' },
  { pattern: /-EncodedCommand\b/i, reason: 'comando PowerShell codificado' },
  { pattern: /\bSet-MpPreference\b|\bAdd-MpPreference\b/i, reason: 'alteração do antivírus' },
  { pattern: /\bnetsh\s+advfirewall\b.*\bdisable\b/i, reason: 'desativação de firewall' },
  { pattern: /\bwhoami\s*\/priv|\bsecretsdump\b|\bmimikatz\b/i, reason: 'coleta de credenciais' }
]

export interface CommandCheck {
  blocked: boolean
  reason?: string
}

export function checkCommand(command: string, policy: PolicyConfig): CommandCheck {
  for (const rule of DEFAULT_BLOCKED_COMMANDS) {
    if (rule.pattern.test(command)) return { blocked: true, reason: rule.reason }
  }
  for (const extra of policy.blockedCommands ?? []) {
    if (!extra.trim()) continue
    try {
      if (new RegExp(extra, 'i').test(command)) return { blocked: true, reason: `regra do usuário: ${extra}` }
    } catch {
      if (command.toLowerCase().includes(extra.toLowerCase())) {
        return { blocked: true, reason: `regra do usuário: ${extra}` }
      }
    }
  }
  return { blocked: false }
}

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore (all )?(previous|prior|above) (instructions|prompts|rules)/i, label: 'instrução para ignorar regras' },
  { re: /disregard (all )?(previous|prior|above)/i, label: 'instrução para descartar regras' },
  { re: /you are now (a|an|the) /i, label: 'troca de persona' },
  { re: /system prompt|prompt do sistema/i, label: 'referência ao prompt de sistema' },
  { re: /reveal (your|the) (system prompt|instructions|api key|token)/i, label: 'tentativa de exfiltração' },
  { re: /(execute|run) the following (command|script)/i, label: 'comando embutido' },
  { re: /<\/?(system|assistant|tool)>/i, label: 'tags de papel forjadas' },
  { re: /new instructions?:/i, label: 'novas instruções embutidas' },
  { re: /do not tell the user|não (avise|conte) ao usuário/i, label: 'instrução de ocultação' }
]

export interface InjectionFinding {
  label: string
  excerpt: string
}

/**
 * Heuristic screen for instruction-like content inside tool output.
 * It never blocks the tool result — it raises an audit warning and the context
 * builder wraps the payload as untrusted data.
 */
export function scanForInjection(text: string): InjectionFinding[] {
  if (!text || text.length < 12) return []
  const findings: InjectionFinding[] = []
  for (const rule of INJECTION_PATTERNS) {
    const match = rule.re.exec(text)
    if (match) {
      const start = Math.max(0, match.index - 40)
      findings.push({ label: rule.label, excerpt: text.slice(start, match.index + match[0].length + 40).trim() })
    }
    if (findings.length >= 5) break
  }
  return findings
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
]

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}

const SENSITIVE_ENV = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i

/** Environment for child processes: keeps PATH etc., drops provider secrets. */
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(key)) continue
    env[key] = value
  }
  return env
}
