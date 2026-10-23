const fs = require('node:fs')
const b = fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/claude-asar/app.asar')
const s = b.toString('latin1')
const needles = [
  'Back at it',
  'coworkTabEnabled',
  'Cowork home',
  'coworkHome',
  'Start a task',
  'scheduled',
  'Cowork session',
  'De volta',
  'What should we',
  'Let Claude work'
]
for (const needle of needles) {
  let idx = 0
  let count = 0
  console.log('###', needle)
  while (count < 4) {
    const i = s.indexOf(needle, idx)
    if (i === -1) break
    idx = i + needle.length
    count += 1
    console.log(s.slice(Math.max(0, i - 260), i + 200).replace(/[^\x20-\x7e]/g, '.'))
    console.log('---')
  }
  console.log('count', count)
}
