import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const extensionDir = path.join(repoRoot, 'resources', 'chrome-extension')
const hostBinary = path.join(repoRoot, 'resources', 'bin', 'openclod-chrome-host.exe')
const hostName = 'com.openclod.desktop'
const extensionId = 'iflajofnlenfolhiemmfbonmiinnookf'
const appData = process.env.APPDATA
if (!appData) throw new Error('APPDATA não definido')
if (!fs.existsSync(extensionDir)) throw new Error(`extensão ausente: ${extensionDir}`)
if (!fs.existsSync(hostBinary)) throw new Error(`host nativo ausente: ${hostBinary}`)

const manifestDir = path.join(appData, 'Openclod Desktop', 'NativeMessagingHosts')
const manifestPath = path.join(manifestDir, `${hostName}.json`)
fs.mkdirSync(manifestDir, { recursive: true })
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: hostName,
      description: 'Openclod Desktop Chrome bridge',
      path: hostBinary,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    },
    null,
    2
  )}\n`,
  'utf8'
)
execFileSync('reg.exe', [
  'ADD',
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
  '/ve',
  '/t',
  'REG_SZ',
  '/d',
  manifestPath,
  '/f'
], { stdio: 'pipe', windowsHide: true })

const shortcut = path.join(process.env.USERPROFILE || '', 'Desktop', 'Openclod - Carregar extensão no Chrome.lnk')
execFileSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  [
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut('${shortcut.replace(/'/g, "''")}')`,
    `$link.TargetPath = '${extensionDir.replace(/'/g, "''")}'`,
    '$link.WorkingDirectory = $link.TargetPath',
    "$link.Description = 'Pasta da extensão do Openclod; carregue-a em chrome://extensions com Desenvolvedor e Carregar sem compactação.'",
    '$link.Save()'
  ].join('; ')
], { stdio: 'pipe', windowsHide: true })

console.log(JSON.stringify({ installed: true, manifestPath, extensionDir, hostBinary, extensionId, shortcut }, null, 2))
