// Real run of the embedded llama.cpp, outside the window: the bundled llama-server, a real GGUF and a real chat through the
// OpenAI endpoint the `llamacpp` provider uses. No Ollama runs — by default the model is the qwen3.5 GGUF (and its vision
// projector) that Ollama already downloaded, read straight from Ollama's blob folder.
//
//   npx tsx scripts/llamacpp-real.ts [--model <file.gguf>] [--mmproj <file.gguf>] [--ctx 8192]
//
// Needs the bundled server: node scripts/embed-llamacpp.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LlamaCppService } from '../src/main/llamacpp/service'
import type { ProviderConfig } from '../src/shared/types'

const arg = (name: string, fallback = ''): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

/** The biggest chat model and the projector in Ollama's blob folder (the layout `ollama pull qwen3.5` leaves). */
function ollamaDefaults(): { model?: string; mmproj?: string } {
  const blobs = path.join(os.homedir(), '.ollama', 'models', 'blobs')
  if (!fs.existsSync(blobs)) return {}
  const big = fs.readdirSync(blobs).map((name) => path.join(blobs, name)).filter((file) => fs.statSync(file).size > 50e6)
  big.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
  return { model: big[0], mmproj: big[1] }
}

async function main(): Promise<void> {
  const defaults = ollamaDefaults()
  const model = arg('model', defaults.model ?? '')
  const mmproj = arg('mmproj', defaults.mmproj ?? '')
  if (!model) throw new Error('nenhum modelo: passe --model <arquivo.gguf>')

  const state: { providers: ProviderConfig[] } = { providers: [] }
  const secrets: Record<string, string> = {}
  const settings = {
    get: () => state as never,
    update: async (patch: never) => Object.assign(state, patch) as never,
    setSecret: async (id: string, value: string) => void (secrets[id] = value),
    resolver: () => ({ get: (key: string) => secrets[key] })
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-llama-real-'))
  const checks: Array<{ ok: boolean; line: string }> = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    const line = `${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` -> ${detail}` : ''}`
    checks.push({ ok, line })
    console.log(line)
  }

  const service = new LlamaCppService({ settings, health: { clear: () => undefined } as never, userData, emitChanged: () => undefined })
  try {
    const status = service.status()
    check('build embutida encontrada', status.available, status.build?.label ?? status.reason)
    const profiled = await service.setProfile({ model, ...(mmproj ? { mmproj } : {}), ctxSize: Number(arg('ctx', '8192')) })
    check('modelo lido do cabeçalho', Boolean(profiled.model), `${profiled.model?.arch} ${profiled.model?.sizeLabel} ${profiled.model?.quant} ferramentas=${profiled.model?.tools} raciocínio=${profiled.model?.thinking}`)

    const started = Date.now()
    await service.start()
    while (Date.now() - started < 8 * 60_000) {
      const now = service.status()
      if (now.state === 'pronto' || now.state === 'erro') break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const ready = service.status()
    check(
      'servidor ficou pronto',
      ready.state === 'pronto',
      `${ready.state} em ${((Date.now() - started) / 1000).toFixed(1)} s · porta ${ready.port} · n_ctx ${ready.nCtx} · visão ${ready.vision}${ready.error ? ` · erro: ${ready.error}` : ''}`
    )
    check('o log diz as camadas na GPU e a placa', Boolean(ready.offload && ready.device), `${ready.offload || '?'} camadas · ${ready.device || '?'} · ${ready.deviceMiB ?? '?'} MiB previstos`)
    const provider = state.providers.find((item) => item.id === 'llamacpp')
    check('virou o provedor llamacpp', Boolean(provider), provider ? `${provider.baseUrl} · modelo ${provider.model} · contexto ${provider.contextWindow} · visão ${provider.supportsVision}` : '')
    if (!provider) return
    check('a chave foi para o cofre e não aparece no log', Boolean(secrets.llamacpp) && !service.log().lines.some((line) => line.includes(secrets.llamacpp)))

    const noKey = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    check('sem a chave o servidor recusa', noKey.status === 401, `HTTP ${noKey.status}`)

    const askedAt = Date.now()
    const reply = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.llamacpp}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Responda apenas com a palavra: FUNCIONOU' }],
        max_tokens: 20,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false }
      })
    })
    const body = (await reply.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = String(body.choices?.[0]?.message?.content ?? '').trim()
    check('chat de verdade pelo endpoint OpenAI', reply.ok && /FUNCIONOU/i.test(text), `HTTP ${reply.status} em ${Date.now() - askedAt} ms: "${text}"`)
    const speed = service.status().speed
    check('o log mostra a velocidade', speed.gen > 0, `${speed.gen} tok/s gerando · ${speed.prompt} tok/s no prompt`)
  } catch (err) {
    check('sem exceção', false, (err as Error).stack ?? String(err))
  } finally {
    await service.stop()
    check('parou', service.status().state === 'parado', service.status().state)
    const log = service.log(0)
    console.log(`\n--- últimas linhas do log (${log.seq} no total) ---\n${log.lines.slice(-6).join('\n')}`)
    fs.rmSync(userData, { recursive: true, force: true })
    const passed = checks.filter((item) => item.ok).length
    console.log(`\n${passed}/${checks.length} OK`)
    process.exitCode = passed === checks.length ? 0 : 1
  }
}

void main()
