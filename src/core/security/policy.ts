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

/** Folders a Windows-style `%NAME%` prefix may stand for in a path (the shell expands them; the file tools did not). */
const PATH_ENV_VARS = new Set(['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PUBLIC', 'PROGRAMDATA', 'ONEDRIVE', 'HOME'])

/**
 * `%TEMP%\\script.py` -> the real temporary folder. Cowork tells the model to keep helper files in %TEMP%, and a file tool
 * given that literally used to create a folder named "%TEMP%" inside the user's own folder. Only a leading, known folder
 * variable is expanded; the result still goes through the same containment checks as any other path.
 */
export function expandLeadingEnv(input: string): string {
  const match = /^%([A-Za-z]+)%(?=[\\/]|$)/.exec(input)
  if (!match || !PATH_ENV_VARS.has(match[1].toUpperCase())) return input
  const value = process.env[match[1]] ?? process.env[match[1].toUpperCase()]
  return value ? value + input.slice(match[0].length) : input
}

/** Prevents path traversal and writes outside the declared project roots. */
export class WorkspaceGuard {
  private readonly roots: string[]
  /** Real paths of the roots, so 8.3/symlinked roots still compare correctly. */
  private readonly realRoots: string[]
  /** When true, any absolute path is accepted (personal workstation mode). */
  readonly unrestricted: boolean

  constructor(roots: string[], unrestricted = false) {
    this.roots = roots.map((r) => normalize(r))
    this.unrestricted = unrestricted
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
  resolve(rawInput: string, base?: string): string {
    if (!rawInput || typeof rawInput !== 'string') throw new SecurityError('caminho vazio', 'invalid')
    const input = expandLeadingEnv(rawInput)
    const absolute = path.isAbsolute(input) ? input : path.resolve(base ?? this.roots[0] ?? process.cwd(), input)

    // Personal workstation mode: the agent may work anywhere the user can,
    // which is what Computer Use needs for real files outside the project.
    if (this.unrestricted) return absolute

    // Walk to the deepest existing ancestor, following links on the way. A symlink whose target does not exist
    // yet (dangling) looks "missing" to existsSync, so the old walk skipped it and a later write created the file
    // wherever the link pointed, outside the roots.
    let probe = absolute
    for (let hops = 0; hops < 32; hops++) {
      let stat: fs.Stats | undefined
      try {
        stat = fs.lstatSync(probe)
      } catch {
        stat = undefined
      }
      if (!stat) {
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
        continue
      }
      if (stat.isSymbolicLink()) {
        try {
          probe = path.resolve(path.dirname(probe), fs.readlinkSync(probe))
          continue
        } catch {
          break
        }
      }
      break
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
  if (policy.mode === 'unrestricted') return { blocked: false }
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
  { re: /<\/?(system|assistant|tool)>/i, label: 'tags de papel falsificadas' },
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

/**
 * What a third-party server process (an MCP server started over stdio) gets from Openclod's environment: only what
 * programs need to run — the same idea as the MCP SDK's `getDefaultEnvironment` — plus proxy and certificate settings
 * of corporate networks. Keys, tokens and everything else the app's environment holds stay out; the server's own
 * `env` from its config is added on top by the caller.
 */
const CHILD_ENV_ALLOW = new Set(
  [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME',
    'USERDOMAIN', 'COMPUTERNAME', 'LOGNAME', 'USER', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'
  ].map((name) => name.toUpperCase())
)

/** `LC_ALL`, `LC_CTYPE`...: the locale, never a secret. */
const CHILD_ENV_PREFIX = /^LC_/

export function childProcessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    if (value !== undefined && (CHILD_ENV_ALLOW.has(upper) || CHILD_ENV_PREFIX.test(upper))) env[key] = value
  }
  return { ...env, ...extra }
}

/** Environment for child processes: keeps PATH etc., drops provider secrets. */
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(key)) continue
    env[key] = value
  }
  return env
}
