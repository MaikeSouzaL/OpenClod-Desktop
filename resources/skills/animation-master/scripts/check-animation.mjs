#!/usr/bin/env node
// Checks for animated SVG / HTML / CSS files.
//   node check-animation.mjs <arquivo.svg|.html|.css>                static checks, no dependencies
//   node check-animation.mjs <arquivo.svg|.html> --frames [--times 0,250,500,750,1000] [--size 120] [--out pasta]
//                                                                    ALSO renders the file in a real headless Chrome/Edge
//                                                                    at different instants and measures how many pixels
//                                                                    changed. Works for models that cannot see images:
//                                                                    "changed: true" means it really moves. The PNG
//                                                                    frames are saved so a model with vision can look.
// Prints a JSON report and ERRO/AVISO lines; exits 1 when there is at least one error.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('uso: node check-animation.mjs <arquivo.svg|.html|.css> [--frames [--times 0,250,500] [--size 120] [--out pasta]]')
  process.exit(2)
}
const optionValue = (name) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}

const source = fs.readFileSync(file, 'utf8')
const isSvg = /\.svg$/i.test(file)
const errors = []
const warnings = []
const stats = { smil: 0, keyframes: 0, cssAnimations: 0, transitions: 0, waapi: 0, raf: 0 }

const strip = (text) => text.replace(/<!--[\s\S]*?-->/g, '')
const text = strip(source)

// ---- hard errors
if (/<script[\s>]/i.test(text) && isSvg) errors.push('script embutido em SVG')
if (/\son[a-z]+\s*=/i.test(text) && isSvg) errors.push('atributo de evento (onload/onclick...) em SVG autônomo')
if (isSvg && /(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//i.test(text)) errors.push('referência externa em SVG autônomo')
if (isSvg && !/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(text)) errors.push('falta xmlns="http://www.w3.org/2000/svg"')
if (isSvg && !/<svg[\s>]/.test(text)) errors.push('nenhum elemento <svg>')

// ---- SMIL
for (const match of text.matchAll(/<(animate|animateTransform|animateMotion|set)\b([^>]*)>/gi)) {
  stats.smil += 1
  const tag = match[1]
  const attrs = match[2]
  if (tag !== 'animateMotion' && !/attributeName\s*=/.test(attrs)) errors.push(`<${tag}> sem attributeName`)
  if (tag !== 'set' && !/\bdur\s*=/.test(attrs)) errors.push(`<${tag}> sem dur`)
  const dur = /\bdur\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]
  if (dur && /^0+(\.0+)?(s|ms)?$/.test(dur.trim())) errors.push(`<${tag}> com dur="${dur}" (nunca anima)`)
  if (dur && /^(\d+(\.\d+)?)s$/.test(dur.trim()) && Number(dur.trim().slice(0, -1)) > 20) warnings.push(`<${tag}> com dur="${dur}" (muito longa)`)
  if (/animateTransform/i.test(tag) && !/\btype\s*=/.test(attrs)) errors.push('<animateTransform> sem type')
}
const indefiniteSmil = /repeatCount\s*=\s*["']indefinite["']/.test(text)

// ---- CSS
const css = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + (/\.css$/i.test(file) ? source : '')
const keyframeNames = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))
stats.keyframes = keyframeNames.size
const animationDecls = [...css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)].map((m) => m[1])
stats.cssAnimations = animationDecls.length
stats.transitions = [...css.matchAll(/transition\s*:/g)].length
const used = new Set()
for (const declaration of animationDecls) for (const name of keyframeNames) if (new RegExp(`(^|[\\s,])${name}([\\s,;]|$)`).test(declaration)) used.add(name)
for (const name of keyframeNames) if (!used.has(name)) warnings.push(`@keyframes ${name} não é usado por nenhuma animation`)
for (const declaration of animationDecls) {
  const names = [...declaration.matchAll(/[A-Za-z_][\w-]*/g)].map((m) => m[0])
  const refersToKnown = names.some((n) => keyframeNames.has(n))
  if (!refersToKnown && !/\bnone\b/.test(declaration) && keyframeNames.size) warnings.push(`animation "${declaration.trim().slice(0, 60)}" não aponta para nenhum @keyframes definido`)
}
const infiniteCss = animationDecls.some((d) => /\binfinite\b/.test(d))
const reducedGuard = /@media[^{]*prefers-reduced-motion/i.test(text)
if ((infiniteCss || indefiniteSmil) && !reducedGuard) {
  warnings.push('animação em loop sem @media (prefers-reduced-motion: reduce); quem pediu menos movimento ainda verá o loop')
}
// Layout-triggering properties inside @keyframes
for (const block of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)) {
  const props = [...block[2].matchAll(/(?:^|[;{\s])(width|height|top|left|right|bottom|margin[\w-]*|padding[\w-]*|box-shadow|filter)\s*:/g)].map((m) => m[1])
  if (props.length) warnings.push(`@keyframes ${block[1]} anima ${[...new Set(props)].join(', ')} (força layout/pintura; prefira transform/opacity)`)
}
for (const duration of css.matchAll(/animation(?:-duration)?\s*:[^;}]*?(\d+(?:\.\d+)?)(ms|s)\b/g)) {
  const seconds = duration[2] === 'ms' ? Number(duration[1]) / 1000 : Number(duration[1])
  if (seconds > 20) warnings.push(`animation com duração de ${seconds}s (muito longa)`)
}
if (/will-change\s*:/.test(css) && (css.match(/will-change\s*:/g) ?? []).length > 6) warnings.push('muitos will-change; use só nos elementos que realmente animam')

// ---- JS (HTML only)
const js = isSvg ? '' : [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n')
stats.waapi = (js.match(/\.animate\s*\(/g) ?? []).length
stats.raf = (js.match(/requestAnimationFrame\s*\(/g) ?? []).length
if (stats.raf && !/matchMedia\([^)]*prefers-reduced-motion/.test(js) && !reducedGuard) warnings.push('requestAnimationFrame sem checar prefers-reduced-motion')
if (/setInterval\s*\([^)]*(?:style|classList)/.test(js)) warnings.push('setInterval mexendo em estilo: prefira CSS/WAAPI/requestAnimationFrame')

if (!stats.smil && !stats.cssAnimations && !stats.transitions && !stats.waapi && !stats.raf) warnings.push('nenhuma animação encontrada (SMIL, CSS, WAAPI ou requestAnimationFrame)')

// ---- rendered frames (opt-in): does it really move?
function findBrowser() {
  const env = process.env
  const candidates = [
    env.CHROME_PATH,
    path.join(env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge'
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

async function loadSharp() {
  for (const base of [path.join(process.cwd(), 'package.json'), path.join(os.homedir(), 'package.json'), import.meta.url]) {
    try {
      return createRequire(base)('sharp')
    } catch {
      /* try the next place */
    }
  }
  return null
}

async function captureFrames() {
  const browser = findBrowser()
  if (!browser) return { skipped: 'nenhum Chrome/Edge encontrado; defina CHROME_PATH ou valide no navegador' }
  const times = (optionValue('--times') ?? '0,250,500,750,1000')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
  const size = Math.max(32, Math.min(800, Number(optionValue('--size')) || 120))
  if (times.length < 2) return { skipped: '--times precisa de pelo menos dois instantes' }
  const absolute = path.resolve(file)
  const outDir = path.resolve(optionValue('--out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-frames-')))
  fs.mkdirSync(outDir, { recursive: true })

  // Real time is useless here (the page loads at a different speed every run), so the page SEEKS to the instant in
  // the URL (#t=500): SMIL through setCurrentTime and CSS/Web animations through getAnimations(). Animations driven by
  // requestAnimationFrame/JS cannot be seeked; they are reported as such below.
  const seekScript =
    '<script>(function(){var t=Number((location.hash.match(/t=(\\d+(?:\\.\\d+)?)/)||[])[1]||0);' +
    'function seek(){document.querySelectorAll("svg").forEach(function(s){try{s.pauseAnimations();s.setCurrentTime(t/1000)}catch(e){}});' +
    'try{document.getAnimations().forEach(function(a){a.pause();a.currentTime=t})}catch(e){}}' +
    'addEventListener("load",function(){seek();requestAnimationFrame(seek)})})()</script>'
  const wrapper = path.join(outDir, 'quadro.html')
  if (isSvg) {
    // Inline (not <img>) so the page can reach the animations; same pictures, since the SVG has no scripts.
    const markup = source.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!DOCTYPE[\s\S]*?>/i, '')
    const inner = Math.round(size * 0.8)
    fs.writeFileSync(
      wrapper,
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}body{display:grid;place-items:center;width:${size}px;height:${size}px}svg{width:${inner}px;height:${inner}px}</style><body>${markup}${seekScript}`
    )
  } else {
    // The HTML as written, plus the seek script before </body>; relative assets keep working through <base>.
    const base = `<base href="${pathToFileURL(path.dirname(absolute) + path.sep).href}">`
    const html = /<\/body>/i.test(source) ? source.replace(/<\/body>/i, `${seekScript}</body>`) : `${source}${seekScript}`
    fs.writeFileSync(wrapper, /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${html}`)
  }
  const pageUrl = pathToFileURL(wrapper).href

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-chrome-'))
  const frames = []
  try {
    for (const time of times) {
      const png = path.join(outDir, `quadro-${String(time).padStart(5, '0')}ms.png`)
      fs.rmSync(png, { force: true })
      // stdio is ignored on purpose: a browser that inherits a pipe keeps it open after it exits and hangs the caller.
      const run = spawnSync(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--force-device-scale-factor=2',
          `--user-data-dir=${profile}`,
          `--window-size=${size},${size}`,
          '--virtual-time-budget=400',
          `--screenshot=${png}`,
          `${pageUrl}#t=${time}`
        ],
        { stdio: 'ignore', timeout: 25_000, windowsHide: true }
      )
      if (run.error && run.pid && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(run.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      if (!fs.existsSync(png)) return { skipped: `o navegador não gerou a captura de ${time} ms (${run.error?.code ?? `exit ${run.status}`})`, browser }
      frames.push({ time, file: png })
    }
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
    } catch {
      /* temp profile; the OS cleans it later */
    }
  }

  const sharp = await loadSharp()
  const hashes = frames.map((frame) => crypto.createHash('sha256').update(fs.readFileSync(frame.file)).digest('hex').slice(0, 12))
  const result = { browser: path.basename(browser), size, outDir, frames: frames.map((frame, index) => ({ time: frame.time, file: frame.file, hash: hashes[index] })) }
  if (!sharp) {
    result.changed = new Set(hashes).size > 1
    result.note = 'sharp não encontrado: comparação só por hash dos arquivos (qualquer diferença conta)'
    return result
  }
  const raw = await Promise.all(frames.map((frame) => sharp(frame.file).removeAlpha().raw().toBuffer({ resolveWithObject: true })))
  const differing = (a, b) => {
    let count = 0
    const pixels = a.info.width * a.info.height
    for (let i = 0; i < pixels; i++) {
      const o = i * a.info.channels
      if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]) > 48) count++
    }
    return Math.round((count / pixels) * 10000) / 100
  }
  result.percentDifferentFromFirst = raw.map((frame, index) => (index === 0 ? 0 : differing(raw[0], frame)))
  result.percentDifferentFromPrevious = raw.map((frame, index) => (index === 0 ? 0 : differing(raw[index - 1], frame)))
  const inkOf = (frame) => {
    let ink = 0
    const pixels = frame.info.width * frame.info.height
    for (let i = 0; i < pixels; i++) {
      const o = i * frame.info.channels
      if (frame.data[o] + frame.data[o + 1] + frame.data[o + 2] < 720) ink++
    }
    return Math.round((ink / pixels) * 10000) / 100
  }
  result.percentInk = raw.map(inkOf)
  result.changed = Math.max(...result.percentDifferentFromFirst) >= 0.1
  if (Math.max(...result.percentInk) < 0.2) result.blank = true
  return result
}

const report = { file, bytes: Buffer.byteLength(source), stats, errors, warnings }
if (process.argv.includes('--frames')) {
  if (isSvg || /\.html?$/i.test(file)) {
    report.frames = await captureFrames()
    const declared = stats.smil + stats.cssAnimations + stats.waapi + stats.raf > 0
    if (report.frames.skipped) warnings.push(`captura de quadros não executada: ${report.frames.skipped}`)
    else if (report.frames.blank) errors.push('os quadros renderizados estão em branco: o desenho não aparece')
    else if (report.frames.changed === false && declared) {
      errors.push(
        `a animação está declarada mas os quadros de ${report.frames.frames[0].time} a ${report.frames.frames.at(-1).time} ms são iguais: ` +
          'ela não roda (alvo errado, dur/delay longos demais, animação que só começa com JavaScript ou com interação)'
      )
    }
  } else {
    warnings.push('--frames só renderiza .svg e .html')
  }
}
console.log(JSON.stringify(report, null, 2))
for (const e of errors) console.error(`ERRO: ${e}`)
for (const w of warnings) console.error(`AVISO: ${w}`)
process.exit(errors.length ? 1 : 0)
