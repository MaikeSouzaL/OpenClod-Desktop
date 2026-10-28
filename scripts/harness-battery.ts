/**
 * Live battery for the harness tools: runs the REAL tool implementations against
 * a throwaway workspace (no model involved) and prints a PASS/FAIL table.
 *
 *   npx esbuild scripts/harness-battery.ts --bundle --platform=node --format=cjs \
 *     --outfile=.qa/harness-battery.cjs --external:sharp --external:playwright \
 *     --external:@lydell/node-pty && node .qa/harness-battery.cjs [--net] [--ui]
 *
 *   --net  also exercises web tools (needs internet)
 *   --ui   also exercises browser (Playwright) and read-only Computer Use tools
 *
 * The tools are called directly, so permission gating (the runner's job) is NOT
 * part of this battery; that is covered by tests/security.test.ts and friends.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import sharp from 'sharp'
import { WorkspaceGuard } from '../src/core/security/policy'
import { FileTracker } from '../src/core/session/tracker'
import { BrowserLayer } from '../src/core/browser/layer'
import { ComputerLayer } from '../src/core/computer/layer'
import { SkillLibrary } from '../src/core/skills/library'
import { MemoryStore } from '../src/core/memory/store'
import { ProjectMemory } from '../src/core/memory/project'
import { fsTools } from '../src/core/tools/fs'
import { searchTools } from '../src/core/tools/search'
import { shellTools, killSessionProcesses } from '../src/core/tools/shell'
import { gitTools } from '../src/core/tools/git'
import { webTools } from '../src/core/tools/web'
import { browserTools } from '../src/core/tools/browser'
import { computerTools } from '../src/core/tools/computer'
import { planTools } from '../src/core/tools/plan'
import { limitationTools } from '../src/core/tools/limitations'
import { askTools } from '../src/core/tools/ask'
import { projectMemoryTools } from '../src/core/memory/tools'
import { codeIntelligenceTools } from '../src/core/tools/code-intelligence'
import { documentTools } from '../src/core/tools/documents'
import { imageTools } from '../src/core/tools/images'
import { mediaTools } from '../src/core/tools/media'
import { mcpTools } from '../src/core/tools/mcp'
import type { ToolContext, ToolDef } from '../src/core/tools/types'
import type { HarnessEvent, PolicyConfig, ToolResult } from '../src/shared/types'

const NET = process.argv.includes('--net')
const UI = process.argv.includes('--ui')
/** --desktop really drives the mouse/keyboard: it opens its OWN Notepad window on a temp file and never touches another window. */
const DESKTOP = process.argv.includes('--desktop')
const ROOT = path.join(__dirname, '..')
const CALL_TIMEOUT_MS = 90_000

const registry = new Map<string, ToolDef>()
for (const tool of [
  ...fsTools, ...searchTools, ...shellTools, ...gitTools, ...webTools, ...browserTools, ...computerTools,
  ...planTools, ...limitationTools, ...askTools, ...projectMemoryTools, ...codeIntelligenceTools,
  ...documentTools, ...imageTools, ...mediaTools, ...mcpTools
]) registry.set(tool.name, tool)

interface Row {
  group: string
  tool: string
  what: string
  pass: boolean
  skipped?: boolean
  ms: number
  detail: string
}
const rows: Row[] = []
let group = ''
let ctx: ToolContext
let work = ''

function oneLine(text: string, max = 150): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

async function call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const def = registry.get(tool)
  if (!def) return { ok: false, text: `ferramenta inexistente: ${tool}` }
  let timer: NodeJS.Timeout | undefined
  try {
    // A hung tool must show up as a FAIL, not stall the whole battery.
    return await Promise.race([
      def.execute(args, ctx),
      new Promise<ToolResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, text: `TIMEOUT: ${tool} não respondeu em ${CALL_TIMEOUT_MS / 1000}s` }), CALL_TIMEOUT_MS)
      })
    ])
  } catch (error) {
    return { ok: false, text: `EXCEÇÃO: ${(error as Error).message}` }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Runs one case. `expectOk=false` marks a negative test: the tool MUST refuse. */
async function t(
  tool: string,
  what: string,
  args: Record<string, unknown>,
  options: { expectOk?: boolean; check?: (r: ToolResult) => string | null; name?: string } = {}
): Promise<ToolResult> {
  const started = Date.now()
  const result = await call(options.name ?? tool, args)
  const expectOk = options.expectOk !== false
  let pass = result.ok === expectOk
  let detail = oneLine(result.text)
  if (pass && options.check) {
    const problem = options.check(result)
    if (problem) {
      pass = false
      detail = `${problem} | ${detail}`
    }
  }
  const row = { group, tool, what, pass, ms: Date.now() - started, detail }
  rows.push(row)
  if (!pass || row.ms > 5000) console.log(`${pass ? 'SLOW' : 'FAIL'}  ${group} · ${tool} · ${what} (${row.ms}ms) ${detail}`)
  return result
}

function skip(tool: string, what: string, why: string): void {
  rows.push({ group, tool, what, pass: true, skipped: true, ms: 0, detail: `PULADO: ${why}` })
}

function has(text: string): (r: ToolResult) => string | null {
  return (r) => (r.text.includes(text) ? null : `esperava conter "${text}"`)
}

async function main(): Promise<void> {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-battery-'))
  const project = path.join(work, 'projeto')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  const policy: PolicyConfig = {
    mode: 'auto', blockedCommands: [], allowedRoots: [], allowNetwork: true, allowComputerControl: false, shellTimeoutSec: 60
  }
  const events: HarnessEvent[] = []
  const memoryRoot = path.join(work, 'memoria')
  const projectMemory = new ProjectMemory(memoryRoot)
  await projectMemory.init()
  const computer = new ComputerLayer(path.join(ROOT, 'resources', 'bin', 'open-computer-use.exe'))
  const browser = new BrowserLayer({ sessionId: 'battery', mode: 'playwright' })
  let plan: unknown[] = []
  ctx = {
    sessionId: 'battery',
    cwd: project,
    mode: 'code',
    policy,
    workspace: new WorkspaceGuard([project]),
    signal: new AbortController().signal,
    tracker: new FileTracker(project),
    emit: (event: HarnessEvent) => { events.push(event) },
    approve: async () => true,
    setPlan: (items: unknown[]) => { plan = items },
    runSubagent: async () => ({ ok: false, text: 'não usado na bateria', sessionId: '' }),
    agents: { depth: 0, maxDepth: 3, callable: () => [], get: () => undefined },
    createAgent: async () => { throw new Error('não usado') },
    ask: async (request: { questions: Array<{ header: string }> }) => request.questions.map((question) => ({ header: question.header, answers: ['Sim'] })) as never,
    services: {
      browser,
      computer,
      skills: new SkillLibrary([{ dir: path.join(ROOT, 'resources', 'skills'), source: 'usuario' }]),
      memory: new MemoryStore(path.join(work, 'memory.json')),
      projectMemory
    },
    projectId: 'prj_battery',
    log: () => undefined
  } as unknown as ToolContext

  /* ------------------------------------------------------------------ */
  group = 'Arquivos'
  await t('write_file', 'cria src/a.ts', { path: 'src/a.ts', content: 'export const a = 1\nexport function soma(x: number, y: number) { return x + y }\n' })
  await t('write_file', 'cria src/b.ts (importa a)', { path: 'src/b.ts', content: "import { soma } from './a'\nexport const r = soma(1, 2)\n" })
  await t('write_file', 'cria notes.md', { path: 'notes.md', content: '# Notas\n\nlinha\n' })
  await t('write_file', 'cria subpasta nova', { path: 'deep/er/file.txt', content: 'x' })
  await t('write_file', 'recusa sair do workspace', { path: '../fora.txt', content: 'x' }, { expectOk: false })
  await t('read_file', 'lê arquivo inteiro', { path: 'src/a.ts' }, { check: has('soma') })
  await t('read_file', 'lê com offset/limit', { path: 'src/a.ts', offset: 2, limit: 1 }, { check: has('soma') })
  await t('read_file', 'arquivo inexistente falha', { path: 'nao-existe.ts' }, { expectOk: false })
  await t('read_file', 'recusa caminho fora', { path: '..\\..\\Windows\\win.ini' }, { expectOk: false })
  await t('list_dir', 'lista raiz com profundidade', { path: '.', depth: 2 }, { check: has('src') })
  await t('glob', 'acha **/*.ts', { pattern: '**/*.ts' }, { check: has('a.ts') })
  await t('grep', 'busca "soma"', { pattern: 'soma' }, { check: has('a.ts') })
  await t('grep', 'busca sem resultado não é erro', { pattern: 'inexistente_xyz' })
  await t('edit_file', 'troca trecho único', { path: 'src/a.ts', old_string: 'export const a = 1', new_string: 'export const a = 2' })
  await t('edit_file', 'falha se o trecho não existe', { path: 'src/a.ts', old_string: 'NAO EXISTE', new_string: 'x' }, { expectOk: false })
  await t('edit_file', 'falha se o trecho é ambíguo', { path: 'src/a.ts', old_string: 'number', new_string: 'string' }, { expectOk: false })
  await t('edit_file', 'replace_all resolve a ambiguidade', { path: 'src/a.ts', old_string: 'number', new_string: 'bigint', replace_all: true })
  await t('edit_file', 'recusa old_string igual a new_string', { path: 'src/a.ts', old_string: 'bigint', new_string: 'bigint', replace_all: true }, { expectOk: false })
  await t('patch_file', 'dry_run não grava', { path: 'notes.md', patch: '--- a/notes.md\n+++ b/notes.md\n@@ -1,3 +1,3 @@\n # Notas\n \n-linha\n+linha alterada\n', dry_run: true })
  const stillOld = fs.readFileSync(path.join(project, 'notes.md'), 'utf8').includes('linha alterada')
  rows.push({ group, tool: 'patch_file', what: 'dry_run realmente não alterou o disco', pass: !stillOld, ms: 0, detail: stillOld ? 'o dry_run gravou!' : 'ok' })
  await t('patch_file', 'aplica diff unificado', { path: 'notes.md', patch: '--- a/notes.md\n+++ b/notes.md\n@@ -1,3 +1,3 @@\n # Notas\n \n-linha\n+linha alterada\n' })
  await t('patch_file', 'recusa diff que não casa', { path: 'notes.md', patch: '--- a/notes.md\n+++ b/notes.md\n@@ -1,3 +1,3 @@\n # Xxxx\n \n-outra\n+coisa\n' }, { expectOk: false })
  await t('delete_path', 'apaga arquivo', { path: 'deep/er/file.txt' })
  await t('delete_path', 'apaga pasta recursivamente', { path: 'deep', recursive: true })
  await t('delete_path', 'recusa apagar fora do workspace', { path: '..', recursive: true }, { expectOk: false })

  /* ------------------------------------------------------------------ */
  group = 'Shell e processos'
  const isWin = process.platform === 'win32'
  await t('run_command', 'executa e captura saída', { command: 'node -e "console.log(6*7)"', description: 'conta' }, { check: has('42') })
  await t('run_command', 'exit code != 0 vira falha com o código', { command: 'node -e "process.exit(3)"', description: 'falha' }, { expectOk: false, check: has('3') })
  await t('run_command', 'timeout é aplicado', { command: 'node -e "setTimeout(()=>{},20000)"', description: 'timeout', timeout_ms: 1500 }, { expectOk: false })
  await t('run_command', 'cwd dentro do workspace', { command: isWin ? 'cd' : 'pwd', description: 'cwd', cwd: 'src' }, { check: has('src') })
  await t('run_command', 'stderr aparece', { command: 'node -e "console.error(\'oops\')"', description: 'stderr' }, { check: has('oops') })
  const started = await t('start_process', 'sobe servidor em segundo plano', {
    command: 'node -e "const s=require(\'http\').createServer((q,r)=>r.end(\'oi\')).listen(0,()=>console.log(\'PORTA \'+s.address().port))"',
    description: 'http', wait_ms: 1500
  }, { check: has('PORTA') })
  const pid = Number((started.data as { pid?: number } | undefined)?.pid ?? /pid[^0-9]*(\d+)/i.exec(started.text)?.[1])
  if (pid) {
    await t('list_processes', 'lista o processo iniciado', {}, { check: (r) => (r.text.includes(String(pid)) ? null : 'pid não listado') })
    await t('read_process_output', 'lê saída pelo pid', { pid, wait_ms: 200 }, { check: has('PORTA') })
    await t('list_ports', 'lista portas em escuta', {})
    await t('stop_process', 'encerra o processo', { pid })
    await t('read_process_output', 'após parar, informa encerrado', { pid, wait_ms: 200 }, { expectOk: true })
  } else {
    skip('read_process_output', 'ciclo do processo', `não consegui extrair o pid de: ${oneLine(started.text, 80)}`)
  }

  /* ------------------------------------------------------------------ */
  group = 'Git'
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: project, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'battery@example.com')
  git('config', 'user.name', 'Battery')
  await t('git_status', 'status lista os arquivos novos (um por linha, não só a pasta)', {}, { check: has('src/a.ts') })
  await t('git_commit', 'commit com add_all', { message: 'feat: inicial', add_all: true })
  await t('git_log', 'log mostra o commit', { limit: 5 }, { check: has('inicial') })
  fs.appendFileSync(path.join(project, 'src', 'a.ts'), 'export const extra = 1\n')
  await t('git_diff', 'diff do arquivo alterado', { path: 'src/a.ts' }, { check: has('extra') })
  await t('git_diff', 'diff --stat', { stat: true })
  await t('git_checkout', 'cria e troca de branch', { branch: 'feature/bateria', create: true })
  await t('git_commit', 'commita a alteração pendente na nova branch', { message: 'feat: extra', add_all: true })
  await t('git_commit', 'recusa commit sem mudanças', { message: 'vazio', add_all: true }, { expectOk: false })

  /* ------------------------------------------------------------------ */
  group = 'Inteligência de código e qualidade'
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node -e "console.log(\'ok\')"' } }))
  await t('code_intelligence', 'overview', { action: 'overview' }, { check: has('Arquivos-fonte') })
  await t('code_intelligence', 'symbols filtra por nome', { action: 'symbols', query: 'soma' }, { check: has('soma') })
  await t('code_intelligence', 'dependencies de src/b.ts', { action: 'dependencies', file: 'src/b.ts' }, { check: has('./a') })
  await t('code_intelligence', 'impact de src/a.ts', { action: 'impact', file: 'src/a.ts' })
  await t('code_intelligence', 'dependencies exige file', { action: 'dependencies' }, { expectOk: false })
  await t('quality_discover', 'descobre o script de teste', {}, { check: has('test') })
  await t('quality_run', 'executa o teste descoberto', { kind: 'test', timeout_ms: 60000 })

  /* ------------------------------------------------------------------ */
  group = 'Documentos, imagens e mídia'
  fs.writeFileSync(path.join(project, 'doc.md'), '# Titulo\n\nO openclod guarda memoria por projeto.\n\n## Outro\n\nTexto sobre agentes.\n')
  fs.writeFileSync(path.join(project, 'tabela.csv'), 'nome,valor\nalfa,1\nbeta,2\n')
  fs.writeFileSync(path.join(project, 'pagina.html'), '<html><body><h1>Ola</h1><p>Paragrafo de teste</p></body></html>')
  await t('document_extract', 'markdown com busca', { path: 'doc.md', query: 'memoria' }, { check: has('memoria') })
  await t('document_extract', 'csv', { path: 'tabela.csv' }, { check: has('alfa') })
  await t('document_extract', 'html', { path: 'pagina.html' }, { check: has('Paragrafo') })
  await t('document_extract', 'arquivo inexistente', { path: 'nada.pdf' }, { expectOk: false })
  const png = path.join(project, 'texto.png')
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><rect width="640" height="160" fill="white"/><text x="20" y="100" font-size="64" font-family="Arial" fill="black">Openclod 2026</text></svg>')).png().toFile(png)
  await t('image_inspect', 'dimensões e formato', { path: 'texto.png' }, { check: has('640') })
  await t('image_edit', 'redimensiona e converte para webp', { input: 'texto.png', output: 'menor.webp', width: 320, format: 'webp' })
  const webp = path.join(project, 'menor.webp')
  rows.push({ group, tool: 'image_edit', what: 'arquivo de saída existe', pass: fs.existsSync(webp), ms: 0, detail: fs.existsSync(webp) ? `${fs.statSync(webp).size} bytes` : 'sem arquivo' })
  await t('image_ocr', 'OCR nativo do Windows', { path: 'texto.png' }, { check: (r) => (/openclod/i.test(r.text) ? null : 'texto não reconhecido') })
  await t('image_generate', 'sem endpoint configurado deve falhar explicitamente', { prompt: 'gato', output: 'gato.png' }, { expectOk: false })
  if (isWin) {
    const wav = path.join(project, 'fala.wav')
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Volume=100; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.Speak('olá, este é um teste do harness'); $s.Dispose()`], { timeout: 60000 })
      await t('media_transcribe', 'transcreve WAV sintetizado', { path: 'fala.wav' }, { check: (r) => (/harness|teste/i.test(r.text) ? null : 'sem as palavras esperadas') })
    } catch (error) {
      skip('media_transcribe', 'transcrição', `não consegui sintetizar o WAV: ${(error as Error).message.slice(0, 80)}`)
    }
  }

  /* ------------------------------------------------------------------ */
  group = 'Plano, skills, memória e perguntas'
  await t('update_plan', 'grava plano', { items: [{ text: 'a', status: 'active' }, { text: 'b', status: 'pending' }] })
  rows.push({ group, tool: 'update_plan', what: 'plano chegou ao contexto', pass: plan.length === 2, ms: 0, detail: `${plan.length} itens` })
  await ctx.services.skills.reload()
  await t('list_skills', 'lista skills embutidas', {}, { check: has('svg-master') })
  await t('use_skill', 'carrega svg-master', { name: 'svg-master' })
  await t('use_skill', 'skill inexistente falha', { name: 'nao-existe' }, { expectOk: false })
  await t('memory_write', 'memória legada: grava', { text: 'o projeto usa pnpm', tags: ['build'] })
  await t('memory_search', 'memória legada: busca', { query: 'pnpm' }, { check: has('pnpm') })
  await t('memory_page', 'wiki: cria página', { action: 'write', title: 'Decisão de build', body: 'Usamos pnpm. Veja [[Convenções]].', tags: ['build'], memory_type: 'decision', confidence: 'observed' })
  await t('memory_page', 'wiki: lê página', { action: 'read', slug: 'decisao-de-build' }, { check: has('pnpm') })
  await t('memory_page', 'wiki: busca', { action: 'search', query: 'pnpm' }, { check: has('decisao-de-build') })
  await t('memory_page', 'wiki: write exige título e corpo', { action: 'write', title: 'sem corpo' }, { expectOk: false })
  await t('memory_brief', 'resumo do projeto', {})
  await t('memory_recall', 'recall sem sidecar responde sem quebrar', { query: 'pnpm' })
  await t('memory_handoff', 'cria handoff', { action: 'begin', summary: 'parei no passo 2', next: 'rodar testes', files: ['src/a.ts'], open_questions: ['usar pnpm?'] })
  await t('memory_handoff', 'lista handoffs', { action: 'list' }, { check: has('rodar testes') })
  await t('memory_handoff', 'handoff inexistente não pode ser aceito', { action: 'accept', id: 'nao-existe' }, { expectOk: false })
  await t('report_limitation', 'registra limitação', { title: 'Sem acesso ao banco', goal: 'migrar', error: 'ECONNREFUSED', difficulty: 'banco offline', suggestion: 'subir o banco', severity: 'degraded' })
  await t('ask_user', 'pergunta estruturada', { questions: [{ header: 'Rumo', question: 'Continuar com o plano?', options: [{ label: 'Sim' }, { label: 'Não' }] }] })
  await t('ask_user', 'menos de 2 opções é recusado', { questions: [{ header: 'Rumo', question: 'Continuar com o plano?', options: [{ label: 'Só uma' }] }] }, { expectOk: false })
  await t('mcp_servers', 'sem serviço MCP informa de forma explícita', {}, { expectOk: false })

  /* ------------------------------------------------------------------ */
  if (NET) {
    group = 'Web (rede)'
    await t('fetch_url', 'baixa example.com', { url: 'https://example.com', max_chars: 3000 }, { check: has('Example Domain') })
    await t('fetch_url', 'URL inválida falha', { url: 'not a url' }, { expectOk: false })
    await t('fetch_url', 'bloqueia endereço de rede local (SSRF)', { url: 'http://169.254.169.254/latest/meta-data/' }, { expectOk: false })
    await t('web_search', 'busca na web', { query: 'Model Context Protocol specification', limit: 5 })
    await t('download_file', 'baixa arquivo para o workspace', { url: 'https://example.com', path: 'baixado.html' })
    await t('web_research', 'pesquisa com URL fixa', { query: 'example domain', urls: ['https://example.com'], max_sources: 1 }, { check: has('Example') })
  } else {
    group = 'Web (rede)'
    skip('fetch_url', 'rede', 'rode com --net')
  }

  /* ------------------------------------------------------------------ */
  if (UI) {
    group = 'Navegador (Playwright)'
    const page = path.join(project, 'pagina-interativa.html')
    fs.writeFileSync(page, '<html><head><title>Bateria</title></head><body><h1 id="t">Olá</h1><input id="i" aria-label="Campo"><button id="b" onclick="document.getElementById(\'t\').textContent=\'Clicado: \'+document.getElementById(\'i\').value;console.log(\'clicou\')">Enviar</button></body></html>')
    const url = `file:///${page.replace(/\\/g, '/')}`
    await t('browser_open', 'abre página local', { url }, { check: has('Bateria') })
    await t('browser_snapshot', 'snapshot de acessibilidade', {}, { check: has('Enviar') })
    await t('browser_type', 'digita no campo', { role: 'textbox', name: 'Campo', value: 'abc' })
    await t('browser_click', 'clica no botão', { role: 'button', name: 'Enviar' })
    await t('browser_read', 'lê o resultado', { selector: '#t' }, { check: has('Clicado: abc') })
    await t('browser_console', 'captura console', {}, { check: has('clicou') })
    await t('browser_screenshot', 'screenshot', {})
    await t('browser_wait', 'espera seletor', { selector: '#t', timeout_ms: 2000 })
    await t('browser_new_tab', 'nova aba', { url })
    await t('browser_tabs', 'lista abas', {})
    await t('browser_close_tab', 'fecha aba', {})
    await t('browser_press', 'tecla', { key: 'Tab' })
    await t('browser_navigate', 'navega', { url })
    await browser.close().catch(() => undefined)

    group = 'Computer Use (somente leitura)'
    await t('computer_list_apps', 'lista apps', {})
    await t('computer_list_windows', 'lista janelas', {})
    await t('computer_cursor_position', 'posição do cursor', {})
    await t('computer_screenshot', 'captura de tela', { max_width: 800 })
    await t('computer_window_at', 'janela sob o ponto', { x: 100, y: 100 })
  } else {
    group = 'Navegador (Playwright)'
    skip('browser_open', 'navegador', 'rode com --ui')
    group = 'Computer Use (somente leitura)'
    skip('computer_list_apps', 'computer use', 'rode com --ui')
  }

  if (DESKTOP && process.platform === 'win32') {
    group = 'Computer Use (controla o computador)'
    const target = path.join(work, 'alvo-openclod.txt')
    // With the setting off the harness must refuse to touch the mouse/keyboard, whatever the model asks.
    await t('computer_type_text', 'recusa digitar quando o controle do computador está desligado', { text: 'x', app: 'notepad' }, { expectOk: false, check: has('desativado') })
    policy.allowComputerControl = true
    computer.configure({ allowControl: true })
    fs.writeFileSync(target, '')
    const notepad = spawn('notepad.exe', [target], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const found = await t('computer_wait_for_window', 'acha a janela do app aberto pela bateria', { title: 'alvo-openclod', timeout_s: 15 }, { check: has('alvo-openclod') })
      const windowId = (found.data as { id?: number } | undefined)?.id ?? Number(/"id":\s*(\d+)/.exec(found.text)?.[1])
      if (!windowId) {
        skip('computer_snapshot', 'ações no app', 'janela do Bloco de Notas não encontrada')
      } else {
        await t('computer_snapshot', 'lê a árvore de acessibilidade do app', { window: windowId, max_chars: 3000 }, { check: has('document') })
        await t('computer_type_text', 'digita texto com acentos no app', { window: windowId, text: 'Ola do Openclod: acentuacao e ç ã é!' }, { check: has('acentuacao') })
        await t('computer_press_key', 'Ctrl+S salva (atalho com modificador)', { window: windowId, key: 'ctrl+s' })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const saved = fs.readFileSync(target, 'utf8')
        rows.push({ group, tool: 'computer_press_key', what: 'o arquivo no disco tem o texto digitado', pass: saved === 'Ola do Openclod: acentuacao e ç ã é!', ms: 0, detail: JSON.stringify(saved) })
        await t('computer_screenshot', 'captura a tela depois da ação', { max_width: 800 })
      }
    } finally {
      notepad.kill()
    }
  } else {
    group = 'Computer Use (controla o computador)'
    skip('computer_type_text', 'ações no desktop', 'rode com --desktop (abre o próprio Bloco de Notas da bateria)')
  }

  killSessionProcesses('battery')
  /* ------------------------------------------------------------------ */
  const failed = rows.filter((row) => !row.pass)
  const skipped = rows.filter((row) => row.skipped)
  let last = ''
  for (const row of rows) {
    if (row.group !== last) {
      console.log(`\n== ${row.group}`)
      last = row.group
    }
    console.log(`${row.skipped ? 'SKIP' : row.pass ? 'PASS' : 'FAIL'}  ${row.tool.padEnd(20)} ${row.what.padEnd(52)} ${String(row.ms).padStart(5)}ms  ${row.pass && !row.skipped ? '' : row.detail}`)
  }
  console.log(`\nTOTAL ${rows.length} · aprovados ${rows.length - failed.length - skipped.length} · pulados ${skipped.length} · falhas ${failed.length}`)
  fs.writeFileSync(path.join(ROOT, 'tmp', 'harness-battery.json'), JSON.stringify(rows, null, 2))
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* handles may linger */ }
  // The computer-use backend is a long-lived child process; without closing it node never exits.
  await computer.close().catch(() => undefined)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 2
})
