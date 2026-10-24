import type { AgentMode, Decision, PermissionEffect, PolicyConfig } from '../../shared/types.js'
import type { ToolDef } from '../tools/types.js'
import { evaluateRules } from './rules.js'
import { checkSensitiveAccess, sensitiveReason } from './sensitive.js'

/** Tools whose effects can be irreversible or visible to third parties. */
const ALWAYS_CONFIRM = new Set([
  'write_file',
  'edit_file',
  'delete_path',
  'run_command',
  'start_process',
  'stop_process',
  'git_commit',
  'git_checkout',
  'browser_click',
  'browser_type',
  'browser_press',
  'computer_click',
  'computer_set_value',
  'computer_type_text',
  'computer_press_key',
  'computer_drag',
  'computer_scroll',
  'computer_launch',
  'computer_activate'
])

export interface Evaluation {
  decision: Decision
  reason: string
  /** Tool/action name. */
  action: string
  /** Concrete subject the tool will touch (command, path, URL, element). */
  resource: string
  /** Effect on the machine or on external systems. */
  effect: PermissionEffect
  /** Rule that decided it, when a rule matched. */
  rule?: string
}

const EXECUTE_TOOLS = new Set([
  'run_command',
  'start_process',
  'stop_process',
  'git_commit',
  'git_checkout',
  'computer_launch',
  'computer_activate'
])

const CONTROL_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'computer_click',
  'computer_mouse_move',
  'computer_mouse_button',
  'computer_set_value',
  'computer_type_text',
  'computer_press_key',
  'computer_scroll',
  'computer_drag',
  'computer_secondary_action'
])

export function effectOf(tool: ToolDef): PermissionEffect {
  if (CONTROL_TOOLS.has(tool.name)) return 'control'
  if (tool.risk === 'destructive') return 'destructive'
  if (tool.risk === 'read') return 'read'
  if (tool.risk === 'network') return 'network'
  if (EXECUTE_TOOLS.has(tool.name)) return 'execute'
  return 'write'
}

/**
 * Order: credential-location hard block → hard caps (read-only mode, network
 * switch) → explicit rules (deny > ask > allow, matched against the tool's
 * preview: command, path or URL) → the permission mode.
 *
 * `args` are the validated tool arguments. They are optional for backwards
 * compatibility, but the credential check needs them for tools whose preview
 * is not the path (grep/glob show the pattern, download_file shows the URL).
 */
export function evaluateTool(
  tool: ToolDef,
  preview: string,
  policy: PolicyConfig,
  cwd: string = process.cwd(),
  args?: unknown
): Evaluation {
  const base = evaluateToolBase(tool, preview, policy, cwd, args)
  return {
    ...base,
    action: tool.name,
    resource: preview,
    effect: effectOf(tool)
  }
}

function evaluateToolBase(
  tool: ToolDef,
  preview: string,
  policy: PolicyConfig,
  cwd: string = process.cwd(),
  args?: unknown
): { decision: Decision; reason: string } {
  // Not a rule: it cannot be overridden by an allow rule, a hook or any mode.
  const sensitive = checkSensitiveAccess(tool.name, preview, args, { cwd })
  if (sensitive) return { decision: 'deny', reason: sensitiveReason(sensitive, tool.name) }

  if (policy.mode === 'readonly') {
    if (tool.risk !== 'read') {
      return { decision: 'deny', reason: 'modo somente leitura permite apenas ferramentas de leitura' }
    }
  }

  if (tool.requires === 'network' && !policy.allowNetwork) {
    return { decision: 'deny', reason: 'acesso de rede desativado nas configurações' }
  }

  const ruled = evaluateRules(policy.rules, tool.name, preview, cwd)
  if (ruled) {
    const verb = ruled.decision === 'deny' ? 'negado' : ruled.decision === 'ask' ? 'pede confirmação' : 'permitido'
    return { decision: ruled.decision, reason: `${verb} pela regra ${ruled.rule}` }
  }

  if (policy.mode === 'readonly') return { decision: 'allow', reason: 'modo somente leitura' }

  switch (policy.mode) {
    case 'auto':
      if (tool.risk === 'destructive') return { decision: 'ask', reason: 'operações destrutivas sempre pedem confirmação' }
      return { decision: 'allow', reason: 'modo automático' }

    case 'accept-edits':
      if (tool.risk === 'read') return { decision: 'allow', reason: 'leitura' }
      if (tool.risk === 'write' && !ALWAYS_CONFIRM.has(tool.name)) return { decision: 'allow', reason: 'edições aceitas' }
      if (tool.risk === 'write' && ['write_file', 'edit_file'].includes(tool.name))
        return { decision: 'allow', reason: 'edições aceitas pelo modo' }
      return { decision: 'ask', reason: 'comando/ação sensível' }

    case 'ask':
    default:
      if (tool.risk === 'read') return { decision: 'allow', reason: 'leitura' }
      if (tool.risk === 'network' && !ALWAYS_CONFIRM.has(tool.name))
        return { decision: 'allow', reason: 'leitura de rede' }
      return { decision: 'ask', reason: 'requer aprovação do usuário' }
  }
}

const MODE_TOOLS: Record<AgentMode, string[]> = {
  ask: [
    'read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'browser_open', 'browser_navigate', 'browser_snapshot',
    'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write',
    'computer_list_windows', 'computer_snapshot', 'computer_screenshot'
  ],
  plan: [
    'read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'browser_open', 'browser_navigate', 'browser_snapshot',
    'browser_read', 'browser_screenshot', 'browser_console',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write',
    'computer_list_windows', 'computer_snapshot', 'computer_screenshot', 'task', 'agent', 'list_agents'
  ],
  code: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_path',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log', 'git_commit', 'git_checkout',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents', 'external_agent',
    'computer_list_windows', 'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_secondary_action'
  ],
  debug: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents', 'external_agent',
    'computer_list_windows', 'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_secondary_action'
  ],
  review: [
    'read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'browser_open', 'browser_snapshot', 'browser_read',
    'browser_screenshot', 'update_plan', 'list_skills', 'use_skill', 'memory_search', 'task', 'agent', 'list_agents'
  ],
  computer: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_path',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'computer_list_windows', 'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_secondary_action',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents'
  ],
  web: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents',
    'run_command', 'read_process_output', 'list_processes'
  ],
  autonomous: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_path',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log', 'git_commit', 'git_checkout',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents', 'external_agent',
    'computer_list_windows', 'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_activate', 'computer_wait', 'computer_wait_for',
    'computer_secondary_action'
  ]
}

// Long-term project memory is orthogonal to the mode: every mode can read the
// briefing; writes still go through the normal risk/policy decision.
for (const tools of Object.values(MODE_TOOLS)) {
  for (const name of ['memory_brief', 'memory_page', 'memory_handoff', 'memory_recall']) {
    if (!tools.includes(name)) tools.push(name)
  }
  if (!tools.includes('web_research')) tools.push('web_research')
  for (const name of ['browser_tabs', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab']) {
    if (!tools.includes(name)) tools.push(name)
  }
  for (const name of ['mcp_search', 'mcp_servers', 'mcp_install']) {
    if (!tools.includes(name)) tools.push(name)
  }
}

// Surgical edits are available wherever files can be written.
for (const mode of ['code', 'debug', 'web', 'autonomous'] as const) {
  if (!MODE_TOOLS[mode].includes('patch_file')) MODE_TOOLS[mode].push('patch_file')
}

// Growing the roster is a coding/autonomous capability, never a read-only one.
for (const mode of ['code', 'debug', 'autonomous'] as const) {
  if (!MODE_TOOLS[mode].includes('create_agent')) MODE_TOOLS[mode].push('create_agent')
}

export function toolsForMode(mode: AgentMode): string[] {
  return MODE_TOOLS[mode] ?? MODE_TOOLS.ask
}

export function modeAllowsWrite(mode: AgentMode): boolean {
  return ['code', 'debug', 'web', 'autonomous'].includes(mode)
}
