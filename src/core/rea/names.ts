import { auditedReaTools } from './policy.js'

/** Harness names of REA's tools: `rea_<tool>` (REA's own name after the prefix), plus `rea_status`. */
export const REA_TOOL_PREFIX = 'rea_'
export const REA_STATUS_TOOL = 'rea_status'

export function reaToolName(tool: string): string {
  return `${REA_TOOL_PREFIX}${tool}`
}

/** Every REA tool the "REA Engineering" mode may use: the whole audited catalog of the vendored release. */
export function reaModeToolNames(): string[] {
  return [REA_STATUS_TOOL, ...auditedReaTools().map(reaToolName)]
}
