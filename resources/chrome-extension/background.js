// In-page helpers (each defines one global function; they are injected into pages with chrome.scripting):
//   openclodPageTool      click/type/press/snapshot resolver (also unit-tested in a real browser)
//   openclodIndicator     the "Openclod is controlling this tab" glow + Stop button
//   openclodConsoleHook / openclodConsoleRead   console and network error capture for browser_console
importScripts('page-tool.js', 'indicator.js', 'console-hook.js')

const HOST = 'com.openclod.desktop'
const ACTIVE_TABS_KEY = 'openclod.activeTabs'
const HEARTBEAT_ALARM = 'openclod-heartbeat'
/** The app answers every hello/heartbeat with `hello_ack`; silence for this long means it is not running. */
const APP_ALIVE_MS = 30000
/** The page removes its own indicator after this long without a refresh, so a stale badge cannot linger. */
const INDICATOR_TTL_MS = 15000
const INDICATOR_REFRESH_MS = 4000
/** After the user presses Stop, commands of that session are refused for a moment (the model's next step). */
const STOP_BLOCK_MS = 4000

const activeTabs = new Map()
/** tabId -> { sessionId, at, shownAt }: tabs the agent touched recently (they show the indicator). */
const touched = new Map()
const stoppedUntil = new Map()
let nativePort = null
let tabsRestored = false
let lastAckAt = 0
let appVersion = ''
let reconnectDelay = 1500

/** MV3 workers are stopped when idle; keep the session→tab map in storage. */
async function restoreActiveTabs() {
  if (tabsRestored) return
  tabsRestored = true
  try {
    const stored = await chrome.storage.session.get(ACTIVE_TABS_KEY)
    const entries = stored?.[ACTIVE_TABS_KEY]
    if (!entries || typeof entries !== 'object') return
    for (const [sessionId, tabId] of Object.entries(entries)) {
      if (typeof tabId === 'number') activeTabs.set(sessionId, tabId)
    }
  } catch {
    /* storage.session may be unavailable on very old Chrome */
  }
}

async function saveActiveTabs() {
  try {
    await chrome.storage.session.set({ [ACTIVE_TABS_KEY]: Object.fromEntries(activeTabs) })
  } catch {
    /* best effort; the map still works for this worker lifetime */
  }
}

function setActiveTab(sessionId, tabId) {
  if (sessionId === undefined || tabId === undefined) return
  activeTabs.set(sessionId, tabId)
  void saveActiveTabs()
}

function forgetActiveTab(sessionId) {
  activeTabs.delete(sessionId)
  void saveActiveTabs()
}

/* ------------------------------------------------------------------ */
/* Connection and toolbar badge                                        */
/* ------------------------------------------------------------------ */

function appAlive() {
  return lastAckAt > 0 && Date.now() - lastAckAt < APP_ALIVE_MS
}

function workingTabIds() {
  const now = Date.now()
  return [...touched.entries()].filter(([, entry]) => now - entry.at < INDICATOR_TTL_MS).map(([tabId]) => tabId)
}

function refreshBadge() {
  let text = ''
  let color = '#ff7a1a'
  let title = 'Openclod: conectado'
  if (!appAlive()) {
    text = '!'
    color = '#d9382b'
    title = nativePort ? 'Openclod: procurando o aplicativo…' : 'Openclod: desconectado'
  } else if (workingTabIds().length) {
    text = String(workingTabIds().length)
    title = 'Openclod: o agente está trabalhando'
  }
  try {
    void chrome.action.setBadgeText({ text })
    void chrome.action.setBadgeBackgroundColor({ color })
    void chrome.action.setBadgeTextColor?.({ color: '#ffffff' })
    void chrome.action.setTitle({ title })
  } catch {
    /* the action API is missing only in unusual embeddings */
  }
}

function postHello() {
  try {
    connectNative().postMessage({
      type: 'hello',
      browser: navigator.userAgent,
      version: chrome.runtime.getManifest().version
    })
  } catch {
    /* the host will reconnect on the next heartbeat */
  }
}

function connectNative() {
  if (nativePort) return nativePort
  nativePort = chrome.runtime.connectNative(HOST)
  nativePort.onMessage.addListener((message) => {
    if (message && message.type === 'hello_ack') {
      lastAckAt = Date.now()
      appVersion = typeof message.appVersion === 'string' ? message.appVersion : appVersion
      reconnectDelay = 1500
      refreshBadge()
      return
    }
    void handle(message)
  })
  nativePort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError // read it so Chrome does not log "unchecked runtime.lastError"
    nativePort = null
    refreshBadge()
    // Back off while the host is missing (app closed or companion not installed): 1.5 s up to 15 s.
    setTimeout(connectNative, reconnectDelay)
    reconnectDelay = Math.min(15000, Math.round(reconnectDelay * 1.6))
  })
  refreshBadge()
  return nativePort
}

function post(message) {
  try {
    connectNative().postMessage(message)
  } catch (error) {
    console.error('Openclod native bridge:', error)
  }
}

/* ------------------------------------------------------------------ */
/* "Openclod is controlling this tab" indicator and Stop               */
/* ------------------------------------------------------------------ */

async function inject(tabId, func, args = [], world) {
  // executeScript rejects `undefined` anywhere in args ("Value is unserializable"): a JSON round trip turns an
  // omitted optional argument (browser_read without a selector) into null and drops undefined fields.
  const safeArgs = JSON.parse(JSON.stringify(args ?? []))
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args: safeArgs, ...(world ? { world } : {}) })
  if (injection?.error) throw new Error(String(injection.error))
  return injection?.result
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pages an extension can never script (the agent can still navigate away from them). */
function unscriptable(url) {
  const value = String(url || '')
  return !value || value === 'about:blank' || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(value) || /^https:\/\/chromewebstore\.google\.com\//i.test(value)
}

/**
 * Waits until the tab finished loading. With `expectNavigation` (after a click, Enter or a URL change) it first
 * gives the navigation a moment to start: a page that is read right after `tabs.update` is still the old one (or
 * about:blank), and single-page apps (GitHub, Gmail) swap the view without a full load.
 */
async function settle(tabId, { timeoutMs = 15000, expectNavigation = false, initialUrl } = {}) {
  const started = Date.now()
  let tab = await validTab(tabId)
  if (!tab) return null
  if (expectNavigation) {
    const from = initialUrl ?? tab.url
    while (Date.now() - started < 1200) {
      if (tab.status === 'loading' || tab.pendingUrl || tab.url !== from) break
      await sleep(100)
      tab = await validTab(tabId)
      if (!tab) return null
    }
  }
  while (tab && (tab.status !== 'complete' || tab.pendingUrl) && Date.now() - started < timeoutMs) {
    await sleep(150)
    tab = await validTab(tabId)
  }
  // Let scripts of the new page render the view before it is read or captured.
  await sleep(350)
  return (await validTab(tabId)) ?? tab
}

/** True for the errors executeScript gives while the document is being replaced (a navigation in flight). */
function transientScriptError(error) {
  return /frame|removed|no tab with id|showing error page|cannot access contents of url|document is not|was closed/i.test(
    String(error?.message || error)
  )
}

/** Marks the tab as in use: shows or refreshes the page indicator and (re)installs the console hook. */
async function touchTab(tab, sessionId) {
  if (!tab || tab.id === undefined) return
  const now = Date.now()
  const previous = touched.get(tab.id)
  const entry = { sessionId, at: now, shownAt: previous?.shownAt ?? 0 }
  touched.set(tab.id, entry)
  try {
    // chrome:// pages and the Web Store cannot be scripted: the agent works there blind, without the badge.
    await inject(tab.id, openclodConsoleHook, [], 'MAIN')
    if (now - entry.shownAt >= INDICATOR_REFRESH_MS) {
      entry.shownAt = now
      await inject(tab.id, openclodIndicator, ['show', { ttlMs: INDICATOR_TTL_MS }])
    }
  } catch {
    /* not scriptable */
  }
  refreshBadge()
}

async function hideIndicator(tabId) {
  touched.delete(tabId)
  try {
    await inject(tabId, openclodIndicator, ['hide'])
  } catch {
    /* tab closed or not scriptable */
  }
  refreshBadge()
}

/** Tells the app to stop the sessions and clears the indicators. With no session ids: every session using a tab. */
async function requestStop(sessionIds) {
  await restoreActiveTabs()
  const ids = sessionIds.length ? sessionIds : [...activeTabs.keys()]
  const until = Date.now() + STOP_BLOCK_MS
  for (const sessionId of ids) {
    stoppedUntil.set(sessionId, until)
    post({ type: 'stop', sessionId })
  }
  const tabIds = new Set(ids.map((id) => activeTabs.get(id)).filter((id) => id !== undefined))
  for (const [tabId, entry] of touched) if (ids.includes(entry.sessionId)) tabIds.add(tabId)
  await Promise.all([...tabIds].map((tabId) => hideIndicator(tabId)))
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

const GROUP_COLOR = 'blue'

async function findGroup(groupName) {
  const matching = await chrome.tabGroups.query({ title: groupName })
  if (!matching.length) return undefined
  matching.sort((left, right) => right.id - left.id)
  return matching[0].id
}

async function groupFor(tabId, groupName) {
  let existing
  try {
    const tab = await chrome.tabs.get(tabId)
    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      const current = await chrome.tabGroups.get(tab.groupId)
      if (current.title === groupName) existing = current.id
    }
  } catch {
    /* the tab may have been closed; fall through to title recovery */
  }
  existing ??= await findGroup(groupName)
  if (existing !== undefined) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: existing })
    await chrome.tabGroups.update(existing, { title: groupName, color: GROUP_COLOR, collapsed: false })
    return existing
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] })
  await chrome.tabGroups.update(groupId, { title: groupName, color: GROUP_COLOR, collapsed: false })
  return groupId
}

async function validTab(tabId) {
  try {
    return await chrome.tabs.get(Number(tabId))
  } catch {
    return null
  }
}

async function claimedTab(sessionId) {
  const id = activeTabs.get(sessionId)
  if (id === undefined) throw new Error('nenhuma aba ativa nesta sessão')
  let tab
  try {
    tab = await chrome.tabs.get(id)
    if (!tab) throw new Error('aba fechada')
  } catch {
    forgetActiveTab(sessionId)
    throw new Error('a aba da sessão foi fechada')
  }
  void touchTab(tab, sessionId)
  return tab
}

async function createTab({ sessionId, groupName, url }) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true })
  if (tab.id === undefined) throw new Error('o Chrome não devolveu o id da aba')
  setActiveTab(sessionId, tab.id)
  await groupFor(tab.id, groupName)
  void touchTab(tab, sessionId)
  return tab.id
}

async function claimExistingTab({ sessionId, groupName, tabId, url, active, urlContains }) {
  let tab
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    tab = await validTab(String(tabId).replace(/^chrome_/, ''))
    if (!tab) throw new Error('a aba informada não existe mais')
  } else if (active) {
    const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!current || current.id === undefined) throw new Error('nenhuma aba ativa encontrada no Chrome')
    tab = current
  } else {
    const all = await chrome.tabs.query({})
    const wanted = String(urlContains || '').toLowerCase()
    const candidates = all.filter((candidate) => {
      if (candidate.id === undefined) return false
      if (url && candidate.url === url) return true
      if (wanted && String(candidate.url || '').toLowerCase().includes(wanted)) return true
      return false
    })
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length
          ? 'mais de uma aba corresponde; informe tab_id ou use active=true'
          : 'aba existente não encontrada; use active=true para adotar a aba em foco'
      )
    }
    tab = candidates[0]
  }
  if (tab.id === undefined) throw new Error('o Chrome não devolveu o id da aba')
  setActiveTab(sessionId, tab.id)
  await groupFor(tab.id, groupName)
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  void touchTab(tab, sessionId)
  return tab.id
}

async function execute(tabId, func, args = []) {
  try {
    return await inject(tabId, func, args)
  } catch (error) {
    // The page was being replaced (a click that navigates, a redirect): wait for the new one and try once more.
    if (!transientScriptError(error)) throw error
    const tab = await settle(tabId)
    if (!tab) throw new Error('a aba foi fechada')
    if (unscriptable(tab.url)) throw new Error(`a página ${tab.url || '(vazia)'} não pode ser lida pela extensão; navegue para um site (browser_navigate)`)
    return inject(tabId, func, args)
  }
}

/**
 * Clicks or types, retrying ONCE when the element was not found — it may still be rendering after a navigation or
 * after a previous click revealed it. Safe to retry: a "not found" means nothing happened, so nothing double-fires.
 */
async function actOnElement(tabId, action, payload) {
  try {
    return await execute(tabId, openclodPageTool, [action, payload])
  } catch (error) {
    if (!/n[ãa]o encontrad|not found|nenhum elemento|no element|n[ãa]o aceita/i.test(String(error?.message || error))) throw error
    await settle(tabId, { timeoutMs: 4000 })
    await sleep(400)
    return execute(tabId, openclodPageTool, [action, payload])
  }
}

/* ------------------------------------------------------------------ */
/* Network log (all requests of the tabs the agent uses)              */
/* ------------------------------------------------------------------ */

const NET_MAX = 150
/** tabId -> recent requests (method, url, status, type, timing); complements the in-page fetch/XHR bodies. */
const netLog = new Map()
/** requestId -> start time, so onCompleted can report a duration. */
const netStart = new Map()

function usingTab(tabId) {
  return tabId !== undefined && tabId >= 0 && ([...activeTabs.values()].includes(tabId) || touched.has(tabId))
}

function netPush(tabId, entry) {
  if (!usingTab(tabId)) return
  const list = netLog.get(tabId) || []
  list.push(entry)
  if (list.length > NET_MAX) list.splice(0, list.length - NET_MAX)
  netLog.set(tabId, list)
}

function installWebRequest() {
  if (!chrome.webRequest) return
  const filter = { urls: ['<all_urls>'] }
  try {
    chrome.webRequest.onBeforeRequest.addListener((d) => { if (usingTab(d.tabId)) netStart.set(d.requestId, d.timeStamp) }, filter)
    chrome.webRequest.onCompleted.addListener((d) => {
      const start = netStart.get(d.requestId)
      netStart.delete(d.requestId)
      netPush(d.tabId, { method: d.method, url: String(d.url).slice(0, 500), status: d.statusCode, type: d.type, fromCache: d.fromCache, ms: start ? Math.round(d.timeStamp - start) : undefined, ts: Date.now() })
    }, filter)
    chrome.webRequest.onErrorOccurred.addListener((d) => {
      const start = netStart.get(d.requestId)
      netStart.delete(d.requestId)
      netPush(d.tabId, { method: d.method, url: String(d.url).slice(0, 500), status: 0, type: d.type, error: String(d.error || '').slice(0, 120), ms: start ? Math.round(d.timeStamp - start) : undefined, ts: Date.now() })
    }, filter)
  } catch (_error) {
    /* webRequest unavailable in this build */
  }
}

/** Tabs a page opened (target=_blank, window.open): openerTabId -> { tabId, at }. */
const openedBy = new Map()

/** After an action: when the page opened a tab of its own, that tab becomes the session's active one. */
async function followOpenedTab(tab, sessionId, groupName, since) {
  const opened = openedBy.get(tab.id)
  if (!opened || opened.at < since) return undefined
  openedBy.delete(tab.id)
  const created = await validTab(opened.tabId)
  if (!created) return undefined
  setActiveTab(sessionId, created.id)
  if (groupName) await groupFor(created.id, groupName).catch(() => undefined)
  await settle(created.id)
  void touchTab(created, sessionId)
  return `chrome_${created.id}`
}

/** Base64 of a Blob without FileReader (not available in service workers). */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Captures the visible part of the tab. The automatic "view" after each action asks for a JPEG no wider than
 * `maxWidth`: a full HD PNG is 1-3 MB and costs the model several thousand tokens per step.
 */
async function capture(tab, { format = 'png', quality = 70, maxWidth = 0 } = {}) {
  if (!tab.active) {
    // captureVisibleTab shows whatever tab is in front of the window: bring the session's tab forward.
    await chrome.tabs.update(tab.id, { active: true })
    await sleep(250)
  }
  const jpeg = format === 'jpeg'
  const options = jpeg ? { format: 'jpeg', quality: Math.max(30, Math.min(95, Number(quality) || 70)) } : { format: 'png' }
  let dataUrl
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options)
  } catch (error) {
    // Chrome allows two captures per second.
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String(error?.message || error))) throw error
    await sleep(700)
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options)
  }
  const mediaType = jpeg ? 'image/jpeg' : 'image/png'
  const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '')
  if (!maxWidth) return { base64, mediaType, width: tab.width || 0, height: tab.height || 0 }
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
    if (bitmap.width <= maxWidth) return { base64, mediaType, width: bitmap.width, height: bitmap.height }
    const width = Math.round(maxWidth)
    const height = Math.round((bitmap.height * width) / bitmap.width)
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: options.quality ? options.quality / 100 : 0.7 })
    return { base64: await blobToBase64(blob), mediaType: 'image/jpeg', width, height }
  } catch {
    return { base64, mediaType, width: tab.width || 0, height: tab.height || 0 }
  }
}

/**
 * The page's HTML for the agent: tags, ids, classes, names, ARIA and form attributes, without scripts, styles,
 * SVG drawings or comments, and never the value of a password field.
 */
function openclodReadHtml(selector, maxChars) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return `(nenhum elemento casa com ${selector})`
  const clone = root.cloneNode(true)
  // Pair the fields before anything is removed from the copy, so the indexes still match the live page.
  const liveInputs = root.querySelectorAll('input, textarea, select')
  const clonedInputs = clone.querySelectorAll('input, textarea, select')
  clonedInputs.forEach((field, index) => {
    const source = liveInputs[index]
    const type = (field.getAttribute('type') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') {
      field.removeAttribute('value')
      return
    }
    // What the user (or the agent) typed lives in the property, not in the attribute.
    if (source && 'value' in source && source.value) field.setAttribute('value', String(source.value).slice(0, 200))
    if (source && (source.type === 'checkbox' || source.type === 'radio') && source.checked) field.setAttribute('checked', '')
  })
  for (const node of clone.querySelectorAll('script, style, noscript, template, link, meta')) node.remove()
  for (const svg of clone.querySelectorAll('svg')) svg.replaceChildren()
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT)
  const comments = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  for (const comment of comments) comment.remove()
  for (const el of clone.querySelectorAll('*')) {
    for (const attribute of [...el.attributes]) {
      const name = attribute.name
      if (name === 'style' || name.startsWith('on') || (name.startsWith('data-') && !/^data-(test|testid|qa|cy|target|action)/.test(name))) {
        el.removeAttribute(name)
      } else if (attribute.value.length > 160) {
        el.setAttribute(name, `${attribute.value.slice(0, 160)}…`)
      }
    }
  }
  const html = clone.outerHTML.replace(/\n\s*\n+/g, '\n').replace(/[ \t]{2,}/g, ' ')
  const limit = Number(maxChars) || 30000
  return html.length > limit ? `${html.slice(0, limit)}\n…[HTML truncado: use selector para ler só uma parte]` : html
}

/**
 * Converts a viewport point (CSS px) into a screen point in DIP so the
 * desktop overlay can put the agent cursor on the clicked element.
 */
async function screenPointFor(tab, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  try {
    const win = await chrome.windows.get(tab.windowId)
    const topChrome = Math.max(0, (win.height || 0) - (tab.height || 0))
    return {
      x: (win.left || 0) + point.x,
      y: (win.top || 0) + Math.min(topChrome, 160) + point.y
    }
  } catch {
    return undefined
  }
}

async function waitFor(tabId, selector, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = await execute(tabId, (value) => Boolean(document.querySelector(value)), [selector])
    if (found) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`elemento não ficou visível: ${selector}`)
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

/**
 * The cookies of the tab's page (and, with `name`, that one). httpOnly cookies are included because an agent that
 * manages a session needs them, but the value is never written to a log or report (the app scrubs those); the
 * model sees it only to act on it in the same browser.
 */
async function readCookies(tab, name) {
  if (!tab.url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)) {
    throw new Error('a página atual não tem cookies de site (navegue para um site com browser_navigate)')
  }
  const all = await chrome.cookies.getAll({ url: tab.url })
  const list = (name ? all.filter((cookie) => cookie.name === name) : all).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expires: cookie.expirationDate ? Math.round(cookie.expirationDate) : null
  }))
  return { url: tab.url, count: list.length, cookies: list }
}

async function writeCookie(tab, cookie) {
  if (!cookie.name) throw new Error('informe o nome do cookie')
  const url = cookie.url || tab.url
  if (!url || !/^https?:/i.test(url)) throw new Error('precisa de um site http(s) para gravar o cookie')
  const details = {
    url,
    name: String(cookie.name),
    value: String(cookie.value ?? ''),
    ...(cookie.path ? { path: String(cookie.path) } : {}),
    ...(cookie.domain ? { domain: String(cookie.domain) } : {}),
    ...(cookie.secure !== undefined ? { secure: Boolean(cookie.secure) } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: Boolean(cookie.httpOnly) } : {}),
    ...(cookie.sameSite ? { sameSite: String(cookie.sameSite) } : {}),
    ...(cookie.expires ? { expirationDate: Number(cookie.expires) } : {})
  }
  const saved = await chrome.cookies.set(details)
  if (!saved) throw new Error('o Chrome recusou gravar o cookie (confira domínio, secure e sameSite)')
  return { ok: true, name: saved.name, domain: saved.domain }
}

async function removeCookie(tab, name, url) {
  if (!name) throw new Error('informe o nome do cookie a remover')
  const target = url || tab.url
  if (!target) throw new Error('precisa da URL do site do cookie')
  const removed = await chrome.cookies.remove({ url: target, name: String(name) })
  return { ok: Boolean(removed), name: String(name) }
}

/* ------------------------------------------------------------------ */
/* Commands from the app                                               */
/* ------------------------------------------------------------------ */

async function handle(message) {
  if (!message || typeof message !== 'object' || !message.id || !message.type) return
  try {
    await restoreActiveTabs()
    const blockedUntil = stoppedUntil.get(message.sessionId) ?? 0
    if (blockedUntil > Date.now() && message.type !== 'tabs_open' && message.type !== 'tabs_list') {
      throw new Error('o usuário pressionou Parar no Chrome; aguarde uma nova instrução antes de agir nesta aba')
    }
    let result
    if (message.type === 'tabs_open') {
      if (message.sessionId) {
        try { await claimedTab(message.sessionId); result = true } catch { result = false }
      }
    } else if (message.type === 'open') {
      let tab
      try { tab = await claimedTab(message.sessionId) } catch { tab = null }
      if (tab && !message.newTab) {
        await chrome.tabs.update(tab.id, { url: message.url, active: true })
        await settle(tab.id, { expectNavigation: true, initialUrl: tab.url })
      } else {
        result = await createTab(message)
        await settle(result)
      }
    } else if (message.type === 'new_tab') {
      result = await createTab(message)
      if (message.url) await settle(result)
    } else if (message.type === 'claim_tab') {
      result = await claimExistingTab(message)
    } else if (message.type === 'navigate') {
      const tab = await claimedTab(message.sessionId)
      await chrome.tabs.update(tab.id, { url: message.url, active: true })
      await settle(tab.id, { expectNavigation: true, initialUrl: tab.url })
    } else if (message.type === 'snapshot') {
      const claimed = await claimedTab(message.sessionId)
      const tab = (await settle(claimed.id)) ?? claimed
      const width = tab.width || 1280
      const height = tab.height || 720
      let tree
      if (unscriptable(tab.url)) {
        tree = `(a página ${tab.url || '(vazia)'} não pode ser lida pela extensão; navegue para um site com browser_navigate)`
      } else {
        tree = String((await execute(tab.id, openclodPageTool, ['snapshot', { maxChars: Number(message.maxChars) || 18000 }])) || '')
      }
      result = {
        url: tab.url || '',
        title: tab.title || '',
        tree,
        // Reading also shows the agent pointer on the page (top-center area).
        cursor: await screenPointFor(tab, { x: width / 2, y: Math.min(220, height / 3) })
      }
    } else if (message.type === 'read_text') {
      const tab = await claimedTab(message.sessionId)
      if (unscriptable(tab.url)) throw new Error(`a página ${tab.url || '(vazia)'} não pode ser lida pela extensão; navegue para um site com browser_navigate`)
      if (message.html) {
        result = await execute(tab.id, openclodReadHtml, [message.selector || '', Number(message.maxChars) || 30000])
      } else {
        result = await execute(
          tab.id,
          (selector, max) => ((selector ? document.querySelector(selector)?.innerText : document.body?.innerText) || '').slice(0, max),
          [message.selector || '', Number(message.maxChars) || 25000]
        )
      }
    } else if (message.type === 'click') {
      const tab = await claimedTab(message.sessionId)
      const target = message.target || {}
      const since = Date.now()
      const clicked = await actOnElement(tab.id, 'click', target)
      // A click on a link or a submit button navigates a moment later: wait for the new page before answering.
      const after = (await settle(tab.id, { expectNavigation: true, timeoutMs: 12000, initialUrl: tab.url })) ?? tab
      const openedTab = await followOpenedTab(tab, message.sessionId, message.groupName, since)
      result = {
        url: after.url ?? clicked?.url ?? tab.url ?? '',
        cursor: await screenPointFor(tab, clicked?.point),
        ...(typeof clicked?.matches === 'number' ? { matches: clicked.matches } : {}),
        ...(openedTab ? { openedTab } : {})
      }
    } else if (message.type === 'type') {
      const tab = await claimedTab(message.sessionId)
      const target = message.target || {}
      const since = Date.now()
      const typed = await actOnElement(tab.id, 'type', { ...target, value: message.value, submit: message.submit })
      if (message.submit) {
        await settle(tab.id, { expectNavigation: true, timeoutMs: 12000, initialUrl: tab.url })
        await followOpenedTab(tab, message.sessionId, message.groupName, since)
      }
      result = { cursor: await screenPointFor(tab, typed?.point) }
    } else if (message.type === 'press') {
      const tab = await claimedTab(message.sessionId)
      await execute(tab.id, openclodPageTool, ['press', { key: message.key }])
      if (/enter/i.test(String(message.key))) await settle(tab.id, { expectNavigation: true, timeoutMs: 12000, initialUrl: tab.url })
      else await sleep(250)
    } else if (message.type === 'screenshot') {
      const claimed = await claimedTab(message.sessionId)
      const tab = (await settle(claimed.id)) ?? claimed
      // The glow and the Stop pill must not appear in what the model "sees".
      await inject(tab.id, openclodIndicator, ['conceal']).catch(() => undefined)
      let shot
      try {
        shot = await capture(tab, { format: message.format, quality: message.quality, maxWidth: Number(message.maxWidth) || 0 })
      } finally {
        await inject(tab.id, openclodIndicator, ['reveal']).catch(() => undefined)
      }
      const width = tab.width || 0
      const height = tab.height || 0
      result = {
        ...shot,
        url: tab.url || '',
        title: tab.title || '',
        cursor: await screenPointFor(tab, { x: width / 2, y: Math.min(220, height / 3) })
      }
    } else if (message.type === 'console') {
      const tab = await claimedTab(message.sessionId)
      const read = await inject(tab.id, openclodConsoleRead, [message.clear !== false], 'MAIN')
      result = read || { installed: false, entries: [], errors: [] }
    } else if (message.type === 'network') {
      const tab = await claimedTab(message.sessionId)
      // fetch/XHR WITH bodies from the page, plus every request (navigation, resources) from webRequest.
      const read = await inject(tab.id, openclodNetworkRead, [message.clear === true], 'MAIN').catch(() => null)
      const all = netLog.get(tab.id) || []
      if (message.clear === true) netLog.set(tab.id, [])
      result = { installed: Boolean(read?.installed) || all.length > 0, requests: read?.requests || [], all }
    } else if (message.type === 'cookies_get') {
      const tab = await claimedTab(message.sessionId)
      result = await readCookies(tab, message.name)
    } else if (message.type === 'cookies_set') {
      const tab = await claimedTab(message.sessionId)
      result = await writeCookie(tab, message.cookie || {})
    } else if (message.type === 'cookies_remove') {
      const tab = await claimedTab(message.sessionId)
      result = await removeCookie(tab, message.name, message.url)
    } else if (message.type === 'wait_for') {
      const tab = await claimedTab(message.sessionId)
      await waitFor(tab.id, message.selector, Number(message.timeoutMs) || 15000)
    } else if (message.type === 'tabs_list') {
      const groupId = await findGroup(message.groupName)
      const tabs = groupId === undefined ? [] : await chrome.tabs.query({ groupId })
      const active = activeTabs.get(message.sessionId)
      result = tabs.filter((tab) => tab.id !== undefined).map((tab) => ({
        id: `chrome_${tab.id}`,
        title: tab.title || '',
        url: tab.url || '',
        active: tab.id === active
      }))
      setActiveTab(message.sessionId, active ?? tabs.find((tab) => tab.active)?.id)
    } else if (message.type === 'switch_tab') {
      // The tab travels as `tab`: `id` is the command id the answer must carry (sending the tab there made the
      // app wait 25 s for an answer that came back under another id).
      const tabId = Number(String(message.tab ?? '').replace(/^chrome_/, ''))
      const tab = await validTab(tabId)
      if (!tab) throw new Error(`aba não encontrada: ${message.tab}; use browser_tabs para ver os ids`)
      await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      setActiveTab(message.sessionId, tabId)
      void touchTab(tab, message.sessionId)
      await settle(tabId)
    } else if (message.type === 'reload') {
      // The app shipped a newer extension: reload from disk so the new code (this worker) takes over. The worker
      // dies here, so there is no result to post; the app re-handshakes with the reloaded extension.
      post({ id: message.id, type: 'result', result: true })
      setTimeout(() => chrome.runtime.reload(), 50)
      return
    } else if (message.type === 'close_tab') {
      const tab = message.tab
        ? await chrome.tabs.get(Number(String(message.tab).replace(/^chrome_/, '')))
        : await claimedTab(message.sessionId)
      await chrome.tabs.remove(tab.id)
      if (activeTabs.get(message.sessionId) === tab.id) forgetActiveTab(message.sessionId)
    } else {
      throw new Error(`comando desconhecido: ${message.type}`)
    }
    post({ id: message.id, type: 'result', result })
  } catch (error) {
    post({ id: message.id, type: 'result', error: error instanceof Error ? error.message : String(error) })
  }
}

/* ------------------------------------------------------------------ */
/* Popup, page button and keyboard shortcut                            */
/* ------------------------------------------------------------------ */

async function popupStatus() {
  await restoreActiveTabs()
  const tabs = []
  for (const [sessionId, tabId] of activeTabs) {
    const tab = await validTab(tabId)
    if (tab) tabs.push({ sessionId, tabId, windowId: tab.windowId, title: tab.title || '', url: tab.url || '' })
  }
  let fileAccess = true
  try {
    fileAccess = await chrome.extension.isAllowedFileSchemeAccess()
  } catch {
    /* unknown: do not nag */
  }
  return {
    version: chrome.runtime.getManifest().version,
    hostConnected: Boolean(nativePort),
    appConnected: appAlive(),
    appVersion,
    ackAgoMs: lastAckAt ? Date.now() - lastAckAt : null,
    working: workingTabIds().length,
    tabs,
    fileAccess
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  if (message.type === 'popup-status') {
    void popupStatus().then(sendResponse)
    return true
  }
  if (message.type === 'popup-stop') {
    void requestStop([]).then(() => sendResponse({ ok: true }))
    return true
  }
  if (message.type === 'popup-reconnect') {
    try { nativePort?.disconnect() } catch { /* already gone */ }
    nativePort = null
    lastAckAt = 0
    reconnectDelay = 1500
    connectNative()
    postHello()
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'popup-focus') {
    void (async () => {
      const tab = await validTab(message.tabId)
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
      }
      sendResponse({ ok: Boolean(tab) })
    })()
    return true
  }
  if (message.type === 'openclod-stop') {
    // The Stop button inside the page: stop whichever sessions own the sender's tab.
    void (async () => {
      await restoreActiveTabs()
      const tabId = sender.tab?.id
      const ids = [...activeTabs.entries()].filter(([, id]) => id === tabId).map(([sessionId]) => sessionId)
      await requestStop(ids.length ? ids : [])
      sendResponse({ ok: true })
    })()
    return true
  }
  return false
})

chrome.commands.onCommand.addListener((command) => {
  if (command === 'stop-agent') void requestStop([])
})

// Remember which tab opened which (a link with target=_blank, window.open, an OAuth popup): the action that caused
// it then hands the new tab to the agent, as a person would follow it.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return
  if (![...activeTabs.values()].includes(tab.openerTabId)) return
  openedBy.set(tab.openerTabId, { tabId: tab.id, at: Date.now() })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  let changed = false
  for (const [sessionId, active] of activeTabs) {
    if (active === tabId) {
      activeTabs.delete(sessionId)
      changed = true
    }
  }
  if (changed) void saveActiveTabs()
  if (touched.delete(tabId)) refreshBadge()
  netLog.delete(tabId)
})

// A navigation destroys the in-page indicator; put it back while the agent is still working on the tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  const entry = touched.get(tabId)
  if (!entry || Date.now() - entry.at >= INDICATOR_TTL_MS) return
  entry.shownAt = 0
  void touchTab(tab, entry.sessionId)
})

function ensureHeartbeat() {
  // MV3 may stop the worker after ~30 s idle. The alarm wakes it up and
  // reconnects the native host, so the app does not stay "disconnected".
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 })
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreActiveTabs()
  ensureHeartbeat()
  postHello()
})

chrome.runtime.onStartup.addListener(() => {
  void restoreActiveTabs()
  ensureHeartbeat()
  connectNative()
  postHello()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return
  void restoreActiveTabs()
  connectNative()
  postHello()
  refreshBadge()
})

ensureHeartbeat()
installWebRequest()
setInterval(() => post({ type: 'heartbeat' }), 10000)
setInterval(refreshBadge, 3000)
refreshBadge()
connectNative()
postHello()
