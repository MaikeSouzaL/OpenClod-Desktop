#!/usr/bin/env node
/**
 * embed-office.mjs - puts the document libraries of Openclod into the embedded Python runtime.
 *
 * Cowork delivers real .docx / .xlsx / .pptx files. Until now the model wrote Python that imported python-docx,
 * openpyxl and python-pptx from the USER's Python, and pip-installed what was missing. This script makes the
 * embedded runtime (resources/runtime/python, built by scripts/embed-stt.mjs) carry them, so a PC with no Python at
 * all can still create the three formats:
 *
 *   python-docx, openpyxl, python-pptx, XlsxWriter           pure Python (MIT / BSD-2)
 *   lxml (BSD-3), Pillow (MIT-CMU), et_xmlfile (MIT)         native wheels / helpers they depend on
 *   typing-extensions                                        already shipped by embed-stt (huggingface-hub needs it)
 *
 * Design notes
 *  - Versions are fixed twice: by version AND by the sha256 of the wheel (WHEELS below). The wheels come from PyPI
 *    through `pip download` run by a SOURCE Python that has pip (nothing is ever installed into it), or from a folder
 *    given with --wheels (offline). A hash mismatch aborts the build.
 *  - Only these packages are touched in site-packages; the speech and TTS packages next to them are left alone.
 *    Their files are unpacked from the wheels (no pip in the embedded runtime, on purpose: the agent must not be able
 *    to `pip install` into it).
 *  - Licenses go to resources/licenses/office/<dist> (not under licenses/python, which embed-stt wipes on every run)
 *    and MANIFEST.json gets one entry per package (group "office") plus the engine script.
 *  - embed-stt rebuilds the whole runtime when its inputs change and that removes these packages: run this script
 *    again afterwards (it notices the missing packages) or use --check in CI.
 *  - Verification runs the embedded interpreter in a clean environment (PATH empty): it imports every library, builds a
 *    small .docx / .xlsx / .pptx and opens them again.
 *
 * Usage:
 *   node scripts/embed-office.mjs [--python <dir>] [--wheels <dir>] [--force] [--check] [--skip-verify]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..')
const RESOURCES = path.join(PROJECT_ROOT, 'resources')
const RUNTIME = path.join(RESOURCES, 'runtime', 'python')
const GROUP = 'office'

/**
 * Wheels of the closure of python-docx + openpyxl + python-pptx for CPython 3.10 / win_amd64 (the embedded
 * runtime). `pkg` is the top-level folder(s) that must exist after unpacking.
 */
const WHEELS = [
  { dist: 'python-docx', version: '1.2.0', file: 'python_docx-1.2.0-py3-none-any.whl', sha256: '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7', license: 'MIT', pkg: ['docx'] },
  { dist: 'openpyxl', version: '3.1.5', file: 'openpyxl-3.1.5-py2.py3-none-any.whl', sha256: '5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2', license: 'MIT', pkg: ['openpyxl'] },
  { dist: 'python-pptx', version: '1.0.2', file: 'python_pptx-1.0.2-py3-none-any.whl', sha256: '160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba', license: 'MIT', pkg: ['pptx'] },
  { dist: 'xlsxwriter', version: '3.3.0', file: 'xlsxwriter-3.3.0-py3-none-any.whl', sha256: '5f04772d43281da5109af66f39b65153359a203e896847c416476e709b024469', license: 'BSD-2-Clause', pkg: ['xlsxwriter'] },
  { dist: 'et-xmlfile', version: '2.0.0', file: 'et_xmlfile-2.0.0-py3-none-any.whl', sha256: '7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa', license: 'MIT', pkg: ['et_xmlfile'] },
  { dist: 'lxml', version: '6.1.1', file: 'lxml-6.1.1-cp310-cp310-win_amd64.whl', sha256: '3abf332af33a74288675d936fe861fd4344da0dd6622193fbc4f2bfbb35536b5', license: 'BSD-3-Clause', pkg: ['lxml'] },
  { dist: 'pillow', version: '12.3.0', file: 'pillow-12.3.0-cp310-cp310-win_amd64.whl', sha256: '300557495eb45ebb8aec96c2da9c4be642fbf7cd937278b4013ba894ea8eb0eb', license: 'MIT-CMU (bundled: FreeType FTL, HarfBuzz, LCMS2, libjpeg-turbo, libavif, brotli... see the license file)', pkg: ['PIL'] }
]
/** Declared by python-docx / python-pptx; shipped by embed-stt, only checked here. */
const EXTERNAL = [{ dist: 'typing-extensions', minimum: '4.9.0' }]
const ENGINE = path.join(RESOURCES, 'office', 'forja_office.py')
/** Our own builders (openclod_office) are not copied: python310._pth points at the folder, relative to the runtime. */
const PYLIB_DIR = path.join(RESOURCES, 'office', 'pylib')
const PTH_ENTRY = '..\\..\\office\\pylib'

const SITE_SKIP_EXT = new Set(['.pyc', '.pyo', '.pyi', '.pxd', '.pxi', '.pyx', '.h', '.hpp', '.c', '.cc', '.cpp', '.lib', '.a', '.pdb', '.exp', '.pth', '.exe'])
const SITE_SKIP_SEGMENTS = new Set(['__pycache__', 'tests', 'test'])
const LICENSE_RE = /^(licen[sc]e|licen[sc]es|copying|notice|authors|patents)([-_.].*)?$/i

// ---------------------------------------------------------------------------
// CLI and helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const opts = { python: path.join(localAppData, 'Programs', 'Python', 'Python310'), wheels: null, force: false, check: false, skipVerify: false }
  const take = (i, flag) => {
    if (i + 1 >= argv.length) fail(`Missing value for ${flag}`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--python') opts.python = path.resolve(take(i++, a))
    else if (a === '--wheels') opts.wheels = path.resolve(take(i++, a))
    else if (a === '--force') opts.force = true
    else if (a === '--check') opts.check = true
    else if (a === '--skip-verify') opts.skipVerify = true
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(SCRIPT_FILE, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
      process.exit(0)
    } else fail(`Unknown argument: ${a}`)
  }
  return opts
}

const t0 = Date.now()
const log = (msg) => console.log(`[embed-office +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)
const warn = (msg) => console.warn(`[embed-office] WARNING: ${msg}`)
function fail(msg) {
  console.error(`[embed-office] ERROR: ${msg}`)
  process.exit(1)
}
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const rmrf = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (file) => sha256Buffer(fs.readFileSync(file))

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

/** Clean environment for the embedded interpreter: nothing from the machine's PATH or Python variables. */
function cleanEnv(extra = {}) {
  return { SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: os.tmpdir(), PATH: '', ...extra }
}

const runtimePython = () => path.join(RUNTIME, 'python.exe')
const sitePackages = () => path.join(RUNTIME, 'Lib', 'site-packages')

// ---------------------------------------------------------------------------
// Wheels: obtain, verify, unpack
// ---------------------------------------------------------------------------

function findSourcePython(opts) {
  const candidates = [path.join(opts.python, 'python.exe'), 'python', 'py']
  for (const exe of candidates) {
    const res = spawnSync(exe, ['-m', 'pip', '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (res.status === 0) return exe
  }
  return null
}

function obtainWheels(opts, dest) {
  if (opts.wheels) {
    for (const w of WHEELS) {
      const from = path.join(opts.wheels, w.file)
      if (!fs.existsSync(from)) fail(`--wheels ${opts.wheels}: ${w.file} not found`)
      fs.copyFileSync(from, path.join(dest, w.file))
    }
    return 'local folder'
  }
  const exe = findSourcePython(opts)
  if (!exe) fail('No Python with pip found to download the wheels. Pass --python <dir> (a Python with pip) or --wheels <folder>.')
  log(`downloading   : ${WHEELS.length} wheels from PyPI with ${exe} (pip download; nothing is installed into that Python)`)
  const specs = WHEELS.map((w) => `${w.dist}==${w.version}`)
  const res = spawnSync(
    exe,
    ['-m', 'pip', 'download', '--no-deps', '--only-binary=:all:', '--platform', 'win_amd64', '--python-version', '3.10', '--implementation', 'cp', '--abi', 'cp310', '--disable-pip-version-check', '-q', '-d', dest, ...specs],
    { encoding: 'utf8', windowsHide: true, timeout: 600_000 }
  )
  if (res.status !== 0) fail(`pip download failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
  return 'PyPI'
}

function verifyWheels(dir) {
  for (const w of WHEELS) {
    const file = path.join(dir, w.file)
    if (!fs.existsSync(file)) fail(`${w.file} was not downloaded`)
    const actual = sha256File(file)
    if (actual !== w.sha256) fail(`${w.file}: sha256 ${actual} does not match the pinned ${w.sha256}`)
  }
}

function keepSiteFile(rel) {
  const segs = rel.split('/')
  if (segs.some((s) => SITE_SKIP_SEGMENTS.has(s))) return false
  const name = segs[segs.length - 1]
  if (SITE_SKIP_EXT.has(path.extname(name).toLowerCase())) return false
  if (/\.dist-info$/i.test(segs[0])) {
    // metadata + licenses only (entry points could trigger plugin discovery)
    return name === 'METADATA' || segs.includes('licenses') || LICENSE_RE.test(name)
  }
  return true
}

/** Unpacks one wheel into `stage`; returns the license files found ({ name, data }) and the byte/file counts kept. */
function unpackWheel(wheel, dir, stage) {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(path.join(dir, wheel.file))))
  const licenses = []
  let bytes = 0
  let files = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    let rel = name
    const dataDir = /^[^/]+\.data\/(purelib|platlib)\/(.+)$/.exec(name)
    if (dataDir) rel = dataDir[2]
    else if (/^[^/]+\.data\//.test(name)) continue // scripts / headers: not needed
    if (!keepSiteFile(rel)) continue
    const segs = rel.split('/')
    if (/\.dist-info$/i.test(segs[0]) && (segs.includes('licenses') || LICENSE_RE.test(segs[segs.length - 1]))) {
      licenses.push({ name: segs[segs.length - 1], data: Buffer.from(data) })
    }
    const to = path.join(stage, ...segs)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, data)
    bytes += data.length
    files++
  }
  for (const pkg of wheel.pkg) {
    if (!fs.existsSync(path.join(stage, pkg))) fail(`${wheel.file}: expected package folder "${pkg}" is missing after unpacking`)
  }
  return { licenses, bytes, files }
}

/** Removes previous copies of exactly these packages (folders and dist-info) from the runtime's site-packages. */
function removeOldCopies(sp) {
  const names = new Set(WHEELS.flatMap((w) => w.pkg.map((p) => p.toLowerCase())))
  const dists = new Set(WHEELS.map((w) => w.dist.replace(/-/g, '_').toLowerCase()))
  for (const entry of fs.readdirSync(sp, { withFileTypes: true })) {
    const lower = entry.name.toLowerCase()
    const info = /^(.+?)-[\d.]+\.dist-info$/.exec(lower)
    if (names.has(lower) || (info && dists.has(info[1].replace(/-/g, '_')))) rmrf(path.join(sp, entry.name))
  }
}

// ---------------------------------------------------------------------------
// Verification (embedded interpreter, clean environment)
// ---------------------------------------------------------------------------

const VERIFY_PY = String.raw`
import json, os, sys, tempfile
out = {"python": sys.version.split()[0], "executable": sys.executable, "sys_path": sys.path}
import docx, openpyxl, pptx, xlsxwriter, PIL, lxml.etree
from importlib import metadata as md
names = ("python-docx", "openpyxl", "python-pptx", "XlsxWriter", "Pillow", "lxml", "et-xmlfile", "typing-extensions")
out["versions"] = {n: md.version(n) for n in names}
tmp = tempfile.mkdtemp(prefix="forja-office-verify-")

# .docx: heading, paragraph, table, image from Pillow
from docx.shared import Cm
d = docx.Document()
d.add_heading("Resumo executivo", 1)
d.add_paragraph("Texto em português com acentuação: ação, coração, não.")
t = d.add_table(rows=2, cols=2); t.cell(0, 0).text = "Região"; t.cell(0, 1).text = "Receita"
img = os.path.join(tmp, "p.png"); PIL.Image.new("RGB", (40, 20), (200, 30, 30)).save(img)
d.add_picture(img, width=Cm(2))
d.save(os.path.join(tmp, "a.docx"))
d2 = docx.Document(os.path.join(tmp, "a.docx"))
assert len(d2.tables) == 1 and d2.paragraphs[0].text == "Resumo executivo"

# .xlsx: XlsxWriter writes a formula with its cached value, openpyxl reads it back
wb = xlsxwriter.Workbook(os.path.join(tmp, "a.xlsx"))
ws = wb.add_worksheet("Resumo"); ws.write(0, 0, 2); ws.write(1, 0, 3); ws.write_formula(2, 0, "=SUM(A1:A2)", None, 5)
wb.close()
w = openpyxl.load_workbook(os.path.join(tmp, "a.xlsx"))
assert w["Resumo"]["A3"].value == "=SUM(A1:A2)"
assert openpyxl.load_workbook(os.path.join(tmp, "a.xlsx"), data_only=True)["Resumo"]["A3"].value == 5
wb2 = openpyxl.Workbook(); wb2.active["A1"] = "=1+1"; wb2.save(os.path.join(tmp, "b.xlsx"))

# .pptx: slide with a native chart
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
p = pptx.Presentation()
s = p.slides.add_slide(p.slide_layouts[5])
s.shapes.title.text = "Receita por região"
cd = CategoryChartData(); cd.categories = ["Norte", "Sul"]; cd.add_series("Receita", (10, 20))
s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.5), Inches(6), Inches(4), cd)
p.save(os.path.join(tmp, "a.pptx"))
assert len(pptx.Presentation(os.path.join(tmp, "a.pptx")).slides) == 1

out["unwanted"] = sorted(m for m in ("pip", "setuptools") if m in sys.modules)
print(json.dumps(out))
`

function verifyRuntime() {
  const res = spawnSync(runtimePython(), ['-X', 'utf8', '-c', VERIFY_PY], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, env: cleanEnv(), timeout: 180_000 })
  if (res.status !== 0) fail(`Clean-environment check FAILED (exit ${res.status}):\n${res.stdout}\n${res.stderr}`)
  const info = JSON.parse(res.stdout.trim().split('\n').pop())
  const allowed = [RUNTIME, PYLIB_DIR].map((dir) => path.resolve(dir).toLowerCase())
  const outside = info.sys_path.filter((p) => p && !allowed.some((dir) => path.resolve(p).toLowerCase().startsWith(dir)))
  if (outside.length) fail(`sys.path has entries outside the runtime: ${outside.join(', ')}`)
  return info
}

/** sha256 over the relative paths and contents of every file under `dirs` (bytecode caches left out), plus the file count and size. */
function treeDigest(...dirs) {
  const hash = crypto.createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = (base, dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(base, full)
      else if (entry.isFile()) {
        const data = fs.readFileSync(full)
        hash.update(path.relative(base, full).replace(/\\/g, '/')).update('\0').update(data).update('\0')
        files++
        bytes += data.length
      }
    }
  }
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir, dir)
  return { sha256: hash.digest('hex'), files, bytes }
}

// ---------------------------------------------------------------------------
// python310._pth: the folder with our builders
// ---------------------------------------------------------------------------

function pthFile() {
  const found = fs.readdirSync(RUNTIME).find((name) => /^python\d+\._pth$/i.test(name))
  if (!found) fail('python3xx._pth not found in the embedded runtime (it is written by scripts/embed-stt.mjs)')
  return path.join(RUNTIME, found)
}

function pthHasEntry() {
  return fs.readFileSync(pthFile(), 'utf8').split(/\r?\n/).some((line) => line.trim() === PTH_ENTRY)
}

/** Adds the pylib folder to the interpreter's search path (idempotent; keeps `import site` last). */
function ensurePthEntry() {
  if (pthHasEntry()) return false
  const file = pthFile()
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line, i, all) => line !== '' || i < all.length - 1)
  const at = lines.findIndex((line) => line.trim() === 'import site')
  lines.splice(at < 0 ? lines.length : at, 0, PTH_ENTRY)
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n')
  return true
}

// ---------------------------------------------------------------------------
// MANIFEST
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

function installedMarkers() {
  const sp = sitePackages()
  return WHEELS.every((w) => w.pkg.every((p) => fs.existsSync(path.join(sp, p))))
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') fail('This script targets the Windows embeddable runtime (win32 only).')
  if (!fs.existsSync(runtimePython())) fail(`${runtimePython()} not found: build the runtime first with scripts/embed-stt.mjs`)

  for (const dep of EXTERNAL) {
    const probe = spawnSync(runtimePython(), ['-X', 'utf8', '-c', `from importlib import metadata as md; print(md.version("${dep.dist}"))`], { encoding: 'utf8', windowsHide: true, env: cleanEnv() })
    if (probe.status !== 0) fail(`${dep.dist} is not in the embedded runtime (embed-stt ships it as a dependency of huggingface-hub)`)
    log(`external      : ${dep.dist} ${probe.stdout.trim()} (needs >= ${dep.minimum})`)
  }

  const stampFile = path.join(RUNTIME, '.forja-office.json')
  // Only the pinned wheels decide whether the libraries are reinstalled (the pylib folder and the ._pth entry are checked on every run).
  const signature = sha256Buffer(Buffer.from(JSON.stringify({ wheels: WHEELS.map((w) => [w.file, w.sha256]) })))

  if (opts.check) {
    let stamp = null
    try {
      stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
    } catch {
      stamp = null
    }
    if (!installedMarkers() || stamp?.signature !== signature) fail('office libraries are missing or out of date in the embedded runtime: run node scripts/embed-office.mjs')
    if (!pthHasEntry()) fail(`python3xx._pth does not list ${PTH_ENTRY}: run node scripts/embed-office.mjs`)
    // MANIFEST.json must describe the files as they are now (the engine, the builders and the command shims change with the code).
    let manifest = { entries: [] }
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'MANIFEST.json'), 'utf8'))
    } catch {
      /* reported below */
    }
    const recorded = (name) => manifest.entries?.find((entry) => entry?.name === name && entry?.group === GROUP)
    const expected = {
      'forja_office.py': fs.existsSync(ENGINE) ? sha256File(ENGINE) : null,
      openclod_office: treeDigest(PYLIB_DIR).sha256,
      'openclod-office-commands': treeDigest(path.join(RESOURCES, 'office', 'bin'), path.join(RESOURCES, 'office', 'bin-fallback')).sha256
    }
    const stale = Object.entries(expected).filter(([name, hash]) => recorded(name)?.sha256 !== hash).map(([name]) => name)
    if (stale.length) fail(`resources/MANIFEST.json is out of date for ${stale.join(', ')}: run node scripts/embed-office.mjs`)
    const info = verifyRuntime()
    log(`check ok      : ${Object.entries(info.versions).map(([n, v]) => `${n} ${v}`).join(', ')}`)
    return
  }

  let stamp = null
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'))
  } catch {
    stamp = null
  }
  let built
  if (!opts.force && stamp?.signature === signature && installedMarkers()) {
    log('libraries     : up to date (signature unchanged and packages present). Use --force to reinstall.')
    built = stamp.built
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-office-'))
    try {
      const wheelDir = path.join(work, 'wheels')
      fs.mkdirSync(wheelDir)
      const origin = obtainWheels(opts, wheelDir)
      verifyWheels(wheelDir)
      log(`wheels        : ${WHEELS.length} verified against the pinned sha256 (${origin})`)

      const stage = path.join(work, 'site')
      fs.mkdirSync(stage)
      const perDist = []
      const licenseDir = path.join(RESOURCES, 'licenses', 'office')
      rmrf(licenseDir)
      for (const w of WHEELS) {
        const { licenses, bytes, files } = unpackWheel(w, wheelDir, stage)
        perDist.push({ name: w.dist, version: w.version, license: w.license, sha256: w.sha256, files, bytes, wheel: w.file })
        const target = path.join(licenseDir, w.dist)
        fs.mkdirSync(target, { recursive: true })
        const used = new Set()
        for (const lic of licenses) {
          let name = lic.name
          for (let i = 2; used.has(name.toLowerCase()); i++) name = `${i}-${lic.name}`
          used.add(name.toLowerCase())
          fs.writeFileSync(path.join(target, name), lic.data)
        }
        if (!used.size) fail(`${w.dist}: the wheel carries no license file`)
      }

      const sp = sitePackages()
      removeOldCopies(sp)
      for (const entry of fs.readdirSync(stage)) fs.cpSync(path.join(stage, entry), path.join(sp, entry), { recursive: true })

      // byte-compile with the embedded interpreter itself (hash-validated so mtimes never matter)
      const targets = fs.readdirSync(stage).filter((n) => fs.statSync(path.join(stage, n)).isDirectory() && !n.endsWith('.dist-info')).map((n) => path.join('Lib', 'site-packages', n))
      const compile = (extra) =>
        spawnSync(runtimePython(), ['-X', 'utf8', '-m', 'compileall', '-q', ...extra, '--invalidation-mode', 'checked-hash', ...targets], { cwd: RUNTIME, encoding: 'utf8', windowsHide: true, env: cleanEnv(), maxBuffer: 64 * 1024 * 1024 })
      let res = compile(['-j', '0'])
      if (res.error || /Traceback/.test(res.stderr ?? '')) res = compile([])
      if (res.error) fail(`byte-compile failed: ${res.error.message}`)
      built = { perDist, origin }
      fs.writeFileSync(stampFile, JSON.stringify({ signature, builtAt: new Date().toISOString(), built }, null, 2) + '\n')
      log(`libraries     : ${perDist.map((d) => `${d.name} ${d.version}`).join(', ')}`)
    } finally {
      rmrf(work)
    }
  }

  if (!fs.existsSync(path.join(PYLIB_DIR, 'openclod_office', '__init__.py'))) fail(`${PYLIB_DIR} is missing (the openclod_office package)`)
  if (ensurePthEntry()) log(`python._pth   : added ${PTH_ENTRY} (openclod_office builders, no copy)`)
  fs.mkdirSync(path.join(RESOURCES, 'licenses', 'office'), { recursive: true })
  fs.writeFileSync(
    path.join(RESOURCES, 'licenses', 'office', 'NOTES.txt'),
    [
      'Document libraries shipped inside resources/runtime/python (generated by scripts/embed-office.mjs)',
      '',
      '* python-docx, openpyxl, python-pptx, et_xmlfile: MIT.   XlsxWriter: BSD-2-Clause.   lxml: BSD-3-Clause.',
      '* Pillow: MIT-CMU. Its wheel bundles FreeType (FreeType License), HarfBuzz, LittleCMS, libjpeg-turbo, libavif,',
      '  brotli and others; the complete notice that the wheel carries is in pillow/LICENSE.',
      '* typing-extensions (PSF-2.0) is shipped by scripts/embed-stt.mjs.',
      '* Each folder here holds the license files taken from the wheel of that package.',
      ''
    ].join('\n')
  )

  let verification = null
  if (!opts.skipVerify) {
    log('verify        : importing and building .docx/.xlsx/.pptx in a clean environment (PATH="")...')
    verification = verifyRuntime()
    for (const [name, version] of Object.entries(verification.versions)) log(`  ${name.padEnd(18)} ${version}`)
    if (verification.unwanted.length) fail(`unexpected modules imported: ${verification.unwanted.join(', ')}`)
  }

  const stats = Object.fromEntries(built.perDist.map((d) => [d.name, d]))
  const entries = [
    ...WHEELS.map((w) => ({
      name: w.dist,
      kind: 'python-package',
      version: w.version,
      source: `PyPI wheel ${w.file} (sha256 pinned in scripts/embed-office.mjs), unpacked into the embedded site-packages`,
      sha256: w.sha256,
      files: stats[w.dist]?.files,
      size: stats[w.dist]?.bytes,
      license: w.license,
      licensePath: `licenses/office/${w.dist}`
    }))
  ]
  if (fs.existsSync(ENGINE)) {
    entries.push({
      name: 'forja_office.py',
      kind: 'script',
      version: '1',
      source: 'resources/office/forja_office.py (openclod-office: check / inspect / pdf / recalc)',
      sha256: sha256File(ENGINE),
      files: 1,
      size: fs.statSync(ENGINE).size,
      license: 'MIT'
    })
  }
  const pylib = treeDigest(PYLIB_DIR)
  entries.push({
    name: 'openclod_office',
    kind: 'python-package',
    version: '1',
    source: 'resources/office/pylib/openclod_office: builders for .docx/.xlsx/.pptx; on the interpreter path through python310._pth (not copied)',
    sha256: pylib.sha256,
    files: pylib.files,
    size: pylib.bytes,
    license: 'MIT'
  })
  const commands = treeDigest(path.join(RESOURCES, 'office', 'bin'), path.join(RESOURCES, 'office', 'bin-fallback'))
  entries.push({
    name: 'openclod-office-commands',
    kind: 'script',
    version: '1',
    source: 'resources/office/bin (openclod-python, openclod-office) and bin-fallback (python, python3 for a computer with no Python): cmd shims that the run_command tool puts on PATH',
    sha256: commands.sha256,
    files: commands.files,
    size: commands.bytes,
    license: 'MIT'
  })
  updateManifest(entries)
  log(`manifest      : ${entries.length} entries (group "${GROUP}") written to resources/MANIFEST.json`)

  console.log('\nSizes')
  let total = 0
  for (const d of [...built.perDist].sort((a, b) => b.bytes - a.bytes)) {
    total += d.bytes
    console.log(`  ${d.name.padEnd(14)} ${mb(d.bytes).padStart(6)} MB  ${d.files} files`)
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${mb(total).padStart(6)} MB`)
  const runtimeStats = dirStats(RUNTIME)
  console.log(`  runtime/python (all)  ${mb(runtimeStats.bytes)} MB in ${runtimeStats.files} files`)
  log('done')
}

main()
