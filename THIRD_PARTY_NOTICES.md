# Avisos de terceiros (Third-Party Notices)

Este documento lista os componentes de terceiros distribuídos com o **Forja**
(versão 0.1.0) ou usados para construí-lo. Ele deve acompanhar o instalador e o
código-fonte.

- O código do Forja é licenciado sob MIT.
- As licenças abaixo são as declaradas nos pacotes instalados em `node_modules`
  (campo `license` do `package.json` e arquivo `LICENSE` de cada pacote).
- Nenhum texto de licença foi removido ou alterado.

## 1. Dependências de runtime

Estas bibliotecas fazem parte do aplicativo distribuído.

| Pacote | Versão instalada | Licença | Uso no Forja |
|---|---|---|---|
| [`diff`](https://github.com/kpdecker/jsdiff) | 5.2.2 | **BSD-3-Clause** | Geração de diffs de arquivos para a UI e para o rastreador de mudanças. |
| [`dompurify`](https://github.com/cure53/DOMPurify) | 3.4.17 | **MPL-2.0 OR Apache-2.0** (esta distribuição usa Apache-2.0) | Sanitização do HTML produzido a partir de markdown antes de renderizar. |
| [`marked`](https://marked.js.org) | 15.0.12 | **MIT** | Conversão de markdown em HTML no renderer. |
| [`playwright`](https://playwright.dev) | 1.64.1 | **Apache-2.0** | Automação do navegador (Chrome/Edge/Chromium). Inclui `playwright-core`, também Apache-2.0. |
| [`zod`](https://zod.dev) | 3.25.76 | **MIT** | Validação de entrada das ferramentas. |
| [`zod-to-json-schema`](https://github.com/StefanTerdell/zod-to-json-schema) | 3.25.2 | **ISC** | Conversão dos schemas Zod em JSON Schema enviado ao modelo. |
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
| [`@opensymph/open-computer-use`](https://www.npmjs.com/package/@opensymph/open-computer-use) | MIT | Backend opcional de Computer Use. **Não é empacotado** no instalador; é instalado globalmente pelo usuário (`npm i -g @opensymph/open-computer-use`) e detectado em tempo de execução. Seus avisos de licença são responsabilidade da instalação global do usuário. |
| Navegadores baixados por `npx playwright install` | Licenças do projeto Chromium | Não são distribuídos pelo instalador do Forja; o usuário os baixa separadamente. |

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
| `vitest` | 3.2.7 | MIT |
| `@types/node`, `@types/react`, `@types/react-dom`, `@types/diff` | 22.x / 19.x / 5.x | MIT (DefinitelyTyped) |

## 4. Fontes incluídas

| Fonte | Arquivo | Licença |
|---|---|---|
| **Inter** (variável) | `src/renderer/src/assets/fonts/InterVariable.woff2` | **SIL Open Font License 1.1** |
| **Source Serif 4** (variável) | `src/renderer/src/assets/fonts/SourceSerif4Variable.woff2` | **SIL Open Font License 1.1** |

A SIL OFL 1.1 exige que o aviso de copyright e o texto da licença acompanhem a
redistribuição das fontes. O texto integral está em
<https://openfontlicense.org/open-font-license-official-text/>. As fontes são
usadas apenas na interface do Forja e não foram modificadas.

## 4.1 Runtime de voz embarcado (`resources/`)

Distribuído para o ditado local (Whisper) e ferramentas nativas. Versões,
tamanhos e hashes estão em `resources/MANIFEST.json`.

| Componente | Licença | Uso |
|---|---|---|
| Python 3.10 embutido | **PSF-2.0** | Runtime do sidecar de reconhecimento de voz. |
| faster-whisper 1.2.1 | **MIT** | Inferência Whisper em CTranslate2. |
| CTranslate2 4.7.1 | **MIT** | Backend de inferência. |
| Silero VAD (ONNX, via faster-whisper) | **MIT** | Detecção de fala no streaming. |
| Modelos `tiny`, `base`, `small` (Systran/faster-whisper-*) | **MIT** | Pesos locais; nenhum áudio é enviado a terceiros. |
| PyAV, onnxruntime, tokenizers, huggingface-hub, numpy e demais dependências | Licenças declaradas no `MANIFEST.json` (MIT/Apache/BSD) | Dependências do sidecar. |
| open-computer-use 1.3.0 | **MIT** | Backend de Computer Use (Go). |
| ripgrep 14.1.1 | **MIT OR Unlicense** | Busca de arquivos. |

## 4.2 Projetos estudados sem código incorporado

| Projeto | Licença | Como foi usado |
|---|---|---|
| [ai-memory](https://github.com/akitaonrails/ai-memory) | **MIT** | Estudo do modelo (wiki markdown por projeto, índice derivado, briefing, handoffs claim-once). A implementação do Forja é independente, em TypeScript; nenhum código Rust foi copiado. O binário oficial pode ser ligado como MCP. |
| [Wispr Flow](https://wisprflow.ai) | **Proprietário** | Análise de comportamento com REA (instalador, `app.asar`, helper .NET). Nenhum código, ícone, fonte, prompt ou artefato foi copiado; o ditado do Forja é uma implementação independente. |
| [opencode](https://github.com/anomalyco/opencode) | MIT | Referência de padrões; trechos adaptados estão identificados no código. |
| [openharness](https://github.com/pokkai/openharness) | MIT | Referência de hooks, permissões e compactação; sem código copiado. |
| [cdesktop](https://github.com/cdesktop-ai/cdesktop) | Apache-2.0 | Referência de UX e executores; sem código copiado. |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Referência de plugins/eventos; sem código copiado. |
| [REA](https://github.com/morluto/rea) | MIT | Ferramenta de análise usada no estudo; preset MCP opcional. |
| [claw-code-local](https://github.com/codetwentyfive/claw-code-local) | Sem licença | Apenas conceitos (hooks exit 2/JSON, deny > ask > allow); nenhum código. |
| [Mcp.ComputerUse](https://github.com/tdav/Mcp.ComputerUse) | Sem licença | Apenas ideias de DPI/coordenadas; nenhum código. |

## 5. Marcas e código proprietário

- **Nenhum código-fonte, logo, ícone ou arquivo de fonte proprietário da
  Anthropic/Claude é usado, copiado ou redistribuído neste projeto.**
- "Claude" e "Anthropic" são marcas registradas de Anthropic PBC. Os nomes
  aparecem apenas para identificar interoperabilidade de API (provedor compatível).
- O Forja é um projeto independente, **sem afiliação, patrocínio ou endosso** da
  Anthropic ou de qualquer outro fornecedor de modelos.
- A interface usa identidade visual própria (tipografia Inter + Source Serif 4,
  ambas OFL). Nenhum recurso visual proprietário do Claude Desktop é reproduzido.

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

### SIL Open Font License 1.1

Aplicada a **Inter** e **Source Serif 4**. Texto oficial:
<https://openfontlicense.org/open-font-license-official-text/>.
As fontes não foram modificadas nem vendidas separadamente.

---

Dúvidas sobre licenciamento devem ser resolvidas antes de redistribuir o Forja.
Este documento não é aconselhamento jurídico.
