# Avisos de terceiros (Third-Party Notices)

Este documento lista os componentes de terceiros distribuídos com o **Openclod Desktop**
(versão 0.1.0) ou usados para construí-lo. Ele deve acompanhar o instalador e o
código-fonte.

- O código do Openclod Desktop é licenciado sob MIT.
- As licenças abaixo são as declaradas nos pacotes instalados em `node_modules`
  (campo `license` do `package.json` e arquivo `LICENSE` de cada pacote).
- Nenhum texto de licença foi removido ou alterado.

## 1. Dependências de runtime

Estas bibliotecas fazem parte do aplicativo distribuído.

| Pacote | Versão instalada | Licença | Uso no Openclod Desktop |
|---|---|---|---|
| [`diff`](https://github.com/kpdecker/jsdiff) | 5.2.2 | **BSD-3-Clause** | Geração de diffs de arquivos para a UI e para o rastreador de mudanças. |
| [`dompurify`](https://github.com/cure53/DOMPurify) | 3.4.17 | **MPL-2.0 OR Apache-2.0** (esta distribuição usa Apache-2.0) | Sanitização do HTML produzido a partir de markdown antes de renderizar. |
| [`marked`](https://marked.js.org) | 15.0.12 | **MIT** | Conversão de markdown em HTML no renderer. |
| [`playwright`](https://playwright.dev) | 1.64.1 | **Apache-2.0** | Automação do navegador (Chrome/Edge/Chromium). Inclui `playwright-core`, também Apache-2.0. |
| [`zod`](https://zod.dev) | 4.6.7 | **MIT** | Validação de entrada das ferramentas e conversão nativa para JSON Schema. |
| [`fflate`](https://github.com/101arrowz/fflate) | 0.8.3 | **MIT** | Leitura ZIP local de DOCX/XLSX/PPTX. |
| [`sharp`](https://sharp.pixelplumbing.com) | 0.35.5 | **Apache-2.0** | Inspeção, edição e conversão local de imagens. |
| [`react`](https://react.dev) | 19.3.1 | **MIT** | Interface (renderer). |
| [`react-dom`](https://react.dev) | 19.3.1 | **MIT** | Renderização da interface no DOM. |

> `react` e `react-dom` estão declarados em `devDependencies` porque o Vite os
> empacota no bundle do renderer durante o build. Ainda assim, o **código deles é
> distribuído dentro do artefato final** e por isso consta aqui como runtime.

### Dependência transitiva relevante

| Pacote | Versão | Licença | Observação |
|---|---|---|---|
| `playwright-core` | 1.64.1 | Apache-2.0 | Motor de automação usado por `playwright`. |

### Componentes opcionais (não empacotados)

| Componente | Licença | Observação |
|---|---|---|
| [`open-computer-use`](https://github.com/opensymph/open-computer-use) | MIT | Backend de Computer Use (Go), **empacotado** em `resources/bin/open-computer-use.exe`. |
| Navegadores baixados por `npx playwright install` | Licenças do projeto Chromium | Não são distribuídos pelo instalador do Openclod Desktop; o usuário os baixa separadamente. |

## 2. Runtime desktop

| Componente | Licença | Observação |
|---|---|---|
| **Electron** 45.x | MIT | Runtime do aplicativo. |
| **Chromium** (embutido no Electron) | BSD-3-Clause + licenças de componentes de terceiros | O arquivo `LICENSES.chromium.html` acompanha a distribuição do Electron (`node_modules/electron/dist/LICENSES.chromium.html`) e **deve ser incluído no instalador**. |
| **Node.js** (embutido no Electron) | MIT | Runtime JavaScript. |
| **npm** (apenas desenvolvimento) | Artistic-2.0 | Não é distribuído com o app. |

## 3. Ferramentas de build (não distribuídas)

Estes pacotes são usados apenas para compilar, testar e empacotar. Não entram no
artefato final (exceto o resultado do build):

| Pacote | Versão instalada | Licença |
|---|---|---|
| `electron` | 45.0.0 | MIT |
| `electron-builder` | 26.15.3 | MIT |
| `electron-vite` | 3.1.0 | MIT |
| `vite` | 6.4.5 | MIT |
| `@vitejs/plugin-react` | 4.x | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 5.0.5 | MIT |
| [`simple-icons`](https://simpleicons.org) | 16.36.0 | **CC0-1.0** (coleção; cada marca segue o próprio dono, ver seção 5) |
| `@types/node`, `@types/react`, `@types/react-dom`, `@types/diff` | 22.x / 19.x / 5.x | MIT (DefinitelyTyped) |

> `simple-icons` é `devDependency` e **não vai no instalador**: só o coletor de logos
> (`scripts/connector-icons.mjs`, `npm run connector-icons`) o lê, em desenvolvimento, para
> escrever os ladrilhos SVG das marcas que ele cobre (o caminho do glifo e a cor oficial; o
> coletor escreve o SVG, nenhum arquivo do pacote é copiado). O app só carrega os arquivos já
> gerados em `src/renderer/public/connector-icons/`. Origem de cada imagem:
> `docs/mcp/icones-conectores.json`.

## 4. Fontes incluídas

| Fonte | Arquivo | Licença |
|---|---|---|
| **Inter** (variável) | `src/renderer/src/assets/fonts/InterVariable.woff2` | **SIL Open Font License 1.1** |
| **Source Serif 4** (variável) | `src/renderer/src/assets/fonts/SourceSerif4Variable.woff2` | **SIL Open Font License 1.1** |

A SIL OFL 1.1 exige que o aviso de copyright e o texto da licença acompanhem a
redistribuição das fontes. O texto integral está em
<https://openfontlicense.org/open-font-license-official-text/>. As fontes são
usadas apenas na interface do Openclod Desktop e não foram modificadas.

## 4.1 Runtime de voz embarcado (`resources/`)

Distribuído para o ditado local (Whisper), a criação de documentos do Office e
ferramentas nativas. Versões,
tamanhos e hashes estão em `resources/MANIFEST.json`.

| Componente | Licença | Uso |
|---|---|---|
| Python 3.10 embutido | **PSF-2.0** | Runtime do sidecar de reconhecimento de voz. |
| edge-tts 7.3.1 | **LGPL-3.0** | Vozes neurais gratuitas da Microsoft Edge. Licença em `resources/licenses/python/edge-tts/LICENSE.txt`. |
| aiohttp, aiohappyeyeballs, aiosignal, async-timeout, attrs, frozenlist, multidict, propcache, tabulate e yarl | Apache-2.0/MIT/BSD conforme os metadados dos pacotes | Dependências do cliente HTTP `edge-tts`. |
| faster-whisper 1.2.1 | **MIT** | Inferência Whisper em CTranslate2. |
| CTranslate2 4.7.1 | **MIT** | Backend de inferência. |
| NVIDIA CUDA 12 / cuBLAS / cuDNN 9 runtime DLLs | **NVIDIA CUDA Toolkit EULA / cuDNN SLA** | Aceleração opcional do Whisper em GPU NVIDIA. As DLLs são carregadas localmente; nenhum áudio sai do computador. |
| Silero VAD (ONNX, via faster-whisper) | **MIT** | Detecção de fala no streaming. |
| Modelos `tiny`, `base`, `small` (Systran/faster-whisper-*) | **MIT** | Pesos locais; nenhum áudio é enviado a terceiros. |
| PyAV, onnxruntime, tokenizers, huggingface-hub, numpy e demais dependências | Licenças declaradas no `MANIFEST.json` (MIT/Apache/BSD) | Dependências do sidecar. |
| python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2 e et-xmlfile 2.0.0 | **MIT** | Criação e leitura de .docx, .xlsx e .pptx pelo Cowork, no mesmo Python embutido (`scripts/embed-office.mjs`, rodas fixadas por versão e sha256). Licenças em `resources/licenses/office/`. |
| XlsxWriter 3.3.0 | **BSD-2-Clause** | Planilhas com fórmulas reais, formatos e gráficos nativos. |
| lxml 6.1.1 | **BSD-3-Clause** | XML das bibliotecas de documentos (a roda traz libxml2, libxslt e zlib; ver `resources/licenses/office/lxml`). |
| Pillow 12.3.0 | **MIT-CMU** | Imagens e gráficos em PNG dos documentos. A roda inclui FreeType (FreeType License), HarfBuzz, LittleCMS, libjpeg-turbo, libavif, brotli e outros; o aviso completo está em `resources/licenses/office/pillow/LICENSE`. |
| typing-extensions 4.15.0 | **PSF-2.0** | Já embarcado como dependência do huggingface-hub; também exigido por python-docx e python-pptx. |
| `openclod_office` (construtores de documentos) | **MIT** (código do projeto) | `resources/office/pylib`: relatório Word, planilha e apresentação sobre as bibliotecas acima, mais os comandos `openclod-python` e `openclod-office`. |
| claude-real-video 0.7.19 (lógica portada) | **MIT** — Copyright (c) 2026 LeoAido. Texto em `resources/licenses/claude-real-video/MIT.txt` | Seleção de frames por mudança de cena com piso de densidade, deduplicação em três canais, folhas de contato e linha do tempo do ingestor de áudio/vídeo (`resources/media/openclod_media.py`), reescritos sobre PyAV e numpy (sem ffmpeg nem Pillow). https://github.com/HUANGCHIHHUNGLeo/claude-real-video |
| open-computer-use 1.3.0 | **MIT** | Backend de Computer Use (Go). |
| ripgrep 14.1.1 | **MIT OR Unlicense** | Busca de arquivos. |
| llama.cpp b11972 — `llama-server` e as DLLs do ggml (build Vulkan oficial para Windows x64) | **MIT** — Copyright (c) 2023-2026 The ggml authors. Texto em `resources/licenses/llama.cpp/LICENSE` | Motor local de LLM (Configurações → Provedores → llama.cpp). `scripts/embed-llamacpp.mjs` baixa o zip oficial de https://github.com/ggml-org/llama.cpp/releases, confere o SHA-256 e guarda só o servidor e as DLLs que ele carrega em `resources/llamacpp/b11972-vulkan/`. Sem modificações. |
| LLVM OpenMP runtime (`libomp.dll`, dentro do zip do llama.cpp) | **Apache-2.0 WITH LLVM-exception** | Threads do llama.cpp na CPU. A licença vai junto dos binários (`resources/llamacpp/b11972-vulkan/LICENSE-LLVM-OpenMP`). |

As versões CUDA e "só CPU" do llama.cpp (Versões) **não vêm no instalador**: são baixadas
do mesmo release oficial do GitHub quando a pessoa pede, conferidas pelo SHA-256 que o
GitHub publica. As CUDA trazem o runtime da NVIDIA (`cudart`, cuBLAS), sob a NVIDIA CUDA
Toolkit EULA. Os modelos GGUF baixados do Hugging Face (Baixar) têm cada um a sua licença,
mostrada antes do download; alguns exigem aceitar termos na página do modelo.

O `edge-tts` acessa o serviço de leitura em voz alta do Microsoft Edge, sem chave
de API. O recurso exige internet, pode mudar ou ficar indisponível por decisão da
Microsoft e não é uma API oficial com SLA. Por isso, o Openclod mantém
`System.Speech` do Windows como fallback offline. O Openclod Desktop não é
afiliado nem endossado pela Microsoft.

## 4.2 Projetos estudados sem código incorporado

| Projeto | Licença | Como foi usado |
|---|---|---|
| [ai-memory](https://github.com/akitaonrails/ai-memory) | **MIT** | Motor de memória de longo prazo executado como sidecar (`resources/bin/ai-memory.exe`, licença em `resources/licenses/ai-memory/MIT.txt`). O grafo consome a API oficial `/api/v1/graph` e complementa com conexões semânticas próprias. O layout circular inicial em `src/renderer/src/lib/graph-layout.ts` é uma adaptação do `circular_layout` de `crates/ai-memory-web/src/routes/graph.rs`. |
| [Wispr Flow](https://wisprflow.ai) | **Proprietário** | Análise de comportamento com REA (instalador, `app.asar`, helper .NET). Nenhum código, ícone, fonte, prompt ou artefato foi copiado; o ditado do Openclod Desktop é uma implementação independente. |
| [opencode](https://github.com/anomalyco/opencode) | MIT | Referência de padrões; trechos adaptados estão identificados no código. |
| [munim-computer-use](https://github.com/munimtechnologies/munim-computer-use) | **Apache-2.0** | Algoritmo de settle adaptado em `src/core/computer/settle.ts`; backend MCP em avaliação. Procedência em `docs/research/CODE_PROVENANCE.md`. |
| [openharness](https://github.com/pokkai/openharness) | MIT | Referência de hooks, permissões e compactação; sem código copiado. |
| [cdesktop](https://github.com/cdesktop-ai/cdesktop) | Apache-2.0 | Referência de UX e executores; sem código copiado. |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Referência de plugins/eventos; sem código copiado. |
| [REA](https://github.com/morluto/rea) | MIT | Ferramenta de análise usada no estudo; preset MCP opcional. |
| [claw-code-local](https://github.com/codetwentyfive/claw-code-local) | Sem licença | Apenas conceitos (hooks exit 2/JSON, deny > ask > allow); nenhum código. |
| [Mcp.ComputerUse](https://github.com/tdav/Mcp.ComputerUse) | Sem licença | Apenas ideias de DPI/coordenadas; nenhum código. |

## 4.3. Assets de pesquisa (skills, agentes, comandos e prompts)

O aplicativo distribui cópias de assets portáveis (MIT/Apache-2.0) em
`resources/harvested/`. Cada item tem origem, commit, licença e hash em
`resources/harvested/manifest.json`; os textos integrais das licenças estão em
`resources/harvested/LICENSES/`.

- **387 skills**, **21 agentes**, **23 comandos**, **168 prompts** e **25 fontes
  de ferramentas** de referência.
- Desses, **5 skills** e **5 agentes** foram curados para o runtime em
  `resources/skills/` e `resources/agents/`, com `origin`/`license` no
  frontmatter e adaptação às ferramentas do Openclod.
- Nenhum asset de `zed`, `claw-code-local`, `Mcp.ComputerUse`, `wisprflow`,
  `ee/` ou `enterprise/` foi copiado.
- As cópias são de referência e **não são compiladas**; o código portado para
  `src/core` tem entrada própria neste arquivo.

## 5. Marcas e código proprietário

- **Nenhum código-fonte, logo, ícone ou arquivo de fonte proprietário da
  Anthropic/Claude é usado, copiado ou redistribuído neste projeto.**
- "Claude" e "Anthropic" são marcas registradas de Anthropic PBC. Os nomes
  aparecem apenas para identificar interoperabilidade de API (provedor compatível).
- O Openclod Desktop é um projeto independente, **sem afiliação, patrocínio ou endosso** da
  Anthropic ou de qualquer outro fornecedor de modelos.
- A interface usa identidade visual própria (tipografia Inter + Source Serif 4,
  ambas OFL). Nenhum recurso visual proprietário do Claude Desktop é reproduzido.
- **Logos dos conectores (Personalização → Conectores).** A tela mostra o logo de cada
  serviço (GitHub, Notion, Slack, Atlassian etc.) em `src/renderer/public/connector-icons/`
  (~890 imagens). São **marcas registradas dos respectivos donos**, usadas **somente para
  identificar o serviço** a que o conector se refere (uso nominativo); não indicam parceria,
  patrocínio nem endosso, e continuam sob os termos de cada marca (veja as diretrizes de
  marca de cada fornecedor antes de reutilizá-las fora do Openclod). Foram coletadas em
  desenvolvimento, de quatro fontes: o `iconUrl` do próprio diretório de conectores, o site do
  fornecedor (apple-touch-icon / ícone declarado na página), o pacote `simple-icons` (CC0, só os
  glifos) e, como último recurso, serviços públicos de favicons (Google, DuckDuckGo). O
  **manifesto `docs/mcp/icones-conectores.json`** registra, para cada imagem, o arquivo, a
  fonte, o endereço de origem, o domínio e o tamanho original. O app **nunca baixa logos em
  tempo de execução**. Por esta seção, os logos da Anthropic/Claude **não** são incluídos (os
  conectores da Anthropic ficam com as iniciais). Se um titular de marca pedir a remoção de um
  logo, basta marcá-lo com `skip` em `scripts/data/connector-icons-overrides.json` e rodar o
  coletor de novo.
- **Marcas dos provedores (Configurações → Provedores).** A grade e os cartões de provedor
  mostram a marca de DeepSeek, Google Colab, Kimi/Moonshot, LM Studio, Ollama, OpenAI,
  OpenCode, OpenRouter e Qwen. São **marcas registradas dos respectivos donos**, usadas
  **somente para identificar o provedor** (uso nominativo), sem parceria nem endosso. Cada
  desenho é um caminho SVG embutido em `src/renderer/src/lib/provider-logos.ts`, **gerado** por
  `scripts/provider-logos.mjs` a partir do pacote `simple-icons` (CC0, só o glifo e a cor
  oficial) e, para a OpenAI (que o `simple-icons` deixou de distribuir), do arquivo
  `docs/images/provider-icons/openai.svg` do repositório
  [mem0ai/mem0](https://github.com/mem0ai/mem0) (Apache-2.0), cuja origem fica anotada em cada
  entrada do arquivo gerado. O app **nunca baixa logos em tempo de execução**. A
  **Anthropic/Claude não tem marca** nessa grade (§5, primeiro item): o provedor mostra a
  inicial. Provedores criados pelo usuário também mostram as iniciais.

## 6. Obrigações práticas de distribuição

Ao gerar um instalador de release:

1. Incluir este arquivo (`THIRD_PARTY_NOTICES.md`) no pacote ou ao lado dele.
2. Incluir os textos integrais das licenças dos pacotes distribuídos. Eles estão em
   `node_modules/<pacote>/LICENSE` (ou `LICENSE.md`). Para Apache-2.0, incluir
   também o `NOTICE`, se existir.
3. Incluir `LICENSES.chromium.html` do Electron.
4. Incluir o texto da SIL OFL 1.1 junto com as fontes.
5. Não remover avisos de copyright dos arquivos de terceiros.
6. Em caso de dúvida, gerar um SBOM (`npm sbom --omit=dev`) junto do release.

## 7. Textos de licença (formas curtas)

Os textos abaixo são reproduzidos para os pacotes MIT/ISC/BSD-3-Clause listados.
Para Apache-2.0 e MPL-2.0, consulte o texto integral em
`node_modules/dompurify/LICENSE`, `node_modules/playwright/LICENSE` e
`node_modules/playwright-core/LICENSE`.

### MIT

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Titulares: Copyright (c) Meta Platforms, Inc. and affiliates (React, React DOM);
Copyright (c) 2025 Colin McDonnell (Zod); Copyright (c) 2018+, MarkedJS e
Copyright (c) 2011-2018, Christopher Jeffrey (marked); Copyright (c) Electron
contributors (Electron); demais titulares conforme os arquivos `LICENSE` de cada
pacote.

### ISC

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Titular: Copyright (c) 2020, Stefan Terdell (`zod-to-json-schema`).

### BSD-3-Clause

```
BSD 3-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Titular: Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
(`diff`/jsdiff).

### Apache-2.0 (resumo e localização)

`dompurify` é dual-licenciado como `MPL-2.0 OR Apache-2.0`; esta distribuição
escolhe **Apache-2.0**. `playwright`, `playwright-core` e `typescript` também são
Apache-2.0. O texto integral está em:

- `node_modules/dompurify/LICENSE`
- `node_modules/playwright/LICENSE`
- `node_modules/playwright-core/LICENSE`
- `node_modules/typescript/LICENSE.txt`

O Apache-2.0 exige manter avisos de copyright, fornecer o texto da licença,
indicar alterações em arquivos modificados e incluir `NOTICE` quando existir.
Nenhum desses pacotes foi modificado neste repositório.

### Munim Computer Use (Apache-2.0)

O ponteiro do agente em `src/main/cursor-arrow.ts` usa `cursor_arrow_112.png` do
projeto Munim Computer Use
(<https://github.com/munimtechnologies/munim-computer-use>), licenciado sob
Apache-2.0. O texto integral está em `licenses/munim-computer-use-LICENSE`.

### SIL Open Font License 1.1

Aplicada a **Inter** e **Source Serif 4**. Texto oficial:
<https://openfontlicense.org/open-font-license-official-text/>.
As fontes não foram modificadas nem vendidas separadamente.

---

Dúvidas sobre licenciamento devem ser resolvidas antes de redistribuir o Openclod Desktop.
Este documento não é aconselhamento jurídico.
