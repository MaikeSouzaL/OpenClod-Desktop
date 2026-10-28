#!/usr/bin/env node
// Empacota scripts/mcp-connectors-test.ts com o esbuild (o nucleo MCP e puro; o Electron nao e carregado) e roda o
// resultado com os mesmos argumentos:  node scripts/mcp-connectors-test.cjs [--only a,b] [--skip-local] ...
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-connectors-bundle-'))
const bundle = path.join(outdir, 'mcp-connectors-test.cjs')
try {
  buildSync({
    entryPoints: [path.join(root, 'scripts', 'mcp-connectors-test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'error',
    // __dirname do script empacotado precisa apontar para a pasta scripts do projeto.
    define: { __dirname: JSON.stringify(path.join(root, 'scripts')) }
  })
  const run = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root })
  process.exitCode = run.status ?? 1
} finally {
  fs.rmSync(outdir, { recursive: true, force: true })
}
