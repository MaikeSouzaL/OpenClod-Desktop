import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { errorMessage, unwrap } from '../lib/api'
import { Icon } from './Icons'
import { Markdown } from './Markdown'

export interface ArtifactFile {
  path: string
  size: number
}

interface ArtifactStudioProps {
  root: string
  file: ArtifactFile
  onClose(): void
  onSaved?(): void
}

function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'tsx' || ext === 'jsx' })
  if (ext === 'json') return json()
  if (ext === 'md' || ext === 'mdx') return markdown()
  if (ext === 'css') return css()
  if (ext === 'html' || ext === 'htm' || ext === 'svg') return html()
  if (ext === 'py') return python()
  return []
}

function kindOf(path: string): 'markdown' | 'html' | 'svg' | 'csv' | 'json' | 'text' {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'md' || ext === 'mdx') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'svg') return 'svg'
  if (ext === 'csv') return 'csv'
  if (ext === 'json') return 'json'
  return 'text'
}

function csvTable(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, 200)
    .map((line) => line.split(';').length > line.split(',').length ? line.split(';') : line.split(','))
}

export function ArtifactStudio({ root, file, onClose, onSaved }: ArtifactStudioProps): ReactElement {
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'split' | 'editor' | 'preview'>('split')
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const draftRef = useRef('')
  draftRef.current = draft

  const kind = kindOf(file.path)
  const dirty = draft !== saved

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const result = await unwrap(window.forja.files.read(root, file.path))
        if (cancelled) return
        setDraft(result.content)
        setSaved(result.content)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file.path, root])

  useEffect(() => {
    const host = hostRef.current
    if (!host || loading || (tab === 'preview' && kind !== 'text')) return
    const extensions = [
      basicSetup,
      keymap.of([]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setDraft(update.state.doc.toString())
      }),
      ...(dark ? [oneDark] : []),
      languageFor(file.path)
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: draftRef.current, extensions }),
      parent: host
    })
    viewRef.current = view
    return () => {
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // The editor is recreated only when the file, theme or view mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, loading, dark, tab])

  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== draft) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft } })
    }
  }, [draft])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await unwrap(window.forja.files.write(root, file.path, draft))
      setSaved(draft)
      onSaved?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const preview = useMemo(() => {
    if (kind === 'markdown') return <Markdown text={draft} />
    if (kind === 'html' || kind === 'svg') {
      const src = kind === 'svg' ? `<html><body style="margin:0;background:#fff">${draft}</body></html>` : draft
      return <iframe className="artifact-preview-frame" title={file.path} sandbox="allow-scripts" srcDoc={src} />
    }
    if (kind === 'csv') {
      const rows = csvTable(draft)
      return (
        <div className="artifact-table-wrap">
          <table className="artifact-table">
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (kind === 'json') {
      try {
        return <pre className="artifact-code">{JSON.stringify(JSON.parse(draft), null, 2)}</pre>
      } catch {
        return <pre className="artifact-code">{draft}</pre>
      }
    }
    return <pre className="artifact-code">{draft}</pre>
  }, [draft, file.path, kind])

  return (
    <section className="artifact-studio">
      <header className="artifact-studio-head">
        <div className="artifact-studio-title">
          <Icon name="file" size={14} />
          <strong>{file.path}</strong>
          {dirty ? <span className="badge on">não salvo</span> : null}
        </div>
        <div className="artifact-studio-actions">
          <button type="button" className={`btn ghost small ${tab === 'editor' ? 'is-active' : ''}`} onClick={() => setTab('editor')}>
            Editor
          </button>
          <button type="button" className={`btn ghost small ${tab === 'preview' ? 'is-active' : ''}`} onClick={() => setTab('preview')}>
            Preview
          </button>
          <button type="button" className={`btn ghost small ${tab === 'split' ? 'is-active' : ''}`} onClick={() => setTab('split')}>
            Dividido
          </button>
          <button type="button" className="btn ghost small" onClick={() => setDark((value) => !value)}>
            {dark ? 'Claro' : 'Escuro'}
          </button>
          <button type="button" className="btn ghost small" onClick={() => void window.forja.files.reveal(`${root}\\${file.path}`)}>
            <Icon name="external" size={12} /> Explorer
          </button>
          <button type="button" className="btn primary small" onClick={() => void save()} disabled={!dirty || saving}>
            <Icon name="check" size={12} /> {saving ? 'Salvando…' : 'Salvar'}
          </button>
          <button type="button" className="icon-btn small" onClick={onClose} title="Fechar">
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>
      {error ? <div className="inline-error">{error}</div> : null}
      {loading ? <div className="page-empty compact">Abrindo artefato…</div> : null}
      <div className={`artifact-studio-body ${tab}`}>
        {tab !== 'preview' ? <div className="artifact-editor" ref={hostRef} /> : null}
        {tab !== 'editor' ? <div className="artifact-preview">{preview}</div> : null}
      </div>
    </section>
  )
}
