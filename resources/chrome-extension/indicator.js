/**
 * Runs inside the page (chrome.scripting.executeScript serialises this function, so it has to stay
 * self-contained). Draws the "Openclod is controlling this tab" signal the user sees while an agent works
 * in their own Chrome: a soft orange glow along the window edges and a small pill with the Openclod face and a
 * Stop button, the same visual language as the desktop overlay.
 *
 * The UI lives in a closed shadow root, so the page cannot style it, and the agent's own page snapshots (which
 * walk the document) never see it. Only the Stop button receives the mouse; everything else is click-through.
 *
 * Actions:
 *   show    draw or refresh it; it removes itself after `ttlMs` unless refreshed (a crashed worker or a closed
 *           app can never leave a stale "controlling" badge behind)
 *   hide    remove it
 *   conceal hide it for a moment (screenshots must not include it)
 *   reveal  bring it back
 */
function openclodIndicator(action, options) {
  const ID = 'openclod-agent-indicator'
  const input = options || {}
  const existing = document.getElementById(ID)

  if (action === 'hide') {
    if (existing) {
      clearTimeout(existing.__openclodTimer)
      existing.remove()
    }
    return true
  }
  if (action === 'conceal' || action === 'reveal') {
    if (existing) existing.style.visibility = action === 'conceal' ? 'hidden' : 'visible'
    return Boolean(existing)
  }

  const ttl = Math.max(3000, Number(input.ttlMs) || 15000)
  const label = String(input.label || 'Openclod está controlando esta aba').slice(0, 80)
  const stopLabel = String(input.stopLabel || 'Parar').slice(0, 20)

  if (existing) {
    // Refresh: same element, new deadline (and text, if it changed).
    clearTimeout(existing.__openclodTimer)
    existing.__openclodTimer = setTimeout(() => existing.remove(), ttl)
    if (typeof existing.__openclodSetLabel === 'function') existing.__openclodSetLabel(label)
    existing.style.visibility = 'visible'
    return true
  }

  const host = document.createElement('div')
  host.id = ID
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText =
    'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;display:block;'
  const root = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .glow {
      position: absolute; inset: 0; pointer-events: none;
      background:
        linear-gradient(90deg, rgba(255,118,20,.5) 0, rgba(255,118,20,.14) 12px, rgba(255,118,20,0) 80px) left / 80px 100% no-repeat,
        linear-gradient(270deg, rgba(255,118,20,.5) 0, rgba(255,118,20,.14) 12px, rgba(255,118,20,0) 80px) right / 80px 100% no-repeat,
        linear-gradient(180deg, rgba(255,118,20,.46) 0, rgba(255,118,20,.14) 12px, rgba(255,118,20,0) 80px) top / 100% 80px no-repeat,
        linear-gradient(0deg, rgba(255,118,20,.46) 0, rgba(255,118,20,.14) 12px, rgba(255,118,20,0) 80px) bottom / 100% 80px no-repeat;
      box-shadow: inset 0 0 0 1px rgba(255,142,50,.6), inset 0 0 28px rgba(255,122,26,.18);
      animation: glow 3.4s ease-in-out infinite;
    }
    @keyframes glow { 50% { opacity: .78; } }
    .pill {
      position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 9px; padding: 6px 7px 6px 8px; border-radius: 999px;
      background: rgba(26,21,18,.94); border: 1px solid rgba(255,122,26,.42); color: #ffe4cc;
      font: 500 12.5px/1 "Segoe UI", system-ui, -apple-system, sans-serif; letter-spacing: .01em; white-space: nowrap;
      box-shadow: 0 10px 30px rgba(0,0,0,.38); pointer-events: none; user-select: none;
      animation: rise .28s cubic-bezier(.2,1.2,.4,1) both;
    }
    @keyframes rise { from { opacity: 0; transform: translate(-50%, 10px) scale(.96); } }
    .face { width: 26px; height: 26px; flex: none; animation: bob 3.6s ease-in-out infinite; }
    @keyframes bob { 50% { transform: translateY(1.5px); } }
    .eye { transform-box: fill-box; transform-origin: center; animation: blink 5.2s infinite; }
    @keyframes blink { 0%, 94%, 100% { transform: scaleY(1); } 97% { transform: scaleY(.1); } }
    .bulb { animation: bulb 1.6s ease-in-out infinite; }
    @keyframes bulb { 50% { opacity: .55; } }
    .text { padding-right: 2px; }
    button {
      all: unset; box-sizing: border-box; pointer-events: auto; cursor: pointer;
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 11px; border-radius: 999px;
      background: rgba(255,122,26,.18); border: 1px solid rgba(255,122,26,.5); color: #ffd9bd;
      font: 600 12px/1 "Segoe UI", system-ui, -apple-system, sans-serif;
      transition: background .15s ease, transform .1s ease;
    }
    button:hover { background: rgba(255,122,26,.34); }
    button:active { transform: scale(.96); }
    button:focus-visible { outline: 2px solid #ffb27a; outline-offset: 2px; }
    .square { width: 8px; height: 8px; border-radius: 2px; background: #ff7a1a; }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  `

  const glow = document.createElement('div')
  glow.className = 'glow'

  const pill = document.createElement('div')
  pill.className = 'pill'
  pill.innerHTML =
    '<svg class="face" viewBox="0 0 64 64" aria-hidden="true">' +
    '<defs><radialGradient id="p" cx="36%" cy="27%" r="80%"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#f4f1ec"/><stop offset=".7" stop-color="#d9d4cb"/><stop offset="1" stop-color="#a39d92"/></radialGradient></defs>' +
    '<path d="M32 15 V9" stroke="#cfc8bd" stroke-width="2.4" stroke-linecap="round"/>' +
    '<circle class="bulb" cx="32" cy="6.5" r="4" fill="#ff8a2e"/>' +
    '<rect x="3" y="31" width="6" height="14" rx="3" fill="#ff8a2e"/><rect x="55" y="31" width="6" height="14" rx="3" fill="#ff8a2e"/>' +
    '<circle cx="32" cy="38" r="23" fill="url(#p)"/>' +
    '<ellipse class="eye" cx="24" cy="36" rx="3.4" ry="5.2" fill="#211c17"/><ellipse class="eye" cx="40" cy="36" rx="3.4" ry="5.2" fill="#211c17"/>' +
    '<circle cx="22.9" cy="33.6" r="1.1" fill="#fff"/><circle cx="38.9" cy="33.6" r="1.1" fill="#fff"/>' +
    '<ellipse cx="17" cy="45" rx="3.6" ry="2.2" fill="#ff9a7a" opacity=".5"/><ellipse cx="47" cy="45" rx="3.6" ry="2.2" fill="#ff9a7a" opacity=".5"/>' +
    '<path d="M27 46.5 Q32 51 37 46.5" fill="none" stroke="#2c2721" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>'

  const text = document.createElement('span')
  text.className = 'text'
  text.textContent = label

  const stop = document.createElement('button')
  stop.type = 'button'
  stop.setAttribute('aria-label', 'Parar o Openclod nesta aba')
  const square = document.createElement('span')
  square.className = 'square'
  stop.append(square, document.createTextNode(stopLabel))
  stop.addEventListener(
    'click',
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      try {
        chrome.runtime.sendMessage({ type: 'openclod-stop' })
      } catch (_error) {
        /* the extension was reloaded: nothing to stop */
      }
      clearTimeout(host.__openclodTimer)
      host.remove()
    },
    true
  )

  pill.append(text, stop)
  root.append(style, glow, pill)
  host.__openclodSetLabel = (value) => {
    text.textContent = value
  }
  host.__openclodTimer = setTimeout(() => host.remove(), ttl)
  ;(document.documentElement || document.body).appendChild(host)
  return true
}
