import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * check-animation.mjs --frames: the check a model WITHOUT vision uses to know whether an animation really moves.
 * It renders the file in a real headless Chrome/Edge at fixed instants (seeking the animation, so the result does
 * not depend on how fast the machine is) and measures how many pixels changed. Skips when there is no browser.
 */
const SCRIPT = path.join(__dirname, '..', 'resources', 'skills', 'animation-master', 'scripts', 'check-animation.mjs')
const BROWSER = [
  process.env.CHROME_PATH,
  path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((candidate) => candidate && fs.existsSync(candidate))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-frames-test-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }))

interface Frames {
  changed: boolean
  blank?: boolean
  percentDifferentFromFirst: number[]
  percentInk: number[]
  frames: Array<{ time: number; file: string }>
}

function check(name: string, content: string, ...extra: string[]): { status: number | null; report: { frames: Frames; errors: string[] }; stderr: string } {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  const run = spawnSync(process.execPath, [SCRIPT, file, '--frames', '--out', path.join(dir, `${name}-out`), ...extra], { encoding: 'utf8', timeout: 60_000 })
  return { status: run.status, report: JSON.parse(run.stdout), stderr: run.stderr }
}

const SPINNER = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e8590c" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 0 1 9 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>'

describe.skipIf(!BROWSER)('check-animation --frames', () => {
  it('sees a SMIL spinner move, the same way every run, and saves the PNG frames', () => {
    const first = check('spin.svg', SPINNER)
    const again = check('spin2.svg', SPINNER)
    expect(first.report.frames.changed).toBe(true)
    expect(first.report.frames.blank).toBeUndefined()
    // quarter-turn positions differ clearly; one full turn at 1000 ms is back where it started
    expect(first.report.frames.percentDifferentFromFirst[1]).toBeGreaterThan(2)
    expect(first.report.frames.percentDifferentFromFirst.at(-1)).toBeLessThan(0.5)
    expect(again.report.frames.percentDifferentFromFirst).toEqual(first.report.frames.percentDifferentFromFirst)
    for (const frame of first.report.frames.frames) expect(fs.statSync(frame.file).size).toBeGreaterThan(200)
    expect(first.status).toBe(0)
  }, 90_000)

  it('sees a CSS @keyframes animation in an SVG and in an HTML page', () => {
    const css = '<style>@keyframes g{to{transform:rotate(360deg)}}.r{transform-origin:12px 12px;animation:g 2s linear infinite}</style>'
    const svg = check('css.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${css}<rect class="r" x="3" y="9" width="18" height="6" fill="#222"/></svg>`, '--times', '0,500,1000')
    expect(svg.report.frames.changed).toBe(true)
    const html = check(
      'page.html',
      `<!doctype html><title>t</title><style>@keyframes m{from{transform:translateX(0)}to{transform:translateX(60px)}}div{width:20px;height:20px;background:#c00;animation:m 2s linear infinite}</style><body><div></div></body>`,
      '--times', '0,500,1000'
    )
    expect(html.report.frames.changed).toBe(true)
  }, 90_000)

  it('fails a declared animation that does not move, naming the likely causes', () => {
    const still = check('still.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"><animate attributeName="r" from="8" to="8" dur="1s" repeatCount="indefinite"/></circle></svg>')
    expect(still.report.frames.changed).toBe(false)
    expect(still.status).toBe(1)
    expect(still.stderr).toMatch(/ela não roda/)
  }, 60_000)

  it('flags an empty rendering instead of calling it "unchanged"', () => {
    const empty = check('empty.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g><animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite"/></g></svg>')
    expect(empty.report.frames.blank).toBe(true)
    expect(empty.status).toBe(1)
    expect(empty.stderr).toMatch(/em branco/)
  }, 60_000)
})
