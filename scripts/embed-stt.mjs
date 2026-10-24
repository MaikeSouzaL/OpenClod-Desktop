#!/usr/bin/env node
/**
 * embed-stt.mjs - builds the fully embedded speech-to-text runtime of Openclod.
 *
 * Nothing the app needs at runtime may come from the user's global Python, PATH,
 * pip packages or the Hugging Face cache. This script assembles, inside the
 * project, from a local Python installation + a local HF cache (no network):
 *
 *   resources/runtime/python/          embeddable layout (python.exe, python310.dll,
 *                                      VC runtime DLLs, DLLs/, Lib/, Lib/site-packages)
 *   resources/models/whisper/<size>/   CTranslate2 Whisper models (real files, no symlinks)
 *   resources/licenses/python/         licenses of everything copied
 *   resources/MANIFEST.json            entries (group "stt") describing all of the above
 *
 * Design notes
 *  - site-packages holds ONLY the dependency closure of faster-whisper, resolved from
 *    importlib.metadata (Requires-Dist, extras and dev deps excluded) of the SOURCE
 *    Python, and every file is copied from the dist's RECORD (hash-verified). Because
 *    onnxruntime and onnxruntime-gpu share one package directory in the source install,
 *    only the files of the CPU "onnxruntime" RECORD are copied; a RECORD hash mismatch
 *    (= file overwritten by the other wheel) aborts the build. CUDA / TensorRT provider
 *    DLLs are therefore never shipped.
 *  - A few declared-but-unused dependencies are skipped (UNUSED_AT_RUNTIME below); pass
 *    --full-closure to ship them anyway. The post-build check and the e2e test prove
 *    nothing imports them.
 *  - A python310._pth file makes the interpreter ignore PYTHONPATH, PYTHONHOME and the
 *    registry (verified at the end of the run). It does NOT disable the user site
 *    (%APPDATA%\Python\...) on 3.10.0, which the run also proves; therefore the engine must
 *    start the interpreter with -I (verified here to block it).
 *  - PyAV ("av") ships FFmpeg DLLs built with libx264/libx265 (GPL). faster_whisper only
 *    imports av for decode_audio(), which Openclod never calls. --stub-av ships a tiny
 *    placeholder "av" package instead (-67 MB, no GPL binaries); the default keeps the
 *    real wheel because that is what the project asked for.
 *  - Native dependencies of every .dll/.pyd are checked with a small PE import reader;
 *    Microsoft VC++ runtime DLLs that are missing next to python.exe are copied
 *    app-local from System32 so the app does not need the VC++ redistributable.
 *  - Idempotent: a stamp (script hash + source package set) lets re-runs skip the heavy
 *    copy; --force rebuilds everything.
 *
 * Usage:
 *   node scripts/embed-stt.mjs [--python <dir>] [--hf-cache <dir>] [--models tiny,base,small]
 *                              [--force] [--full-closure] [--skip-verify]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..')
const RESOURCES = path.join(PROJECT_ROOT, 'resources')
const GROUP = 'stt'

/** Root distribution whose dependency closure is shipped. */
const ROOT_DISTS = ['faster-whisper']
/**
 * Declared dependencies that are never imported at inference time:
 *  - sympy, mpmath, coloredlogs, humanfriendly, pyreadline3: only used by
 *    onnxruntime.tools / .transformers / .quantization (offline model tooling).
 *  - setuptools: declared by ctranslate2 for its converters; the runtime never imports it.
 */
const UNUSED_AT_RUNTIME = ['sympy', 'mpmath', 'coloredlogs', 'humanfriendly', 'pyreadline3', 'setuptools']
/** Heavy / dev / GPU stacks that must never be shipped, with or without --full-closure. */
const NEVER_SHIP = ['onnxruntime-gpu', 'torch', 'openai-whisper', 'transformers', 'pytest', 'black', 'flake8', 'isort']
/** Stdlib parts that an embedded, headless, non-interactive runtime does not need. */
const STDLIB_SKIP_TOP = new Set([
  'site-packages', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'lib2to3', 'msilib',
  'pydoc_data', 'test', '__pycache__', 'turtle.py', 'antigravity.py', 'this.py', '__phello__.foo.py'
])
const STDLIB_SKIP_DIRS = new Set(['test', 'tests', 'idle_test', '__pycache__'])
const DLL_SKIP_RE = /^(_test.*|_ctypes_test|_tkinter|tcl86t|tk86t|_msi)\.|\.(ico|cat|lib)$/i
/** File extensions of site-packages content that is useless at runtime. */
const SITE_SKIP_EXT = new Set([
  '.pyc', '.pyo', '.pyi', '.pxd', '.pyx', '.h', '.hpp', '.c', '.cc', '.cpp', '.lib', '.a',
  '.pdb', '.exp', '.pth', '.exe'
])
const SITE_SKIP_SEGMENTS = new Set(['__pycache__', 'tests', 'test'])
const LICENSE_RE = /^(licen[sc]e|licen[sc]es|copying|notice|authors|patents)([-_.].*)?$/i
const VC_RUNTIME_RE = /^(msvcp\d+(_\d+)?|vcruntime\d+(_\d+)?|concrt\d+|vcomp\d+|vccorlib\d+)\.dll$/i

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const hfHome = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface')
  const opts = {
    python: path.join(localAppData, 'Programs', 'Python', 'Python310'),
    hfCache: process.env.HF_HUB_CACHE || path.join(hfHome, 'hub'),
    models: ['tiny', 'base', 'small'],
    force: false,
    fullClosure: false,
    stubAv: false,
    skipVerify: false
  }
  const take = (i, flag) => {
    if (i + 1 >= argv.length) fail(`Missing value for ${flag}`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--python') opts.python = path.resolve(take(i++, a))
    else if (a === '--hf-cache') opts.hfCache = path.resolve(take(i++, a))
    else if (a === '--models') opts.models = take(i++, a).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--force') opts.force = true
    else if (a === '--full-closure') opts.fullClosure = true
    else if (a === '--stub-av') opts.stubAv = true
    else if (a === '--skip-verify') opts.skipVerify = true
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(SCRIPT_FILE, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
      process.exit(0)
    } else fail(`Unknown argument: ${a}`)
  }
  return opts
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const t0 = Date.now()
function log(msg) {
  console.log(`[embed-stt +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
}
function warn(msg) {
  console.warn(`[embed-stt] WARNING: ${msg}`)
}
function fail(msg) {
  console.error(`[embed-stt] ERROR: ${msg}`)
  process.exit(1)
}
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)

function dirStats(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        bytes += fs.statSync(p).size
        files++
      }
    }
  }
  return { bytes, files }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(8 * 1024 * 1024)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

function copyTree(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (filter && !filter(e, s)) continue
    if (e.isDirectory()) copyTree(s, d, filter)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

// ---------------------------------------------------------------------------
// Python probe (runs on the SOURCE python, read only)
// ---------------------------------------------------------------------------

const PROBE_PY = String.raw`
import json, sys, platform
import importlib.metadata as md
try:
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
except Exception as exc:
    print(json.dumps({"fatal": "o pacote 'packaging' nao esta disponivel no Python de origem: %r" % (exc,)}))
    sys.exit(3)

args = json.loads(sys.stdin.read())
skip = {canonicalize_name(n) for n in args["skip"]}

dists = {}
for d in md.distributions():
    name = d.metadata["Name"]
    if name:
        dists.setdefault(canonicalize_name(name), d)

def license_of(d):
    m = d.metadata
    v = m.get("License-Expression")
    if v:
        return v.strip()
    v = (m.get("License") or "").strip()
    if v and len(v) < 120 and "\n" not in v:
        return v
    cl = [c.split("::")[-1].strip() for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]
    cl = [c for c in cl if c != "OSI Approved"]
    if cl:
        return " / ".join(cl)
    return v.splitlines()[0][:100] if v else "UNKNOWN"

out, skipped, warnings, missing = [], [], [], []
seen = set()
queue = [(canonicalize_name(r), "<root>") for r in args["roots"]]
while queue:
    name, parent = queue.pop(0)
    if name in seen:
        continue
    if name in skip:
        skipped.append({"name": name, "requiredBy": parent})
        seen.add(name)
        continue
    d = dists.get(name)
    if d is None:
        missing.append({"name": name, "requiredBy": parent})
        seen.add(name)
        continue
    seen.add(name)
    files = []
    for f in (d.files or []):
        rel = str(f).replace("\\", "/")
        if rel.startswith("../") or rel.startswith("/") or ":" in rel.split("/")[0]:
            continue
        h = f.hash.value if (f.hash is not None and f.hash.mode == "sha256") else None
        files.append([rel, h, f.size])
    if not files:
        warnings.append("%s nao tem RECORD (arquivos nao listados)" % name)
    out.append({
        "name": name,
        "version": d.version,
        "license": license_of(d),
        "home": (d.metadata.get("Home-page") or ((d.metadata.get_all("Project-URL") or [""])[0])).strip(),
        "author": (d.metadata.get("Author") or d.metadata.get("Author-email") or "").strip(),
        "location": str(d.locate_file("")),
        "requiredBy": parent,
        "files": files,
    })
    for req in (d.requires or []):
        r = Requirement(req)
        if r.marker is not None and not r.marker.evaluate({"extra": ""}):
            continue
        dep = canonicalize_name(r.name)
        dd = dists.get(dep)
        if dd is not None and len(r.specifier) and not r.specifier.contains(dd.version, prereleases=True):
            warnings.append("%s exige %s%s mas %s esta instalado" % (name, r.name, r.specifier, dd.version))
        queue.append((dep, name))

print(json.dumps({
    "python": {
        "version": platform.python_version(),
        "full": sys.version,
        "machine": platform.machine(),
        "platform": sys.platform,
        "executable": sys.executable,
    },
    "dists": out,
    "skipped": skipped,
    "missing": missing,
    "warnings": warnings,
}))
`

function probeSourcePython(pythonDir, skip) {
  const exe = path.join(pythonDir, 'python.exe')
  const res = spawnSync(exe, ['-I', '-X', 'utf8', '-c', PROBE_PY], {
    input: JSON.stringify({ roots: ROOT_DISTS, skip }),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true
  })
  if (res.error) fail(`Could not run ${exe}: ${res.error.message}`)
  if (res.status !== 0) {
    fail(`Python probe failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
  }
  const plan = JSON.parse(res.stdout)
  if (plan.fatal) fail(plan.fatal)
  return plan
}

// ---------------------------------------------------------------------------
// PE import reader (to prove the runtime is self-contained)
// ---------------------------------------------------------------------------

function peImports(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const rd = (off, len) => {
      const b = Buffer.alloc(len)
      const n = fs.readSync(fd, b, 0, len, off)
      return b.subarray(0, n)
    }
    const dos = rd(0, 64)
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null
    const peOff = dos.readUInt32LE(0x3c)
    const nt = rd(peOff, 24 + 240)
    if (nt.length < 24 || nt.readUInt32LE(0) !== 0x00004550) return null
    const numSections = nt.readUInt16LE(6)
    const optSize = nt.readUInt16LE(20)
    const magic = nt.readUInt16LE(24)
    const dirBase = 24 + (magic === 0x20b ? 112 : 96)
    const importRva = nt.readUInt32LE(dirBase + 8)
    if (!importRva) return []
    const sections = rd(peOff + 24 + optSize, numSections * 40)
    const rvaToOff = (rva) => {
      for (let i = 0; i < numSections; i++) {
        const va = sections.readUInt32LE(i * 40 + 12)
        const vsz = sections.readUInt32LE(i * 40 + 8)
        const rawSz = sections.readUInt32LE(i * 40 + 16)
        const raw = sections.readUInt32LE(i * 40 + 20)
        if (rva >= va && rva < va + Math.max(vsz, rawSz)) return rva - va + raw
      }
      return -1
    }
    const names = []
    let off = rvaToOff(importRva)
    if (off < 0) return []
    for (let guard = 0; guard < 512; guard++, off += 20) {
      const desc = rd(off, 20)
      if (desc.length < 20) break
      const nameRva = desc.readUInt32LE(12)
      if (nameRva === 0) break
      const nameOff = rvaToOff(nameRva)
      if (nameOff < 0) break
      const raw = rd(nameOff, 260)
      const end = raw.indexOf(0)
      names.push(raw.subarray(0, end < 0 ? raw.length : end).toString('latin1').toLowerCase())
    }
    return names
  } finally {
    fs.closeSync(fd)
  }
}

function listNative(dir) {
  const found = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (/\.(dll|pyd|exe)$/i.test(e.name)) found.push(p)
    }
  }
  return found
}

/**
 * Walks the import table of every native module in the runtime. Imports that are not
 * bundled are classified: VC++ runtime (copied app-local from System32), Windows
 * system DLL (fine), or truly missing (error).
 */
function checkNativeDependencies(runtimeDir) {
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const copiedVc = []
  const missing = []
  const systemUsed = new Set()
  for (let round = 0; round < 4; round++) {
    const natives = listNative(runtimeDir)
    const bundled = new Set(natives.map((p) => path.basename(p).toLowerCase()))
    let changed = false
    for (const file of natives) {
      const imports = peImports(file) ?? []
      for (const dep of imports) {
        if (bundled.has(dep)) continue
        if (/^(api-ms-|ext-ms-)/.test(dep)) continue
        const sys32 = path.join(system32, dep)
        if (VC_RUNTIME_RE.test(dep) && fs.existsSync(sys32)) {
          fs.copyFileSync(sys32, path.join(runtimeDir, dep))
          copiedVc.push(dep)
          bundled.add(dep)
          changed = true
        } else if (fs.existsSync(sys32)) {
          systemUsed.add(dep)
        } else {
          missing.push(`${path.relative(runtimeDir, file)} -> ${dep}`)
        }
      }
    }
    if (!changed) break
  }
  return { copiedVc: [...new Set(copiedVc)], missing: [...new Set(missing)], system: [...systemUsed].sort() }
}

// ---------------------------------------------------------------------------
// Build the embedded runtime
// ---------------------------------------------------------------------------

function keepSiteFile(rel) {
  const segs = rel.split('/')
  if (segs.some((s) => SITE_SKIP_SEGMENTS.has(s))) return false
  const name = segs[segs.length - 1]
  if (SITE_SKIP_EXT.has(path.extname(name).toLowerCase())) return false
  if (/\.(dist|egg)-info$/i.test(segs[0])) {
    // keep metadata + licenses only (entry points could trigger plugin discovery)
    return name === 'METADATA' || segs.includes('licenses') || LICENSE_RE.test(name)
  }
  return true
}

/** Placeholder for PyAV: faster_whisper imports "av" at module level but only uses it in decode_audio(). */
const AV_STUB = `"""Openclod placeholder for PyAV (the real wheel bundles GPL FFmpeg builds).

faster_whisper imports \`av\` at import time but only calls it from decode_audio(); Openclod feeds raw
PCM and never decodes media files, so this module only has to be importable.
"""

__version__ = "0.0.0+forja-stub"


def open(*_args, **_kwargs):  # noqa: A001 - mirrors av.open
    raise RuntimeError("PyAV nao esta embarcado nesta build do Openclod; decodificacao de arquivos de midia indisponivel")
`

function buildRuntime(opts, plan, stageDir) {
  const py = opts.python
  const src = (...p) => path.join(py, ...p)
  fs.mkdirSync(stageDir, { recursive: true })

  // 1. interpreter + core DLLs
  for (const f of ['python.exe', 'python3.dll', 'python310.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    if (!fs.existsSync(src(f))) fail(`Missing ${f} in ${py}`)
    fs.copyFileSync(src(f), path.join(stageDir, f))
  }

  // 2. extension modules (.pyd) and their DLLs
  copyTree(src('DLLs'), path.join(stageDir, 'DLLs'), (e) => e.isDirectory() || !DLL_SKIP_RE.test(e.name))

  // 3. stdlib
  copyTree(src('Lib'), path.join(stageDir, 'Lib'), (e, full) => {
    const rel = path.relative(src('Lib'), full)
    const top = rel.split(path.sep)[0]
    if (rel === top && STDLIB_SKIP_TOP.has(e.name)) return false
    if (e.isDirectory() && STDLIB_SKIP_DIRS.has(e.name)) return false
    return true
  })

  // 4. site-packages: dependency closure only
  const sp = path.join(stageDir, 'Lib', 'site-packages')
  fs.mkdirSync(sp, { recursive: true })
  const mismatches = []
  const perDist = []
  for (const dist of plan.dists) {
    let bytes = 0
    let files = 0
    if (opts.stubAv && dist.name === 'av') {
      fs.mkdirSync(path.join(sp, 'av'), { recursive: true })
      fs.writeFileSync(path.join(sp, 'av', '__init__.py'), AV_STUB)
      perDist.push({ name: 'av', version: `${dist.version}+forja-stub`, license: 'MIT', files: 1, bytes: AV_STUB.length, stub: true })
      continue
    }
    for (const [rel, hash] of dist.files) {
      if (!keepSiteFile(rel)) continue
      const from = path.join(dist.location, ...rel.split('/'))
      if (!fs.existsSync(from)) fail(`${dist.name}: file listed in RECORD is missing: ${from}`)
      const data = fs.readFileSync(from)
      if (hash && crypto.createHash('sha256').update(data).digest('base64url') !== hash) {
        mismatches.push(`${dist.name}: ${rel}`)
        continue
      }
      const to = path.join(sp, ...rel.split('/'))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.writeFileSync(to, data)
      bytes += data.length
      files++
    }
    perDist.push({ name: dist.name, version: dist.version, license: dist.license, files, bytes })
  }
  if (mismatches.length) {
    fail(
      'Some files differ from the RECORD hash of their distribution (overwritten by another ' +
        `wheel in the shared package directory?). Refusing to ship them:\n  ${mismatches.slice(0, 20).join('\n  ')}`
    )
  }

  // 5. ._pth: stdlib dirs + site-packages; makes Python ignore PYTHONPATH / PYTHONHOME / user site
  fs.writeFileSync(
    path.join(stageDir, 'python310._pth'),
    ['DLLs', 'Lib', 'Lib\\site-packages', 'import site', ''].join('\r\n')
  )

  // 6. self-containment: bundle missing VC++ runtime DLLs
  const deps = checkNativeDependencies(stageDir)

  // 7. byte-compile with the embedded interpreter itself (hash-validated so mtimes never matter)
  const exe = path.join(stageDir, 'python.exe')
  const compile = (extra) =>
    spawnSync(exe, ['-X', 'utf8', '-m', 'compileall', '-q', ...extra, '--invalidation-mode', 'checked-hash', 'Lib'], {
      cwd: stageDir,
      encoding: 'utf8',
      windowsHide: true,
      env: cleanEnv(),
      maxBuffer: 64 * 1024 * 1024
    })
  let res = compile(['-j', '0'])
  // A Python traceback (not just "*** Error compiling" lines) means the worker pool failed: go serial.
  if (res.error || /Traceback/.test(res.stderr ?? '')) res = compile([])
  if (res.error) fail(`byte-compile failed: ${res.error.message}`)
  const syntaxNoise = ((res.stdout ?? '') + (res.stderr ?? '')).split(/\r?\n/).filter((l) => /Error compiling/.test(l)).length
  return { perDist, deps, compileNoise: syntaxNoise }
}

function cleanEnv(extra = {}) {
  return {
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    TEMP: os.tmpdir(),
    PATH: '',
    ...extra
  }
}

// ---------------------------------------------------------------------------
// Verification in a clean environment
// ---------------------------------------------------------------------------

const VERIFY_PY = String.raw`
import json, sys, os
out = {"python": sys.version.split()[0], "isolated": sys.flags.isolated, "no_user_site": sys.flags.no_user_site,
       "executable": sys.executable, "sys_path": sys.path}
import numpy, av, ctranslate2, onnxruntime, faster_whisper, tokenizers, huggingface_hub
out["versions"] = {
    "faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__,
    "onnxruntime": onnxruntime.__version__, "av": av.__version__, "numpy": numpy.__version__,
    "tokenizers": tokenizers.__version__, "huggingface_hub": huggingface_hub.__version__,
}
out["onnx_providers"] = onnxruntime.get_available_providers()
out["ct2_cuda_devices"] = ctranslate2.get_cuda_device_count()
out["ct2_compute_cpu"] = sorted(ctranslate2.get_supported_compute_types("cpu"))
from faster_whisper.vad import get_vad_model
get_vad_model()
out["silero_vad"] = "ok"
out["leaked"] = sorted(m for m in ("sympy", "mpmath", "setuptools", "torch", "coloredlogs") if m in sys.modules)
print(json.dumps(out))
`

function verifyRuntime(runtimeDir) {
  const exe = path.join(runtimeDir, 'python.exe')
  const run = (args, env) =>
    spawnSync(exe, args, { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, env, timeout: 180_000 })

  const res = run(['-X', 'utf8', '-c', VERIFY_PY], cleanEnv())
  if (res.status !== 0) fail(`Clean-environment import check FAILED (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
  const info = JSON.parse(res.stdout.trim().split('\n').pop())

  // PYTHONPATH / user site must be ignored thanks to the ._pth file
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-pythonpath-'))
  fs.writeFileSync(path.join(probeDir, 'forja_pythonpath_probe.py'), 'VALUE = 1\n')
  const ignored = run(['-X', 'utf8', '-c', 'import forja_pythonpath_probe'], cleanEnv({ PYTHONPATH: probeDir }))
  rmrf(probeDir)
  const pythonPathIgnored = ignored.status !== 0 && /No module named/.test(ignored.stderr ?? '')

  // The user site (%APPDATA%\Python\Python310\site-packages) is NOT disabled by the ._pth file on 3.10.0,
  // so the engine must start the interpreter with -I. Prove both facts with a fake APPDATA.
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-appdata-'))
  const userSite = path.join(fakeAppData, 'Python', 'Python310', 'site-packages')
  fs.mkdirSync(userSite, { recursive: true })
  fs.writeFileSync(path.join(userSite, 'forja_usersite_probe.py'), 'VALUE = 1\n')
  const probeEnv = cleanEnv({ APPDATA: fakeAppData })
  const withoutI = run(['-X', 'utf8', '-c', 'import forja_usersite_probe'], probeEnv)
  const withI = run(['-I', '-X', 'utf8', '-c', 'import forja_usersite_probe'], probeEnv)
  rmrf(fakeAppData)
  const userSiteLeaksWithoutI = withoutI.status === 0
  const userSiteBlockedWithI = withI.status !== 0 && /No module named/.test(withI.stderr ?? '')

  const rootPrefix = runtimeDir.toLowerCase()
  const outside = info.sys_path.filter((p) => p && !p.toLowerCase().startsWith(rootPrefix))
  return { info, pythonPathIgnored, outside, userSiteLeaksWithoutI, userSiteBlockedWithI }
}

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

function writeLicenses(opts, plan, deps) {
  const dir = path.join(RESOURCES, 'licenses', 'python')
  rmrf(dir)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(opts.python, 'LICENSE.txt'), path.join(dir, 'PYTHON-LICENSE.txt'))
  let copied = 0
  for (const dist of plan.dists) {
    const target = path.join(dir, dist.name)
    const used = new Set()
    for (const [rel] of dist.files) {
      const segs = rel.split('/')
      const base = segs[segs.length - 1]
      const inDistInfo = /\.(dist|egg)-info$/i.test(segs[0])
      const topLevelPackageFile = !inDistInfo && segs.length <= 2
      if (!LICENSE_RE.test(base) || segs.some((s) => SITE_SKIP_SEGMENTS.has(s))) continue
      if (!inDistInfo && !topLevelPackageFile) continue
      const from = path.join(dist.location, ...segs)
      if (!fs.existsSync(from)) continue
      let name = base
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${i}-${base}`
      used.add(name.toLowerCase())
      fs.mkdirSync(target, { recursive: true })
      fs.copyFileSync(from, path.join(target, name))
      copied++
    }
    if (!used.size) {
      // The wheel ships no license text: record what its metadata declares and where to find the original.
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(
        path.join(target, 'LICENSE-NOTE.txt'),
        [
          `${dist.name} ${dist.version}`,
          `Declared license (package metadata): ${dist.license}`,
          dist.author ? `Author: ${dist.author}` : '',
          dist.home ? `Upstream: ${dist.home}` : '',
          '',
          'The distributed wheel did not include a license file, so this note records the license declared in',
          'its metadata. The full license text is available from the upstream project.',
          ''
        ]
          .filter((line, i, all) => line !== '' || all[i - 1] !== '')
          .join('\n')
      )
      warn(`${dist.name}: wheel has no license file; wrote LICENSE-NOTE.txt (declared: ${dist.license})`)
    }
  }
  const notes = [
    'Third-party components shipped inside resources/runtime/python (generated by scripts/embed-stt.mjs)',
    '',
    '* CPython 3.10 (PSF License) - see PYTHON-LICENSE.txt. DLLs/ also carries the OpenSSL 1.1.1',
    '  libraries (libcrypto/libssl, OpenSSL license), libffi (MIT) and SQLite (public domain) that the',
    '  official Windows build of Python redistributes.',
    deps.copiedVc.length
      ? `* Microsoft Visual C++ runtime DLLs bundled app-local (${deps.copiedVc.join(', ')}); redistributable under the Microsoft Visual C++ Redistributable terms.`
      : '* Microsoft Visual C++ runtime: vcruntime140.dll / vcruntime140_1.dll are shipped next to python.exe.',
    ...(opts.stubAv
      ? [
          '* "av" is a tiny placeholder module (no FFmpeg is shipped): faster_whisper imports it at module',
          '  level but Openclod only feeds raw PCM and never decodes media files.'
        ]
      : [
          '* PyAV (package "av") bundles FFmpeg shared libraries in site-packages/av.libs. That FFmpeg build',
          '  includes libx264/libx265 (GPL) besides LGPL components: review the licensing / source-offer',
          '  obligations before redistributing the installer, or rebuild with --stub-av (Openclod only needs',
          '  "av" because faster_whisper imports it; audio is fed as raw PCM).'
        ]),
    '* Whisper models: MIT (OpenAI), CTranslate2 conversions by Systran - see resources/models/whisper/LICENSE.txt.',
    '* Silero VAD (silero_vad_v6.onnx inside faster_whisper/assets): MIT.',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'BUNDLED-NOTES.txt'), notes)
  return copied
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function resolveSnapshot(hfCache, id) {
  const repo = path.join(hfCache, `models--Systran--faster-whisper-${id}`)
  if (!fs.existsSync(repo)) {
    const avail = fs.existsSync(hfCache)
      ? fs.readdirSync(hfCache).filter((n) => n.startsWith('models--Systran--faster-whisper-')).map((n) => n.replace('models--Systran--faster-whisper-', ''))
      : []
    fail(`Model "${id}" not found in ${hfCache} (available: ${avail.join(', ') || 'none'})`)
  }
  let revision
  const ref = path.join(repo, 'refs', 'main')
  if (fs.existsSync(ref)) revision = fs.readFileSync(ref, 'utf8').trim()
  const snaps = path.join(repo, 'snapshots')
  if (!revision || !fs.existsSync(path.join(snaps, revision))) {
    const all = fs.readdirSync(snaps)
    if (!all.length) fail(`No snapshot for model ${id}`)
    revision = all[0]
  }
  return { dir: path.join(snaps, revision), revision, repo: `Systran/faster-whisper-${id}` }
}

function copyModel(opts, id) {
  const snap = resolveSnapshot(opts.hfCache, id)
  const dst = path.join(RESOURCES, 'models', 'whisper', id)
  const metaFile = path.join(dst, 'forja-model.json')
  fs.mkdirSync(dst, { recursive: true })

  const names = fs.readdirSync(snap.dir).filter((n) => !n.startsWith('.') && !n.endsWith('.md') && n !== '.gitattributes')
  for (const req of ['config.json', 'model.bin', 'tokenizer.json']) {
    if (!names.includes(req)) fail(`Model ${id}: ${req} missing in ${snap.dir}`)
  }
  if (!names.some((n) => n.startsWith('vocabulary.'))) fail(`Model ${id}: vocabulary.* missing in ${snap.dir}`)

  let previous = {}
  try {
    previous = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    previous = {}
  }
  const hashes = {}
  let copiedAny = false
  for (const name of names) {
    const real = fs.realpathSync(path.join(snap.dir, name)) // resolves HF symlinks to the blob
    const stat = fs.statSync(real)
    if (!stat.isFile()) continue
    const to = path.join(dst, name)
    const upToDate =
      !opts.force && fs.existsSync(to) && fs.statSync(to).size === stat.size && previous.sha256?.[name]
    if (upToDate) {
      hashes[name] = previous.sha256[name]
      continue
    }
    fs.copyFileSync(real, to)
    hashes[name] = sha256File(to)
    copiedAny = true
    // HF blobs of LFS files are named after their sha256: free integrity check
    const blob = path.basename(real)
    if (/^[0-9a-f]{64}$/.test(blob) && blob !== hashes[name]) fail(`Model ${id}: ${name} copy does not match its blob hash`)
  }
  fs.writeFileSync(
    metaFile,
    JSON.stringify({ id, repo: snap.repo, revision: snap.revision, sha256: hashes }, null, 2) + '\n'
  )
  const stats = dirStats(dst)
  return { id, dir: dst, ...stats, sha256: hashes['model.bin'], revision: snap.revision, repo: snap.repo, copiedAny }
}

const WHISPER_LICENSE = `Whisper model weights - license notice
=====================================

The Whisper models in this folder are the OpenAI Whisper checkpoints
(https://github.com/openai/whisper) converted to the CTranslate2 format by
Systran (https://huggingface.co/Systran, faster-whisper-* repositories).

Both the OpenAI Whisper code and weights, and the Systran conversions, are
released under the MIT License.

MIT License

Copyright (c) 2022 OpenAI

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

// ---------------------------------------------------------------------------
// MANIFEST.json
// ---------------------------------------------------------------------------

function updateManifest(entries) {
  const file = path.join(RESOURCES, 'MANIFEST.json')
  let manifest = { version: 1, entries: [] }
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    /* keep default */
  }
  if (!Array.isArray(manifest.entries)) manifest.entries = []
  manifest.entries = manifest.entries.filter((e) => e?.group !== GROUP)
  manifest.entries.push(...entries.map((e) => ({ ...e, group: GROUP })))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') fail('This script builds the Windows embeddable runtime (win32 only).')
  if (!fs.existsSync(path.join(opts.python, 'python.exe'))) fail(`python.exe not found in ${opts.python} (use --python <dir>)`)
  log(`source python : ${opts.python}`)
  log(`HF cache      : ${opts.hfCache}`)
  log(`models        : ${opts.models.join(', ')}`)

  const runtimeParent = path.join(RESOURCES, 'runtime')
  const runtimeDir = path.join(runtimeParent, 'python')
  const stampFile = path.join(runtimeDir, '.forja-embed.json')
  fs.mkdirSync(runtimeParent, { recursive: true })

  // ---- plan (closure of faster-whisper) --------------------------------------------
  const skip = opts.fullClosure ? NEVER_SHIP : [...UNUSED_AT_RUNTIME, ...NEVER_SHIP]
  const plan = probeSourcePython(opts.python, skip)
  if (plan.python.version !== '3.10.0' && !plan.python.version.startsWith('3.10.')) {
    fail(`Source Python is ${plan.python.version}; the embedded layout (python310._pth) expects 3.10.x`)
  }
  if (plan.missing.length) fail(`Dependencies not installed in the source Python: ${plan.missing.map((m) => `${m.name} (required by ${m.requiredBy})`).join(', ')}`)
  for (const w of plan.warnings) warn(w)
  log(`closure       : ${plan.dists.map((d) => `${d.name}@${d.version}`).join(', ')}`)
  if (plan.skipped.length) log(`skipped deps  : ${[...new Set(plan.skipped.map((s) => s.name))].join(', ')}`)

  const signature = sha256Text(
    JSON.stringify({
      script: sha256File(SCRIPT_FILE),
      options: { fullClosure: opts.fullClosure, stubAv: opts.stubAv },
      python: plan.python.full,
      dists: plan.dists.map((d) => [d.name, d.version, d.files.map((f) => `${f[0]}:${f[1] ?? ''}`)])
    })
  )

  // ---- runtime ----------------------------------------------------------------------
  let stamp = null
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
  } catch {
    stamp = null
  }
  let built
  if (!opts.force && stamp?.signature === signature && fs.existsSync(path.join(runtimeDir, 'python310._pth'))) {
    log('runtime       : up to date (signature unchanged), skipping the copy. Use --force to rebuild.')
    built = stamp.built
  } else {
    const stage = path.join(runtimeParent, `.python-staging-${process.pid}`)
    rmrf(stage)
    log('runtime       : building (stdlib + DLLs + site-packages + byte-compile)...')
    built = buildRuntime(opts, plan, stage)
    rmrf(runtimeDir)
    fs.renameSync(stage, runtimeDir)
    fs.writeFileSync(
      stampFile,
      JSON.stringify({ signature, builtAt: new Date().toISOString(), python: plan.python.version, built }, null, 2) + '\n'
    )
    if (built.compileNoise) log(`byte-compile  : ${built.compileNoise} third-party files could not be compiled (py2-only sources); ignored`)
  }
  const runtimeStats = dirStats(runtimeDir)
  log(`runtime       : ${mb(runtimeStats.bytes)} MB in ${runtimeStats.files} files`)

  // ---- licenses ---------------------------------------------------------------------
  const licenseFiles = writeLicenses(opts, plan, built.deps ?? { copiedVc: [] })
  log(`licenses      : ${licenseFiles} files in resources/licenses/python`)

  // ---- models -----------------------------------------------------------------------
  fs.mkdirSync(path.join(RESOURCES, 'models', 'whisper'), { recursive: true })
  fs.writeFileSync(path.join(RESOURCES, 'models', 'whisper', 'LICENSE.txt'), WHISPER_LICENSE)
  const models = opts.models.map((id) => {
    const m = copyModel(opts, id)
    log(`model ${id.padEnd(6)}: ${mb(m.bytes)} MB (${m.copiedAny ? 'copied' : 'up to date'}) sha256(model.bin)=${m.sha256.slice(0, 16)}...`)
    return m
  })

  // ---- verification -----------------------------------------------------------------
  let verification = null
  if (!opts.skipVerify) {
    log('verify        : importing in a clean environment (env = SystemRoot, TEMP, PATH="")...')
    verification = verifyRuntime(runtimeDir)
    const v = verification.info
    log(`  python ${v.python}  isolated=${v.isolated}  no_user_site=${v.no_user_site}`)
    for (const [k, val] of Object.entries(v.versions)) log(`  ${k.padEnd(16)} ${val}`)
    log(`  onnxruntime providers: ${v.onnx_providers.join(', ')}`)
    log(`  ctranslate2 cuda devices visible: ${v.ct2_cuda_devices}; cpu compute types: ${v.ct2_compute_cpu.join(', ')}`)
    log(`  silero vad: ${v.silero_vad}; skipped deps imported: ${v.leaked.length ? v.leaked.join(',') : 'none'}`)
    log(`  PYTHONPATH ignored: ${verification.pythonPathIgnored ? 'yes' : 'NO'}; sys.path entries outside the runtime: ${verification.outside.length ? verification.outside.join(', ') : 'none'}`)
    log(`  user site (APPDATA) importable without -I: ${verification.userSiteLeaksWithoutI ? 'YES (engine must pass -I)' : 'no'}; blocked with -I: ${verification.userSiteBlockedWithI ? 'yes' : 'NO'}`)
    if (!verification.userSiteBlockedWithI) fail('python.exe -I does not block the user site')
    if (!verification.pythonPathIgnored) fail('PYTHONPATH is NOT ignored by the embedded interpreter')
    if (verification.outside.length) fail('sys.path leaks entries outside the embedded runtime')
    if (v.onnx_providers.some((p) => /cuda|tensorrt/i.test(p))) fail('onnxruntime exposes GPU providers; the GPU wheel leaked into the runtime')
    if (v.leaked.length) fail(`skipped dependencies were imported: ${v.leaked.join(', ')}`)
  }
  if (built.deps?.missing?.length) fail(`Unresolved native dependencies:\n  ${built.deps.missing.join('\n  ')}`)
  if (built.deps) {
    log(`native deps   : app-local VC++ runtime copied: ${built.deps.copiedVc.join(', ') || 'none needed'}; Windows system DLLs used (${built.deps.system.length}): ${built.deps.system.join(', ')}`)
  }

  // ---- manifest ---------------------------------------------------------------------
  const sidecar = path.join(RESOURCES, 'stt', 'forja_stt.py')
  const entries = [
    {
      name: 'python-embedded',
      kind: 'runtime',
      version: plan.python.version,
      source: `copied from ${opts.python} (python.exe, python310.dll, vcruntime, DLLs, stdlib minus tests/idle/tkinter)`,
      files: runtimeStats.files,
      size: runtimeStats.bytes,
      license: 'PSF-2.0'
    },
    ...built.perDist.map((d) => ({
      name: d.name,
      kind: 'python-package',
      version: d.version,
      source: 'site-packages of the source Python (RECORD hash-verified)',
      files: d.files,
      size: d.bytes,
      license: d.license
    })),
    ...models.map((m) => ({
      name: `whisper-${m.id}`,
      kind: 'model',
      version: m.revision,
      source: `huggingface.co/${m.repo}`,
      sha256: m.sha256,
      files: m.files,
      size: m.bytes,
      license: 'MIT'
    }))
  ]
  if (fs.existsSync(sidecar)) {
    entries.push({
      name: 'forja_stt.py',
      kind: 'script',
      version: '1',
      source: 'resources/stt/forja_stt.py',
      sha256: sha256File(sidecar),
      files: 1,
      size: fs.statSync(sidecar).size,
      license: 'MIT'
    })
  }
  updateManifest(entries)
  log(`manifest      : ${entries.length} entries (group "${GROUP}") written to resources/MANIFEST.json`)

  // ---- summary ----------------------------------------------------------------------
  console.log('\nSizes')
  console.log(`  runtime/python (total)      ${mb(runtimeStats.bytes).padStart(8)} MB  ${runtimeStats.files} files`)
  const lib = dirStats(path.join(runtimeDir, 'Lib'))
  const sp = dirStats(path.join(runtimeDir, 'Lib', 'site-packages'))
  console.log(`    stdlib (Lib minus sp)     ${mb(lib.bytes - sp.bytes).padStart(8)} MB`)
  console.log(`    site-packages             ${mb(sp.bytes).padStart(8)} MB`)
  for (const d of [...built.perDist].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    console.log(`      ${d.name.padEnd(24)} ${mb(d.bytes).padStart(8)} MB`)
  }
  let modelTotal = 0
  for (const m of models) {
    modelTotal += m.bytes
    console.log(`  models/whisper/${m.id.padEnd(12)} ${mb(m.bytes).padStart(8)} MB`)
  }
  console.log(`  TOTAL (runtime + models)    ${mb(runtimeStats.bytes + modelTotal).padStart(8)} MB`)
  log('done')
}

main()
