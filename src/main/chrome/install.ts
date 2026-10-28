import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { resourcePath } from '../../core/util/resources.js'
import { extensionVersion, syncExtensionFiles, zipExtension } from './package.js'

export interface ChromeCompanionStatus {
  installed: boolean
  /** Folder the user loads in chrome://extensions (a stable per-user copy once installed). */
  extensionPath: string
  hostPath: string
  manifestPath: string
  chromePath?: string
  detail: string
  extensionConnected?: boolean
  extensionVersion?: string
  /** Version of the extension bundled with this app. */
  bundledVersion?: string
  /** True when Chrome runs an older extension than the one bundled: reload it in chrome://extensions. */
  extensionOutdated?: boolean
}

const HOST_NAME = 'com.openclod.desktop'
const EXTENSION_ID = 'iflajofnlenfolhiemmfbonmiinnookf'
const EXTENSION_LINK_NAME = 'Openclod - Carregar extensão no Chrome.lnk'

/** Chromium-based browsers read native-messaging hosts from their own per-user registry key; same extension id. */
const NATIVE_HOST_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`
]

/** Per-user registry keys under HKCU; no administrator elevation is needed. */
function manifestPath(): string {
  return path.join(process.env.APPDATA || '', 'Openclod Desktop', 'NativeMessagingHosts', `${HOST_NAME}.json`)
}

/** The extension that ships inside the app (read-only, moves with the install folder). */
function bundledExtensionPath(): string {
  return resourcePath('chrome-extension') ?? ''
}

/**
 * Chrome remembers an unpacked extension by its folder. The copy lives in the user's data folder so that
 * updating or moving the app never breaks the path Chrome has stored.
 */
export function stableExtensionPath(): string {
  return path.join(process.env.APPDATA || '', 'Openclod Desktop', 'chrome-extension')
}

function extensionPath(): string {
  return fs.existsSync(path.join(stableExtensionPath(), 'manifest.json')) ? stableExtensionPath() : bundledExtensionPath()
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

/** Refreshes the stable copy when the bundled extension changed (new app version). Never throws. */
export function syncStableExtension(): { updated: boolean; path: string } {
  const bundled = bundledExtensionPath()
  const stable = stableExtensionPath()
  if (!bundled || !fs.existsSync(path.join(bundled, 'manifest.json'))) return { updated: false, path: stable }
  if (!fs.existsSync(path.join(stable, 'manifest.json'))) return { updated: false, path: stable } // not installed yet
  try {
    const { copied, removed } = syncExtensionFiles(bundled, stable)
    return { updated: copied.length + removed.length > 0, path: stable }
  } catch {
    return { updated: false, path: stable }
  }
}

export function chromeCompanionStatus(): ChromeCompanionStatus {
  const ext = extensionPath()
  const host = hostPath()
  const manifest = manifestPath()
  const chrome = findChrome()
  const installed = Boolean(ext && host && chrome && fs.existsSync(manifest))
  return {
    installed,
    extensionPath: ext,
    hostPath: host,
    manifestPath: manifest,
    chromePath: chrome,
    bundledVersion: extensionVersion(bundledExtensionPath()),
    detail: installed
      ? 'Host nativo e arquivos da extensão instalados. O Chrome exige a confirmação da extensão local na tela de extensões.'
      : !chrome
        ? 'Google Chrome não encontrado.'
        : !ext || !host
          ? 'Arquivos do companion ausentes no pacote.'
          : 'Companion ainda não instalado.'
  }
}

/**
 * Copies the extension to its stable folder, writes the native-messaging manifest and registers it for the
 * current Windows user in every Chromium browser we know (Chrome, Edge, Brave, Chromium).
 */
export async function installChromeCompanion(): Promise<ChromeCompanionStatus> {
  if (process.platform !== 'win32') throw new Error('a integração com Chrome existente está disponível no Windows')
  const before = chromeCompanionStatus()
  if (!before.chromePath) throw new Error(before.detail)
  const bundled = bundledExtensionPath()
  if (!bundled || !before.hostPath) throw new Error(before.detail)

  syncExtensionFiles(bundled, stableExtensionPath())
  const status = chromeCompanionStatus()

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

  await Promise.all(
    NATIVE_HOST_KEYS.map(
      (key) =>
        new Promise<void>((resolve, reject) => {
          execFile('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', status.manifestPath, '/f'], { windowsHide: true }, (error) => {
            // Chrome's key is required; the others are a convenience for the user's other browsers.
            if (error && key === NATIVE_HOST_KEYS[0]) reject(error)
            else resolve()
          })
        })
    )
  )
  await createExtensionShortcut(status)
  return chromeCompanionStatus()
}

/** Writes `openclod-chrome-extension-v<version>.zip` (manifest at the root) and returns where. */
export function exportChromeExtension(destinationDir?: string): { path: string; bytes: number; files: number; version: string } {
  const source = extensionPath()
  if (!source) throw new Error('arquivos da extensão ausentes no pacote')
  const version = extensionVersion(source) ?? '0'
  const dir = destinationDir || path.join(process.env.USERPROFILE || '', 'Desktop')
  const result = zipExtension(source, path.join(dir, `openclod-chrome-extension-v${version}.zip`))
  return { ...result, version }
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
 * Opens chrome://extensions in the user's Chrome. Chrome does not publish a supported silent-install API for
 * unpacked extensions, so the one confirmation ("Load unpacked" and the folder) stays with the user; the
 * folder path is on the clipboard-friendly Settings card and in the desktop shortcut.
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
