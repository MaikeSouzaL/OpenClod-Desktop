/**
 * Both functions run in the page's MAIN world (chrome.scripting.executeScript with world: 'MAIN'), so they
 * have to stay self-contained. `openclodConsoleHook` wraps console.*, window errors, unhandled rejections,
 * failed resources, fetch and XMLHttpRequest once per page and keeps the last entries in a ring buffer;
 * `openclodConsoleRead` returns (and optionally clears) them for the `browser_console` tool.
 *
 * Only what happens after the hook is installed can be seen: the extension installs it the moment the agent
 * takes a tab, and again after each navigation.
 */
function openclodConsoleHook() {
  if (window.__openclodLog) return true
  const MAX = 200
  // `requests` holds the recent fetch/XHR traffic (method, url, status, timing and the request/response bodies,
  // each capped) for browser_network: the agent follows a page's API as a person reads the DevTools Network tab.
  const log = { entries: [], errors: [], requests: [], since: Date.now() }
  Object.defineProperty(window, '__openclodLog', { value: log, enumerable: false, configurable: true })

  const BODY_CAP = 4000
  const bodyText = (value) => {
    try {
      if (value == null) return ''
      if (typeof value === 'string') return value.slice(0, BODY_CAP)
      if (value instanceof URLSearchParams) return value.toString().slice(0, BODY_CAP)
      if (value instanceof FormData) {
        const parts = []
        for (const [key] of value.entries()) parts.push(key)
        return `[FormData: ${parts.join(', ')}]`.slice(0, BODY_CAP)
      }
      if (value instanceof Blob || value instanceof ArrayBuffer) return `[${value.constructor.name}, ${value.size || value.byteLength || 0} bytes]`
      return String(value).slice(0, BODY_CAP)
    } catch (_error) {
      return ''
    }
  }
  const recordRequest = (entry) => {
    log.requests.push(entry)
    if (log.requests.length > MAX) log.requests.splice(0, log.requests.length - MAX)
  }

  const text = (value) => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
    try {
      return JSON.stringify(value)
    } catch (_error) {
      return String(value)
    }
  }
  const push = (list, item) => {
    list.push(item)
    if (list.length > MAX) list.splice(0, list.length - MAX)
  }

  for (const type of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[type]
    console[type] = function (...args) {
      try {
        push(log.entries, { type, text: args.map(text).join(' ').slice(0, 800), ts: Date.now() })
      } catch (_error) {
        /* never break the page's own logging */
      }
      return original.apply(this, args)
    }
  }

  window.addEventListener(
    'error',
    (event) => {
      const target = event.target
      if (target && target !== window && target.tagName) {
        const src = target.currentSrc || target.src || target.href || ''
        push(log.errors, `falha ao carregar <${target.tagName.toLowerCase()}> ${String(src).slice(0, 300)}`)
      } else {
        push(log.entries, {
          type: 'pageerror',
          text: `${event.message || 'erro'} (${String(event.filename || '').slice(-80)}:${event.lineno || 0})`,
          ts: Date.now()
        })
      }
    },
    true
  )
  window.addEventListener('unhandledrejection', (event) => {
    push(log.entries, { type: 'pageerror', text: `promessa rejeitada: ${text(event.reason).slice(0, 600)}`, ts: Date.now() })
  })

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '').slice(0, 500)
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      const started = Date.now()
      const reqBody = bodyText(init && init.body)
      return originalFetch.apply(this, arguments).then(
        (response) => {
          if (response && response.status >= 400) push(log.errors, `${response.status} ${method} ${url}`)
          // Read the body off a clone so the page still consumes the original stream untouched.
          const record = (resBody) =>
            recordRequest({ method, url, status: response ? response.status : 0, type: response ? response.type : '', ms: Date.now() - started, reqBody, resBody, ts: started })
          try {
            response.clone().text().then((value) => record(value.slice(0, BODY_CAP)), () => record(''))
          } catch (_error) {
            record('')
          }
          return response
        },
        (error) => {
          push(log.errors, `falha de rede ${method} ${url}: ${text(error).slice(0, 160)}`)
          recordRequest({ method, url, status: 0, type: 'error', ms: Date.now() - started, reqBody, resBody: text(error).slice(0, 300), ts: started })
          throw error
        }
      )
    }
  }

  const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype
  if (proto) {
    const originalOpen = proto.open
    const originalSend = proto.send
    proto.open = function (method, url) {
      this.__openclod = { method: String(method || 'GET').toUpperCase(), url: String(url || '').slice(0, 500), started: Date.now() }
      this.addEventListener('loadend', () => {
        const meta = this.__openclod
        if (!meta) return
        if (this.status === 0) push(log.errors, `falha de rede ${meta.method} ${meta.url}`)
        else if (this.status >= 400) push(log.errors, `${this.status} ${meta.method} ${meta.url}`)
        let resBody = ''
        try {
          if (this.responseType === '' || this.responseType === 'text') resBody = String(this.responseText || '').slice(0, BODY_CAP)
          else if (this.responseType === 'json') resBody = bodyText(this.response)
          else resBody = `[${this.responseType}]`
        } catch (_error) {
          /* cross-origin opaque responses throw on read */
        }
        recordRequest({ method: meta.method, url: meta.url, status: this.status, type: this.responseType || 'text', ms: Date.now() - meta.started, reqBody: meta.reqBody || '', resBody, ts: meta.started })
      })
      return originalOpen.apply(this, arguments)
    }
    proto.send = function (body) {
      if (this.__openclod) this.__openclod.reqBody = bodyText(body)
      return originalSend.apply(this, arguments)
    }
  }
  return true
}

/** Returns (and optionally clears) the recent network traffic captured by the hook above, for browser_network. */
function openclodNetworkRead(clear) {
  const log = window.__openclodLog
  if (!log || !log.requests) return { installed: false, requests: [] }
  const result = { installed: true, since: log.since, requests: log.requests.slice(-120) }
  if (clear) log.requests.length = 0
  return result
}

function openclodConsoleRead(clear) {
  const log = window.__openclodLog
  if (!log) return { installed: false, entries: [], errors: [] }
  const result = { installed: true, since: log.since, entries: log.entries.slice(-100), errors: log.errors.slice(-100) }
  if (clear) {
    log.entries.length = 0
    log.errors.length = 0
  }
  return result
}
