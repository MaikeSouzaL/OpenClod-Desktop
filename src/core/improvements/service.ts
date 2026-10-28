import fs from 'node:fs'
import path from 'node:path'
import type { ImprovementFinding, ImprovementReviewInfo, ImprovementStartOptions } from '../../shared/api.js'
import { redactDiagnosticText } from '../observability/service.js'
import { id } from '../util/ids.js'
import { collectEvidence, deriveFindings, hasSignal } from './evidence.js'
import { ANALYST_SYSTEM_PROMPT, buildAnalystPrompt, composeReview, sanitizeAnalysis, type ComposedReview } from './report.js'
import type { Evidence, ReviewInput } from './types.js'

/** 'on': a model writes the analysis; 'off': the user chose rules only; 'unavailable': no usable provider. */
type AiMode = 'on' | 'off' | 'unavailable'

const DEFAULT_DAYS = 30
const MAX_HISTORY = 40
const FILE_VERSION = 1

export interface ImprovementDeps {
  now(): number
  /** Gathers the project's logs; null when the project does not exist. */
  loadInput(projectId: string, days: number): Promise<ReviewInput | null>
  /** The model an AI analysis would use, if one is usable. Its evidence leaves the machine. */
  aiProvider(): { id: string; label: string; model: string } | undefined
  /** One tool-less model call. Throws on failure; honours the signal. */
  analyze(system: string, prompt: string, signal: AbortSignal): Promise<string>
  /** Writes the report page into the project's memory. */
  savePage(projectId: string, review: ComposedReview, evidence: Evidence): Promise<void>
  /** Leaves a note in the Activity inbox. */
  notify(info: ImprovementReviewInfo, review: ComposedReview, findings: ImprovementFinding[]): void
  log?(message: string): void
}

interface Running {
  info: ImprovementReviewInfo
  controller: AbortController
}

interface HistoryFile {
  version: 1
  items: ImprovementReviewInfo[]
}

function clampDays(days: number | undefined): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return DEFAULT_DAYS
  return Math.max(1, Math.min(180, Math.round(days)))
}

/**
 * Runs the "improvement review": counts what happened in a project, derives
 * rule-based findings, optionally asks the model for an analysis, and saves the
 * result as a memory page plus an Activity note. It never edits code, settings
 * or permissions; the report only suggests.
 */
export class ImprovementService {
  private running: Running | null = null
  private history: ImprovementReviewInfo[] = []
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: ImprovementDeps,
    private readonly file: string
  ) {}

  async init(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as HistoryFile
      if (parsed.version === FILE_VERSION && Array.isArray(parsed.items)) {
        this.history = parsed.items.filter((item) => item && typeof item.id === 'string' && item.state !== 'running').slice(-MAX_HISTORY)
      }
    } catch {
      this.history = []
    }
  }

  current(): ImprovementReviewInfo | null {
    return this.running ? { ...this.running.info } : null
  }

  list(projectId: string): ImprovementReviewInfo[] {
    return this.history.filter((item) => item.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt).map((item) => ({ ...item }))
  }

  last(projectId: string): ImprovementReviewInfo | null {
    return this.list(projectId)[0] ?? null
  }

  /** Starts a review and returns at once; `done` settles when it ends, whatever the outcome. */
  begin(projectId: string, options: ImprovementStartOptions = {}, trigger: 'manual' | 'schedule' = 'manual'): { info: ImprovementReviewInfo; done: Promise<ImprovementReviewInfo> } {
    if (this.running) throw new Error('já existe uma revisão de melhorias em andamento')
    const days = clampDays(options.days)
    const provider = this.deps.aiProvider()
    const ai: AiMode = options.useAi === false ? 'off' : provider ? 'on' : 'unavailable'
    const info: ImprovementReviewInfo = {
      id: id('imp'),
      projectId,
      projectName: '',
      startedAt: this.deps.now(),
      state: 'running',
      trigger,
      usedAi: false,
      model: ai === 'on' ? provider?.model : undefined,
      findings: 0,
      periodDays: days,
      step: 'Coletando evidências'
    }
    const run: Running = { info, controller: new AbortController() }
    this.running = run
    const done = this.execute(run, ai).finally(() => {
      if (this.running === run) this.running = null
    })
    return { info: { ...info }, done }
  }

  start(projectId: string, options?: ImprovementStartOptions, trigger: 'manual' | 'schedule' = 'manual'): ImprovementReviewInfo {
    const { info, done } = this.begin(projectId, options, trigger)
    void done.catch(() => undefined)
    return info
  }

  cancel(): boolean {
    if (!this.running) return false
    this.running.info.step = 'Cancelando'
    this.running.controller.abort()
    return true
  }

  private async execute(run: Running, ai: AiMode): Promise<ImprovementReviewInfo> {
    const { info, controller } = run
    const finish = async (patch: Partial<ImprovementReviewInfo>): Promise<ImprovementReviewInfo> => {
      Object.assign(info, patch, { finishedAt: this.deps.now(), step: undefined })
      this.history.push({ ...info })
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)
      await this.persist().catch(() => undefined)
      return { ...info }
    }
    try {
      const input = await this.deps.loadInput(info.projectId, info.periodDays)
      if (!input) return await finish({ state: 'error', error: 'projeto não encontrado' })
      info.projectName = input.project.name
      if (controller.signal.aborted) return await finish({ state: 'cancelled' })

      const evidence = collectEvidence(input)
      const findings = deriveFindings(evidence)
      info.findings = findings.length

      if (!hasSignal(evidence)) {
        return await finish({ state: 'done', note: `Sem atividade suficiente nos últimos ${info.periodDays} dias para analisar; nenhuma página foi criada.` })
      }

      let analysis: string | undefined
      let note: string | undefined
      if (ai === 'on') {
        info.step = 'O analista está lendo as evidências'
        try {
          const raw = await this.deps.analyze(ANALYST_SYSTEM_PROMPT, buildAnalystPrompt(evidence, findings), controller.signal)
          analysis = sanitizeAnalysis(raw) || undefined
          if (!analysis) note = 'O modelo respondeu sem texto; salvei apenas o relatório das regras automáticas.'
        } catch (err) {
          if (controller.signal.aborted) return await finish({ state: 'cancelled' })
          note = `A análise por IA falhou (${redactDiagnosticText((err as Error).message, 160)}); salvei apenas o relatório das regras automáticas.`
        }
      } else if (ai === 'off') {
        note = 'Análise por IA desligada; relatório gerado só pelas regras automáticas.'
      } else {
        note = 'Nenhum provedor com credencial; relatório gerado só pelas regras automáticas.'
      }
      if (controller.signal.aborted) return await finish({ state: 'cancelled' })

      info.step = 'Salvando na memória do projeto'
      const review = composeReview({ evidence, findings, analysis, model: info.model, note, trigger: info.trigger })
      await this.deps.savePage(info.projectId, review, evidence)
      const result = await finish({
        state: 'done',
        usedAi: Boolean(analysis),
        model: analysis ? info.model : undefined,
        slug: review.slug,
        title: review.title,
        summary: review.summary,
        note
      })
      try {
        this.deps.notify(result, review, findings)
      } catch (err) {
        this.deps.log?.(`revisão de melhorias: não consegui avisar na Atividade: ${(err as Error).message}`)
      }
      return result
    } catch (err) {
      if (controller.signal.aborted) return finish({ state: 'cancelled' })
      this.deps.log?.(`revisão de melhorias falhou: ${(err as Error).message}`)
      return finish({ state: 'error', error: redactDiagnosticText((err as Error).message, 300) })
    }
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify({ version: FILE_VERSION, items: this.history } satisfies HistoryFile, null, 2), 'utf8')
      await fs.promises.rename(tmp, this.file)
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }
}
