// Renders resources/chrome-extension/icons/icon.svg into the PNG sizes Chrome asks for.
//   node scripts/make-extension-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'resources', 'chrome-extension', 'icons')
const svg = fs.readFileSync(path.join(dir, 'icon.svg'))

for (const size of [16, 32, 48, 128]) {
  const file = path.join(dir, `${size}.png`)
  await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file)
  console.log(`${path.relative(root, file)} (${fs.statSync(file).size} bytes)`)
}
