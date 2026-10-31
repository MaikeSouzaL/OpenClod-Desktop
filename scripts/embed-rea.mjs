#!/usr/bin/env node
/**
 * Bundles REA (Reverse Engineer Anything, github.com/morluto/rea, MIT) into `resources/rea/`, so the "REA Engineering"
 * mode works without the user installing Node, REA or configuring an MCP server.
 *
 *   resources/rea/node/      official Node.js runtime REA 6.8 requires (^24.22.1; Electron 45 ships 24.22.0)
 *   resources/rea/app/       the official rea-agents package (dist, bridges, native Windows addon, skills, licenses)
 *                            + its production dependencies, installed from the lockfile of the vendored source
 *   resources/rea/engines/   the external engines REA drives (Ghidra, JDK, JADX, Apktool, WABT...), see ENGINES
 *   resources/rea/openclod-rea.json   versions, hashes and a digest of every tree (what --check verifies)
 *
 * The source of the same release lives in `vendor/rea/` (tag rea-agents-6.8.0); this script refuses to run when the two
 * disagree. Every download is accepted only when its hash matches the one pinned below. Archives already on disk (for
 * example the user's Desktop\REA\downloads) are reused with --cache when their hash matches.
 *
 *   node scripts/embed-rea.mjs                      # Node + REA + the default engines
 *   node scripts/embed-rea.mjs --only node,app      # just these parts (ids: node, app, and the ENGINES ids)
 *   node scripts/embed-rea.mjs --skip ghidra,jdk    # everything but these
 *   node scripts/embed-rea.mjs --cache "<a>;<b>"    # look for the pinned archives in these folders before downloading
 *   node scripts/embed-rea.mjs --check              # verify every bundled tree against openclod-rea.json
 *   node scripts/embed-rea.mjs --list               # print the parts and engines with versions and licenses
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REA_DIR = path.join(ROOT, 'resources', 'rea')
const VENDOR_DIR = path.join(ROOT, 'vendor', 'rea')
const LICENSE_DIR = path.join(ROOT, 'resources', 'licenses', 'rea')
const MANIFEST = path.join(ROOT, 'resources', 'MANIFEST.json')
export const STATE_FILE = 'openclod-rea.json'
const UA = 'openclod-embed-rea'

/** The REA release: the official npm tarball of the tag vendored in vendor/rea. */
export const REA = {
  version: '6.8.0',
  tag: 'rea-agents-6.8.0',
  commit: '160d821ac9a0310afcb8d1fc427862dd6508add5',
  tarball: 'https://registry.npmjs.org/rea-agents/-/rea-agents-6.8.0.tgz',
  file: 'rea-agents-6.8.0.tgz',
  integrity: 'sha512-9QDeRnGqEDzABZyr04eLnBXBv/c6I9/TWu/6M0MD4pEfkySI/BIgwTODIbAReX3C1x6hjw9+Jlx4A2yUSPZ9ww==',
  /** artifactSha256 of native/windows/build/manifest.json inside that tarball. */
  windowsAddonSha256: '6a015bfefee7fafb6cbafab659f040170848a45425bbcef6caf962fd39b6ff7b'
}

/** Node.js LTS that satisfies REA 6.8's engines (^22.23.4 || ^24.22.1 || >=26.12.1). */
export const NODE = {
  version: '24.22.2',
  file: 'node-v24.22.2-win-x64.zip',
  url: 'https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip',
  sha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
  shasums: 'https://nodejs.org/dist/v24.22.2/SHASUMS256.txt'
}

/** Batch launcher for Apktool: REA runs .cmd launchers as `cmd.exe /d /s /c`, so upstream's apktool.bat (it ends in `pause`) cannot be used. */
const APKTOOL_CMD = [
  '@echo off',
  'setlocal',
  'set "JAVA_EXE=java.exe"',
  'if defined JAVA_HOME set "JAVA_EXE=%JAVA_HOME%\\bin\\java.exe"',
  '"%JAVA_EXE%" -Xmx1024M -Duser.language=en -Dfile.encoding=UTF8 -Djdk.util.zip.disableZip64ExtraFieldValidation=true -Djdk.nio.zipfs.allowDotZipEntry=true -jar "%~dp0apktool_3.0.3.jar" %*',
  'exit /b %ERRORLEVEL%',
  ''
].join('\r\n')

/** The Visual C++ runtime the WABT and rizin builds load, taken from the embedded Python (python.org's official package). */
const VC_RUNTIME = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']

/**
 * External engines REA drives on Windows. Each one is unpacked to resources/rea/engines/<id>; `env` says which REA variable
 * the app points at it (path relative to the engine folder). Versions are the ones REA 6.8.0 verifies or pins (Ghidra
 * 12.1.x only, jadx-headless-mcp 0.7.1 by SHA-256, WABT exactly 1.0.42). `defaultOn: false` engines are fetched only when
 * named with --only.
 *
 * Not here on purpose:
 *   adb (Android platform-tools)   Google's SDK license (§3.4) forbids redistributing it: the app detects an installed SDK
 *   Wireshark (tshark, capinfos), GNU objdump   GPL builds that need 7-Zip to unpack; the app detects an installed copy
 *   Kuna, wakaru, binwalk, unblob, ghidra-nativeaot, pwntools, pwndbg   REA 6.8.0 refuses them on a Windows host
 *   IDA, JEB, Hopper               commercial; REA reaches a copy the user runs (REA_IDA_MCP_CONFIG, REA_JEB_MCP_URL)
 */
export const ENGINES = [
  {
    id: 'jdk',
    name: 'Eclipse Temurin JDK',
    version: '21.0.13+9',
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
    file: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
    sha256: 'a4dbaa05fca4bd89d84584e58c459bd732efebb1722af80ab13c6516832004f9',
    strip: 'jdk-21.0.13+9',
    env: { JAVA_HOME: '.' },
    requiredPaths: ['bin/java.exe', 'bin/javac.exe', 'release'],
    license: 'GPL-2.0-only WITH Classpath-exception-2.0',
    sourceUrl: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk-sources_21.0.13_9.tar.gz'
  },
  {
    id: 'ghidra',
    name: 'Ghidra',
    version: '12.1.4',
    url: 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip',
    file: 'ghidra_12.1.4_PUBLIC_20260921.zip',
    sha256: 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db',
    strip: 'ghidra_12.1.4_PUBLIC',
    env: { GHIDRA_INSTALL_DIR: '.' },
    requiredPaths: ['Ghidra/application.properties', 'support/analyzeHeadless.bat', 'support/launch.bat', 'Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe'],
    license: 'Apache-2.0 (GPL/ components ship with their source inside the release)'
  },
  {
    id: 'jadx',
    name: 'jadx-headless-mcp (JADX)',
    version: '0.7.1',
    url: 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar',
    file: 'jadx-headless-mcp-0.7.1-all.jar',
    sha256: '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75',
    archive: 'file',
    env: { REA_JADX_MCP_JAR: 'jadx-headless-mcp-0.7.1-all.jar' },
    requiredPaths: ['jadx-headless-mcp-0.7.1-all.jar'],
    license: 'Apache-2.0'
  },
  {
    id: 'apktool',
    name: 'Apktool',
    version: '3.0.3',
    url: 'https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar',
    file: 'apktool_3.0.3.jar',
    sha256: 'dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423',
    archive: 'file',
    extraFiles: { 'apktool.cmd': APKTOOL_CMD },
    env: { REA_APKTOOL_COMMAND: 'apktool.cmd' },
    requiredPaths: ['apktool_3.0.3.jar', 'apktool.cmd'],
    license: 'Apache-2.0'
  },
  {
    id: 'wabt',
    name: 'WABT',
    version: '1.0.42',
    url: 'https://github.com/WebAssembly/wabt/releases/download/1.0.42/wabt-1.0.42-windows-x64.tar.gz',
    file: 'wabt-1.0.42-windows-x64.tar.gz',
    sha256: '62f1eb2b51aa57cf0f0b8ba333bf2c72a049930aa9c5de01dcad271c4fe48c88',
    strip: 'wabt-1.0.42',
    vcRuntime: 'bin',
    env: { REA_WABT_BIN_DIRECTORY: 'bin' },
    requiredPaths: ['bin/wasm-validate.exe', 'bin/wasm-objdump.exe', 'bin/wasm2wat.exe'],
    license: 'Apache-2.0'
  },
  {
    id: 'rizin',
    name: 'rizin',
    version: '0.9.1',
    url: 'https://github.com/rizinorg/rizin/releases/download/v0.9.1/rizin-windows-shared64-v0.9.1.zip',
    file: 'rizin-windows-shared64-v0.9.1.zip',
    sha256: '45ffa004e26653eaee8d262b8e6eeae09402a7d319c1f20a2ba794bd6af1cc28',
    strip: 'rizin-win-installer-clang_cl-64',
    vcRuntime: 'bin',
    env: { REA_RIZIN_COMMAND: 'bin/rizin.exe' },
    requiredPaths: ['bin/rizin.exe'],
    license: 'LGPL-3.0-only (with GPL/BSD/MIT components)',
    sourceUrl: 'https://github.com/rizinorg/rizin/releases/download/v0.9.1/rizin-src-v0.9.1.tar.xz',
    // A GPL/LGPL binary in a public installer needs the matching source offer: opt-in only.
    defaultOn: false
  }
]

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const log = (text) => console.error(text)

async function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest(encoding)
}

async function download(url, dest) {
  log(`baixando ${url}`)
  const response = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`download falhou: HTTP ${response.status} em ${url}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest))
}

/** An archive already on disk with the right hash, or a fresh download checked against the same hash. */
async function fetchPinned({ url, file, check, cacheDirs, workDir }) {
  for (const dir of cacheDirs) {
    const candidate = path.join(dir, file)
    if (fs.existsSync(candidate) && (await check(candidate))) {
      log(`usando ${candidate} (hash confere)`)
      return candidate
    }
  }
  const target = path.join(workDir, file)
  await download(url, target)
  if (!(await check(target))) throw new Error(`hash de ${file} não confere com o fixado no script`)
  return target
}

/** Windows 10+ ships bsdtar, which unpacks .zip, .tgz and .tar.gz without loading them into memory. */
function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const result = spawnSync(tar, ['-xf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`não consegui extrair ${path.basename(archive)}: ${(result.stderr || result.error?.message || '').slice(0, 400)}`)
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.slice(0, 3).join(' ')} terminou com ${result.status ?? result.error?.message}`)
}

/** Files of a tree, sorted, with a digest over "path NUL sha256" lines: what --check recomputes. */
export async function treeDigest(dir) {
  const files = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  files.sort()
  const total = createHash('sha256')
  let size = 0
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/')
    total.update(`${rel}\u0000${await hashFile(file)}\n`)
    size += fs.statSync(file).size
  }
  return { files: files.length, size, digest: total.digest('hex') }
}

/** Replaces `dest` with `staged` only after the new tree is complete, so a failed run never leaves half a bundle. */
function swapIn(staged, dest) {
  const old = `${dest}.old-${process.pid}`
  if (fs.existsSync(dest)) fs.renameSync(dest, old)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(staged, dest)
  fs.rmSync(old, { recursive: true, force: true })
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REA_DIR, STATE_FILE), 'utf8'))
  } catch {
    return { version: 1, parts: {} }
  }
}

function writeState(state) {
  fs.mkdirSync(REA_DIR, { recursive: true })
  fs.writeFileSync(path.join(REA_DIR, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

function updateManifest(entry) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  manifest.entries = (manifest.entries ?? []).filter((item) => item.name !== entry.name).concat(entry)
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** vendor/rea must be the source of the very release this script bundles. */
function assertVendorMatches() {
  const pkg = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'package.json'), 'utf8'))
  if (pkg.version !== REA.version) throw new Error(`vendor/rea é a versão ${pkg.version}, o script embute ${REA.version}: atualize os dois juntos`)
  if (!fs.existsSync(path.join(VENDOR_DIR, 'package-lock.json'))) throw new Error('vendor/rea/package-lock.json não existe')
}

/* ------------------------------------------------------------------ */
/* Parts                                                               */
/* ------------------------------------------------------------------ */

async function embedNode(ctx) {
  const archive = await fetchPinned({
    url: NODE.url,
    file: NODE.file,
    check: async (file) => (await hashFile(file)) === NODE.sha256,
    cacheDirs: ctx.cacheDirs,
    workDir: ctx.workDir
  })
  // The pinned hash must also be the one nodejs.org publishes (skipped offline when the archive came from the cache).
  try {
    const response = await fetch(NODE.shasums, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) })
    const line = (await response.text()).split('\n').find((entry) => entry.trim().endsWith(`  ${NODE.file}`))
    if (!line?.startsWith(NODE.sha256)) throw new Error(`SHA-256 de ${NODE.file} diferente do SHASUMS256.txt oficial`)
  } catch (err) {
    if (/diferente/.test(err.message)) throw err
    log(`aviso: não conferi com o SHASUMS256.txt (${err.message}); o hash fixado no script confere`)
  }
  const unpacked = path.join(ctx.workDir, 'node-unpacked')
  extract(archive, unpacked)
  const root = path.join(unpacked, NODE.file.replace(/\.zip$/, ''))
  // npm stays in the work folder (only this script uses it); the bundle keeps the runtime and its license.
  ctx.npmCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ctx.nodeExe = path.join(root, 'node.exe')
  const staged = path.join(ctx.workDir, 'node-staged')
  fs.mkdirSync(staged, { recursive: true })
  for (const name of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(root, name), path.join(staged, name))
  swapIn(staged, path.join(REA_DIR, 'node'))
  ctx.state.parts.node = { version: NODE.version, source: NODE.url, sha256: NODE.sha256, license: 'MIT (and bundled component notices in LICENSE)', ...(await treeDigest(path.join(REA_DIR, 'node'))) }
  updateManifest({ name: 'Node.js (REA runtime)', version: NODE.version, source: NODE.url, sha256: NODE.sha256, license: 'MIT', path: 'rea/node' })
  log(`Node ${NODE.version}: resources/rea/node`)
}

/** npm of the pinned Node: from this run, or unpacked again from the cache when only `app` is rebuilt. */
async function ensureNpm(ctx) {
  if (ctx.npmCli) return
  const archive = await fetchPinned({ url: NODE.url, file: NODE.file, check: async (file) => (await hashFile(file)) === NODE.sha256, cacheDirs: ctx.cacheDirs, workDir: ctx.workDir })
  const unpacked = path.join(ctx.workDir, 'node-unpacked')
  extract(archive, unpacked)
  const root = path.join(unpacked, NODE.file.replace(/\.zip$/, ''))
  ctx.npmCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ctx.nodeExe = path.join(root, 'node.exe')
}

async function embedApp(ctx) {
  assertVendorMatches()
  await ensureNpm(ctx)
  const archive = await fetchPinned({
    url: REA.tarball,
    file: REA.file,
    check: async (file) => `sha512-${await hashFile(file, 'sha512', 'base64')}` === REA.integrity,
    cacheDirs: ctx.cacheDirs,
    workDir: ctx.workDir
  })
  const unpacked = path.join(ctx.workDir, 'app-unpacked')
  extract(archive, unpacked)
  const staged = path.join(unpacked, 'package')
  const pkg = JSON.parse(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'))
  if (pkg.name !== 'rea-agents' || pkg.version !== REA.version) throw new Error(`o pacote é ${pkg.name}@${pkg.version}, esperado rea-agents@${REA.version}`)
  const addon = path.join(staged, 'native', 'windows', 'build', 'rea-windows-x64.node')
  if ((await hashFile(addon)) !== REA.windowsAddonSha256) throw new Error('o componente nativo do Windows não confere com o manifesto da release')

  // Production dependencies exactly as the release's lockfile pins them. Lifecycle scripts stay off; only Frida's own
  // installer runs afterwards (it fetches the prebuilt binding of the pinned Frida release).
  fs.copyFileSync(path.join(VENDOR_DIR, 'package-lock.json'), path.join(staged, 'package-lock.json'))
  const env = { ...process.env, PATH: `${path.dirname(ctx.nodeExe)}${path.delimiter}${process.env.PATH ?? ''}`, npm_config_update_notifier: 'false' }
  run(ctx.nodeExe, [ctx.npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staged, env })
  run(ctx.nodeExe, [ctx.npmCli, 'rebuild', 'frida', '--ignore-scripts=false', '--no-audit', '--no-fund'], { cwd: staged, env })
  fs.rmSync(path.join(staged, 'package-lock.json'), { force: true })

  // Smoke test with the bundled runtime before the tree replaces the current one.
  const version = spawnSync(ctx.nodeExe, ['scripts/rea.mjs', '--version'], { cwd: staged, encoding: 'utf8', timeout: 120_000 })
  if (version.status !== 0 || !version.stdout.includes(REA.version)) {
    throw new Error(`o REA embutido não respondeu a --version: ${(version.stderr || version.stdout || '').slice(0, 400)}`)
  }
  const frida = spawnSync(ctx.nodeExe, ['-e', "require('frida'); console.log('ok')"], { cwd: staged, encoding: 'utf8', timeout: 60_000 })
  if (!frida.stdout?.includes('ok')) throw new Error(`o Frida não carregou: ${(frida.stderr || '').slice(0, 400)}`)

  swapIn(staged, path.join(REA_DIR, 'app'))
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'DISCLAIMER.md']) {
    fs.mkdirSync(LICENSE_DIR, { recursive: true })
    fs.copyFileSync(path.join(REA_DIR, 'app', name), path.join(LICENSE_DIR, name))
  }
  fs.cpSync(path.join(REA_DIR, 'app', 'licenses'), path.join(LICENSE_DIR, 'licenses'), { recursive: true })
  ctx.state.parts.app = {
    version: REA.version,
    tag: REA.tag,
    commit: REA.commit,
    source: REA.tarball,
    integrity: REA.integrity,
    license: 'MIT',
    ...(await treeDigest(path.join(REA_DIR, 'app')))
  }
  updateManifest({
    name: 'REA (rea-agents)',
    version: REA.version,
    source: `${REA.tarball} (${REA.integrity}); production dependencies from vendor/rea/package-lock.json (${REA.tag} @ ${REA.commit})`,
    license: 'MIT (Windows addon: GCC runtime under GPL-3.0 WITH GCC-exception-3.1; dependencies: see licenses/rea)',
    licensePath: 'licenses/rea/LICENSE',
    path: 'rea/app'
  })
  log(`REA ${REA.version}: resources/rea/app (${ctx.state.parts.app.files} arquivos, ${(ctx.state.parts.app.size / 1e6).toFixed(0)} MB)`)
}

/**
 * The tool catalog the app registers without starting REA: `tools/list` of the bundled server (compact input schemas, the
 * profile the app also runs with). The server is started with the bundled Node and stopped right after.
 */
export const CATALOG_FILE = 'catalog.json'
const SCHEMA_PROFILE = 'compact'

async function generateCatalog(ctx) {
  const appDir = path.join(REA_DIR, 'app')
  const nodeExe = path.join(REA_DIR, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!fs.existsSync(path.join(appDir, 'scripts', 'rea.mjs')) || !fs.existsSync(nodeExe)) throw new Error('catálogo: falta resources/rea/app ou resources/rea/node (rode com node,app)')
  const tmp = path.join(ctx.workDir, 'catalog-tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const { spawn } = await import('node:child_process')
  const child = spawn(nodeExe, [path.join(appDir, 'scripts', 'rea.mjs'), 'mcp'], {
    cwd: appDir,
    env: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: SCHEMA_PROFILE, TEMP: tmp, TMP: tmp },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  let stderr = ''
  const pending = new Map()
  child.stderr.on('data', (chunk) => (stderr = `${stderr}${chunk}`.slice(-4000)))
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined
      if (waiter) {
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      }
    }
  })
  let nextId = 1
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`${method} sem resposta em 120 s; stderr: ${stderr.slice(-600)}`)), 120_000)
      pending.set(id, { resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (err) => (clearTimeout(timer), reject(err)) })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openclod-embed-rea', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const tools = []
    let cursor
    do {
      const page = await request('tools/list', cursor ? { cursor } : {})
      tools.push(...(page.tools ?? []))
      cursor = page.nextCursor
    } while (cursor)
    const catalog = {
      version: REA.version,
      schemaProfile: SCHEMA_PROFILE,
      server: init.serverInfo ?? null,
      protocolVersion: init.protocolVersion,
      instructions: typeof init.instructions === 'string' ? init.instructions : '',
      tools: tools
        .map((tool) => ({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? { type: 'object' },
          annotations: tool.annotations ?? {}
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
    if (catalog.tools.length < 100) throw new Error(`o REA listou só ${catalog.tools.length} ferramentas`)
    fs.writeFileSync(path.join(REA_DIR, CATALOG_FILE), `${JSON.stringify(catalog)}\n`)
    ctx.state.catalog = { version: REA.version, tools: catalog.tools.length, schemaProfile: SCHEMA_PROFILE }
    log(`catálogo: ${catalog.tools.length} ferramentas em resources/rea/${CATALOG_FILE}`)
  } finally {
    child.kill()
  }
}

async function embedEngine(ctx, engine) {
  const archive = await fetchPinned({
    url: engine.url,
    file: engine.file,
    check: async (file) => (await hashFile(file)) === engine.sha256,
    cacheDirs: ctx.cacheDirs,
    workDir: ctx.workDir
  })
  const staged = path.join(ctx.workDir, `engine-${engine.id}`)
  fs.rmSync(staged, { recursive: true, force: true })
  if (engine.archive === 'file') {
    fs.mkdirSync(staged, { recursive: true })
    fs.copyFileSync(archive, path.join(staged, engine.file))
  } else {
    const unpacked = path.join(ctx.workDir, `engine-${engine.id}-unpacked`)
    extract(archive, unpacked)
    // `strip` is the single top folder of the archive (ghidra_12.1.4_PUBLIC, jdk-21.0.x+y...): the engine folder is its content.
    fs.renameSync(engine.strip ? path.join(unpacked, engine.strip) : unpacked, staged)
  }
  for (const [name, content] of Object.entries(engine.extraFiles ?? {})) fs.writeFileSync(path.join(staged, name), content)
  if (engine.vcRuntime) {
    for (const dll of VC_RUNTIME) {
      const from = path.join(ROOT, 'resources', 'runtime', 'python', dll)
      if (!fs.existsSync(from)) throw new Error(`${engine.id}: falta ${dll} em resources/runtime/python (rode o embed do Python antes)`)
      fs.copyFileSync(from, path.join(staged, engine.vcRuntime, dll))
    }
  }
  for (const required of engine.requiredPaths ?? []) {
    if (!fs.existsSync(path.join(staged, required))) throw new Error(`${engine.id}: falta ${required} depois de extrair`)
  }
  swapIn(staged, path.join(REA_DIR, 'engines', engine.id))
  ctx.state.parts[engine.id] = {
    version: engine.version,
    source: engine.url,
    sha256: engine.sha256,
    license: engine.license,
    env: engine.env,
    ...(await treeDigest(path.join(REA_DIR, 'engines', engine.id)))
  }
  updateManifest({
    name: `${engine.name} (REA engine)`,
    version: engine.version,
    source: engine.url,
    sha256: engine.sha256,
    license: engine.license,
    ...(engine.sourceUrl ? { sourceOffer: engine.sourceUrl } : {}),
    path: `rea/engines/${engine.id}`
  })
  log(`${engine.name} ${engine.version}: resources/rea/engines/${engine.id}`)
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function check() {
  const state = readState()
  const parts = Object.entries(state.parts ?? {})
  if (!parts.length) {
    log(`sem ${STATE_FILE} em resources/rea: rode node scripts/embed-rea.mjs`)
    return false
  }
  let ok = true
  for (const [id, part] of parts) {
    const dir = id === 'node' || id === 'app' ? path.join(REA_DIR, id) : path.join(REA_DIR, 'engines', id)
    const actual = fs.existsSync(dir) ? await treeDigest(dir) : null
    const same = actual?.digest === part.digest
    if (!same) ok = false
    log(`  ${same ? 'ok' : 'DIFERENTE'}  ${id} ${part.version}${actual ? ` (${actual.files} arquivos)` : ' (faltando)'}`)
  }
  return ok
}

function list() {
  log(`node   ${NODE.version}  MIT  ${NODE.url}`)
  log(`app    rea-agents ${REA.version}  MIT  ${REA.tarball}`)
  for (const engine of ENGINES) log(`${engine.id.padEnd(6)} ${engine.name} ${engine.version}  ${engine.license}${engine.defaultOn === false ? '  (só com --only)' : ''}`)
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : '')
  if (args.includes('--check')) process.exit((await check()) ? 0 : 1)
  if (args.includes('--list')) return list()
  const only = option('--only') ? new Set(option('--only').split(',').map((id) => id.trim())) : null
  const skip = new Set(option('--skip').split(',').map((id) => id.trim()).filter(Boolean))
  const wanted = (id, defaultOn = true) => (only ? only.has(id) : defaultOn) && !skip.has(id)
  if (only) {
    const known = new Set(['node', 'app', 'catalog', ...ENGINES.map((engine) => engine.id)])
    for (const id of only) if (!known.has(id)) throw new Error(`parte desconhecida: ${id} (veja --list)`)
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-embed-rea-'))
  // --cache accepts several folders separated by ";" (for example the REA workspace's downloads and tools folders).
  const cacheDirs = option('--cache') ? option('--cache').split(';').filter(Boolean).map((dir) => path.resolve(dir)) : []
  const ctx = { workDir, cacheDirs, state: readState() }
  try {
    if (wanted('node')) await embedNode(ctx)
    if (wanted('app')) await embedApp(ctx)
    if (wanted('app') || wanted('catalog', false)) await generateCatalog(ctx)
    for (const engine of ENGINES) if (wanted(engine.id, engine.defaultOn !== false)) await embedEngine(ctx, engine)
    ctx.state.version = 1
    ctx.state.generatedAt = new Date().toISOString()
    writeState(ctx.state)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('ERRO', err.message)
    process.exit(1)
  })
}
