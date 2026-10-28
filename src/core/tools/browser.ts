import { z } from 'zod'
import type { ImagePart, ToolResult } from '../../shared/types.js'
import type { ScreenshotOptions } from '../browser/layer.js'
import type { ToolContext, ToolDef } from './types.js'

/**
 * Every action hands the model a picture of the page as it is AFTER the action, next to the element list: a
 * model that only reads the tree cannot tell that a menu opened, a click navigated a moment later or a form
 * showed an error, and ends up asking the user to do it by hand. A small JPEG keeps it to ~1k tokens a step.
 */
const VIEW: ScreenshotOptions = { format: 'jpeg', quality: 60, maxWidth: 1280 }

async function pageView(ctx: ToolContext): Promise<{ images?: ImagePart[]; note: string }> {
  try {
    const shot = await ctx.services.browser.screenshot(VIEW)
    return {
      images: [{ type: 'image', mediaType: shot.mediaType ?? 'image/jpeg', data: shot.base64, label: 'página depois da ação' }],
      note:
        `\n[captura anexada: a página como ficou depois desta ação${shot.url ? `, em ${shot.url}` : ''}. ` +
        'Olhe a imagem e a lista de elementos e confirme que o passo deu certo antes do próximo; se não deu, mude a abordagem.]'
    }
  } catch (err) {
    return { note: `\n[captura indisponível agora (${(err as Error).message.slice(0, 160)}); confira com browser_snapshot ou browser_read]` }
  }
}

/** The page block every action returns (URL and title of the page as it is now, then its elements). */
function pageBlock(snap: { url: string; title: string; tree: string }): string {
  return `<page url="${snap.url}" title="${snap.title}">\n${snap.tree}\n</page>`
}

const target = {
  selector: z.string().optional().describe('Seletor CSS (último recurso)'),
  role: z.string().optional().describe('Papel ARIA: button, textbox, link, checkbox, tab...'),
  name: z.string().optional().describe('Nome acessível do elemento'),
  text: z.string().optional().describe('Texto visível do elemento')
}

export const browserOpenTool: ToolDef = {
  name: 'browser_open',
  description:
    'Abre o navegador (o Chrome do usuário, quando a extensão está conectada) em uma URL, espera a página carregar e devolve a captura da tela e a árvore de elementos. É o primeiro passo de qualquer navegação web.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({
    url: z.string().url(),
    headed: z.boolean().optional().describe('Mostrar a janela do navegador'),
    new_tab: z.boolean().optional().describe('Abrir em uma nova aba em vez de reutilizar a atual')
  }),
  describe(a) {
    const args = a as { url: string }
    return { title: 'Abrir navegador', detail: args.url, preview: args.url }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { url: string; headed?: boolean; new_tab?: boolean }
    const browser = ctx.services.browser
    await browser.open(args.url, args.headed ?? false, args.new_tab ?? false)
    const snap = await browser.snapshot()
    const view = await pageView(ctx)
    // Set when "Chrome existente" is configured but the extension is offline: say so, so the model does not
    // expect the user's logins or tabs in this isolated browser.
    const note = browser.fallbackNote
    return {
      ok: true,
      text: `${note ? `${note}\n\n` : ''}${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: snap.title || snap.url,
      data: { url: snap.url, title: snap.title, ...(snap.cursor ? { cursor_dip: snap.cursor } : {}), ...(note ? { isolated: true } : {}) }
    }
  }
}

export const browserNavigateTool: ToolDef = {
  name: 'browser_navigate',
  description:
    'Navega para outra URL na aba atual, espera carregar e devolve a captura da tela e a árvore de elementos. Ir direto pela URL (ex.: https://github.com/new) costuma ser o caminho mais curto.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({ url: z.string().url() }),
  describe(a) {
    const args = a as { url: string }
    return { title: 'Navegar', detail: args.url, preview: args.url }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { url: string }
    await ctx.services.browser.navigate(args.url)
    const snap = await ctx.services.browser.snapshot()
    const view = await pageView(ctx)
    return {
      ok: true,
      text: `${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: snap.title || snap.url,
      data: { url: snap.url, title: snap.title, ...(snap.cursor ? { cursor_dip: snap.cursor } : {}) }
    }
  }
}

export const browserSnapshotTool: ToolDef = {
  name: 'browser_snapshot',
  description:
    'Olha a página atual: devolve a captura da tela e a árvore de elementos (papel, nome, link). Use para conferir o estado antes de decidir o próximo passo; para ver as tags, ids e atributos, use browser_read com html=true.',
  risk: 'read',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({ max_chars: z.number().int().min(1000).max(60_000).optional() }),
  describe() {
    return { title: 'Inspecionar página', detail: 'captura + árvore de elementos' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { max_chars?: number }
    const snap = await ctx.services.browser.snapshot(args.max_chars)
    const view = await pageView(ctx)
    return {
      ok: true,
      text: `${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `${snap.title} · ${snap.tree.split('\n').length} nós`,
      data: { url: snap.url, title: snap.title, ...(snap.cursor ? { cursor_dip: snap.cursor } : {}) }
    }
  }
}

export const browserClickTool: ToolDef = {
  name: 'browser_click',
  description:
    'Clica em um elemento usando papel ARIA + nome, texto visível ou seletor CSS (prefira role+name). Espera a navegação que o clique causar e devolve a captura da tela e a árvore da página resultante: confira nelas se o clique fez o que você queria.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object(target),
  describe(a) {
    const args = a as { role?: string; name?: string; text?: string; selector?: string }
    const label = args.role ? `${args.role} "${args.name ?? ''}"` : args.text ?? args.selector ?? ''
    return { title: 'Clicar', detail: label, preview: label }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { selector?: string; role?: string; name?: string; text?: string }
    const clicked = await ctx.services.browser.click(args)
    const snap = await ctx.services.browser.snapshot(6000)
    const view = await pageView(ctx)
    return {
      ok: true,
      text:
        `clique realizado · agora em ${snap.url || clicked.url}` +
        (clicked.openedTab ? ` (abriu uma nova aba, ${clicked.openedTab}, que agora é a ativa)` : '') +
        (clicked.matches && clicked.matches > 1
          ? `\nAtenção: ${clicked.matches} elementos casam com esse alvo e cliquei no primeiro. Se não era esse, refine com role+name ou selector.`
          : '') +
        `\n${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `clique · ${snap.url || clicked.url}`,
      ...(clicked.cursor ? { data: { cursor_dip: clicked.cursor } } : {})
    }
  }
}

export const browserTypeTool: ToolDef = {
  name: 'browser_type',
  description:
    'Preenche um campo de texto (papel ARIA + nome, texto ou seletor). Use submit=true para pressionar Enter. Devolve a captura da tela e a árvore depois de preencher.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({
    ...target,
    value: z.string(),
    submit: z.boolean().optional()
  }),
  describe(a) {
    const args = a as { role?: string; name?: string; value?: string }
    return { title: 'Preencher campo', detail: `${args.role ?? ''} "${args.name ?? ''}" ← ${args.value ?? ''}`, preview: args.name }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      selector?: string
      role?: string
      name?: string
      text?: string
      value: string
      submit?: boolean
    }
    const typed = await ctx.services.browser.type(args, args.value, args.submit ?? false)
    const snap = await ctx.services.browser.snapshot(6000)
    const view = await pageView(ctx)
    return {
      ok: true,
      text: `campo preenchido${args.submit ? ' e Enter pressionado' : ''}\n${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `preenchido: ${args.value.slice(0, 40)}`,
      ...(typed.cursor ? { data: { cursor_dip: typed.cursor } } : {})
    }
  }
}

export const browserPressTool: ToolDef = {
  name: 'browser_press',
  description: 'Pressiona uma tecla ou combinação (ex.: Enter, Tab, Escape, Control+A) e devolve a captura da tela e a árvore depois.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({ key: z.string().min(1) }),
  describe(a) {
    const args = a as { key: string }
    return { title: 'Tecla', detail: args.key, preview: args.key }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { key: string }
    await ctx.services.browser.press(args.key)
    const snap = await ctx.services.browser.snapshot(6000).catch(() => null)
    const view = await pageView(ctx)
    return {
      ok: true,
      text: `tecla ${args.key} pressionada${snap ? `\n${pageBlock(snap)}` : ''}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: args.key
    }
  }
}

export const browserReadTool: ToolDef = {
  name: 'browser_read',
  description:
    'Lê a página atual (ou só o elemento de um seletor CSS): o texto visível ou, com html=true, o HTML com as tags, ids, classes, names, placeholders e atributos ARIA (sem scripts nem estilos). Use o HTML quando a árvore não mostrar o elemento certo e você precisar de um seletor exato.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({
    selector: z.string().optional().describe('Seletor CSS; omita para a página inteira'),
    html: z.boolean().optional().describe('true = HTML limpo (tags e atributos) em vez do texto visível'),
    max_chars: z.number().int().min(1000).max(80_000).optional()
  }),
  describe(a) {
    const args = a as { selector?: string; html?: boolean }
    return { title: args.html ? 'Ler HTML' : 'Ler texto', detail: args.selector ?? 'página inteira' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { selector?: string; html?: boolean; max_chars?: number }
    const text = await ctx.services.browser.readText(args.selector, { html: args.html, maxChars: args.max_chars })
    return { ok: true, text, summary: `${text.length} caracteres${args.html ? ' de HTML' : ''}` }
  }
}

export const browserScreenshotTool: ToolDef = {
  name: 'browser_screenshot',
  description: 'Captura a página atual como imagem (visão computacional) para validar o resultado visual.',
  risk: 'read',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({}),
  describe() {
    return { title: 'Screenshot da página', detail: 'viewport atual' }
  },
  async execute(_raw, ctx) {
    const shot = await ctx.services.browser.screenshot()
    return {
      ok: true,
      text: `screenshot ${shot.width}x${shot.height}${shot.url ? ` · ${shot.url}` : ''}`,
      images: [{ type: 'image', mediaType: shot.mediaType ?? 'image/png', data: shot.base64, label: 'página' }],
      summary: `${shot.width}x${shot.height}`,
      ...(shot.cursor ? { data: { cursor_dip: shot.cursor } } : {})
    }
  }
}

export const browserConsoleTool: ToolDef = {
  name: 'browser_console',
  description: 'Lista mensagens de console e erros de rede/página coletados até agora.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({}),
  describe() {
    return { title: 'Console e erros', detail: 'logs do navegador' }
  },
  async execute(_raw, ctx) {
    await ctx.services.browser.collectConsole()
    const entries = ctx.services.browser.consoleEntries()
    const errors = ctx.services.browser.errors()
    const text = [
      errors.length ? `--- erros (${errors.length}) ---\n${errors.slice(-30).join('\n')}` : '--- sem erros de rede ---',
      `--- console (${entries.length}) ---`,
      ...entries.slice(-40).map((e) => `[${e.type}] ${e.text}`)
    ].join('\n')
    return { ok: true, text, summary: `${errors.length} erros · ${entries.length} logs` }
  }
}

export const browserNetworkTool: ToolDef = {
  name: 'browser_network',
  description:
    'Lista as requisições de rede recentes da aba: as chamadas fetch/XHR com os corpos do pedido e da resposta (cortados) e, além delas, todas as requisições (navegação, scripts, imagens, APIs) com método, URL, status, tipo e tempo. Use para seguir a API de um site, ver o que entra e sai e por que algo falhou. Só captura o que ocorreu depois que o agente assumiu a aba.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({
    url_contains: z.string().optional().describe('Filtra as requisições cuja URL contém este trecho'),
    bodies: z.boolean().optional().describe('false para omitir os corpos e ver só a lista (padrão true)'),
    limit: z.number().int().min(1).max(120).optional(),
    clear: z.boolean().optional().describe('Zera o buffer depois de ler')
  }),
  describe(a) {
    const args = a as { url_contains?: string }
    return { title: 'Rede do navegador', detail: args.url_contains ?? 'requisições recentes' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { url_contains?: string; bodies?: boolean; limit?: number; clear?: boolean }
    const capture = await ctx.services.browser.network(args.clear ?? false)
    if (!capture.installed) {
      return { ok: true, text: 'nenhuma aba em uso ainda; abra uma página com browser_open', summary: '0 requisições' }
    }
    const needle = args.url_contains?.toLowerCase()
    const match = (request: { url: string }): boolean => !needle || request.url.toLowerCase().includes(needle)
    const limit = args.limit ?? 40
    const withBodies = args.bodies !== false
    const calls = capture.requests.filter(match).slice(-limit)
    const others = (capture.all ?? []).filter(match).slice(-limit)
    if (!calls.length && !others.length) {
      return { ok: true, text: 'nenhuma requisição capturada ainda (depois que o agente assumiu a aba)', summary: '0 requisições' }
    }
    const blocks: string[] = []
    if (calls.length) {
      const text = calls
        .map((request) => {
          const head = `${request.status || '—'} ${request.method} ${request.url}${request.ms ? ` · ${request.ms}ms` : ''}`
          if (!withBodies) return head
          const parts = [head]
          if (request.reqBody) parts.push(`  ↑ ${request.reqBody}`)
          if (request.resBody) parts.push(`  ↓ ${request.resBody}`)
          return parts.join('\n')
        })
        .join('\n')
      blocks.push(`fetch/XHR (com corpos):\n${text}`)
    }
    if (others.length) {
      const text = others
        .map((request) => `${request.status || (request.error ? 'ERRO' : '—')} ${request.method} ${request.url}${request.type ? ` [${request.type}]` : ''}${request.fromCache ? ' (cache)' : ''}${request.error ? ` ${request.error}` : ''}`)
        .join('\n')
      blocks.push(`Todas as requisições:\n${text}`)
    }
    return { ok: true, text: blocks.join('\n\n'), summary: `${calls.length} fetch/XHR · ${others.length} no total` }
  }
}

export const browserCookiesTool: ToolDef = {
  name: 'browser_cookies',
  description:
    'Lê, grava ou apaga cookies do site da aba atual (action: get | set | remove). "get" traz todos os cookies da página (ou o de um nome); "set" grava um cookie; "remove" apaga um. Use para inspecionar ou ajustar a sessão/consentimento. Trate os valores como segredos: eles não vão para logs nem relatórios.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({
    action: z.enum(['get', 'set', 'remove']).default('get'),
    name: z.string().optional().describe('Nome do cookie (para get de um só, set ou remove)'),
    value: z.string().optional().describe('Valor do cookie (set)'),
    domain: z.string().optional(),
    path: z.string().optional(),
    secure: z.boolean().optional(),
    http_only: z.boolean().optional(),
    same_site: z.enum(['Strict', 'Lax', 'None']).optional(),
    expires: z.number().optional().describe('Expiração em segundos Unix (set); omita para cookie de sessão'),
    url: z.string().optional().describe('URL do cookie (padrão: a página atual)')
  }),
  describe(a) {
    const args = a as { action?: string; name?: string }
    return { title: 'Cookies', detail: `${args.action ?? 'get'}${args.name ? ` · ${args.name}` : ''}` }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      action: 'get' | 'set' | 'remove'
      name?: string
      value?: string
      domain?: string
      path?: string
      secure?: boolean
      http_only?: boolean
      same_site?: 'Strict' | 'Lax' | 'None'
      expires?: number
      url?: string
    }
    const browser = ctx.services.browser
    if (args.action === 'set') {
      if (!args.name) return { ok: false, text: 'informe name e value para gravar um cookie', summary: 'faltou o nome' }
      const result = await browser.cookiesSet({
        name: args.name,
        value: args.value ?? '',
        ...(args.url ? { url: args.url } : {}),
        ...(args.domain ? { domain: args.domain } : {}),
        ...(args.path ? { path: args.path } : {}),
        ...(args.secure !== undefined ? { secure: args.secure } : {}),
        ...(args.http_only !== undefined ? { httpOnly: args.http_only } : {}),
        ...(args.same_site ? { sameSite: args.same_site } : {}),
        ...(args.expires ? { expires: args.expires } : {})
      })
      return { ok: result.ok, text: `cookie "${result.name}" gravado${result.domain ? ` em ${result.domain}` : ''}`, summary: `set ${result.name}` }
    }
    if (args.action === 'remove') {
      if (!args.name) return { ok: false, text: 'informe o nome do cookie a remover', summary: 'faltou o nome' }
      const result = await browser.cookiesRemove(args.name, args.url)
      return { ok: result.ok, text: result.ok ? `cookie "${result.name}" apagado` : `não achei o cookie "${result.name}"`, summary: `remove ${result.name}` }
    }
    const list = await browser.cookiesGet(args.name)
    if (!list.cookies.length) return { ok: true, text: `nenhum cookie em ${list.url}`, summary: '0 cookies' }
    const text = list.cookies
      .map((cookie) => {
        const flags = [cookie.httpOnly ? 'httpOnly' : '', cookie.secure ? 'secure' : '', cookie.session ? 'sessão' : '', cookie.sameSite ? `sameSite=${cookie.sameSite}` : '']
          .filter(Boolean)
          .join(', ')
        return `${cookie.name}=${cookie.value}  [${cookie.domain}${cookie.path && cookie.path !== '/' ? cookie.path : ''}${flags ? `; ${flags}` : ''}]`
      })
      .join('\n')
    return { ok: true, text: `${list.count} cookie(s) em ${list.url}:\n${text}`, summary: `${list.count} cookies` }
  }
}

export const browserWaitTool: ToolDef = {
  name: 'browser_wait',
  description: 'Espera um seletor ficar visível na página.',
  risk: 'read',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({ selector: z.string(), timeout_ms: z.number().int().min(500).max(60_000).optional() }),
  describe(a) {
    const args = a as { selector: string }
    return { title: 'Esperar elemento', detail: args.selector, preview: args.selector }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { selector: string; timeout_ms?: number }
    await ctx.services.browser.waitFor(args.selector, args.timeout_ms)
    return { ok: true, text: `elemento visível: ${args.selector}`, summary: args.selector }
  }
}

export const browserTabsTool: ToolDef = {
  name: 'browser_tabs',
  description: 'Lista as abas abertas do navegador (id, título, URL e qual está ativa). Use antes de alternar ou fechar uma aba.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({}),
  describe() {
    return { title: 'Listar abas', detail: 'abas abertas' }
  },
  async execute(_raw, ctx) {
    const tabs = await ctx.services.browser.tabsList()
    if (!tabs.length) return { ok: true, text: 'nenhuma aba aberta; use browser_new_tab ou browser_open', summary: '0 abas' }
    return {
      ok: true,
      text: tabs
        .map((tab) => `${tab.active ? '*' : ' '} ${tab.id} · ${tab.title || '(sem título)'} · ${tab.url}`)
        .join('\n'),
      summary: `${tabs.length} abas`
    }
  }
}

export const browserNewTabTool: ToolDef = {
  name: 'browser_new_tab',
  description: 'Abre uma nova aba (opcionalmente em uma URL) e a torna ativa. Use para trabalhar em paralelo sem perder a aba atual.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({
    url: z.string().url().optional().describe('URL inicial; omita para uma aba em branco')
  }),
  describe(a) {
    const args = a as { url?: string }
    return { title: 'Nova aba', detail: args.url ?? 'about:blank', preview: args.url }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { url?: string }
    const id = await ctx.services.browser.newTab(args.url)
    const snap = await ctx.services.browser.snapshot()
    // A blank tab has nothing to see (and Chrome does not let an extension capture about:blank's contents).
    const view: { images?: ImagePart[]; note: string } = args.url
      ? await pageView(ctx)
      : { note: '\n[aba em branco: use browser_navigate para ir a um site]' }
    return {
      ok: true,
      text: `aba ${id} aberta e ativa\n${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `aba ${id}`,
      data: { tab: id, url: snap.url, title: snap.title, ...(snap.cursor ? { cursor_dip: snap.cursor } : {}) }
    }
  }
}

export const browserClaimTabTool: ToolDef = {
  name: 'browser_claim_tab',
  description:
    'Usa uma aba que o usuário já abriu no Chrome e a adiciona ao grupo desta sessão, sem abrir outro navegador. Informe tab_id, a URL exata, um trecho da URL ou active=true para adotar a aba em foco.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z
    .object({
      tab_id: z.string().min(1).optional().describe('Id da aba informado pelo usuário ou retornado pela extensão'),
      url: z.string().url().optional().describe('URL exata de uma única aba já aberta'),
      url_contains: z
        .string()
        .min(3)
        .optional()
        .describe('Trecho da URL (ex.: "jira" ou "/browse/CNC-") quando só existe uma aba correspondente'),
      active: z.boolean().optional().describe('Adota a aba que está em foco no Chrome agora (mais simples)')
    })
    .refine((value) => Boolean(value.tab_id?.trim() || value.url?.trim() || value.url_contains?.trim() || value.active), {
      message: 'informe tab_id, url, url_contains ou active=true'
    }),
  describe(a) {
    const args = a as { tab_id?: string; url?: string; url_contains?: string; active?: boolean }
    return {
      title: 'Vincular aba existente',
      detail: args.tab_id ?? args.url ?? args.url_contains ?? (args.active ? 'aba em foco' : ''),
      preview: args.tab_id ?? args.url ?? args.url_contains ?? (args.active ? 'aba em foco' : '')
    }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      tab_id?: string
      url?: string
      url_contains?: string
      active?: boolean
    }
    const id = await ctx.services.browser.claimTab({
      tabId: args.tab_id,
      url: args.url,
      urlContains: args.url_contains,
      active: args.active
    })
    const snap = await ctx.services.browser.snapshot()
    const view = await pageView(ctx)
    return {
      ok: true,
      text: `aba existente ${id} vinculada e ativa\n${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `aba ${id}`,
      data: { tab: id, url: snap.url, title: snap.title, ...(snap.cursor ? { cursor_dip: snap.cursor } : {}) }
    }
  }
}

export const browserSwitchTabTool: ToolDef = {
  name: 'browser_switch_tab',
  description: 'Ativa uma aba existente pelo id retornado por browser_tabs/browser_new_tab e devolve seu snapshot.',
  risk: 'read',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({ tab: z.string().min(1).describe('Id da aba, ex.: tab_2') }),
  describe(a) {
    const args = a as { tab?: string }
    return { title: 'Trocar de aba', detail: args.tab ?? '', preview: args.tab }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { tab: string }
    await ctx.services.browser.switchTab(args.tab)
    const snap = await ctx.services.browser.snapshot()
    const view = await pageView(ctx)
    return {
      ok: true,
      text: `aba ${args.tab} ativa\n${pageBlock(snap)}${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `aba ${args.tab}`,
      data: { tab: args.tab, url: snap.url, title: snap.title, ...(snap.cursor ? { cursor_dip: snap.cursor } : {}) }
    }
  }
}

export const browserCloseTabTool: ToolDef = {
  name: 'browser_close_tab',
  description: 'Fecha uma aba (a ativa quando tab é omitido) e lista as restantes.',
  risk: 'network',
  parallelSafe: false,
  requires: 'network',
  schema: z.object({ tab: z.string().min(1).optional().describe('Id da aba; omita para fechar a ativa') }),
  describe(a) {
    const args = a as { tab?: string }
    return { title: 'Fechar aba', detail: args.tab ?? 'aba ativa', preview: args.tab }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { tab?: string }
    await ctx.services.browser.closeTab(args.tab)
    const tabs = await ctx.services.browser.tabsList()
    return {
      ok: true,
      text: `aba fechada. Restantes: ${tabs.length}\n${tabs.map((tab) => `${tab.active ? '*' : ' '} ${tab.id} · ${tab.url}`).join('\n')}`,
      summary: `${tabs.length} abas restantes`
    }
  }
}

export const browserTools: ToolDef[] = [
  browserOpenTool,
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserPressTool,
  browserReadTool,
  browserScreenshotTool,
  browserConsoleTool,
  browserNetworkTool,
  browserCookiesTool,
  browserWaitTool,
  browserTabsTool,
  browserNewTabTool,
  browserClaimTabTool,
  browserSwitchTabTool,
  browserCloseTabTool
]
