import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServerSettings } from '../shared/types.js'
import { normalizeMcpServerSettings } from '../core/mcp/client.js'
import { BUILTIN_AGENTS } from '../core/agents/definitions.js'

export interface ClaudeImportReport {
  skills: number
  agents: number
  mcp: number
  mcpNames: string[]
  sources: string[]
  plugins: number
  warnings: string[]
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function copyDirContents(from: string, to: string): number {
  let copied = 0
  try {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      try {
        fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
        copied++
      } catch {
        /* a locked or already-existing item must not abort the import */
      }
    }
  } catch {
    /* missing source folder */
  }
  return copied
}

function copyMarkdownFiles(from: string, to: string): number {
  let copied = 0
  // A Claude agent must never shadow an Openclod built-in (orchestrator,
  // planner, tester...): the built-in prompt is part of the product contract.
  const reserved = new Set(BUILTIN_AGENTS.map((agent) => agent.name))
  try {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const name = entry.name.slice(0, -3)
      const target = path.join(to, entry.name)
      if (reserved.has(name)) {
        // Remove an exact copy from an earlier import; never touch an edited file.
        try {
          const sourceRaw = fs.readFileSync(path.join(from, entry.name), 'utf8')
          const normalize = (raw: string): string => raw.replace(/^model\s*:.*$/m, 'model: inherit')
          if (normalize(fs.readFileSync(target, 'utf8')) === normalize(sourceRaw)) fs.unlinkSync(target)
        } catch {
          /* nothing to remove */
        }
        continue
      }
      try {
        fs.copyFileSync(path.join(from, entry.name), target, fs.constants.COPYFILE_EXCL)
        // Claude Code agent files often pin a Claude model (opus/sonnet). In
        // Openclod that model may not exist, so imported agents inherit the
        // caller's best available model instead of failing at spawn time.
        try {
          const raw = fs.readFileSync(target, 'utf8')
          if (/^model\s*:/m.test(raw)) {
            fs.writeFileSync(target, raw.replace(/^model\s*:.*$/m, 'model: inherit'), 'utf8')
          }
        } catch {
          /* keep the file as copied */
        }
        copied++
      } catch {
        // Existing copy: if it is still byte-identical to the Claude source,
        // it was imported before the model normalization and can be fixed.
        try {
          const sourceRaw = fs.readFileSync(path.join(from, entry.name), 'utf8')
          if (fs.readFileSync(target, 'utf8') === sourceRaw && /^model\s*:/m.test(sourceRaw)) {
            fs.writeFileSync(target, sourceRaw.replace(/^model\s*:.*$/m, 'model: inherit'), 'utf8')
          }
        } catch {
          /* user-edited file: never touch it */
        }
      }
    }
  } catch {
    /* missing source folder */
  }
  return copied
}

function mcpFrom(value: unknown): McpServerSettings[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out: McpServerSettings[] = []
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    try {
      const type = raw.type === 'sse' || raw.type === 'http' ? raw.type : raw.url ? 'http' : 'stdio'
      const server = normalizeMcpServerSettings({
        name,
        command: raw.command ?? '',
        args: raw.args ?? [],
        env: raw.env,
        type,
        url: raw.url,
        headers: raw.headers,
        enabled: true,
        cwd: raw.cwd
      })
      if (server.name) {
        // Keep a missing local binary registered but disabled, so the user can
        // fix the path instead of seeing the whole startup fail.
        if (server.command && path.isAbsolute(server.command) && !fs.existsSync(server.command)) {
          server.enabled = false
        }
        out.push(server)
      }
    } catch {
      /* skip malformed entries */
    }
  }
  return out
}

/**
 * Imports the user's Claude Desktop/Code catalog into Openclod:
 * skills, agents and MCP server definitions. It never deletes anything and
 * never overwrites an existing skill/agent file (COPYFILE_EXCL / force:false).
 * MCP environment values stay in the local settings file, as they do in Claude.
 */
export function importClaudeCatalog(options: {
  userData: string
  homeDir?: string
  appData?: string
}): { report: ClaudeImportReport; servers: McpServerSettings[] } {
  const home = options.homeDir ?? os.homedir()
  const appData = options.appData ?? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const claude = path.join(home, '.claude')
  const report: ClaudeImportReport = { skills: 0, agents: 0, mcp: 0, mcpNames: [], sources: [], plugins: 0, warnings: [] }

  report.skills = copyDirContents(path.join(claude, 'skills'), path.join(options.userData, 'skills'))
  report.agents = copyMarkdownFiles(path.join(claude, 'agents'), path.join(options.userData, 'agents'))

  const mcp = new Map<string, McpServerSettings>()
  const files = [
    path.join(claude, 'settings.json'),
    path.join(home, '.claude.json'),
    path.join(appData, 'Claude', 'claude_desktop_config.json')
  ]
  for (const file of files) {
    const json = readJson(file)
    if (!json) continue
    const list = mcpFrom(json.mcpServers)
    if (!list.length) continue
    report.sources.push(file)
    for (const server of list) if (!mcp.has(server.name)) mcp.set(server.name, server)
  }
  report.mcp = mcp.size
  report.mcpNames = [...mcp.keys()]

  const catalogCandidates = [
    path.join(options.userData, 'catalog', 'claude-plugins-official.json'),
    path.join(process.cwd(), 'resources', 'catalog', 'claude-plugins-official.json')
  ]
  for (const catalog of catalogCandidates) {
    const parsed = readJson(catalog) as { count?: number } | null
    if (parsed?.count) {
      report.plugins = parsed.count
      break
    }
  }
  return { report, servers: [...mcp.values()] }
}

/** Same as importClaudeCatalog, but returns the servers so the app can save them. */
export function readClaudeCatalog(options: { userData: string; homeDir?: string; appData?: string }): {
  report: ClaudeImportReport
  servers: McpServerSettings[]
} {
  return importClaudeCatalog(options)
}
