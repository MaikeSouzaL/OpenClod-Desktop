const fs = require('node:fs')
const b = fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/claude-asar/app.asar')
const s = b.toString('latin1')
const out = []
let idx = 0
while (idx < s.length) {
  const i = s.indexOf('Cowork', idx)
  if (i === -1) break
  idx = i + 6
  const seg = s.slice(Math.max(0, i - 120), i + 90).replace(/[^\x20-\x7e]/g, '.')
  if (/tab|Tab|Chat|label|title|nav|sidebar/i.test(seg)) out.push(seg)
}
console.log(out.slice(0, 40).join('\n---\n'))
console.log('total', out.length)
