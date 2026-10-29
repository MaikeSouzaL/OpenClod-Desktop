import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commandInstallsOfficeLibs,
  knownSystemPython,
  missingOfficeModuleHint,
  officeEnvPatch,
  officeInstallRefusal,
  officeLibraries,
  officeRuntime,
  parseSystemProbe,
  probeSystemPython,
  resetOfficeRuntimeCache
} from '../src/core/util/office-runtime'
import { resetResourcesCache } from '../src/core/util/resources'
import { makeTempDir, removeTempDir } from './helpers'

// The document runtime: the embedded Python carries python-docx / openpyxl / python-pptx, and run_command puts openclod-python and
// openclod-office on PATH. `python` itself is redirected only when the computer has no working Python. These tests use a fake
// resources folder, so they do not depend on the real embedded runtime.

const windows = process.platform === 'win32'
const run = windows ? describe : describe.skip

let root: string
let previousResources: string | undefined

function fakeResources(withLibraries = true): string {
  const resources = path.join(root, 'resources')
  const site = path.join(resources, 'runtime', 'python', 'Lib', 'site-packages')
  fs.mkdirSync(site, { recursive: true })
  fs.writeFileSync(path.join(resources, 'MANIFEST.json'), '{}')
  fs.writeFileSync(path.join(resources, 'runtime', 'python', 'python.exe'), '')
  fs.mkdirSync(path.join(resources, 'office', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(resources, 'office', 'bin-fallback'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'office', 'openclod_office_cli.py'), '')
  if (withLibraries) {
    for (const [dir, info] of [['docx', 'python_docx-1.2.0'], ['openpyxl', 'openpyxl-3.1.5'], ['pptx', 'python_pptx-1.0.2'], ['PIL', 'pillow-12.3.0'], ['xlsxwriter', 'xlsxwriter-3.3.0']]) {
      fs.mkdirSync(path.join(site, dir), { recursive: true })
      fs.mkdirSync(path.join(site, `${info}.dist-info`), { recursive: true })
    }
  }
  return resources
}

/** A folder for PATH with a `python.cmd` that prints what a real interpreter's probe would (or nothing at all). */
function fakePythonDir(output: string | null): string {
  const dir = path.join(root, 'sistema')
  fs.mkdirSync(dir, { recursive: true })
  if (output !== null) fs.writeFileSync(path.join(dir, 'python.cmd'), `@echo off\r\necho ${output}\r\n`)
  return dir
}

beforeEach(async () => {
  root = await makeTempDir('openclod-office-rt-')
  previousResources = process.env.OPENCLOD_RESOURCES
  resetOfficeRuntimeCache()
})

afterEach(async () => {
  if (previousResources === undefined) delete process.env.OPENCLOD_RESOURCES
  else process.env.OPENCLOD_RESOURCES = previousResources
  resetResourcesCache()
  resetOfficeRuntimeCache()
  await removeTempDir(root)
})

describe('which pip commands install document libraries', () => {
  it('recognises the usual spellings and every package of the closure', () => {
    expect(commandInstallsOfficeLibs('pip install python-pptx')).toEqual(['python-pptx'])
    expect(commandInstallsOfficeLibs('python -m pip install --user python-docx openpyxl')).toEqual(['python-docx', 'openpyxl'])
    expect(commandInstallsOfficeLibs('py -3 -m pip install "openpyxl>=3.1" pillow==11.0')).toEqual(['openpyxl', 'pillow'])
    expect(commandInstallsOfficeLibs('pip3 install docx')).toEqual(['docx'])
    expect(commandInstallsOfficeLibs('cd C:\\tmp && pip install -q python_pptx[extra] && echo pronto')).toEqual(['python-pptx'])
    expect(commandInstallsOfficeLibs('uv pip install xlsxwriter lxml')).toEqual(['xlsxwriter', 'lxml'])
    expect(commandInstallsOfficeLibs('PIP INSTALL OpenPyXL')).toEqual(['openpyxl'])
  })

  it('leaves other installs, other pip verbs and plain mentions alone', () => {
    expect(commandInstallsOfficeLibs('pip install pandas matplotlib')).toEqual([])
    expect(commandInstallsOfficeLibs('pip list')).toEqual([])
    expect(commandInstallsOfficeLibs('pip uninstall python-docx')).toEqual([])
    expect(commandInstallsOfficeLibs('python gerar.py')).toEqual([])
    expect(commandInstallsOfficeLibs('npm install docx')).toEqual([])
    expect(commandInstallsOfficeLibs('echo python-docx')).toEqual([])
  })
})

describe('what the model is told about a missing document module', () => {
  it('parses the probe of the system Python', () => {
    expect(parseSystemProbe('3.10.0 1 1 1\r\n')).toEqual({ found: true, version: '3.10.0', hasOfficeLibs: true })
    expect(parseSystemProbe('3.12.4 1 0 1')).toEqual({ found: true, version: '3.12.4', hasOfficeLibs: false })
    expect(parseSystemProbe('Python was not found; run without arguments to install from the Microsoft Store')).toEqual({ found: false, hasOfficeLibs: false })
    expect(parseSystemProbe('')).toEqual({ found: false, hasOfficeLibs: false })
  })

  run('with the embedded runtime present', () => {
    beforeEach(() => {
      process.env.OPENCLOD_RESOURCES = fakeResources()
      resetResourcesCache()
    })

    it('refuses to install what is already embedded, pointing at openclod-python', () => {
      const message = officeInstallRefusal('pip install python-docx')
      expect(message).toContain('openclod-python')
      expect(message).toContain('python-docx')
      expect(officeInstallRefusal('pip install pandas')).toBeNull()
    })

    it('turns "No module named docx" into a hint to use openclod-python', () => {
      const hint = missingOfficeModuleHint("Traceback (most recent call last):\n  File \"a.py\", line 1\nModuleNotFoundError: No module named 'docx'")
      expect(hint).toContain('openclod-python')
      expect(hint).toContain('"docx"')
      expect(missingOfficeModuleHint("ModuleNotFoundError: No module named 'pandas'")).toBeNull()
      expect(missingOfficeModuleHint("No module named 'pptx.util'")).toContain('"pptx"')
    })
  })

  run('without the embedded runtime', () => {
    it('says nothing: there is no embedded Python to point at', () => {
      // a resources folder with no runtime (the real one would be found as the fallback of a folder without MANIFEST.json)
      fs.mkdirSync(path.join(root, 'vazio'), { recursive: true })
      fs.writeFileSync(path.join(root, 'vazio', 'MANIFEST.json'), '{}')
      process.env.OPENCLOD_RESOURCES = path.join(root, 'vazio')
      resetResourcesCache()
      expect(officeRuntime()).toBeNull()
      expect(officeInstallRefusal('pip install python-docx')).toBeNull()
      expect(missingOfficeModuleHint("No module named 'docx'")).toBeNull()
      const env = { PATH: 'C:\\Windows' }
      expect(officeEnvPatch(env)).toBe(env)
    })
  })
})

run('the embedded runtime on a command PATH', () => {
  it('is found only when the libraries are installed, and reports their versions', () => {
    process.env.OPENCLOD_RESOURCES = fakeResources(false)
    resetResourcesCache()
    expect(officeRuntime()).toBeNull()
    fs.rmSync(path.join(root, 'resources'), { recursive: true, force: true })
    process.env.OPENCLOD_RESOURCES = fakeResources(true)
    resetResourcesCache()
    const runtime = officeRuntime()
    expect(runtime).not.toBeNull()
    expect(officeLibraries(runtime)).toEqual({ 'python-docx': '1.2.0', openpyxl: '3.1.5', 'python-pptx': '1.0.2', XlsxWriter: '3.3.0', Pillow: '12.3.0' })
  })

  it('adds openclod-python and openclod-office, keeps `python` alone while the machine has its own, and sets OPENCLOD_PYTHON', async () => {
    const resources = fakeResources()
    process.env.OPENCLOD_RESOURCES = resources
    resetResourcesCache()
    const env = { Path: `${fakePythonDir('3.10.0 0 0 0')};C:\\Windows\\System32`, SystemRoot: 'C:\\Windows' }
    const learned = await probeSystemPython(env)
    expect(learned).toEqual({ found: true, version: '3.10.0', hasOfficeLibs: false })
    expect(knownSystemPython(env)).toEqual(learned)
    const patched = officeEnvPatch(env)
    const parts = String(patched.Path).split(path.delimiter)
    expect(parts[0]).toBe(path.join(resources, 'office', 'bin'))
    expect(parts).not.toContain(path.join(resources, 'office', 'bin-fallback'))
    expect(parts).toContain('C:\\Windows\\System32')
    expect(patched.OPENCLOD_PYTHON).toBe(path.join(resources, 'runtime', 'python', 'python.exe'))
    // the spelling of the PATH key is respected: no second PATH variable appears
    expect(Object.keys(patched).filter((key) => key.toLowerCase() === 'path')).toEqual(['Path'])
  })

  it('also redirects python and python3 when the machine has no working Python', async () => {
    const resources = fakeResources()
    process.env.OPENCLOD_RESOURCES = resources
    resetResourcesCache()
    const env = { PATH: `${fakePythonDir(null)};C:\\Windows\\System32`, SystemRoot: 'C:\\Windows' }
    expect(await probeSystemPython(env)).toEqual({ found: false, hasOfficeLibs: false })
    const parts = String(officeEnvPatch(env).PATH).split(path.delimiter)
    expect(parts.slice(0, 2)).toEqual([path.join(resources, 'office', 'bin'), path.join(resources, 'office', 'bin-fallback')])
  })

  it('does not redirect python when it already has the libraries', async () => {
    const resources = fakeResources()
    process.env.OPENCLOD_RESOURCES = resources
    resetResourcesCache()
    const env = { PATH: `${fakePythonDir('3.11.2 1 1 1')};C:\\Windows\\System32`, SystemRoot: 'C:\\Windows' }
    expect((await probeSystemPython(env)).hasOfficeLibs).toBe(true)
    expect(String(officeEnvPatch(env).PATH).split(path.delimiter)).not.toContain(path.join(resources, 'office', 'bin-fallback'))
  })

  it('does not guess before the probe ran: only the openclod commands are added', () => {
    const resources = fakeResources()
    process.env.OPENCLOD_RESOURCES = resources
    resetResourcesCache()
    const parts = String(officeEnvPatch({ PATH: 'C:\\Windows' }).PATH).split(path.delimiter)
    expect(parts).toEqual([path.join(resources, 'office', 'bin'), 'C:\\Windows'])
  })
})
