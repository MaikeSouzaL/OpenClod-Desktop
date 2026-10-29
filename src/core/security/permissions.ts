import type { AgentMode, Decision, PermissionEffect, PolicyConfig } from '../../shared/types.js'
import type { ToolDef } from '../tools/types.js'
import { evaluateRulesFor } from './rules.js'
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
  /** Risk the decision was made with, when a per-call override (mcp_call) changed it. */
  risk?: ToolDef['risk']
}

const EXECUTE_TOOLS = new Set([
  'run_command',
  'start_process',
  'stop_process',
  'git_commit',
  'git_checkout',
  'computer_launch',
  'computer_open_path',
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
  // A tool that fronts other tools (mcp_call) resolves its target's risk and approval from the arguments.
  const call = tool.resolveCall?.(args)
  const effective: ToolDef =
    call && (call.risk || call.approval)
      ? { ...tool, ...(call.risk ? { risk: call.risk } : {}), ...(call.approval ? { approval: call.approval } : {}) }
      : tool
  // Hidden by the user's per-tool policy: a configuration, not a mode, so no permission mode lifts it.
  const base = call?.deny
    ? { decision: 'deny' as Decision, reason: call.deny }
    : evaluateToolBase(effective, preview, policy, cwd, args)
  return {
    ...base,
    action: tool.name,
    resource: preview,
    effect: effectOf(effective),
    risk: effective.risk
  }
}

function evaluateToolBase(
  tool: ToolDef,
  preview: string,
  policy: PolicyConfig,
  cwd: string = process.cwd(),
  args?: unknown
): { decision: Decision; reason: string } {
  // Explicit opt-in mode: the local harness itself imposes no decisions.
  // Provider-side refusals and operating-system permissions remain external.
  if (policy.mode === 'unrestricted') {
    // The one exception: a tool the user (or its server) marked "always ask" still asks, like Claude Code's
    // `anthropic/requiresUserInteraction` does in bypass mode.
    if (tool.approval === 'ask') return { decision: 'ask', reason: 'a ferramenta está configurada para sempre pedir aprovação' }
    return { decision: 'allow', reason: 'modo Ignorar permissões: sem bloqueios do harness' }
  }
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

  // Each command of a chain and each file of a patch is judged: allow needs all of them, deny or ask on one wins.
  const ruled = evaluateRulesFor(policy.rules, tool.name, preview, cwd, args)
  if (ruled) {
    const verb = ruled.decision === 'deny' ? 'negado' : ruled.decision === 'ask' ? 'pede confirmação' : 'permitido'
    return { decision: ruled.decision, reason: `${verb} pela regra ${ruled.rule}` }
  }

  // Per-tool choice from the MCP settings: below explicit rules, above the permission mode.
  if (tool.approval === 'ask') return { decision: 'ask', reason: 'ferramenta configurada para pedir aprovação' }
  if (tool.approval === 'allow' && policy.mode !== 'readonly') {
    return { decision: 'allow', reason: 'permitida pela política da ferramenta' }
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
    'code_intelligence', 'quality_discover',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot'
  ],
  plan: [
    'read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'browser_open', 'browser_navigate', 'browser_snapshot',
    'browser_read', 'browser_screenshot', 'browser_console',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write',
    'code_intelligence', 'quality_discover',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot', 'task', 'agent', 'list_agents'
  ],
  code: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_path',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log', 'git_commit', 'git_checkout',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents', 'external_agent',
    'code_intelligence', 'quality_discover', 'quality_run',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_open_path', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_wait_for_window', 'computer_secondary_action'
  ],
  debug: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents', 'external_agent',
    'code_intelligence', 'quality_discover', 'quality_run',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_open_path', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_wait_for_window', 'computer_secondary_action'
  ],
  review: [
    'read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'browser_open', 'browser_snapshot', 'browser_read',
    'browser_screenshot', 'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window',
    'computer_cursor_position', 'computer_snapshot', 'computer_screenshot',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'task', 'agent', 'list_agents'
    , 'code_intelligence', 'quality_discover'
  ],
  computer: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_path',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_open_path', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_wait_for_window', 'computer_secondary_action',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents'
    , 'code_intelligence', 'quality_discover', 'quality_run'
  ],
  web: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents',
    'code_intelligence', 'quality_discover', 'quality_run',
    'run_command', 'read_process_output', 'list_processes',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot'
  ],
  autonomous: [
    'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_path',
    'run_command', 'start_process', 'read_process_output', 'list_processes', 'stop_process', 'list_ports',
    'git_status', 'git_diff', 'git_log', 'git_commit', 'git_checkout',
    'fetch_url', 'web_search', 'download_file',
    'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
    'browser_press', 'browser_read', 'browser_screenshot', 'browser_console', 'browser_wait',
    'update_plan', 'list_skills', 'use_skill', 'memory_search', 'memory_write', 'task', 'agent', 'list_agents', 'external_agent',
    'code_intelligence', 'quality_discover', 'quality_run',
    'computer_list_apps', 'computer_list_windows', 'computer_window_at', 'computer_get_window', 'computer_cursor_position',
    'computer_snapshot', 'computer_screenshot', 'computer_click',
    'computer_mouse_move', 'computer_mouse_button',
    'computer_set_value', 'computer_type_text', 'computer_press_key', 'computer_scroll',
    'computer_drag', 'computer_launch', 'computer_open_path', 'computer_activate', 'computer_wait', 'computer_wait_for', 'computer_wait_for_window',
    'computer_secondary_action'
  ]
}

// Long-term project memory is orthogonal to the mode: every mode can read the
// briefing; writes still go through the normal risk/policy decision.
for (const tools of Object.values(MODE_TOOLS)) {
  for (const name of ['memory_brief', 'memory_page', 'memory_handoff', 'memory_recall']) {
    if (!tools.includes(name)) tools.push(name)
  }
  if (!tools.includes('document_extract')) tools.push('document_extract')
  for (const name of ['media_transcribe', 'media_ingest', 'media_view']) {
    if (!tools.includes(name)) tools.push(name)
  }
  if (!tools.includes('image_inspect')) tools.push('image_inspect')
  if (!tools.includes('image_generate')) tools.push('image_generate')
  if (!tools.includes('image_ocr')) tools.push('image_ocr')
  if (!tools.includes('web_research')) tools.push('web_research')
  // Reporting a harness limitation must work in every mode, including read-only.
  if (!tools.includes('report_limitation')) tools.push('report_limitation')
  // Asking the user for context is also mode-independent.
  if (!tools.includes('ask_user')) tools.push('ask_user')
  for (const name of ['browser_tabs', 'browser_new_tab', 'browser_claim_tab', 'browser_switch_tab', 'browser_close_tab']) {
    if (!tools.includes(name)) tools.push(name)
  }
  // Inspecting the page's traffic is read-only; every mode that can open the browser can read it.
  if (tools.includes('browser_open') && !tools.includes('browser_network')) tools.push('browser_network')
  // Rodar no terminal visível vai junto com os modos que já podem rodar comandos (mesma política de segurança).
  if (tools.includes('run_command') && !tools.includes('run_in_terminal')) tools.push('run_in_terminal')
  for (const name of ['mcp_search', 'mcp_servers', 'mcp_install', 'mcp_resource', 'mcp_prompt', 'mcp_read_resource', 'mcp_get_prompt', 'mcp_reload']) {
    if (!tools.includes(name)) tools.push(name)
  }
}

// Surgical edits are available wherever files can be written.
for (const mode of ['code', 'debug', 'web', 'autonomous'] as const) {
  if (!MODE_TOOLS[mode].includes('patch_file')) MODE_TOOLS[mode].push('patch_file')
  if (!MODE_TOOLS[mode].includes('apply_patch')) MODE_TOOLS[mode].push('apply_patch')
  if (!MODE_TOOLS[mode].includes('image_edit')) MODE_TOOLS[mode].push('image_edit')
}

// Reading and changing the page's cookies goes with the interactive browser (clicking, typing), not read-only modes.
for (const mode of ['code', 'debug', 'web', 'autonomous', 'computer'] as const) {
  if (!MODE_TOOLS[mode].includes('browser_cookies')) MODE_TOOLS[mode].push('browser_cookies')
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
