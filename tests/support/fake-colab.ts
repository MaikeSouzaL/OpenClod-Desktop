import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for the notebook's server, for unit tests: it answers like the real one (resources/colab/openclod_llm_server.py)
 * and, on demand, like Cloudflare does when the tunnel or the notebook behind it is gone. The two "down" bodies are REAL
 * responses captured from a Cloudflare quick tunnel (tests/fixtures/colab/*.json), only anonymized.
 */
export type FakeColabMode = 'ok' | 'tunnel-down' | 'origin-down' | 'html-200' | 'engine-down' | 'hang'

export interface FakeColabOptions {
  key?: string
  model?: string
  vision?: boolean
  tools?: boolean
  context?: number
  gpu?: string
}

export interface FakeColab {
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string
  key: string
  model: string
  mode: FakeColabMode
  requests: Array<{ method: string; path: string; authorized: boolean }>
  close(): Promise<void>
}

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'colab')

export function fixture(name: 'cloudflare-502-origem-parada' | 'cloudflare-530-tunel-encerrado'): { status: number; body: string } {
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as { status: number; body: string }
  return { status: data.status, body: data.body }
}

export async function startFakeColab(options: FakeColabOptions = {}): Promise<FakeColab> {
  const key = options.key ?? 'occ_chave-do-teste-0123456789'
  const model = options.model ?? 'qwen3.5:9b-q8_0'
  const state = { mode: 'ok' as FakeColabMode }
  const requests: FakeColab['requests'] = []
  const sockets = new Set<import('node:net').Socket>()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const authorized = req.headers.authorization === `Bearer ${key}`
    requests.push({ method: req.method ?? 'GET', path: url.pathname, authorized })
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (state.mode === 'hang') return
      if (state.mode === 'tunnel-down' || state.mode === 'origin-down') {
        const page = fixture(state.mode === 'tunnel-down' ? 'cloudflare-530-tunel-encerrado' : 'cloudflare-502-origem-parada')
        res.writeHead(page.status, { 'content-type': 'text/html; charset=utf-8', server: 'cloudflare' })
        res.end(page.body)
        return
      }
      if (state.mode === 'html-200') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><html><body>Bem-vindo ao servidor de outra pessoa</body></html>')
        return
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"ok","service":"openclod-colab"}')
        return
      }
      if (!authorized) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"Chave de API ausente ou inválida.","type":"invalid_request_error","code":"invalid_api_key"}}')
        return
      }
      if (url.pathname === '/v1/models') {
        if (state.mode === 'engine-down') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"O motor (Ollama) não está respondendo no Colab.","type":"server_error","code":503}}')
          return
        }
        const vision = options.vision ?? true
        const tools = options.tools ?? true
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: model,
                object: 'model',
                owned_by: 'openclod-colab',
                context_length: options.context ?? 65536,
                architecture: { input_modalities: vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
                supported_parameters: tools ? ['temperature', 'tools', 'tool_choice'] : ['temperature'],
                openclod: { gpu: options.gpu ?? 'Tesla T4 (15 GB)', notebook: '1.0.0', engine: 'ollama' }
              }
            ]
          })
        )
        return
      }
      if (url.pathname === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"Rota inexistente."}}')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    baseUrl: `${origin}/v1`,
    key,
    model,
    requests,
    get mode() {
      return state.mode
    },
    set mode(value: FakeColabMode) {
      state.mode = value
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}
