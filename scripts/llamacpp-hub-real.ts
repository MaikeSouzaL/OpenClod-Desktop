// Real run of the llama.cpp "Baixar" list, outside the window: the Hugging Face list, this computer's GPU (from the
// bundled llama-server's --list-devices), the suggested quantization of each model, the real files of one repository and
// — with --download — a real download checked by SHA-256, cancelled halfway and resumed.
//
//   npx tsx scripts/llamacpp-hub-real.ts [--repo <autor/repo>] [--download]
//
// Needs the bundled server (node scripts/embed-llamacpp.mjs) and internet. Writes only to a temporary folder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LlamaHub } from '../src/main/llamacpp/hub'

const arg = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? '') : ''
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`

async function main(): Promise<void> {
  const exe = path.resolve('resources', 'llamacpp', 'b11972-vulkan', 'llama-server.exe')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-llama-hub-'))
  const checks: boolean[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push(ok)
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` -> ${detail}` : ''}`)
  }
  let downloaded: { model: string; mmproj?: string; label: string; alias: string } | null = null
  const hub = new LlamaHub({
    userData,
    exe: () => (fs.existsSync(exe) ? exe : null),
    ctx: () => 32_768,
    modelsDir: () => path.join(userData, 'models'),
    onDownloaded: async (result) => void (downloaded = result)
  })
  try {
    const started = Date.now()
    await hub.refresh()
    const list = await hub.list()
    check('lista do Hugging Face', list.state === 'pronto' && list.models.length > 50, `${list.models.length} modelos em ${((Date.now() - started) / 1000).toFixed(1)} s${list.error ? ` · ${list.error}` : ''}`)
    const budget = list.budget
    check('placa lida do llama-server', budget.vramMiB > 0, `${budget.gpu} · ${budget.vramMiB} MiB (usa ${budget.vramUseMiB}) · RAM ${budget.ramMiB} MiB (usa ${budget.ramUseMiB})`)
    const fits = { gpu: 0, misto: 0, cpu: 0, nao: 0 }
    for (const row of list.models) fits[row.fit]++
    check('cada modelo tem quantização e encaixe', list.models.every((row) => row.quant && row.bytes > 0), JSON.stringify(fits))
    console.log('\n  primeiros que cabem na GPU:')
    for (const row of list.models.filter((item) => item.fit === 'gpu').slice(0, 12)) {
      console.log(`   ${row.repo.padEnd(52)} ${String(row.params).padStart(6)}B ${row.arch.padEnd(10)} ${row.quant.padEnd(7)} ${gb(row.bytes)}${row.vision ? ' visão' : ''}${row.tools ? ' ferramentas' : ''}${row.sources > 1 ? ` (${row.sources} cópias)` : ''}`)
    }
    console.log('')

    const repo = arg('repo') || list.models.find((row) => row.fit === 'gpu' && !row.gated)?.repo || ''
    const files = await hub.files(repo)
    const suggested = files.files.find((file) => file.name === files.suggested)
    check('arquivos reais do repositório', files.files.length > 0 && Boolean(suggested?.sha256), `${repo}: ${files.files.length} arquivos · sugerido ${files.suggested} (${suggested ? gb(suggested.bytes) : '?'}, ${suggested?.fit})${files.mmproj ? ` · projetor ${files.mmproj.name}` : ''}`)

    const search = await hub.search('qwen3')
    check('busca livre', search.models.length > 0, `"qwen3" → ${search.models.length} modelos`)

    if (process.argv.includes('--download')) {
      // The smallest file of the list, so the test downloads little.
      const small = list.models.filter((row) => !row.gated && row.fit === 'gpu').sort((a, b) => a.bytes - b.bytes)[0]
      const target = await hub.files(small.repo)
      const file = [...target.files].sort((a, b) => a.bytes - b.bytes)[0]
      console.log(`  baixando ${small.repo}/${file.name} (${gb(file.bytes)}${target.mmproj ? ` + projetor ${gb(target.mmproj.bytes)}` : ''})`)
      hub.startDownload(small.repo, file.name)
      // Cancel at ~40% of the model, then resume from the .part.
      while (hub.downloadStatus().active && hub.downloadStatus().done < file.bytes * 0.4) await new Promise((resolve) => setTimeout(resolve, 200))
      hub.cancelDownload()
      while (hub.downloadStatus().active) await new Promise((resolve) => setTimeout(resolve, 100))
      const partial = hub.downloadStatus()
      check('cancelar guarda o que já veio', /cancelado/i.test(partial.error), `${gb(partial.done)} de ${gb(partial.total)} · "${partial.error}"`)
      hub.startDownload(small.repo, file.name)
      while (hub.downloadStatus().active) await new Promise((resolve) => setTimeout(resolve, 250))
      const done = hub.downloadStatus()
      check('retomou e conferiu o SHA-256', Boolean(done.finished) && !done.error, done.error || done.finished)
      check('o perfil recebe o modelo e o projetor', Boolean(downloaded), JSON.stringify(downloaded))
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
