import path from 'node:path'
import type { ImprovementReviewInfo, ImprovementStartOptions, ImprovementStatusInfo } from '../shared/api.js'
import { ImprovementService } from '../core/improvements/service.js'
import { ANALYST_SYSTEM_PROMPT } from '../core/improvements/report.js'
import { redactDiagnosticText, type ObservabilityService } from '../core/observability/service.js'
import type { Scheduler } from '../core/scheduler/scheduler.js'
import type { ScheduledTask } from '../core/scheduler/types.js'
import type { ActivityStore } from './activity-store.js'
import type { Orchestrator } from './orchestrator.js'
import type { ProviderUsageStore } from './provider-usage.js'

export const WEEKLY_REVIEW_NAME = 'Revisão semanal de melhorias'

/** Late-bound: the stores are created one by one during start-up. */
export interface ImprovementWiring {
  orchestrator: () => Orchestrator | null
  activity: () => ActivityStore | null
  observability: () => ObservabilityService | null
  usage: () => ProviderUsageStore | null
  /** `<userData>/data`; the run history lives next to the other stores. */
  dataDir: string
  log: (message: string) => void
}

export function createImprovementService(wiring: ImprovementWiring): ImprovementService {
  const orchestrator = (): Orchestrator => {
    const value = wiring.orchestrator()
    if (!value) throw new Error('aplicativo ainda inicializando')
    return value
  }
  return new ImprovementService(
    {
      now: () => Date.now(),
      async loadInput(projectId, days) {
        const core = orchestrator()
        const project = core.store.listProjects().find((item) => item.id === projectId)
        if (!project) return null
        const [sessions, pages, stats] = await Promise.all([
          core.improvementSessions(projectId),
          core.memoryList(projectId),
          core.memoryStats(projectId)
        ])
        return {
          project: { id: project.id, name: project.name },
          now: Date.now(),
          days,
          sessions,
          activity: wiring.activity()?.all() ?? [],
          events: wiring.observability()?.all() ?? [],
          usage: wiring.usage()?.list() ?? [],
          memoryPages: pages.map((page) => ({
            slug: page.slug,
            title: page.title,
            tags: page.tags,
            pinned: page.pinned,
            updated: page.updated,
            summary: page.summary,
            memoryType: page.memoryType,
            status: page.status,
            possibleConflicts: page.possibleConflicts
          })),
          memoryStats: {
            pages: stats.pages,
            pinned: stats.pinned,
            openHandoffs: stats.openHandoffs,
            conflicts: stats.conflicts,
            superseded: stats.superseded,
            invalidated: stats.invalidated
          }
        }
      },
      aiProvider: () => wiring.orchestrator()?.improvementProvider(),
      analyze: (system, prompt, signal) => {
        const core = orchestrator()
        return core.improvementAnalyze(core.improvementAnalystPrompt(system || ANALYST_SYSTEM_PROMPT), prompt, signal)
      },
      savePage: (projectId, review, _evidence) => orchestrator().improvementSavePage(projectId, review, review.tags.includes('ia')),
      notify(info, review, findings) {
        const high = findings.filter((finding) => finding.severity === 'high').length
        wiring.activity()?.addNote({
          type: 'review',
          severity: high ? 'warning' : 'info',
          title: `Revisão de melhorias: ${findings.length ? `${findings.length} achado(s)` : 'sem achados'}`,
          // The project name is user text (it can hold a key or a personal path): redact it like the report does.
          detail: `${redactDiagnosticText(info.projectName, 120)} · ${review.summary}`,
          actionable: 'memory',
          metadata: { projectId: info.projectId, slug: review.slug, reviewId: info.id, usedAi: info.usedAi, trigger: info.trigger, high }
        })
      },
      log: wiring.log
    },
    path.join(wiring.dataDir, 'improvement-reviews.json')
  )
}

export function findWeeklyReview(scheduler: Scheduler | null, projectId: string): ScheduledTask | undefined {
  return scheduler?.list().find((task) => task.action === 'improvement-review' && task.projectId === projectId)
}

function weeklyInfo(task: ScheduledTask | undefined): ImprovementStatusInfo['weekly'] {
  return task ? { enabled: task.enabled, taskId: task.id, nextRunAt: task.enabled ? task.nextRunAt : undefined } : { enabled: false }
}

export function improvementStatus(
  service: ImprovementService,
  orchestrator: Orchestrator,
  scheduler: Scheduler | null,
  projectId: string
): ImprovementStatusInfo {
  return {
    current: service.current(),
    last: service.last(projectId),
    history: service.list(projectId).slice(0, 8),
    weekly: weeklyInfo(findWeeklyReview(scheduler, projectId)),
    aiProvider: orchestrator.improvementProvider()
  }
}

/** Normalizes untrusted start options from the renderer. */
export function startOptions(raw: unknown): ImprovementStartOptions {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const options: ImprovementStartOptions = {}
  if (typeof input.useAi === 'boolean') options.useAi = input.useAi
  if (typeof input.days === 'number' && Number.isFinite(input.days)) options.days = input.days
  return options
}

/**
 * Creates, resumes or pauses the project's weekly review in Agendados. It is a
 * normal scheduled task (visible, editable, removable there); the only thing it
 * does when it fires is run the same read-only review.
 */
export async function setWeeklyReview(
  scheduler: Scheduler,
  project: { id: string; path: string; name: string },
  enabled: boolean,
  useAi: boolean | undefined
): Promise<ImprovementStatusInfo['weekly']> {
  const existing = findWeeklyReview(scheduler, project.id)
  if (existing) {
    const options = useAi === undefined ? existing.actionOptions : { ...existing.actionOptions, useAi }
    const updated = await scheduler.update(existing.id, { enabled, actionOptions: options })
    return weeklyInfo(updated)
  }
  if (!enabled) return { enabled: false }
  const created = await scheduler.create({
    name: WEEKLY_REVIEW_NAME,
    prompt: `Revisão de melhorias do projeto ${project.name}: coleta limitações recorrentes, falhas por ferramenta, aprovações negadas, uso por provedor e a memória do projeto, e salva o relatório como página de memória. Somente leitura: nada é aplicado.`,
    projectId: project.id,
    cwd: project.path,
    schedule: { kind: 'weekly', day: 1, time: '09:00' },
    priority: 'low',
    action: 'improvement-review',
    // Two weeks: consecutive weekly reports overlap, so a problem that persists shows up as recurring.
    actionOptions: { useAi: useAi !== false, days: 14 },
    enabled: true
  })
  return weeklyInfo(created)
}

export type { ImprovementReviewInfo }
