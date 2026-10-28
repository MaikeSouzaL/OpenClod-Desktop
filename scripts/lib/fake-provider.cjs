// A local, made-up provider that speaks the OpenAI Chat Completions API (streaming) and fails on demand: 402 (no balance), 429
// (rate limit with a one-hour Retry-After), 401 (key refused), a cut stream, a context-window error, a dropped connection.
// It stands in for "the provider of the session ran out of credit" in the end-to-end runs; the OTHER side of every run is a REAL model.
// It never receives a real key: the app is given a made-up one for it, in a throwaway profile.
//
//   const { startFakeProvider } = require('./lib/fake-provider.cjs')
//   const fake = await startFakeProvider()      // { baseUrl, state, close() }
//   fake.state.mode = '402'                      // 'ok' | '402' | '429' | '401' | 'partial' | 'overflow' | 'refused'
//   fake.state.perModel['fake-b-1'] = '429'      // one model fails while the others follow `mode`
const http = require('node:http')

/** Models the fake lists on GET /v1/models, with the OpenRouter-style metadata that "Detectar modelos" reads. */
function fakeCatalog(count = 40) {
  const data = []
  for (let index = 0; index < count; index++) {
    const vision = index % 4 === 0
    data.push({
      id: `fake/modelo-${String(index).padStart(2, '0')}${vision ? '-visao' : ''}`,
      name: `Modelo falso ${index}`,
      context_length: vision ? 65536 : 32768,
      architecture: { input_modalities: vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'temperature']
    })
  }
  return data
}

function startFakeProvider({ catalog = fakeCatalog(), answer = 'ok, guardei.' } = {}) {
  // `perModel`: a model that fails differently from the rest, e.g. { 'fake-b-1': '429' } (the others follow `mode`).
  const state = { mode: 'ok', perModel: {}, answer, hits: [], listed: 0 }
  const server = http.createServer((req, res) => {
    const url = req.url || ''
    if (req.method === 'GET' && /\/models(\?|$)/.test(url)) {
      state.listed++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: catalog }))
      return
    }
    if (req.method === 'POST' && /\/chat\/completions(\?|$)/.test(url)) {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {
          /* not JSON: counted all the same */
        }
        state.hits.push({
          at: Date.now(),
          mode: state.perModel[body.model] ?? state.mode,
          model: body.model,
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          images: JSON.stringify(body.messages || []).includes('image_url'),
          authorized: Boolean(req.headers.authorization)
        })
        reply(res, req, state, state.perModel[body.model] ?? state.mode)
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        port,
        state,
        close: () => new Promise((done) => server.close(() => done())),
        /** Requests that arrived while the fake was in `mode` (all of them when omitted). */
        hits: (mode) => state.hits.filter((hit) => !mode || hit.mode === mode)
      })
    })
  })
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
  res.end()
}

function reply(res, req, state, mode) {
  switch (mode) {
    case '402':
      return json(res, 402, { error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } })
    case '429':
      return json(
        res,
        429,
        { error: { message: 'Rate limit reached for requests: too many requests per minute', type: 'requests', code: 'rate_limit_exceeded' } },
        { 'retry-after': '3600' }
      )
    case '401':
      return json(res, 401, { error: { message: 'Incorrect API key provided: sk-test-***', type: 'invalid_request_error', code: 'invalid_api_key' } })
    case 'overflow':
      return json(res, 400, {
        error: {
          message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 20000 tokens. Please reduce the length of the messages.",
          type: 'invalid_request_error',
          code: 'context_length_exceeded'
        }
      })
    case 'refused':
      req.socket.destroy()
      return undefined
    case 'partial': {
      // A real answer that starts and is cut in the middle by the provider.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'A capital da França é' }, finish_reason: null }] })}\n\n`)
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ error: { message: 'Rate limit exceeded: too many requests', code: 429, type: 'rate_limit_error' } })}\n\n`)
        res.end()
      }, 200)
      return undefined
    }
    default:
      return sse(res, [
        { id: 'fake-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: state.answer }, finish_reason: null }] },
        { id: 'fake-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
        '[DONE]'
      ])
  }
}

/**
 * A pass-through to the REAL local Ollama that only adds `reasoning_effort: "none"` to chat requests, so a 4B thinking model
 * answers in seconds instead of minutes. Everything else (the model, the answer, the tool calls, images) is real. It also
 * counts what went through, so a run can show which requests the real model received (for instance: no image bytes).
 */
function startOllamaProxy({ target = 'http://127.0.0.1:11434', extra = { reasoning_effort: 'none' } } = {}) {
  const hits = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      let body = Buffer.concat(chunks)
      let parsed = null
      if (req.method === 'POST' && /\/chat\/completions/.test(req.url || '')) {
        try {
          parsed = JSON.parse(body.toString('utf8'))
          const serialized = JSON.stringify(parsed.messages || [])
          hits.push({ at: Date.now(), model: parsed.model, messages: (parsed.messages || []).length, images: serialized.includes('image_url'), system: Boolean(parsed.messages?.some((m) => m.role === 'system')), serialized })
          body = Buffer.from(JSON.stringify({ ...parsed, ...extra }))
        } catch {
          /* forwarded untouched */
        }
      }
      try {
        const upstream = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] || 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
        })
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
        if (!upstream.body) return res.end()
        const reader = upstream.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
        }
        res.end()
      } catch (err) {
        // The client may have hung up (the app gave up on a slow request) after the headers were sent: just stop, a second
        // writeHead would throw and take the whole test process down.
        if (res.headersSent) return res.end()
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `proxy: ${err.message}` } }))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, port, hits, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

module.exports = { startFakeProvider, startOllamaProxy, fakeCatalog }
