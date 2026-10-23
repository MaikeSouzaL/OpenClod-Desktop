const fs = require('node:fs')
const b = fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/claude-asar/app.asar')
const s = b.toString('utf8')
const needles = [
  'Como posso ajudar',
  'No que você',
  'O que você quer',
  'De volta',
  'Digite /',
  'Cowork',
  'Automatize',
  'Automações',
  'Tarefas agendadas'
]
for (const needle of needles) {
  let idx = 0
  let count = 0
  console.log('###', needle)
  while (count < 3) {
    const i = s.indexOf(needle, idx)
    if (i === -1) break
    idx = i + needle.length
    count += 1
    console.log(s.slice(Math.max(0, i - 150), i + 110).replace(/[\u0000-\u001f]/g, '.'))
    console.log('---')
  }
  console.log('count', count)
}
