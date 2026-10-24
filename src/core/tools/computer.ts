import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import type { ComputerLayer, Target } from '../computer/layer.js'

function requireControl(ctx: { policy: { allowComputerControl: boolean } }): string | null {
  if (!ctx.policy.allowComputerControl) {
    return 'Controle de mouse/teclado desativado nas configurações (allowComputerControl=false). Peça ao usuário para habilitar em Configurações → Permissões.'
  }
  return null
}

/** Every computer tool runs through here: availability + backend flags from the policy. */
function layerFor(ctx: ToolContext): ComputerLayer | ToolResult {
  const layer = ctx.services.computer
  if (!layer.available) return { ok: false, text: layer.status().detail }
  layer.configure({ allowControl: ctx.policy.allowComputerControl })
  return layer
}

function isResult(value: ComputerLayer | ToolResult): value is ToolResult {
  return 'ok' in value && 'text' in value
}

const targetShape = {
  app: z.string().min(1).optional().describe('App da lista de janelas (ex.: notepad, explorer, chrome)'),
  window: z.number().int().min(0).optional().describe('Id de janela de computer_list_windows (mais preciso que app)')
}

function targetOf(args: { app?: string; window?: number }): Target {
  return { app: args.app, window: args.window }
}

function label(target: Target): string {
  return target.window != null ? `janela ${target.window}` : (target.app ?? 'tela')
}

const computerNote =
  'Percepção híbrida: primeiro a árvore de UI Automation (com element_index), depois screenshot. Verifique o estado após cada ação.'

export const computerListWindowsTool: ToolDef = {
  name: 'computer_list_windows',
  description: `Lista janelas abertas com app, título e id de janela. ${computerNote}`,
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({}),
  describe() {
    return { title: 'Janelas abertas', detail: 'listar janelas do Windows' }
  },
  async execute(_raw, ctx) {
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.listWindows()
    const count = (result.text.match(/"id"/g) ?? []).length
    return { ...result, summary: result.ok ? `${count} janelas` : 'falha ao listar janelas' }
  }
}

export const computerSnapshotTool: ToolDef = {
  name: 'computer_snapshot',
  description:
    'Lê a árvore de acessibilidade (UI Automation) de um app ou de uma janela. Retorna element_index para computer_click/set_value/type_text/secondary_action. Com window e include_screenshot=true também devolve a imagem da janela; coordenadas dessa imagem podem ser usadas em computer_click com o mesmo window.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({ ...targetShape, include_screenshot: z.boolean().optional() })
    .refine((v) => v.app || v.window != null, { message: 'informe app ou window' }),
  describe(a) {
    const args = a as { app?: string; window?: number }
    return { title: 'Árvore de acessibilidade', detail: label(targetOf(args)), preview: label(targetOf(args)) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { app?: string; window?: number; include_screenshot?: boolean }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const target = targetOf(args)
    const snap = await layer.snapshot(target, Boolean(args.include_screenshot))
    if (!snap.ok) return { ...snap, summary: `falhou: ${label(target)}` }
    const text = snap.text || '(árvore vazia — o app pode não expor UI Automation; use screenshot)'
    return {
      ok: true,
      text: `<ax_tree target="${label(target)}">\n${text}\n</ax_tree>`,
      images: snap.images,
      summary: `${label(target)} · ${text.split('\n').length} linhas`,
      data: { app: args.app, window: args.window }
    }
  }
}

export const computerScreenshotTool: ToolDef = {
  name: 'computer_screenshot',
  description:
    'Captura a tela real do Windows (todos os monitores, reduzida para visão). Coordenadas desta imagem podem ser passadas direto a computer_click/computer_drag: o Openclod converte para a tela real.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    max_width: z.number().int().min(640).max(2560).optional()
  }),
  describe() {
    return { title: 'Capturar tela', detail: 'desktop completo' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { max_width?: number }
    const shot = await ctx.services.computer.captureScreen(args.max_width ?? 1600)
    return {
      ok: true,
      text: `captura ${shot.width}x${shot.height} da área de trabalho virtual (${shot.originalWidth}px de largura real, origem ${shot.capture.originX},${shot.capture.originY}). Use coordenadas desta imagem.`,
      images: [shot.image],
      summary: `tela ${shot.width}x${shot.height}`,
      data: { width: shot.width, height: shot.height, path: shot.path, scale: shot.capture.scale }
    }
  }
}

export const computerClickTool: ToolDef = {
  name: 'computer_click',
  description:
    'Clica em um elemento (app/window + element_index, preferido), em coordenadas da imagem de uma janela (window + x,y) ou em coordenadas da última computer_screenshot (só x,y). button="right" abre menus de contexto.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({
      ...targetShape,
      element_index: z.number().int().min(0).optional(),
      x: z.number().min(0).optional(),
      y: z.number().min(0).optional(),
      double: z.boolean().optional(),
      button: z.enum(['left', 'right', 'middle']).optional()
    })
    .refine((v) => (v.element_index != null && (v.app || v.window != null)) || (v.x != null && v.y != null), {
      message: 'informe app/window + element_index, ou x + y'
    }),
  describe(a) {
    const args = a as { app?: string; window?: number; element_index?: number; x?: number; y?: number }
    const where = args.element_index != null ? `${label(targetOf(args))} elemento ${args.element_index}` : `(${args.x}, ${args.y})`
    return { title: 'Clique', detail: where, preview: where }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      app?: string
      window?: number
      element_index?: number
      x?: number
      y?: number
      double?: boolean
      button?: 'left' | 'right' | 'middle'
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const count = args.double ? 2 : 1
    const target = targetOf(args)
    if (args.element_index != null && (args.app || args.window != null)) {
      const result = await layer.clickElement(target, args.element_index, count, args.button)
      return { ...result, summary: `${label(target)}#${args.element_index}${result.ok ? '' : ' (falhou)'}` }
    }
    if (args.window != null) {
      const result = await layer.clickInWindow(args.window, args.x!, args.y!, count, args.button)
      return { ...result, summary: `janela ${args.window} (${args.x}, ${args.y})${result.ok ? '' : ' (falhou)'}` }
    }
    if (args.button && args.button !== 'left') {
      return { ok: false, text: 'clique com botão direito/meio por coordenada exige window; use computer_snapshot com window para obter a imagem da janela' }
    }
    const result = await layer.clickAt({ x: args.x!, y: args.y! }, count)
    return {
      ok: result.code === 0,
      text:
        result.code === 0
          ? `clique em (${args.x}, ${args.y}) da captura → tela (${result.screen.x}, ${result.screen.y})`
          : result.stderr || 'falha no clique',
      summary: `(${args.x}, ${args.y})`
    }
  }
}

export const computerMouseMoveTool: ToolDef = {
  name: 'computer_mouse_move',
  description:
    'Move o ponteiro real do mouse para um ponto da última computer_screenshot, sem clicar. Use para posicionar antes de rolar, arrastar ou abrir um menu.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ x: z.number().min(0), y: z.number().min(0) }),
  describe(a) {
    const args = a as { x: number; y: number }
    return { title: 'Mover mouse', detail: `(${args.x}, ${args.y})`, preview: 'move' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { x: number; y: number }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.moveMouse({ x: args.x, y: args.y })
    const actual = result.actual ? `; cursor em (${result.actual.x}, ${result.actual.y})` : ''
    return {
      ok: result.code === 0,
      text:
        result.code === 0
          ? `ponteiro em (${args.x}, ${args.y}) da captura → tela (${result.screen.x}, ${result.screen.y})${actual}`
          : result.stderr || 'falha ao mover o mouse',
      summary: result.actual ? `(${result.actual.x}, ${result.actual.y})` : `(${args.x}, ${args.y})`
    }
  }
}

export const computerMouseButtonTool: ToolDef = {
  name: 'computer_mouse_button',
  description:
    'Pressiona (down) ou solta (up) um botão do mouse — esquerdo, direito ou do meio — opcionalmente num ponto da última screenshot. Combine com computer_mouse_move para arrastar, selecionar texto ou abrir menus de contexto.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    action: z.enum(['down', 'up']),
    button: z.enum(['left', 'right', 'middle']).optional(),
    x: z.number().min(0).optional(),
    y: z.number().min(0).optional()
  }),
  describe(a) {
    const args = a as { action: string; button?: string; x?: number; y?: number }
    const where = args.x != null && args.y != null ? ` em (${args.x}, ${args.y})` : ''
    return { title: 'Botão do mouse', detail: `${args.action} ${args.button ?? 'left'}${where}`, preview: args.action }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      action: 'down' | 'up'
      button?: 'left' | 'right' | 'middle'
      x?: number
      y?: number
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const point = args.x != null && args.y != null ? { x: args.x, y: args.y } : undefined
    const result = await layer.mouseButton(args.action, args.button ?? 'left', point)
    return {
      ok: result.code === 0,
      text:
        result.code === 0
          ? `${args.action} ${args.button ?? 'left'}${point ? ` em (${point.x}, ${point.y})` : ''}`
          : result.stderr || 'falha no botão do mouse',
      summary: `${args.action} ${args.button ?? 'left'}`
    }
  }
}

export const computerSetValueTool: ToolDef = {
  name: 'computer_set_value',
  description: 'Define o valor de um controle diretamente via UI Automation (mais confiável que digitar).',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({ ...targetShape, element_index: z.number().int().min(0), value: z.string() })
    .refine((v) => v.app || v.window != null, { message: 'informe app ou window' }),
  describe(a) {
    const args = a as { app?: string; window?: number; element_index: number; value: string }
    return {
      title: 'Definir valor',
      detail: `${label(targetOf(args))}#${args.element_index} ← ${args.value.slice(0, 60)}`,
      preview: label(targetOf(args))
    }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { app?: string; window?: number; element_index: number; value: string }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.setValue(targetOf(args), args.element_index, args.value)
    return { ...result, summary: result.ok ? args.value.slice(0, 40) : 'falhou' }
  }
}

export const computerTypeTool: ToolDef = {
  name: 'computer_type_text',
  description:
    'Digita texto. Com app/window + element_index, clica no elemento para focá-lo e digita nele; com app/window, digita no elemento em foco daquela janela; sem alvo, digita na janela em primeiro plano.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    text: z.string(),
    ...targetShape,
    element_index: z.number().int().min(0).optional()
  }),
  describe(a) {
    const args = a as { text: string; app?: string; window?: number }
    const prefix = args.app || args.window != null ? `${label(targetOf(args))}: ` : ''
    return { title: 'Digitar', detail: `${prefix}${args.text.slice(0, 60)}`, preview: args.text.slice(0, 60) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { text: string; app?: string; window?: number; element_index?: number }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const target = targetOf(args)
    if (args.app || args.window != null) {
      if (args.element_index != null) {
        const focus = await layer.clickElement(target, args.element_index)
        if (!focus.ok) return { ...focus, text: `não foi possível focar o elemento: ${focus.text}` }
      }
      const result = await layer.typeIn(target, args.text)
      return { ...result, summary: result.ok ? `${args.text.length} caracteres` : 'falhou' }
    }
    const result = await layer.typeText(args.text)
    return { ok: result.code === 0, text: result.code === 0 ? 'texto digitado' : result.stderr, summary: `${args.text.length} caracteres` }
  }
}

export const computerKeyTool: ToolDef = {
  name: 'computer_press_key',
  description:
    'Pressiona tecla ou combinação (ex.: "ctrl+s", "alt+tab", "Return"). Com app/window envia para aquela janela; sem alvo, para a janela em primeiro plano.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ key: z.string().min(1), ...targetShape }),
  describe(a) {
    const args = a as { key: string }
    return { title: 'Tecla', detail: args.key, preview: args.key }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { key: string; app?: string; window?: number }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    if (args.app || args.window != null) {
      const result = await layer.pressKeyIn(targetOf(args), args.key)
      return { ...result, summary: args.key }
    }
    const result = await layer.pressKey(args.key)
    return { ok: result.code === 0, text: result.code === 0 ? `tecla ${args.key}` : result.stderr, summary: args.key }
  }
}

export const computerScrollTool: ToolDef = {
  name: 'computer_scroll',
  description: 'Rola a tela (direção e quantidade de passos) na posição atual do mouse.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(20).optional(),
    x: z.number().min(0).optional().describe('Ponto da última screenshot onde rolar (opcional)'),
    y: z.number().min(0).optional()
  }),
  describe(a) {
    const args = a as { direction: string; amount?: number }
    return { title: 'Rolar', detail: `${args.direction} x${args.amount ?? 3}`, preview: args.direction }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { direction: 'up' | 'down' | 'left' | 'right'; amount?: number; x?: number; y?: number }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const point = args.x != null && args.y != null ? { x: args.x, y: args.y } : undefined
    const result = await layer.scroll(args.direction, args.amount ?? 3, point)
    return { ok: result.code === 0, text: result.code === 0 ? 'rolagem executada' : result.stderr, summary: args.direction }
  }
}

export const computerDragTool: ToolDef = {
  name: 'computer_drag',
  description: 'Arrasta de um ponto a outro, em coordenadas da última computer_screenshot.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    from_x: z.number().min(0),
    from_y: z.number().min(0),
    to_x: z.number().min(0),
    to_y: z.number().min(0),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Botão usado no arrasto (padrão: left)')
  }),
  describe(a) {
    const args = a as { from_x: number; from_y: number; to_x: number; to_y: number }
    return {
      title: 'Arrastar',
      detail: `(${args.from_x},${args.from_y}) → (${args.to_x},${args.to_y})`,
      preview: 'drag'
    }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { from_x: number; from_y: number; to_x: number; to_y: number; button?: 'left' | 'right' | 'middle' }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.drag(
      { x: args.from_x, y: args.from_y },
      { x: args.to_x, y: args.to_y },
      'screenshot',
      args.button ?? 'left'
    )
    return { ok: result.code === 0, text: result.code === 0 ? 'arrasto executado' : result.stderr, summary: 'drag' }
  }
}

export const computerLaunchTool: ToolDef = {
  name: 'computer_launch',
  description: 'Abre uma aplicação instalada do Windows (ex.: notepad, calc, mspaint) ou um caminho de executável.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ app: z.string().min(1) }),
  describe(a) {
    const args = a as { app: string }
    return { title: 'Abrir aplicativo', detail: args.app, preview: args.app }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { app: string }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.launchApp(args.app)
    if (result.ok) await layer.wait(1)
    return { ...result, summary: result.ok ? args.app : `falhou: ${args.app}` }
  }
}

export const computerActivateTool: ToolDef = {
  name: 'computer_activate',
  description: 'Ativa (traz para frente) uma janela pelo id retornado em computer_list_windows.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ window: z.number().int().min(0) }),
  describe(a) {
    const args = a as { window: number }
    return { title: 'Ativar janela', detail: `janela ${args.window}`, preview: String(args.window) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { window: number }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.activateWindow(args.window)
    return { ...result, summary: result.ok ? `janela ${args.window}` : 'falhou' }
  }
}

export const computerSecondaryActionTool: ToolDef = {
  name: 'computer_secondary_action',
  description:
    'Executa uma ação de acessibilidade secundária num elemento (ex.: expandir/recolher, abrir menu, selecionar). Os nomes de ação aparecem na árvore de computer_snapshot.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({ ...targetShape, element_index: z.number().int().min(0), action: z.string().min(1) })
    .refine((v) => v.app || v.window != null, { message: 'informe app ou window' }),
  describe(a) {
    const args = a as { app?: string; window?: number; element_index: number; action: string }
    return { title: 'Ação secundária', detail: `${label(targetOf(args))}#${args.element_index} ${args.action}`, preview: args.action }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { app?: string; window?: number; element_index: number; action: string }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.secondaryAction(targetOf(args), args.element_index, args.action)
    return { ...result, summary: `${args.action}${result.ok ? '' : ' (falhou)'}` }
  }
}

export const computerWaitTool: ToolDef = {
  name: 'computer_wait',
  description: 'Aguarda N segundos para a interface reagir antes de verificar o novo estado.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ seconds: z.number().min(0.2).max(30) }),
  describe(a) {
    const args = a as { seconds: number }
    return { title: 'Aguardar', detail: `${args.seconds}s`, preview: `${args.seconds}s` }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { seconds: number }
    await ctx.services.computer.wait(args.seconds)
    return { ok: true, text: `aguardou ${args.seconds}s`, summary: `${args.seconds}s` }
  }
}

export const computerWaitForTool: ToolDef = {
  name: 'computer_wait_for',
  description:
    'Espera a interface mudar: consulta a árvore de acessibilidade a cada segundo até aparecer o texto `contains` (ou, sem `contains`, até a árvore mudar), ou até o tempo limite.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({ ...targetShape, contains: z.string().optional(), timeout_s: z.number().min(1).max(120).optional() })
    .refine((v) => v.app || v.window != null, { message: 'informe app ou window' }),
  describe(a) {
    const args = a as { app?: string; window?: number; contains?: string }
    return { title: 'Esperar mudança', detail: `${label(targetOf(args))}${args.contains ? ` · "${args.contains}"` : ''}` }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { app?: string; window?: number; contains?: string; timeout_s?: number }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const target = targetOf(args)
    const deadline = Date.now() + (args.timeout_s ?? 15) * 1000
    const baseline = args.contains ? null : (await layer.snapshot(target)).text
    let last = ''
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) return { ok: false, text: 'cancelado' }
      const snap = await layer.snapshot(target)
      last = snap.text
      if (snap.ok && (args.contains ? last.includes(args.contains) : last !== baseline)) {
        return {
          ok: true,
          text: `<ax_tree target="${label(target)}">\n${last}\n</ax_tree>`,
          summary: args.contains ? `"${args.contains}" apareceu` : 'interface mudou'
        }
      }
      await layer.wait(1)
    }
    return {
      ok: false,
      text: `tempo esgotado esperando ${args.contains ? `"${args.contains}"` : 'mudança'} em ${label(target)}. Último estado:\n${last.slice(0, 4000)}`,
      summary: 'tempo esgotado'
    }
  }
}

export const computerTools: ToolDef[] = [
  computerListWindowsTool,
  computerSnapshotTool,
  computerScreenshotTool,
  computerClickTool,
  computerMouseMoveTool,
  computerMouseButtonTool,
  computerSetValueTool,
  computerTypeTool,
  computerKeyTool,
  computerScrollTool,
  computerDragTool,
  computerLaunchTool,
  computerActivateTool,
  computerSecondaryActionTool,
  computerWaitTool,
  computerWaitForTool
]
