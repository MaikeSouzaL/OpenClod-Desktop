'use strict'
/**
 * Brain shared by the fake MCP servers used in the tests (stdio script and HTTP factory).
 * It speaks the MCP protocol (initialize with version negotiation, tools, resources, resource templates,
 * prompts, pagination, list_changed, progress, cancellation, elicitation, structured content, large output)
 * and nothing else: no network, no files, no real work. Test double only; never part of the app.
 *
 * createFakeMcp(options) -> { state, handle(message, ctx) }
 *   ctx.notify(method, params)           server -> client notification
 *   ctx.sendRequest(method, params)      server -> client request, resolves with the client's result
 *   handle() resolves with the JSON-RPC response object, or null when nothing must be answered
 */

const ALL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function objectSchema(properties, required) {
  return { type: 'object', properties: properties || {}, ...(required ? { required } : {}) }
}

/** The catalogue of tools the fake can serve; `options.only` picks a subset. */
function baseTools() {
  return [
    {
      name: 'echo',
      title: 'Echo',
      description: 'Devolve o texto recebido.',
      inputSchema: objectSchema({ text: { type: 'string' } }, ['text']),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'add',
      description: 'Soma dois números.',
      inputSchema: objectSchema({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
      outputSchema: objectSchema({ sum: { type: 'number' } }, ['sum']),
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    {
      name: 'create_issue',
      description: 'Cria um ticket.',
      inputSchema: objectSchema({ title: { type: 'string' }, priority: { type: 'integer' } }, ['title']),
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    {
      name: 'delete_issue',
      description: 'Apaga um ticket.',
      inputSchema: objectSchema({ key: { type: 'string' } }, ['key']),
      annotations: { destructiveHint: true }
    },
    { name: 'plain', description: 'Ferramenta sem anotações.', inputSchema: objectSchema({}) },
    {
      name: 'big_output',
      description: 'Devolve um texto grande (size caracteres).',
      inputSchema: objectSchema({ size: { type: 'integer' } }),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'structured',
      description: 'Devolve conteúdo estruturado e texto.',
      inputSchema: objectSchema({}),
      outputSchema: objectSchema({ temperature: { type: 'number' }, conditions: { type: 'string' } }),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'slow',
      description: 'Espera ms milissegundos antes de responder.',
      inputSchema: objectSchema({ ms: { type: 'integer' } }),
      annotations: { readOnlyHint: true }
    },
    {
      name: 'progress_tool',
      description: 'Envia notificações de progresso e termina.',
      inputSchema: objectSchema({ steps: { type: 'integer' } }),
      annotations: { readOnlyHint: true }
    },
    { name: 'grow', description: 'Cria a ferramenta late_tool e avisa list_changed.', inputSchema: objectSchema({}) },
    { name: 'die', description: 'Encerra o processo do servidor (stdio).', inputSchema: objectSchema({}) },
    {
      name: 'ask_user',
      description: 'Pede uma informação ao usuário por elicitation.',
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true }
    },
    { name: 'fail', description: 'Devolve isError.', inputSchema: objectSchema({}) },
    { name: 'rpc_fail', description: 'Devolve um erro JSON-RPC.', inputSchema: objectSchema({}) },
    { name: 'image', description: 'Devolve uma imagem.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true } },
    { name: 'link', description: 'Devolve um resource_link e um recurso embutido.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true } },
    {
      name: 'needs_human',
      description: 'Exige decisão humana a cada chamada.',
      inputSchema: objectSchema({}),
      _meta: { 'anthropic/requiresUserInteraction': true }
    },
    {
      name: 'union_tool',
      description: 'Schema com anyOf na raiz.',
      inputSchema: { anyOf: [objectSchema({ id: { type: 'string' } }, ['id']), objectSchema({ name: { type: 'string' } }, ['name'])] }
    },
    {
      name: 'bad schema!',
      description: 'Propriedade com nome inválido.',
      inputSchema: objectSchema({ 'campo inválido': { type: 'string' } })
    }
  ]
}

const DEFAULT_RESOURCES = [
  { uri: 'file:///projeto/README.md', name: 'README', description: 'Documento principal', mimeType: 'text/markdown' },
  { uri: 'db://tarefas', name: 'Tarefas', mimeType: 'application/json' },
  { uri: 'db://clientes', name: 'Clientes' }
]

const DEFAULT_TEMPLATES = [
  { uriTemplate: 'issue://{key}', name: 'Ticket', description: 'Um ticket pelo código', mimeType: 'application/json' }
]

const DEFAULT_PROMPTS = [
  {
    name: 'revisar',
    description: 'Revisa um arquivo',
    arguments: [{ name: 'arquivo', description: 'Caminho', required: true }]
  },
  { name: 'resumo', description: 'Resume o projeto', arguments: [] }
]

function createFakeMcp(options) {
  const o = Object.assign(
    {
      name: 'fake',
      version: '1.0.0',
      versions: ALL_VERSIONS,
      /** tools/resources/prompts pagination: items per page (0 = single page) */
      pageSize: 0,
      /** extra generated tools bulk_1..bulk_N (read-only) */
      toolCount: 0,
      only: null,
      resources: true,
      prompts: true,
      listChanged: true,
      instructions: undefined,
      /** milliseconds to wait before answering initialize */
      initializeDelayMs: 0,
      /** milliseconds to wait before answering tools/list (a server with hundreds of tools, or a loaded machine) */
      toolsListDelayMs: 0,
      /** never answer initialize */
      hangOnInitialize: false,
      /** answer initialize with this JSON-RPC error */
      failInitialize: null,
      /** answer initialize with this protocol version regardless of the request */
      forceVersion: null,
      /** answer every tools/call with this isError text */
      alwaysError: null
    },
    options || {}
  )

  let tools = baseTools().filter((tool) => !o.only || o.only.includes(tool.name))
  for (let index = 1; index <= o.toolCount; index++) {
    tools.push({
      name: 'bulk_' + index,
      description: 'Ferramenta gerada ' + index + ' do servidor ' + o.name + '.',
      inputSchema: objectSchema({ q: { type: 'string' } }),
      annotations: { readOnlyHint: true }
    })
  }
  if (o.extraTools) tools = tools.concat(o.extraTools)

  const state = {
    /** every tools/call received: { name, args } */
    calls: [],
    /** request ids the client cancelled */
    cancelled: [],
    /** methods received, in order */
    methods: [],
    negotiated: null,
    initializedCount: 0,
    clientCapabilities: null,
    tools
  }

  function page(items, params, key) {
    const size = o.pageSize
    if (!size || items.length <= size) return { [key]: items }
    const start = params && params.cursor ? Number(String(params.cursor).replace('c', '')) : 0
    const slice = items.slice(start, start + size)
    const next = start + size
    return { [key]: slice, ...(next < items.length ? { nextCursor: 'c' + next } : {}) }
  }

  function capabilities() {
    if (o.capabilities) return o.capabilities
    const caps = { tools: o.listChanged ? { listChanged: true } : {}, logging: {} }
    if (o.resources) caps.resources = o.listChanged ? { listChanged: true } : {}
    if (o.prompts) caps.prompts = o.listChanged ? { listChanged: true } : {}
    return caps
  }

  async function callTool(message, ctx) {
    const params = message.params || {}
    const name = params.name
    const args = params.arguments || {}
    const meta = params._meta || {}
    state.calls.push({ name, args })
    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result })
    const text = (value, extra) => reply({ content: [{ type: 'text', text: value }], ...(extra || {}) })

    if (o.alwaysError) return text(o.alwaysError, { isError: true })
    if (!tools.some((tool) => tool.name === name)) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool: ' + name } }
    }

    switch (name) {
      case 'echo':
        return text('echo:' + String(args.text))
      case 'add': {
        const sum = Number(args.a) + Number(args.b)
        return text(JSON.stringify({ sum }), { structuredContent: { sum } })
      }
      case 'create_issue':
        return text('criado:' + String(args.title))
      case 'delete_issue':
        return text('apagado:' + String(args.key))
      case 'plain':
        return text('plain-ok')
      case 'needs_human':
        return text('humano-ok')
      case 'big_output':
        return text('x'.repeat(Number(args.size) || 1000))
      case 'structured':
        return text('{"temperature":22.5,"conditions":"nublado"}', {
          structuredContent: { temperature: 22.5, conditions: 'nublado' }
        })
      case 'slow': {
        await sleep(Number(args.ms) || 500)
        if (state.cancelled.includes(message.id)) return null
        return text('slow-done')
      }
      case 'progress_tool': {
        const steps = Number(args.steps) || 3
        for (let step = 1; step <= steps; step++) {
          await sleep(15)
          ctx.notify('notifications/progress', {
            progressToken: meta.progressToken,
            progress: step,
            total: steps,
            message: 'passo ' + step
          })
        }
        await sleep(15)
        return text('progress-done')
      }
      case 'grow': {
        if (!tools.some((tool) => tool.name === 'late_tool')) {
          tools.push({
            name: 'late_tool',
            description: 'Ferramenta que apareceu depois.',
            inputSchema: objectSchema({}),
            annotations: { readOnlyHint: true }
          })
        }
        ctx.notify('notifications/tools/list_changed', {})
        return text('grown')
      }
      case 'late_tool':
        return text('late-ok')
      case 'die':
        if (ctx.die) ctx.die()
        return null
      case 'ask_user': {
        const answer = await ctx.sendRequest('elicitation/create', {
          message: 'Qual projeto?',
          requestedSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', title: 'Projeto', enum: ['Alfa', 'Beta'] },
              urgent: { type: 'boolean', title: 'Urgente?' }
            },
            required: ['project']
          }
        })
        return text('elicit:' + JSON.stringify(answer))
      }
      case 'fail':
        return text('falhou de propósito', { isError: true })
      case 'rpc_fail':
        return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'erro do servidor' } }
      case 'image':
        return reply({ content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] })
      case 'link':
        return reply({
          content: [
            { type: 'resource_link', uri: 'file:///projeto/README.md', name: 'README', mimeType: 'text/markdown' },
            { type: 'resource', resource: { uri: 'db://tarefas', mimeType: 'application/json', text: '[1,2,3]' } },
            { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }
          ]
        })
      case 'union_tool':
        return text('union-ok')
      default:
        return text('called:' + name)
    }
  }

  async function handle(message, ctx) {
    if (!message || typeof message !== 'object') return null
    if (message.method) state.methods.push(message.method)

    // Notifications from the client.
    if (message.id === undefined || message.id === null) {
      if (message.method === 'notifications/cancelled' && message.params) state.cancelled.push(message.params.requestId)
      if (message.method === 'notifications/initialized') state.initializedCount++
      return null
    }

    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result })
    const params = message.params || {}

    switch (message.method) {
      case 'initialize': {
        if (o.hangOnInitialize) return null
        if (o.initializeDelayMs) await sleep(o.initializeDelayMs)
        if (o.failInitialize) return { jsonrpc: '2.0', id: message.id, error: o.failInitialize }
        const requested = params.protocolVersion
        const negotiated = o.forceVersion || (o.versions.includes(requested) ? requested : o.versions[0])
        state.negotiated = negotiated
        state.clientCapabilities = params.capabilities || {}
        return reply({
          protocolVersion: negotiated,
          capabilities: capabilities(),
          serverInfo: { name: o.name, version: o.version },
          ...(o.instructions ? { instructions: o.instructions } : {})
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        if (o.toolsListDelayMs) await sleep(o.toolsListDelayMs)
        return reply(page(tools, params, 'tools'))
      case 'tools/call':
        return callTool(message, ctx)
      case 'resources/list':
        return reply(page(o.resourcesList || DEFAULT_RESOURCES, params, 'resources'))
      case 'resources/templates/list':
        return reply(page(o.resourceTemplates || DEFAULT_TEMPLATES, params, 'resourceTemplates'))
      case 'resources/read': {
        const uri = params.uri
        if (uri === 'db://missing') return { jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Resource not found' } }
        if (uri === 'db://clientes') {
          return reply({ contents: [{ uri, mimeType: 'application/octet-stream', blob: 'aGVsbG8=' }] })
        }
        return reply({ contents: [{ uri, mimeType: 'text/plain', text: 'conteudo de ' + uri }] })
      }
      case 'prompts/list':
        return reply(page(o.promptsList || DEFAULT_PROMPTS, params, 'prompts'))
      case 'prompts/get': {
        const args = params.arguments || {}
        if (params.name === 'revisar' && !args.arquivo) {
          return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'arquivo é obrigatório' } }
        }
        return reply({
          description: 'Prompt ' + params.name,
          messages: [
            { role: 'user', content: { type: 'text', text: 'Revise ' + (args.arquivo || '(nada)') } },
            { role: 'assistant', content: { type: 'resource', resource: { uri: 'file:///guia.md', text: 'Guia' } } }
          ]
        })
      }
      default:
        return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } }
    }
  }

  return { state, handle, options: o }
}

module.exports = { createFakeMcp, ALL_VERSIONS }
