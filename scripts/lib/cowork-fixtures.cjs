// Test folders for scripts/ui-cowork.cjs: what a person would drop in front of Cowork (a messy folder, the raw material for
// a report, a pile of documents to compare). Everything is deterministic so the script can compute the right answers itself
// and compare them with what the agent delivered.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { strToU8, zipSync } = require('fflate')

function write(dir, name, content, when) {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  if (when) fs.utimesSync(target, new Date(when), new Date(when))
  return target
}

// 1x1 PNG (valid), so the "images" are real files that open.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A messy "Downloads" folder: 13 files, inconsistent names, one exact duplicate, dates only inside the files. */
function messyFolder(dir) {
  const csvQ1 = 'mes,total\n2026-01,10200\n2026-02,11800\n2026-03,13150\n'
  write(dir, 'nota fiscal marco 2026 (1).txt', 'NOTA FISCAL 1021\nData de emissão: 2026-03-10\nCliente: Padaria Sol\nValor: R$ 1.250,00\n', '2026-03-11')
  write(dir, 'nota-fiscal-abril.txt', 'NOTA FISCAL 1044\nData de emissão: 2026-04-14\nCliente: Mercado Central\nValor: R$ 980,50\n', '2026-04-15')
  write(dir, 'NF_maio_final_v2.txt', 'NOTA FISCAL 1067\nData de emissão: 2026-05-09\nCliente: Oficina Beta\nValor: R$ 2.310,00\n', '2026-05-10')
  write(dir, 'contrato_clienteA_assinado.txt', 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS\nCliente A\nVigência a partir de 2026-01-15\nStatus: assinado\n', '2026-01-16')
  write(dir, 'contrato clienteB rascunho.txt', 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS\nCliente B\nVigência prevista: 2026-02-20\nStatus: rascunho\n', '2026-02-18')
  write(dir, 'ata reuniao 12-03.txt', 'ATA DA REUNIÃO — 2026-03-12\nPauta: metas do trimestre\nDecisão: contratar mais um vendedor.\n', '2026-03-12')
  write(dir, 'ata_reuniao_19_03.md', '# Ata da reunião — 2026-03-19\nPauta: revisão de preços\nDecisão: manter preços até junho.\n', '2026-03-19')
  write(dir, 'vendas_q1.csv', csvQ1, '2026-04-02')
  write(dir, 'vendas q1 (copia).csv', csvQ1, '2026-04-03') // exact duplicate of vendas_q1.csv
  write(dir, 'vendas q2 FINAL.csv', 'mes,total\n2026-04,14100\n2026-05,15250\n2026-06,16900\n', '2026-07-01')
  write(dir, 'foto_equipe.png', PNG, '2026-05-20')
  write(dir, 'logo antigo.png', PNG, '2025-11-02')
  write(dir, 'lista de tarefas.txt', '- ligar para o contador\n- renovar domínio\n- revisar contrato do cliente B\n', '2026-06-05')
}

/** Every file under `dir`: relative path, size and a hash of the content (so a rename is not a loss and a loss is visible). */
function snapshot(dir) {
  const out = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, rel)
      else out.push({ rel, size: fs.statSync(full).size, hash: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) })
    }
  }
  walk(dir, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
const REGIONS = ['Sul', 'Sudeste', 'Nordeste']
const PRODUCTS = [
  ['Plano Basico', 199],
  ['Plano Pro', 499]
]

/** Raw material for the report: a sales CSV, targets, meeting notes and a house-rule CLAUDE.md (the folder instructions). */
function salesFolder(dir) {
  const rows = []
  MONTHS.forEach((month, m) =>
    REGIONS.forEach((region, r) =>
      PRODUCTS.forEach(([product, price], p) => {
        const units = 40 + ((m * 7 + r * 13 + p * 5) % 23)
        rows.push({ month, region, product, units, revenue: units * price })
      })
    )
  )
  write(dir, 'vendas_2026.csv', ['mes,regiao,produto,unidades,receita', ...rows.map((row) => `${row.month},${row.region},${row.product},${row.units},${row.revenue}`)].join('\n') + '\n')
  write(dir, 'metas.txt', 'Meta de receita do semestre: R$ 480.000\nMeta por região: Sul R$ 150.000; Sudeste R$ 200.000; Nordeste R$ 130.000\n')
  write(
    dir,
    'reuniao-diretoria.md',
    '# Reunião da diretoria — 2026-07-03\n\n## Decisões\n1. Priorizar o Plano Pro no Sudeste.\n2. Rever o preço do Plano Basico no Nordeste.\n3. Abrir um canal de vendas online no Sul.\n\n## Ações\n- Ana: proposta de preços até 15/07.\n- Beto: plano do canal online até 31/07.\n'
  )
  write(dir, 'CLAUDE.md', '# Instruções desta pasta\n- Escreva em português do Brasil.\n- Todo documento entregue (relatório, planilha ou apresentação) deve conter, em algum lugar visível, o texto exato: Preparado pela Equipe Alfa\n')
  const total = rows.reduce((sum, row) => sum + row.revenue, 0)
  const byRegion = Object.fromEntries(REGIONS.map((region) => [region, rows.filter((row) => row.region === region).reduce((sum, row) => sum + row.revenue, 0)]))
  const byProduct = Object.fromEntries(PRODUCTS.map(([product]) => [product, rows.filter((row) => row.product === product).reduce((sum, row) => sum + row.revenue, 0)]))
  const byMonth = Object.fromEntries(MONTHS.map((month) => [month, rows.filter((row) => row.month === month).reduce((sum, row) => sum + row.revenue, 0)]))
  return { rows, total, byRegion, byProduct, byMonth, targets: { total: 480000, Sul: 150000, Sudeste: 200000, Nordeste: 130000 } }
}

const COMPETITORS = [
  ['Alfa Cloud', 'R$ 89/mês', 'fatia de 24%', 'integrações nativas com 40 sistemas', 'suporte só por e-mail'],
  ['Beta Soft', 'R$ 129/mês', 'fatia de 18%', 'aplicativo móvel premiado', 'sem plano gratuito'],
  ['Gama Systems', 'R$ 59/mês', 'fatia de 15%', 'preço mais baixo do mercado', 'relatórios limitados'],
  ['Delta One', 'R$ 149/mês', 'fatia de 12%', 'automação de fluxos sem código', 'curva de aprendizado alta'],
  ['Épsilon Hub', 'R$ 99/mês', 'fatia de 9%', 'suporte 24 horas em português', 'poucas integrações'],
  ['Zeta Labs', 'R$ 179/mês', 'fatia de 7%', 'análises com inteligência artificial', 'preço acima da média']
]

/** Six one-page profiles to compare (the long, splittable task). */
function researchFolder(dir) {
  COMPETITORS.forEach(([name, price, share, strength, weakness], index) => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')
    const body = [
      `# Ficha do concorrente: ${name}`,
      '',
      `- Preço de entrada: ${price}`,
      `- Participação de mercado: ${share}`,
      `- Ponto forte: ${strength}`,
      `- Ponto fraco: ${weakness}`,
      '',
      '## Histórico',
      ...Array.from({ length: 12 }, (_, line) => `Em 202${3 + (line % 3)}, a ${name} anunciou a novidade número ${line + 1} (prioridade ${(index + line) % 5 + 1}) voltada ao segmento de pequenas empresas.`),
      '',
      '## Clientes citados',
      ...Array.from({ length: 6 }, (_, line) => `- Cliente ${String.fromCharCode(65 + line)} (${name.split(' ')[0]}-${100 + line * 7 + index})`)
    ].join('\n')
    write(dir, `concorrente-${slug}.md`, body + '\n')
  })
  write(dir, 'pergunta.md', '# Pergunta da diretoria\nQual concorrente é a maior ameaça ao nosso plano de R$ 99/mês e por quê?\n')
  return { competitors: COMPETITORS.map(([name, price, share, strength, weakness]) => ({ name, price, share, strength, weakness })) }
}

/** Notes for the interrupted job (three documents to be written from them, one after the other). */
function notesFolder(dir) {
  write(dir, 'notas/produto.txt', 'Lançamento do aplicativo Horizonte previsto para 15 de setembro de 2026.\nPúblico: pequenos varejistas.\nDiferencial: cobrança por Pix integrada.\n')
  write(dir, 'notas/riscos.txt', 'Risco 1: atraso do fornecedor de pagamentos (probabilidade alta).\nRisco 2: baixa adesão no primeiro mês (probabilidade média).\nRisco 3: falha de segurança no login (probabilidade baixa, impacto alto).\n')
  write(dir, 'notas/equipe.txt', 'Equipe: 2 desenvolvedores, 1 designer, 1 analista de suporte.\nOrçamento total: R$ 90.000.\n')
}

module.exports = { write, messyFolder, snapshot, salesFolder, researchFolder, notesFolder, COMPETITORS, MONTHS, REGIONS, PRODUCTS }
