#!/usr/bin/env node
/**
 * Bundles the native helpers Openclod ships with into `resources/bin/`.
 *
 *   rg.exe                 ripgrep (Rust, MIT OR Unlicense) - copied, never built here
 *   open-computer-use.exe  open-computer-use Windows backend (Go, MIT) - built from
 *                          repositorios/open-computer-use/apps/OpenComputerUseWindows
 *
 * Reproducible and idempotent: running it twice leaves the files, licenses and
 * resources/MANIFEST.json untouched when nothing changed. The Go source clone is
 * never modified (the build runs in a temp copy). Nothing is taken from the
 * user's PATH at runtime; PATH is only one of the places this script *looks for a
 * ripgrep to copy* (real rg.exe files only - shell functions are invisible).
 *
 * Usage:
 *   node scripts/embed-bin.mjs                    # everything
 *   node scripts/embed-bin.mjs --only rg          # or: --only ocu
 *   node scripts/embed-bin.mjs --rg C:\path\rg.exe  # explicit ripgrep source (or env FORJA_RG_SRC)
 *   node scripts/embed-bin.mjs --check            # verify bundled files against MANIFEST.json
 *   node scripts/embed-bin.mjs --force            # rewrite even when hashes match
 *
 * Environment: FORJA_RG_SRC (ripgrep to copy), FORJA_OCU_SRC (Go module dir), GO (go binary).
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = path.join(ROOT, 'resources', 'bin')
const RES_LICENSES = path.join(ROOT, 'resources', 'licenses')
const LICENSES = path.join(ROOT, 'licenses')
const MANIFEST = path.join(ROOT, 'resources', 'MANIFEST.json')
const EXE = process.platform === 'win32' ? '.exe' : ''

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const only = (option('--only') ?? 'rg,ocu').split(',').map((s) => s.trim())
const force = flag('--force')

const log = (msg) => console.log(`[embed-bin] ${msg}`)
const fail = (msg) => {
  console.error(`[embed-bin] ERROR: ${msg}`)
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Copies src -> dst only when the content differs. Returns true when written. */
function copyIfChanged(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (!force && fs.existsSync(dst) && sha256(src) === sha256(dst)) return false
  const tmp = `${dst}.tmp-${process.pid}`
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dst)
  return true
}

/** Display path with the home directory abbreviated, so manifests do not leak the user name. */
function tilde(p) {
  const home = os.homedir()
  return p.startsWith(home) ? `~${p.slice(home.length).replace(/\\/g, '/')}` : p.replace(/\\/g, '/')
}

/* ------------------------------ MANIFEST ------------------------------ */

/** Upserts one entry by name; other agents' entries are preserved byte-for-byte in meaning. */
function upsertManifest(entry) {
  // Read-modify-write immediately before writing: other scripts append to the same file.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  if (!Array.isArray(manifest.entries)) manifest.entries = []
  const index = manifest.entries.findIndex((e) => e && e.name === entry.name)
  if (index >= 0) manifest.entries[index] = entry
  else manifest.entries.push(entry)
  const next = `${JSON.stringify(manifest, null, 2)}\n`
  if (fs.readFileSync(MANIFEST, 'utf8') === next) return false
  const tmp = `${MANIFEST}.tmp-${process.pid}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, MANIFEST)
  return true
}

function readManifestEntries() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).entries ?? []
  } catch {
    return []
  }
}

/* ------------------------------- ripgrep ------------------------------ */

function probeRipgrep(file) {
  const run = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  if (run.status !== 0) return null
  const match = /^ripgrep (\d+)\.(\d+)\.(\d+)(?: \(rev ([0-9a-f]+)\))?/m.exec(run.stdout)
  if (!match) return null
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    rev: match[4] ?? null,
    pcre2: /\+pcre2/.test(run.stdout)
  }
}

function ripgrepCandidates() {
  const list = []
  const explicit = option('--rg') ?? process.env.FORJA_RG_SRC
  if (explicit) list.push({ origin: 'explicit', file: path.resolve(explicit) })
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    list.push({ origin: 'PATH', file: path.join(dir, `rg${EXE}`) })
  }
  // opencode downloads the upstream ripgrep release here.
  list.push({ origin: 'opencode', file: path.join(os.homedir(), '.local', 'share', 'opencode', 'bin', `rg${EXE}`) })
  return list
}

function embedRipgrep() {
  const dst = path.join(BIN_DIR, `rg${EXE}`)
  let chosen = null
  for (const candidate of ripgrepCandidates()) {
    if (!fs.existsSync(candidate.file) || !fs.statSync(candidate.file).isFile()) continue
    const info = probeRipgrep(candidate.file)
    if (!info || info.major < 14) continue
    chosen = { ...candidate, ...info }
    break
  }
  if (!chosen) {
    // An already-bundled copy is fine: the script is idempotent.
    if (fs.existsSync(dst) && probeRipgrep(dst)) {
      log('rg: no source found, keeping the bundled copy')
      chosen = { origin: 'bundled', file: dst, ...probeRipgrep(dst) }
    } else {
      fail('no ripgrep >= 14 found. Pass --rg <path-to-rg.exe> or set FORJA_RG_SRC (release builds: https://github.com/BurntSushi/ripgrep/releases).')
    }
  }

  const written = chosen.file === dst ? false : copyIfChanged(chosen.file, dst)
  const info = probeRipgrep(dst)
  if (!info) fail(`bundled ${dst} does not run`)

  // Licence texts live once in licenses/ (authoritative) and are mirrored next to the binary.
  for (const [from, to] of [
    ['ripgrep-MIT', 'LICENSE-MIT'],
    ['ripgrep-UNLICENSE', 'UNLICENSE']
  ]) {
    const source = path.join(LICENSES, from)
    if (!fs.existsSync(source)) fail(`missing ${source}`)
    copyIfChanged(source, path.join(RES_LICENSES, 'ripgrep', to))
  }

  const stat = fs.statSync(dst)
  const changed = upsertManifest({
    name: 'ripgrep',
    version: info.version,
    source: `https://github.com/BurntSushi/ripgrep (upstream release build${info.rev ? `, rev ${info.rev}` : ''}); copied from ${chosen.origin === 'bundled' ? 'the existing bundled copy' : tilde(chosen.file)}`,
    size: stat.size,
    sha256: sha256(dst),
    license: 'MIT OR Unlicense',
    path: `bin/rg${EXE}`
  })
  log(`rg ${info.version}${info.rev ? ` (rev ${info.rev})` : ''} ${written ? 'copied' : 'already up to date'} -> ${path.relative(ROOT, dst)}${changed ? ' (MANIFEST updated)' : ''}`)
}

/* --------------------------- open-computer-use ------------------------ */

function git(repo, ...gitArgs) {
  const run = spawnSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8', windowsHide: true })
  return run.status === 0 ? run.stdout.trim() : null
}

function embedOpenComputerUse() {
  const goBin = process.env.GO ?? 'go'
  const repo = path.join(ROOT, 'repositorios', 'open-computer-use')
  const moduleDir = path.resolve(process.env.FORJA_OCU_SRC ?? path.join(repo, 'apps', 'OpenComputerUseWindows'))
  if (!fs.existsSync(path.join(moduleDir, 'go.mod'))) {
    fail(`Go module not found at ${moduleDir} (clone open-computer-use into repositorios/ first)`)
  }
  const goVersion = spawnSync(goBin, ['version'], { encoding: 'utf8', windowsHide: true })
  if (goVersion.status !== 0) fail('`go` is not available on PATH (Go >= 1.25 required)')

  const pluginJson = path.join(repo, 'plugins', 'open-computer-use', '.codex-plugin', 'plugin.json')
  const version = fs.existsSync(pluginJson) ? JSON.parse(fs.readFileSync(pluginJson, 'utf8')).version : '0.0.0'
  const rev = git(repo, 'log', '-1', '--format=%H') ?? 'unknown'

  // Build in a temp copy: the clone stays untouched (no go.sum edits, no build cache files).
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-ocu-'))
  try {
    for (const name of fs.readdirSync(moduleDir)) {
      if (name.endsWith('_test.go') || !/\.(go|mod|sum)$/.test(name)) continue
      fs.copyFileSync(path.join(moduleDir, name), path.join(work, name))
    }
    const out = path.join(work, `open-computer-use${EXE}`)
    const env = {
      ...process.env,
      GOOS: 'windows',
      GOARCH: 'amd64',
      CGO_ENABLED: '0', // pure Go: the backend talks to Win32/UIA through syscalls, no cgo needed
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-mod=readonly'
    }
    const build = spawnSync(
      goBin,
      ['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X main.version=${version}`, '-o', out, '.'],
      { cwd: work, env, encoding: 'utf8', windowsHide: true, timeout: 600_000 }
    )
    if (build.status !== 0) {
      fail(`go build failed (exit ${build.status}):\n${build.stderr || build.stdout}`)
    }

    const dst = path.join(BIN_DIR, `open-computer-use${EXE}`)
    const written = copyIfChanged(out, dst)

    // Licences: the project's own, plus the Go toolchain/modules linked into the binary
    // (Go standard library, golang.org/x/sys, golang.org/x/image - all BSD-3-Clause, one text).
    const projectLicense = path.join(repo, 'LICENSE')
    if (fs.existsSync(projectLicense)) {
      copyIfChanged(projectLicense, path.join(LICENSES, 'open-computer-use-LICENSE'))
    }
    const mirror = path.join(RES_LICENSES, 'open-computer-use')
    copyIfChanged(path.join(LICENSES, 'open-computer-use-LICENSE'), path.join(mirror, 'LICENSE'))
    const goRoot = spawnSync(goBin, ['env', 'GOROOT'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
    const goLicense = path.join(goRoot, 'LICENSE')
    if (fs.existsSync(goLicense)) {
      copyIfChanged(goLicense, path.join(LICENSES, 'go-LICENSE'))
      copyIfChanged(goLicense, path.join(mirror, 'GO-AND-X-MODULES-LICENSE'))
    }

    // Only modules whose packages are actually linked into the binary (not the whole build list).
    const modules = [
      ...new Set(
        spawnSync(goBin, ['list', '-deps', '-f', '{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}}{{end}}{{end}}', '.'], {
          cwd: work,
          env,
          encoding: 'utf8',
          windowsHide: true
        })
          .stdout.split(/\r?\n/)
          .filter(Boolean)
      )
    ].sort()
    const changed = upsertManifest({
      name: 'open-computer-use',
      version,
      source: `https://github.com/opensymph/open-computer-use apps/OpenComputerUseWindows @ ${rev}; built with ${goVersion.stdout.trim().replace(/^go version /, '')} (-trimpath, CGO_ENABLED=0, GOOS=windows GOARCH=amd64); modules: ${modules.join(', ')}`,
      size: fs.statSync(dst).size,
      sha256: sha256(dst),
      license: 'MIT (module deps and Go runtime: BSD-3-Clause)',
      path: `bin/open-computer-use${EXE}`
    })
    log(`open-computer-use ${version} @ ${rev.slice(0, 12)} ${written ? 'built and copied' : 'rebuilt, identical to the bundled copy'} -> ${path.relative(ROOT, dst)}${changed ? ' (MANIFEST updated)' : ''}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/* --------------------------------- check ------------------------------ */

function check() {
  let bad = 0
  const entries = readManifestEntries().filter((e) => e && typeof e.path === 'string' && e.path.startsWith('bin/'))
  if (!entries.length) {
    console.error('[embed-bin] no bin/ entries in MANIFEST.json')
    process.exit(1)
  }
  for (const entry of entries) {
    const file = path.join(ROOT, 'resources', entry.path)
    if (!fs.existsSync(file)) {
      console.error(`MISSING  ${entry.name}  ${entry.path}`)
      bad++
    } else if (sha256(file) !== entry.sha256 || fs.statSync(file).size !== entry.size) {
      console.error(`MISMATCH ${entry.name}  ${entry.path}`)
      bad++
    } else {
      console.log(`ok       ${entry.name} ${entry.version}  ${entry.path}  ${entry.sha256.slice(0, 16)}...`)
    }
  }
  process.exit(bad ? 1 : 0)
}

/* --------------------------------- main ------------------------------- */

if (flag('--check')) check()
fs.mkdirSync(BIN_DIR, { recursive: true })
if (!fs.existsSync(MANIFEST)) fail(`${MANIFEST} not found (it is created with the resources/ folder)`)
if (only.includes('rg')) embedRipgrep()
if (only.includes('ocu')) embedOpenComputerUse()
