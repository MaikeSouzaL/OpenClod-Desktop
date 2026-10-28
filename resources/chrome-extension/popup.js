// Toolbar popup: shows whether the extension reaches the Openclod app and which tabs the agent is using.
const $ = (id) => document.getElementById(id)

function ago(ms) {
  if (ms == null) return 'nunca'
  const seconds = Math.round(ms / 1000)
  if (seconds < 5) return 'agora'
  if (seconds < 60) return `há ${seconds} s`
  return `há ${Math.round(seconds / 60)} min`
}

function hostOf(url) {
  try {
    return new URL(url).host || url
  } catch (_error) {
    return url || ''
  }
}

function render(state) {
  $('version').textContent = `extensão v${state.version}`
  const box = $('status')
  const active = state.working > 0
  let mode = 'disconnected'
  if (state.appConnected) mode = active ? 'active' : 'connected'
  else if (state.hostConnected) mode = 'connecting'
  box.dataset.state = mode

  if (mode === 'active') {
    $('status-title').textContent = `Agente trabalhando em ${state.working} aba${state.working === 1 ? '' : 's'}`
    $('status-detail').textContent = 'Você pode parar a qualquer momento.'
  } else if (mode === 'connected') {
    $('status-title').textContent = 'Conectado ao Openclod'
    $('status-detail').textContent = `Aplicativo respondeu ${ago(state.ackAgoMs)}. O agente usa este Chrome quando precisar.`
  } else if (mode === 'connecting') {
    $('status-title').textContent = 'Procurando o Openclod…'
    $('status-detail').textContent = 'A extensão está no ar, mas o aplicativo ainda não respondeu.'
  } else {
    $('status-title').textContent = 'Desconectado'
    $('status-detail').textContent = 'Não foi possível falar com o host nativo do Openclod.'
  }

  const hint = $('hint')
  hint.hidden = state.appConnected
  hint.textContent = state.hostConnected
    ? 'Abra o Openclod Desktop. Se ele já estiver aberto, aguarde alguns segundos ou clique em Reconectar.'
    : 'Abra o Openclod Desktop e use Configurações → Navegador → Instalar integração para registrar o host nativo.'

  const list = $('tabs')
  list.textContent = ''
  for (const tab of state.tabs) {
    const item = document.createElement('li')
    const name = document.createElement('div')
    name.className = 'name'
    const title = document.createElement('b')
    title.textContent = tab.title || hostOf(tab.url) || 'Aba'
    const site = document.createElement('span')
    site.textContent = hostOf(tab.url)
    name.append(title, site)
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = 'Ir'
    go.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'popup-focus', tabId: tab.tabId }))
    item.append(name, go)
    list.append(item)
  }
  $('tabs-empty').hidden = state.tabs.length > 0
  $('stop').disabled = state.tabs.length === 0
  $('files').hidden = state.fileAccess !== false
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'popup-status' }))
  } catch (_error) {
    $('status').dataset.state = 'disconnected'
    $('status-title').textContent = 'Extensão reiniciando…'
    $('status-detail').textContent = 'Abra o popup de novo em alguns segundos.'
  }
}

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true
  await chrome.runtime.sendMessage({ type: 'popup-stop' })
  refresh()
})
$('reconnect').addEventListener('click', async () => {
  $('reconnect').disabled = true
  await chrome.runtime.sendMessage({ type: 'popup-reconnect' })
  setTimeout(() => {
    $('reconnect').disabled = false
    refresh()
  }, 1200)
})
$('details').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }))

refresh()
setInterval(refresh, 1000)
