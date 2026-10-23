import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icons'

interface ErrorBoundaryProps {
  /** Shown in the fallback, e.g. "o painel lateral". */
  label: string
  /** Changing this key clears a previous error (e.g. the active session or tab). */
  resetKey?: string
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/** Keeps a crash in one area (a pane, a page) from blanking the whole window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[forja] erro em ${this.props.label}:`, error, info.componentStack)
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="error-fallback" role="alert">
        <Icon name="alert" size={20} />
        <strong>Falha ao exibir {this.props.label}.</strong>
        <code>{this.state.error.message}</code>
        <button type="button" className="btn small" onClick={() => this.setState({ error: null })}>
          Tentar de novo
        </button>
      </div>
    )
  }
}
