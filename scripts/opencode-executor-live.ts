import { createExternalAgentTool } from '../src/core/tools/external-agent'
import { WorkspaceGuard } from '../src/core/security/policy'
import type { ToolContext } from '../src/core/tools/types'
import type { HarnessEvent, PolicyConfig } from '../src/shared/types'

async function main(): Promise<void> {
  const cwd = process.cwd()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  const policy: PolicyConfig = {
    mode: 'unrestricted',
    blockedCommands: [],
    allowedRoots: [],
    allowNetwork: true,
    allowComputerControl: true,
    shellTimeoutSec: 180
  }
  const notices: string[] = []
  const ctx = {
    sessionId: 'opencode-executor-live',
    cwd,
    mode: 'code',
    policy,
    workspace: new WorkspaceGuard([cwd]),
    signal: controller.signal,
    emit: (event: HarnessEvent) => {
      if (event.type === 'notice') notices.push(event.text)
    },
    log: () => undefined
  } as unknown as ToolContext

  try {
    const result = await createExternalAgentTool().execute({
      agent: 'opencode',
      prompt: 'Responda apenas a palavra PONG e nao use ferramentas.',
      model: process.env.FORJA_OPENCODE_MODEL?.trim() || 'opencode/beam-free',
      timeout_ms: 180_000
    }, ctx)
    if (!result.ok) throw new Error(result.text)
    console.log(JSON.stringify({
      ok: true,
      model: process.env.FORJA_OPENCODE_MODEL?.trim() || 'opencode/beam-free',
      answer: result.data?.answer ?? result.text.split('\n')[0],
      sessionId: result.data?.sessionId,
      usage: result.data?.usage,
      progressEvents: notices.length
    }, null, 2))
  } finally {
    clearTimeout(timer)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
