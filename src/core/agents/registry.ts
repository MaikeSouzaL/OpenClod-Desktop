import type { AgentDefinition, AgentLoadWarning, AgentsListing } from './types.js'
import { BUILTIN_AGENTS } from './definitions.js'
import { loadAgents, type LoadAgentsOptions } from './loader.js'

/** Per-agent and total room the listing may take in a tool description. */
const MAX_DESCRIPTION_CHARS = 240
const MAX_LISTING_CHARS = 12_000

export class AgentRegistry {
  private readonly byName = new Map<string, AgentDefinition>()

  constructor(
    agents: Iterable<AgentDefinition> = BUILTIN_AGENTS,
    readonly warnings: readonly AgentLoadWarning[] = []
  ) {
    for (const agent of agents) this.byName.set(agent.name, agent)
  }

  get(name: string): AgentDefinition | undefined {
    return this.byName.get(name)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  names(): string[] {
    return [...this.byName.keys()]
  }

  /** Definitions in load order; hidden utilities are left out unless asked for. */
  list(options: { includeHidden?: boolean } = {}): AgentDefinition[] {
    const all = [...this.byName.values()]
    return options.includeHidden ? all : all.filter((agent) => !agent.hidden)
  }

  /**
   * Agents `caller` may delegate to. `undefined` is the user's own session,
   * which may call every visible agent. Hidden agents are never callable.
   */
  callableBy(caller?: string): AgentDefinition[] {
    const visible = this.list()
    if (caller === undefined) return visible
    const def = this.byName.get(caller)
    if (!def?.canCall) return []
    if (def.canCall === '*') return visible
    const allowed = new Set(def.canCall)
    return visible.filter((agent) => allowed.has(agent.name))
  }

  canCall(caller: string | undefined, target: string): boolean {
    return this.callableBy(caller).some((agent) => agent.name === target)
  }

  listing(): AgentsListing {
    return { agents: this.list({ includeHidden: true }), warnings: [...this.warnings] }
  }
}

/** Built-ins plus the user/project folders (see loadAgents for the precedence). Cheap enough to call per session. */
export function createAgentRegistry(options: LoadAgentsOptions = {}): AgentRegistry {
  const loaded = loadAgents(options)
  return new AgentRegistry(loaded.agents, loaded.warnings)
}

/** One line: `- name: description`, with the description flattened and capped. */
export function agentLine(agent: AgentDefinition, maxChars = MAX_DESCRIPTION_CHARS): string {
  const flat = agent.description.replace(/\s+/g, ' ').trim()
  return `- ${agent.name}: ${flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat}`
}

/** The agents section of the `agent` tool description. Bounded so a big imported library cannot flood it. */
export function formatAgentListing(agents: AgentDefinition[]): string {
  if (!agents.length) return '(nenhum agente disponível para você)'
  const lines: string[] = []
  let used = 0
  for (const agent of agents) {
    const line = agentLine(agent)
    if (used + line.length > MAX_LISTING_CHARS) {
      lines.push(`- (+${agents.length - lines.length} agentes; chame list_agents para ver todos)`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}
