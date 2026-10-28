// Opens what the agent delivered (DOCX, XLSX, PPTX) and reports what is really inside, without trusting the model's own
// description. Used by scripts/ui-cowork.cjs. Nothing here runs the files: they are zip containers read as data.
//
// The conversion helpers drive the LibreOffice that is installed on the machine (headless, throwaway profile): a file that
// LibreOffice opens and renders is a file a person can open too.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { unzipSync, strFromU8 } = require('fflate')

const SOFFICE = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
].find((candidate) => fs.existsSync(candidate))

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function readZip(file) {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(file)))
  const text = (name) => (entries[name] ? strFromU8(entries[name]) : '')
  return { entries, names: Object.keys(entries), text }
}

/** Text of every `<tag>...</tag>` (namespace prefix included in `tag`), in order. */
function texts(xml, tag) {
  const out = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let match
  while ((match = re.exec(xml))) out.push(decodeXml(match[1].replace(/<[^>]+>/g, '')))
  return out
}

function inspectDocx(file) {
  const zip = readZip(file)
  const xml = zip.text('word/document.xml')
  const paragraphs = []
  const re = /<w:p[\s>][\s\S]*?<\/w:p>/g
  let match
  while ((match = re.exec(xml))) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(match[0])
    const text = texts(match[0], 'w:t').join('')
    if (text.trim()) paragraphs.push({ style: style ? style[1] : '', text })
  }
  const rows = (xml.match(/<w:tr[\s>]/g) || []).length
  return {
    file,
    bytes: fs.statSync(file).size,
    validZip: zip.names.includes('word/document.xml') && zip.names.includes('[Content_Types].xml'),
    paragraphs,
    headings: paragraphs.filter((p) => /^(Heading|Ttulo|Title|Titulo)/i.test(p.style)).map((p) => p.text),
    tables: (xml.match(/<w:tbl>/g) || []).length,
    tableRows: rows,
    images: zip.names.filter((name) => name.startsWith('word/media/')).length,
    text: paragraphs.map((p) => p.text).join('\n')
  }
}

function inspectXlsx(file) {
  const zip = readZip(file)
  const workbook = zip.text('xl/workbook.xml')
  const rels = zip.text('xl/_rels/workbook.xml.rels')
  const targets = {}
  for (const rel of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[0])
    const target = /\bTarget="([^"]+)"/.exec(rel[0])
    if (id && target) targets[id[1]] = target[1].replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/')
  }
  const shared = []
  for (const si of zip.text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeXml(si[1].replace(/<[^>]+>/g, '')))
  const sheets = []
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(sheet[0])
    const rid = /\br:id="([^"]+)"/.exec(sheet[0])
    const part = rid ? targets[rid[1]] : undefined
    const xml = part ? zip.text(part) : ''
    const cells = []
    for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]
      const body = cell[2] || ''
      const ref = /\br="([^"]+)"/.exec(attrs)
      const type = /\bt="([^"]+)"/.exec(attrs)
      const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body) || (/<f\b[^>]*\/>/.test(body) ? ['', ''] : null)
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)
      const inline = /<is>([\s\S]*?)<\/is>/.exec(body)
      let shown = value ? decodeXml(value[1]) : inline ? decodeXml(inline[1].replace(/<[^>]+>/g, '')) : ''
      if (type && type[1] === 's' && value) shown = shared[Number(value[1])] ?? shown
      cells.push({ ref: ref ? ref[1] : '', formula: formula ? decodeXml(formula[1]) : null, value: shown, type: type ? type[1] : '' })
    }
    sheets.push({ name: name ? decodeXml(name[1]) : '?', cells })
  }
  const formulaCells = sheets.flatMap((sheet) => sheet.cells.filter((cell) => cell.formula !== null).map((cell) => ({ sheet: sheet.name, ...cell })))
  return {
    file,
    bytes: fs.statSync(file).size,
    validZip: zip.names.includes('xl/workbook.xml'),
    sheets: sheets.map((sheet) => ({ name: sheet.name, cells: sheet.cells.length, formulas: sheet.cells.filter((cell) => cell.formula !== null).length })),
    formulaCells,
    allText: sheets.flatMap((sheet) => sheet.cells.map((cell) => cell.value)).join('\n'),
    charts: zip.names.filter((name) => name.startsWith('xl/charts/')).length
  }
}

function inspectPptx(file) {
  const zip = readZip(file)
  const slideNames = zip.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const slides = slideNames.map((name) => {
    const xml = zip.text(name)
    return { name, text: texts(xml, 'a:t'), hasTable: /<a:tbl>/.test(xml), hasPicture: /<p:pic>/.test(xml) }
  })
  return {
    file,
    bytes: fs.statSync(file).size,
    validZip: zip.names.includes('[Content_Types].xml') && slideNames.length > 0,
    slides,
    notes: zip.names.filter((name) => name.startsWith('ppt/notesSlides/')).length,
    allText: slides.flatMap((slide) => slide.text).join('\n')
  }
}

/** Does `text` hold the number `n` (any thousands separator, optional decimals)? 412350 matches 412.350, 412,350 and 412350. */
function containsNumber(text, n) {
  const digits = String(Math.round(n))
  const groups = []
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
  const body = groups.join('[.,\\s\\u00a0]?')
  return new RegExp(`(^|[^\\d])${body}([^\\d]|$)`).test(text)
}

/** Converts with LibreOffice (headless, own profile so it never fights a LibreOffice the user has open). */
function convert(file, format, outDir) {
  if (!SOFFICE) throw new Error('LibreOffice não encontrado')
  fs.mkdirSync(outDir, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-lo-'))
  try {
    execFileSync(SOFFICE, [`-env:UserInstallation=file:///${profile.replace(/\\/g, '/')}`, '--headless', '--convert-to', format, '--outdir', outDir, file], {
      stdio: 'ignore',
      timeout: 180000,
      windowsHide: true
    })
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }) } catch { /* best effort */ }
  }
  const produced = path.join(outDir, `${path.basename(file, path.extname(file))}.${format.split(':')[0]}`)
  if (!fs.existsSync(produced)) throw new Error(`LibreOffice não gerou ${produced}`)
  return produced
}

/** Renders the first `maxPages` pages of a PDF to PNG (PyMuPDF from the system Python); returns the page count and files. */
function renderPdf(pdf, outDir, prefix, maxPages = 3) {
  fs.mkdirSync(outDir, { recursive: true })
  const script = [
    'import sys, fitz',
    'pdf, out, prefix, maxp = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])',
    'doc = fitz.open(pdf)',
    'files = []',
    'for i in range(min(len(doc), maxp)):',
    '    pix = doc[i].get_pixmap(matrix=fitz.Matrix(1.4, 1.4))',
    '    name = f"{out}/{prefix}-p{i+1}.png"',
    '    pix.save(name)',
    '    files.append(name)',
    'print(len(doc)); print("\\n".join(files))'
  ].join('\n')
  // No -I: PyMuPDF lives in the user's site-packages. It may print a deprecation warning before the page count.
  const output = execFileSync('python', ['-c', script, pdf, outDir, prefix, String(maxPages)], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).trim().split(/\r?\n/)
  const counted = output.findIndex((line) => /^\d+$/.test(line.trim()))
  if (counted < 0) throw new Error(`não consegui ler a contagem de páginas: ${output.join(' | ').slice(0, 200)}`)
  return { pages: Number(output[counted]), files: output.slice(counted + 1).map((line) => line.trim()).filter((line) => /\.png$/.test(line)) }
}

/** Opens a delivered file in LibreOffice (PDF render) and saves page images; never throws, so a failure becomes a check. */
function renderOffice(file, outDir, prefix, maxPages = 3) {
  try {
    const pdf = convert(file, 'pdf', outDir)
    return { ok: true, pdf, ...renderPdf(pdf, outDir, prefix, maxPages) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), pages: 0, files: [] }
  }
}

/** Formula cells with the value LibreOffice computed for them (round trip through LibreOffice recalculates). */
function recalculatedFormulas(xlsxFile, outDir) {
  const converted = convert(xlsxFile, 'xlsx:Calc MS Excel 2007 XML', path.join(outDir, 'recalc'))
  return inspectXlsx(converted).formulaCells
}

module.exports = { SOFFICE, readZip, inspectDocx, inspectXlsx, inspectPptx, containsNumber, convert, renderPdf, renderOffice, recalculatedFormulas }
