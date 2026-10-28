// Tipos de scripts/lib/mcp-probe-core.mjs (para os testes em TypeScript).
import type { ConnectorAuth, ConnectorProbe, DirectoryConnector } from '../../src/shared/mcp-connectors'

export const PROBE_USER_AGENT: string
export const PROBE_PROTOCOL_VERSION: string

export interface WwwChallenge {
  scheme: string
  params: Record<string, string>
}
export function parseWwwAuthenticate(header: string | null | undefined): WwwChallenge[]
export function resourceMetadataFromHeader(header: string | null | undefined): string | undefined
export function protectedResourceMetadataCandidates(resourceUrl: string): string[]
export function authServerMetadataCandidates(issuer: string): string[]

export interface SseEvent {
  event: string
  data: string
  id?: string
}
export function parseSseEvents(text: string): SseEvent[]
export function jsonRpcMessages(text: string, contentType?: string): Array<Record<string, any>>
export function isInitializeResult(message: unknown): boolean
export function detectWaf(status: number, headers: { get(name: string): string | null } | Record<string, string> | undefined, body: string | undefined): boolean
export function mentionsApiKey(text: string | undefined): boolean

export interface NetworkError {
  kind: 'dns' | 'timeout' | 'tls' | 'refused' | 'reset' | 'blocked' | 'other'
  message?: string
}
export function describeNetworkError(error: NetworkError | undefined): string
export function classifyNetworkError(err: unknown): NetworkError

export function probeLevel(probe: ConnectorProbe | undefined | null): 0 | 1 | 2 | 3 | 4 | null

export interface ProbeEvidence {
  reachable?: boolean
  error?: NetworkError
  status?: number
  wwwAuthenticate?: string
  authBody?: string
  waf?: boolean
  rateLimited?: boolean
  redirectedTo?: string
  redirectBlocked?: string
  stateless?: string
  versionMismatch?: string[]
  initialize?: { ok: boolean; rpcError?: string }
  transport?: 'http' | 'sse'
  tools?: { ok: boolean; count?: number; status?: number; error?: string; names?: string[] }
  prm?: { found: boolean; advertised?: boolean; via?: 'header' | 'well-known'; authorizationServers?: string[]; scopesSupported?: string[] }
  as?: { found: boolean; issuer?: string; registrationEndpoint?: string; codeChallengeMethods?: string[]; scopesSupported?: string[]; via?: string; cimd?: boolean }
  sse?: { endpointEvent: boolean; status?: number }
}

export interface ProbeClassification {
  auth: ConnectorAuth
  probe: ConnectorProbe
  level: 0 | 1 | 2 | 3 | 4 | null
  scopes?: string[]
}
export function classifyProbe(evidence?: ProbeEvidence, now?: number): ProbeClassification
export function applyProbe(entry: DirectoryConnector, result: ProbeClassification, evidence?: ProbeEvidence): DirectoryConnector
