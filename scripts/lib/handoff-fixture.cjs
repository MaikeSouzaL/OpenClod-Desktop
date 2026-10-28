// The scenario of scripts/ui-handoff.cjs: the decisions given to the first model and the hidden tests that need them.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SPEC = [
  'Vamos construir a biblioteca `relatorio` em JavaScript (ESM, sem dependências, testes com `node --test`).',
  'Decisões do projeto, que valem para tudo:',
  '(1) o CSV usa ponto e vírgula como separador e as linhas terminam em CRLF, inclusive a última;',
  '(2) valores em dinheiro saem com vírgula decimal e duas casas, como 1234,50;',
  '(3) as funções públicas têm nomes em português e saem todas de src/index.js: lerLinhas(texto), validarLinha(linha), exportarCsv(linhas);',
  '(4) lerLinhas devolve objetos {nome, valor} com valor numérico (10,5 vira 10.5) e usa a primeira linha como cabeçalho;',
  '(5) validarLinha lança RangeError com a mensagem exata "valor negativo não permitido" quando valor < 0;',
  '(6) exportarCsv escreve o cabeçalho "nome;valor", uma linha por registro e, no fim, a linha de rodapé "# total;<soma dos valores no mesmo formato>".',
  'Plano em 3 passos: passo 1 lerLinhas, passo 2 validarLinha, passo 3 exportarCsv.',
  'Registre o plano com update_plan. Faça SÓ os passos 1 e 2 agora, com testes que passem, e pare. O passo 3 fica para depois.'
].join('\n')

// Written to the project only while the tests run. The namespace import keeps the steps independent: a project that has
// not implemented exportarCsv still gets a result for steps 1 and 2.
const HIDDEN_TEST = [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import * as lib from '../src/index.js'",
  '',
  "test('passo 1: lerLinhas converte o valor e usa o cabeçalho', () => {",
  "  assert.deepEqual(lib.lerLinhas('nome;valor\\r\\nAna;10,5\\r\\n'), [{ nome: 'Ana', valor: 10.5 }])",
  '})',
  "test('passo 2: validarLinha recusa valor negativo com a mensagem exata', () => {",
  "  assert.throws(() => lib.validarLinha({ nome: 'x', valor: -1 }), (error) => error instanceof RangeError && error.message === 'valor negativo não permitido')",
  "  assert.doesNotThrow(() => lib.validarLinha({ nome: 'x', valor: 0 }))",
  '})',
  "test('passo 3: exportarCsv usa ; CRLF, vírgula decimal com duas casas', () => {",
  "  assert.equal(typeof lib.exportarCsv, 'function', 'exportarCsv não é exportada por src/index.js')",
  "  const csv = lib.exportarCsv([{ nome: 'Ana', valor: 1234.5 }, { nome: 'Bia', valor: 10 }])",
  "  assert.ok(csv.startsWith('nome;valor\\r\\nAna;1234,50\\r\\nBia;10,00\\r\\n'), JSON.stringify(csv))",
  "  assert.ok(csv.endsWith('\\r\\n'), 'a última linha também termina em CRLF')",
  '})',
  "test('passo 3: exportarCsv termina com o rodapé de total', () => {",
  "  assert.equal(typeof lib.exportarCsv, 'function', 'exportarCsv não é exportada por src/index.js')",
  "  const csv = lib.exportarCsv([{ nome: 'Ana', valor: 1234.5 }, { nome: 'Bia', valor: 10 }])",
  "  assert.ok(csv.includes('# total;1244,50\\r\\n'), JSON.stringify(csv))",
  '})',
  ''
].join('\n')

const TEST_NAMES = [
  'passo 1: lerLinhas converte o valor e usa o cabeçalho',
  'passo 2: validarLinha recusa valor negativo com a mensagem exata',
  'passo 3: exportarCsv usa ; CRLF, vírgula decimal com duas casas',
  'passo 3: exportarCsv termina com o rodapé de total'
]

function hiddenTests(project) {
  const dir = path.join(project, 'test')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'zz-oculto.test.js')
  fs.writeFileSync(file, HIDDEN_TEST)
  if (!fs.existsSync(path.join(project, 'package.json'))) fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}\n')
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: project, encoding: 'utf8', timeout: 60000 })
  fs.rmSync(file, { force: true })
  const out = `${run.stdout}\n${run.stderr}`
  // A name that did not report is a failure (the project did not even load).
  const results = Object.fromEntries(TEST_NAMES.map((name) => [name, false]))
  for (const match of out.matchAll(/^\s*(not ok|ok) \d+ - (.+)$/gm)) {
    const name = match[2].trim()
    if (name in results) results[name] = match[1] === 'ok'
  }
  return results
}

function fileTree(project) {
  const list = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else list.push(path.relative(project, full).replace(/\\/g, '/'))
    }
  }
  walk(project)
  return list.sort()
}

module.exports = { SPEC, HIDDEN_TEST, TEST_NAMES, hiddenTests, fileTree }

// node scripts/lib/handoff-fixture.cjs <project folder>   -> runs the hidden tests on a folder
if (require.main === module) console.log(JSON.stringify({ files: fileTree(process.argv[2]), hidden: hiddenTests(process.argv[2]) }, null, 2))
