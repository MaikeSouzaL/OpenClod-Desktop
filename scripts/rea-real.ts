/**
 * REA Engineering without the window: the REA bundled in resources/rea (scripts/embed-rea.mjs) started by the same
 * ReaLayer the app uses, and real analyses through the same rea_* tools the model calls.
 *
 *   npx tsx scripts/rea-real.ts             # status + JavaScript app + Windows executable (static readers)
 *   npx tsx scripts/rea-real.ts --ghidra    # also decompiles a function with Ghidra (minutes on the first import)
 *
 * The targets are made here (a tiny Electron-like JavaScript app) or copied from Windows itself (where.exe): no user data.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReaLayer } from '../src/core/rea/layer'
import { buildReaTools } from '../src/core/rea/tools'
import type { ToolContext, ToolDef } from '../src/core/tools/types'

const withGhidra = process.argv.includes('--ghidra')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-rea-real-'))
const layer = new ReaLayer({ tmpDir: path.join(work, 'tmp'), log: (message) => console.log(`  [layer] ${message}`) })
const tools = new Map<string, ToolDef>(buildReaTools(layer).map((tool) => [tool.name, tool]))
const ctx = { signal: new AbortController().signal, log: (level: string, text: string) => console.log(`  [${level}] ${text}`), progress: () => undefined } as unknown as ToolContext

let failures = 0
async function call(name: string, args: Record<string, unknown>, expect: (text: string) => boolean, label: string): Promise<string> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`ferramenta ${name} não registrada`)
  const started = Date.now()
  const result = await tool.execute(args, ctx)
  const ok = result.ok && expect(result.text)
  if (!ok) failures++
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label} (${name}, ${((Date.now() - started) / 1000).toFixed(1)} s, ${result.text.length} caracteres)`)
  if (!ok) console.log(result.text.slice(0, 1500))
  return result.text
}

function evidenceIds(text: string): string[] {
  return [...new Set(text.match(/ev_[0-9a-f]{16,}/g) ?? [])]
}

function makeJsApp(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-notes', version: '1.2.3', main: 'main.js' }, null, 2))
  fs.writeFileSync(
    path.join(dir, 'main.js'),
    [
      "const { app, BrowserWindow, ipcMain } = require('electron')",
      "const { searchNotes } = require('./src/search')",
      "ipcMain.handle('notes:search', async (_event, query) => searchNotes(query))",
      "app.whenReady().then(() => new BrowserWindow({ webPreferences: { preload: __dirname + '/preload.js' } }).loadFile('index.html'))",
      ''
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(dir, 'src', 'search.js'),
    [
      'const NOTES = [{ id: 1, title: "Compras", body: "pão e café" }, { id: 2, title: "Ideias", body: "busca rápida" }]',
      'function normalize(text) { return text.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase() }',
      'function searchNotes(query) {',
      '  const wanted = normalize(String(query))',
      '  return NOTES.filter((note) => normalize(note.title + " " + note.body).includes(wanted)).map((note) => note.id)',
      '}',
      'module.exports = { searchNotes, normalize }',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(dir, 'preload.js'), "require('electron').contextBridge.exposeInMainWorld('notes', { search: (q) => require('electron').ipcRenderer.invoke('notes:search', q) })\n")
}

async function main(): Promise<void> {
  console.log(`pasta de trabalho: ${work}`)
  const status = await call('rea_status', {}, (text) => /REA 6\.\d+\.\d+ embutido/.test(text), 'estado do REA e dos motores')
  console.log(status.split('\n').slice(0, 24).map((line) => `    ${line}`).join('\n'))

  const jsApp = path.join(work, 'demo-notes')
  makeJsApp(jsApp)
  const js = await call('rea_analyze_javascript_application', { input_path: jsApp }, (text) => /searchNotes|notes:search/.test(text), 'app JavaScript/Electron de teste')
  console.log(`    evidências: ${evidenceIds(js).slice(0, 3).join(', ') || '(nenhuma)'}`)
  console.log(`    trecho: ${js.replace(/\s+/g, ' ').slice(0, 400)}`)

  const exe = path.join(work, 'where.exe')
  fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), exe)
  const opened = await call('rea_open_binary', { path: exe }, (text) => /pe|PE|x86|amd64|x86-64|machine/i.test(text), 'executável do Windows (where.exe)')
  console.log(`    trecho: ${opened.replace(/\s+/g, ' ').slice(0, 300)}`)
  const imports = await call('rea_inspect_pe_imports', { path: exe }, (text) => /kernel32|KERNEL32|msvcrt|api-ms/i.test(text), 'importações do PE')
  console.log(`    trecho: ${imports.replace(/\s+/g, ' ').slice(0, 300)}`)
  await call('rea_inspect_pe_resources', { path: exe }, (text) => text.length > 0, 'recursos do PE')

  // A hand-made WebAssembly module (add(i32, i32) -> i32), read with the bundled WABT 1.0.42.
  const wasm = path.join(work, 'add.wasm')
  fs.writeFileSync(
    wasm,
    Buffer.from('0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b', 'hex')
  )
  await call('rea_inspect_wasm_artifact', { path: wasm }, (text) => /i32\.add|"add"|add/.test(text) && !/unavailable|not configured/i.test(text), 'WebAssembly com o WABT embutido')
  // Apktool launcher + JDK: REA's own probe runs the bundled apktool.cmd with the bundled Java.
  await call('rea_inspect_apktool_client', {}, (text) => /3\.0\.3/.test(text), 'Apktool + JDK embutidos')
  // A sample APK that ships with Android Studio, read by the bundled JADX (jadx-headless-mcp) on the bundled JDK.
  const sampleApk = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Android', 'Android Studio', 'plugins', 'android', 'resources', 'apks', 'ComplicationWatchFace.apk')
  if (fs.existsSync(sampleApk)) {
    const apk = path.join(work, 'sample.apk')
    fs.copyFileSync(sampleApk, apk)
    await call('rea_inspect_android_package', { path: apk }, (text) => /package|manifest|class/i.test(text) && !/jadx[^"]*(missing|unavailable|not configured)/i.test(text), 'APK de exemplo com o JADX embutido')
  } else {
    console.log('(sem o APK de exemplo do Android Studio: JADX não exercitado)')
  }

  if (withGhidra) {
    // The first procedure tool triggers Ghidra's import of the binary (minutes the first time).
    const procedures = await call('rea_list_procedures', { detail: 'complete' }, (text) => /0x[0-9a-f]+/i.test(text), 'procedimentos (Ghidra)')
    const address = /0x[0-9a-f]{6,}/i.exec(procedures)?.[0]
    if (address) await call('rea_procedure_pseudo_code', { procedure: address }, (text) => /\{|\(/.test(text), `pseudocódigo de ${address} (Ghidra)`)
    else failures++
  }
  await call('rea_close_binary', {}, () => true, 'fechar o binário')
}

main()
  .catch((err) => {
    failures++
    console.error('ERRO', (err as Error).message)
  })
  .finally(async () => {
    await layer.stop()
    fs.rmSync(work, { recursive: true, force: true })
    console.log(failures ? `${failures} falha(s)` : 'tudo certo')
    process.exit(failures ? 1 : 0)
  })
