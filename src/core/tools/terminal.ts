import { z } from 'zod'
import type { ToolResult } from '../../shared/types.js'
import type { ToolDef } from './types.js'
import { commandDeletesFiles } from '../security/deletion.js'
import { checkCommand } from '../security/policy.js'
import { truncateMiddle } from '../util/ids.js'

/** A command that deletes files is as destructive here as in run_command: the automatic mode must ask for it too. */
function terminalCallRisk(raw: unknown): { risk: 'destructive' } | undefined {
  const command = (raw as { command?: unknown } | null)?.command
  return typeof command === 'string' && commandDeletesFiles(command) ? { risk: 'destructive' } : undefined
}

export const runInTerminalTool: ToolDef = {
  name: 'run_in_terminal',
  description:
    'Roda um comando no TERMINAL INTEGRADO VISÍVEL da sessão (abre um se não houver), para o usuário acompanhar ao vivo, e devolve a saída. O estado persiste entre chamadas (cd, variáveis de ambiente). O shell é o do terminal (PowerShell no Windows). Mesmas regras do run_command: a saída é limitada e comandos destrutivos são bloqueados.\n' +
    'A ferramenta NÃO espera cega: ela volta assim que o comando termina OU quando ele fica lento/sem resposta, com a saída até ali. Se a resposta trouxer running:true, o comando AINDA está rodando — chame run_in_terminal de novo (pode deixar command vazio) para ver o que surgiu e conferir o que está acontecendo. Para parar um comando travado ou que espera entrada, chame com interrupt:true (envia Ctrl+C). Não digita em prompts interativos; para servidores/watchers use start_process.',
  risk: 'exec',
  parallelSafe: false,
  schema: z.object({
    command: z.string().max(4000).describe('Linha de comando completa. Deixe vazio para só continuar acompanhando o comando que já está rodando.'),
    description: z.string().max(120).optional().describe('Resumo de 5 a 10 palavras do que o comando faz'),
    timeout_ms: z.number().int().min(1000).max(900_000).optional(),
    interrupt: z.boolean().optional().describe('Envia Ctrl+C ao comando que está rodando no terminal antes de observar de novo.')
  }),
  resolveCall: terminalCallRisk,
  describe(a) {
    const args = a as { command?: string; interrupt?: boolean }
    const label = args.interrupt ? 'Interromper (Ctrl+C)' : args.command?.trim() ? args.command : 'Continuar acompanhando'
    return { title: 'Rodar no terminal', detail: label, preview: label }
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = this.schema.parse(raw) as { command: string; timeout_ms?: number; interrupt?: boolean }
    const runner = ctx.services.terminal
    if (!runner) {
      return { ok: false, text: 'o terminal integrado não está disponível neste contexto; use run_command.' }
    }
    // Só checa a política quando há um comando novo para iniciar (continuar/interromper não roda nada).
    if (args.command.trim() && !args.interrupt) {
      const guard = checkCommand(args.command, ctx.policy)
      if (guard.blocked) {
        ctx.log('warn', `comando bloqueado no terminal: ${args.command} (${guard.reason})`)
        ctx.emit({ type: 'audit', sessionId: ctx.sessionId, level: 'blocked', message: `Comando bloqueado pela política: ${guard.reason}` })
        return { ok: false, text: `BLOQUEADO pela política de segurança: ${guard.reason}. Reformule o comando de forma segura.` }
      }
    }
    const started = Date.now()
    const result = await runner.run({
      sessionId: ctx.sessionId,
      command: args.command,
      cwd: ctx.cwd,
      timeoutMs: args.timeout_ms,
      interrupt: args.interrupt
    })
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    const output = result.output.trim()
    const header = args.interrupt ? 'Ctrl+C enviado' : args.command.trim() ? `$ ${args.command}` : '(acompanhando)'
    let status: string
    if (result.running) {
      const idle = Math.round(result.idleMs / 1000)
      status = `AINDA RODANDO${result.timedOut ? ' (tempo limite atingido)' : ''} · ${elapsed}s · sem saída nova há ${idle}s · terminal visível`
    } else {
      status = `exit=${result.exitCode ?? 'null'} · ${elapsed}s · terminal visível`
    }
    const parts = [header, status, output ? truncateMiddle(output, 20_000) : '(sem saída nova)']
    if (result.ignoredCommand) {
      parts.push('Obs.: o terminal já estava ocupado, então o comando enviado foi ignorado; só continuei acompanhando o que já rodava. Use interrupt:true para parar antes de rodar outro.')
    }
    if (result.running) {
      parts.push(
        result.idleMs >= 8000
          ? 'O comando parou de produzir saída. Pode estar travado ou esperando uma entrada (que não há como digitar). Chame de novo (command vazio) para seguir observando, ou interrupt:true para parar. Para servidores/watchers, prefira start_process.'
          : 'Chame run_in_terminal de novo (command vazio) para ver o restante quando terminar.'
      )
    }
    return {
      ok: !result.running && !result.timedOut && result.exitCode === 0,
      text: parts.join('\n'),
      summary: result.running ? `terminal · rodando · ${elapsed}s` : `terminal · exit ${result.exitCode ?? '?'} · ${elapsed}s`,
      data: {
        terminalId: result.terminalId,
        exitCode: result.exitCode,
        running: result.running,
        timedOut: result.timedOut,
        idleMs: result.idleMs,
        command: args.command
      }
    }
  }
}

export const terminalTools: ToolDef[] = [runInTerminalTool]
