#!/usr/bin/env node
/**
 * Validador de SVG da skill svg-master.
 *
 * Uso:
 *   node check-svg.mjs <arquivo.svg> [--render]
 *
 * Sem dependências: valida estrutura, segurança, viewBox, ids e referências.
 * Com `--render`, usa `sharp` se estiver disponível para rasterizar em vários
 * tamanhos e medir cobertura/limite do desenho. Não falha se o sharp não existir;
 * avisa que a checagem visual não foi feita.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--'))
const render = args.includes('--render')
const errors = []
const warnings = []
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)

if (!file) {
  console.error('uso: node check-svg.mjs <arquivo.svg> [--render]')
  process.exit(2)
}

const absolute = path.resolve(file)
let svg
try {
  svg = fs.readFileSync(absolute, 'utf8')
} catch (err) {
  console.error(`não foi possível ler ${absolute}: ${err.message}`)
  process.exit(2)
}

if (!svg.trim()) fail('arquivo vazio')
if (svg.length > 300_000) warn(`arquivo grande (${Math.round(svg.length / 1024)} KB); considere simplificar`)
if (!/<svg[\s>]/i.test(svg)) fail('não há elemento raiz <svg>')
if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(svg)) {
  fail('falta xmlns="http://www.w3.org/2000/svg"')
}

const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)?.[1]
if (!viewBox) {
  fail('falta viewBox')
} else {
  const numbers = viewBox.trim().split(/[\s,]+/).map(Number)
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) {
    fail(`viewBox inválido: "${viewBox}"`)
  } else if (numbers[2] <= 0 || numbers[3] <= 0) {
    fail(`viewBox com largura/altura não positiva: "${viewBox}"`)
  } else {
    if (numbers[0] !== 0 || numbers[1] !== 0) warn(`viewBox começa em ${numbers[0]},${numbers[1]}; prefira 0 0`)
    if (Math.abs(numbers[2] - numbers[3]) > 0.01) warn(`viewBox não quadrado (${numbers[2]}×${numbers[3]})`)
  }
}

for (const [pattern, message] of [
  [/<script\b/i, 'script embutido'],
  [/<foreignObject\b/i, 'foreignObject'],
  [/\son[a-z]+\s*=/i, 'atributo de evento inline (on*)'],
  [/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|file:|data:)/i, 'referência externa/bitmap embutido'],
  [/<image\b/i, 'elemento <image> (bitmap)'],
  [/<iframe\b/i, 'iframe embutido']
]) {
  if (pattern.test(svg)) fail(message)
}
if (/<text\b/i.test(svg)) warn('usa <text>; prefira caminhos para o ícone não depender de fonte')
if (/<filter\b/i.test(svg)) warn('usa <filter>; filtros costumam sumir ou pesar em 16 px')
if (!/<title\b/i.test(svg)) warn('sem <title> (recomendado para SVG autônomo)')

const ids = [...svg.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
if (duplicates.length) fail(`ids duplicados: ${duplicates.join(', ')}`)

const idSet = new Set(ids)
const references = [...svg.matchAll(/(?:url\(\s*#|(?:xlink:)?href\s*=\s*["']#)([^)"'\s]+)/gi)].map((match) => match[1])
for (const reference of new Set(references)) {
  if (!idSet.has(reference)) fail(`referência #${reference} não existe`)
}

if (!/(?:fill|stroke)\s*=\s*["']currentColor["']/i.test(svg) && !/(?:fill|stroke)\s*=\s*["']none["']/i.test(svg)) {
  warn('não usa currentColor nem fill="none"; confirme as cores nos dois temas')
}

const result = { file: absolute, bytes: Buffer.byteLength(svg), errors, warnings, render: [] }

async function loadSharp() {
  for (const base of [path.join(process.cwd(), 'package.json'), path.join(os.homedir(), 'package.json')]) {
    try {
      const require = createRequire(base)
      return require('sharp')
    } catch {
      /* tenta o próximo */
    }
  }
  try {
    const require = createRequire(import.meta.url)
    return require('sharp')
  } catch {
    return null
  }
}

if (render) {
  const sharp = await loadSharp()
  if (!sharp) {
    warn('sharp não encontrado; rasterização/checagem visual não executada')
  } else {
    for (const size of [16, 24, 32, 48, 128, 256]) {
      try {
        const { data, info } = await sharp(Buffer.from(svg))
          .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        const { width, height, channels } = info
        let painted = 0
        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const alpha = data[(y * width + x) * channels + 3]
            if (alpha > 8) {
              painted++
              if (x < minX) minX = x
              if (y < minY) minY = y
              if (x > maxX) maxX = x
              if (y > maxY) maxY = y
            }
          }
        }
        const ratio = painted / (width * height)
        if (painted === 0) fail(`render ${size}px ficou vazio`)
        if (ratio > 0.92) warn(`render ${size}px preenche ${(ratio * 100).toFixed(0)}% do quadro; falta respiro`)
        if (painted > 0 && (minX <= 0 || minY <= 0 || maxX >= width - 1 || maxY >= height - 1)) {
          warn(`render ${size}px encosta na borda; revise a área segura`)
        }
        result.render.push({ size, painted, coverage: Number(ratio.toFixed(3)), bbox: [minX, minY, maxX, maxY] })
      } catch (err) {
        fail(`não foi possível rasterizar em ${size}px: ${err.message}`)
      }
    }
  }
}

console.log(JSON.stringify(result, null, 2))
for (const error of errors) console.error(`ERRO: ${error}`)
for (const message of warnings) console.error(`AVISO: ${message}`)
process.exitCode = errors.length ? 1 : 0
