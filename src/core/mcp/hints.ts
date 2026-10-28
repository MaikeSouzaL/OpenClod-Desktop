import type { McpServerSettings } from '../../shared/types.js'
import { DEFAULT_START_TIMEOUT_MS } from './limits.js'

/**
 * Turns a raw MCP connection/call error into the known fix, in pt-BR. Pure:
 * the same function serves `mcp_servers`, `mcp_call`, the direct tools and the
 * connectors screen. Returns undefined when the error has no known fix.
 */

type HintConfig = Partial<Pick<McpServerSettings, 'url' | 'headers' | 'command' | 'args' | 'type' | 'startTimeoutMs'>>

const CREDENTIAL_HEADER = /^(authorization|x-api-key|api-key|apikey|x-auth-token|private-token|x-.*(token|key|secret).*)$/i

function credentialHeaders(config: HintConfig | undefined): string[] {
  return Object.keys(config?.headers ?? {}).filter((key) => CREDENTIAL_HEADER.test(key))
}

function hostOf(config: HintConfig | undefined): string {
  try {
    return config?.url ? new URL(config.url).hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

function commandName(config: HintConfig | undefined, message: string): string {
  const fromConfig = (config?.command ?? '').trim().replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|bat)$/i, '')
  if (fromConfig) return fromConfig
  const spawned = /spawn\s+(\S+)\s+ENOENT/i.exec(message)
  return spawned?.[1]?.replace(/^.*[\\/]/, '') ?? 'o comando'
}

function installAdvice(command: string): string {
  switch (command.toLowerCase()) {
    case 'npx':
    case 'npm':
    case 'node':
    case 'pnpm':
    case 'yarn':
      return 'Instale o Node.js (que traz npx e npm) e reinicie o Openclod para ele entrar no PATH'
    case 'uvx':
    case 'uv':
      return 'Instale o uv (https://docs.astral.sh/uv/: o comando uvx vem com ele) e reinicie o Openclod'
    case 'docker':
      return 'Instale e inicie o Docker Desktop'
    case 'python':
    case 'python3':
    case 'py':
      return 'Instale o Python e confirme que o comando está no PATH'
    default:
      return `Instale "${command}" ou informe o caminho completo do executável no campo comando do conector`
  }
}

export function hintForMcpError(serverName: string, serverConfig: HintConfig | undefined, message: string): string | undefined {
  const text = String(message ?? '')
  if (!text.trim()) return undefined
  const lower = text.toLowerCase()
  const host = hostOf(serverConfig)
  const remote = Boolean(serverConfig?.url)
  const headers = credentialHeaders(serverConfig)
  const authorization = Object.keys(serverConfig?.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
  const unauthorized = /\b(401|403)\b|unauthorized|forbidden|invalid_token|não autorizad/i.test(text)

  // 1. Atlassian Rovo MCP: the organisation did not enable API-token auth for it.
  if (
    /don'?t have permission to connect via api token|missing the scope claim|api token.*(not|isn'?t).*(allowed|enabled)/i.test(text) ||
    (host.endsWith('atlassian.com') && unauthorized && authorization)
  ) {
    return (
      `O Rovo MCP da Atlassian (mcp.atlassian.com) não aceitou o token de API: a organização não liberou token de API para o Rovo MCP. ` +
      `Remova o cabeçalho Authorization do conector "${serverName}" e use "Entrar com OAuth" em Personalização → Conectores; ` +
      `ou use o conector local "jira" (uvx mcp-atlassian, com e-mail + token de API do Jira).`
    )
  }

  // 2. The server wants OAuth (401 with a resource_metadata challenge).
  if (/resource_metadata|www-authenticate/i.test(text) && !authorization) {
    return (
      `O servidor "${serverName}" exige login OAuth. Abra Personalização → Conectores, escolha este conector e use "Entrar com OAuth"; ` +
      `depois use mcp_reload para reconectar.`
    )
  }

  // 3. Dynamic client registration refused.
  if (
    /dynamic client registration|dynamic registration|registro din[aâ]mico|registration_endpoint|invalid_client_metadata|client registration (failed|is not|not)|does not support dynamic/i.test(text)
  ) {
    return (
      `O servidor "${serverName}" recusou o registro dinâmico de cliente OAuth: ele exige uma chave de API ou um client id pré-registrado. ` +
      `Use o conector com chave/cabeçalho de API (se o provedor oferecer) ou informe o client id registrado para o Openclod.`
    )
  }

  // 4. Static credential rejected.
  if (unauthorized && (remote || /http/i.test(text))) {
    if (headers.length) {
      return (
        `O servidor "${serverName}" recusou a credencial do cabeçalho (${headers.join(', ')}): o token pode estar inválido, expirado, sem permissão ` +
        `ou ser de outro ambiente. Gere um novo token, atualize o conector e use mcp_reload.`
      )
    }
    return (
      `O servidor "${serverName}" exige autenticação e o conector não tem credencial: adicione o cabeçalho da API (por exemplo Authorization: Bearer ...) ` +
      `ou, se o servidor suportar, use "Entrar com OAuth" em Personalização → Conectores.`
    )
  }

  // 5. Command not found (stdio).
  if (
    /spawn\s+\S+\s+ENOENT|\bENOENT\b.*spawn|n[ãa]o [ée] reconhecido como um comando|is not recognized as an internal or external command|command not found|no such file or directory.*(npx|uvx|node|python)/i.test(
      text
    )
  ) {
    const command = commandName(serverConfig, text)
    return `O comando "${command}" não foi encontrado. ${installAdvice(command)}; depois use mcp_reload.`
  }

  // 5b. uv could not unpack a package into its cache because a file was in use (an antivirus scanning it, a stuck Python
  // process, a damaged cache). A new cache folder works; seen with `uvx mcp-server-*` on Windows (pywin32 "os error 32").
  if (/failed to remove directory|failed to install:/i.test(text) && /uv[\\/]+cache|builds-v0|os error 32|sendo usado por outro processo|used by another process/i.test(text)) {
    return (
      `O uv não conseguiu instalar um pacote de "${serverName}": um arquivo do cache dele estava em uso (antivírus, processo Python preso ou cache danificado). ` +
      `Feche os programas Python/uv e tente de novo; se persistir, aponte o cache do uv para uma pasta nova (variável de ambiente UV_CACHE_DIR no conector, por exemplo ` +
      `C:\\uv-cache) ou rode "uv cache clean"; depois use mcp_reload.`
    )
  }

  // 6. Start timeout.
  if (/timeout de mcp .*\.(initialize|tools\/list)|tempo de partida|start timeout|esgotou o prazo de partida/i.test(text)) {
    const seconds = Math.round((serverConfig?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS) / 1000)
    return remote
      ? `O servidor "${serverName}" não respondeu em ${seconds} s. Confira a URL, a rede/VPN/proxy e se o serviço está no ar; aumente startTimeoutMs se ele for lento.`
      : `O servidor "${serverName}" não respondeu em ${seconds} s. Na primeira execução npx/uvx baixam pacotes e podem demorar: rode o comando uma vez no terminal ou aumente startTimeoutMs (padrão ${DEFAULT_START_TIMEOUT_MS / 1000} s).`
  }

  // 6b. Neither transport answered (a retired /sse endpoint, a wrong path).
  if (/nenhum transporte mcp funcionou/i.test(text)) {
    return `O endereço de "${serverName}" não fala MCP nem por HTTP nem por SSE. Confira a URL na documentação do provedor: muitos aposentaram o /sse (HTTP 410/404) e hoje usam /mcp.`
  }

  // 7. Wrong URL.
  if (remote && /\bHTTP 404\b/.test(text) && !/session|sess[aã]o/i.test(lower)) {
    return `A URL do conector "${serverName}" respondeu 404: confira o endereço (normalmente termina em /mcp ou /sse) na documentação do provedor.`
  }

  // 8a. A server on this very computer that is not listening: an app has to be open (Figma Desktop's MCP server, a dev server).
  if (remote && /ECONNREFUSED/i.test(text) && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1')) {
    return (
      `Sem conexão com "${serverName}": nada está ouvindo no endereço local ${serverConfig?.url}. Abra o aplicativo que oferece este servidor ` +
      `(por exemplo o Figma Desktop com o servidor MCP do modo Dev ligado); o Openclod tenta reconectar sozinho, ou use mcp_reload.`
    )
  }

  // 8. Network unreachable.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|getaddrinfo|network|socket hang up|conex[aã]o perdida/i.test(text)) {
    return remote
      ? `Sem conexão com "${serverName}": confira a URL, a internet, VPN/proxy e se o serviço está no ar. O Openclod tenta reconectar sozinho; use mcp_reload para forçar.`
      : `O servidor "${serverName}" encerrou a conexão. Veja o erro acima, corrija a causa e use mcp_reload.`
  }

  // 9. Protocol version.
  if (/vers[aã]o de protocolo|unsupported protocol version|protocol version/i.test(text)) {
    return `O servidor "${serverName}" usa uma versão do protocolo MCP que o Openclod não suporta (aceitas: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05). Atualize ou troque o servidor.`
  }

  // 10. Invalid params for a tool call.
  if (/MCP -32602|invalid params|invalid arguments|argumentos inv[aá]lidos/i.test(text)) {
    return `O servidor recusou os argumentos. Confira o schema da ferramenta (mcp_catalog com server e tool) e envie exatamente os campos pedidos.`
  }

  return undefined
}

/** Message followed by its hint on a new line, when there is one. */
export function withMcpHint(serverName: string, serverConfig: HintConfig | undefined, message: string): string {
  const hint = hintForMcpError(serverName, serverConfig, message)
  return hint ? `${message}\nDica: ${hint}` : message
}
