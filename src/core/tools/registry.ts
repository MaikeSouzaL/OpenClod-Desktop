import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolSpec } from '../../shared/types.js'
import type { ToolDef } from './types.js'
import { externalAgentTools } from './external-agent.js'

export { externalAgentTool, externalAgentTools } from './external-agent.js'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()

  register(...tools: ToolDef[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`ferramenta duplicada: ${tool.name}`)
      this.tools.set(tool.name, tool)
    }
    return this
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  list(filter?: string[]): ToolDef[] {
    const all = [...this.tools.values()]
    if (!filter) return all
    const set = new Set(filter)
    return all.filter((t) => set.has(t.name))
  }

  /** Tool specifications sent to the model. */
  specs(filter?: string[]): ToolSpec[] {
    return this.list(filter).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema
        ? tool.jsonSchema
        : (zodToJsonSchema(tool.schema, {
            $refStrategy: 'none',
            target: 'jsonSchema7'
          }) as Record<string, unknown>)
    }))
  }
}

export function buildRegistry(...tools: ToolDef[]): ToolRegistry {
  return new ToolRegistry().register(...tools)
}

/**
 * Adds the tools that delegate work to other coding agents (`external_agent`).
 * Call it where the per-domain tool arrays (fs, shell, git...) are registered.
 */
export function registerExternalAgents(registry: ToolRegistry): ToolRegistry {
  return registry.register(...externalAgentTools)
}
