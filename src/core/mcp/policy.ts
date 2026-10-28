import type { McpServerSettings, RiskLevel } from '../../shared/types.js'

/**
 * Pure rules that decide what the model may see and call on an MCP server:
 * the include/exclude filter, the per-tool policy (`toolPolicy`), the
 * always-ask list (`approvalTools`) and the risk implied by the tool's own
 * annotations. No I/O here: the client, the registry builder and the tests
 * all share these functions.
 */

export type McpToolPolicy = 'allow' | 'ask' | 'deny'

/** Tool annotations from the MCP specification (all optional hints; untrusted by definition). */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** `_meta` of a tool entry: Anthropic-namespaced hints are honoured, the rest is ignored. */
export type McpToolMeta = Record<string, unknown>

/** `_meta` key a server sets to demand a human decision on every call (same key Claude Code reads). */
export const META_REQUIRES_INTERACTION = 'anthropic/requiresUserInteraction'
export const META_MAX_RESULT_CHARS = 'anthropic/maxResultSizeChars'
export const META_ALWAYS_LOAD = 'anthropic/alwaysLoad'

export type McpPolicyConfig = Pick<
  McpServerSettings,
  'includeTools' | 'excludeTools' | 'approvalTools' | 'toolPolicy'
>

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** Usable patterns only: settings are user-edited JSON, so entries may be junk. */
export function cleanPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return []
  return patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
}

/**
 * Glob-ish match over a server's own tool name: `*` is any run of characters,
 * `?` exactly one; everything else is literal. Case-insensitive.
 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  const source = pattern
    .trim()
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegex(ch)))
    .join('')
  return new RegExp(`^${source}$`, 'i').test(name)
}

export function matchesAnyToolPattern(patterns: unknown, name: string): boolean {
  return cleanPatterns(patterns).some((pattern) => matchesToolPattern(pattern, name))
}

type ToolFilterConfig = Pick<McpServerSettings, 'includeTools' | 'excludeTools'>

/** Whether the filter lets this tool through. An empty include list means "all". */
export function isMcpToolExposed(config: ToolFilterConfig, name: string): boolean {
  const include = cleanPatterns(config.includeTools)
  if (include.length && !include.some((pattern) => matchesToolPattern(pattern, name))) return false
  return !matchesAnyToolPattern(config.excludeTools, name)
}

export function filterMcpTools<T extends { name: string }>(tools: T[], config: ToolFilterConfig): T[] {
  return tools.filter((tool) => isMcpToolExposed(config, tool.name))
}

/**
 * Risk level for a tool that is only known by the `approvalTools` list.
 * `approvalTools` map to `destructive`, the only level that still asks in
 * `auto` mode; everything else keeps the MCP default (`exec`).
 */
export function mcpToolRisk(config: Pick<McpServerSettings, 'approvalTools'>, name: string): RiskLevel {
  return matchesAnyToolPattern(config.approvalTools, name) ? 'destructive' : 'exec'
}

/* ------------------------------------------------------------------ */
/* Annotations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Risk implied by the annotations alone: `readOnlyHint` is a read, an explicit
 * `destructiveHint: true` is destructive, anything else (including no
 * annotation) is `exec`, which asks in `ask`/`accept-edits` mode and runs in `auto`.
 * Annotations are hints from the server, not guarantees: the user's
 * `toolPolicy` always wins over them.
 */
export function riskFromAnnotations(annotations?: McpToolAnnotations | null): RiskLevel {
  if (annotations?.readOnlyHint === true) return 'read'
  if (annotations?.destructiveHint === true) return 'destructive'
  return 'exec'
}

/** Cleans an annotations object received from a server (wrong types are dropped). */
export function sanitizeAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const out: McpToolAnnotations = {}
  if (typeof source.title === 'string') out.title = source.title.slice(0, 200)
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof source[key] === 'boolean') out[key] = source[key]
  }
  return Object.keys(out).length ? out : undefined
}

/* ------------------------------------------------------------------ */
/* toolPolicy                                                          */
/* ------------------------------------------------------------------ */

function isPolicyValue(value: unknown): value is McpToolPolicy {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

/** Shapes untrusted JSON into a toolPolicy map: junk dropped, keys capped. Undefined when nothing is left. */
export function sanitizeToolPolicy(raw: unknown): Record<string, McpToolPolicy> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, McpToolPolicy> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 300)) {
    const pattern = key.trim().slice(0, 120)
    if (pattern && isPolicyValue(value)) out[pattern] = value
  }
  return Object.keys(out).length ? out : undefined
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?')
}

interface PolicyMatch {
  pattern: string
  value: McpToolPolicy
}

/**
 * Picks the toolPolicy entry for a tool: an exact name first, then the glob
 * with the most literal characters (the most specific), then `'*'` (the
 * server default, returned separately by `resolveToolPolicy`). Ties are broken
 * alphabetically so the answer never depends on key order.
 */
function matchToolPolicy(
  policy: Record<string, McpToolPolicy> | undefined,
  name: string
): { specific?: PolicyMatch; fallback?: PolicyMatch } {
  const entries = Object.entries(sanitizeToolPolicy(policy) ?? {})
  if (!entries.length) return {}
  const lowered = name.toLowerCase()
  const exact = entries.find(([pattern]) => !hasWildcard(pattern) && pattern.toLowerCase() === lowered)
  if (exact) return { specific: { pattern: exact[0], value: exact[1] } }
  const globs = entries
    .filter(([pattern]) => pattern !== '*' && hasWildcard(pattern) && matchesToolPattern(pattern, name))
    .sort((a, b) => literalLength(b[0]) - literalLength(a[0]) || a[0].localeCompare(b[0]))
  const fallback = entries.find(([pattern]) => pattern === '*')
  return {
    specific: globs[0] ? { pattern: globs[0][0], value: globs[0][1] } : undefined,
    fallback: fallback ? { pattern: '*', value: fallback[1] } : undefined
  }
}

function literalLength(pattern: string): number {
  return pattern.replace(/[*?]/g, '').length
}

/* ------------------------------------------------------------------ */
/* resolveToolPolicy                                                   */
/* ------------------------------------------------------------------ */

export type PolicySource =
  | 'filter'
  | 'toolPolicy'
  | 'toolPolicy-default'
  | 'approvalTools'
  | 'meta'
  | 'annotation'
  | 'default'

export interface ResolvedToolPolicy {
  /** The model can see and call it. False for `deny` and for tools the include/exclude filter hides. */
  exposed: boolean
  /** Effective choice. For an unconfigured tool this is the default implied by its annotations. */
  policy: McpToolPolicy
  /** True when the choice came from the user's settings or the server's `_meta`, false for the derived default. */
  explicit: boolean
  source: PolicySource
  /** Risk the harness registers the tool with. */
  risk: RiskLevel
  /** One line in pt-BR saying why. */
  reason: string
}

/**
 * Decides exposure, approval and risk of one server tool. Order (first match wins):
 *  1. includeTools/excludeTools hide the tool;
 *  2. `toolPolicy` by exact name, then by the most specific glob (`deny` hides it);
 *  3. the server asked for a human on every call (`_meta["anthropic/requiresUserInteraction"]`): ask;
 *  4. `toolPolicy['*']`, the server default (`deny` hides every tool that no entry above names);
 *  5. `approvalTools`: ask, with `destructive` risk;
 *  6. the default from the annotations: read-only tools are allowed, the rest ask according to the app mode.
 */
export function resolveToolPolicy(
  config: McpPolicyConfig,
  toolName: string,
  annotations?: McpToolAnnotations | null,
  meta?: McpToolMeta | null
): ResolvedToolPolicy {
  const baseRisk = riskFromAnnotations(annotations)
  const hidden = (source: PolicySource, reason: string): ResolvedToolPolicy => ({
    exposed: false,
    policy: 'deny',
    explicit: true,
    source,
    risk: baseRisk,
    reason
  })

  if (!isMcpToolExposed(config, toolName)) {
    return hidden('filter', 'oculta por includeTools/excludeTools')
  }

  const { specific, fallback } = matchToolPolicy(config.toolPolicy, toolName)
  const interaction = meta?.[META_REQUIRES_INTERACTION] === true

  if (specific) {
    if (specific.value === 'deny') return hidden('toolPolicy', `negada pela política da ferramenta (${specific.pattern})`)
    if (specific.value === 'allow' && interaction) {
      return {
        exposed: true,
        policy: 'ask',
        explicit: true,
        source: 'meta',
        risk: baseRisk,
        reason: 'o servidor exige uma decisão humana a cada chamada'
      }
    }
    return {
      exposed: true,
      policy: specific.value,
      explicit: true,
      source: 'toolPolicy',
      risk: baseRisk,
      reason:
        specific.value === 'allow'
          ? `permitida pela política da ferramenta (${specific.pattern})`
          : `pede aprovação pela política da ferramenta (${specific.pattern})`
    }
  }

  if (interaction) {
    return {
      exposed: true,
      policy: 'ask',
      explicit: true,
      source: 'meta',
      risk: baseRisk,
      reason: 'o servidor exige uma decisão humana a cada chamada'
    }
  }

  // The server default ("set all" in the connector settings) is the user's latest word, so it beats the catalog's
  // own approvalTools list.
  if (fallback) {
    if (fallback.value === 'deny') return hidden('toolPolicy-default', 'o padrão do servidor é negar (toolPolicy "*")')
    return {
      exposed: true,
      policy: fallback.value,
      explicit: true,
      source: 'toolPolicy-default',
      risk: baseRisk,
      reason: fallback.value === 'allow' ? 'permitida pelo padrão do servidor' : 'pede aprovação pelo padrão do servidor'
    }
  }

  if (matchesAnyToolPattern(config.approvalTools, toolName)) {
    return {
      exposed: true,
      policy: 'ask',
      explicit: true,
      source: 'approvalTools',
      risk: 'destructive',
      reason: 'a lista approvalTools do servidor exige aprovação'
    }
  }

  const readOnly = annotations?.readOnlyHint === true
  return {
    exposed: true,
    policy: readOnly ? 'allow' : 'ask',
    explicit: false,
    source: annotations ? 'annotation' : 'default',
    risk: baseRisk,
    reason: readOnly
      ? 'a ferramenta se declara somente leitura'
      : baseRisk === 'destructive'
        ? 'a ferramenta se declara destrutiva'
        : 'sem anotação de somente leitura: segue o modo de permissão do app'
  }
}

/** Approval override a registered tool carries: only an explicit user/server choice overrides the app mode. */
export function approvalOf(resolved: ResolvedToolPolicy): 'allow' | 'ask' | undefined {
  if (!resolved.exposed || !resolved.explicit) return undefined
  return resolved.policy === 'deny' ? undefined : resolved.policy
}
