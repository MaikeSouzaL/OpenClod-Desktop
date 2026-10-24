import type { ReactElement } from 'react'
import type { Project, SessionSummary } from '../../../shared/types'
import { relativeTime } from '../lib/format'
import { Icon } from './Icons'

interface ArtifactsPageProps {
  sessions: SessionSummary[]
  onCreate(prompt: string): void
}

const ARTIFACT_KINDS = [
  { id: 'doc', title: 'Documentos', detail: 'Relatórios, propostas e notas', icon: 'file' as const, prompt: 'Crie um documento novo na pasta do projeto e comece pelo título e estrutura.' },
  { id: 'slides', title: 'Apresentação', detail: 'Slides a partir de notas ou pesquisa', icon: 'image' as const, prompt: 'Crie uma apresentação com slides a partir do conteúdo disponível no projeto.' },
  { id: 'design', title: 'Design', detail: 'Telas, componentes e protótipos', icon: 'sparkles' as const, prompt: 'Crie um protótipo de tela e mostre o resultado visualmente.' },
  { id: 'panel', title: 'Painel', detail: 'Gráficos e indicadores', icon: 'gauge' as const, prompt: 'Crie um painel com indicadores e gráficos a partir dos dados do projeto.' }
]

export function ArtifactsPage({ sessions, onCreate }: ArtifactsPageProps): ReactElement {
  const recent = [...sessions].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt).slice(0, 8)
  return (
    <div className="page artifact-page">
      <header className="page-head">
        <div>
          <h1>Artefatos</h1>
          <p className="page-sub">Documentos, apresentações, designs e painéis criados pelos agentes.</p>
        </div>
      </header>
      <div className="page-tabs" role="tablist">
        <button type="button" role="tab" aria-selected className="active">Todos</button>
        <button type="button" role="tab" aria-selected={false}>Meus</button>
        <button type="button" role="tab" aria-selected={false}>Compartilhados com você</button>
      </div>

      <div className="artifact-banner">
        <div>
          <strong>Openclod Design agora está aqui</strong>
          <p>Novos projetos de slides e design são criados como artefatos e ficam na pasta do projeto.</p>
        </div>
        <button type="button" className="btn small" onClick={() => onCreate('Crie um artefato de design novo no projeto.')}>
          Criar artefato
        </button>
      </div>

      <h2 className="section-title">Crie algo novo</h2>
      <div className="artifact-kinds">
        {ARTIFACT_KINDS.map((kind) => (
          <button key={kind.id} type="button" className="artifact-kind" onClick={() => onCreate(kind.prompt)}>
            <span className={`artifact-thumb ${kind.id}`}>
              <Icon name={kind.icon} size={26} />
            </span>
            <strong>{kind.title}</strong>
            <span>{kind.detail}</span>
          </button>
        ))}
      </div>

      <h2 className="section-title">Recentes</h2>
      {recent.length ? (
        <div className="artifact-grid">
          {recent.map((session) => (
            <article key={session.meta.id} className="artifact-card">
              <div className="artifact-preview">
                <Icon name="file" size={26} />
              </div>
              <strong>{session.meta.title}</strong>
              <span>{session.preview.slice(0, 110) || 'Sessão sem prévia.'}</span>
              <small>Aberto {relativeTime(session.meta.updatedAt)}</small>
            </article>
          ))}
        </div>
      ) : (
        <div className="page-empty">
          <Icon name="image" size={28} />
          <p>Nenhum artefato ainda. Peça um documento, uma apresentação ou um painel ao agente.</p>
        </div>
      )}
    </div>
  )
}

interface DesignPageProps {
  onCreate(prompt: string): void
}

export function DesignPage({ onCreate }: DesignPageProps): ReactElement {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Design</h1>
          <p className="page-sub">Protótipos, telas e sistemas de design produzidos com o agente.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => onCreate('Crie um novo design de tela e mostre o resultado.')}>
          <Icon name="plus" size={13} /> Novo design
        </button>
      </header>
      <div className="page-tabs" role="tablist">
        <button type="button" role="tab" aria-selected className="active">Todos</button>
        <button type="button" role="tab" aria-selected={false}>Meus</button>
        <button type="button" role="tab" aria-selected={false}>Compartilhados com você</button>
      </div>
      <div className="page-empty">
        <Icon name="sparkles" size={30} />
        <p>Nenhum design ainda. Peça ao agente para criar uma tela, um componente ou um protótipo navegável.</p>
        <button type="button" className="btn primary" onClick={() => onCreate('Crie um protótipo de tela para o projeto e abra o preview.')}>
          Criar com o agente
        </button>
      </div>
    </div>
  )
}

interface DispatchPageProps {
  projects: Project[]
  activeProjectId: string | null
  keepAwake: boolean
  onToggleKeepAwake(): void
  onOpenSettings(): void
}

export function DispatchPage({ projects, activeProjectId, keepAwake, onToggleKeepAwake, onOpenSettings }: DispatchPageProps): ReactElement {
  const project = projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null
  return (
    <div className="page dispatch-page">
      <header className="page-head">
        <div>
          <h1>
            Dispatch <span className="badge">Beta</span>
          </h1>
          <p className="page-sub">Envie tarefas ao agente e acompanhe de outro dispositivo.</p>
        </div>
      </header>
      <div className="dispatch-layout">
        <aside className="dispatch-settings">
          <div className="info-card">
            <div className="info-card-head">
              <strong>Configurações</strong>
            </div>
            <label className="check-line">
              <input type="checkbox" checked={keepAwake} onChange={onToggleKeepAwake} />
              Manter computador ativo
            </label>
            <label className="check-line">
              <input type="checkbox" checked disabled />
              Notificações móveis
            </label>
            <p className="muted">
              O controle remoto por celular ainda não está disponível nesta versão. O agente continua trabalhando no
              computador enquanto esta janela estiver aberta.
            </p>
            <button type="button" className="btn small" onClick={onOpenSettings}>
              <Icon name="settings" size={13} /> Permissões
            </button>
          </div>
          <div className="info-card">
            <div className="info-card-head">
              <strong>Projeto</strong>
            </div>
            <p>{project ? project.name : 'Nenhum projeto escolhido'}</p>
            <p className="muted">{project?.path ?? 'Abra uma pasta para o agente trabalhar.'}</p>
          </div>
        </aside>
        <section className="dispatch-main">
          <div className="info-card dispatch-hero">
            <Icon name="monitor" size={20} />
            <div>
              <strong>Trabalhe com o Openclod direto no seu computador</strong>
              <p>
                O agente abre arquivos, navega, usa conectores e executa tarefas. Cada ação sensível aparece na
                conversa para você acompanhar e aprovar.
              </p>
            </div>
          </div>
          <div className="page-empty compact">
            <Icon name="message" size={24} />
            <p>Nenhuma tarefa Dispatch ainda. Use a conversa normal para começar.</p>
          </div>
        </section>
      </div>
    </div>
  )
}

interface MorePageProps {
  version: string
  archivedCount: number
  onOpenSettings(): void
  onOpenMemory(): void
}

export function MorePage({ version, archivedCount, onOpenSettings, onOpenMemory }: MorePageProps): ReactElement {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Mais</h1>
          <p className="page-sub">Configurações, arquivo e informações do aplicativo.</p>
        </div>
      </header>
      <div className="more-list">
        <button type="button" className="more-row" onClick={onOpenSettings}>
          <Icon name="settings" size={16} /> <span>Configurações</span> <kbd>Ctrl+,</kbd>
        </button>
        <div className="more-row static">
          <Icon name="archive" size={16} /> <span>Conversas arquivadas</span> <span className="muted">{archivedCount} na barra lateral</span>
        </div>
        <button type="button" className="more-row" onClick={onOpenMemory}>
          <Icon name="bookmark" size={16} /> <span>Memória dos projetos</span>
        </button>
        <div className="more-row static">
          <Icon name="info" size={16} /> <span>Openclod Desktop</span> <span className="muted">v{version}</span>
        </div>
      </div>
    </div>
  )
}
