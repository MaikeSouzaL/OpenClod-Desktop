import { createHash } from 'node:crypto'
import { COLAB_NOTEBOOK_VERSION } from './connection-code.js'

/**
 * The notebook the "Google Colab (GPU)" button writes. It has no logic of its own: one cell writes the server module
 * (resources/colab/openclod_llm_server.py, readable in full inside the notebook) and each step is one call into it, so what
 * runs in Colab is exactly the file the tests exercise. "Run all" goes through the cells in order with nothing to click.
 */

export const COLAB_NOTEBOOK_FILE = 'openclod-servidor-llm.ipynb'
export const COLAB_URL = 'https://colab.research.google.com/'
export const COLAB_FAQ_URL = 'https://research.google.com/colaboratory/faq.html'
export const COLAB_TERMS_URL = 'https://research.google.com/colaboratory/tos_v6.html'

export interface ColabCell {
  cell_type: 'markdown' | 'code'
  id: string
  metadata: Record<string, unknown>
  source: string[]
  outputs?: unknown[]
  execution_count?: number | null
}

export interface ColabNotebook {
  nbformat: 4
  nbformat_minor: 5
  metadata: Record<string, unknown>
  cells: ColabCell[]
}

/** BOM and CRLF out, one trailing newline in: the text the notebook stores and the Python side hashes. */
export function normalizeServerSource(raw: string): string {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 12 hex of the SHA-256 of the normalized source: the `sh` field of the connection code. */
export function serverSourceHash(source: string): string {
  return createHash('sha256').update(normalizeServerSource(source), 'utf8').digest('hex').slice(0, 12)
}

function lines(text: string): string[] {
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((line, index) => (index < parts.length - 1 ? `${line}\n` : line))
}

function markdown(id: string, text: string): ColabCell {
  return { cell_type: 'markdown', id, metadata: {}, source: lines(text) }
}

function code(id: string, text: string, metadata: Record<string, unknown> = {}): ColabCell {
  return { cell_type: 'code', id, metadata, source: lines(text), outputs: [], execution_count: null }
}

const FORM = { cellView: 'form' }

const INTRO = `# Openclod · servidor de LLM no Google Colab

Este notebook transforma a GPU do Colab em um servidor de LLM **só seu**, para o **Openclod Desktop** usar como provedor. Ele faz tudo sozinho: confere a GPU, **mostra todos os modelos abertos que cabem nela**, roda o melhor (com **visão** e **chamada de ferramentas**), instala o motor, baixa o modelo, abre um túnel, testa tudo e, no fim, mostra um **código de conexão**.

**Como usar (5 passos)**
1. Menu **Ambiente de execução → Executar tudo** (Ctrl+F9). O notebook já pede uma GPU; se aparecer o aviso de "sem GPU", escolha em *Ambiente de execução → Alterar o tipo de ambiente de execução → GPU*.
2. Espere. A **etapa 2** mostra os modelos que cabem na GPU e **para por até 2 minutos** numa caixa de seleção (botão **Usar este modelo**): escolha um, ou deixe passar e ela segue com o automático. Depois, na primeira vez, leva de 5 a 15 minutos (baixa o motor e o modelo); o progresso aparece em cada etapa.
3. No fim aparece o **CÓDIGO DE CONEXÃO** (uma linha que começa com \`OCLC1.\`) e o botão **Copiar**.
4. No Openclod: *Configurações → Provedores → Google Colab (GPU)* → cole o código → confira o que o Openclod mostra → **Conectar**.
5. **Deixe esta aba aberta** enquanto usar. Quando a sessão acabar, rode o notebook de novo e cole o código novo.

**Quer escolher o modelo?** A etapa 2 lista todos os modelos abertos que cabem na GPU que você recebeu (agentes com visão, código, raciocínio, só conversa e **sem censura**), numerados, com o tamanho, o contexto que cabe e o que cada um faz, e **para numa caixa de seleção**: escolha um modelo e clique em **Usar este modelo**. O automático (o melhor agente com visão e ferramentas) já vem marcado; se você não escolher em 2 minutos, ele roda sozinho, e só depois disso o notebook baixa alguma coisa. Para mudar o tempo, ou para não ser perguntado (rodar sem ninguém olhando), use *segundos_para_escolher* nas Opções (0 = não perguntar). Também dá para escolher antes, nas Opções, com *numero_da_lista*, *tipo_de_modelo* ou *modelo_manual* (nesses casos a caixa não aparece); *somente_listar_modelos* só mostra a lista e para. Os modelos **sem censura** (*uncensored* / *abliterated*) recusam menos, mas a qualidade e o uso de ferramentas variam, e o uso é por sua conta. Os números da lista são conferidos no registro do Ollama a cada execução; o contexto é uma estimativa conservadora (o notebook confere de verdade ao carregar).

---

**Leia antes de rodar**
- O Colab não garante a GPU gratuita (T4), derruba sessões ociosas e limita cada sessão a cerca de 12 h (até 24 h no Pro+).
- As regras do Colab proíbem, **em todos os planos**, "oferecer serviços web não relacionados à computação interativa" e "conectar-se a proxies remotos"; no plano gratuito proíbem também usar o Colab principalmente por uma interface web em vez do notebook. Um servidor de LLM acessado de fora por um túnel **pode se enquadrar nisso e ser encerrado sem aviso**. Um plano pago com saldo positivo remove as restrições do plano gratuito, mas não as gerais. Leia o [FAQ do Colab](${COLAB_FAQ_URL}) e os [Termos](${COLAB_TERMS_URL}).
- Use só para você. Os termos também proíbem dar acesso ao Colab a terceiros: **não compartilhe o código de conexão** (ele contém a chave de acesso e vale só nesta execução).
- Se você precisa de um servidor estável, use uma GPU alugada em um serviço que permita servir modelos (confira os termos dele): o arquivo \`openclod_llm_server.py\` da célula abaixo roda em qualquer Linux com GPU NVIDIA (\`python openclod_llm_server.py run\`) e gera o mesmo código.

O que este notebook baixa, sempre de fontes oficiais e com a versão e o SHA-256 conferidos: o **Ollama** (github.com/ollama/ollama), o **cloudflared** (github.com/cloudflare/cloudflared) e o **modelo** (registro do Ollama). Nada é enviado para fora além disso e do túnel que você vai usar.`

const OPTIONS = `#@title Opções (opcional: pode deixar como está) { display-mode: "form" }
# Sem mexer em nada, a etapa 2 mostra TODOS os modelos abertos que cabem na GPU (inclusive sem censura), numerados, e PARA numa caixa
# de seleção com o botão "Usar este modelo" (2 minutos); sem escolha, roda o melhor modelo com visão e ferramentas que cabe. Para
# escolher já aqui, sem a caixa, use um destes campos (do primeiro ao último, o primeiro preenchido vence):
# modelo_manual: etiqueta do Ollama (ex.: qwen3.5:9b) ou hf.co/usuario/repositorio:Q4_K_M. Em branco = não usar.
modelo_manual = ""  #@param {type:"string"}
# numero_da_lista: o número do modelo na lista da etapa 2 (a lista só depende da GPU). 0 = não usar.
numero_da_lista = 0  #@param {type:"integer"}
# tipo_de_modelo: "automático" = o melhor agente com visão e ferramentas; os outros pegam o maior modelo desse tipo que cabe.
tipo_de_modelo = "automático"  #@param ["automático", "sem censura", "código", "raciocínio", "leve e rápido"]
# somente_listar_modelos: marque para só ver a lista (nada é baixado), escolha o número, desmarque e use Executar tudo.
somente_listar_modelos = False  #@param {type:"boolean"}
# segundos_para_escolher: quanto tempo a etapa 2 espera pela sua escolha na caixa de seleção antes de seguir com o automático. 0 = não
# perguntar (vai direto no automático, útil para rodar sem ninguém olhando). Só vale quando os campos acima estão em branco.
segundos_para_escolher = 120  #@param {type:"integer"}
# contexto_manual: tamanho da janela de contexto em tokens. 0 = o maior que cabe (de 8k a 128k conforme a GPU e o modelo).
contexto_manual = 0  #@param {type:"integer"}
# pensamento: "padrão" = decide a tabela (desligado em GPUs até 24 GB, para ficar rápido); "ligado" ou "desligado" força.
pensamento = "padrão"  #@param ["padrão", "ligado", "desligado"]
# Modelo com acesso restrito (opcional): guarde o token do Hugging Face em Segredos (ícone da chave) com o nome HF_TOKEN.`

function serverCell(source: string): string {
  return `#@title Servidor do Openclod (código aberto: use "Mostrar código" para ler tudo) { display-mode: "form" }
import pathlib
import sys

SERVIDOR = r'''${source}'''

pathlib.Path("/content/openclod_llm_server.py").write_text(SERVIDOR, encoding="utf-8")
if "/content" not in sys.path:
    sys.path.insert(0, "/content")
print("Servidor do Openclod gravado em /content/openclod_llm_server.py (%d linhas)." % (SERVIDOR.count("\\n")))
`
}

// The ";" at the end of each call keeps Colab from printing the value the step returns (a dict, a path) under the lines the step prints.
const STEPS: Array<{ id: string; title: string; body: string }> = [
  { id: 'openclod-passo-1', title: '1 · Conferir a GPU', body: 'import openclod_llm_server as oc\n\noc.step_gpu();' },
  {
    id: 'openclod-passo-2',
    title: '2 · Mostrar os modelos que cabem nesta GPU e escolher',
    body: `import openclod_llm_server as oc

try:
    from google.colab import userdata
    token_hf = userdata.get("HF_TOKEN")
except Exception:
    token_hf = ""

oc.step_plan(modelo_manual, contexto_manual, pensamento, token_hf or "", numero_da_lista, tipo_de_modelo, somente_listar_modelos, segundos_para_escolher);`
  },
  { id: 'openclod-passo-3', title: '3 · Instalar o motor (Ollama)', body: 'import openclod_llm_server as oc\n\noc.step_install_engine();' },
  { id: 'openclod-passo-4', title: '4 · Baixar o modelo e carregar na GPU', body: 'import openclod_llm_server as oc\n\noc.step_model();' },
  { id: 'openclod-passo-5', title: '5 · Subir o servidor (exige a chave gerada agora)', body: 'import openclod_llm_server as oc\n\noc.step_server();' },
  { id: 'openclod-passo-6', title: '6 · Abrir o túnel público', body: 'import openclod_llm_server as oc\n\noc.step_tunnel();' },
  {
    id: 'openclod-passo-7',
    title: '7 · Autoteste, código de conexão e painel (esta célula fica rodando: não feche a aba)',
    body: 'import openclod_llm_server as oc\n\noc.step_serve_forever()'
  }
]

const OUTRO = `### Se algo falhar
- **"Este ambiente não tem GPU"**: *Ambiente de execução → Alterar o tipo de ambiente de execução → GPU* e rode tudo de novo.
- **Falta de memória ou modelo grande demais**: o notebook já tenta a próxima opção da tabela; para forçar um modelo menor use \`modelo_manual\` (ex.: \`qwen3.5:4b\`).
- **O túnel não abre**: rode a célula 6 de novo (o endereço muda a cada túnel). Se o seu ambiente bloqueia saída na porta 7844, este método não funciona nele.
- **O Openclod diz "caiu" depois de um tempo**: a sessão do Colab terminou. Rode tudo de novo e cole o código novo (o endereço e a chave mudam a cada execução).
- Mais detalhes no Openclod: *docs/COLAB.md*.`

/** The whole notebook. `serverSource` is the module text (resources/colab/openclod_llm_server.py). */
export function buildColabNotebook(options: { serverSource: string; version?: string }): ColabNotebook {
  const source = normalizeServerSource(options.serverSource)
  if (source.includes("'''")) throw new Error("o módulo do servidor não pode conter ''' (ele vai dentro de uma string do notebook)")
  if (/\\\s*$/.test(source)) throw new Error('o módulo do servidor não pode terminar com uma barra invertida')
  const version = options.version ?? COLAB_NOTEBOOK_VERSION
  const cells: ColabCell[] = [
    markdown('openclod-intro', INTRO),
    code('openclod-opcoes', OPTIONS, FORM),
    code('openclod-servidor', serverCell(source), FORM),
    ...STEPS.map((step) => code(step.id, `#@title ${step.title} { display-mode: "form" }\n${step.body}`, FORM)),
    markdown('openclod-ajuda', OUTRO)
  ]
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      accelerator: 'GPU',
      colab: { name: COLAB_NOTEBOOK_FILE, provenance: [], gpuType: 'T4', toc_visible: true },
      kernelspec: { display_name: 'Python 3', name: 'python3' },
      language_info: { name: 'python' },
      openclod: { notebookVersion: version, serverSha256: serverSourceHash(source) }
    },
    cells
  }
}

/** The .ipynb text (one-space indent, trailing newline: what Jupyter and Colab write). */
export function colabNotebookJson(options: { serverSource: string; version?: string }): string {
  return `${JSON.stringify(buildColabNotebook(options), null, 1)}\n`
}
