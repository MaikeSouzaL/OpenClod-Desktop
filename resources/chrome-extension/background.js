const HOST = 'com.openclod.desktop'
const activeTabs = new Map()
let nativePort = null

function connectNative() {
  if (nativePort) return nativePort
  nativePort = chrome.runtime.connectNative(HOST)
  nativePort.onMessage.addListener((message) => { void handle(message) })
  nativePort.onDisconnect.addListener(() => {
    nativePort = null
    setTimeout(connectNative, 1500)
  })
  return nativePort
}

function post(message) {
  try {
    connectNative().postMessage(message)
  } catch (error) {
    console.error('Openclod native bridge:', error)
  }
}

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
  try {
    const tab = await chrome.tabs.get(id)
    if (!tab) throw new Error('aba fechada')
    return tab
  } catch {
    activeTabs.delete(sessionId)
    throw new Error('a aba da sessão foi fechada')
  }
}

async function createTab({ sessionId, groupName, url }) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true })
  if (tab.id === undefined) throw new Error('o Chrome não devolveu o id da aba')
  activeTabs.set(sessionId, tab.id)
  await groupFor(tab.id, groupName)
  return tab.id
}

async function claimExistingTab({ sessionId, groupName, tabId, url }) {
  let tab
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    tab = await validTab(String(tabId).replace(/^chrome_/, ''))
    if (!tab) throw new Error('a aba informada não existe mais')
  } else {
    const all = await chrome.tabs.query({})
    const candidates = all.filter((candidate) => {
      if (candidate.id === undefined) return false
      if (url && candidate.url === url) return true
      return false
    })
    if (candidates.length !== 1) {
      throw new Error(candidates.length ? 'mais de uma aba corresponde à URL; informe tab_id' : 'aba existente não encontrada')
    }
    tab = candidates[0]
  }
  if (tab.id === undefined) throw new Error('o Chrome não devolveu o id da aba')
  activeTabs.set(sessionId, tab.id)
  await groupFor(tab.id, groupName)
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  return tab.id
}

async function execute(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  if (injection?.error) throw new Error(String(injection.error))
  return injection?.result
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

async function handle(message) {
  if (!message || typeof message !== 'object' || !message.id || !message.type) return
  try {
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
      } else {
        result = await createTab(message)
      }
    } else if (message.type === 'new_tab') {
      result = await createTab(message)
    } else if (message.type === 'claim_tab') {
      result = await claimExistingTab(message)
    } else if (message.type === 'navigate') {
      const tab = await claimedTab(message.sessionId)
      await chrome.tabs.update(tab.id, { url: message.url, active: true })
    } else if (message.type === 'snapshot') {
      const tab = await claimedTab(message.sessionId)
      const body = await execute(tab.id, (maxChars) => {
        const text = document.body?.innerText || ''
        return `${text.slice(0, maxChars)}${text.length > maxChars ? '\n…[snapshot truncado]' : ''}`
      }, [Number(message.maxChars) || 18000])
      result = { url: tab.url || '', title: tab.title || '', tree: String(body || '') }
    } else if (message.type === 'read_text') {
      const tab = await claimedTab(message.sessionId)
      result = await execute(tab.id, (selector) => ((selector ? document.querySelector(selector)?.innerText : document.body?.innerText) || '').slice(0, 25000), [message.selector])
    } else if (message.type === 'click') {
      const tab = await claimedTab(message.sessionId)
      const target = message.target || {}
      result = await execute(tab.id, (value) => {
        const nodes = [...document.querySelectorAll(value.selector || '*')]
        const name = (value.name || value.text || '').toLowerCase()
        const element = value.selector
          ? document.querySelector(value.selector)
          : nodes.find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase().includes(name))
        if (!(element instanceof HTMLElement)) throw new Error('elemento não encontrado')
        element.scrollIntoView({ block: 'center' })
        element.click()
        return location.href
      }, [target])
    } else if (message.type === 'type') {
      const tab = await claimedTab(message.sessionId)
      const target = message.target || {}
      await execute(tab.id, (value) => {
        const nodes = [...document.querySelectorAll(value.target.selector || 'input, textarea, [contenteditable="true"]')]
        const name = (value.target.name || value.target.text || '').toLowerCase()
        const element = value.target.selector
          ? document.querySelector(value.target.selector)
          : nodes.find((node) => (node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').toLowerCase().includes(name))
        if (!(element instanceof HTMLElement)) throw new Error('campo não encontrado')
        element.focus()
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = value.value
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          element.textContent = value.value
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value.value }))
        }
        if (value.submit) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      }, [{ target, value: message.value, submit: message.submit }])
    } else if (message.type === 'press') {
      const tab = await claimedTab(message.sessionId)
      await execute(tab.id, (key) => {
        const target = document.activeElement || document.body
        for (const type of ['keydown', 'keyup']) target?.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }))
      }, [message.key])
    } else if (message.type === 'screenshot') {
      const tab = await claimedTab(message.sessionId)
      const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      result = { base64: data.replace(/^data:image\/png;base64,/, ''), width: tab.width || 0, height: tab.height || 0 }
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
      activeTabs.set(message.sessionId, active ?? tabs.find((tab) => tab.active)?.id)
    } else if (message.type === 'switch_tab') {
      const tabId = Number(String(message.id).replace(/^chrome_/, ''))
      const tab = await chrome.tabs.get(tabId)
      await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      activeTabs.set(message.sessionId, tabId)
    } else if (message.type === 'close_tab') {
      const tab = message.id
        ? await chrome.tabs.get(Number(String(message.id).replace(/^chrome_/, '')))
        : await claimedTab(message.sessionId)
      await chrome.tabs.remove(tab.id)
      if (activeTabs.get(message.sessionId) === tab.id) activeTabs.delete(message.sessionId)
    } else {
      throw new Error(`comando desconhecido: ${message.type}`)
    }
    post({ id: message.id, type: 'result', result })
  } catch (error) {
    post({ id: message.id, type: 'result', error: error instanceof Error ? error.message : String(error) })
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, active] of activeTabs) if (active === tabId) activeTabs.delete(sessionId)
})

chrome.runtime.onInstalled.addListener(() => {
  post({ type: 'hello', browser: navigator.userAgent })
})

setInterval(() => post({ type: 'heartbeat' }), 10000)
connectNative()
