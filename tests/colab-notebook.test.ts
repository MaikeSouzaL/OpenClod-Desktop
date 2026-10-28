import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COLAB_FAQ_URL,
  COLAB_NOTEBOOK_FILE,
  COLAB_TERMS_URL,
  buildColabNotebook,
  colabNotebookJson,
  normalizeServerSource,
  serverSourceHash,
  type ColabNotebook
} from '../src/core/colab/notebook'
import { COLAB_NOTEBOOK_VERSION } from '../src/core/colab/connection-code'
import { colabServerHash, readColabServerSource } from '../src/core/colab/resource'
import { spawnSync } from 'node:child_process'
import { SERVER_MODULE, findPython, findPythonWith, runPython } from './support/colab-python'

/**
 * The .ipynb the "Google Colab (GPU)" button writes. It must be a valid nbformat 4 notebook that asks for a GPU, whose every
 * code cell is valid Python, that runs from "Run all" with no prompt, and that carries the server module exactly as shipped.
 */
const source = readColabServerSource()
const notebook = buildColabNotebook({ serverSource: source })
const codeCells = notebook.cells.filter((cell) => cell.cell_type === 'code')
const text = (cell: { source: string[] }): string => cell.source.join('')

describe('notebook: format', () => {
  it('is a valid nbformat 4 notebook', () => {
    expect(notebook.nbformat).toBe(4)
    expect(notebook.nbformat_minor).toBeGreaterThanOrEqual(5)
    const ids = new Set<string>()
    for (const cell of notebook.cells) {
      expect(['markdown', 'code']).toContain(cell.cell_type)
      expect(cell.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(ids.has(cell.id), `id repetido: ${cell.id}`).toBe(false)
      ids.add(cell.id)
      expect(Array.isArray(cell.source) && cell.source.every((line) => typeof line === 'string')).toBe(true)
      expect(cell.metadata).toBeTypeOf('object')
      if (cell.cell_type === 'code') {
        expect(cell.outputs).toEqual([])
        expect(cell.execution_count).toBeNull()
      } else {
        expect(cell).not.toHaveProperty('outputs')
      }
    }
  })

  it('serializes to JSON that parses back to the same notebook, ending in a newline', () => {
    const json = colabNotebookJson({ serverSource: source })
    expect(json.endsWith('}\n')).toBe(true)
    expect(JSON.parse(json)).toEqual(notebook)
  })

  it('splits the source into lines that join back to the original text', () => {
    for (const cell of notebook.cells) {
      cell.source.slice(0, -1).forEach((line) => expect(line.endsWith('\n')).toBe(true))
    }
    const server = codeCells.find((cell) => cell.id === 'openclod-servidor')!
    expect(text(server)).toContain('SERVIDOR = r\'\'\'')
  })
})

describe('notebook: asks for a GPU and says what it is', () => {
  it('requests a GPU runtime in the metadata', () => {
    expect(notebook.metadata.accelerator).toBe('GPU')
    expect((notebook.metadata.colab as { gpuType: string }).gpuType).toBe('T4')
  })

  it('records the notebook version and the hash of the embedded server', () => {
    const meta = notebook.metadata.openclod as { notebookVersion: string; serverSha256: string }
    expect(meta.notebookVersion).toBe(COLAB_NOTEBOOK_VERSION)
    expect(meta.serverSha256).toBe(serverSourceHash(source))
    expect(colabServerHash()).toBe(meta.serverSha256)
  })

  it('opens with the steps and the honest warning about the Colab rules, with their links', () => {
    const intro = text(notebook.cells[0])
    expect(notebook.cells[0].cell_type).toBe('markdown')
    expect(intro).toMatch(/Executar tudo/)
    expect(intro).toContain('OCLC1.')
    expect(intro).toContain(COLAB_FAQ_URL)
    expect(intro).toContain(COLAB_TERMS_URL)
    expect(intro).toMatch(/serviços web/)
    expect(intro).toMatch(/proxies remotos/)
    expect(intro).toMatch(/sem aviso/)
    expect(intro).toMatch(/não compartilhe o código de conexão/)
    expect(intro).toMatch(/GPU alugada/)
  })

  it('has the optional fields as a Colab form, all with safe defaults', () => {
    const options = codeCells[0]
    expect(text(options)).toMatch(/^#@title/)
    expect(text(options)).toContain('modelo_manual = ""')
    expect(text(options)).toContain('contexto_manual = 0')
    expect(text(options)).toContain('pensamento = "padrão"')
    expect(text(options)).toContain('numero_da_lista = 0')
    expect(text(options)).toContain('tipo_de_modelo = "automático"')
    expect(text(options)).toContain('somente_listar_modelos = False')
    expect(options.metadata.cellView).toBe('form')
  })

  it('asks for the choice by default (2 minutes) and lets the user change the wait or turn the question off', () => {
    const options = text(codeCells[0])
    expect(options).toContain('segundos_para_escolher = 120  #@param {type:"integer"}')
    expect(options).toMatch(/0 = não\s+# perguntar/)
    expect(options).toContain('Usar este modelo')
    const plan = text(codeCells.find((cell) => cell.id === 'openclod-passo-2')!)
    expect(plan).toMatch(/oc\.step_plan\(modelo_manual, contexto_manual, pensamento, token_hf or "", numero_da_lista, tipo_de_modelo, somente_listar_modelos, segundos_para_escolher\);$/)
  })

  it('tells, in the intro, that step 2 stops for the choice, for how long, what happens without one and how to skip it', () => {
    const intro = text(notebook.cells[0])
    expect(intro).toMatch(/etapa 2\*\* mostra os modelos que cabem na GPU e \*\*para por até 2 minutos\*\*/)
    expect(intro).toContain('**Usar este modelo**')
    expect(intro).toMatch(/se você não escolher em 2 minutos, ele roda sozinho, e só depois disso o notebook baixa alguma coisa/)
    expect(intro).toContain('*segundos_para_escolher*')
    expect(intro).toMatch(/0 = não perguntar/)
    expect(intro).toMatch(/nesses casos a caixa não aparece/)
  })
})

describe('notebook: runs with "Run all" and nothing else', () => {
  it('has the steps in order, one per cell, ending with the cell that keeps the server alive', () => {
    const calls = codeCells.map((cell) => /oc\.(step_\w+)/.exec(text(cell))?.[1]).filter(Boolean)
    expect(calls).toEqual(['step_gpu', 'step_plan', 'step_install_engine', 'step_model', 'step_server', 'step_tunnel', 'step_serve_forever'])
    expect(text(codeCells[codeCells.length - 1])).toContain('step_serve_forever')
    expect(notebook.cells[notebook.cells.length - 1].cell_type).toBe('markdown')
  })

  it('ends each step call with ";" so Colab does not echo the value the step returns (a dict, a path) under the step\'s own lines', () => {
    const steps = codeCells.filter((cell) => /^openclod-passo-[1-6]$/.test(cell.id))
    expect(steps).toHaveLength(6)
    for (const cell of steps) expect(text(cell).trimEnd()).toMatch(/oc\.step_\w+\(.*\);$/)
  })

  it('never asks the user for anything inside a cell', () => {
    for (const cell of codeCells.filter((item) => item.id !== 'openclod-servidor')) {
      expect(text(cell)).not.toMatch(/\binput\s*\(|getpass|!pip|%pip|%%|files\.upload|drive\.mount|auth\.authenticate_user/)
    }
  })

  it('reads the optional Hugging Face token from Colab secrets without failing when it is not there', () => {
    const plan = codeCells.find((cell) => cell.id === 'openclod-passo-2')!
    expect(text(plan)).toContain('userdata.get("HF_TOKEN")')
    expect(text(plan)).toMatch(/except Exception:\s+token_hf = ""/)
  })

  it('embeds exactly the module that ships with the app', () => {
    const server = text(codeCells.find((cell) => cell.id === 'openclod-servidor')!)
    const match = /SERVIDOR = r'''([\s\S]*)'''\n\npathlib\.Path/.exec(server)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(normalizeServerSource(fs.readFileSync(SERVER_MODULE, 'utf8')))
  })

  it('contains no secret and no key', () => {
    const everything = JSON.stringify(notebook)
    expect(everything).not.toMatch(/occ_[A-Za-z0-9_-]{16,}/)
    expect(everything).not.toMatch(/hf_[A-Za-z0-9]{20,}/)
  })
})

describe('notebook: the generator refuses a module that cannot be embedded', () => {
  it('refuses triple single quotes and a trailing backslash', () => {
    expect(() => buildColabNotebook({ serverSource: "x = '''oi'''\n" })).toThrow(/'''/)
    expect(() => buildColabNotebook({ serverSource: 'x = 1 \\' })).toThrow(/barra invertida/)
  })

  it('normalizes line endings and the BOM, and ends with one newline', () => {
    expect(normalizeServerSource('﻿a\r\nb\rc')).toBe('a\nb\nc\n')
    expect(normalizeServerSource('a\n')).toBe('a\n')
  })

  it('names the file the user will upload', () => {
    expect(COLAB_NOTEBOOK_FILE).toBe('openclod-servidor-llm.ipynb')
  })
})

const python = findPython()
const withPython = python ? describe : describe.skip

withPython('notebook: every code cell is valid Python', () => {
  it('compiles with ast', () => {
    const script = [
      'import ast, json, sys',
      'cells = json.load(sys.stdin)',
      'for index, source in enumerate(cells):',
      '    ast.parse(source, filename="celula-%d" % index)',
      'print(len(cells))'
    ].join('\n')
    const result = runPython(['-c', script], { input: JSON.stringify(codeCells.map(text)) })
    expect(result.stderr).toBe('')
    expect(Number(result.stdout.trim())).toBe(codeCells.length)
  })

  // The official nbformat 4.5 JSON schema (jupyter/nbformat, BSD-3). Needs the `jsonschema` package of the Python that runs the test.
  const schemaPython = findPythonWith('jsonschema')
  it.skipIf(!schemaPython)('validates against the official nbformat 4.5 schema', () => {
    const script = [
      'import json, sys, jsonschema',
      'schema = json.load(open(sys.argv[1], encoding="utf-8"))',
      'notebook = json.load(sys.stdin)',
      'errors = sorted(jsonschema.Draft4Validator(schema).iter_errors(notebook), key=lambda e: list(e.path))',
      'print(json.dumps([[list(map(str, e.path)), e.message[:200]] for e in errors]))'
    ].join('\n')
    const schema = path.join(__dirname, 'fixtures', 'colab', 'nbformat.v4.5.schema.json')
    const result = spawnSync(schemaPython!, ['-X', 'utf8', '-I', '-c', script, schema], { input: JSON.stringify(notebook), encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual([])
  })

  it('compiles for Python 3.9+ syntax only (no match statements or | in annotations at runtime)', () => {
    const server = text(codeCells.find((cell) => cell.id === 'openclod-servidor')!)
    expect(server).not.toMatch(/^\s*match\s+\w+:/m)
  })
})

describe('notebook: the cells run in order (stub GPU, no downloads)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclod-nb-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }))

  /** Runs the form cell, the module cell and the first two steps in one interpreter, like Colab's "Run all" would. */
  function runFirstCells(gpuMib: number, extra = ''): { status: number | null; out: string; err: string } {
    const cells = [codeCells[0], codeCells.find((cell) => cell.id === 'openclod-servidor')!, codeCells[2], codeCells[3]].map(text)
    const harness = [
      'import json, sys',
      'cells = json.load(open(sys.argv[1], encoding="utf-8"))',
      // Colab's /content is a POSIX path; a Windows path with backslashes would turn into escapes inside the cell's string.
      'work = sys.argv[2].replace("\\\\", "/")',
      'namespace = {}',
      'for index, source in enumerate(cells):',
      '    source = source.replace("/content", work)',
      '    exec(compile(source, "celula-%d" % index, "exec"), namespace)',
      '    if index == 1:',
      '        import openclod_llm_server as oc',
      `        oc.detect_gpu = lambda: {"name": "GPU de teste", "total_mib": ${gpuMib}, "free_mib": ${gpuMib - 300}, "driver": "535.1", "cc": "7.5"}`,
      extra
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'cells.json'), JSON.stringify(cells))
    fs.writeFileSync(path.join(dir, 'harness.py'), harness)
    // The registry check is off: a test never needs the network.
    const result = runPython([path.join(dir, 'harness.py'), path.join(dir, 'cells.json'), dir], { env: { OPENCLOD_COLAB_DIR: path.join(dir, 'work'), OPENCLOD_COLAB_OFFLINE: '1' } })
    return { status: result.status, out: result.stdout, err: result.stderr }
  }

  it.skipIf(!python)('a T4 gets the 9B model with 64k of context and the list of what fits, with its sources', () => {
    const run = runFirstCells(15360)
    expect(run.err).toBe('')
    expect(run.status).toBe(0)
    expect(run.out).toContain('GPU encontrada: GPU de teste')
    expect(run.out).toContain('Rodando nesta execução (GPU de 16 GB (T4))')
    expect(run.out).toContain('-> qwen3.5:9b-q8_0 | contexto 65536 tokens')
    expect(run.out).toContain('https://ollama.com/library/qwen3.5')
    expect(run.out).toContain('Modelos abertos que cabem nesta GPU')
    expect(fs.existsSync(path.join(dir, 'openclod_llm_server.py'))).toBe(true)
  })

  it.skipIf(!python)('step 2 shows every kind of model that fits the GPU, numbered, uncensored ones included, and marks the one that runs', () => {
    const run = runFirstCells(15360)
    for (const title of ['Agentes com visão e ferramentas', 'Agentes só texto', 'Código:', 'Raciocínio:', 'Só conversa', 'Sem censura (uncensored / abliterated)']) {
      expect(run.out).toContain(title)
    }
    expect(run.out).toMatch(/\n\s+1\. Qwen3\.5 9B\s+Q8_0\s+10,4 GB\s+ctx 64k\s+visão, ferramentas, pensamento/)
    expect(run.out).toMatch(/<== rodando esta/)
    expect(run.out).toMatch(/abliterated/)
    expect(run.out).toMatch(/Dolphin 3 8B/)
    expect(run.out).toContain('Não cabem nesta GPU')
    expect(run.out).toContain('numero_da_lista')
  })

  it.skipIf(!python)('the running model is marked in the list even when the tier table spells its tag another way', () => {
    // 12 GB: the table runs qwen3.5:9b-q4_K_M, which the catalog keeps as qwen3.5:9b (the same file).
    const run = runFirstCells(12288)
    expect(run.out).toContain('-> qwen3.5:9b-q4_K_M | contexto 65536 tokens')
    expect(run.out).toMatch(/Qwen3\.5 9B\s+Q4_K_M[^\n]*<== rodando esta/)
  })

  it.skipIf(!python)('a bigger GPU lists more models than a smaller one (the list depends on the VRAM read)', () => {
    const count = (out: string): number => Number(/: (\d+) de \d+ do catálogo/.exec(out)?.[1])
    const small = count(runFirstCells(8192).out)
    const t4 = count(runFirstCells(15360).out)
    const a100 = count(runFirstCells(40960).out)
    expect(small).toBeGreaterThan(10)
    expect(t4).toBeGreaterThan(small)
    expect(a100).toBeGreaterThan(t4)
  })

  it.skipIf(!python)('numero_da_lista runs the model that number names in the list', () => {
    // The number comes from the list the same GPU prints (it only depends on the GPU): read it there, then ask for it.
    const number = Number(/\n\s+(\d+)\. Qwen3\.5 4B\s+Q8_0/.exec(runFirstCells(15360).out)?.[1])
    expect(number).toBeGreaterThan(1)
    const run = runFirstCells(15360, `        namespace["numero_da_lista"] = ${number}`)
    expect(run.status).toBe(0)
    expect(run.out).toContain(`Modelo n.º ${number} da lista, escolhido por você: Qwen3.5 4B (Q8_0).`)
    expect(run.out).toContain('-> qwen3.5:4b-q8_0 | contexto 131072 tokens')
  })

  it.skipIf(!python)('a number that is not on the list stops with a message that says how to see the list', () => {
    const run = runFirstCells(15360, '        namespace["numero_da_lista"] = 999')
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('O número 999 não está na lista desta GPU')
  })

  it.skipIf(!python)('tipo_de_modelo "sem censura" picks an uncensored model that fits', () => {
    const run = runFirstCells(15360, '        namespace["tipo_de_modelo"] = "sem censura"')
    expect(run.status).toBe(0)
    expect(run.out).toContain("Tipo 'sem censura': o maior modelo desse tipo que cabe nesta GPU")
    expect(run.out).toMatch(/-> (huihui_ai\/|dolphin|orcarouter\/|llama2-uncensored|wizard)\S*/)
  })

  it.skipIf(!python)('somente_listar_modelos stops after the list, before anything is downloaded', () => {
    const run = runFirstCells(15360, '        namespace["somente_listar_modelos"] = True')
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('Você marcou somente_listar_modelos: parei aqui, antes de baixar qualquer coisa.')
    expect(run.out).toContain('Modelos abertos que cabem nesta GPU')
  })

  /**
   * Python lines (already indented for the harness) that put a fake `google.colab` in place, as the Colab has: `eval_js` answers
   * with `reply` (a Python expression that may use `oc`) and prints the `timeout_sec` it was called with.
   */
  function fakeColab(reply: string): string {
    return [
      'import types',
      'def eval_js(script, ignore_result=False, timeout_sec=None):',
      '    if ignore_result:',
      '        return None',
      '    print("EVAL_JS timeout_sec=%s" % timeout_sec)',
      `    return ${reply}`,
      'google = types.ModuleType("google")',
      'colab = types.ModuleType("google.colab")',
      'output = types.ModuleType("google.colab.output")',
      'output.eval_js = eval_js',
      'colab.output = output',
      'google.colab = colab',
      'sys.modules.update({"google": google, "google.colab": colab, "google.colab.output": output})',
      'oc.colab_show_js = lambda code: None',
      'number_of = lambda nome, quant: next(r["numero"] for r in oc.build_listing(oc.usable_gib(15360, 15060))["rows"] if r["variant"]["nome"] == nome and r["variant"]["quant"] == quant)'
    ]
      .map((line) => `        ${line}`)
      .join('\n')
  }

  it.skipIf(!python)('in the Colab, step 2 stops on the choice box, waits at most 2 minutes + a grace, and runs the model the user picks', () => {
    const run = runFirstCells(15360, fakeColab('json.dumps({"quem": "usuario", "numero": number_of("Qwen3.5 4B", "Q8_0")})'))
    expect(run.err).toBe('')
    expect(run.status).toBe(0)
    expect(run.out).toContain('EVAL_JS timeout_sec=150')
    expect(run.out).toContain('Escolha o modelo na caixa abaixo e clique em «Usar este modelo». Sem escolha em 2 minutos, o notebook segue com o automático (qwen3.5:9b-q8_0).')
    expect(run.out).toMatch(/Você escolheu o n\.º \d+: Qwen3\.5 4B \(Q8_0\)\./)
    expect(run.out).toContain('-> qwen3.5:4b-q8_0 | contexto 131072 tokens')
    expect(run.out).toMatch(/<== automático/)
    expect(run.out).not.toContain('<== rodando esta')
  })

  it.skipIf(!python)('in the Colab, when nobody chooses, step 2 goes on with the automatic model and says so', () => {
    const run = runFirstCells(15360, fakeColab('json.dumps({"quem": "tempo", "numero": 0})'))
    expect(run.status).toBe(0)
    expect(run.out).toContain('Ninguém escolheu em 2 minutos: seguindo com o automático (qwen3.5:9b-q8_0).')
    expect(run.out).toContain('-> qwen3.5:9b-q8_0 | contexto 65536 tokens')
  })

  it.skipIf(!python)('in the Colab, a choice already made in the form (number, type, tag) or 0 seconds skips the box', () => {
    const never = fakeColab('(_ for _ in ()).throw(AssertionError("a caixa não devia aparecer"))')
    const number = Number(/\n\s+(\d+)\. Qwen3\.5 4B\s+Q8_0/.exec(runFirstCells(15360).out)?.[1])
    for (const form of [`namespace["numero_da_lista"] = ${number}`, 'namespace["tipo_de_modelo"] = "código"', 'namespace["modelo_manual"] = "qwen3.5:4b"', 'namespace["segundos_para_escolher"] = 0']) {
      const run = runFirstCells(15360, `${never}\n        ${form}`)
      expect(run.err, form).toBe('')
      expect(run.status, form).toBe(0)
      expect(run.out, form).not.toContain('Escolha o modelo na caixa abaixo')
    }
    const listOnly = runFirstCells(15360, `${never}\n        namespace["somente_listar_modelos"] = True`)
    expect(listOnly.out).toContain('Você marcou somente_listar_modelos: parei aqui')
    expect(listOnly.out).not.toContain('Escolha o modelo na caixa abaixo')
  })

  it.skipIf(!python)('an A100 40 GB gets the 27B model', () => {
    const run = runFirstCells(40960)
    expect(run.out).toContain('-> qwen3.8:27b-q8_0 | contexto 65536 tokens')
  })

  it.skipIf(!python)('an environment without a GPU stops with a message that says what to click', () => {
    const run = runFirstCells(15360, '        oc.detect_gpu = lambda: None')
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('Este ambiente não tem GPU')
    expect(run.out).toContain('Alterar o tipo de ambiente de execução')
    expect(run.out).toContain('Executar tudo')
  })
})
