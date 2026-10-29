import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { keymap, highlightWhitespace, scrollPastEnd } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import type { FileNode, FileSearchHit } from '../../../shared/api'
import { Icon } from './Icons'
import { MenuPopover, type MenuItem } from './Chrome'
import { formatBytes, shortPath } from '../lib/format'
import { errorMessage, unwrap } from '../lib/api'

interface EditorOptions {
  showTree: boolean
  treeSide: 'left' | 'right'
  previewTabs: boolean
  autoSave: boolean
  tabIndents: boolean
  wordWrap: boolean
  showWhitespace: boolean
  scrollPastEnd: boolean
  tabSize: 2 | 4 | 8
}

const DEFAULT_OPTIONS: EditorOptions = {
  showTree: true,
  treeSide: 'left',
  previewTabs: true,
  autoSave: false,
  tabIndents: true,
  wordWrap: false,
  showWhitespace: false,
  scrollPastEnd: false,
  tabSize: 2
}

const OPTIONS_KEY = 'openclod.files.options'

function loadOptions(): EditorOptions {
  try {
    return { ...DEFAULT_OPTIONS, ...(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<EditorOptions>) }
  } catch {
    return DEFAULT_OPTIONS
  }
}

function language(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true, jsx: ext === 'tsx' })
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return javascript({ jsx: ext === 'jsx' })
  if (['json', 'jsonc'].includes(ext)) return json()
  if (['md', 'mdx', 'markdown'].includes(ext)) return markdown()
  if (['css', 'scss', 'less'].includes(ext)) return css()
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return html()
  if (['py', 'pyw'].includes(ext)) return python()
  return []
}

interface OpenFile {
  path: string
  /** Content as last read from or written to disk. */
  baseline: string
  content: string
  pinned: boolean
  saving: boolean
  error?: string
}

function Editor({
  file,
  options,
  dark,
  onChange,
  onSave
}: {
  file: OpenFile
  options: EditorOptions
  dark: boolean
  onChange(content: string): void
  onSave(): void
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const compartments = useRef({
    theme: new Compartment(),
    wrap: new Compartment(),
    tab: new Compartment(),
    whitespace: new Compartment(),
    past: new Compartment(),
    size: new Compartment()
  })
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  /** Raw option extensions, in compartment order; wrapped once at creation, reconfigured later. */
  const dynamic = useCallback(
    (): Extension[] => [
      dark ? oneDark : [],
      options.wordWrap ? EditorView.lineWrapping : [],
      options.tabIndents ? keymap.of([indentWithTab]) : [],
      options.showWhitespace ? highlightWhitespace() : [],
      options.scrollPastEnd ? scrollPastEnd() : [],
      [EditorState.tabSize.of(options.tabSize), indentUnit.of(' '.repeat(options.tabSize))]
    ],
    [dark, options.wordWrap, options.tabIndents, options.showWhitespace, options.scrollPastEnd, options.tabSize]
  )

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: file.content,
        extensions: [
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave()
                return true
              }
            }
          ]),
          basicSetup,
          language(file.path),
          ...(() => {
            const c = compartments.current
            const [theme, wrap, tab, whitespace, past, size] = dynamic()
            return [c.theme.of(theme), c.wrap.of(wrap), c.tab.of(tab), c.whitespace.of(whitespace), c.past.of(past), c.size.of(size)]
          })(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // One EditorView per open file; options are reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const c = compartments.current
    const [theme, wrap, tab, whitespace, past, size] = dynamic()
    view.dispatch({
      effects: [
        c.theme.reconfigure(theme),
        c.wrap.reconfigure(wrap),
        c.tab.reconfigure(tab),
        c.whitespace.reconfigure(whitespace),
        c.past.reconfigure(past),
        c.size.reconfigure(size)
      ]
    })
  }, [dynamic])

  // External reloads (e.g. "Recarregar do disco") replace the document.
  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== file.content) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.content } })
    }
  }, [file.content])

  return <div ref={host} className="code-editor" />
}

interface FilesPaneProps {
  root: string
  active: boolean
  onReveal(path: string): void
}

export function FilesPane({ root, active, onReveal }: FilesPaneProps): ReactElement {
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FileSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [options, setOptions] = useState<EditorOptions>(loadOptions)
  const [menu, setMenu] = useState(false)
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')
  const filesRef = useRef(files)
  filesRef.current = files

  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
    } catch {
      /* storage unavailable */
    }
  }, [options])

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.theme !== 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      setNodes(await unwrap(window.openclod.files.tree(root, 4)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [root])

  useEffect(() => {
    void load()
  }, [load])

  // Ctrl+Shift+Y toggles the tree while this pane is visible.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        setOptions((current) => ({ ...current, showTree: !current.showTree }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  // "?texto" searches file contents; anything else filters the tree by path.
  useEffect(() => {
    const text = query.trim()
    if (!text.startsWith('?')) {
      setHits(null)
      return
    }
    const term = text.slice(1).trim()
    if (term.length < 2) {
      setHits([])
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void window.openclod.files
        .search(root, term)
        .then((result) => setHits(result.ok ? result.value : []))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [query, root])

  const open = async (path: string, pin = false): Promise<void> => {
    const existing = filesRef.current.find((file) => file.path === path)
    if (existing) {
      if (pin && !existing.pinned) setFiles((list) => list.map((file) => (file.path === path ? { ...file, pinned: true } : file)))
      setActivePath(path)
      return
    }
    try {
      const result = await unwrap(window.openclod.files.read(root, path))
      const opened: OpenFile = { path, baseline: result.content, content: result.content, pinned: pin || !options.previewTabs, saving: false }
      setFiles((list) => {
        // A preview tab is replaced by the next file opened with a single click.
        const replaceable = options.previewTabs && !pin ? list.findIndex((file) => !file.pinned && file.content === file.baseline) : -1
        if (replaceable >= 0) return list.map((file, index) => (index === replaceable ? opened : file))
        return [...list, opened]
      })
      setActivePath(path)
      setError('')
    } catch (err) {
      setError(`${path}: ${errorMessage(err)}`)
    }
  }

  const save = async (path: string): Promise<void> => {
    const file = filesRef.current.find((item) => item.path === path)
    if (!file || file.content === file.baseline) return
    setFiles((list) => list.map((item) => (item.path === path ? { ...item, saving: true, error: undefined } : item)))
    try {
      // Refuse to silently overwrite changes made on disk (e.g. by the agent) since the file was opened.
      const disk = await window.openclod.files.read(root, path)
      if (disk.ok && disk.value.content !== file.baseline) {
        const overwrite = window.confirm(`${path} foi alterado no disco depois de aberto. Sobrescrever com a sua versão?`)
        if (!overwrite) {
          setFiles((list) => list.map((item) => (item.path === path ? { ...item, saving: false } : item)))
          return
        }
      }
      await unwrap(window.openclod.files.write(root, path, file.content))
      setFiles((list) => list.map((item) => (item.path === path ? { ...item, baseline: file.content, saving: false, pinned: true } : item)))
    } catch (err) {
      setFiles((list) => list.map((item) => (item.path === path ? { ...item, saving: false, error: errorMessage(err) } : item)))
    }
  }

  const reloadFromDisk = async (path: string): Promise<void> => {
    try {
      const result = await unwrap(window.openclod.files.read(root, path))
      setFiles((list) => list.map((item) => (item.path === path ? { ...item, baseline: result.content, content: result.content, error: undefined } : item)))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const closeFile = (path: string): void => {
    const file = filesRef.current.find((item) => item.path === path)
    if (file && file.content !== file.baseline && !window.confirm(`Descartar as alterações não salvas em ${path}?`)) return
    setFiles((list) => {
      const next = list.filter((item) => item.path !== path)
      if (activePath === path) setActivePath(next.length ? next[next.length - 1].path : null)
      return next
    })
  }

  // Auto-save one second after the last keystroke.
  const activeFile = files.find((file) => file.path === activePath) ?? null
  useEffect(() => {
    if (!options.autoSave || !activeFile || activeFile.content === activeFile.baseline || activeFile.saving) return
    const timer = setTimeout(() => void save(activeFile.path), 1000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.autoSave, activeFile?.content, activeFile?.path])

  const visibleNodes = useMemo(() => {
    const filter = query.trim().startsWith('?') ? '' : query.trim().toLowerCase()
    if (filter) return nodes.filter((node) => node.path.toLowerCase().includes(filter))
    return nodes.filter((node) => {
      const parts = node.path.split('/')
      for (let index = 1; index < parts.length; index++) {
        if (!expanded.has(parts.slice(0, index).join('/'))) return false
      }
      return true
    })
  }, [nodes, expanded, query])

  const toggleDir = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const set = <K extends keyof EditorOptions>(key: K, value: EditorOptions[K]): void => setOptions((current) => ({ ...current, [key]: value }))

  const menuItems: MenuItem[] = [
    { id: 'tree', label: 'Mostrar árvore', icon: 'list', checked: options.showTree, shortcut: 'Ctrl+Shift+Y', onSelect: () => set('showTree', !options.showTree) },
    {
      id: 'side',
      label: options.treeSide === 'left' ? 'Árvore à direita' : 'Árvore à esquerda',
      icon: options.treeSide === 'left' ? 'panelRight' : 'panelLeft',
      onSelect: () => set('treeSide', options.treeSide === 'left' ? 'right' : 'left')
    },
    { id: 'preview', label: 'Abas de visualização', checked: options.previewTabs, onSelect: () => set('previewTabs', !options.previewTabs) },
    { id: 'sep1', separator: true },
    { id: 'autosave', label: 'Salvamento automático', checked: options.autoSave, onSelect: () => set('autoSave', !options.autoSave) },
    { id: 'tabindent', label: 'A tecla Tab insere recuo', checked: options.tabIndents, onSelect: () => set('tabIndents', !options.tabIndents) },
    { id: 'wrap', label: 'Quebra de linha', checked: options.wordWrap, onSelect: () => set('wordWrap', !options.wordWrap) },
    { id: 'ws', label: 'Mostrar espaços em branco', checked: options.showWhitespace, onSelect: () => set('showWhitespace', !options.showWhitespace) },
    { id: 'past', label: 'Rolar além do fim', checked: options.scrollPastEnd, onSelect: () => set('scrollPastEnd', !options.scrollPastEnd) },
    { id: 'sep2', separator: true },
    ...([2, 4, 8] as const).map((size) => ({
      id: `size-${size}`,
      heading: size === 2 ? 'Tamanho da tabulação' : undefined,
      label: `${size} espaços`,
      checked: options.tabSize === size,
      onSelect: () => set('tabSize', size)
    }))
  ]

  const tree = (
    <div className="files-tree-col">
      <div className="panel-search">
        <Icon name="search" size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar, ou ? para pesquisar nos arquivos" spellCheck={false} />
        {query ? (
          <button type="button" className="icon-btn small" title="Limpar" onClick={() => setQuery('')}>
            <Icon name="x" size={11} />
          </button>
        ) : null}
      </div>
      <div className="file-tree">
        {loading && !nodes.length ? <div className="muted pad">Carregando…</div> : null}
        {hits ? (
          <>
            {searching ? <div className="muted pad">Pesquisando…</div> : null}
            {!searching && !hits.length ? <div className="muted pad">Nada encontrado.</div> : null}
            {hits.map((hit) => (
              <button key={`${hit.path}:${hit.line}`} type="button" className="search-hit" onClick={() => void open(hit.path)} title={`${hit.path}:${hit.line}`}>
                <span className="search-hit-path">
                  {hit.path}:{hit.line}
                </span>
                <span className="search-hit-text">{hit.text}</span>
              </button>
            ))}
          </>
        ) : (
          visibleNodes.map((node) => {
            const depth = node.path.split('/').length - 1
            const isOpen = expanded.has(node.path)
            return (
              <button
                key={node.path}
                type="button"
                className={`file-row ${node.dir ? 'dir' : ''} ${activePath === node.path ? 'active' : ''}`}
                style={{ paddingLeft: `${6 + depth * 12}px` }}
                onClick={() => (node.dir ? toggleDir(node.path) : void open(node.path))}
                onDoubleClick={() => (node.dir ? undefined : void open(node.path, true))}
                title={node.path}
              >
                {node.dir ? <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} /> : <span className="file-row-gap" />}
                <Icon name={node.dir ? (isOpen ? 'folderOpen' : 'folder') : 'fileCode'} size={12} />
                <span className="file-name">{node.path.split('/').pop()}</span>
                {!node.dir ? <span className="file-size">{formatBytes(node.size)}</span> : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )

  return (
    <div className={`files-pane2 tree-${options.treeSide} ${options.showTree ? '' : 'no-tree'}`}>
      <div className="pane-toolbar">
        <span className="pane-path" title={root}>
          {shortPath(root, 40)}
        </span>
        <button type="button" className={`icon-btn small ${options.showTree ? 'is-active' : ''}`} onClick={() => set('showTree', !options.showTree)} title="Mostrar árvore (Ctrl+Shift+Y)">
          <Icon name="list" size={13} />
        </button>
        <button type="button" className="icon-btn small" onClick={() => void load()} title="Recarregar árvore">
          <Icon name="refresh" size={13} />
        </button>
        <button type="button" className="icon-btn small" onClick={() => onReveal(root)} title="Abrir no Explorer">
          <Icon name="external" size={13} />
        </button>
        <span className="inline-anchor">
          <button type="button" className={`icon-btn small ${menu ? 'is-active' : ''}`} onClick={() => setMenu((value) => !value)} title="Opções do editor">
            <Icon name="more" size={13} />
          </button>
          {menu ? <MenuPopover items={menuItems} align="right" onClose={() => setMenu(false)} /> : null}
        </span>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="files-body">
        {options.showTree ? tree : null}
        <div className="files-editor-col">
          {files.length ? (
            <>
              <div className="editor-tabs" role="tablist">
                {files.map((file) => {
                  const dirty = file.content !== file.baseline
                  return (
                    <div key={file.path} className={`editor-tab ${file.path === activePath ? 'active' : ''} ${file.pinned ? '' : 'preview'}`}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={file.path === activePath}
                        onClick={() => setActivePath(file.path)}
                        onDoubleClick={() => setFiles((list) => list.map((item) => (item.path === file.path ? { ...item, pinned: true } : item)))}
                        title={file.path}
                      >
                        <span>{file.path.split('/').pop()}</span>
                        {dirty ? <span className="dirty-dot" title="Alterações não salvas" /> : null}
                      </button>
                      <button type="button" className="editor-tab-close" title="Fechar" onClick={() => closeFile(file.path)}>
                        <Icon name="x" size={10} />
                      </button>
                    </div>
                  )
                })}
              </div>
              {activeFile ? (
                <>
                  <div className="editor-status">
                    <span title={activeFile.path}>{activeFile.path}</span>
                    {activeFile.error ? <em className="error">{activeFile.error}</em> : null}
                    <span className="editor-status-actions">
                      {activeFile.saving ? <em>Salvando…</em> : activeFile.content !== activeFile.baseline ? <em>Não salvo</em> : <em>Salvo</em>}
                      <button type="button" className="btn tiny" disabled={activeFile.content === activeFile.baseline || activeFile.saving} onClick={() => void save(activeFile.path)} title="Salvar (Ctrl+S)">
                        Salvar
                      </button>
                      <button type="button" className="icon-btn small" onClick={() => void reloadFromDisk(activeFile.path)} title="Recarregar do disco">
                        <Icon name="refresh" size={12} />
                      </button>
                    </span>
                  </div>
                  <Editor
                    key={activeFile.path}
                    file={activeFile}
                    options={options}
                    dark={dark}
                    onChange={(content) => setFiles((list) => list.map((item) => (item.path === activeFile.path ? { ...item, content, pinned: true } : item)))}
                    onSave={() => void save(activeFile.path)}
                  />
                </>
              ) : null}
            </>
          ) : (
            <div className="file-empty">
              <Icon name="folderOpen" size={22} />
              <p>
                Os arquivos abertos aparecem aqui.
                <br />
                Clique para visualizar; clique duas vezes para fixar a aba.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
