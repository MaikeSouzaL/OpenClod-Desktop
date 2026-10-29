// Real run of llama.cpp → Versões, outside the window: this computer's NVIDIA card and the CUDA its driver runs, the
// newest official release on GitHub, and a real install (SHA-256 from GitHub, streaming unzip, only the server's files)
// that then runs `llama-server --version`. By default the small CPU build (~25 MB); `--kind cuda-12.4` downloads ~670 MB.
//
//   npx tsx scripts/llamacpp-builds-real.ts [--kind cpu|cuda-12.4|cuda-13.4|vulkan]
//
// Writes only to a temporary folder.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LlamaBuilds } from '../src/main/llamacpp/builds'
import type { BuildKind } from '../src/core/llamacpp/builds'

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

async function main(): Promise<void> {
  const kind = arg('kind', 'cpu') as BuildKind
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-llama-builds-'))
  const checks: boolean[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push(ok)
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` -> ${detail}` : ''}`)
  }
  const builds = new LlamaBuilds({ userData, bundledDir: () => path.resolve('resources', 'llamacpp', 'b11972-vulkan') })
  try {
    const machine = await builds.machine()
    check('placa e driver', true, machine.gpus.length ? `${machine.gpus[0].name} · driver ${machine.driver} · CUDA até ${machine.cudaMax} · sugerida ${machine.suggested}` : 'sem NVIDIA')
    check('cada tipo diz se roda', machine.kinds.length === 4, machine.kinds.map((item) => `${item.kind}=${item.runs ? 'roda' : 'não'}`).join(' '))
    const tag = await builds.newest(kind)
    check('versão mais nova no GitHub', /^b\d+$/.test(tag), tag)

    const started = Date.now()
    builds.start(kind, 'newest')
    let last = ''
    while (builds.status().active) {
      const now = builds.status()
      const line = `${now.file} ${Math.round(now.done / 1e6)}/${Math.round(now.total / 1e6)} MB`
      if (line !== last && Date.now() - started > 0) last = line
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const done = builds.status()
    check('baixou, conferiu e extraiu', Boolean(done.finished) && !done.error, done.error || `${done.finished} em ${((Date.now() - started) / 1000).toFixed(1)} s`)
    const installed = builds.list().find((build) => build.id === done.finished)
    check('aparece na lista', Boolean(installed), installed?.label ?? '')
    if (installed) {
      const files = fs.readdirSync(path.dirname(installed.exe))
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(installed.exe), 'openclod-build.json'), 'utf8')) as { assets: Array<{ sha256: string }>; files: unknown[] }
      check('só os arquivos do servidor + manifesto', files.includes('llama-server.exe') && !files.some((name) => /^llama-(cli|bench|quantize)\.exe$/i.test(name)), `${files.length} arquivos · ${manifest.assets.length} zip(s) conferidos`)
      // llama-server prints its version on stderr.
      const run = spawnSync(installed.exe, ['--version'], { cwd: path.dirname(installed.exe), encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() || '(vazio)'
      check('o llama-server instalado roda', /build/i.test(output), output.split('\n').slice(-2).join(' | '))
      builds.remove(installed.id)
      check('remover apaga a pasta', !fs.existsSync(path.dirname(installed.exe)))
    }
  } catch (err) {
    check('sem exceção', false, (err as Error).stack ?? String(err))
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
    const passed = checks.filter(Boolean).length
    console.log(`\n${passed}/${checks.length} OK`)
    process.exitCode = passed === checks.length ? 0 : 1
  }
}

void main()
