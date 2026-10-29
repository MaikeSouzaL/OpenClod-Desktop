import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { LlamaCppStatusInfo, LlamaOptionField, LlamaOptionsInfo } from '../../../shared/llamacpp'
import { Icon } from './Icons'
import { errorMessage, unwrap } from '../lib/api'

type Values = Record<string, string | boolean | null>

/** How the extra arguments look in the text box: quoted where a value has spaces, as in a terminal. */
const joinArgs = (args: string[]): string => args.map((arg) => (arg === '' || /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')

/**
 * Configurações → Provedores → llama.cpp → Opções do servidor: every option the running llama-server lists in its own
 * --help, grouped, with Portuguese names for the known ones. Empty = llama.cpp's default. Saving checks every value
 * against the help; the next start uses them (a running server keeps the old ones until restarted).
 */
export function LlamaCppOptions({ status, onSaved }: { status: LlamaCppStatusInfo; onSaved(next: LlamaCppStatusInfo): void }): ReactElement {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<LlamaOptionsInfo | null>(null)
  const [draft, setDraft] = useState<Values>(status.profile.values)
  const [extra, setExtra] = useState(joinArgs(status.profile.extraArgs))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setInfo(await unwrap(window.openclod.app.llamacppOptions()))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    if (open && !info) void load()
  }, [open, info, load])

  // Another profile, or the saved values changed elsewhere: the draft follows.
  const profileKey = `${status.activeProfile}|${JSON.stringify(status.profile.values)}|${status.profile.extraArgs.join('\u0000')}`
  useEffect(() => {
    setDraft(status.profile.values)
    setExtra(joinArgs(status.profile.extraArgs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey])

  const changed = Object.values(draft).filter((value) => value !== null && value !== '' && value !== false).length
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.profile.values) || extra.trim() !== joinArgs(status.profile.extraArgs)

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!info) return []
    return info.groups
      .map((group) => ({
        ...group,
        fields: needle
          ? group.fields.filter((field) => `${field.label} ${field.flags.join(' ')} ${field.tip} ${field.help}`.toLowerCase().includes(needle))
          : group.fields
      }))
      .filter((group) => group.fields.length)
  }, [info, query])

  const set = (key: string, value: string | boolean | null): void => {
    setSaved(false)
    setDraft((current) => {
      const next = { ...current }
      if (value === null || value === '' || value === false) delete next[key]
      else next[key] = value
      return next
    })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const next = await unwrap(window.openclod.app.llamacppSetProfile({ values: draft, extraText: extra }))
      onSaved(next)
      setSaved(true)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="llama-section" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name="settings" size={13} /> Opções do servidor
        {changed ? <span className="llama-count">{changed} alterada{changed > 1 ? 's' : ''}</span> : null}
      </summary>
      {!info ? (
        <p className="llama-meta">{error || 'Lendo as opções do llama-server…'}</p>
      ) : (
        <div className="llama-section-body">
          <p className="llama-meta">
            Todas as opções que o llama-server ({info.build}) lista na própria ajuda. Vazio = o padrão do llama.cpp. Endereço, porta, chave, modelo,
            contexto e as opções que abririam o servidor para fora deste computador ficam com o Openclod. Vale no próximo <em>Iniciar</em>.
          </p>
          <input type="search" className="llama-search" value={query} placeholder="Procurar uma opção (nome, flag ou descrição)…" onChange={(event) => setQuery(event.target.value)} />
          <div className="llama-option-groups">
            {groups.map((group) => {
              const count = group.fields.filter((field) => draft[field.key] !== undefined).length
              return (
                <details key={group.id} className="llama-option-group" open={Boolean(query.trim())}>
                  <summary>
                    {group.name}
                    <span className="llama-meta">
                      {group.fields.length}
                      {count ? ` · ${count} alterada${count > 1 ? 's' : ''}` : ''}
                    </span>
                  </summary>
                  <div className="llama-option-fields">
                    {group.fields.map((field) => (
                      <OptionInput key={field.key} field={field} value={draft[field.key]} onChange={(value) => set(field.key, value)} />
                    ))}
                  </div>
                </details>
              )
            })}
            {!groups.length ? <p className="llama-meta">Nenhuma opção com "{query}".</p> : null}
          </div>
          <label className="llama-extra">
            Argumentos extras
            <input
              type="text"
              value={extra}
              placeholder='ex.: --override-kv tokenizer.ggml.add_bos_token=bool:false'
              onChange={(event) => {
                setSaved(false)
                setExtra(event.target.value)
              }}
            />
          </label>
          <div className="llama-actions">
            <button type="button" className="btn small primary" onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? 'Salvando…' : 'Salvar opções'}
            </button>
            <button
              type="button"
              className="btn small subtle"
              onClick={() => {
                setDraft({})
                setExtra('')
                setSaved(false)
              }}
              disabled={busy || (!changed && !extra.trim())}
            >
              Voltar aos padrões
            </button>
            {saved && !dirty ? <span className="llama-meta">Salvo{status.state === 'pronto' ? ': pare e inicie de novo para usar.' : '.'}</span> : null}
          </div>
          {error ? (
            <div className="llama-problem" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="llama-command">
            <span className="llama-meta">Linha de comando do próximo início (a chave vai pelo ambiente, nunca aqui)</span>
            <pre>{info.error ? info.error : info.commandLine}</pre>
          </div>
        </div>
      )}
    </details>
  )
}

function OptionInput({ field, value, onChange }: { field: LlamaOptionField; value: string | boolean | null | undefined; onChange(value: string | boolean | null): void }): ReactElement {
  const id = `llama-opt-${field.key.slice(2)}`
  const current = value === undefined || value === null ? '' : value
  const title = [field.flags.join(', '), field.help].filter(Boolean).join('\n\n')
  let control: ReactElement
  if (field.kind === 'bool') {
    control = <input id={id} type="checkbox" checked={current === true || current === 'on'} onChange={(event) => onChange(event.target.checked ? true : null)} />
  } else if (field.kind === 'tri') {
    control = (
      <select id={id} value={typeof current === 'string' ? current : current ? 'on' : ''} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">padrão</option>
        <option value="on">ligado</option>
        <option value="off">desligado</option>
      </select>
    )
  } else if (field.kind === 'choice') {
    control = (
      <select id={id} value={String(current)} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">padrão{field.default ? ` (${field.default})` : ''}</option>
        {field.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    )
  } else {
    control = (
      <input
        id={id}
        type="text"
        inputMode={field.kind === 'number' ? 'decimal' : undefined}
        value={String(current)}
        placeholder={field.default ? `padrão: ${field.default}` : field.kind === 'multi' ? field.choices.join(',') : field.value}
        onChange={(event) => onChange(event.target.value || null)}
      />
    )
  }
  return (
    <div className={`llama-option${value !== undefined ? ' set' : ''}${field.deprecated ? ' old' : ''}`} title={title}>
      <label htmlFor={id}>
        <span className="llama-option-name">{field.label}</span>
        <code>{field.key}</code>
      </label>
      {control}
      {field.tip ? <span className="llama-option-tip">{field.tip}</span> : !field.curated && field.help ? <span className="llama-option-tip">{field.help.split('\n')[0]}</span> : null}
    </div>
  )
}
