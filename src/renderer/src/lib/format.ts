import type { AgentMode, AuditLevel, RunState, SessionState, Usage } from '../../../shared/types'

export const MODE_LABELS: Record<AgentMode, string> = {
  ask: 'Perguntar',
  plan: 'Planejar',
  code: 'Código',
  debug: 'Depurar',
  review: 'Revisar',
  computer: 'Computer Use',
  web: 'Web',
  autonomous: 'Autônomo',
  loop: 'Loop Engineering',
  rea: 'REA Engineering'
}

export const MODE_HINTS: Record<AgentMode, string> = {
  ask: 'Investiga e responde sem alterar nada',
  plan: 'Produz um plano acionável, sem editar',
  code: 'Implementa, verifica e corrige',
  debug: 'Reproduz a falha e corrige a causa',
  review: 'Aponta bugs e riscos com arquivo:linha',
  computer: 'Controla aplicativos reais do Windows',
  web: 'Navega, coleta e cita fontes',
  autonomous: 'Executa uma tarefa longa de ponta a ponta',
  loop: 'Uma equipe de agentes repete até o juiz provar que terminou',
  rea: 'Engenharia reversa com o REA: binários, apps, JavaScript, Frida'
}

export const STATE_LABELS: Record<RunState, string> = {
  idle: 'Pronto',
  thinking: 'Pensando',
  streaming: 'Respondendo',
  tool: 'Executando ferramenta',
  waiting_approval: 'Aguardando aprovação',
  cancelled: 'Cancelado',
  error: 'Erro',
  done: 'Concluído'
}

export const RISK_LABELS: Record<string, string> = {
  read: 'leitura',
  write: 'escrita',
  exec: 'execução',
  network: 'rede',
  destructive: 'destrutivo'
}

export const TOOL_LABELS: Record<string, string> = {
  read_file: 'Ler arquivo',
  write_file: 'Escrever arquivo',
  edit_file: 'Editar arquivo',
  delete_path: 'Apagar',
  list_dir: 'Listar diretório',
  grep: 'Buscar conteúdo',
  glob: 'Buscar arquivos',
  run_command: 'Executar comando',
  agent: 'Chamar agente',
  list_agents: 'Listar agentes',
  external_agent: 'Agente externo',
  start_process: 'Iniciar processo',
  stop_process: 'Parar processo',
  list_ports: 'Listar portas',
  git_status: 'Git status',
  git_diff: 'Git diff',
  git_log: 'Git log',
  git_commit: 'Git commit',
  git_checkout: 'Git checkout',
  fetch_url: 'Buscar URL',
  web_search: 'Busca web',
  download_file: 'Baixar arquivo',
  browser_open: 'Abrir navegador',
  browser_navigate: 'Navegar',
  browser_snapshot: 'Inspecionar página',
  browser_click: 'Clicar na página',
  browser_type: 'Preencher campo',
  browser_press: 'Tecla na página',
  browser_read: 'Ler página',
  browser_screenshot: 'Screenshot da página',
  browser_console: 'Console do navegador',
  browser_wait: 'Esperar elemento',
  computer_list_windows: 'Janelas do Windows',
  computer_snapshot: 'Árvore de acessibilidade',
  computer_screenshot: 'Capturar tela',
  computer_click: 'Clique real',
  computer_set_value: 'Definir valor',
  computer_type_text: 'Digitar (real)',
  computer_press_key: 'Tecla (real)',
  computer_scroll: 'Rolar tela',
  computer_drag: 'Arrastar',
  computer_launch: 'Abrir aplicativo',
  computer_activate: 'Ativar janela',
  computer_wait: 'Aguardar',
  update_plan: 'Atualizar plano',
  list_skills: 'Listar skills',
  use_skill: 'Carregar skill',
  memory_search: 'Buscar memória',
  memory_write: 'Salvar memória',
  task: 'Chamar agente'
}

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__')
    return `MCP ${server}/${rest.join('_')}`
  }
  return name
}

export function toolFamily(name: string): string {
  if (name.startsWith('computer_')) return 'computer'
  if (name.startsWith('browser_')) return 'browser'
  if (name.startsWith('git_')) return 'git'
  if (name.startsWith('mcp__')) return 'mcp'
  if (['run_command', 'start_process', 'stop_process', 'list_ports'].includes(name)) return 'shell'
  if (['read_file', 'write_file', 'edit_file', 'delete_path', 'list_dir'].includes(name)) return 'file'
  if (['grep', 'glob'].includes(name)) return 'search'
  if (['fetch_url', 'web_search', 'download_file'].includes(name)) return 'web'
  if (name === 'task' || name === 'agent' || name === 'list_agents' || name === 'external_agent') return 'agent'
  return 'default'
}

export function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'agora'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} d`
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatUsage(usage: Usage): string {
  const total = usage.input + usage.output
  const cost = usage.costUsd ? ` · US$ ${usage.costUsd.toFixed(3)}` : ''
  return `${formatTokens(total)} tokens${cost}`
}

/**
 * Prompt size of the most recent model call. `session.usage` is cumulative and
 * must not be shown as the current context gauge.
 */
export function lastRequestTokens(session: SessionState | null): number {
  if (!session) return 0
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const usage = session.messages[index].usage
    if (usage) return usage.input + usage.output
  }
  return 0
}

export function levelLabel(level: AuditLevel | 'error'): string {
  if (level === 'blocked') return 'bloqueado'
  if (level === 'warn') return 'alerta'
  return 'info'
}

export function shortPath(file: string, max = 46): string {
  if (file.length <= max) return file
  const parts = file.split(/[\\/]/)
  if (parts.length < 3) return `…${file.slice(-max)}`
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}

export function basename(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}
