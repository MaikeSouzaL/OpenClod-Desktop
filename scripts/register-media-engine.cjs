// Registers resources/media/forja_media.py in resources/MANIFEST.json (name, size, sha256) without running the whole
// embed-stt.mjs again. embed-stt.mjs writes the same entry when it runs, so the two always agree.
//
//   node scripts/register-media-engine.cjs
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const script = path.join(root, 'resources', 'media', 'forja_media.py')
const manifestPath = path.join(root, 'resources', 'MANIFEST.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entry = {
  name: 'forja_media.py',
  kind: 'script',
  version: '1',
  source: 'resources/media/forja_media.py (frame logic ported from claude-real-video, MIT, (c) 2026 LeoAido)',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'),
  files: 1,
  size: fs.statSync(script).size,
  license: 'MIT',
  group: 'stt'
}
const at = manifest.entries.findIndex((item) => item.name === entry.name)
if (at >= 0) manifest.entries[at] = entry
else manifest.entries.push(entry)
const raw = fs.readFileSync(manifestPath, 'utf8')
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + (raw.endsWith('\n') ? '\n' : ''))
console.log(`${at >= 0 ? 'atualizada' : 'adicionada'} a entrada ${entry.name}: ${entry.size} bytes, sha256 ${entry.sha256.slice(0, 12)}…`)
