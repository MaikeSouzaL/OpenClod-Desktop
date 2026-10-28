export interface PromptOptions {
  title: string
  /** Text above the field. */
  label?: string
  initial?: string
  placeholder?: string
  /** Hide what is typed (tokens, keys). */
  secret?: boolean
  confirmLabel?: string
}

/**
 * In-app replacement for `window.prompt()`: Electron does not implement it (the call throws), so every
 * place that asked for a value this way silently did nothing. Resolves with the text, or `null` when the user
 * cancels (Esc, Cancel, click outside). The dialog is plain DOM so it works from any event handler.
 */
export function promptText(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null
    const overlay = document.createElement('div')
    overlay.className = 'prompt-overlay'
    overlay.setAttribute('role', 'presentation')

    const dialog = document.createElement('form')
    dialog.className = 'prompt-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', options.title)

    const title = document.createElement('h2')
    title.className = 'prompt-title'
    title.textContent = options.title
    dialog.append(title)

    const input = document.createElement('input')
    input.className = 'prompt-input'
    input.type = options.secret ? 'password' : 'text'
    input.value = options.initial ?? ''
    input.autocomplete = 'off'
    input.spellcheck = false
    if (options.placeholder) input.placeholder = options.placeholder
    input.setAttribute('aria-label', options.label ?? options.title)
    if (options.label) {
      const label = document.createElement('label')
      label.className = 'prompt-label'
      label.textContent = options.label
      dialog.append(label)
    }
    dialog.append(input)

    const actions = document.createElement('div')
    actions.className = 'prompt-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn ghost'
    cancel.textContent = 'Cancelar'
    const confirm = document.createElement('button')
    confirm.type = 'submit'
    confirm.className = 'btn primary'
    confirm.textContent = options.confirmLabel ?? 'OK'
    actions.append(cancel, confirm)
    dialog.append(actions)
    overlay.append(dialog)

    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      previous?.focus?.()
      resolve(value)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
      }
    }
    dialog.addEventListener('submit', (event) => {
      event.preventDefault()
      finish(input.value)
    })
    cancel.addEventListener('click', () => finish(null))
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null)
    })
    document.addEventListener('keydown', onKey, true)
    document.body.append(overlay)
    input.focus()
    input.select()
  })
}
