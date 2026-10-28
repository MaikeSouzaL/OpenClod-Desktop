// Packs resources/chrome-extension into release/openclod-chrome-extension-v<versão>.zip (manifest.json at the root).
// The same zip loads with "Load unpacked" after unzipping, or can be uploaded to the Chrome Web Store.
//   node scripts/pack-chrome-extension.mjs [pasta-de-destino]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Reuse the app's own packer (src/main/chrome/package.ts) so the zip is byte-for-byte what Settings exports.
const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-pack-')), 'package.cjs')
buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'chrome', 'package.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'silent'
})
const { extensionVersion, zipExtension } = require(bundle)

const source = path.join(root, 'resources', 'chrome-extension')
const version = extensionVersion(source)
if (!version) throw new Error('manifest.json da extensão sem versão')
const destinationDir = path.resolve(process.argv[2] || path.join(root, 'release'))
const result = zipExtension(source, path.join(destinationDir, `openclod-chrome-extension-v${version}.zip`))
console.log(`${path.relative(root, result.path)} · ${result.files} arquivos · ${(result.bytes / 1024).toFixed(1)} KB`)
