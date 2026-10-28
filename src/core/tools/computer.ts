import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ImagePart, ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import { pointerGridFor, type ComputerLayer, type Target } from '../computer/layer.js'

interface WindowProbe {
  root: number
  hit: number
  title: string
  class: string
}

/** Native hit-test: which top-level window really receives a screen point. */
function windowAtPoint(x: number, y: number): Promise<WindowProbe | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class OpenclodWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint ga);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
$p = [OpenclodWindowProbe+POINT]::new()
$p.X = ${Math.round(x)}
$p.Y = ${Math.round(y)}
$h = [OpenclodWindowProbe]::WindowFromPoint($p)
$root = [OpenclodWindowProbe]::GetAncestor($h, 2)
$t = New-Object System.Text.StringBuilder 512
$c = New-Object System.Text.StringBuilder 256
[void][OpenclodWindowProbe]::GetWindowText($root, $t, 512)
[void][OpenclodWindowProbe]::GetClassName($root, $c, 256)
@{ root = $root.ToInt64(); hit = $h.ToInt64(); title = $t.ToString(); class = $c.ToString() } | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8_000 },
      (error, stdout) => {
        if (error || !stdout.trim()) return resolve(null)
        try {
          const value = JSON.parse(stdout.trim()) as WindowProbe
          return resolve(value)
        } catch {
          return resolve(null)
        }
      }
    )
  })
}

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

/** Adds the screen point the overlay should animate to. */
function withData(result: ToolResult, data: Record<string, unknown>): ToolResult {
  return { ...result, data: { ...(result.data ?? {}), ...data } }
}

/**
 * Moves the agent overlay pointer before the real input runs and gives the
 * 460 ms cursor transition a head start, so the user sees the agent icon move
 * first instead of only the physical Windows pointer jumping.
 */
async function showCursor(
  ctx: { progress?(text: string, data?: Record<string, unknown>): void },
  point: { x: number; y: number } | null
): Promise<void> {
  if (!point || !ctx.progress) return
  ctx.progress('', { screen: point })
  await new Promise((resolve) => setTimeout(resolve, 320))
}

/**
 * What the model looks at after pointing by coordinates: a 1:1 crop of the real screen around the pointer with a red cross on
 * it. A model that only gets "moved to (x, y)" cannot tell it stopped beside the button; with the crop it can correct before
 * clicking. Only for models that receive images.
 */
async function pointerLook(
  ctx: ToolContext,
  layer: ComputerLayer,
  point: { x: number; y: number } | null
): Promise<{ text: string; image: ImagePart } | null> {
  if (!ctx.vision || !point || typeof layer.captureAround !== 'function') return null
  const image = await layer.captureAround(point).catch(() => null)
  if (!image) return null
  return {
    image,
    text:
      '. Imagem: recorte de 220x220 px reais ao redor do ponteiro (a cruz vermelha é onde ele está). ' +
      'Se a cruz não estiver sobre o alvo, corrija com uma nova computer_screenshot antes de clicar.'
  }
}

/**
 * After an action, for a vision model, a fresh picture of where it happened so it can confirm the result in the
 * same step instead of acting blind. Element/window actions get the window image through the layer; this covers
 * the paths that do not (global keyboard, scroll, drag), capturing the window when there is one, else the monitor.
 */
async function afterView(
  ctx: ToolContext,
  layer: ComputerLayer,
  target: { app?: string; window?: number }
): Promise<{ images?: ImagePart[]; note: string }> {
  if (!ctx.vision) return { note: '' }
  try {
    if (target.window != null) {
      const snap = await layer.snapshot({ window: target.window, app: target.app }, true)
      if (snap.images?.length) return { images: snap.images, note: '\n[imagem da janela anexada: confirme o resultado antes do próximo passo; se não deu certo, mude a abordagem.]' }
      return { note: '' }
    }
    const grid = pointerGridFor(ctx.model)
    const shot = await layer.captureScreen(1280, { grid })
    return {
      images: [shot.image],
      note:
        `\n[captura ${shot.shown ? `do monitor ${shot.shown}` : ''} anexada: confirme o resultado antes do próximo passo. ` +
        `${grid ? `Para apontar, use 0 a ${grid} em cada eixo.` : `Pixels desta imagem ${shot.width}x${shot.height}.`}]`
    }
  } catch {
    return { note: '' }
  }
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

/** Accepts `element_index` or a stable `ref` such as `e12` from a snapshot. */
function elementIndex(args: { element_index?: number; ref?: string }): number {
  if (args.element_index != null) return args.element_index
  const match = /^e?(\d+)$/i.exec(args.ref ?? '')
  return match ? Number(match[1]) : -1
}

const elementShape = {
  element_index: z.number().int().min(0).optional().describe('Índice do elemento na última árvore de acessibilidade'),
  ref: z.string().regex(/^e?\d+$/i).optional().describe('Referência do snapshot (ex.: e12)'),
  snapshot_id: z.string().min(1).optional().describe('Id do computer_snapshot que produziu a ref; refs de snapshot antigo são recusadas')
}

/** Opt-in post-action verification, like Munim's `return_state`. */
const observeShape = {
  observe_after: z
    .boolean()
    .optional()
    .describe(
      'Depois de agir, espera a interface parar de mudar e devolve um snapshot novo (settle). Ligado por padrão para confirmar o resultado; passe false para ações em sequência rápida onde você não precisa verificar cada uma.'
    )
}

/** Resolves a model-facing element reference only against the latest snapshot. */
function resolveElement(
  args: { element_index?: number; ref?: string; snapshot_id?: string; app?: string; window?: number },
  layer: ComputerLayer
): number | ToolResult {
  if (args.ref) {
    const resolved = layer.resolveSnapshotRef(targetOf(args), args.snapshot_id, args.ref)
    if (resolved.error) return { ok: false, text: resolved.error, summary: 'element_stale' }
    return resolved.index!
  }
  return elementIndex(args)
}

const inputMethodShape = {
  input_method: z
    .enum(['auto', 'global'])
    .optional()
    .describe('auto = UI Automation/mensagem em segundo plano; global = SendInput na janela em primeiro plano')
}

const computerNote =
  'Percepção híbrida: primeiro a árvore de UI Automation (com element_index/ref), depois screenshot. A computer_screenshot captura um monitor por vez (o principal por padrão, outro com monitor=N), incluindo barra de tarefas, menu Iniciar, menus abertos e bandeja do sistema; para interagir com eles, use as coordenadas dessa captura. Cada ação de elemento retorna snapshot_id, generation e state_changed; verifique o estado após cada ação.'

export const computerListAppsTool: ToolDef = {
  name: 'computer_list_apps',
  description:
    'Lista aplicativos instalados e em execução, incluindo janelas utilizáveis. Use antes de computer_launch para obter o id ou nome correto do aplicativo.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({}),
  describe() {
    return { title: 'Aplicativos disponíveis', detail: 'listar apps instalados e em execução' }
  },
  async execute(_raw, ctx) {
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const result = await layer.listApps()
    const running = (result.text.match(/\[running/g) ?? []).length
    return { ...result, summary: result.ok ? `${running} apps em execução` : 'falha ao listar apps' }
  }
}

export const computerGetWindowTool: ToolDef = {
  name: 'computer_get_window',
  description:
    'Reidrata uma janela por id retornado anteriormente, útil após perder a referência. Não invente nem ajuste o id.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ window: z.number().int().min(0), app: z.string().min(1).optional() }),
  describe(a) {
    const args = a as { window: number; app?: string }
    return { title: 'Reidratar janela', detail: `janela ${args.window}`, preview: String(args.window) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { window: number; app?: string }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    return layer.getWindow(args.window, args.app)
  }
}

export const computerCursorPositionTool: ToolDef = {
  name: 'computer_cursor_position',
  description: 'Lê a posição real do cursor de mouse na tela, em pixels absolutos.',
  risk: 'read',
  parallelSafe: true,
  requires: 'computer',
  schema: z.object({}),
  describe() {
    return { title: 'Posição do cursor', detail: 'tela absoluta' }
  },
  async execute(_raw, ctx) {
    const position = await ctx.services.computer.cursorPosition()
    if (!position) return { ok: false, text: 'não foi possível ler a posição do cursor', summary: 'indisponível' }
    return {
      ok: true,
      text: `cursor em (${position.x}, ${position.y})`,
      summary: `(${position.x}, ${position.y})`,
      data: position
    }
  }
}

export const computerWindowAtTool: ToolDef = {
  name: 'computer_window_at',
  description:
    'Faz hit-test nativo em um ponto e diz qual janela realmente receberia o clique (id, título e classe). Use antes de clicar por coordenada quando houver risco da janela errada estar na frente.',
  risk: 'read',
  parallelSafe: true,
  requires: 'computer',
  schema: z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    space: z.enum(['screenshot', 'screen']).optional().describe('Padrão: coordenadas da última computer_screenshot')
  }),
  describe(a) {
    const args = a as { x: number; y: number }
    return { title: 'Janela no ponto', detail: `(${args.x}, ${args.y})` }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { x: number; y: number; space?: 'screenshot' | 'screen' }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const screen =
      args.space === 'screen' ? { x: args.x, y: args.y } : layer.screenPointFor({ x: args.x, y: args.y })
    if (!screen) return { ok: false, text: 'ponto fora da última captura; tire um novo computer_screenshot' }
    const probe = await windowAtPoint(screen.x, screen.y)
    if (!probe) return { ok: false, text: 'não foi possível fazer o hit-test nativo', data: { screen } }
    return {
      ok: true,
      text: `janela sob (${screen.x}, ${screen.y}): ${probe.title || '(sem título)'} · classe ${probe.class} · id ${probe.root} (hit ${probe.hit})`,
      summary: probe.title || `janela ${probe.root}`,
      data: { ...probe, screen }
    }
  }
}

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
    .object({
      ...targetShape,
      include_screenshot: z.boolean().optional(),
      max_chars: z.number().int().min(1000).max(80_000).optional().describe('Limite do texto da árvore'),
      depth: z.number().int().min(1).max(30).optional().describe('Profundidade máxima da árvore'),
      interactive_only: z.boolean().optional().describe('Mantém apenas controles interativos')
    })
    .refine((v) => v.app || v.window != null, { message: 'informe app ou window' }),
  describe(a) {
    const args = a as { app?: string; window?: number }
    return { title: 'Árvore de acessibilidade', detail: label(targetOf(args)), preview: label(targetOf(args)) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      app?: string
      window?: number
      include_screenshot?: boolean
      max_chars?: number
      depth?: number
      interactive_only?: boolean
    }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const target = targetOf(args)
    const snap = await layer.snapshot(target, Boolean(args.include_screenshot))
    if (!snap.ok) return { ...snap, summary: `falhou: ${label(target)}` }
    let text = snap.text || '(árvore vazia - o app pode não expor UI Automation; use screenshot)'
    if (args.depth) {
      text = text
        .split('\n')
        .filter((line) => {
          const indent = /^[\t ]*/.exec(line)?.[0] ?? ''
          const level = (indent.match(/\t/g)?.length ?? 0) + Math.floor((indent.match(/ /g)?.length ?? 0) / 2)
          return level <= args.depth!
        })
        .join('\n')
    }
    if (args.interactive_only) {
      text = text
        .split('\n')
        .filter((line) => line.trim() && !/^\s*(text|paragraph|static|image|heading)\b/i.test(line))
        .join('\n')
    }
    if (args.max_chars && text.length > args.max_chars) {
      text = `${text.slice(0, args.max_chars)}\n.[árvore truncada em ${args.max_chars} caracteres]`
    }
    return {
      ok: true,
      text: `<ax_tree target="${label(target)}" snapshot="${(snap.data as { snapshot_id?: string } | undefined)?.snapshot_id ?? ''}">\n${text}\n</ax_tree>`,
      images: snap.images,
      summary: `${label(target)} · ${text.split('\n').length} linhas`,
      data: { app: args.app, window: args.window, ...(snap.data as Record<string, unknown> | undefined) }
    }
  }
}

export const computerScreenshotTool: ToolDef = {
  name: 'computer_screenshot',
  description:
    'Captura a tela real do Windows, um monitor por vez (o principal por padrão; outro com monitor=N; monitor=0 junta todos, com menos detalhe), incluindo barra de tarefas, menu Iniciar, menus abertos e bandeja. Se o que você precisa não estiver no monitor capturado, capture o outro; se o usuário disser em qual tela fazer, use essa. O resultado diz em que coordenadas apontar (pixels da imagem, ou relativas 0-1000 para modelos treinados assim); passe-as direto a computer_click/computer_mouse_move/computer_drag: o Openclod converte para a tela real.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    max_width: z.number().int().min(640).max(2560).optional(),
    monitor: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe('Qual monitor capturar: 1, 2… (padrão: o principal). 0 = todos juntos, com menos detalhe'),
    annotate: z
      .boolean()
      .optional()
      .describe('Inclui a lista de janelas com ids; útil quando o modelo não recebe imagens')
  }),
  describe() {
    return { title: 'Capturar tela', detail: 'desktop completo' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { max_width?: number; monitor?: number; annotate?: boolean }
    const grid = pointerGridFor(ctx.model)
    const shot = await ctx.services.computer.captureScreen(args.max_width ?? 0, { grid, monitor: args.monitor })
    const physicalHeight = shot.capture.scale > 0 ? Math.round(shot.height / shot.capture.scale) : shot.height
    const how = grid
      ? `Para apontar (computer_click, computer_mouse_move, computer_drag, computer_scroll), use x,y RELATIVOS a esta imagem, de 0 a ${grid} em cada eixo ` +
        `(0,0 = canto superior esquerdo; ${grid},${grid} = canto inferior direito); o harness converte para a tela real.`
      : `Use x,y em pixels desta imagem (${shot.width}x${shot.height}); o harness converte para a tela real.`
    const list = shot.monitors ?? []
    const shown = shot.shown ?? args.monitor ?? 0
    const where = shown ? `do monitor ${shown}${list.find((item) => item.index === shown)?.primary ? ' (principal)' : ''}` : 'de todos os monitores juntos'
    const others = list.filter((item) => item.index !== shown)
    const monitors =
      list.length > 1
        ? ` Monitores: ${list.map((item) => `${item.index} = ${item.width}x${item.height} em ${item.x},${item.y}${item.primary ? ' (principal)' : ''}`).join('; ')}. ` +
          (shown
            ? `Esta imagem mostra só o monitor ${shown}. Se o que você precisa não estiver nela, capture ${others.map((item) => `monitor=${item.index}`).join(' ou ')}; se o usuário disser em qual tela fazer, use essa.`
            : 'Para ver um com mais detalhe, use monitor=N.')
        : ''
    const annotate = args.annotate ?? !ctx.vision
    let windows = ''
    if (annotate) {
      const list = await ctx.services.computer.listWindows().catch(() => null)
      if (list?.ok && list.text) windows = `\n\nJanelas abertas (use com computer_list_windows/computer_activate):\n${list.text.slice(0, 4000)}`
    }
    return {
      ok: true,
      text:
        `captura ${shot.width}x${shot.height} ${where} ` +
        `(${shot.originalWidth}x${physicalHeight}px reais, origem ${shot.capture.originX},${shot.capture.originY}). ` +
        `Escala ${shot.capture.scale.toFixed(4)}: 1 px da imagem = ${(1 / shot.capture.scale).toFixed(3)} px reais. ` +
        `${how}${monitors}${windows}`,
      images: [shot.image],
      summary: `tela ${shot.width}x${shot.height} (escala ${shot.capture.scale.toFixed(3)})`,
      data: {
        width: shot.width,
        height: shot.height,
        physicalWidth: shot.originalWidth,
        physicalHeight,
        originX: shot.capture.originX,
        originY: shot.capture.originY,
        scale: shot.capture.scale,
        grid,
        path: shot.path
      }
    }
  }
}

export const computerClickTool: ToolDef = {
  name: 'computer_click',
  description:
    'Clica em um elemento (app/window + element_index, preferido), em coordenadas da imagem de uma janela (window + x,y) ou em coordenadas da última computer_screenshot (só x,y). button="right" abre menus de contexto. expect_window/expect_title fazem hit-test antes e cancelam se a janela errada estiver na frente.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({
      ...targetShape,
      ...elementShape,
      x: z.number().min(0).optional(),
      y: z.number().min(0).optional(),
      double: z.boolean().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      click_method: z.enum(['auto', 'accessibility', 'app_post', 'global']).optional(),
      expect_window: z.number().int().optional().describe('Id da janela que deve receber o clique (hit-test antes)'),
      expect_title: z.string().min(1).optional().describe('Trecho do título que deve receber o clique'),
      ...inputMethodShape,
      ...observeShape
    })
    .refine(
      (v) =>
        ((v.element_index != null || v.ref) && (v.app || v.window != null)) ||
        (v.x != null && v.y != null),
      { message: 'informe app/window + element_index/ref, ou x + y' }
    ),
  describe(a) {
    const args = a as { app?: string; window?: number; element_index?: number; ref?: string; x?: number; y?: number }
    const index = elementIndex(args)
    const where = index >= 0 ? `${label(targetOf(args))} elemento ${index}` : `(${args.x}, ${args.y})`
    return { title: 'Clique', detail: where, preview: where }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      app?: string
      window?: number
      element_index?: number
      ref?: string
      x?: number
      y?: number
      double?: boolean
      button?: 'left' | 'right' | 'middle'
      click_method?: 'auto' | 'accessibility' | 'app_post' | 'global'
      input_method?: 'auto' | 'global'
      observe_after?: boolean
      expect_window?: number
      expect_title?: string
    }
    if (args.input_method === 'global' && args.window == null && !args.app) {
      return {
        ok: false,
        text: 'input_method=global exige app ou window; um clique sobre a captura global não tem alvo verificável.',
        summary: 'alvo ausente'
      }
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const count = args.double ? 2 : 1
    const target = targetOf(args)
    const resolved = resolveElement(args, layer)
    if (typeof resolved !== 'number') return resolved
    const index = resolved
    const verify = async (point: { x: number; y: number } | null): Promise<ToolResult | null> => {
      if (args.expect_window === undefined && !args.expect_title) return null
      if (!point) return { ok: false, text: 'não foi possível calcular o ponto do clique para o hit-test' }
      const probe = await windowAtPoint(point.x, point.y)
      if (!probe) return { ok: false, text: 'não foi possível fazer o hit-test nativo; clique cancelado' }
      if (args.expect_window !== undefined && probe.root !== args.expect_window) {
        return {
          ok: false,
          text: `clique cancelado: a janela sob o ponto é ${probe.title || '(sem título)'} (id ${probe.root}), não ${args.expect_window}`,
          summary: 'janela errada',
          data: { ...probe }
        }
      }
      if (args.expect_title && !probe.title.toLowerCase().includes(args.expect_title.toLowerCase())) {
        return {
          ok: false,
          text: `clique cancelado: a janela sob o ponto é "${probe.title || '(sem título)'}", não "${args.expect_title}"`,
          summary: 'janela errada',
          data: { ...probe }
        }
      }
      return null
    }
    if (index >= 0 && (args.app || args.window != null)) {
      const point = layer.cursorForElement(target, index)
      const mismatch = await verify(point)
      if (mismatch) return mismatch
      await showCursor(ctx, point)
      const result = await layer.clickElementWithOptions(
        target,
        index,
        count,
        args.button,
        args.input_method,
        args.click_method,
        args.observe_after ?? true,
        ctx.vision
      )
      const screen =
        result.data && typeof result.data === 'object'
          ? (result.data as Record<string, unknown>).screen
          : undefined
      const cursor = screen ? null : await layer.cursorPosition().catch(() => null)
      return withData(
        { ...result, summary: `${label(target)}#${index}${result.ok ? '' : ' (falhou)'}` },
        screen ? { screen } : cursor ? { cursor } : {}
      )
    }
    if (args.window != null) {
      if (args.expect_window !== undefined || args.expect_title) {
        return {
          ok: false,
          text: 'expect_window/expect_title exigem um clique de elemento ou coordenada global; não são verificáveis em coordenadas relativas à janela'
        }
      }
      const result = await layer.clickInWindowWithOptions(
        args.window,
        args.x!,
        args.y!,
        count,
        args.button,
        args.input_method,
        args.click_method,
        args.observe_after ?? true,
        ctx.vision
      )
      const cursor = await layer.cursorPosition().catch(() => null)
      return withData(
        { ...result, summary: `janela ${args.window} (${args.x}, ${args.y})${result.ok ? '' : ' (falhou)'}` },
        cursor ? { cursor } : {}
      )
    }
    if (args.button && args.button !== 'left') {
      return { ok: false, text: 'clique com botão direito/meio por coordenada exige window; use computer_snapshot com window para obter a imagem da janela' }
    }
    const globalPoint = layer.screenPointFor({ x: args.x!, y: args.y! })
    const mismatch = await verify(globalPoint)
    if (mismatch) return mismatch
    await showCursor(ctx, globalPoint)
    const result = await layer.clickAt({ x: args.x!, y: args.y! }, count)
    const look = result.code === 0 ? await pointerLook(ctx, layer, result.screen) : null
    return withData(
      {
        ok: result.code === 0,
        text:
          result.code === 0
            ? `clique em (${args.x}, ${args.y}) da captura → tela (${result.screen.x}, ${result.screen.y})${look ? look.text : ''}`
            : result.stderr || 'falha no clique',
        summary: `(${args.x}, ${args.y})`,
        ...(look ? { images: [look.image] } : {})
      },
      { screen: result.screen }
    )
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
    await showCursor(ctx, layer.screenPointFor({ x: args.x, y: args.y }))
    const result = await layer.moveMouse({ x: args.x, y: args.y })
    const actual = result.actual ? `; cursor em (${result.actual.x}, ${result.actual.y})` : ''
    const look = result.code === 0 ? await pointerLook(ctx, layer, result.actual ?? result.screen) : null
    return withData(
      {
        ok: result.code === 0,
        text:
          result.code === 0
            ? `ponteiro em (${args.x}, ${args.y}) da captura → tela (${result.screen.x}, ${result.screen.y})${actual}${look ? look.text : ''}`
            : result.stderr || 'falha ao mover o mouse',
        summary: result.actual ? `(${result.actual.x}, ${result.actual.y})` : `(${args.x}, ${args.y})`,
        ...(look ? { images: [look.image] } : {})
      },
      { screen: result.screen, ...(result.actual ? { actual: result.actual } : {}) }
    )
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
    if (point) await showCursor(ctx, layer.screenPointFor(point))
    const result = await layer.mouseButton(args.action, args.button ?? 'left', point)
    const cursor = result.screen ? undefined : await layer.cursorPosition().catch(() => null)
    return withData(
      {
        ok: result.code === 0,
        text:
          result.code === 0
            ? `${args.action} ${args.button ?? 'left'}${point ? ` em (${point.x}, ${point.y})` : ''}`
            : result.stderr || 'falha no botão do mouse',
        summary: `${args.action} ${args.button ?? 'left'}`
      },
      { ...(result.screen ? { screen: result.screen } : {}), ...(cursor ? { cursor } : {}) }
    )
  }
}

export const computerSetValueTool: ToolDef = {
  name: 'computer_set_value',
  description: 'Define o valor de um controle diretamente via UI Automation (mais confiável que digitar).',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({ ...targetShape, ...elementShape, value: z.string(), ...observeShape })
    .refine((v) => (v.element_index != null || v.ref) && (v.app || v.window != null), {
      message: 'informe app/window + element_index/ref'
    }),
  describe(a) {
    const args = a as { app?: string; window?: number; element_index?: number; ref?: string; value: string }
    return {
      title: 'Definir valor',
      detail: `${label(targetOf(args))}#${elementIndex(args)} ← ${args.value.slice(0, 60)}`,
      preview: label(targetOf(args))
    }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      app?: string
      window?: number
      element_index?: number
      ref?: string
      value: string
      observe_after?: boolean
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const resolved = resolveElement(args, layer)
    if (typeof resolved !== 'number') return resolved
    await showCursor(ctx, layer.cursorForElement(targetOf(args), resolved))
    const result = await layer.setValue(targetOf(args), resolved, args.value, args.observe_after ?? true, ctx.vision)
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
    ...elementShape,
    ...inputMethodShape,
    ...observeShape
  }),
  describe(a) {
    const args = a as { text: string; app?: string; window?: number }
    const prefix = args.app || args.window != null ? `${label(targetOf(args))}: ` : ''
    return { title: 'Digitar', detail: `${prefix}${args.text.slice(0, 60)}`, preview: args.text.slice(0, 60) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      text: string
      app?: string
      window?: number
      element_index?: number
      ref?: string
      input_method?: 'auto' | 'global'
      observe_after?: boolean
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const target = targetOf(args)
    const resolved = resolveElement(args, layer)
    if (typeof resolved !== 'number') return resolved
    const index = resolved
    if (args.app || args.window != null) {
      if (index >= 0) {
        await showCursor(ctx, layer.cursorForElement(target, index))
        const focus = await layer.clickElement(target, index)
        if (!focus.ok) return { ...focus, text: `não foi possível focar o elemento: ${focus.text}` }
        const result = await layer.typeIn(target, args.text, args.input_method, args.observe_after ?? true, ctx.vision)
        const screen =
          focus.data && typeof focus.data === 'object'
            ? (focus.data as Record<string, unknown>).screen
            : undefined
        return withData(
          { ...result, summary: result.ok ? `${args.text.length} caracteres` : 'falhou' },
          screen ? { screen } : {}
        )
      }
      const result = await layer.typeIn(target, args.text, args.input_method, args.observe_after ?? true, ctx.vision)
      return { ...result, summary: result.ok ? `${args.text.length} caracteres` : 'falhou' }
    }
    const result = await layer.typeText(args.text)
    if (result.code !== 0) return { ok: false, text: result.stderr || 'falha ao digitar', summary: 'falhou' }
    const view = await afterView(ctx, layer, {})
    return {
      ok: true,
      text: `texto digitado${view.note}`,
      ...(view.images ? { images: view.images } : {}),
      summary: `${args.text.length} caracteres`
    }
  }
}

export const computerKeyTool: ToolDef = {
  name: 'computer_press_key',
  description:
    'Pressiona tecla ou combinação (ex.: "ctrl+s", "alt+tab", "Return"). Com app/window envia para aquela janela; sem alvo, para a janela em primeiro plano.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({ key: z.string().min(1), ...targetShape, ...inputMethodShape }),
  describe(a) {
    const args = a as { key: string }
    return { title: 'Tecla', detail: args.key, preview: args.key }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { key: string; app?: string; window?: number; input_method?: 'auto' | 'global' }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    if (args.app || args.window != null) {
      const result = await layer.pressKeyIn(targetOf(args), args.key, args.input_method)
      if (!result.ok) return { ...result, summary: args.key }
      const view = await afterView(ctx, layer, targetOf(args))
      return { ...result, text: `${result.text}${view.note}`, ...(view.images ? { images: view.images } : {}), summary: args.key }
    }
    const result = await layer.pressKey(args.key)
    if (result.code !== 0) return { ok: false, text: result.stderr || 'falha na tecla', summary: args.key }
    const view = await afterView(ctx, layer, {})
    return { ok: true, text: `tecla ${args.key}${view.note}`, ...(view.images ? { images: view.images } : {}), summary: args.key }
  }
}

export const computerScrollTool: ToolDef = {
  name: 'computer_scroll',
  description:
    'Rola a interface. Com window + x/y usa a janela observada e o gate de screenshot; sem window rola a captura global. Use scroll_x/scroll_y em pixels para rolagem precisa ou direction/amount no desktop.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Direção no modo global; omitida no modo por janela com scroll_x/scroll_y'),
    amount: z.number().int().min(1).max(20).optional(),
    x: z.number().min(0).optional().describe('Ponto da última screenshot onde rolar (opcional)'),
    y: z.number().min(0).optional(),
    window: z.number().int().min(0).optional().describe('Janela observada; x/y ficam relativos à janela'),
    scroll_x: z.number().optional().describe('Delta horizontal em pixels, negativo para a esquerda'),
    scroll_y: z.number().optional().describe('Delta vertical em pixels, negativo para cima'),
    ...inputMethodShape
  }),
  describe(a) {
    const args = a as { direction: string; amount?: number }
    return { title: 'Rolar', detail: `${args.direction} x${args.amount ?? 3}`, preview: args.direction }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      direction?: 'up' | 'down' | 'left' | 'right'
      amount?: number
      x?: number
      y?: number
      window?: number
      scroll_x?: number
      scroll_y?: number
      input_method?: 'auto' | 'global'
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    if (args.window != null) {
      if (args.x == null || args.y == null) return { ok: false, text: 'com window, informe x e y da captura da janela' }
      if (args.scroll_x == null && args.scroll_y == null && !args.direction) {
        return { ok: false, text: 'informe direction ou scroll_x/scroll_y' }
      }
      const delta =
        args.scroll_x != null || args.scroll_y != null
          ? { x: args.scroll_x ?? 0, y: args.scroll_y ?? 0 }
          : args.direction === 'down'
            ? { x: 0, y: (args.amount ?? 3) * 120 }
            : args.direction === 'up'
              ? { x: 0, y: -(args.amount ?? 3) * 120 }
              : args.direction === 'right'
                ? { x: (args.amount ?? 3) * 120, y: 0 }
                : { x: -(args.amount ?? 3) * 120, y: 0 }
      const result = await layer.scrollInWindow(args.window, args.x, args.y, delta.x, delta.y, undefined, args.input_method)
      const cursor = result.ok ? await layer.cursorPosition().catch(() => null) : null
      const view = result.ok ? await afterView(ctx, layer, { window: args.window }) : { note: '' }
      return withData(
        {
          ...result,
          text: `${result.text}${'note' in view ? view.note : ''}`,
          ...('images' in view && view.images ? { images: view.images } : {}),
          summary: result.ok ? `janela ${args.window} · ${args.direction ?? `scroll ${delta.x},${delta.y}`}` : `falhou: ${result.text.slice(0, 140)}`
        },
        cursor ? { cursor } : {}
      )
    }
    if (!args.direction) return { ok: false, text: 'sem window, informe direction para a captura global' }
    const point = args.x != null && args.y != null ? { x: args.x, y: args.y } : undefined
    if (point) await showCursor(ctx, layer.screenPointFor(point))
    const result = await layer.scroll(args.direction, args.amount ?? 3, point)
    const view = result.code === 0 ? await afterView(ctx, layer, {}) : { note: '' }
    return withData(
      {
        ok: result.code === 0,
        text: result.code === 0 ? `rolagem executada${'note' in view ? view.note : ''}` : result.stderr,
        ...('images' in view && view.images ? { images: view.images } : {}),
        summary: args.direction
      },
      result.screen ? { screen: result.screen } : {}
    )
  }
}

export const computerDragTool: ToolDef = {
  name: 'computer_drag',
  description:
    'Arrasta de um ponto a outro. Com window, as coordenadas são relativas à imagem mais recente da janela. Sem window, usa a última computer_screenshot global.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    from_x: z.number().min(0),
    from_y: z.number().min(0),
    to_x: z.number().min(0),
    to_y: z.number().min(0),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Botão usado no arrasto (padrão: left)'),
    window: z.number().int().min(0).optional().describe('Janela observada; coordenadas ficam relativas à imagem da janela'),
    ...inputMethodShape
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
    const args = this.schema.parse(raw) as {
      from_x: number
      from_y: number
      to_x: number
      to_y: number
      button?: 'left' | 'right' | 'middle'
      window?: number
      input_method?: 'auto' | 'global'
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    if (args.window != null) {
      const result = await layer.dragInWindow(
        args.window,
        { x: args.from_x, y: args.from_y },
        { x: args.to_x, y: args.to_y },
        undefined,
        args.input_method
      )
      const cursor = result.ok ? await layer.cursorPosition().catch(() => null) : null
      const view = result.ok ? await afterView(ctx, layer, { window: args.window }) : { note: '' }
      return withData(
        {
          ...result,
          text: `${result.text}${'note' in view ? view.note : ''}`,
          ...('images' in view && view.images ? { images: view.images } : {}),
          summary: result.ok ? `janela ${args.window} · drag` : `falhou: ${result.text.slice(0, 140)}`
        },
        cursor ? { cursor } : {}
      )
    }
    await showCursor(ctx, layer.screenPointFor({ x: args.from_x, y: args.from_y }))
    const result = await layer.drag(
      { x: args.from_x, y: args.from_y },
      { x: args.to_x, y: args.to_y },
      'screenshot',
      args.button ?? 'left'
    )
    const view = result.code === 0 ? await afterView(ctx, layer, {}) : { note: '' }
    return withData(
      {
        ok: result.code === 0,
        text: result.code === 0 ? `arrasto executado${'note' in view ? view.note : ''}` : result.stderr,
        ...('images' in view && view.images ? { images: view.images } : {}),
        summary: 'drag'
      },
      { from: result.from, to: result.to }
    )
  }
}

export const computerOpenPathTool: ToolDef = {
  name: 'computer_open_path',
  description:
    'Abre uma pasta ou arquivo local com o aplicativo padrão do Windows, sem clicar em ícones. Use reveal=true para abrir o Explorer com o item selecionado. É a forma mais segura e determinística de abrir algo que o usuário pediu.',
  risk: 'exec',
  parallelSafe: false,
  requires: 'computer',
  schema: z.object({
    path: z.string().min(1).describe('Caminho absoluto ou relativo ao projeto'),
    reveal: z.boolean().optional().describe('Abrir o Explorer já com o item selecionado')
  }),
  describe(a) {
    const args = a as { path: string }
    return { title: 'Abrir caminho', detail: args.path, preview: path.basename(args.path) }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { path: string; reveal?: boolean }
    if (process.platform !== 'win32') return { ok: false, text: 'computer_open_path é específico do Windows' }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const target = path.resolve(ctx.cwd, args.path)
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return { ok: false, text: `caminho não encontrado: ${target}` }
    }
    const folder = stat.isDirectory()
    // Absolute paths to the Windows tools so a shell PATH without C:\Windows cannot turn this into ENOENT, and
    // the spawn's async 'error' is caught: a tool must never crash the harness, only return ok:false.
    const windows = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const [command, spawnArgs] =
      args.reveal || folder
        ? [path.join(windows, 'explorer.exe'), args.reveal ? [`/select,${target}`] : [target]]
        : [path.join(windows, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', target]]
    const spawnError = await new Promise<Error | null>((resolve) => {
      let child
      try {
        child = spawn(command, spawnArgs, { detached: true, windowsHide: true })
      } catch (err) {
        resolve(err as Error)
        return
      }
      let settled = false
      const done = (value: Error | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      child.on('error', (err) => done(err))
      // explorer.exe returns immediately; give a real failure time to surface, then treat it as launched.
      child.unref()
      setTimeout(() => done(null), 700)
    })
    if (spawnError) {
      return { ok: false, text: `não consegui abrir ${target}: ${spawnError.message}`, summary: 'falha ao abrir' }
    }
    return {
      ok: true,
      text: `${folder ? 'pasta' : 'arquivo'} aberto: ${target}${args.reveal ? ' (selecionado no Explorer)' : ''}`,
      summary: `${folder ? 'pasta' : 'arquivo'} ${path.basename(target)}`,
      data: { path: target, kind: folder ? 'folder' : 'file', reveal: Boolean(args.reveal) }
    }
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
    .object({ ...targetShape, ...elementShape, action: z.string().min(1), ...observeShape })
    .refine((v) => (v.element_index != null || v.ref) && (v.app || v.window != null), {
      message: 'informe app/window + element_index/ref'
    }),
  describe(a) {
    const args = a as { app?: string; window?: number; element_index?: number; ref?: string; action: string }
    return { title: 'Ação secundária', detail: `${label(targetOf(args))}#${elementIndex(args)} ${args.action}`, preview: args.action }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as {
      app?: string
      window?: number
      element_index?: number
      ref?: string
      action: string
      observe_after?: boolean
    }
    const blocked = requireControl(ctx)
    if (blocked) return { ok: false, text: blocked }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const resolved = resolveElement(args, layer)
    if (typeof resolved !== 'number') return resolved
    await showCursor(ctx, layer.cursorForElement(targetOf(args), resolved))
    const result = await layer.secondaryAction(targetOf(args), resolved, args.action, undefined, args.observe_after ?? true, ctx.vision)
    return { ...result, summary: `${args.action}${result.ok ? '' : ' (falhou)'}` }
  }
}

export const computerWaitForWindowTool: ToolDef = {
  name: 'computer_wait_for_window',
  description:
    'Espera uma janela aparecer (por título ou app) e devolve o id dela. Use depois de computer_open_path ou computer_launch para não dormir um tempo fixo.',
  risk: 'read',
  parallelSafe: false,
  requires: 'computer',
  schema: z
    .object({
      title: z.string().min(1).optional().describe('Trecho do título da janela'),
      app: z.string().min(1).optional().describe('Nome do app/processo'),
      timeout_s: z.number().min(1).max(120).optional()
    })
    .refine((value) => Boolean(value.title?.trim() || value.app?.trim()), {
      message: 'informe title ou app'
    }),
  describe(a) {
    const args = a as { title?: string; app?: string }
    return { title: 'Esperar janela', detail: args.title ?? args.app ?? '' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { title?: string; app?: string; timeout_s?: number }
    const layer = layerFor(ctx)
    if (isResult(layer)) return layer
    const deadline = Date.now() + (args.timeout_s ?? 15) * 1000
    const title = args.title?.toLowerCase()
    const app = args.app?.toLowerCase()
    let last = ''
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) return { ok: false, text: 'cancelado' }
      const list = await layer.listWindows()
      last = list.text
      if (list.ok) {
        try {
          const windows = JSON.parse(list.text) as Array<{ id: number; app?: string; title?: string }>
          const match = windows.find(
            (window) =>
              (!title || String(window.title ?? '').toLowerCase().includes(title)) &&
              (!app || String(window.app ?? '').toLowerCase().includes(app))
          )
          if (match) {
            return {
              ok: true,
              text: `janela encontrada: ${match.title ?? match.app ?? match.id}\n${JSON.stringify(match, null, 2)}`,
              summary: `janela ${match.id}`,
              data: match
            }
          }
        } catch {
          /* non-JSON list; keep polling */
        }
      }
      await layer.wait(0.5)
    }
    return {
      ok: false,
      text: `tempo esgotado esperando a janela ${args.title ?? args.app}. Última lista:\n${last.slice(0, 3000)}`,
      summary: 'tempo esgotado'
    }
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
  computerListAppsTool,
  computerListWindowsTool,
  computerWindowAtTool,
  computerGetWindowTool,
  computerCursorPositionTool,
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
  computerOpenPathTool,
  computerLaunchTool,
  computerActivateTool,
  computerSecondaryActionTool,
  computerWaitTool,
  computerWaitForTool,
  computerWaitForWindowTool
]
