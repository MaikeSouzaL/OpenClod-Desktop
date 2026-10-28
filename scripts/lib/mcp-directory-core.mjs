// Logica pura do diretorio de conectores (sem rede, sem disco): usada por scripts/mcp-directory-build.mjs
// e testada em tests/mcp-probe.test.ts. Os tipos vivem em src/shared/mcp-connectors.ts.

export const CATEGORIES = [
  'produtividade',
  'desenvolvimento',
  'comunicacao',
  'design',
  'dados',
  'financas',
  'vendas-crm',
  'marketing',
  'suporte',
  'documentos',
  'nuvem-infra',
  'seguranca-compliance',
  'pesquisa',
  'viagens',
  'saude-ciencia',
  'midia',
  'rh',
  'juridico',
  'outros'
]

const CATEGORY_SET = new Set(CATEGORIES)

export const AUTH_KINDS = ['oauth', 'oauth-static', 'api-key', 'local-env', 'none', 'unknown']

/** Ascii, minusculo, so [a-z0-9-]. Devolve '' quando nada sobra (nome so com simbolos/ideogramas). */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/** 'sse' quando a URL termina em /sse ou /mcpsse (servidores legados); 'http' (streamable HTTP) nos demais. */
export function transportForUrl(url) {
  try {
    const path = new URL(url).pathname
    return /\/(sse|mcpsse)\/?$/i.test(path) ? 'sse' : 'http'
  } catch {
    return 'http'
  }
}

/** Chave de comparacao entre a URL do diretorio e a do catalogo proprio (mesmo servico = mesma chave). */
export function normalizeUrl(raw) {
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`.toLowerCase()
  } catch {
    return String(raw ?? '').trim().toLowerCase().replace(/\/+$/, '')
  }
}

const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.br', 'org.br', 'gov.br', 'com.au', 'org.au', 'co.jp', 'co.in', 'com.mx',
  'co.za', 'com.ar', 'com.sg', 'co.nz', 'com.tr', 'com.cn', 'co.il', 'com.hk', 'com.tw', 'co.kr', 'com.co', 'com.pe'
])
/** Hospedagens compartilhadas: o sub-dominio e a marca, entao mantemos tres rotulos. */
const PLATFORM_SUFFIXES = new Set([
  'vercel.app', 'herokuapp.com', 'workers.dev', 'pages.dev', 'netlify.app', 'github.io', 'railway.app', 'onrender.com',
  'fly.dev', 'azurewebsites.net', 'run.app', 'web.app', 'firebaseapp.com', 'supabase.co', 'ngrok.app', 'ngrok.io',
  'trycloudflare.com', 'lovable.app', 'replit.app', 'repl.co', 'deno.dev', 'val.run'
])
/** Hosts de CDN/armazenamento: nao dizem nada sobre a marca do conector. */
const GENERIC_ICON_HOSTS = new Set([
  'googleapis.com', 'githubusercontent.com', 'website-files.com', 'cloudfront.net', 'imgur.com', 'amazonaws.com',
  'googleusercontent.com', 'gstatic.com', 'wp.com', 'jsdelivr.net', 'unpkg.com', 'zohostratus.com', 'imagekit.io',
  'ctfassets.net', 'framerusercontent.com', 'vercel-storage.com', 'azureedge.net', 'blob.core.windows.net',
  'cdn.discordapp.com', 'notion-static.com', 'bunnycdn.com', 'b-cdn.net', 'fastly.net', 'akamaized.net', 'icons8.com'
])

export function registrableDomain(host) {
  const labels = String(host ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('.')
    .filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const last2 = labels.slice(-2).join('.')
  if (PLATFORM_SUFFIXES.has(last2) || TWO_LEVEL_TLDS.has(last2)) return labels.slice(-3).join('.')
  return last2
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isIpHost(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/** Dominio para desenhar monograma/cor. Nao baixa nada. Prefere o host do iconUrl, exceto se for CDN generico. */
export function iconDomainOf({ iconUrl, url } = {}) {
  const fromIcon = hostOf(iconUrl)
  const fromUrl = hostOf(url)
  const candidates = [fromIcon, fromUrl].filter((h) => h && !isIpHost(h) && h !== 'localhost')
  for (const host of candidates) {
    const reg = registrableDomain(host)
    if (!reg || !reg.includes('.')) continue
    if (GENERIC_ICON_HOSTS.has(reg) || GENERIC_ICON_HOSTS.has(host)) continue
    return reg
  }
  return undefined
}

export function normalizeCategory(value) {
  return CATEGORY_SET.has(value) ? value : 'outros'
}

// ---------------------------------------------------------------------------------------------
// Catalogo proprio do Openclod -> DirectoryConnector

const CATALOG_CATEGORY = {
  atlassian: 'produtividade',
  productivity: 'produtividade',
  development: 'desenvolvimento',
  database: 'dados',
  browser: 'desenvolvimento',
  desktop: 'produtividade',
  documents: 'documentos',
  observability: 'nuvem-infra',
  design: 'design',
  cloud: 'nuvem-infra',
  communication: 'comunicacao'
}
const CATALOG_CATEGORY_OVERRIDE = {
  stripe: 'financas',
  'brave-search': 'pesquisa',
  fetch: 'pesquisa',
  context7: 'desenvolvimento',
  memory: 'produtividade',
  'sequential-thinking': 'produtividade',
  time: 'produtividade',
  markitdown: 'documentos',
  excel: 'documentos',
  firebase: 'nuvem-infra',
  supabase: 'dados'
}
const CATALOG_ICON_DOMAIN = {
  atlassian: 'atlassian.com',
  'atlassian-token': 'atlassian.com',
  jira: 'atlassian.com',
  github: 'github.com',
  context7: 'context7.com',
  playwright: 'playwright.dev',
  'chrome-devtools': 'chrome.com',
  firebase: 'firebase.google.com',
  stripe: 'stripe.com',
  supabase: 'supabase.com',
  terraform: 'terraform.io',
  figma: 'figma.com',
  laravel: 'laravel.com',
  'laravel-boost': 'laravel.com',
  postgres: 'postgresql.org',
  sqlite: 'sqlite.org',
  'brave-search': 'brave.com',
  serena: 'github.com',
  markitdown: 'github.com'
}

function credentialFrom(entry, where, prefix) {
  const out = { key: entry.key, label: entry.label, where }
  if (entry.required) out.required = true
  if (entry.secret) out.secret = true
  if (prefix) out.prefix = prefix
  if (entry.example) out.example = entry.example
  return out
}

/**
 * Converte uma entrada de src/core/mcp/catalog.ts (McpCatalogEntry) em DirectoryConnector.
 * Nada aqui guarda valores de credencial: so o nome da variavel/cabecalho.
 */
export function mapCatalogEntry(cat) {
  const localApp = cat.transport === 'http' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(cat.url ?? '')
  const kind = cat.transport === 'stdio' || localApp ? 'local' : 'remote'
  const credentials = []
  for (const env of cat.env ?? []) credentials.push(credentialFrom(env, 'env'))
  for (const header of cat.headers ?? []) {
    const bearer = /^authorization$/i.test(header.key)
    const next = credentialFrom(
      bearer ? { ...header, label: header.label.replace(/^Authorization:\s*Bearer\s*<token>$/i, 'Token de acesso (Bearer)'), example: String(header.example ?? '').replace(/^Bearer\s+/i, '') || undefined } : header,
      'header',
      bearer ? 'Bearer ' : undefined
    )
    credentials.push(next)
  }

  let auth
  if (cat.oauth) auth = 'oauth'
  else if (cat.basicAuth || (cat.headers ?? []).length) auth = 'api-key'
  else if (kind === 'local') auth = (cat.env ?? []).length ? 'local-env' : 'none'
  else auth = 'unknown'

  const entry = {
    id: cat.id,
    name: cat.name,
    description: cat.description,
    category: CATALOG_CATEGORY_OVERRIDE[cat.id] ?? CATALOG_CATEGORY[cat.category] ?? 'outros',
    kind,
    transport: cat.transport,
    auth,
    tools: [],
    source: 'openclod-catalog'
  }
  if (cat.url) entry.url = cat.url
  if (cat.command) entry.command = cat.command
  if (cat.args?.length) entry.args = [...cat.args]
  if (credentials.length) entry.credentials = credentials
  if (cat.approvalTools?.length) entry.approvalTools = [...cat.approvalTools]
  if (cat.docs) entry.docs = cat.docs
  const notes = []
  if (cat.notes) notes.push(cat.notes)
  if (cat.basicAuth) notes.push(`Compõe "Authorization: Basic base64(${cat.basicAuth.user}:${cat.basicAuth.password})" com as duas credenciais.`)
  if (notes.length) entry.notes = notes.join(' ')
  const icon = CATALOG_ICON_DOMAIN[cat.id] ?? iconDomainOf({ url: localApp ? undefined : cat.url })
  if (icon) entry.iconDomain = icon
  return entry
}

// ---------------------------------------------------------------------------------------------
// Diretorio do Claude (linhas do harvest) -> DirectoryConnector

const NO_ENDPOINT_NOTE = 'Sem endpoint público no diretório; informe a URL do servidor ao conectar.'

export function mapHarvestRow(row) {
  const entry = {
    id: '',
    name: String(row.n).trim(),
    description: String(row.d || '').trim() || 'Conector do diretório do Claude (sem descrição publicada).',
    category: normalizeCategory(row.c),
    kind: 'remote',
    transport: row.url ? transportForUrl(row.url) : 'http',
    auth: 'unknown',
    tools: Array.isArray(row.t) ? row.t.filter((t) => typeof t === 'string' && t) : [],
    directoryUuid: row.u,
    source: 'claude-directory'
  }
  if (row.url) entry.url = row.url
  else entry.notes = NO_ENDPOINT_NOTE
  if (row.tc > 0) entry.toolCount = row.tc
  const icon = iconDomainOf({ iconUrl: row.i, url: row.url })
  if (icon) entry.iconDomain = icon
  return entry
}

/**
 * Junta harvest + catalogo proprio (+ probes ja feitos antes). Devolve as entradas ordenadas por nome.
 * Regras:
 *  - ids do catalogo proprio sao preservados; o id do diretorio e o slug do nome (unico).
 *  - mesma URL no diretorio e no catalogo => UMA entrada (a do catalogo, com directoryUuid/iconDomain/ferramentas do diretorio).
 *  - entrada local do catalogo cujo nome coincide com o de uma entrada remota ganha o sufixo " (local)".
 *  - `previous` (mcp-directory.json anterior): preserva `probe`/`auth`/`toolCount` quando o id e a URL nao mudaram.
 */
export function mergeDirectory({ harvest, catalog, previous = [] }) {
  const catalogEntries = catalog.map(mapCatalogEntry)
  const byCatalogUrl = new Map()
  for (const entry of catalogEntries) {
    if (entry.kind === 'remote' && entry.url) {
      const key = normalizeUrl(entry.url)
      if (!byCatalogUrl.has(key)) byCatalogUrl.set(key, entry) // 'atlassian' (OAuth) ganha de 'atlassian-token'
    }
  }

  const used = new Set(catalogEntries.map((e) => e.id))
  const directory = []
  const nameCount = new Map()
  for (const row of harvest) {
    const mapped = mapHarvestRow(row)
    const twin = mapped.url ? byCatalogUrl.get(normalizeUrl(mapped.url)) : undefined
    if (twin && !twin.directoryUuid) {
      twin.directoryUuid = mapped.directoryUuid
      if (mapped.tools.length) twin.tools = mapped.tools
      if (mapped.toolCount) twin.toolCount = mapped.toolCount
      // o icone publicado no diretorio (quando existe) diz melhor qual e a marca do que o host do endpoint
      if (mapped.iconDomain && (row.i || !twin.iconDomain)) twin.iconDomain = mapped.iconDomain
      continue
    }
    directory.push(mapped)
    const key = mapped.name.toLowerCase()
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1)
  }

  // ids unicos para o diretorio
  directory.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.directoryUuid.localeCompare(b.directoryUuid))
  for (const entry of directory) {
    let base = slugify(entry.name)
    if (!base) base = slugify(hostLabel(entry.url)) || `conector-${entry.directoryUuid.slice(0, 8)}`
    let id = base
    if (used.has(id)) id = `${base}-remote`
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    entry.id = id
  }

  // nomes iguais entre local do catalogo e remoto do diretorio
  const remoteNames = new Set(directory.map((e) => e.name.toLowerCase()))
  for (const entry of catalogEntries) {
    if (entry.kind === 'local' && remoteNames.has(entry.name.toLowerCase())) entry.name = `${entry.name} (local)`
  }

  const all = [...catalogEntries, ...directory]
  all.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))

  const prev = new Map(previous.map((p) => [p.id, p]))
  for (const entry of all) {
    const old = prev.get(entry.id)
    if (old?.probe && normalizeUrl(old.url ?? '') === normalizeUrl(entry.url ?? '')) {
      entry.probe = old.probe
      const catalogLocked = entry.source === 'openclod-catalog' && (entry.kind === 'local' || (entry.auth === 'api-key' && (entry.credentials?.length ?? 0) > 0))
      if (entry.source === 'claude-directory') entry.auth = old.auth // a ultima sondagem manda (inclusive "unknown")
      else if (!catalogLocked && old.auth !== 'unknown') entry.auth = old.auth
      if (old.source === entry.source && old.toolCount !== undefined && old.probe.openAccess) entry.toolCount = old.toolCount
      if (!entry.tools.length && old.tools?.length) entry.tools = old.tools
      if (entry.source === 'claude-directory' && old.notes && entry.notes === undefined) entry.notes = old.notes
      // a divergencia anotada pela sondagem ("Sondagem: ...") acompanha a entrada do catalogo
      const probeNote = /\s*Sondagem:[^\n]*$/.exec(old.notes ?? '')
      if (entry.source === 'openclod-catalog' && probeNote && !/Sondagem:/.test(entry.notes ?? '')) entry.notes = `${entry.notes ?? ''}${probeNote[0]}`.trim()
      if (old.oauthScopes && !entry.oauthScopes) entry.oauthScopes = old.oauthScopes
      // credenciais acrescentadas a mao a uma entrada do diretorio do Claude (ex.: a chave de API do Learning Commons,
      // confirmada na documentacao do servico) sobrevivem a uma nova coleta
      if (entry.source === 'claude-directory' && old.credentials?.length && !entry.credentials) entry.credentials = old.credentials
    }
  }
  return all
}

function hostLabel(url) {
  const host = hostOf(url)
  if (!host) return ''
  return registrableDomain(host).split('.')[0]
}

/** Valida as invariantes do diretorio. Devolve a lista de problemas (vazia = ok). Usada pelo build e pelo teste. */
export function validateDirectory(directory) {
  const problems = []
  const ids = new Set()
  const uuids = new Set()
  const secretLike = [/\bsk-[A-Za-z0-9]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
  if (!directory || !Array.isArray(directory.entries)) return ['entries ausente']
  if (typeof directory.generatedAt !== 'number') problems.push('generatedAt precisa ser numero')
  for (const e of directory.entries) {
    const tag = e?.id ?? '?'
    if (!e || typeof e.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id)) problems.push(`${tag}: id invalido`)
    if (ids.has(e.id)) problems.push(`${tag}: id repetido`)
    ids.add(e.id)
    if (!e.name || typeof e.name !== 'string') problems.push(`${tag}: name`)
    if (!e.description || typeof e.description !== 'string') problems.push(`${tag}: description`)
    if (!CATEGORY_SET.has(e.category)) problems.push(`${tag}: categoria invalida ${e.category}`)
    if (e.kind !== 'remote' && e.kind !== 'local') problems.push(`${tag}: kind`)
    if (!['http', 'sse', 'stdio'].includes(e.transport)) problems.push(`${tag}: transport`)
    if (!AUTH_KINDS.includes(e.auth)) problems.push(`${tag}: auth ${e.auth}`)
    if (!Array.isArray(e.tools)) problems.push(`${tag}: tools`)
    if (e.source !== 'claude-directory' && e.source !== 'openclod-catalog') problems.push(`${tag}: source`)
    if (e.kind === 'remote' && e.url !== undefined && !/^https:\/\//.test(e.url)) problems.push(`${tag}: url remota precisa ser https`)
    if (e.kind === 'remote' && e.transport === 'stdio') problems.push(`${tag}: remoto com transport stdio`)
    if (e.kind === 'local' && e.transport === 'stdio' && !e.command) problems.push(`${tag}: stdio sem command`)
    if (e.directoryUuid !== undefined) {
      if (uuids.has(e.directoryUuid)) problems.push(`${tag}: directoryUuid repetido`)
      uuids.add(e.directoryUuid)
    }
    const text = JSON.stringify(e)
    for (const re of secretLike) if (re.test(text)) problems.push(`${tag}: parece conter segredo (${re})`)
    for (const c of e.credentials ?? []) {
      if (!c.key || !c.label || !['env', 'header'].includes(c.where)) problems.push(`${tag}: credencial malformada`)
    }
  }
  return problems
}
