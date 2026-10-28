/**
 * Teste dos conectores do diretorio (resources/mcp-directory.json) pelo CODIGO REAL do Openclod, ate onde da sem a conta
 * do usuario. Nada aqui entra em conta alguma, digita senha, cria conta, escreve ou envia dados.
 *
 *   node scripts/mcp-connectors-test.cjs [opcoes]        (empacota este arquivo com esbuild e roda)
 *   npm run test:connectors -- [opcoes]
 *
 *   --only a,b        so estes ids                      --retest failed,blocked,...  so quem terminou assim no JSON
 *   --skip-local      nao sobe servidores locais        --skip-remote  so os locais
 *   --concurrency N   remotos em paralelo (padrao 10)   --local-concurrency N (padrao 2)  --local-timeout S (padrao 120)
 *   --no-write        nao grava JSON/relatorio          --note "texto"  anota a correcao nos registros testados de novo
 *   --report-only     so regenera o relatorio a partir do JSON gravado
 *
 * Por conector remoto com URL:
 *   1. McpClient (o cliente real, SEM credenciais): initialize + tools/list; se for aberto e houver uma ferramenta
 *      somente-leitura sem argumentos obrigatorios (readOnlyHint), chama UMA para provar a chamada.
 *   2. oauth / oauth-static / unknown: o ensaio do ConnectorService (`connect(id, { dryRun })`): descoberta, UM registro
 *      dinamico descartavel (e o que o app faz na primeira conexao; nada e guardado) e a URL de autorizacao com PKCE.
 *   3. api-key: 401/403 + dica pt-BR e o formulario gerado pelas `credentials` do diretorio.
 * Locais (stdio): sobe pelo McpClient num diretorio temporario, com variaveis minimas; os que exigem segredo so
 * precisam ser recusados com mensagem clara.
 *
 * Etiqueta: User-Agent Openclod-Desktop-ConnectorTest/1.0, UMA tentativa por conector, no maximo 1 requisicao por segundo
 * por host (fila entre todos os chamadores), backoff em 429, concorrencia ~10.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { McpClient, type McpServerConfig } from '../src/core/mcp/client'
import { hintForMcpError } from '../src/core/mcp/hints'
import { ConnectorService, looksUnauthorized, serverNameFor } from '../src/main/connector-service'
import { McpOAuthManager } from '../src/main/mcp-oauth'
import { MCP_OAUTH_REDIRECT_URI, type DirectoryConnector } from '../src/shared/mcp-connectors'
import type { McpServerSettings } from '../src/shared/types'
import { credentialFields, isSecretField } from '../src/renderer/src/lib/connectors'
import {
  TEST_USER_AGENT,
  authHostOf,
  blockedReason,
  classifyRemote,
  createThrottledFetch,
  mergeRecords,
  parseClientError,
  pickSafeTool,
  summarize,
  type ConnectorTestRecord,
  type DryRunFacts,
  type Outcome,
  type TestStep
} from './lib/mcp-connectors-test-core'
import { buildReport } from './lib/mcp-connectors-test-report'

const ROOT = path.resolve(__dirname, '..')
const DIRECTORY_FILE = path.join(ROOT, 'resources', 'mcp-directory.json')
const RESULT_FILE = path.join(ROOT, 'docs', 'mcp', 'teste-conectores.json')
const REPORT_FILE = path.join(ROOT, 'docs', 'mcp', 'TESTE-CONECTORES-2026-10-27.md')
const FIXES_FILE = path.join(ROOT, 'scripts', 'data', 'mcp-connectors-test-fixes.json')

/* --------------------------------- argumentos -------------------------------- */

const argv = process.argv.slice(2)
const has = (flag: string): boolean => argv.includes(flag)
const value = (flag: string): string | undefined => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}
const numberOf = (flag: string, fallback: number): number => {
  const parsed = Number(value(flag))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const REMOTE_CONCURRENCY = numberOf('--concurrency', 10)
const LOCAL_CONCURRENCY = numberOf('--local-concurrency', 2)
const LOCAL_TIMEOUT_MS = numberOf('--local-timeout', 120) * 1000
const REMOTE_START_MS = 20_000
const REMOTE_DEADLINE_MS = 120_000
const WRITE = !has('--no-write')

/* ------------------------------ ambiente isolado ----------------------------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-connectors-test-'))

/**
 * Variaveis minimas para os servidores locais (e para tudo o que este processo dispara): nada de chaves de API do shell do
 * usuario, e o "home" aponta para uma pasta temporaria (o npm/uv seguem usando o cache real em LOCALAPPDATA).
 */
function isolateEnvironment(): void {
  const keep = new Set(
    [
      'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
      'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'COMPUTERNAME', 'LOCALAPPDATA', 'APPDATA', 'ALLUSERSPROFILE', 'PUBLIC'
    ].map((name) => name.toUpperCase())
  )
  const saved: Record<string, string> = {}
  for (const [key, val] of Object.entries(process.env)) if (val !== undefined && keep.has(key.toUpperCase())) saved[key] = val
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, saved)
  const home = path.join(TMP, 'home')
  const temp = path.join(TMP, 'temp')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(temp, { recursive: true })
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    // O cache padrao do uv desta maquina esta com arquivos presos (pywin32 "os error 32"); um cache novo isola o teste.
    UV_CACHE_DIR: path.join(TMP, 'uv-cache'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    NO_UPDATE_NOTIFIER: '1',
    DO_NOT_TRACK: '1',
    CI: '1'
  })
}

/* ------------------------------------ rede ----------------------------------- */

const throttled = createThrottledFetch(globalThis.fetch.bind(globalThis))
globalThis.fetch = throttled.fetch

process.on('unhandledRejection', (reason) => {
  console.error('[aviso] rejeição não tratada:', reason instanceof Error ? reason.message : reason)
})

/* ---------------------------------- servico ---------------------------------- */

interface BuildResult {
  server: McpServerSettings
  missing: string[]
  secretKeys: Set<string>
}

function makeService(): { service: ConnectorService; build: (entry: DirectoryConnector, values: Record<string, string>, custom?: unknown) => BuildResult } {
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`o teste não deve ${what}`)
  }
  const settings = {
    get: () => ({ mcpServers: [] as McpServerSettings[] }),
    mcpSecretValue: () => undefined,
    update: refuse('gravar configurações'),
    setMcpSecrets: refuse('gravar segredos'),
    clearMcpSecrets: refuse('limpar segredos'),
    clearMcpSecret: refuse('limpar segredos')
  }
  const oauth = new McpOAuthManager(path.join(TMP, 'oauth'), undefined, {
    openUrl: () => {
      throw new Error('o teste nunca abre o navegador')
    }
  })
  const service = new ConnectorService({
    settings: settings as never,
    oauth,
    clients: () => new Map(),
    restart: refuse('reiniciar servidores'),
    refreshTools: () => undefined,
    emitChanged: () => undefined,
    secretIssues: () => new Map(),
    challenge: () => undefined,
    loadDirectoryFile: () => JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8')),
    log: () => undefined
  })
  // A montagem do servidor a partir da entrada e a MESMA do app (ConnectorService.buildFromEntry, privada).
  const build = (entry: DirectoryConnector, values: Record<string, string>, custom?: unknown): BuildResult =>
    (service as unknown as { buildFromEntry(e: DirectoryConnector, v: Record<string, string>, c?: unknown): BuildResult }).buildFromEntry(entry, values, custom)
  return { service, build }
}

/* --------------------------------- utilitarios ------------------------------- */

function isLoopbackUrl(raw: string | undefined): boolean {
  try {
    const host = new URL(raw ?? '').hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

const short = (text: string | undefined, max = 300): string => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

async function pool<T>(items: readonly T[], size: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        await worker(items[index], index)
      }
    })
  )
}

async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Promise<T> | T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    const first = await Promise.race([work, late])
    return first === 'timeout' ? await onTimeout() : first
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function baseRecord(entry: DirectoryConnector, group: ConnectorTestRecord['group']): ConnectorTestRecord {
  return {
    id: entry.id,
    name: entry.name,
    group,
    source: entry.source,
    category: entry.category,
    transport: entry.transport,
    auth: entry.auth,
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.command ? { command: [entry.command, ...(entry.args ?? [])].join(' ').slice(0, 200) } : {}),
    level: null,
    outcome: 'failed',
    connected: false,
    loginReady: false,
    steps: [],
    ms: 0,
    testedAt: new Date().toISOString()
  }
}

async function stopQuietly(client: McpClient | null): Promise<void> {
  if (!client) return
  await withDeadline(client.stop(1_000).catch(() => undefined), 6_000, () => undefined)
}

/** O que o app diria ao usuario com este erro (a tabela do nucleo; sem ela, o aviso generico de credencial). */
function hintOf(config: McpServerConfig, entryAuth: string, error: string): string | undefined {
  const known = hintForMcpError(config.name, config, error)
  if (known) return known
  if (looksUnauthorized(error)) {
    return entryAuth === 'oauth' || entryAuth === 'oauth-static' || entryAuth === 'unknown'
      ? 'Entre com sua conta para autorizar este conector.'
      : 'O servidor exige credencial. Informe a chave de API do serviço.'
  }
  return undefined
}

function toolNames(client: McpClient): string[] {
  return client.toolsList().map((tool) => tool.name)
}

/* ------------------------------------ remotos -------------------------------- */

/**
 * Servidores locais: so as chamadas de prova conhecidas e sem efeito (nada que abra navegador, leia a conta ou toque no
 * PC do usuario). Um `list_pages` do chrome-devtools abre o Chrome, um `browser_find` do Playwright abre o Chromium.
 */
const LOCAL_PROOF_CALLS: Record<string, string> = { memory: 'read_graph', filesystem: 'list_allowed_directories' }

async function tryOneTool(client: McpClient, record: ConnectorTestRecord, only?: string): Promise<void> {
  const candidates = client.toolsList()
  const tool = only ? candidates.find((item) => item.name === only && item.annotations?.readOnlyHint === true) ?? null : pickSafeTool(candidates)
  if (!tool) {
    record.steps.push({
      step: 'mcp:chamada-de-prova',
      ok: true,
      ms: 0,
      detail: only
        ? 'servidor local sem chamada de prova conhecida e sem efeito (nada que abra navegador ou toque no PC); nada chamado'
        : 'nenhuma ferramenta somente-leitura sem argumentos obrigatórios e sem dados pessoais; nada chamado'
    })
    return
  }
  const started = Date.now()
  try {
    const result = await client.callTool(tool.name, {}, 25_000)
    const note = short(result.text, 80)
    record.toolCall = { tool: tool.name, ok: result.ok, ms: Date.now() - started, chars: result.text.length, isError: !result.ok, note }
    record.steps.push({
      step: 'mcp:chamada-de-prova',
      ok: result.ok,
      ms: Date.now() - started,
      detail: `${tool.name} (readOnlyHint) → ${result.ok ? 'ok' : 'erro do servidor'}, ${result.text.length} caracteres${result.ok ? '' : `: ${note}`}`
    })
  } catch (err) {
    const message = short((err as Error).message, 200)
    record.toolCall = { tool: tool.name, ok: false, ms: Date.now() - started, chars: 0, isError: true, note: message }
    record.steps.push({ step: 'mcp:chamada-de-prova', ok: false, ms: Date.now() - started, detail: `${tool.name} → ${message}` })
  }
}

/** Formulario das `credentials` do diretorio: cada campo precisa de chave, rotulo, onde vai e (cabecalho) o prefixo certo. */
function formStep(entry: DirectoryConnector, build: ReturnType<typeof makeService>['build']): TestStep {
  const fields = credentialFields(entry)
  if (!fields.length) {
    return { step: 'form:credenciais', ok: false, ms: 0, detail: 'entrada api-key sem `credentials` no diretório: o formulário ficaria sem campo para a chave' }
  }
  const problems: string[] = []
  for (const field of fields) {
    if (!field.label?.trim()) problems.push(`${field.key}: sem rótulo`)
    if (field.where !== 'env' && field.where !== 'header') problems.push(`${field.key}: where inválido`)
    if (field.where === 'header' && /^authorization$/i.test(field.key) && !field.prefix) problems.push(`${field.key}: cabeçalho Authorization sem prefixo`)
    // Um cabecalho de autenticacao e sempre segredo (vai para o cofre); um e-mail ou uma URL no ambiente pode nao ser.
    if (field.where === 'header' && !isSecretField(field)) problems.push(`${field.key}: cabeçalho que não é tratado como segredo`)
  }
  // Montagem local com valores de enfeite: nunca enviados a ninguem.
  const dummy = Object.fromEntries(fields.map((field) => [field.key, 'VALOR-DE-TESTE-NAO-ENVIADO-123']))
  const built = build(entry, dummy)
  if (built.missing.length) problems.push(`montagem com todos os campos ainda acusa falta: ${built.missing.join(', ')}`)
  const places = fields.map((field) => `${field.key} (${field.where}${field.prefix ? `, prefixo "${field.prefix.trim()}"` : ''}${isSecretField(field) ? ', secreto' : ''}${field.required ? ', obrigatório' : ''})`)
  return { step: 'form:credenciais', ok: problems.length === 0, ms: 0, detail: problems.length ? problems.join('; ') : `${fields.length} campo(s): ${places.join('; ')}` }
}

async function testRemote(entry: DirectoryConnector, ctx: ReturnType<typeof makeService>): Promise<ConnectorTestRecord> {
  const started = Date.now()
  const record = baseRecord(entry, 'remote')
  const steps = record.steps
  const guard = blockedReason(entry.url)
  if (guard) {
    record.outcome = 'failed'
    record.cause = `URL não testada pelo guarda do teste (${guard})`
    record.ms = Date.now() - started
    return record
  }

  // 1) o cliente MCP real, sem credenciais
  const built = ctx.build(entry, {})
  const raw = built.server.url ? built.server : ({ name: serverNameFor(entry.id), type: entry.transport, url: entry.url, command: '', args: [] } as McpServerSettings)
  const { enabled: _enabled, ...rest } = raw
  const config: McpServerConfig = { ...rest, startTimeoutMs: REMOTE_START_MS, timeoutMs: 25_000 }
  const client = new McpClient(config)
  let ready = false
  let clientError: string | undefined
  const clientStarted = Date.now()
  try {
    await client.start()
    ready = true
  } catch (err) {
    clientError = client.lastError ?? (err as Error).message
  }
  if (ready) {
    const info = client.describe()
    record.protocolVersion = info.protocolVersion ?? undefined
    record.serverInfo = [info.serverName, info.serverVersion].filter(Boolean).join(' ') || undefined
    record.transportUsed = info.transport
    record.toolCount = client.toolsList().length
    record.tools = toolNames(client).slice(0, 12)
    steps.push({
      step: 'mcp:initialize+tools/list',
      ok: true,
      ms: Date.now() - clientStarted,
      detail: `${record.toolCount} ferramenta(s); protocolo ${info.protocolVersion}; transporte ${info.transport}${record.serverInfo ? `; servidor ${record.serverInfo}` : ''}`
    })
    await tryOneTool(client, record)
  } else {
    record.error = short(clientError, 500)
    steps.push({ step: 'mcp:initialize+tools/list', ok: false, ms: Date.now() - clientStarted, detail: short(clientError, 300) })
    record.hint = hintOf(config, entry.auth, clientError ?? '')
  }
  await stopQuietly(client)
  const parsed = parseClientError(clientError)
  if (parsed.httpStatus) record.httpStatus = parsed.httpStatus
  if (parsed.challenge) record.challenge = short(parsed.challenge, 300)

  // 2) ensaio OAuth (a mesma montagem do botao "Conectar"), sem navegador, sem gravar nada
  let dry: DryRunFacts | null = null
  const oauthEntry = entry.auth === 'oauth' || entry.auth === 'oauth-static' || entry.auth === 'unknown'
  if (oauthEntry && parsed.network !== 'dns') {
    const dryStarted = Date.now()
    try {
      const result = await ctx.service.connect(entry.id, { dryRun: { minIntervalMs: 1000 } })
      const report = result.dryRun
      if (report) {
        dry = {
          ok: report.ok,
          error: report.error,
          hint: report.hint,
          steps: report.steps,
          redirectUri: report.redirectUri,
          client: report.client,
          scope: report.scope
        }
        for (const step of report.steps) steps.push({ step: `oauth:${step.step}`, ok: step.ok, ms: step.ms, detail: short(step.detail, 300) })
        if (!report.steps.length) steps.push({ step: 'oauth:ensaio', ok: false, ms: Date.now() - dryStarted, detail: short(report.error, 300) })
        record.redirectUri = report.redirectUri
        if (report.scope) record.scope = report.scope.slice(0, 300)
        if (!report.ok) {
          record.error = record.error ?? short(report.error, 500)
          record.hint = record.hint ?? report.hint
          if (report.hint) record.hint = report.hint
        }
        // O ensaio tem que dizer o URL de retorno fixo e, sem registro dinamico, dar a dica com ele.
        if (!report.ok && /n[aã]o aceita registro din[aâ]mico/i.test(report.error ?? '')) {
          const right = report.redirectUri === MCP_OAUTH_REDIRECT_URI && (report.hint ?? '').includes(MCP_OAUTH_REDIRECT_URI)
          steps.push({
            step: 'app:dica-e-redirectUri',
            ok: right,
            ms: 0,
            detail: right ? `mensagem e dica trazem ${MCP_OAUTH_REDIRECT_URI}` : `redirectUri=${report.redirectUri}; dica=${short(report.hint, 160)}`
          })
        }
      }
    } catch (err) {
      steps.push({ step: 'oauth:ensaio', ok: false, ms: Date.now() - dryStarted, detail: short((err as Error).message, 300) })
    }
  }

  // 2b) oauth-static sem client id no diretorio: o botao "Conectar" tem que pedir o client id (sem rede, sem gravar)
  if (entry.auth === 'oauth-static' && !entry.oauthClientId) {
    const state = (await ctx.service.connect(entry.id, {})).state
    const right = state.status === 'needs-auth' && state.redirectUri === MCP_OAUTH_REDIRECT_URI && (state.hint ?? '').includes(MCP_OAUTH_REDIRECT_URI)
    steps.push({
      step: 'app:conectar-sem-client-id',
      ok: right,
      ms: 0,
      detail: right ? `pede o client id e mostra ${MCP_OAUTH_REDIRECT_URI}` : `estado inesperado: ${state.status} / ${short(state.detail, 120)}`
    })
  }

  // 3) api-key: formulario completo e dica pt-BR
  if (entry.auth === 'api-key') {
    steps.push(formStep(entry, ctx.build))
    if (!ready) {
      const status = parsed.httpStatus
      steps.push({
        step: 'app:dica-pt-br',
        ok: Boolean(record.hint),
        ms: 0,
        detail: `HTTP ${status ?? '?'}; sem credencial: ${short(record.hint, 220) || '(nenhuma)'}`
      })
      // O caso real do usuario: ele digitou a chave e o servidor a recusou (cabecalho presente no conector).
      const header = credentialFields(entry).find((field) => field.where === 'header')?.key ?? 'Authorization'
      const rejected = hintForMcpError(config.name, { ...config, headers: { [header]: 'x' } }, clientError ?? '')
      steps.push({
        step: 'app:dica-credencial-recusada',
        ok: Boolean(rejected),
        ms: 0,
        detail: `com o cabeçalho ${header} recusado: ${short(rejected, 220) || '(nenhuma dica)'}`
      })
    }
  }

  const verdict = classifyRemote({ auth: entry.auth, ready, clientError, dry })
  record.level = verdict.level
  record.outcome = verdict.outcome
  record.connected = verdict.connected
  record.loginReady = verdict.loginReady
  record.needsOwnClient = verdict.needsOwnClient
  if (verdict.cause) record.cause = verdict.cause
  const authHost = authHostOf(dry)
  if (authHost) record.authHost = authHost
  if (ready && oauthEntry) record.note = 'a listagem é aberta; chamar ferramentas pode exigir login'
  record.ms = Date.now() - started
  return record
}

/* ------------------------------------- locais -------------------------------- */

function sampleValue(entry: DirectoryConnector, key: string): string {
  const dir = path.join(TMP, 'work', entry.id)
  fs.mkdirSync(dir, { recursive: true })
  switch (key) {
    case 'REPO_PATH':
      try {
        execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore', env: process.env })
      } catch {
        /* sem git: o servidor reclamara */
      }
      return dir
    case 'DB_PATH':
      return path.join(dir, 'teste.db')
    default:
      return dir
  }
}

async function testLocal(entry: DirectoryConnector, ctx: ReturnType<typeof makeService>): Promise<ConnectorTestRecord> {
  const started = Date.now()
  const record = baseRecord(entry, 'local')
  const steps = record.steps
  const fields = credentialFields(entry)
  const secrets = fields.filter((field) => field.required && isSecretField(field))

  if (secrets.length) {
    // Exige segredo: o servico tem que recusar sem ele, com mensagem clara, e nada sobe.
    const refusal = await ctx.service.connect(entry.id, {})
    const required = fields.filter((field) => field.required).map((field) => field.key)
    const ok =
      refusal.state.status === 'needs-auth' &&
      /faltam credenciais/i.test(refusal.state.detail ?? '') &&
      required.every((key) => (refusal.state.lastError ?? '').includes(key))
    steps.push({
      step: 'app:conectar-sem-credencial',
      ok,
      ms: Date.now() - started,
      detail: ok ? `recusado: ${short(refusal.state.detail)}; nada instalado nem iniciado` : `resposta inesperada: ${refusal.state.status} / ${short(refusal.state.detail)}`
    })
    const formStepResult: TestStep = {
      step: 'form:credenciais',
      ok: fields.every((field) => field.label?.trim() && (field.where === 'env' || field.where === 'header')),
      ms: 0,
      detail: fields.map((field) => `${field.key} (${field.where}${isSecretField(field) ? ', secreto' : ''}${field.required ? ', obrigatório' : ''})`).join('; ')
    }
    steps.push(formStepResult)
    record.outcome = ok && formStepResult.ok ? 'local-needs-credentials' : 'failed'
    record.cause = ok ? `exige ${secrets.map((field) => field.key).join(', ')}` : 'não recusou sem credencial'
    if (!ok) record.error = short(refusal.state.detail)
    record.hint = refusal.state.hint
    record.ms = Date.now() - started
    return record
  }

  // Sem segredo: sobe o servidor de verdade (npx/uvx baixam pacotes), numa pasta temporaria.
  const values: Record<string, string> = {}
  for (const field of fields) values[field.key] = sampleValue(entry, field.key)
  const built = ctx.build(entry, values)
  if (built.missing.length) {
    record.outcome = 'failed'
    record.cause = 'faltaram campos na montagem do teste'
    record.error = built.missing.join(', ')
    record.ms = Date.now() - started
    return record
  }
  const { enabled: _enabled, ...rest } = built.server
  const workDir = path.join(TMP, 'work', entry.id)
  fs.mkdirSync(workDir, { recursive: true })
  const config: McpServerConfig = { ...rest, cwd: workDir, startTimeoutMs: LOCAL_TIMEOUT_MS, timeoutMs: 60_000 }
  const client = new McpClient(config)
  let ready = false
  let error: string | undefined
  const clientStarted = Date.now()
  try {
    await withDeadline(client.start(), LOCAL_TIMEOUT_MS + 15_000, () => {
      throw new Error(`prazo de ${Math.round(LOCAL_TIMEOUT_MS / 1000)} s esgotado`)
    })
    ready = true
  } catch (err) {
    error = client.lastError ?? (err as Error).message
  }
  if (ready) {
    const info = client.describe()
    record.protocolVersion = info.protocolVersion ?? undefined
    record.serverInfo = [info.serverName, info.serverVersion].filter(Boolean).join(' ') || undefined
    record.transportUsed = info.transport
    record.toolCount = client.toolsList().length
    record.tools = toolNames(client).slice(0, 12)
    steps.push({
      step: 'mcp:initialize+tools/list',
      ok: true,
      ms: Date.now() - clientStarted,
      detail: `${record.toolCount} ferramenta(s); protocolo ${info.protocolVersion}${record.serverInfo ? `; servidor ${record.serverInfo}` : ''}`
    })
    await tryOneTool(client, record, LOCAL_PROOF_CALLS[entry.id] ?? '(nenhuma)')
    record.outcome = 'local-connected'
    record.connected = true
  } else {
    record.error = short(error, 500)
    steps.push({ step: 'mcp:initialize+tools/list', ok: false, ms: Date.now() - clientStarted, detail: short(error, 300) })
    record.hint = hintOf(config, entry.auth, error ?? '')
    if (/ENOENT|n[ãa]o foi poss[ií]vel iniciar|n[ãa]o [ée] reconhecido|command not found/i.test(error ?? '')) {
      record.outcome = 'local-needs-runtime'
      record.cause = `falta o programa no PC (${entry.command})`
    } else if (/ECONNREFUSED/i.test(error ?? '')) {
      record.outcome = 'local-app-offline'
      record.cause = 'o aplicativo que serve este endereço não está aberto'
    } else if (/prazo|tempo|timeout|esgotado/i.test(error ?? '')) {
      record.outcome = 'local-failed'
      record.cause = `não ficou pronto em ${Math.round(LOCAL_TIMEOUT_MS / 1000)} s`
    } else {
      record.outcome = 'local-failed'
      record.cause = 'o servidor encerrou ou recusou o handshake'
    }
  }
  await stopQuietly(client)
  record.ms = Date.now() - started
  return record
}

/* --------------------------------- sem endpoint ------------------------------ */

async function testNoEndpoint(entry: DirectoryConnector, ctx: ReturnType<typeof makeService>): Promise<ConnectorTestRecord> {
  const started = Date.now()
  const record = baseRecord(entry, 'no-endpoint')
  const state = (await ctx.service.connect(entry.id, {})).state
  const ok = state.status === 'needs-auth' && /url do servidor mcp/i.test(state.detail ?? '')
  record.steps.push({
    step: 'app:conectar-sem-url',
    ok,
    ms: Date.now() - started,
    detail: ok ? `pede a URL ao usuário (${short(state.detail, 80)})` : `estado inesperado: ${state.status} / ${short(state.detail, 120)}`
  })
  record.outcome = ok ? 'needs-endpoint' : 'failed'
  record.cause = ok ? 'o diretório do Claude não publica a URL (endpoint por conta/tenant)' : 'não pediu a URL'
  record.hint = state.hint
  record.ms = Date.now() - started
  return record
}

/* ------------------------------------- main ---------------------------------- */

function loadResult(): { records: ConnectorTestRecord[] } & Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')) as { records: ConnectorTestRecord[] }
  } catch {
    return { records: [] }
  }
}

function loadFixesFile(): { fixes: unknown[]; investigations: unknown[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(FIXES_FILE, 'utf8')) as { fixes?: unknown[]; investigations?: unknown[] }
    return { fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [], investigations: Array.isArray(parsed.investigations) ? parsed.investigations : [] }
  } catch {
    return { fixes: [], investigations: [] }
  }
}

function writeOutputs(records: ConnectorTestRecord[], directory: DirectoryConnector[], extra: Record<string, unknown>): void {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id))
  const { fixes, investigations } = loadFixesFile()
  const payload = {
    generatedAt: new Date().toISOString(),
    userAgent: TEST_USER_AGENT,
    redirectUri: MCP_OAUTH_REDIRECT_URI,
    summary: summarize(sorted),
    ...extra,
    fixes,
    investigations,
    records: sorted
  }
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true })
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(payload, null, 1)}\n`)
  fs.writeFileSync(REPORT_FILE, buildReport(sorted, directory, { userAgent: TEST_USER_AGENT, fixes: fixes as never, investigations: investigations as never, extra }))
}

async function main(): Promise<void> {
  const ctx = makeService()
  const directory = ctx.service.directory().entries

  if (has('--report-only')) {
    const data = loadResult()
    writeOutputs(data.records, directory, { runs: data.runs })
    console.log(`relatório regenerado: ${path.relative(ROOT, REPORT_FILE)} (${data.records.length} registros)`)
    return
  }

  if (has('--reclassify')) {
    // Sem rede: aplica de novo o classificador aos registros "a investigar" cujo registro dinamico foi recusado, a partir dos
    // passos gravados (usado depois de ensinar o classificador a separar a politica do servico de um defeito nosso).
    const data = loadResult()
    let changed = 0
    for (const record of data.records) {
      const registration = record.steps.find((step) => step.step === 'oauth:registration' && !step.ok)
      if (record.group !== 'remote' || (record.outcome !== 'failed' && record.outcome !== 'blocked') || !registration) continue
      const dry: DryRunFacts = {
        ok: false,
        error: registration.detail,
        steps: record.steps.filter((step) => step.step.startsWith('oauth:')).map((step) => ({ ...step, step: step.step.slice('oauth:'.length) }))
      }
      const verdict = classifyRemote({ auth: record.auth, ready: false, clientError: record.error, dry })
      if (verdict.outcome === record.outcome && verdict.cause === record.cause) continue
      record.outcome = verdict.outcome
      record.cause = verdict.cause
      changed++
    }
    writeOutputs(data.records, directory, { runs: data.runs })
    console.log(`reclassificados: ${changed} registros (sem rede)`)
    return
  }

  isolateEnvironment()
  const only = new Set((value('--only') ?? '').split(',').map((item) => item.trim()).filter(Boolean))
  const retest = new Set((value('--retest') ?? '').split(',').map((item) => item.trim()).filter(Boolean))
  const stored = loadResult()
  const previous = stored.records
  const priorRuns = Array.isArray(stored.runs) ? (stored.runs as unknown[]) : []
  const currentRun = { at: new Date().toISOString(), args: argv.join(' '), tested: 0, requests: 0, retries429: 0 }
  const retestIds = new Set(previous.filter((record) => retest.has(record.outcome)).map((record) => record.id))

  let entries = directory.filter((entry) => (only.size ? only.has(entry.id) : retest.size ? retestIds.has(entry.id) : true))
  const limit = Number(value('--limit'))
  if (Number.isFinite(limit) && limit > 0) entries = entries.slice(0, limit)

  // Um endereco de loopback (o servidor MCP do Figma Desktop, http://127.0.0.1:3845/mcp) tambem e local: so existe com o app aberto.
  const isLocal = (entry: DirectoryConnector): boolean => entry.transport === 'stdio' || entry.kind === 'local' || isLoopbackUrl(entry.url)
  const noUrl = has('--skip-remote') ? [] : entries.filter((entry) => !isLocal(entry) && !entry.url)
  const locals = has('--skip-local') ? [] : entries.filter(isLocal)
  const remotes = has('--skip-remote') ? [] : entries.filter((entry) => !isLocal(entry) && entry.url)

  console.log(
    `Openclod ${TEST_USER_AGENT}: ${entries.length} conectores (${remotes.length} remotos com URL, ${locals.length} locais, ${noUrl.length} sem endpoint); ` +
      `remotos x${REMOTE_CONCURRENCY}, locais x${LOCAL_CONCURRENCY}, 1 requisição/s por host; pasta temporária ${TMP}`
  )

  const fresh: ConnectorTestRecord[] = []
  const t0 = Date.now()
  let done = 0
  const total = noUrl.length + remotes.length + locals.length
  const save = (): void => {
    if (WRITE && fresh.length) {
      const merged = mergeRecords(previous, fresh, value('--note'))
      currentRun.tested = fresh.length
      currentRun.requests = throttled.stats.requests
      currentRun.retries429 = throttled.stats.retries429
      writeOutputs(merged, directory, { runs: [...priorRuns, currentRun] })
    }
  }
  const finish = (record: ConnectorTestRecord): void => {
    fresh.push(record)
    done++
    const level = record.level === null ? '  ' : `N${record.level}`
    console.log(`[${done}/${total}] ${level} ${record.outcome.padEnd(22)} ${record.id} (${(record.ms / 1000).toFixed(1)}s)${record.cause ? ` — ${record.cause}` : ''}`)
    if (has('--verbose')) {
      for (const step of record.steps) console.log(`      ${step.ok ? 'ok ' : 'ERR'} ${step.step} (${step.ms} ms) ${step.detail}`)
      if (record.hint) console.log(`      dica: ${record.hint}`)
    }
    if (done % 25 === 0) save()
  }
  const guarded = (entry: DirectoryConnector, ms: number, run: () => Promise<ConnectorTestRecord>): Promise<ConnectorTestRecord> =>
    withDeadline(run(), ms, () => {
      const record = baseRecord(entry, isLocal(entry) ? 'local' : 'remote')
      record.outcome = isLocal(entry) ? 'local-failed' : 'unreachable'
      record.cause = `prazo total do teste (${Math.round(ms / 1000)} s) esgotado`
      record.ms = ms
      return record
    }).catch((err: unknown) => {
      const record = baseRecord(entry, isLocal(entry) ? 'local' : 'remote')
      record.outcome = 'failed'
      record.cause = 'erro inesperado no teste'
      record.error = short((err as Error)?.message, 300)
      return record
    })

  for (const entry of noUrl) finish(await testNoEndpoint(entry, ctx))

  const jobs: Array<Promise<void>> = []
  if (remotes.length) {
    jobs.push(pool(remotes, REMOTE_CONCURRENCY, async (entry) => finish(await guarded(entry, REMOTE_DEADLINE_MS, () => testRemote(entry, ctx)))))
  }
  if (locals.length) {
    jobs.push(pool(locals, LOCAL_CONCURRENCY, async (entry) => finish(await guarded(entry, LOCAL_TIMEOUT_MS + 60_000, () => testLocal(entry, ctx)))))
  }
  await Promise.all(jobs)

  save()
  const summary = summarize(fresh)
  console.log(`\nConcluído em ${((Date.now() - t0) / 1000).toFixed(0)} s: ${throttled.stats.requests} requisições HTTP (${throttled.stats.retries429} reenvios por 429).`)
  console.log('Por nível:', JSON.stringify(summary.byLevel))
  console.log('Por resultado:', JSON.stringify(summary.byOutcome))
  if (WRITE && fresh.length) console.log(`Gravado: ${path.relative(ROOT, RESULT_FILE)} e ${path.relative(ROOT, REPORT_FILE)}`)
}

main()
  .then(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error('falha no teste:', err)
    try {
      fs.rmSync(TMP, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    process.exit(1)
  })
