import type { RiskLevel } from '../../shared/types.js'
import { TOOL_EFFECTS, toolReturnsTargetContent, type ToolEffects } from '../../../vendor/rea/src/contracts/toolEffects.js'

/**
 * Risk and approval of each REA tool, derived from REA's own effect audit (vendor/rea/src/contracts/toolEffects.ts, the
 * same table REA turns into its MCP annotations). No tool-name lists here: a tool REA audits as running foreign code or
 * changing a device asks the user even in the auto and unrestricted modes, whatever it is called.
 *
 *   always ask (destructive) runs code REA does not own (Frida scripts, debuggers, captured scenarios), changes an attached
 *                            Android device (install, push, start/stop apps), drives an application's UI, or changes a live
 *                            target (a process, a page) it reached through a launched process or the network
 *   write                    writes where the caller says (output_directory, overwrite...) or edits the analysis database
 *                            (names, comments, bookmarks): follows the permission mode, like write_file
 *   network                  reaches the network or a device bridge without changing anything
 *   read                     everything else: reading the target, REA's own engines and temporary files
 */

export type { ToolEffects }

export interface ReaToolPolicy {
  risk: RiskLevel
  /** 'ask' asks on every call, in every permission mode. */
  approval?: 'ask'
  /** The result can carry text written by the analysed target (strings, code, pages, logs): data, never instructions. */
  untrustedOutput: boolean
  /** One line in pt-BR saying why. */
  reason: string
}

/** Parameters through which a caller chooses where REA writes on disk. */
const CALLER_PATH_PARAM = /^(output|out|destination|dest|export|save)(_(directory|dir|path|file|folder))?$|^overwrite$/i

/** Unknown tools (a newer REA than the audit) are treated as the riskiest kind until audited. */
const UNAUDITED: ToolEffects = {
  mutatesTarget: true,
  mutatesSession: true,
  writesFilesystem: true,
  launchesProcess: true,
  accessesNetwork: true,
  changesUiState: true,
  mayDiscardData: true,
  executesForeignCode: true,
  mutatesDevice: true,
  idempotent: false
}

export function reaToolEffects(tool: string): ToolEffects | null {
  return Object.prototype.hasOwnProperty.call(TOOL_EFFECTS, tool) ? TOOL_EFFECTS[tool] : null
}

function schemaParams(inputSchema: unknown): string[] {
  const properties = (inputSchema as { properties?: unknown } | undefined)?.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? Object.keys(properties) : []
}

export function reaToolPolicy(tool: string, inputSchema?: unknown): ReaToolPolicy {
  const audited = reaToolEffects(tool)
  const e = audited ?? UNAUDITED
  const untrustedOutput = toolReturnsTargetContent(tool)
  if (!audited) return { risk: 'destructive', approval: 'ask', untrustedOutput, reason: 'ferramenta sem auditoria de efeitos nesta versão do REA' }

  const live = e.launchesProcess || e.accessesNetwork
  // goto_address only moves the cursor of the analysis UI: changesUiState with no other effect is not an app being driven.
  const drivesUi = e.changesUiState && (e.mutatesTarget || e.executesForeignCode || e.writesFilesystem)
  if (e.executesForeignCode) return { risk: 'destructive', approval: 'ask', untrustedOutput, reason: 'executa código que o REA não controla no alvo ou na máquina' }
  if (e.mutatesDevice) return { risk: 'destructive', approval: 'ask', untrustedOutput, reason: 'altera o aparelho Android conectado' }
  if (drivesUi) return { risk: 'destructive', approval: 'ask', untrustedOutput, reason: 'aciona a interface de um aplicativo' }
  if (e.mutatesTarget && live) return { risk: 'destructive', approval: 'ask', untrustedOutput, reason: 'altera um processo ou página em execução' }

  const callerPath = e.writesFilesystem && schemaParams(inputSchema).some((name) => CALLER_PATH_PARAM.test(name))
  if (callerPath || (e.writesFilesystem && e.mayDiscardData)) return { risk: 'write', untrustedOutput, reason: 'grava arquivos no disco' }
  if (e.mutatesTarget) return { risk: 'write', untrustedOutput, reason: 'edita o banco de análise (nomes, comentários, marcadores)' }
  if (e.accessesNetwork) return { risk: 'network', untrustedOutput, reason: 'usa a rede ou a ponte do aparelho, sem alterar nada' }
  return { risk: 'read', untrustedOutput, reason: 'só lê o alvo (motores e arquivos temporários do próprio REA)' }
}

/** Names of every audited REA tool. */
export function auditedReaTools(): string[] {
  return Object.keys(TOOL_EFFECTS).sort()
}
