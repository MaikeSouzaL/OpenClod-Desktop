// Freezes the BUILT app (out/ + package.json) into a temp folder so end-to-end runs and A/B comparisons do not depend
// on what `electron-vite build` writes to out/ meanwhile. node_modules and resources are linked, not copied.
//
//   node scripts/snapshot-app.cjs <label>      -> prints the folder; use it with `--root <folder>` in scripts/ui-*.cjs
//   node scripts/snapshot-app.cjs --remove <folder>
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

if (process.argv[2] === '--remove') {
  const target = path.resolve(process.argv[3] || '')
  if (!path.basename(target).startsWith('openclod-snap-')) throw new Error('recuso apagar uma pasta que não é um snapshot')
  // node_modules and resources are junctions to the project: take the links off first (rmdir on a junction removes only the
  // link), so that the recursive removal below can never reach what they point to.
  for (const link of ['node_modules', 'resources']) {
    try {
      fs.rmdirSync(path.join(target, link))
    } catch {
      /* not there */
    }
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
  console.log('removido', target)
  process.exit(0)
}

const label = (process.argv[2] || 'build').replace(/[^\w.-]+/g, '-')
// `--from <folder>`: a build made with `electron-vite build --outDir <folder>` (it leaves the app's own out/ alone).
const fromIndex = process.argv.indexOf('--from')
const built = fromIndex > 0 ? path.resolve(process.argv[fromIndex + 1]) : path.join(ROOT, 'out')
if (!fs.existsSync(path.join(built, 'main', 'index.js'))) throw new Error(`${built} não tem um build (main/index.js): rode npm run build, ou electron-vite build --outDir`)
const target = path.join(os.tmpdir(), `openclod-snap-${label}-${Date.now().toString(36)}`)
fs.mkdirSync(target, { recursive: true })
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(target, 'package.json'))
copyDir(built, path.join(target, 'out'))
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(target, 'node_modules'), 'junction')
fs.symlinkSync(path.join(ROOT, 'resources'), path.join(target, 'resources'), 'junction')
console.log(target)
