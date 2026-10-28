// Tipos de scripts/mcp-probe.mjs (para os testes em TypeScript).
import type { NetworkError, ProbeEvidence } from './lib/mcp-probe-core'

export interface ProbeHttpOptions {
  timeoutMs?: number
  minGapMs?: number
  allowPrivate?: boolean
  maxRetryAfterMs?: number
  userAgent?: string
}
export interface ProbeHttp {
  stats: { requests: number; byHost: Map<string, number> }
  opts: Required<ProbeHttpOptions>
  blockedReason(url: string): string | null
  request(url: string, init?: Record<string, unknown>): Promise<{ status?: number; text?: string; error?: NetworkError }>
}
export function createHttp(options?: ProbeHttpOptions): ProbeHttp
export function probeUrl(
  url: string,
  options?: ProbeHttpOptions & { http?: ProbeHttp; retryDelayMs?: number }
): Promise<{ evidence: ProbeEvidence & { durationMs?: number }; requests?: number }>
