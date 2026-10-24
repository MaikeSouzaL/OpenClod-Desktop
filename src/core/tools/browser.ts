import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolDef } from './types.js'

const target = {
  selector: z.string().optional().describe('Seletor CSS (último recurso)'),
  role: z.string().optional().describe('Papel ARIA: button, textbox, link, checkbox, tab...'),
  name: z.string().optional().describe('Nome acessível do elemento'),
  text: z.string().optional().describe('Texto visível do elemento')
}

export const browserOpenTool: ToolDef = {
  name: 'browser_open',
  description:
    'Abre o navegador automatizado em uma URL e devolve a árvore de acessibilidade da página. É o primeiro passo de qualquer navegação web.',
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
    return {
      ok: true,
      text: `<page url="${snap.url}" title="${snap.title}">\n${snap.tree}\n</page>`,
      summary: snap.title || snap.url,
      data: { url: snap.url, title: snap.title }
    }
  }
}

export const browserNavigateTool: ToolDef = {
  name: 'browser_navigate',
  description: 'Navega para outra URL na aba atual e devolve a árvore de acessibilidade.',
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
    return {
      ok: true,
      text: `<page url="${snap.url}" title="${snap.title}">\n${snap.tree}\n</page>`,
      summary: snap.title || snap.url
    }
  }
}

export const browserSnapshotTool: ToolDef = {
  name: 'browser_snapshot',
  description:
    'Retorna a árvore de acessibilidade da página atual. Use depois de cada interação para confirmar o resultado antes de continuar.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({ max_chars: z.number().int().min(1000).max(60_000).optional() }),
  describe() {
    return { title: 'Inspecionar página', detail: 'árvore de acessibilidade' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { max_chars?: number }
    const snap = await ctx.services.browser.snapshot(args.max_chars)
    return {
      ok: true,
      text: `<page url="${snap.url}" title="${snap.title}">\n${snap.tree}\n</page>`,
      summary: `${snap.title} · ${snap.tree.split('\n').length} nós`
    }
  }
}

export const browserClickTool: ToolDef = {
  name: 'browser_click',
  description:
    'Clica em um elemento usando papel ARIA + nome, texto visível ou seletor CSS. Prefira role+name.',
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
    const url = await ctx.services.browser.click(args)
    const snap = await ctx.services.browser.snapshot(6000)
    return {
      ok: true,
      text: `clique realizado · agora em ${url}\n<page>\n${snap.tree}\n</page>`,
      summary: `clique · ${url}`
    }
  }
}

export const browserTypeTool: ToolDef = {
  name: 'browser_type',
  description: 'Preenche um campo de texto (papel ARIA + nome, texto ou seletor). Use submit=true para pressionar Enter.',
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
    await ctx.services.browser.type(args, args.value, args.submit ?? false)
    const snap = await ctx.services.browser.snapshot(6000)
    return {
      ok: true,
      text: `campo preenchido${args.submit ? ' e Enter pressionado' : ''}\n<page>\n${snap.tree}\n</page>`,
      summary: `preenchido: ${args.value.slice(0, 40)}`
    }
  }
}

export const browserPressTool: ToolDef = {
  name: 'browser_press',
  description: 'Pressiona uma tecla ou combinação (ex.: Enter, Tab, Control+A).',
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
    return { ok: true, text: `tecla ${args.key} pressionada`, summary: args.key }
  }
}

export const browserReadTool: ToolDef = {
  name: 'browser_read',
  description: 'Lê o texto visível da página (ou de um seletor) para resumir ou verificar conteúdo.',
  risk: 'read',
  parallelSafe: true,
  requires: 'network',
  schema: z.object({ selector: z.string().optional() }),
  describe(a) {
    const args = a as { selector?: string }
    return { title: 'Ler texto', detail: args.selector ?? 'página inteira' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { selector?: string }
    const text = await ctx.services.browser.readText(args.selector)
    return { ok: true, text, summary: `${text.length} caracteres` }
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
      text: `screenshot ${shot.width}x${shot.height}`,
      images: [{ type: 'image', mediaType: 'image/png', data: shot.base64, label: 'página' }],
      summary: `${shot.width}x${shot.height}`
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
    return {
      ok: true,
      text: `aba ${id} aberta e ativa\n<page url="${snap.url}" title="${snap.title}">\n${snap.tree}\n</page>`,
      summary: `aba ${id}`,
      data: { tab: id, url: snap.url, title: snap.title }
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
    return {
      ok: true,
      text: `aba ${args.tab} ativa\n<page url="${snap.url}" title="${snap.title}">\n${snap.tree}\n</page>`,
      summary: `aba ${args.tab}`,
      data: { tab: args.tab, url: snap.url, title: snap.title }
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
  browserWaitTool,
  browserTabsTool,
  browserNewTabTool,
  browserSwitchTabTool,
  browserCloseTabTool
]
