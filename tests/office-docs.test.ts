import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SkillLibrary } from '../src/core/skills/library'
import { officeLibraries, officeRuntime } from '../src/core/util/office-runtime'
import { makeTempDir, removeTempDir } from './helpers'

// The recipes of the docx / xlsx / pptx skills, run for real on the embedded Python (python-docx, XlsxWriter, python-pptx),
// then read back by `openclod-office inspect` (and, where LibreOffice is installed, opened and recalculated by it). Skipped when the
// embedded runtime is not built (it is rebuilt with scripts/embed-stt.mjs + scripts/embed-office.mjs).

const runtime = process.platform === 'win32' ? officeRuntime() : null
const run = runtime ? describe : describe.skip
const skills = path.join(__dirname, '..', 'resources', 'skills')

let work = ''

function python(args: string[], options: { isolated?: boolean } = {}): { code: number; out: string } {
  const result = spawnSync(runtime!.python, [...(options.isolated ? ['-I'] : []), '-X', 'utf8', ...args], { encoding: 'utf8', cwd: work, windowsHide: true, timeout: 240_000 })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const office = (...args: string[]): { code: number; out: string } => python([runtime!.engine, ...args], { isolated: true })

function inspect(file: string, full = false): Record<string, any> {
  const result = office('inspect', file, '--json', ...(full ? ['--full'] : []))
  expect(result.code, result.out).toBe(0)
  return JSON.parse(result.out)
}

/** Runs a recipe with its own sample data (no CSV) unless `extra` brings one; returns the file it wrote. */
function recipe(skill: string, name: string, out: string, extra: string[] = []): string {
  const target = path.join(work, out)
  const result = python([path.join(skills, skill, 'receitas', name), ...extra, '--saida', target])
  expect(result.code, result.out).toBe(0)
  expect(fs.existsSync(target)).toBe(true)
  return target
}

const MANDATORY = ['--rodape', 'Preparado pela Equipe Alfa']

/** Text of every part of an Office file (zip) whose name matches `pattern`. */
function parts(file: string, pattern: RegExp): string[] {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(file)))
  return Object.keys(entries).filter((name) => pattern.test(name)).map((name) => strFromU8(entries[name]))
}

// Decided while the tests are collected (it.skipIf is evaluated then): is LibreOffice installed?
const hasLibreOffice = runtime
  ? Boolean(JSON.parse(spawnSync(runtime.python, ['-I', '-X', 'utf8', runtime.engine, 'check', '--json'], { encoding: 'utf8', windowsHide: true }).stdout || '{}').libreoffice)
  : false

beforeAll(async () => {
  if (!runtime) return
  work = await makeTempDir('openclod-office-docs-')
}, 120_000)

afterAll(async () => {
  if (work) await removeTempDir(work)
})

run('the embedded document runtime', () => {
  it('has every library of the closure at the pinned versions, and the pylib folder on the interpreter path', () => {
    expect(officeLibraries(runtime)).toMatchObject({ 'python-docx': '1.2.0', openpyxl: '3.1.5', 'python-pptx': '1.0.2', XlsxWriter: '3.3.0', Pillow: '12.3.0', lxml: '6.1.1' })
    const result = python(['-c', 'import sys, openclod_office, docx, openpyxl, pptx, xlsxwriter, PIL, lxml.etree; print(openclod_office.__file__)'], { isolated: true })
    expect(result.code, result.out).toBe(0)
    expect(result.out.trim().toLowerCase()).toContain(path.join('resources', 'office', 'pylib').toLowerCase())
  })

  it('check says everything is ready and that nothing is to be installed', () => {
    const result = office('check')
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('Tudo pronto')
    expect(result.out).toContain('NÃO instale pacotes')
    const json = JSON.parse(office('check', '--json').out)
    expect(json.ok).toBe(true)
    expect(json.missing).toEqual([])
  })

  it('embed-office --check agrees (pinned wheels, ._pth entry, a clean-environment build of the three formats)', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'embed-office.mjs'), '--check'], { encoding: 'utf8', timeout: 180_000 })
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  }, 200_000)
})

run('docx recipe', () => {
  it('writes a report with executive summary, a table with its total, a chart image, conclusions and page numbers', () => {
    const file = recipe('docx', 'relatorio.py', 'relatorio.docx', MANDATORY)
    const info = inspect(file)
    expect(info.kind).toBe('docx')
    expect(info.headings.map((h: { text: string }) => h.text)).toEqual(expect.arrayContaining(['Resumo executivo', 'Receita por região', 'Conclusões e recomendações']))
    const table = info.tables.find((t: { cols: number }) => t.cols === 5)
    expect(table.header).toEqual(['Região', 'Receita', '% do total', 'Meta', 'Atingimento'])
    expect(table.rows).toBe(5) // header + 3 regions + total
    expect(table.preview.at(-1)[0]).toBe('Total')
    expect(table.preview.at(-1)[1]).toMatch(/^R\$ \d{1,3}(\.\d{3})+$/)
    expect(info.images).toBe(1)
    expect(info.pageNumbers).toBe(true)
    expect(info.footer).toContain('Preparado pela Equipe Alfa')
    expect(info.warnings).toEqual([])
    // the mandatory text of the folder instructions is in the body too (a reader of the XML sees it, not only the footer)
    const body = inspect(file, true).text as string
    expect(body).toContain('Resumo executivo')
    expect(spawnSync(runtime!.python, ['-I', '-c', 'import docx,sys; d=docx.Document(sys.argv[1]); print(any("Preparado pela Equipe Alfa" in p.text for p in d.paragraphs))', file], { encoding: 'utf8' }).stdout.trim()).toBe('True')
  })

  it('quick path: a CSV, the folder metas, the mandatory text and our own conclusions, in one command', () => {
    const csv = path.join(work, 'vendas.csv')
    fs.writeFileSync(csv, 'mes,regiao,produto,unidades,receita\nJan,Sul,Plano Pro,10,1000\nJan,Sudeste,Plano Pro,20,3500\nFev,Sul,Plano Pro,10,2000\n', 'utf8')
    const file = recipe('docx', 'relatorio.py', 'do-csv.docx', [csv, ...MANDATORY, '--meta', 'Sul=2500', '--meta', 'Sudeste=3000', '--conclusao', 'Sudeste superou a meta em 17%', '--conclusao', 'Sul ficou 20% acima da meta'])
    const info = inspect(file)
    const table = info.tables.find((t: { cols: number }) => t.cols === 5)
    expect(table.preview.map((row: string[]) => row[0])).toEqual(['Região', 'Sudeste', 'Sul', 'Total'])
    expect(table.preview.at(-1)[1]).toBe('R$ 6.500')
    expect(table.preview.at(-1)[3]).toBe('R$ 5.500') // the metas that were given, summed
    const text = inspect(file, true).text as string
    expect(text).toContain('Sudeste superou a meta em 17%')
    expect(text).not.toContain('Revisar metas e preços') // the generic conclusions are replaced
    expect(info.footer).toContain('Preparado pela Equipe Alfa')
  })

  it('reads a Brazilian CSV (; separator, accents in the header, 1.234,56 numbers) and, with no metas, leaves meta and attainment out', () => {
    const csv = path.join(work, 'vendas-br.csv')
    fs.writeFileSync(csv, 'Mês;Região;Produto;Unidades;Receita\n2026-01;Sul;Plano Pro;10;R$ 1.234,56\n2026-01;Norte;Plano Pro;20;2.000,00\n', 'utf8')
    const file = recipe('docx', 'relatorio.py', 'do-csv-br.docx', [csv])
    const table = inspect(file).tables.find((t: { header: string[] }) => t.header[0] === 'Região')
    expect(table.header).toEqual(['Região', 'Receita', '% do total'])
    expect(table.preview.map((row: string[]) => row[0])).toEqual(['Região', 'Norte', 'Sul', 'Total'])
    expect(table.preview.at(-1)[1]).toBe('R$ 3.235') // 1234,56 + 2000,00
    expect(inspect(file).warnings).toEqual([])
  })

  it('says which columns the CSV lacks instead of failing with a traceback', () => {
    const csv = path.join(work, 'sem-receita.csv')
    fs.writeFileSync(csv, 'mes,regiao,valor\nJan,Sul,10\n', 'utf8')
    for (const [skill, name] of [['docx', 'relatorio.py'], ['xlsx', 'planilha.py'], ['pptx', 'apresentacao.py']]) {
      const result = python([path.join(skills, skill, 'receitas', name), csv, '--saida', path.join(work, 'nunca.out')])
      expect(result.code, `${skill}: ${result.out}`).not.toBe(0)
      expect(result.out, skill).toContain('faltam: receita')
      expect(result.out, skill).toContain('Colunas encontradas: mes, regiao, valor')
      expect(result.out, skill).not.toContain('Traceback')
    }
  })

  it('every recipe documents its options with --help', () => {
    for (const [skill, name, flags] of [
      ['docx', 'relatorio.py', ['--saida', '--rodape', '--meta', '--conclusao']],
      ['xlsx', 'planilha.py', ['--saida', '--rodape', '--meta']],
      ['pptx', 'apresentacao.py', ['--saida', '--rodape', '--meta', '--passo']]
    ] as Array<[string, string, string[]]>) {
      const result = python([path.join(skills, skill, 'receitas', name), '--help'])
      expect(result.code, result.out).toBe(0)
      for (const flag of flags) expect(result.out, `${skill} ${flag}`).toContain(flag)
    }
  })

  it.skipIf(!hasLibreOffice)('opens in LibreOffice', () => {
    const file = recipe('docx', 'relatorio.py', 'para-pdf.docx')
    const result = office('pdf', file, '--out', path.join(work, 'pdf-docx'))
    expect(result.code, result.out).toBe(0)
    expect(result.out).toMatch(/PDF: .*para-pdf\.pdf · [12] página/)
  }, 240_000)
})

run('xlsx recipe', () => {
  const verify = [
    'import sys, openpyxl',
    'f = openpyxl.load_workbook(sys.argv[1]); v = openpyxl.load_workbook(sys.argv[1], data_only=True)',
    'rows = [r for r in f["Dados"].iter_rows(min_row=2, values_only=True)]',
    'receita = lambda key, col: sum(r[4] for r in rows if r[col] == key)',
    'out = {"total": sum(r[4] for r in rows), "linhas": len(rows)}',
    'resumo = f["Resumo"]; cache = v["Resumo"]',
    'regioes = []',
    'for r in range(5, 8):',
    '    regioes.append([resumo["A%d" % r].value, resumo["B%d" % r].value, cache["B%d" % r].value, receita(resumo["A%d" % r].value, 1)])',
    'out["regioes"] = regioes',
    'out["total_formula"] = [resumo["B8"].value, cache["B8"].value]',
    'out["media"] = [resumo["B18"].value, cache["B18"].value]',
    'import json; print(json.dumps(out))'
  ].join('\n')

  it('writes Dados + Resumo with real formulas whose cached values equal what Python computes', () => {
    const file = recipe('xlsx', 'planilha.py', 'planilha.xlsx')
    const info = inspect(file, true)
    expect(info.sheets.map((s: { name: string }) => s.name)).toEqual(['Dados', 'Resumo'])
    expect(info.sheets[0].rows).toBe(37)
    expect(info.formulas).toBeGreaterThanOrEqual(12)
    expect(info.charts).toBe(1)
    expect(info.warnings).toEqual([])
    const script = path.join(work, 'verificar.py')
    fs.writeFileSync(script, verify)
    const result = python([script, file], { isolated: true })
    expect(result.code, result.out).toBe(0)
    const facts = JSON.parse(result.out.trim().split('\n').pop()!)
    for (const [, formula, cached, expected] of facts.regioes) {
      expect(String(formula)).toMatch(/^=SUMIF\(Dados!/)
      expect(cached).toBeCloseTo(expected, 6)
    }
    expect(facts.total_formula[0]).toBe('=SUM(B5:B7)')
    expect(facts.total_formula[1]).toBeCloseTo(facts.total, 6)
    expect(facts.media[0]).toBe('=AVERAGE(B12:B17)')
    expect(facts.media[1]).toBeCloseTo(facts.total / 6, 6)
  })

  it('draws its column chart from zero (a truncated axis makes small differences look huge)', () => {
    const [chart] = parts(recipe('xlsx', 'planilha.py', 'eixo.xlsx'), /^xl\/charts\/chart\d+\.xml$/)
    expect(chart).toMatch(/<c:min val="0"\/>/)
  })

  it('quick path: a Brazilian CSV with metas and the mandatory text; and without metas the table has no meta or attainment', () => {
    const csv = path.join(work, 'vendas-xlsx.csv')
    fs.writeFileSync(csv, 'Mês;Região;Receita\n2026-01;Sul;1.000,50\n2026-01;Sudeste;3.500,00\n2026-02;Sul;2.000,00\n', 'utf8')
    const withMetas = recipe('xlsx', 'planilha.py', 'br-com-metas.xlsx', [csv, ...MANDATORY, '--meta', 'Sul=2500', '--meta', 'Sudeste=3000'])
    const info = inspect(withMetas, true)
    expect(info.sheets[0].rows).toBe(4) // header + 3 rows
    expect(info.warnings).toEqual([])
    const resumo = info.sheets.find((s: { name: string }) => s.name === 'Resumo')
    expect(resumo.formulaSamples.map((f: { ref: string; cached: number }) => [f.ref, f.cached])).toEqual(
      expect.arrayContaining([['B5', 3000.5], ['B6', 3500]]) // regions with a meta come first, in the order the metas were given: Sul, Sudeste
    )
    const note = spawnSync(runtime!.python, ['-I', '-X', 'utf8', '-c', 'import openpyxl,sys; print(openpyxl.load_workbook(sys.argv[1])["Resumo"]["A2"].value)', withMetas], { encoding: 'utf8' }).stdout.trim()
    expect(note).toBe('Preparado pela Equipe Alfa')

    const without = recipe('xlsx', 'planilha.py', 'br-sem-metas.xlsx', [csv])
    const header = spawnSync(runtime!.python, ['-I', '-X', 'utf8', '-c', 'import openpyxl,sys; ws=openpyxl.load_workbook(sys.argv[1])["Resumo"]; print([c.value for c in ws[4]])', without], { encoding: 'utf8' }).stdout.trim()
    expect(header).toBe("['Região', 'Receita']")
    expect(inspect(without).warnings).toEqual([])
  })

  it.skipIf(!hasLibreOffice)('is recalculated by LibreOffice without errors and with the same values', () => {
    const file = recipe('xlsx', 'planilha.py', 'planilha-recalc.xlsx')
    const result = office('recalc', file)
    expect(result.code, result.out).toBe(0)
    expect(result.out).toMatch(/fórmula\(s\) recalculadas pelo LibreOffice: 0 com erro, 0 com valor em cache diferente/)
  }, 240_000)
})

run('pptx recipe', () => {
  it('writes five titled slides with a native chart, a native table, speaker notes and no warnings', () => {
    const file = recipe('pptx', 'apresentacao.py', 'apresentacao.pptx')
    const info = inspect(file)
    expect(info.slides).toHaveLength(5)
    expect(info.charts).toBe(1)
    expect(info.slides.every((s: { title: string | null }) => Boolean(s.title))).toBe(true)
    expect(info.slides.filter((s: { shapes: { table: number } }) => s.shapes.table > 0)).toHaveLength(1)
    expect(info.slides.filter((s: { notes: boolean }) => s.notes).length).toBeGreaterThanOrEqual(4)
    expect(info.slideSize.widthCm).toBeCloseTo(33.9, 1)
    expect(info.warnings).toEqual([])
  })

  it('draws its bar chart from zero (the viewer would otherwise start the axis at the smallest value)', () => {
    const [chart] = parts(recipe('pptx', 'apresentacao.py', 'eixo.pptx'), /^ppt\/charts\/chart\d+\.xml$/)
    expect(chart).toMatch(/<c:min val="0(\.0)?"\/>/)
  })

  it('quick path: the mandatory text on the cover and in every footer, and the next steps given on the command line', () => {
    const csv = path.join(work, 'vendas-pptx.csv')
    fs.writeFileSync(csv, 'mes,regiao,produto,unidades,receita\nJan,Sul,Plano Pro,10,1000\nJan,Sudeste,Plano Pro,20,3500\nFev,Sul,Plano Pro,10,2000\n', 'utf8')
    const file = recipe('pptx', 'apresentacao.py', 'do-csv.pptx', [csv, ...MANDATORY, '--meta', 'Sul=2500', '--passo', 'Primeiro passo do caso', '--passo', 'Segundo passo do caso'])
    const info = inspect(file)
    expect(info.slides).toHaveLength(5)
    expect(info.slides[0].text.join(' ')).toContain('Preparado pela Equipe Alfa')
    expect(info.slides.slice(1).every((s: { text: string[] }) => s.text.includes('Preparado pela Equipe Alfa'))).toBe(true)
    expect(info.slides[4].text.join(' ')).toContain('Primeiro passo do caso')
    expect(info.slides[4].text.join(' ')).not.toContain('Definir responsáveis') // the generic steps are replaced
    expect(info.warnings).toEqual([])
  })

  it.skipIf(!hasLibreOffice)('opens in LibreOffice with one page per slide', () => {
    const file = recipe('pptx', 'apresentacao.py', 'para-pdf.pptx')
    const result = office('pdf', file, '--out', path.join(work, 'pdf-pptx'))
    expect(result.code, result.out).toBe(0)
    expect(result.out).toMatch(/PDF: .*para-pdf\.pdf · 5 página/)
  }, 240_000)
})

run('inspect and recalc catch the usual defects', () => {
  const broken = [
    'import sys, docx, openpyxl, pptx, xlsxwriter',
    'from pptx.util import Inches',
    'out = sys.argv[1]',
    'd = docx.Document()',
    'for _ in range(4): d.add_paragraph("")',
    'd.add_paragraph("## Titulo em markdown e **negrito** solto")',
    'd.add_paragraph("Lorem ipsum")',
    'd.save(out + "/ruim.docx")',
    'wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Dados"; ws["A1"] = "1234"; ws["A2"] = 5; ws["A3"] = "=SUM(A2:A2)"; ws["A4"] = "#DIV/0!"; wb.save(out + "/ruim.xlsx")',
    'p = pptx.Presentation(); p.slide_width = Inches(13.333); p.slide_height = Inches(7.5)',
    's = p.slides.add_slide(p.slide_layouts[1])',
    's.shapes.title.text = "Slide com placeholder vazio"',
    's2 = p.slides.add_slide(p.slide_layouts[6])',
    'box = s2.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(0.5)); box.text_frame.word_wrap = True',
    'box.text_frame.text = "texto muito longo " * 40',
    'p.save(out + "/ruim.pptx")',
    'wrong = xlsxwriter.Workbook(out + "/errado.xlsx"); w = wrong.add_worksheet("Resumo")',
    'w.write("A1", 2); w.write("A2", 3); w.write_formula("A3", "=SUM(A1:A2)", None, 999); w.write_formula("A4", "=SUMA(A1:A2)", None, 0)',
    'wrong.close()'
  ].join('\n')

  beforeAll(() => {
    const script = path.join(work, 'defeitos.py')
    fs.writeFileSync(script, broken)
    const result = python([script, work])
    expect(result.code, result.out).toBe(0)
  })

  it('docx: empty paragraphs, Markdown left in the text, placeholder text, no headings', () => {
    const warnings = inspect(path.join(work, 'ruim.docx')).warnings.join('\n')
    expect(warnings).toMatch(/nenhum título/)
    expect(warnings).toMatch(/parágrafos vazios seguidos/)
    expect(warnings).toMatch(/Markdown/)
    expect(warnings).toMatch(/preenchimento/)
  })

  it('xlsx: number stored as text, formula without cached value, error value', () => {
    const warnings = inspect(path.join(work, 'ruim.xlsx')).warnings.join('\n')
    expect(warnings).toMatch(/número guardado como texto/)
    expect(warnings).toMatch(/sem valor em cache/)
    expect(warnings).toMatch(/valores de erro/)
  })

  it('pptx: empty placeholder, text that may overflow', () => {
    const warnings = inspect(path.join(work, 'ruim.pptx')).warnings.join('\n')
    expect(warnings).toMatch(/placeholder vazio/)
    expect(warnings).toMatch(/transbordar/)
    expect(warnings).toMatch(/sem título/)
  })

  it.skipIf(!hasLibreOffice)('recalc: a wrong cached value and a pt-BR function name (#NAME?) are found', () => {
    const result = office('recalc', path.join(work, 'errado.xlsx'))
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/CACHE .*A3.*em cache 999, recalculado 5/)
    expect(result.out).toMatch(/ERRO .*A4.*#NAME\?/)
  }, 240_000)

  it('refuses what is not an Office file', () => {
    fs.writeFileSync(path.join(work, 'falso.docx'), 'isto não é um zip')
    expect(office('inspect', path.join(work, 'falso.docx')).code).toBe(1)
    expect(office('inspect', path.join(work, 'nao-existe.docx')).code).toBe(2)
    expect(office('inspect', path.join(work, 'ruim.docx').replace('.docx', '.txt')).code).toBe(2)
  })
})

describe('the docx / xlsx / pptx skills', () => {
  it('are bundled with a real description and point at the embedded tools, not at pip', async () => {
    const library = new SkillLibrary([{ dir: skills, source: 'usuario' }])
    const names = (await library.reload()).map((skill) => skill.name)
    expect(names).toEqual(expect.arrayContaining(['docx', 'xlsx', 'pptx']))
    for (const name of ['docx', 'xlsx', 'pptx']) {
      const skill = library.get(name)!
      expect(skill.description.length, name).toBeGreaterThan(120)
      expect(skill.description, name).toMatch(/sem(pre)? .*Use SEMPRE|Use SEMPRE/)
      expect(skill.body, name).toContain('openclod-office check')
      expect(skill.body, name).toContain('openclod-python')
      expect(skill.body, name).toContain('Não rode `pip`')
      expect(skill.body, name).toContain('receitas')
      expect(skill.body.length, name).toBeLessThan(11_000)
    }
    expect(library.get('docx')!.body).toContain('openclod-office inspect')
    expect(library.get('xlsx')!.body).toContain('openclod-office recalc')
    expect(library.get('pptx')!.body).toContain('chart_slide')
  })

  it('ship their recipes next to SKILL.md', () => {
    for (const [skill, file] of [['docx', 'relatorio.py'], ['xlsx', 'planilha.py'], ['pptx', 'apresentacao.py']]) {
      expect(fs.existsSync(path.join(skills, skill, 'receitas', file)), `${skill}/receitas/${file}`).toBe(true)
    }
  })
})
