import { useMemo, useState, type ReactElement } from 'react'
import type { ToolResultPart } from '../../../shared/types'
import { Icon } from './Icons'
import { previewEdit } from '../lib/groups'
import { basename } from '../lib/format'
import type { LiveTool } from '../lib/types'

interface EditCardProps {
  name: string
  args: unknown
  result?: ToolResultPart
  live?: LiveTool
}

/** The green/red diff of an edit_file / write_file call, built from the call's own arguments. */
export function EditCard({ name, args, result, live }: EditCardProps): ReactElement {
  const preview = useMemo(() => previewEdit(name, args), [name, args])
  const running = live?.running ?? false
  const failed = live?.ok === false || result?.ok === false
  const [open, setOpen] = useState(true)
  const errorText = failed ? (live?.text ?? result?.text ?? '') : ''
  const path = preview?.path ?? ''

  return (
    <div className={`edit-card ${failed ? 'failed' : ''} ${running ? 'running' : ''}`}>
      <button type="button" className="edit-card-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Icon name={name === 'write_file' ? 'fileCode' : 'pencil'} size={13} />
        <span className="edit-card-path" title={path}>
          {path ? basename(path) : name}
        </span>
        {preview ? (
          <span className="edit-card-count">
            <em>+{preview.additions}</em> <b>−{preview.deletions}</b>
          </span>
        ) : null}
        <span className="edit-card-state">
          {running ? <span className="spinner tiny" /> : failed ? <Icon name="alert" size={12} /> : <Icon name="check" size={12} />}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {failed && errorText ? <div className="edit-card-error">{errorText.slice(0, 600)}</div> : null}
      {open && preview ? (
        <div className="edit-card-body">
          {preview.lines.map((line, index) => (
            <div key={index} className={`edit-line ${line.kind}`}>
              <span className="edit-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'gap' ? '' : ' '}</span>
              <span className="edit-text">{line.text || ' '}</span>
            </div>
          ))}
          {preview.truncated ? <div className="edit-line gap"><span className="edit-sign" /><span className="edit-text">… diff truncado</span></div> : null}
        </div>
      ) : null}
    </div>
  )
}
