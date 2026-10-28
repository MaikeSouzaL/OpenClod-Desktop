import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeFailureOutput, fileDependencies, findSymbols, repositoryOverview } from '../src/core/code-intelligence'
import { discoverQualityChecks, runQualityChecks } from '../src/core/quality/engine'
import { makeTempDir, removeTempDir } from './helpers'

describe('code intelligence and quality engine', () => {
  let dir: string
  beforeEach(async () => {
    dir = await makeTempDir('openclod-code-intel-')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node test.cjs', typecheck: 'node check.cjs' } }))
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), [
      "import path from 'node:path'",
      "import { helper } from './helper'",
      'export class Service {}',
      'export function runTask() { return helper() }',
      'const hidden = () => 1'
    ].join('\n'))
    fs.writeFileSync(path.join(dir, 'src', 'helper.ts'), 'export function helper() { return 42 }\n')
    fs.writeFileSync(path.join(dir, 'src', 'index.test.ts'), 'test("ok", () => {})\n')
  })
  afterEach(async () => removeTempDir(dir))

  it('summarizes repository structure and extracts exported symbols', async () => {
    const overview = await repositoryOverview(dir)
    expect(overview.files).toBe(3)
    expect(overview.languages).toContainEqual({ language: 'typescript', files: 3 })
    expect(overview.testFiles).toContain('src/index.test.ts')
    const symbols = await findSymbols(dir)
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Service', kind: 'class', line: 3, exported: true }),
      expect.objectContaining({ name: 'runTask', kind: 'function', line: 4, exported: true }),
      expect.objectContaining({ name: 'hidden', kind: 'function', exported: false })
    ]))
  })

  it('distinguishes local and package dependencies', async () => {
    expect(await fileDependencies(dir, 'src/index.ts')).toEqual([
      expect.objectContaining({ specifier: 'node:path', kind: 'package', line: 1 }),
      expect.objectContaining({ specifier: './helper', kind: 'local', line: 2 })
    ])
  })

  it('turns real failure output into structured diagnostics', () => {
    expect(analyzeFailureOutput([
      'src/a.ts(3,7): error TS2322: Type string is not assignable to number.',
      'FAIL tests/math.test.js - expected 4',
      'src/main.go:12:2: syntax error: unexpected EOF'
    ].join('\n'))).toEqual([
      expect.objectContaining({ severity: 'error', path: 'src/a.ts', line: 3, column: 7, code: 'TS2322' }),
      expect.objectContaining({ severity: 'error', path: 'tests/math.test.js' }),
      expect.objectContaining({ severity: 'error', path: 'src/main.go', line: 12 })
    ])
  })

  it('discovers and executes package checks with real exit codes', async () => {
    fs.writeFileSync(path.join(dir, 'test.cjs'), 'console.log("tests ok")\n')
    fs.writeFileSync(path.join(dir, 'check.cjs'), 'console.error("src/x.ts(1,1): error TS0001: broken")\nprocess.exit(2)\n')
    const checks = await discoverQualityChecks(dir)
    expect(checks.map((check) => check.id)).toEqual(['npm:test', 'npm:typecheck'])
    const results = await runQualityChecks({
      root: dir,
      checks,
      sessionId: 'quality-test',
      signal: new AbortController().signal,
      timeoutMs: 10_000
    })
    expect(results).toEqual([
      expect.objectContaining({ status: 'passed', exitCode: 0, stdout: expect.stringContaining('tests ok') }),
      expect.objectContaining({ status: 'failed', exitCode: 2, issues: [expect.objectContaining({ code: 'TS0001' })] })
    ])
  })
})
