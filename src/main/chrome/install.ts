import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { resourcePath } from '../../core/util/resources.js'

export interface ChromeCompanionStatus {
  installed: boolean
  extensionPath: string
  hostPath: string
  manifestPath: string
  chromePath?: string
  detail: string
  extensionConnected?: boolean
}

const HOST_NAME = 'com.openclod.desktop'
const EXTENSION_ID = 'iflajofnlenfolhiemmfbonmiinnookf'
const EXTENSION_LINK_NAME = 'Openclod - Carregar extensão no Chrome.lnk'

/** Per-user registry key under HKCU; no administrator elevation is needed. */
function manifestPath(): string {
  return path.join(process.env.APPDATA || '', 'Openclod Desktop', 'NativeMessagingHosts', `${HOST_NAME}.json`)
}

function extensionPath(): string {
  return resourcePath('chrome-extension') ?? ''
}

function hostPath(): string {
  return resourcePath('bin', 'openclod-chrome-host.exe') ?? ''
}

function findChrome(): string | undefined {
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

export function chromeCompanionStatus(): ChromeCompanionStatus {
  const ext = extensionPath()
  const host = hostPath()
  const manifest = manifestPath()
  const chrome = findChrome()
  const installed = Boolean(ext && host && chrome && fs.existsSync(manifest))
  const registryRegistered = installed
  return {
    installed: registryRegistered,
    extensionPath: ext,
    hostPath: host,
    manifestPath: manifest,
    chromePath: chrome,
    detail: installed
      ? 'Host nativo e arquivos da extensão instalados. O Chrome exige a confirmação da extensão local na tela de extensões.'
      : !chrome
        ? 'Google Chrome não encontrado.'
        : !ext || !host
          ? 'Arquivos do companion ausentes no pacote.'
          : 'Companion ainda não instalado.'
  }
}

/** Writes the native-messaging manifest and registers it for the current Windows user. */
export async function installChromeCompanion(): Promise<ChromeCompanionStatus> {
  if (process.platform !== 'win32') throw new Error('a integração com Chrome existente está disponível no Windows')
  const status = chromeCompanionStatus()
  if (!status.chromePath) throw new Error(status.detail)
  if (!status.extensionPath || !status.hostPath) throw new Error(status.detail)

  const target = path.dirname(status.manifestPath)
  await fs.promises.mkdir(target, { recursive: true })
  const manifest = {
    name: HOST_NAME,
    description: 'Openclod Desktop Chrome bridge',
    path: status.hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  }
  await fs.promises.writeFile(status.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
  await new Promise<void>((resolve, reject) => {
    execFile('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', status.manifestPath, '/f'], { windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  await createExtensionShortcut(status)
  return chromeCompanionStatus()
}

/**
 * Chrome requires one browser-owned confirmation for an unpacked extension and
 * does not support silent enrollment. Leave a clearly named shortcut to the
 * exact folder so that this final confirmation needs no path pasting.
 */
async function createExtensionShortcut(status: ChromeCompanionStatus): Promise<void> {
  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop')
  if (!desktop || !status.extensionPath || !fs.existsSync(desktop)) return
  const shortcut = path.join(desktop, EXTENSION_LINK_NAME)
  const escapedShortcut = shortcut.replace(/'/g, "''")
  const escapedTarget = status.extensionPath.replace(/'/g, "''")
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut('${escapedShortcut}')`,
    `$link.TargetPath = '${escapedTarget}'`,
    "$link.WorkingDirectory = $link.TargetPath",
    "$link.Description = 'Pasta da extensão do Openclod; carregue-a em chrome://extensions com Desenvolvedor e Carregar sem compactação.'",
    '$link.Save()'
  ].join('; ')
  await new Promise<void>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => resolve())
  })
}

/**
 * Automates the final unpacked-extension enrollment through Computer Use.
 * Chrome does not publish a supported silent-install API for unpacked
 * extensions, so the one non-scriptable confirmation is performed in the
 * actual Chrome window instead of asking the user to repeat every step.
 */
export async function openChromeExtensions(): Promise<ChromeCompanionStatus> {
  const status = chromeCompanionStatus()
  if (!status.chromePath) throw new Error(status.detail)
  await createExtensionShortcut(status)
  const extensionUrl = 'chrome://extensions/'
  const escape = (value: string): string => value.replace(/'/g, "''")
  await new Promise<void>((resolve, reject) => {
    const command = [
      '$ErrorActionPreference = "Stop"',
      `$chrome = '${escape(status.chromePath!)}'`,
      `$url = '${escape(extensionUrl)}'`,
      '$existing = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
      'if ($existing) {',
      '  Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class OpenclodWin32 { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\'',
      '  [OpenclodWin32]::SetForegroundWindow($existing.MainWindowHandle) | Out-Null',
      '}',
      'Start-Process -FilePath $chrome -ArgumentList "--profile-directory=Default",$url -WindowStyle Hidden',
      'Write-Output "chrome-extension-page-opened"'
    ].join('\n')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 500)))
      else if (!String(stdout).includes('chrome-extension-page-opened')) reject(new Error('o Chrome não confirmou a abertura da página de extensões'))
      else resolve()
    })
  })
  return status
}
