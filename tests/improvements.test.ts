import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityItem, ObservabilityEventInfo, ProviderUsageInfo } from '../src/shared/api'
import { collectEvidence, deriveFindings, hasSignal } from '../src/core/improvements/evidence'
import { buildAnalystPrompt, composeReview, reviewSlug, sanitizeAnalysis } from '../src/core/improvements/report'
import { ImprovementService, type ImprovementDeps } from '../src/core/improvements/service'
import type { ReviewInput } from '../src/core/improvements/types'
import { Scheduler } from '../src/core/scheduler/scheduler'
import { makeTempDir, removeTempDir } from './helpers'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0)

let seq = 0
function activity(over: Partial<ActivityItem> & Pick<ActivityItem, 'type' | 'title'>): ActivityItem {
  seq += 1
  return {
    id: `act_${seq}`,
    sessionId: 's1',
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    severity: 'info',
    detail: '',
    read: false,
    archived: false,
    count: 1,
    ...over
  }
}

function event(over: Partial<ObservabilityEventInfo> & Pick<ObservabilityEventInfo, 'type'>): ObservabilityEventInfo {
  seq += 1
  return { id: `obs_${seq}`, ts: NOW - DAY, level: 'info', sessionId: 's1', ...over }
}

function toolEnd(name: string, ok: boolean, detail?: string, over: Partial<ObservabilityEventInfo> = {}): ObservabilityEventInfo {
  return event({ type: 'tool_end', name, ok, detail, durationMs: 500, level: ok ? 'info' : 'error', ...over })
}

function input(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    project: { id: 'prj_1', name: 'Loja' },
    now: NOW,
    days: 30,
    sessions: [
      { id: 's1', title: 'Primeira', updatedAt: NOW - DAY },
      { id: 's2', title: 'Segunda', updatedAt: NOW - 2 * DAY }
    ],
    activity: [],
    events: [],
    usage: [],
    memoryPages: [],
    ...over
  }
}

describe('collectEvidence', () => {
  it('counts only this project and this period', () => {
    const evidence = collectEvidence(
      input({
        events: [
          toolEnd('run_command', false, 'exit 1'),
          toolEnd('run_command', false, 'exit 1', { sessionId: 'other-project' }),
          toolEnd('run_command', false, 'exit 1', { ts: NOW - 60 * DAY })
        ],
        activity: [
          activity({ type: 'limitation', title: 'Limitação: sem acesso ao banco', sessionId: 'other-project' }),
          activity({ type: 'limitation', title: 'Limitação: sem acesso ao banco', updatedAt: NOW - 90 * DAY })
        ]
      })
    )
    expect(evidence.totals.toolCalls).toBe(1)
    expect(evidence.totals.limitations).toBe(0)
    expect(evidence.totals.sessions).toBe(2)
  })

  it('groups recurring limitations across sessions, keeps dedupe counts and the blocking flag', () => {
    const evidence = collectEvidence(
      input({
        activity: [
          activity({ type: 'limitation', title: 'Limitação: PDF protegido', detail: 'não consegui abrir', count: 3, actionRequired: true, sessionId: 's1' }),
          activity({ type: 'limitation', title: 'Limitação: pdf protegido', detail: 'mesma coisa', count: 1, sessionId: 's2', updatedAt: NOW - 2 * 3600_000 }),
          activity({ type: 'limitation', title: 'Limitação: lento', sessionId: 's1' })
        ]
      })
    )
    const group = evidence.limitations.find((item) => item.title.toLowerCase() === 'pdf protegido')!
    expect(group.count).toBe(4)
    expect(group.sessions.sort()).toEqual(['s1', 's2'])
    expect(group.blocking).toBe(true)
    expect(group.detail).toBe('mesma coisa')
    expect(evidence.totals.limitations).toBe(5)
  })

  it('aggregates tool failures, ignores report_limitation and redacts secrets and user paths', () => {
    const evidence = collectEvidence(
      input({
        events: [
          toolEnd('web_fetch', false, 'Authorization: Bearer abc123secret on C:\\Users\\maike\\proj'),
          toolEnd('web_fetch', false, 'timeout'),
          toolEnd('web_fetch', true),
          toolEnd('report_limitation', true)
        ]
      })
    )
    const tool = evidence.tools.find((item) => item.name === 'web_fetch')!
    expect(tool).toMatchObject({ calls: 3, failures: 2 })
    expect(tool.failureRate).toBeCloseTo(2 / 3)
    const text = JSON.stringify(evidence)
    expect(text).not.toContain('abc123secret')
    expect(text).not.toContain('maike')
    expect(evidence.tools.some((item) => item.name === 'report_limitation')).toBe(false)
  })

  it('ties refusals back to the request by approval id', () => {
    const evidence = collectEvidence(
      input({
        activity: [
          activity({ type: 'approval', title: 'Aprovação necessária', detail: 'Executar comando: rm -rf build', actionRequired: true, metadata: { approvalId: 'a1' } }),
          activity({ type: 'approval', title: 'Aprovação necessária', detail: 'Executar comando: rm -rf dist', actionRequired: true, metadata: { approvalId: 'a2' } }),
          activity({ type: 'approval', title: 'Aprovação necessária', detail: 'Editar arquivo: src/a.ts', actionRequired: true, metadata: { approvalId: 'a3' } }),
          activity({ type: 'approval', title: 'Aprovação recusada', detail: 'a1', severity: 'warning' }),
          activity({ type: 'approval', title: 'Aprovação recusada', detail: 'a2', severity: 'warning' }),
          activity({ type: 'approval', title: 'Aprovação concedida', detail: 'a3', severity: 'success' })
        ]
      })
    )
    expect(evidence.totals).toMatchObject({ approvalsRequested: 3, approvalsGranted: 1, approvalsDenied: 2 })
    expect(evidence.permissions.find((item) => item.title === 'Executar comando')).toMatchObject({ requested: 2, denied: 2, granted: 0 })
    expect(evidence.permissions.find((item) => item.title === 'Editar arquivo')).toMatchObject({ granted: 1, denied: 0 })
  })

  it('counts turns, failed turns, budget stops and failing sub-agents', () => {
    const evidence = collectEvidence(
      input({
        events: [
          event({ type: 'turn_start' }),
          event({ type: 'turn_start' }),
          event({ type: 'turn_end', ok: true }),
          event({ type: 'turn_end', ok: false, detail: 'HTTP 429 limite semanal' })
        ],
        activity: [
          activity({ type: 'budget', title: 'Orçamento do turno esgotado (custo)', detail: 'US$ 5 de US$ 5', metadata: { kind: 'cost' } }),
          activity({ type: 'agent', title: 'coder: error', severity: 'error', detail: 'falhou' }),
          activity({ type: 'agent', title: 'coder: done', severity: 'success' })
        ]
      })
    )
    expect(evidence.totals).toMatchObject({ turns: 2, failedTurns: 1, budgetStops: 1, agentFailures: 1 })
    expect(evidence.failedTurns[0]).toEqual({ reason: 'HTTP 429 limite semanal', count: 1 })
    expect(evidence.budget[0]).toMatchObject({ kind: 'custo', count: 1 })
    expect(evidence.agentFailures[0]).toMatchObject({ label: 'coder', count: 1 })
  })

  it('separates curated memory from automatic turn logs and finds previous reviews', () => {
    const evidence = collectEvidence(
      input({
        memoryPages: [
          { slug: 'decisao-a', title: 'Decisão A', tags: ['decisao'], pinned: true, updated: new Date(NOW - 200 * DAY).toISOString(), summary: '' },
          { slug: 'turno-1', title: 'Turno 1', tags: ['turno', 'automatico'], pinned: false, updated: new Date(NOW - DAY).toISOString(), summary: '' },
          { slug: reviewSlug(NOW - 7 * DAY), title: 'Revisão', tags: ['revisao-melhorias'], pinned: false, updated: new Date(NOW - 7 * DAY).toISOString(), summary: '' }
        ],
        memoryStats: { pages: 3, pinned: 1, openHandoffs: 4, conflicts: 0 }
      })
    )
    expect(evidence.memory).toMatchObject({ pages: 3, topics: 1, turnLogs: 1, stale: 1, openHandoffs: 4 })
    expect(evidence.memory.reviews[0].slug).toBe(reviewSlug(NOW - 7 * DAY))
    expect(evidence.memory.recent.map((page) => page.slug)).toEqual(['decisao-a'])
  })

  it('reports no signal for an empty window so no model tokens are spent', () => {
    expect(hasSignal(collectEvidence(input()))).toBe(false)
    expect(hasSignal(collectEvidence(input({ events: [toolEnd('read_file', true)] })))).toBe(true)
  })
})

describe('deriveFindings', () => {
  it('flags a blocking limitation that repeats as high priority and a single degraded one as low', () => {
    const findings = deriveFindings(
      collectEvidence(
        input({
          activity: [
            activity({ type: 'limitation', title: 'Limitação: captcha', actionRequired: true, count: 2 }),
            activity({ type: 'limitation', title: 'Limitação: layout estranho' })
          ]
        })
      )
    )
    expect(findings.find((item) => item.id === 'limitation:captcha')?.severity).toBe('high')
    expect(findings.find((item) => item.id === 'limitation:layout-estranho')?.severity).toBe('low')
    expect(findings[0].id).toBe('limitation:captcha')
  })

  it('needs repeated failures before blaming a tool, and quotes the real errors', () => {
    const few = deriveFindings(collectEvidence(input({ events: [toolEnd('grep', false, 'x'), toolEnd('grep', true), toolEnd('grep', true), toolEnd('grep', true)] })))
    expect(few.some((item) => item.id === 'tool:grep')).toBe(false)

    const many = deriveFindings(
      collectEvidence(input({ events: [toolEnd('patch_file', false, 'hunk não aplica'), toolEnd('patch_file', false, 'hunk não aplica'), toolEnd('patch_file', false, 'contexto mudou'), toolEnd('patch_file', true)] }))
    )
    const finding = many.find((item) => item.id === 'tool:patch-file')!
    expect(finding.severity).toBe('high')
    expect(finding.evidence).toContain('3 falhas em 4 chamadas')
    expect(finding.evidence).toContain('contexto mudou')
  })

  it('does not call a long-running tool slow by nature', () => {
    const slow = (name: string) => [1, 2, 3].map(() => toolEnd(name, true, undefined, { durationMs: 120_000 }))
    const findings = deriveFindings(collectEvidence(input({ events: [...slow('agent'), ...slow('run_command')] })))
    expect(findings.some((item) => item.id === 'tool-slow:agent')).toBe(false)
    expect(findings.some((item) => item.id === 'tool-slow:run-command')).toBe(true)
  })

  it('suggests, without applying, when the user keeps refusing or always accepts', () => {
    const approvals: ActivityItem[] = []
    for (let i = 0; i < 2; i++) {
      approvals.push(activity({ type: 'approval', title: 'Aprovação necessária', detail: `Executar comando: deploy ${i}`, metadata: { approvalId: `d${i}` } }))
      approvals.push(activity({ type: 'approval', title: 'Aprovação recusada', detail: `d${i}` }))
    }
    for (let i = 0; i < 5; i++) {
      approvals.push(activity({ type: 'approval', title: 'Aprovação necessária', detail: `Ler arquivo: a${i}.ts`, metadata: { approvalId: `r${i}` } }))
      approvals.push(activity({ type: 'approval', title: 'Aprovação concedida', detail: `r${i}` }))
    }
    const findings = deriveFindings(collectEvidence(input({ activity: approvals })))
    expect(findings.find((item) => item.id === 'permission-denied:executar-comando')?.severity).toBe('medium')
    expect(findings.find((item) => item.id === 'permission-granted:ler-arquivo')?.severity).toBe('low')
    expect(findings.find((item) => item.id === 'permission-granted:ler-arquivo')?.suggestion).toContain('nada foi alterado')
  })

  it('escalates repeated budget stops, failed turns and cache-less providers', () => {
    const usage: ProviderUsageInfo = { providerId: 'p', label: 'Provedor X', input: 400_000, output: 20_000, cachedInput: 0, costUsd: 3.2, calls: 25, updatedAt: NOW }
    const findings = deriveFindings(
      collectEvidence(
        input({
          events: [event({ type: 'turn_start' }), event({ type: 'turn_start' }), event({ type: 'turn_end', ok: false, detail: 'boom' }), event({ type: 'turn_end', ok: false, detail: 'boom' })],
          activity: [activity({ type: 'budget', title: 'Orçamento do turno esgotado (tokens)', count: 3, metadata: { kind: 'tokens' } })],
          usage: [usage]
        })
      )
    )
    expect(findings.find((item) => item.id === 'budget:stops')?.severity).toBe('high')
    expect(findings.find((item) => item.id === 'workflow:failed-turns')).toBeTruthy()
    const cache = findings.find((item) => item.id === 'cost:cache:p')!
    expect(cache.evidence).toContain('uso global')
  })

  it('points at memory gaps: no curated pages, conflicts, handoffs, stale pages', () => {
    const turnLogs = Array.from({ length: 6 }, (_, index) => ({ slug: `t${index}`, title: `T${index}`, tags: ['turno'], pinned: false, updated: new Date(NOW).toISOString(), summary: '' }))
    const findings = deriveFindings(collectEvidence(input({ memoryPages: turnLogs, memoryStats: { pages: 6, pinned: 0, openHandoffs: 3, conflicts: 2 } })))
    const ids = findings.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['memory:no-topics', 'memory:conflicts', 'memory:handoffs']))
  })

  it('returns nothing for a quiet, healthy project', () => {
    const findings = deriveFindings(collectEvidence(input({ events: [toolEnd('read_file', true), toolEnd('read_file', true)] })))
    expect(findings).toEqual([])
  })
})

describe('report', () => {
  const evidence = collectEvidence(
    input({
      activity: [activity({ type: 'limitation', title: 'Limitação: captcha | bloqueia', actionRequired: true, count: 2 })],
      events: [toolEnd('web_fetch', false, 'timeout'), toolEnd('web_fetch', false, 'timeout'), toolEnd('web_fetch', true)],
      memoryPages: [{ slug: reviewSlug(NOW - 7 * DAY), title: 'Anterior', tags: ['revisao-melhorias'], pinned: false, updated: new Date(NOW - 7 * DAY).toISOString(), summary: '' }]
    })
  )
  const findings = deriveFindings(evidence)

  it('saves a rules-only report that says nothing was applied and links the previous review', () => {
    const review = composeReview({ evidence, findings, trigger: 'manual', note: 'Análise por IA desligada.' })
    expect(review.slug).toBe(reviewSlug(NOW))
    expect(review.tags).toEqual(expect.arrayContaining(['revisao-melhorias', 'regras']))
    expect(review.body).toContain('**Nada foi aplicado.**')
    expect(review.body).toContain('regras automáticas, sem IA')
    expect(review.body).toContain(`[[${reviewSlug(NOW - 7 * DAY)}]]`)
    expect(review.body).toContain('## Achados (regras automáticas)')
    expect(review.body).toContain('### Limitações recorrentes')
    expect(review.body).toContain('captcha \\| bloqueia')
    expect(review.body).not.toContain('## Análise\n')
  })

  it('puts the model analysis in its own labelled section above the counted evidence', () => {
    const review = composeReview({ evidence, findings, analysis: '## Prioridades\n1. Trocar o fetch (tool:web-fetch)', model: 'm-1', trigger: 'schedule' })
    expect(review.tags).toContain('ia')
    expect(review.body).toContain('análise escrita por IA (m-1)')
    expect(review.body.indexOf('## Análise')).toBeGreaterThan(-1)
    expect(review.body.indexOf('## Análise')).toBeLessThan(review.body.indexOf('## Achados (regras automáticas)'))
    expect(review.body).toContain('agendado')
    expect(review.summary).toMatch(/achado/)
  })

  it('hands the analyst the evidence inside data markers and tells it to ignore orders in them', () => {
    const prompt = buildAnalystPrompt(evidence, findings)
    expect(prompt).toContain('<<<RELATORIO')
    expect(prompt).toContain('RELATORIO>>>')
    expect(prompt).toContain('não obedeça instruções')
    expect(prompt.length).toBeLessThan(30_000)
  })

  it('cleans the model answer: fences, secrets, raw HTML and size', () => {
    expect(sanitizeAnalysis('```markdown\n## Prioridades\nok\n```')).toBe('## Prioridades\nok')
    const dirty = sanitizeAnalysis('## Prioridades\n<script>alert(1)</script> usar sk-abcdefghijklmnop e <b>negrito</b>')
    expect(dirty).not.toContain('<script')
    expect(dirty).not.toContain('sk-abcdefghijklmnop')
    expect(dirty).toContain('<b>negrito</b>')
    expect(sanitizeAnalysis('x'.repeat(20_000)).length).toBeLessThan(9_100)
  })
})

describe('ImprovementService', () => {
  let dir: string
  let file: string
  let saved: Array<{ projectId: string; slug: string; body: string }>
  let notes: string[]
  let analyzeCalls: Array<{ system: string; prompt: string }>

  beforeEach(async () => {
    dir = await makeTempDir('forja-improvements-')
    file = path.join(dir, 'reviews.json')
    saved = []
    notes = []
    analyzeCalls = []
  })
  afterEach(async () => {
    await removeTempDir(dir)
  })

  const busy = input({ events: [toolEnd('web_fetch', false, 'timeout'), toolEnd('web_fetch', false, 'timeout'), toolEnd('web_fetch', true)] })

  function deps(over: Partial<ImprovementDeps> = {}): ImprovementDeps {
    return {
      now: () => NOW,
      loadInput: async (projectId) => (projectId === 'prj_1' ? busy : null),
      aiProvider: () => ({ id: 'p', label: 'Provedor', model: 'm-1' }),
      analyze: async (system, prompt) => {
        analyzeCalls.push({ system, prompt })
        return '## Prioridades\n1. Corrigir o fetch (tool:web-fetch)'
      },
      savePage: async (projectId, review) => {
        saved.push({ projectId, slug: review.slug, body: review.body })
      },
      notify: (info) => {
        notes.push(info.summary ?? '')
      },
      ...over
    }
  }

  it('runs end to end with an analyst: saves the page, notes the Activity and remembers the run', async () => {
    const service = new ImprovementService(deps(), file)
    await service.init()
    const { done } = service.begin('prj_1')
    expect(service.current()?.state).toBe('running')
    const result = await done
    expect(result).toMatchObject({ state: 'done', usedAi: true, model: 'm-1', slug: reviewSlug(NOW), projectName: 'Loja' })
    expect(result.findings).toBeGreaterThan(0)
    expect(saved).toHaveLength(1)
    expect(saved[0].body).toContain('Corrigir o fetch')
    expect(analyzeCalls[0].system).toMatch(/no tools/i)
    expect(notes).toHaveLength(1)
    expect(service.current()).toBeNull()

    const reloaded = new ImprovementService(deps(), file)
    await reloaded.init()
    expect(reloaded.last('prj_1')?.id).toBe(result.id)
    expect(reloaded.list('other')).toEqual([])
  })

  it('keeps the rules-only report when the model fails, and says why', async () => {
    const service = new ImprovementService(deps({ analyze: async () => { throw new Error('HTTP 429 limite') } }), file)
    const result = await service.begin('prj_1').done
    expect(result).toMatchObject({ state: 'done', usedAi: false })
    expect(result.note).toContain('A análise por IA falhou')
    expect(result.note).toContain('429')
    expect(saved[0].body).toContain('regras automáticas, sem IA')
    expect(saved[0].body).not.toContain('## Análise')
  })

  it('does not call the model when AI is off or no provider exists', async () => {
    const off = new ImprovementService(deps(), file)
    const first = await off.begin('prj_1', { useAi: false }).done
    expect(first.note).toContain('desligada')
    const none = new ImprovementService(deps({ aiProvider: () => undefined }), file)
    const second = await none.begin('prj_1').done
    expect(second.note).toContain('Nenhum provedor')
    expect(analyzeCalls).toHaveLength(0)
    expect(saved).toHaveLength(2)
  })

  it('writes nothing when the project has no activity', async () => {
    const service = new ImprovementService(deps({ loadInput: async () => input() }), file)
    const result = await service.begin('prj_1').done
    expect(result).toMatchObject({ state: 'done', findings: 0 })
    expect(result.slug).toBeUndefined()
    expect(result.note).toContain('Sem atividade')
    expect(saved).toHaveLength(0)
    expect(notes).toHaveLength(0)
    expect(analyzeCalls).toHaveLength(0)
  })

  it('allows one review at a time and reports unknown projects as an error', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = new ImprovementService(deps({ analyze: async () => { await gate; return '## Prioridades\nok' } }), file)
    const first = service.begin('prj_1')
    expect(() => service.begin('prj_1')).toThrow(/em andamento/)
    release()
    await first.done
    const missing = await service.begin('prj_404').done
    expect(missing).toMatchObject({ state: 'error', error: 'projeto não encontrado' })
  })

  it('cancels while the analyst is working and saves nothing', async () => {
    const service = new ImprovementService(
      deps({
        analyze: (_system, _prompt, signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
      }),
      file
    )
    const { done } = service.begin('prj_1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.cancel()).toBe(true)
    expect(await done).toMatchObject({ state: 'cancelled' })
    expect(saved).toHaveLength(0)
    expect(service.cancel()).toBe(false)
  })

  it('clamps the look-back window', async () => {
    const service = new ImprovementService(deps(), file)
    expect((await service.begin('prj_1', { days: 9999 }).done).periodDays).toBe(180)
    expect((await service.begin('prj_1', { days: 0 }).done).periodDays).toBe(1)
    expect((await service.begin('prj_1', { days: Number.NaN }).done).periodDays).toBe(30)
  })

  it('ignores a persisted run that was still marked running', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: [{ id: 'imp_x', projectId: 'prj_1', state: 'running', startedAt: 1 }] }))
    const service = new ImprovementService(deps(), file)
    await service.init()
    expect(service.list('prj_1')).toEqual([])
  })
})

describe('scheduler action', () => {
  let dir: string
  beforeEach(async () => {
    dir = await makeTempDir('forja-sched-action-')
  })
  afterEach(async () => {
    await removeTempDir(dir)
  })

  const base = (over: Record<string, unknown> = {}) => ({
    name: 'Revisão semanal de melhorias',
    prompt: 'Revisão de melhorias do projeto',
    projectId: 'prj_1',
    cwd: dir,
    schedule: { kind: 'weekly' as const, day: 1, time: '09:00' },
    ...over
  })

  it('stores a built-in action with its options and can clear it', async () => {
    const scheduler = new Scheduler(path.join(dir, 'tasks.json'))
    try {
      const task = await scheduler.create(base({ action: 'improvement-review', actionOptions: { useAi: false, days: 14 } }))
      expect(task).toMatchObject({ action: 'improvement-review', actionOptions: { useAi: false, days: 14 } })

      const reloaded = new Scheduler(path.join(dir, 'tasks.json'))
      await reloaded.load()
      expect(reloaded.get(task.id)).toMatchObject({ action: 'improvement-review', actionOptions: { useAi: false, days: 14 } })
      reloaded.stop()

      const cleared = await scheduler.update(task.id, { action: undefined, actionOptions: undefined })
      expect(cleared.action).toBeUndefined()
      expect(cleared.actionOptions).toBeUndefined()
    } finally {
      scheduler.stop()
    }
  })

  it('refuses unknown actions and bad options', async () => {
    const scheduler = new Scheduler(path.join(dir, 'tasks2.json'))
    try {
      await expect(scheduler.create(base({ action: 'format-disk' }))).rejects.toThrow(/Ação inválida/)
      await expect(scheduler.create(base({ action: 'improvement-review', actionOptions: { days: 999 } }))).rejects.toThrow(/days/)
      await expect(scheduler.create(base({ action: 'improvement-review', actionOptions: { useAi: 'sim' } }))).rejects.toThrow(/useAi/)
    } finally {
      scheduler.stop()
    }
  })
})
