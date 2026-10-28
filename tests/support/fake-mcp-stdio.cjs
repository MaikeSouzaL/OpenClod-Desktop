'use strict'
/**
 * Fake MCP server over stdio (newline-delimited JSON-RPC). Test double only.
 * Configure with the FAKE_MCP environment variable (JSON of createFakeMcp options) plus:
 *   hangOnStart       never answers anything (a server stuck at startup)
 *   hangIfFile        like hangOnStart, but only while this file exists when the process starts (a slow start that
 *                     works on the next attempt)
 *   exitAfterMs       exits with code 3 after this long (a server that dies)
 *   ignoreStdinClose  keeps running when stdin closes (forces the client to kill it)
 *   pidFile           writes the process id to this file
 *   stderrOnStart     writes this text to stderr at startup
 *   failIfFile        exits with code 5 at startup while this file exists
 */
const fs = require('node:fs')
const readline = require('node:readline')
const { createFakeMcp } = require('./fake-mcp-core.cjs')

const options = JSON.parse(process.env.FAKE_MCP || '{}')
const fake = createFakeMcp(options)

// A server that cannot come back: it exits at once while this file exists (reconnection tests).
if (options.failIfFile && fs.existsSync(options.failIfFile)) process.exit(5)
const hangNow = Boolean(options.hangOnStart) || Boolean(options.hangIfFile && fs.existsSync(options.hangIfFile))
if (options.pidFile) fs.writeFileSync(options.pidFile, String(process.pid))
if (options.stderrOnStart) process.stderr.write(options.stderrOnStart + '\n')
if (options.exitAfterMs) setTimeout(() => process.exit(3), options.exitAfterMs)

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

let serverRequestId = 0
const waiting = new Map()

const ctx = {
  notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
  sendRequest: (method, params) =>
    new Promise((resolve) => {
      const id = 'srv-' + ++serverRequestId
      waiting.set(id, resolve)
      send({ jsonrpc: '2.0', id, method, params })
    }),
  die: () => process.exit(4)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (hangNow) return
  // Response to a server -> client request.
  if (message && message.id !== undefined && message.method === undefined && waiting.has(message.id)) {
    const resolve = waiting.get(message.id)
    waiting.delete(message.id)
    resolve(message.result !== undefined ? message.result : { error: message.error })
    return
  }
  fake.handle(message, ctx).then((response) => {
    if (response) send(response)
  })
})

rl.on('close', () => {
  if (!options.ignoreStdinClose) process.exit(0)
})
if (options.ignoreStdinClose) setInterval(() => undefined, 1000)
