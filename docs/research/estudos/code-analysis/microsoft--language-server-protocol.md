# Language Server Protocol (especificação)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/microsoft/language-server-protocol |
| Clone local | `repositorios/_research/code-analysis/microsoft--language-server-protocol` |
| Commit | `baf2db31b5fb314a8f358f9a839d3c66e9d98734` |
| Licença | Texto da especificação: **CC BY 4.0** (`License.txt:1`); código: **MIT** (`License-code.txt:1`). Atribuição obrigatória ao usar o texto. |
| Categoria | code-analysis / protocolo (LSP) |
| Stack | Markdown + Jekyll (`_config.yml`, `Gemfile`), JSON Schema + `metaModel.json`, TypeScript embutido nos blocos de exemplo; spec também de LSIF |
| Tamanho | 383 arquivos, ~52k linhas; 6 versões de LSP (3.14 → 3.19; a estável declarada é 3.18, `index.html:97`) + LSIF 0.4/0.5/0.6 |

## 1. O que é (verificado no código)

Não é software executável: é a **especificação** do protocolo que clientes (editores) e
servidores (language servers) falam, mais um *meta model* legível por máquina. O texto é
versionado em markdown por release (`_specifications/lsp/3.17/...`,
`_specifications/lsp/3.18/...`, `_specifications/lsp/3.19/...`) e há um índice que declara
a versão estável: "The latest version of the LSP specification is version 3.18"
(`index.html:97`).

O valor prático está em três artefatos:

1. **Base protocol** — framing por header + `Content-Length` + JSON-RPC
   (`_specifications/lsp/3.17/specification.md:26-54`).
2. **Modelo de tipos** — `metaModel.json` (409.982 bytes,
   `_specifications/lsp/3.17/metaModel/metaModel.json:2-4` declara `"version": "3.17.0"`)
   com requests, notifications, structures, enumerations e type aliases.
3. **Semântica de cada feature** — quem pergunta o quê, com quais campos, e o que o cliente
   deve suportar (capabilities).

## 2. Como executar e comandos reais

Não há binário. O "comando" é uma mensagem no socket/stdio.

| Comando / mensagem | Onde está | O que faz |
|---|---|---|
| `initialize` / `initialized` | `3.17/general/initialize.md:1` | negocia capabilities e `positionEncoding` |
| `textDocument/definition` | `3.17/language/definition.md:1` | localização da definição |
| `textDocument/references` | `3.17/language/references.md:1` | referências (com `includeDeclaration`) |
| `textDocument/hover` | `3.17/language/hover.md:51` | MarkupContent + range opcional |
| `textDocument/rename` + `prepareRename` | `3.17/language/rename.md:1` | WorkspaceEdit com anotações |
| `textDocument/documentSymbol` | `3.17/language/documentSymbol.md:1` | símbolos hierárquicos do arquivo |
| `workspace/symbol` + `workspaceSymbol/resolve` | `3.17/workspace/symbol.md:3` | símbolos do projeto |
| `textDocument/diagnostic` | `3.17/language/pullDiagnostics.md:114` | diagnóstico *pull* por documento |
| `workspace/diagnostic` | `3.17/language/pullDiagnostics.md:335` | diagnóstico *pull* do workspace |
| `workspace/executeCommand` | `3.17/workspace/executeCommand.md:1` | comandos específicos do servidor |
| `$/cancelRequest` | `3.17/specification.md:338` | cancelamento de request |

O framing exige `Content-Length` (`specification.md:39`), header em ASCII (`:43`) e corpo
JSON-RPC (`:47`). Sem isso, nenhum servidor real responde.

## 3. Arquitetura e fluxo

```
cliente (editor/agente)
  → initialize (capabilities do cliente)            [general/initialize.md]
    ← InitializeResult (capabilities do servidor)   [types + metaModel]
      → textDocument/didOpen (texto + versão)       [textDocument/didOpen.md]
        → textDocument/definition|references|hover  [language/*.md]
          ← Location[] | LocationLink[] | Hover | WorkspaceEdit
            → textDocument/publishDiagnostics (push) ou textDocument/diagnostic (pull)
```

- Base: `3.17/specification.md:26-54` (header, content, JSON-RPC).
- Negociação: `initialize.md` define `ClientCapabilities`/`ServerCapabilities`; cada
  feature tem bloco `_Client Capability_` e `_Server Capability_` (ex.:
  `definition.md:4-30`).
- Sincronização de documento: `didOpen`/`didChange`/`didSave`/`didClose`
  (`3.17/textDocument/*`), com `TextDocumentSyncKind.Incremental` (o jdtls usa,
  `eclipse-jdtls.../handlers/InitHandler.java:84`).
- Diagnóstico: dois modelos coexistem — push (`publishDiagnostics.md`) e pull
  (`pullDiagnostics.md:114`), este com `resultId`/`previousResultId` (`:140`, `:207`) e
  `relatedDocuments` (`:261`).
- Cancelamento: `$/cancelRequest` (`specification.md:338`); progresso:
  `$/progress` (`types/workDoneProgress.md`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Definition | `3.17/language/definition.md:1` | `Location` ou `LocationLink` (desde 3.14) | baixo |
| References | `3.17/language/references.md:1` | referências com `includeDeclaration` | baixo |
| Hover | `3.17/language/hover.md:51-81` | Markdown/plaintext + range | baixo |
| Rename | `3.17/language/rename.md:1` | WorkspaceEdit (multi-arquivo) | **alto** (edita workspace) |
| Prepare rename | `3.17/language/rename.md:20-40` | valida range antes de renomear | baixo |
| Document symbol | `3.17/language/documentSymbol.md:1` | `DocumentSymbol[]` hierárquico | baixo |
| Workspace symbol | `3.17/workspace/symbol.md:3` | busca por nome no projeto | baixo |
| Pull diagnostics | `3.17/language/pullDiagnostics.md:114` | diagnóstico por demanda, cacheável | baixo |
| Code action | `3.17/language/codeAction.md:1` | quick fix + refactor | **alto** |
| Implementation / type hierarchy | `3.17/language/implementation.md:1`, `typeHierarchy.md:1` | subtipos e hierarquia | baixo |
| Semantic tokens | `3.17/language/semanticTokens.md:1` | highlight semântico | baixo |
| Inlay hints | `3.17/language/inlayHint.md:1` | tipos/parâmetros inline | baixo |
| Moniker (símbolo estável) | `3.17/language/moniker.md:1` | ID de símbolo entre projetos | baixo |
| File operations | `3.17/workspace/willRenameFiles.md:1` | rename de arquivo com edits | **alto** |

## 5. Loop do agente, contexto e streaming

O LSP define o **contrato** que permite a um agente pedir inteligência sem saber a
linguagem:

- **Posição**: zero-based `line`/`character`, com `positionEncoding` negociado —
  `utf-16` é o default (`types/position.md:51-56`), e há `utf-8`/`utf-32` (`:46`, `:59`).
  Este é o detalhe que mais gera bug de off-by-N ao converter offset de byte (nosso caso)
  para posição LSP.
- **Contexto mínimo**: cada request carrega `textDocument` + `position`; não há "sessão de
  conversa". O estado é o documento aberto e a versão (`versionedTextDocumentIdentifier`).
- **Streaming**: resultados parciais existem via `partialResultToken`/`workDoneToken`
  (`types/partialResults.md`), não via stream contínuo. Progresso é notificação.
- **Cancelamento**: `$/cancelRequest` (`specification.md:338`) — obrigatório para não
  deixar request pendurado quando o agente desiste.
- **Retry**: não especificado; erro volta como `ResponseError` com `code`/`message`/
  `data`, e o cliente decide.

## 6. Sessões, estado e persistência

- A especificação **não define persistência**: nem índice, nem cache, nem formato de
  projeto. Cada servidor decide (jdtls usa workspace Eclipse; rust-analyzer usa
  `target/`; tsserver usa memória).
- O que existe no protocolo é o ciclo de vida: `initialize` → `initialized` →
  requests/notifications → `shutdown` → `exit`.
- `workspace/didChangeWorkspaceFolders` (`3.17/workspace/didChangeWorkspaceFolders.md:1`)
  permite múltiplas raízes; `workspace/didChangeWatchedFiles`
  (`3.17/workspace/didChangeWatchedFiles.md:1`) informa mudanças externas — é o gancho para
  invalidar cache.
- 3.18 adiciona `workspace/textDocumentContent`
  (`3.18/workspace/textDocumentContent.md:1`), permitindo o servidor pedir o conteúdo sem
  o cliente ter enviado `didOpen`.

## 7. Configuração e extensibilidade

- `workspace/configuration` (`3.17/workspace/configuration.md:1`) e
  `workspace/didChangeConfiguration` (`:1`) são o canal de preferências.
- `workspace/executeCommand` (`3.17/workspace/executeCommand.md:1`) é a válvula de escape:
  cada servidor publica comandos próprios (o jdtls tem ~35, `plugin.xml:53-154`).
- Dynamic registration (`client/registerCapability`) permite habilitar feature em runtime.
- O `metaModel.json` é a fonte para gerar tipos e validadores; `metaModel.ts` (10.981
  bytes) mostra o formato esperado.

## 8. Permissões, sandbox e erros

- O protocolo não define segurança. Um servidor LSP roda com os mesmos privilégios do
  cliente e recebe caminhos absolutos — é execução de terceiro no processo, se embutido.
- `WorkspaceEdit` pode alterar arquivos fora do documento aberto
  (`types/workspaceEdit.md:1`); `documentChanges` + `changeAnnotations` existem para o
  cliente confirmar antes (`rename.md:33-40`).
- Erros: `ResponseError { code, message, data }`; códigos reservados em
  `specification.md` (JSON-RPC + LSP). Servidor que não suporta uma feature deve responder
  `MethodNotFound` (-32601) — o cliente tem que tratar.
- Versão: capability não anunciada = feature não deve ser chamada. Ignorar isso é a causa
  mais comum de "funciona no VS Code, quebra no nosso app".

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Meta model schema | `3.17/metaModel/metaModel.schema.json` (22.580 bytes) | validação estrutural do modelo |
| Meta model TS | `3.17/metaModel/metaModel.ts` | tipos do próprio modelo |
| Versionamento | `_specifications/specification-3-1{4,5,6}.md` | histórico e changelog por versão |
| Implementadores | `_implementors/` | lista de servidores/clientes reais |
| LSIF | `_specifications/lsif/0.4.0`…`0.6.0` | formato predecessor do SCIP |

O repo não tem teste executável do protocolo; a conformidade é social (implementadores) +
schema do metaModel. Para nós, isso significa: **precisamos escrever nosso próprio
conformance test** com um servidor falso.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `metaModel.json` como fonte de tipos/validadores | `3.17/metaModel/metaModel.json:1` | gera TS em vez de manter tipos à mão; inclui `since` e docs | CC BY 4.0 (dados) | `src/shared/lsp/` (gerado) | 20 |
| Negociação de capabilities | `3.17/general/initialize.md:1` | evita chamar o que o servidor não tem | CC BY 4.0 (texto) | `src/core/lsp/capabilities.ts` | 16 |
| `positionEncoding` explícito | `3.17/types/position.md:23-63` | mata a classe de bug UTF-16 vs byte offset | CC BY 4.0 | `src/core/lsp/position.ts` | 18 |
| Pull diagnostics com `resultId` | `3.17/language/pullDiagnostics.md:114-207` | cache incremental em vez de recompilar | CC BY 4.0 | `src/core/lsp/diagnostics.ts` | 15 |
| `LocationLink` (targetRange + originSelectionRange) | `3.17/language/definition.md:4-12` | destaca o trecho certo ao navegar | CC BY 4.0 | `src/core/lsp/locations.ts` | 12 |
| Rename com prepare + annotations | `3.17/language/rename.md:20-40` | evita rename parcial sem confirmação | CC BY 4.0 | `src/core/lsp/rename.ts` | 13 |
| Base protocol (framing) | `3.17/specification.md:26-54` | 40 linhas de código, contrato universal | MIT (código) | `src/core/lsp/framing.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Texto da spec para dentro do produto | CC BY 4.0 exige atribuição; não precisamos do texto em runtime |
| LSIF 0.4–0.6 | legado, substituído por SCIP |
| Notebook document / inline completion | fora do nosso caso de uso |
| `semanticTokens` | CodeMirror já resolve highlight no renderer |
| 3.19 (presente no repo, mas não declarada estável) | arriscado; 3.18 é a versão estável declarada (`index.html:97`) |
| Implementação de referência (vscode-languageserver-node) | não está neste repo; é outro projeto |

## 12. Modelo de exemplo para o nosso harness

1. **`src/core/lsp/framing.ts`**: `encode(message)`/`decode(chunks)` com
   `Content-Length` em bytes ASCII e `\r\n` — 40 linhas, testável com corpus de mensagens
   fragmentadas (o bug clássico é split no meio do header).
2. **`src/core/lsp/position.ts`**: conversão explícita
   `byteOffset ↔ { line, character }` por `positionEncoding`; a fonte da verdade é
   `types/position.md:51-63`. Toda resposta de LSP passa por aqui antes de virar range do
   nosso `CodeSymbol` (`src/core/code-intelligence/index.ts:16-22`).
3. **`src/core/lsp/client.ts`**: um cliente mínimo com `initialize`, `didOpen`, `request`
   com timeout + `$/cancelRequest`, `shutdown`/`exit`. Capacidades lidas do
   `InitializeResult`, nunca assumidas.
4. **Tool `lsp`** com ações `definition`, `references`, `hover`, `diagnostics`,
   `rename_preview`. `rename` só devolve `WorkspaceEdit`; aplicar é outra tool, com diff e
   confirmação — mesmo desenho do `apply_fix` do ast-grep.
5. **Gerar tipos** de `metaModel.json` no build (script em `scripts/`), versionado com a
   spec 3.18; nunca editar à mão.
6. **Teste**: servidor falso em Node + 6 casos (definition com LocationLink, references
   com includeDeclaration, hover Markdown, pull diagnostics com resultId igual e diferente,
   rename com prepare, erro -32601).

## 13. Evidências da análise

```text
$ git -C ... rev-parse HEAD
baf2db31b5fb314a8f358f9a839d3c66e9d98734

$ Get-Content License.txt -TotalCount 1
Attribution 4.0 International

$ Get-Content License-code.txt -TotalCount 3
MIT License
Copyright (c) Microsoft Corporation.

$ Select-String index.html -Pattern "latest version"
97: The latest version of the LSP specification is version 3.18. ...

$ Select-String _specifications/lsp/3.17/specification.md -Pattern "Content-Length|Base Protocol"
26: ## Base Protocol
28: The base protocol consists of a header and a content part (comparable to HTTP).
39: | Content-Length    | number      | The length of the content part in bytes. This header is required. |

$ Select-String _specifications/lsp/3.17/types/position.md -Pattern "UTF16|UTF-16"
51:  * Character offsets count UTF-16 code units.
56: 	export const UTF16: PositionEncodingKind = 'utf-16';

$ Select-String _specifications/lsp/3.17/language/pullDiagnostics.md -Pattern "method:"
114: * method: `textDocument/diagnostic`.
335: * method: `workspace/diagnostic`.

$ Get-Content _specifications/lsp/3.17/metaModel/metaModel.json -TotalCount 4
{
	"metaData": {
		"version": "3.17.0"
	},
```
