/**
 * Runs inside the page (chrome.scripting.executeScript serialises this function, so it must stay
 * self-contained: every helper lives inside it). The extension used to click "the first element whose
 * textContent contains the name", which is always <html>; typing used a synthetic Enter that never submits a
 * form and set `value` directly, which React-style controlled inputs ignore. This resolver works like an
 * accessibility tree instead: visible interactive elements, accessible names, roles, best match wins.
 *
 * Actions: click, type, press, snapshot. Everything returns plain JSON.
 */
function openclodPageTool(action, payload) {
  const input = payload || {}

  const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase()
  const clip = (value, max) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  const visible = (el) => {
    if (!(el instanceof Element)) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.split(' ')[0].toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'range') return 'slider'
      if (type === 'hidden') return ''
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return ''
  }

  const nameOf = (el) => {
    const label = el.getAttribute('aria-label')
    if (label && label.trim()) return clip(label, 160)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ')
      if (text.trim()) return clip(text, 160)
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const labels = el.labels ? [...el.labels].map((l) => l.innerText).join(' ') : ''
      if (labels.trim()) return clip(labels, 160)
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (['submit', 'button', 'reset'].includes(type) && el.value) return clip(el.value, 160)
      return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 160)
    }
    if (tag === 'img') return clip(el.getAttribute('alt') || el.getAttribute('title') || '', 160)
    const text = el.innerText || el.textContent || ''
    return clip(text || el.getAttribute('title') || '', 160)
  }

  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],' +
    '[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=treeitem],' +
    '[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])'

  const interactive = () => [...document.querySelectorAll(INTERACTIVE)].filter(visible)

  const scoreName = (name, wanted) => {
    const n = norm(name)
    if (!wanted) return 1
    if (!n) return 0
    if (n === wanted) return 4
    if (n.startsWith(wanted)) return 3
    if (n.includes(wanted)) return 2
    return 0
  }

  /** Resolves `{ selector, role, name, text }` to one element; reports how many matched equally well. */
  const resolve = (target, fallbackRoles) => {
    if (target.selector) {
      const all = [...document.querySelectorAll(target.selector)]
      const shown = all.filter(visible)
      const list = shown.length ? shown : all
      const index = Number.isInteger(target.index) ? target.index : 0
      return { el: list[index] || null, matches: list.length }
    }
    const wanted = norm(target.name || target.text || '')
    const role = norm(target.role || '')
    let pool = interactive()
    if (role) pool = pool.filter((el) => roleOf(el) === role)
    else if (fallbackRoles) pool = pool.filter((el) => fallbackRoles.includes(roleOf(el)))
    let best = []
    let bestScore = 0
    for (const el of pool) {
      const score = scoreName(nameOf(el), wanted)
      if (score > bestScore) {
        bestScore = score
        best = [el]
      } else if (score === bestScore && score > 0) best.push(el)
    }
    // Clickable things that are not marked interactive (a styled <div>): match on their own text.
    if (!best.length && wanted && !role && !fallbackRoles) {
      const loose = [...document.querySelectorAll('body *')].filter((el) => {
        if (!visible(el)) return false
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')
        return norm(own).includes(wanted)
      })
      best = loose
    }
    if (!best.length && !wanted && pool.length) best = [pool[0]]
    if (best.length > 1) {
      // The most specific one wins: shortest accessible name, then document order.
      best.sort((a, b) => nameOf(a).length - nameOf(b).length)
    }
    return { el: best[0] || null, matches: best.length }
  }

  const describe = (el) => ({ tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el) })

  const pointOf = (el) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  const setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  const focusables = () => [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')].filter((el) => visible(el) && !el.disabled)

  if (action === 'click') {
    const { el, matches } = resolve(input)
    if (!el) throw new Error(`elemento não encontrado: ${input.selector || `${input.role || 'qualquer'} "${input.name || input.text || ''}"`}`)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const point = pointOf(el)
    const top = document.elementFromPoint(point.x, point.y)
    const covered = Boolean(top && top !== el && !el.contains(top) && !top.contains(el))
    el.focus?.({ preventScroll: true })
    el.click()
    return { url: location.href, point, matches, chosen: describe(el), covered }
  }

  if (action === 'type') {
    const hasTarget = Boolean(input.selector || input.name || input.text || input.role)
    let found = hasTarget ? resolve(input, input.role ? null : ['textbox', 'combobox', 'searchbox', 'checkbox', 'radio']) : { el: null, matches: 0 }
    if (!found.el && !hasTarget) {
      const active = document.activeElement
      const editable = active && (active.matches?.('input,textarea,select') || active.isContentEditable)
      found = { el: editable ? active : interactive().find((el) => roleOf(el) === 'textbox') || null, matches: 1 }
    }
    const el = found.el
    if (!el) throw new Error(`campo não encontrado: ${input.selector || `"${input.name || input.text || ''}"`}`)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.focus?.({ preventScroll: true })
    const value = String(input.value == null ? '' : input.value)
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const wantChecked = !/^(false|0|nao|não|off)$/i.test(value)
      if (el.checked !== wantChecked) el.click()
    } else if (el instanceof HTMLSelectElement) {
      const wanted = norm(value)
      const option = [...el.options].find((o) => norm(o.value) === wanted || norm(o.text) === wanted) || [...el.options].find((o) => norm(o.text).includes(wanted))
      if (!option) throw new Error(`opção não encontrada: ${value}`)
      setNativeValue(el, option.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // The native setter is what React/Vue controlled inputs listen to; assigning `.value` alone is ignored by them.
      setNativeValue(el, value)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (el.isContentEditable) {
      const selection = getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      selection?.removeAllRanges()
      selection?.addRange(range)
      if (!document.execCommand('insertText', false, value)) {
        el.textContent = value
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      }
    } else {
      throw new Error('o elemento encontrado não aceita texto')
    }
    let submitted = false
    if (input.submit) {
      const form = el.form || el.closest?.('form')
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        submitted = true
      } else {
        for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
        submitted = true
      }
    }
    return { url: location.href, point: pointOf(el), matches: found.matches, chosen: describe(el), submitted }
  }

  if (action === 'press') {
    const raw = String(input.key || '')
    const parts = raw.split('+')
    const key = parts[parts.length - 1]
    const shift = parts.slice(0, -1).some((p) => /shift/i.test(p))
    const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body
    if (/^tab$/i.test(key)) {
      const list = focusables()
      const at = list.indexOf(active)
      const next = list[(at + (shift ? -1 : 1) + list.length) % list.length]
      next?.focus()
      return { focused: next ? describe(next) : null }
    }
    if (/^enter$/i.test(key)) {
      const form = active.form || active.closest?.('form')
      const tag = active.tagName?.toLowerCase()
      if (tag === 'button' || tag === 'a' || active.getAttribute?.('role') === 'button') {
        active.click()
        return { activated: describe(active) }
      }
      if (form && typeof form.requestSubmit === 'function' && tag !== 'textarea') {
        form.requestSubmit()
        return { submitted: true }
      }
    }
    const keyCodes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, Home: 36, End: 35, PageDown: 34, PageUp: 33 }
    const names = { esc: 'Escape', return: 'Enter', down: 'ArrowDown', up: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight' }
    const normalized = names[key.toLowerCase()] || key
    const init = { key: normalized, code: normalized.length === 1 ? `Key${normalized.toUpperCase()}` : normalized, keyCode: keyCodes[normalized] || normalized.charCodeAt(0), shiftKey: shift, bubbles: true, cancelable: true }
    for (const type of ['keydown', 'keypress', 'keyup']) active.dispatchEvent(new KeyboardEvent(type, init))
    return { dispatched: normalized }
  }

  if (action === 'snapshot') {
    const max = Number(input.maxChars) > 0 ? Number(input.maxChars) : 18000
    const lines = []
    let n = 0
    for (const el of document.querySelectorAll(`${INTERACTIVE},h1,h2,h3,h4,h5,h6,img[alt]`)) {
      if (!visible(el)) continue
      const role = roleOf(el) || el.tagName.toLowerCase()
      const name = nameOf(el)
      if (!name && role !== 'textbox') continue
      n += 1
      let line = `- ${role}${name ? ` "${name}"` : ''}`
      if (el instanceof HTMLAnchorElement && el.href) line += ` → ${el.href}`
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.type !== 'password' && el.value && !['submit', 'button', 'reset', 'checkbox', 'radio'].includes(el.type)) line += ` = "${clip(el.value, 80)}"`
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) line += el.checked ? ' [marcado]' : ' [desmarcado]'
      if (el.disabled) line += ' [desabilitado]'
      lines.push(line)
      if (n >= 250) {
        lines.push('- …[mais elementos omitidos]')
        break
      }
    }
    const text = (document.body?.innerText || '').trim()
    const head = `Elementos (${n}):\n${lines.join('\n')}\n\nTexto da página:\n`
    const room = Math.max(1000, max - head.length)
    return `${head}${text.slice(0, room)}${text.length > room ? '\n…[snapshot truncado]' : ''}`
  }

  throw new Error(`ação desconhecida: ${action}`)
}
