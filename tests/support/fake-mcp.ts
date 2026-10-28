import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { McpServerConfig } from '../../src/core/mcp/client'

/** Shared helpers of the MCP tests that talk to the fake servers in this folder. Test double only. */

export const FAKE_STDIO_PATH = fileURLToPath(new URL('./fake-mcp-stdio.cjs', import.meta.url))

/** A client config that runs the fake stdio server with these options (see fake-mcp-core.cjs / fake-mcp-stdio.cjs). */
export function fakeStdio(name: string, options: Record<string, unknown> = {}, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, command: process.execPath, args: [FAKE_STDIO_PATH], env: { FAKE_MCP: JSON.stringify(options) }, ...extra }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readPid(file: string): number {
  return Number(fs.readFileSync(file, 'utf8'))
}

/** Polls until the condition holds or the time runs out (then the assertion that follows reports what is wrong). */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 6_000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return Boolean(await condition())
}
