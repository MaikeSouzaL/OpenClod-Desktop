import path from 'node:path'
import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolContext, ToolDef } from './types.js'
import {
  analyzeFailureOutput,
  fileDependencies,
  findSymbols,
  repositoryOverview
} from '../code-intelligence/index.js'
import { discoverQualityChecks, runQualityChecks } from '../quality/engine.js'
import { grepTool } from './search.js'
import { truncateMiddle } from '../util/ids.js'

function rootOf(args: { path?: string }, ctx: ToolContext): string {
  return ctx.workspace.resolve(args.path ?? '.', ctx.cwd)
}

export const codeIntelligenceTool: ToolDef = {
  name: 'code_intelligence',
  description:
    'Analisa a estrutura real do repositório: visão geral e linguagens, símbolos, importações/dependências, referências de impacto e diagnósticos TypeScript. Use antes de alterações amplas e para localizar onde um símbolo é usado.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({
    action: z.enum(['overview', 'symbols', 'dependencies', 'impact', 'diagnostics']),
    path: z.string().optional().describe('Subdiretório ou raiz relativo ao workspace'),
    file: z.string().optional().describe('Arquivo para dependencies ou impacto'),
    query: z.string().optional().describe('Nome parcial do símbolo'),
    limit: z.number().int().min(1).max(1000).optional()
  }),
  describe(raw) {
    const args = raw as { action?: string; query?: string; file?: string }
    return { title: `Código · ${args.action ?? 'análise'}`, detail: args.file ?? args.query ?? '', preview: args.action }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as {
      action: 'overview' | 'symbols' | 'dependencies' | 'impact' | 'diagnostics'
      path?: string
      file?: string
      query?: string
      limit?: number
    }
    const root = rootOf(args, ctx)
    const limit = args.limit ?? 200
    if (args.action === 'overview') {
      const overview = await repositoryOverview(root, ctx.signal)
      return {
        ok: true,
        text: [
          `Arquivos-fonte: ${overview.files}`,
          `Linguagens: ${overview.languages.map((item) => `${item.language}=${item.files}`).join(', ') || 'nenhuma'}`,
          `Manifestos: ${overview.manifests.join(', ') || 'nenhum'}`,
          `Testes: ${overview.testFiles.slice(0, 40).join(', ') || 'nenhum identificado'}`,
          `Diretórios: ${overview.topDirectories.slice(0, 20).map((item) => `${item.path}=${item.files}`).join(', ')}`
        ].join('\n'),
        summary: `${overview.files} arquivos-fonte`
      }
    }
    if (args.action === 'symbols') {
      const symbols = (await findSymbols(root, args.query, ctx.signal)).slice(0, limit)
      return {
        ok: true,
        text: symbols.length
          ? symbols.map((symbol) => `${symbol.path}:${symbol.line} · ${symbol.kind} ${symbol.name}${symbol.exported ? ' (exportado)' : ''}`).join('\n')
          : 'nenhum símbolo encontrado',
        summary: `${symbols.length} símbolo(s)`
      }
    }
    if (args.action === 'dependencies') {
      if (!args.file) return { ok: false, text: 'file é obrigatório para dependencies' }
      const deps = await fileDependencies(root, args.file)
      return {
        ok: true,
        text: deps.length ? deps.map((dep) => `${dep.from}:${dep.line} · ${dep.kind} · ${dep.specifier}`).join('\n') : 'nenhuma dependência encontrada',
        summary: `${deps.length} dependência(s)`
      }
    }
    if (args.action === 'impact') {
      if (!args.file) return { ok: false, text: 'file é obrigatório para impact' }
      const base = path.basename(args.file).replace(/\.[^.]+$/, '')
      const result = await grepTool.execute({ pattern: base, path: path.relative(ctx.cwd, root) || '.', max_results: limit }, ctx)
      const references = result.text.split(/\r?\n/).filter(Boolean).slice(0, limit)
      return {
        ok: result.ok,
        text: references.length ? references.join('\n') : `nenhuma referência textual a ${base}; impacto semântico não confirmado`,
        summary: `${references.length} referência(s) textual(is)`
      }
    }
    const checks = (await discoverQualityChecks(root)).filter((check) => check.kind === 'typecheck')
    if (!checks.length) return { ok: true, text: 'Nenhum typecheck configurado neste workspace.', summary: 'não configurado' }
    const results = await runQualityChecks({ root, checks, sessionId: ctx.sessionId, signal: ctx.signal, environment: ctx.environment, timeoutMs: 120_000 })
    const issues = results.flatMap((result) => result.issues)
    return {
      ok: results.every((result) => result.status === 'passed'),
      text: [results.map((result) => `${result.check.label}: ${result.status} (exit ${result.exitCode ?? '?'})`).join('\n'), issues.slice(0, limit).map((issue) => `${issue.path ?? ''}${issue.line ? `:${issue.line}` : ''} · ${issue.severity} · ${issue.message}`).join('\n')].filter(Boolean).join('\n\n'),
      summary: `${issues.length} diagnóstico(s)`
    }
  }
}

export const qualityDiscoverTool: ToolDef = {
  name: 'quality_discover',
  description: 'Descobre os comandos reais de teste, typecheck, lint e build disponíveis no workspace.',
  risk: 'read',
  parallelSafe: true,
  schema: z.object({ path: z.string().optional() }),
  describe(raw) {
    return { title: 'Descobrir verificações', detail: (raw as { path?: string })?.path ?? 'workspace' }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { path?: string }
    const root = rootOf(args, ctx)
    const checks = await discoverQualityChecks(root)
    return {
      ok: true,
      text: checks.length ? checks.map((check) => `${check.id} · ${check.kind} · ${check.command} · ${check.source}`).join('\n') : 'nenhuma verificação reconhecida',
      summary: `${checks.length} verificação(ões)`,
      data: { checks }
    }
  }
}

export const qualityRunTool: ToolDef = {
  name: 'quality_run',
  description:
    'Executa testes, typecheck, lint ou build descobertos no workspace, preserva stdout/stderr e códigos de saída, e transforma falhas em diagnósticos estruturados. Use check para escolher um id ou omita para executar todas.',
  risk: 'exec',
  parallelSafe: false,
  schema: z.object({
    path: z.string().optional(),
    check: z.string().optional().describe('Id de quality_discover'),
    kind: z.enum(['test', 'typecheck', 'lint', 'build']).optional(),
    timeout_ms: z.number().int().min(1000).max(1_800_000).optional()
  }),
  describe(raw) {
    const args = raw as { check?: string; kind?: string }
    return { title: 'Executar qualidade', detail: args.check ?? args.kind ?? 'todas', preview: args.check ?? args.kind }
  },
  async execute(raw, ctx) {
    const args = this.schema.parse(raw) as { path?: string; check?: string; kind?: 'test' | 'typecheck' | 'lint' | 'build'; timeout_ms?: number }
    const root = rootOf(args, ctx)
    const all = await discoverQualityChecks(root)
    const checks = args.check ? all.filter((check) => check.id === args.check) : args.kind ? all.filter((check) => check.kind === args.kind) : all
    if (!checks.length) return { ok: false, text: args.check ? `verificação não encontrada: ${args.check}` : 'nenhuma verificação reconhecida' }
    const results = await runQualityChecks({ root, checks, sessionId: ctx.sessionId, signal: ctx.signal, environment: ctx.environment, timeoutMs: args.timeout_ms })
    const ok = results.every((result) => result.status === 'passed')
    const text = results.map((result) => {
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n')
      const issues = result.issues.slice(0, 50).map((issue) => `${issue.path ?? ''}${issue.line ? `:${issue.line}` : ''} · ${issue.severity} · ${issue.message}`)
      return [`${result.check.label}: ${result.status} · exit=${result.exitCode ?? '?'} · ${(result.durationMs / 1000).toFixed(1)}s`, detail ? truncateMiddle(detail, 20_000) : '', issues.join('\n')].filter(Boolean).join('\n')
    }).join('\n\n')
    return {
      ok,
      text,
      summary: results.map((result) => `${result.check.kind}:${result.status}`).join(' · '),
      data: { results }
    }
  }
}

export const codeIntelligenceTools: ToolDef[] = [codeIntelligenceTool, qualityDiscoverTool, qualityRunTool]
