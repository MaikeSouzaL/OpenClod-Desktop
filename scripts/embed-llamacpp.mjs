#!/usr/bin/env node
/**
 * Bundles the official llama.cpp server (`llama-server`) that Openclod runs on this computer instead of Ollama, into
 * `resources/llamacpp/<tag>-vulkan/`. The Vulkan build runs on any GPU (NVIDIA, AMD, Intel) and on the CPU; CUDA builds
 * are downloaded later from the app (Configurações → Provedores → llama.cpp → Versões), never bundled.
 *
 * Only the files `llama-server` loads are kept: the release also ships llama-cli, llama-bench, the quantizer and other
 * tools. The archive is accepted only when its SHA-256 matches BOTH the digest pinned below AND the one GitHub publishes
 * for the asset, so a swapped release or a tampered mirror fails the build.
 *
 * Reproducible and idempotent, like embed-bin.mjs: nothing is rewritten when the files already match.
 *
 *   node scripts/embed-llamacpp.mjs                 # download the official zip from GitHub, verify, extract
 *   node scripts/embed-llamacpp.mjs --from <zip>    # an official zip already on disk (still verified)
 *   node scripts/embed-llamacpp.mjs --check         # verify the bundled files against their build manifest
 *   node scripts/embed-llamacpp.mjs --force         # rewrite even when the files match
 *
 * llama.cpp is MIT (github.com/ggml-org/llama.cpp). Its license is not inside the release zip, so it is written to
 * resources/licenses/llama.cpp/LICENSE; libomp's own license (LICENSE-LLVM-OpenMP) travels with the binaries.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TAG = 'b11972'
export const KIND = 'vulkan'
export const ASSET = `llama-${TAG}-bin-win-vulkan-x64.zip`
/** SHA-256 of the official asset, as published by GitHub for this release (checked again against the API on download). */
export const PINNED_SHA256 = '5f3fa9b3ec948e6cb1af3c8f1063fa39c79f58bb5dc9bb9dfb2db890d098508d'
const REPO = 'ggml-org/llama.cpp'
const RELEASE_URL = `https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`
const API_URL = `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`
const UA = 'openclod-embed-llamacpp'

export const BUILD_DIR = path.join(ROOT, 'resources', 'llamacpp', `${TAG}-${KIND}`)
const LICENSE_DIR = path.join(ROOT, 'resources', 'licenses', 'llama.cpp')
const MANIFEST = path.join(ROOT, 'resources', 'MANIFEST.json')
/** Written next to the binaries: the app reads it to name the build and `--check` verifies every file against it. */
export const BUILD_MANIFEST = 'openclod-build.json'

/**
 * The files `llama-server` needs from the release: the server and its DLLs, every ggml backend (Vulkan, the CPU variants,
 * RPC), the OpenMP runtime and the licenses. Anything else in the zip is another llama.cpp tool.
 */
export const SERVER_FILES = /^(llama-server\.exe|llama-server-impl\.dll|llama-common\.dll|llama\.dll|mtmd\.dll|ggml[\w.-]*\.dll|libomp\.dll|LICENSE[\w.-]*)$/i

const MIT = `MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * The server files of an official release zip, in name order. A zip with folders or odd names is refused: the official
 * archives are flat, so a path inside one means it is not the archive we pinned.
 */
export function serverFilesOf(zipBytes) {
  const entries = unzipSync(zipBytes, { filter: (file) => !file.name.endsWith('/') })
  const out = []
  for (const [name, data] of Object.entries(entries)) {
    if (/[\\/:]/.test(name) || name.startsWith('.')) throw new Error(`o pacote tem um arquivo fora do lugar (${name.slice(0, 80)})`)
    if (SERVER_FILES.test(name)) out.push({ name, data })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  if (!out.some((file) => file.name.toLowerCase() === 'llama-server.exe')) throw new Error('o pacote não tem o llama-server.exe')
  return out
}

async function publishedDigest() {
  const response = await fetch(API_URL, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`GitHub respondeu ${response.status} ao ler a release ${TAG}`)
  const release = await response.json()
  const asset = (release.assets ?? []).find((item) => item.name === ASSET)
  if (!asset) throw new Error(`a release ${TAG} não tem ${ASSET}`)
  const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')
  if (!match) throw new Error(`o GitHub não publicou o SHA-256 de ${ASSET}`)
  return match[1]
}

async function download() {
  console.error(`baixando ${RELEASE_URL}`)
  const response = await fetch(RELEASE_URL, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok) throw new Error(`download falhou: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function readBuildManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BUILD_DIR, BUILD_MANIFEST), 'utf8'))
  } catch {
    return null
  }
}

/** Every bundled file still matches its recorded hash (and nothing recorded is missing). */
function check() {
  const manifest = readBuildManifest()
  if (!manifest) {
    console.error(`sem ${BUILD_MANIFEST} em ${path.relative(ROOT, BUILD_DIR)}: rode node scripts/embed-llamacpp.mjs`)
    return false
  }
  let ok = true
  for (const file of manifest.files) {
    const target = path.join(BUILD_DIR, file.name)
    const actual = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : null
    if (actual !== file.sha256) {
      ok = false
      console.error(`  diferente: ${file.name}${actual ? '' : ' (faltando)'}`)
    }
  }
  console.error(ok ? `llama.cpp ${manifest.tag}-${manifest.kind}: ${manifest.files.length} arquivos conferem` : 'llama.cpp: os arquivos não conferem')
  return ok
}

function writeIfChanged(target, data, force) {
  if (!force && fs.existsSync(target) && sha256(fs.readFileSync(target)) === sha256(data)) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
  return true
}

function updateManifest(entry) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const entries = (manifest.entries ?? []).filter((item) => item.name !== entry.name)
  entries.push(entry)
  manifest.entries = entries
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '')
  if (args.includes('--check')) process.exit(check() ? 0 : 1)
  const force = args.includes('--force')

  const zip = option('--from') ? fs.readFileSync(path.resolve(option('--from'))) : await download()
  const actual = sha256(zip)
  if (actual !== PINNED_SHA256) throw new Error(`SHA-256 de ${ASSET} não confere com o fixado no script: ${actual}`)
  // A zip given with --from is still compared with what GitHub publishes when the network answers.
  try {
    const published = await publishedDigest()
    if (published !== actual) throw new Error(`SHA-256 de ${ASSET} diferente do publicado pelo GitHub (${published})`)
  } catch (err) {
    if (!option('--from')) throw err
    console.error(`aviso: não conferi com o GitHub (${err.message}); o SHA-256 fixado no script confere`)
  }

  const files = serverFilesOf(zip)
  let changed = 0
  // Files of an older bundle that this one does not have would be loaded by mistake: drop them.
  if (fs.existsSync(BUILD_DIR)) {
    const keep = new Set(files.map((file) => file.name).concat(BUILD_MANIFEST))
    for (const name of fs.readdirSync(BUILD_DIR)) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(BUILD_DIR, name), { force: true, recursive: true })
        changed++
      }
    }
  }
  for (const file of files) if (writeIfChanged(path.join(BUILD_DIR, file.name), file.data, force)) changed++
  const record = {
    tag: TAG,
    kind: KIND,
    asset: ASSET,
    assetSha256: actual,
    source: RELEASE_URL,
    files: files.map((file) => ({ name: file.name, size: file.data.length, sha256: sha256(file.data) }))
  }
  if (writeIfChanged(path.join(BUILD_DIR, BUILD_MANIFEST), Buffer.from(`${JSON.stringify(record, null, 2)}\n`), force)) changed++
  if (writeIfChanged(path.join(LICENSE_DIR, 'LICENSE'), Buffer.from(MIT), force)) changed++

  const size = files.reduce((total, file) => total + file.data.length, 0)
  updateManifest({
    name: 'llama.cpp (llama-server)',
    version: `${TAG}-${KIND}`,
    source: `${RELEASE_URL} (sha256 ${actual}, server files only: ${files.length} of the release)`,
    size,
    sha256: actual,
    license: 'MIT (libomp: Apache-2.0 WITH LLVM-exception, see LICENSE-LLVM-OpenMP)',
    path: `llamacpp/${TAG}-${KIND}`
  })
  console.error(`llama.cpp ${TAG}-${KIND}: ${files.length} arquivos, ${(size / 1e6).toFixed(1)} MB em ${path.relative(ROOT, BUILD_DIR)} (${changed} alterado(s))`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('ERRO', err.message)
    process.exit(1)
  })
}
