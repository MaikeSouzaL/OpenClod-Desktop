import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { Project } from '../../../shared/types'
import type { ScheduleSpec, ScheduledTaskInfo, ScheduledTaskInput } from '../../../shared/api'
import { Icon } from './Icons'
import { MenuPopover, type MenuItem } from './Chrome'
import { relativeTime } from '../lib/format'
import { errorMessage, unwrap } from '../lib/api'
import { surfaceFor, type TaskSurface } from '../lib/scheduled-surface'

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

export function describeSchedule(schedule: ScheduleSpec): string {
  switch (schedule.kind) {
    case 'hourly':
      return `A cada hora, aos ${String(schedule.minute).padStart(2, '0')} min`
    case 'daily':
      return `Todo dia às ${schedule.time}`
    case 'weekdays':
      return `Dias úteis às ${schedule.time}`
    case 'weekly':
      return `Toda ${WEEKDAYS[schedule.day] ?? '?'} às ${schedule.time}`
    case 'once':
      return `Uma vez em ${new Date(schedule.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
  }
}

interface Template {
  name: string
  prompt: string
  schedule: ScheduleSpec
  icon: 'code' | 'checkSquare' | 'refresh' | 'list' | 'search' | 'hammer' | 'folder' | 'file'
  /** Session surface of each run; a template without one opens a Code session. */
  surface?: TaskSurface
  /** Built-in job instead of a prompt session. */
  action?: 'improvement-review'
  actionOptions?: { useAi?: boolean; days?: number }
}

/** Cowork starting points first (work in a folder), then developer-oriented ones, mirroring the template cards of the reference app. */
const TEMPLATES: Template[] = [
  {
    name: 'Organizar os arquivos novos da pasta',
    prompt: 'Veja os arquivos que chegaram nesta pasta desde a última execução e organize-os por tipo e data, sem apagar nada. No fim, liste o que foi movido e o que ficou de fora.',
    schedule: { kind: 'weekly', day: 5, time: '17:00' },
    icon: 'folder',
    surface: 'cowork'
  },
  {
    name: 'Resumo semanal da pasta',
    prompt: 'Leia os arquivos desta pasta alterados nos últimos 7 dias e grave um resumo em Markdown (resumo-semanal.md) com os pontos principais, decisões e pendências.',
    schedule: { kind: 'weekly', day: 1, time: '09:00' },
    icon: 'file',
    surface: 'cowork'
  },
  {
    name: 'Revisão diária do código',
    prompt: 'Revise as alterações não commitadas e os commits das últimas 24 horas. Aponte bugs prováveis, riscos de segurança e código sem teste, com arquivo e linha.',
    schedule: { kind: 'weekdays', time: '09:00' },
    icon: 'code',
    surface: 'code'
  },
  {
    name: 'Rodar os testes',
    prompt: 'Rode a suíte de testes do projeto. Se algo falhar, resuma cada falha com a causa provável e o arquivo envolvido. Não altere código.',
    schedule: { kind: 'daily', time: '08:00' },
    icon: 'checkSquare',
    surface: 'code'
  },
  {
    name: 'Dependências e vulnerabilidades',
    prompt: 'Liste dependências desatualizadas e vulnerabilidades conhecidas (por exemplo npm outdated e npm audit). Proponha atualizações seguras, sem aplicá-las.',
    schedule: { kind: 'weekly', day: 1, time: '10:00' },
    icon: 'refresh',
    surface: 'code'
  },
  {
    name: 'Resumo semanal do repositório',
    prompt: 'Resuma o que mudou no repositório nesta semana: commits, áreas afetadas, pendências e próximos passos sugeridos.',
    schedule: { kind: 'weekly', day: 5, time: '17:00' },
    icon: 'list',
    surface: 'code'
  },
  {
    name: 'Caçar TODO e FIXME',
    prompt: 'Procure TODO, FIXME e HACK no código e organize por prioridade e área, com arquivo e linha.',
    schedule: { kind: 'weekly', day: 3, time: '14:00' },
    icon: 'search',
    surface: 'code'
  },
  {
    name: 'Conferir o build',
    prompt: 'Rode o build do projeto. Se quebrar, explique o erro e onde corrigir. Não altere código.',
    schedule: { kind: 'daily', time: '12:00' },
    icon: 'hammer',
    surface: 'code'
  },
  {
    name: 'Revisão semanal de melhorias',
    prompt: 'Lê as limitações recorrentes, falhas por ferramenta, aprovações recusadas, uso por provedor e a memória do projeto, e salva um relatório com evidências na memória e na Atividade. Somente leitura: nada é aplicado.',
    schedule: { kind: 'weekly', day: 1, time: '09:00' },
    icon: 'search',
    action: 'improvement-review',
    actionOptions: { useAi: true, days: 14 }
  }
]

interface Draft {
  id?: string
  name: string
  prompt: string
  projectId: string
  kind: ScheduleSpec['kind']
  time: string
  minute: number
  day: number
  at: string
  enabled: boolean
  priority: 'low' | 'normal' | 'high'
  maxRetries: number
  retryDelaySec: number
  surface: TaskSurface
  action?: 'improvement-review'
  actionOptions?: { useAi?: boolean; days?: number }
}

function draftFrom(projectId: string, source?: Partial<Template> & { schedule?: ScheduleSpec; id?: string; enabled?: boolean; projectId?: string; priority?: 'low' | 'normal' | 'high'; maxRetries?: number; retryDelayMs?: number }): Draft {
  const schedule = source?.schedule ?? { kind: 'daily', time: '09:00' }
  return {
    id: source?.id,
    surface: surfaceFor(source),
    name: source?.name ?? '',
    prompt: source?.prompt ?? '',
    projectId: source?.projectId ?? projectId,
    kind: schedule.kind,
    time: 'time' in schedule ? schedule.time : '09:00',
    minute: schedule.kind === 'hourly' ? schedule.minute : 0,
    day: schedule.kind === 'weekly' ? schedule.day : 1,
    at: schedule.kind === 'once' ? schedule.at.slice(0, 16) : new Date(Date.now() + 3600_000).toISOString().slice(0, 16),
    enabled: source?.enabled ?? true,
    priority: source?.priority ?? 'normal',
    maxRetries: source?.maxRetries ?? 0,
    retryDelaySec: Math.round((source?.retryDelayMs ?? 0) / 1000),
    action: source?.action,
    actionOptions: source?.actionOptions
  }
}

function scheduleOf(draft: Draft): ScheduleSpec {
  switch (draft.kind) {
    case 'hourly':
      return { kind: 'hourly', minute: draft.minute }
    case 'weekly':
      return { kind: 'weekly', day: draft.day, time: draft.time }
    case 'once':
      return { kind: 'once', at: new Date(draft.at).toISOString() }
    default:
      return { kind: draft.kind, time: draft.time }
  }
}

function TaskDialog({
  draft,
  projects,
  onClose,
  onSaved
}: {
  draft: Draft
  projects: Project[]
  onClose(): void
  onSaved(task: ScheduledTaskInfo): void
}): ReactElement {
  const [form, setForm] = useState(draft)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setForm((current) => ({ ...current, [key]: value }))

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const input: ScheduledTaskInput = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        projectId: form.projectId,
        schedule: scheduleOf(form),
        enabled: form.enabled,
        priority: form.priority,
        maxRetries: form.maxRetries,
        retryDelayMs: form.retryDelaySec * 1000,
        ...(form.action ? { action: form.action, actionOptions: form.actionOptions ?? {} } : { surface: form.surface })
      }
      const task = form.id ? await unwrap(window.forja.schedules.update(form.id, input)) : await unwrap(window.forja.schedules.create(input))
      onSaved(task)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal task-modal" role="dialog" aria-modal="true" aria-label="Tarefa agendada">
        <header className="modal-head">
          <div>
            <h2>{form.id ? 'Editar tarefa' : 'Nova tarefa agendada'}</h2>
            <p>O Openclod abre uma sessão nova (Cowork ou Code) no projeto e envia a instrução no horário marcado, enquanto o app estiver aberto.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Fechar">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="modal-body task-form">
          {error ? <div className="inline-error">{error}</div> : null}
          <label>
            Nome
            <input value={form.name} maxLength={120} onChange={(event) => set('name', event.target.value)} placeholder="Ex.: Revisão diária do código" />
          </label>
          <label>
            Projeto
            <select value={form.projectId} onChange={(event) => set('projectId', event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {form.action ? null : (
            <label>
              Tipo de sessão
              <select value={form.surface} onChange={(event) => set('surface', event.target.value as TaskSurface)}>
                <option value="cowork">Cowork: trabalho em uma pasta (documentos, arquivos, pesquisa)</option>
                <option value="code">Code: sessão de código do projeto</option>
              </select>
            </label>
          )}
          {form.action ? (
            <div className="task-action-note">
              <strong>Tarefa interna: revisão de melhorias</strong>
              <p>{form.prompt}</p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.actionOptions?.useAi !== false}
                  onChange={(event) => set('actionOptions', { ...form.actionOptions, useAi: event.target.checked })}
                />{' '}
                Usar IA para analisar (envia as evidências, sem segredos, ao provedor padrão)
              </label>
            </div>
          ) : (
            <label>
              Instrução para o agente
              <textarea value={form.prompt} rows={6} maxLength={20000} onChange={(event) => set('prompt', event.target.value)} placeholder="O que o agente deve fazer a cada execução" />
            </label>
          )}
          <div className="task-form-row">
            <label>
              Frequência
              <select value={form.kind} onChange={(event) => set('kind', event.target.value as Draft['kind'])}>
                <option value="hourly">A cada hora</option>
                <option value="daily">Todo dia</option>
                <option value="weekdays">Dias úteis</option>
                <option value="weekly">Toda semana</option>
                <option value="once">Uma vez</option>
              </select>
            </label>
            {form.kind === 'hourly' ? (
              <label>
                Minuto
                <input type="number" min={0} max={59} value={form.minute} onChange={(event) => set('minute', Math.max(0, Math.min(59, Number(event.target.value) || 0)))} />
              </label>
            ) : null}
            {form.kind === 'weekly' ? (
              <label>
                Dia
                <select value={form.day} onChange={(event) => set('day', Number(event.target.value))}>
                  {WEEKDAYS.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {form.kind === 'daily' || form.kind === 'weekdays' || form.kind === 'weekly' ? (
              <label>
                Horário
                <input type="time" value={form.time} onChange={(event) => set('time', event.target.value)} />
              </label>
            ) : null}
            {form.kind === 'once' ? (
              <label>
                Data e hora
                <input type="datetime-local" value={form.at} onChange={(event) => set('at', event.target.value)} />
              </label>
            ) : null}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.enabled} onChange={(event) => set('enabled', event.target.checked)} /> Ativada
          </label>
          <div className="task-form-row">
            <label>
              Prioridade
              <select value={form.priority} onChange={(event) => set('priority', event.target.value as Draft['priority'])}>
                <option value="low">Baixa</option>
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
              </select>
            </label>
            <label>
              Retentativas
              <input type="number" min={0} max={5} value={form.maxRetries} onChange={(event) => set('maxRetries', Math.max(0, Math.min(5, Number(event.target.value) || 0)))} />
            </label>
            <label>
              Espera entre tentativas (s)
              <input type="number" min={0} max={300} value={form.retryDelaySec} onChange={(event) => set('retryDelaySec', Math.max(0, Math.min(300, Number(event.target.value) || 0)))} />
            </label>
          </div>
        </div>
        <footer className="modal-foot">
          <span className="muted">{describeSchedule(scheduleOf(form))}</span>
          <span className="modal-foot-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn primary" disabled={saving || !form.name.trim() || !form.prompt.trim() || !form.projectId} onClick={() => void save()}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </span>
        </footer>
      </div>
    </div>
  )
}

interface ScheduledPageProps {
  projects: Project[]
  activeProjectId: string | null
  onOpenSession(sessionId: string): void
  onAddProject(): void
}

export function ScheduledPage({ projects, activeProjectId, onOpenSession, onAddProject }: ScheduledPageProps): ReactElement {
  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'next' | 'name'>('next')
  const [newMenu, setNewMenu] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const defaultProject = activeProjectId ?? projects[0]?.id ?? ''

  const load = useCallback(async (): Promise<void> => {
    try {
      setTasks(await unwrap(window.forja.schedules.list()))
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => clearInterval(timer)
  }, [load])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? tasks.filter((task) => task.name.toLowerCase().includes(q) || task.prompt.toLowerCase().includes(q)) : tasks
    return [...filtered].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : (a.enabled ? (a.nextRunAt ?? Infinity) : Infinity) - (b.enabled ? (b.nextRunAt ?? Infinity) : Infinity)
    )
  }, [tasks, query, sort])

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const projectName = (id: string): string => projects.find((project) => project.id === id)?.name ?? 'projeto removido'
  const menuTask = rowMenu ? tasks.find((task) => task.id === rowMenu.id) : null
  const rowItems: MenuItem[] = menuTask
    ? [
        { id: 'run', label: 'Executar agora', icon: 'play', onSelect: () => void act(() => unwrap(window.forja.schedules.runNow(menuTask.id))) },
        { id: 'edit', label: 'Editar', icon: 'pencil', onSelect: () => setDraft(draftFrom(defaultProject, menuTask)) },
        {
          id: 'toggle',
          label: menuTask.enabled ? 'Pausar' : 'Ativar',
          icon: menuTask.enabled ? 'pause' : 'play',
          onSelect: () => void act(() => unwrap(window.forja.schedules.update(menuTask.id, { enabled: !menuTask.enabled })))
        },
        ...(menuTask.lastSessionId ? [{ id: 'open', label: 'Abrir última execução', icon: 'message' as const, onSelect: () => onOpenSession(menuTask.lastSessionId!) }] : []),
        { id: 'sep', separator: true },
        {
          id: 'delete',
          label: 'Apagar tarefa',
          icon: 'trash',
          danger: true,
          onSelect: () => {
            if (window.confirm(`Apagar a tarefa "${menuTask.name}"?`)) void act(() => unwrap(window.forja.schedules.remove(menuTask.id)))
          }
        }
      ]
    : []

  const newItems: MenuItem[] = [
    { id: 'manual', label: 'Configurar manualmente', icon: 'sliders', onSelect: () => setDraft(draftFrom(defaultProject)) },
    ...TEMPLATES.map((template, index) => ({
      id: `tpl-${index}`,
      heading: index === 0 ? 'A partir de um modelo' : undefined,
      label: template.name,
      icon: template.icon,
      onSelect: () => setDraft(draftFrom(defaultProject, template))
    }))
  ]

  return (
    <div className="page">
      <header className="page-head">
        <h1>Tarefas agendadas</h1>
        <span className="inline-anchor">
          <button type="button" className="btn primary" disabled={!projects.length} onClick={() => setNewMenu((value) => !value)}>
            <Icon name="plus" size={14} /> Nova tarefa
          </button>
          {newMenu ? <MenuPopover items={newItems} align="right" onClose={() => setNewMenu(false)} /> : null}
        </span>
      </header>
      <p className="page-lead">
        Rode instruções do agente em horários fixos: relatórios, organização de pastas, revisões, testes. Cada execução abre uma sessão Cowork ou Code, à sua
        escolha. As execuções acontecem enquanto o Openclod estiver aberto; uma execução perdida com o app fechado roda uma vez ao abrir.
      </p>
      <div className="page-tools">
        <div className="page-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar tarefas" spellCheck={false} />
        </div>
        <label className="page-sort">
          Ordenar por
          <select value={sort} onChange={(event) => setSort(event.target.value as 'next' | 'name')}>
            <option value="next">Próxima execução</option>
            <option value="name">Nome</option>
          </select>
        </label>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {!projects.length ? (
        <div className="page-empty">
          <Icon name="folderOpen" size={26} />
          <p>Adicione um projeto antes de agendar tarefas: cada execução abre uma sessão nele.</p>
          <button type="button" className="btn primary" onClick={onAddProject}>
            Abrir pasta de projeto
          </button>
        </div>
      ) : loading ? (
        <div className="muted pad">Carregando…</div>
      ) : list.length ? (
        <div className="task-list">
          {list.map((task) => (
            <div key={task.id} className={`task-row ${task.enabled ? '' : 'paused'}`}>
              <span className={`dot ${task.lastStatus === 'error' ? 'off' : task.enabled ? 'on' : 'idle'}`} />
              <div className="task-main">
                <strong>
                  {task.name}
                  {task.action ? <span className="badge" title="Roda a revisão de melhorias, sem abrir sessão">interna</span> : null}
                </strong>
                <span>
                  {describeSchedule(task.schedule)} · {projectName(task.projectId)}
                  {task.action ? '' : ` · ${(task.surface ?? 'code') === 'cowork' ? 'Cowork' : 'Code'}`} · prioridade {task.priority ?? 'normal'}
                  {task.maxRetries ? ` · até ${task.maxRetries} retentativa(s)` : ''}
                </span>
              </div>
              <div className="task-meta">
                <span>{task.enabled ? (task.nextRunAt ? `próxima ${new Date(task.nextRunAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'sem próxima') : 'pausada'}</span>
                <em className={task.lastStatus === 'error' ? 'error' : ''} title={task.lastError}>
                  {task.lastRunAt ? `última ${relativeTime(task.lastRunAt)}${task.lastStatus === 'error' ? ' · falhou' : task.lastStatus === 'running' ? ' · rodando' : ''}` : 'nunca executada'}
                </em>
              </div>
              <button
                type="button"
                className="side-mini"
                title="Opções"
                onClick={(event) => setRowMenu({ id: task.id, x: event.clientX - 220, y: event.clientY })}
              >
                <Icon name="more" size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="page-empty compact">
            <Icon name="clock" size={24} />
            <p>{query ? 'Nenhuma tarefa corresponde à pesquisa.' : 'Nenhuma tarefa agendada ainda. Comece por um modelo:'}</p>
          </div>
          {!query ? (
            <div className="template-grid">
              {TEMPLATES.map((template) => (
                <button key={template.name} type="button" className="template-card" onClick={() => setDraft(draftFrom(defaultProject, template))}>
                  <Icon name={template.icon} size={16} />
                  <strong>{template.name}</strong>
                  <span>{template.prompt}</span>
                  <em>{describeSchedule(template.schedule)}</em>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {rowMenu ? (
        <div className="context-anchor" style={{ left: rowMenu.x, top: rowMenu.y }}>
          <MenuPopover items={rowItems} onClose={() => setRowMenu(null)} />
        </div>
      ) : null}
      {draft ? (
        <TaskDialog
          draft={draft}
          projects={projects}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}
