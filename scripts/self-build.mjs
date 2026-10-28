#!/usr/bin/env node
/**
 * Compila o harness em uma pasta staging e imprime o caminho no final:
 *   SELF_BUILD_STAGING=<...>/win-unpacked
 *
 * O processo principal mostra a mensagem de atualização, executa este script
 * e relança o app a partir do staging. O app.asar em execução nunca é
 * sobrescrito (evita o lock do Windows).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stagingRoot = path.join(root, `release-self-${Date.now().toString(36)}`)

function run(label, command, args) {
  console.log(`\n[ self-build ] ${label}`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} falhou (exit ${result.status ?? '?'})`)
}

try {
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error('package.json não encontrado')
  run('typecheck', 'npm', ['run', 'typecheck'])
  run('testes', 'npm', ['test'])
  run('build', 'npm', ['run', 'build'])
  run('empacotamento', 'npx', ['electron-builder', '--win', 'dir', '--config.directories.output=' + stagingRoot])
  const winUnpacked = path.join(stagingRoot, 'win-unpacked')
  if (!fs.existsSync(path.join(winUnpacked, 'Openclod Desktop.exe'))) {
    throw new Error('o pacote staging não foi gerado')
  }
  console.log(`\nSELF_BUILD_STAGING=${winUnpacked}`)
} catch (error) {
  console.error(`\nSELF_BUILD_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
