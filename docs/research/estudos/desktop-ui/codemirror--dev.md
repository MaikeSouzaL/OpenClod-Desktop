# CodeMirror (repositório `dev`)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/codemirror/dev (movido para https://code.haverbeke.berlin/codemirror/dev) |
| Clone local | `repositorios/_research/desktop-ui/codemirror--dev` |
| Commit | `c010426d06689a7115aa9df08425126b6d3ead2f` |
| Licença | MIT (`LICENSE:1-6`; `package.json:10`) |
| Categoria | desktop-ui (editor de código) |
| Stack | Node.js >= 16, JavaScript (scripts), TypeScript no demo; npm (`README.md:13-17`) |
| Tamanho | 16 arquivos; ~727 linhas (`.js` 438, `.ts` 117, `.md` 83) |

## 1. O que é (verificado no código)

**Não é o código do CodeMirror.** É o repositório de desenvolvimento que
orquestra os pacotes publicados no npm. O README é explícito: “This repository
has moved…”, “It holds the bug tracker and development scripts” e “If you want to
use CodeMirror, install the separate packages from npm, and ignore the contents
of this repository” (`README.md:1-13`).

O clone tem apenas: `bin/` (scripts de clone/build/release), `demo/` (demo e
testes de browser), `package.json`, `tsconfig.json` e licença. Não há `src/`,
`view/`, `state/` nem `language/` — os 38 pacotes são clonados por
`node bin/cm.js install` em diretórios irmãos (`bin/cm.js:81-99`).

Isso muda o estudo: não há algoritmo de editor para ler aqui. O valor é (a) o
**mapa de pacotes** (`bin/packages.js`), que mostra a divisão real do CodeMirror 6,
e (b) o fato de o nosso app já usar `codemirror` + `@codemirror/*`
(`src/renderer/src/components/FilesPane.tsx:2-13`). O que falta no nosso editor
(merge/diff e LSP) aparece justamente na lista de pacotes.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `node bin/cm.js install` | `bin/cm.js:81-99` | clona os 38 pacotes, roda `npm install` e builda |
| `node bin/cm.js install --ssh` | `bin/cm.js:82` | usa origem SSH |
| `node bin/cm.js build` | `bin/cm.js:114-119` | build de todos os pacotes com `@marijn/buildtool` |
| `node bin/cm.js devserver` | `bin/cm.js:149-156` | servidor em `127.0.0.1:8090` com demo e testes |
| `node bin/cm.js test` | `bin/cm.js:348` | roda a suíte de cada pacote |
| `node bin/cm.js test --no-browser` | `package.json:5` | testes Node, sem browser |
| `npm run dev` | `package.json:7` | atalho para `cm.js devserver` |
| `node bin/cm.js release <pkg>` | `bin/cm.js:221` | cria commits/tags de release |
| `node bin/cm.js packages` | `bin/cm.js:102-104` | lista os nomes dos pacotes |

A superfície de UX é de **desenvolvimento**, não de usuário. O demo importa
`codemirror` (meta-pacote), `@codemirror/lang-html`, `@codemirror/language` e
`@lezer/highlight` (`demo/demo.ts:1-4`) e cria uma `EditorView` com
`basicSetup` e tema customizado (`demo/demo.ts:94-124`).

## 3. Arquitetura e fluxo

```text
bin/cm.js install
  → lê bin/packages.js (core + nonCore)
  → git clone <base>/<pkg>.git <dir>
  → npm install na raiz (workspaces "*")
  → buildhelper.build(main de cada pacote)
bin/cm.js devserver
  → esmoduleserve + serve-static em demo/
  → buildtool.watch(main de cada pacote, demo.ts)
  → http://127.0.0.1:8090 (demo + /test)
```

- Entry point de desenvolvimento: `bin/cm.js:17-33` (mapa de subcomandos).
- Lista de pacotes: `bin/packages.js:3-16` (core) e `:17-42` (nonCore).
- Resolução do `main` de cada pacote: `bin/packages.js:46-58` (procura
  `src/index.ts`, `<nome>.ts` etc.).
- Clone/install: `bin/cm.js:85-99`; build: `:114-119`.
- Servidor: `bin/cm.js:121-156`; bind em `127.0.0.1` a menos que `OPEN` esteja
  definido (`:145`).
- Testes: `bin/cm.js:348` delega para o runner de cada pacote; não há código de
  teste neste clone.

Não há loop de agente, streaming, sessão ou persistência. O “estado” é o
filesystem: diretórios clonados ao lado do meta-repo.

## 4. Catálogo de ferramentas / capacidades

| Pacote / capacidade | Onde está declarado | O que faz | Risco |
|---|---|---|---|
| `state` | `bin/packages.js:4` | estado imutável, transações, facets | baixo |
| `view` | `bin/packages.js:5` | editor DOM, decorações, keymaps | baixo |
| `language` | `bin/packages.js:6` | Lezer, syntax tree, highlighting | baixo |
| `commands` | `bin/packages.js:7` | comandos de edição/histórico | baixo |
| `search` | `bin/packages.js:8` | busca no documento | baixo |
| `autocomplete` | `bin/packages.js:9` | completion sources | médio |
| `lint` | `bin/packages.js:10` | diagnósticos no gutter | baixo |
| `collab` | `bin/packages.js:11` | colaboração (OT/CRDT) | alto (rede) |
| `language-data` | `bin/packages.js:12` | metadados de linguagens | baixo |
| `merge` | `bin/packages.js:13` | **diff/merge de dois documentos** | baixo |
| `lsp-client` | `bin/packages.js:14` | cliente LSP para o editor | médio |
| `codemirror` | `bin/packages.js:15` | meta-pacote com `basicSetup` | baixo |
| 25 `lang-*`/`theme-*`/`legacy-modes` | `bin/packages.js:17-42` | linguagens e tema | baixo (tamanho) |

O ponto mais importante para nós: **`merge` e `lsp-client` são pacotes de
primeira classe do projeto**, mas não estão implementados neste clone. Para usá-los,
a fonte é o npm (`@codemirror/merge`, `@codemirror/lsp-client`), não este
repositório.

## 5. Loop do agente, contexto e streaming

Não existe. O meta-repo só orquestra processos: `install` clona, `build` compila,
`devserver` observa, `test` executa. Não há chamada de modelo, ferramenta,
compactação, cancelamento ou retry.

O único “fluxo” é o de desenvolvimento:

1. `install` verifica se o diretório existe; se não, clona
   (`bin/cm.js:85-92`).
2. `npm install` na raiz usa os workspaces `"*"` (`package.json:22-24`).
3. `build` chama `buildtool.build` para cada `main`
   (`bin/cm.js:114-119`).
4. `devserver` observa os `main` e o `demo.ts`, e serve o demo
   (`bin/cm.js:149-156`).

## 6. Sessões, estado e persistência

- Não há sessão de app. O estado persistente é o próprio checkout: 38 diretórios
  git independentes, cada um com seu `.git` (o meta-repo não usa submodules;
  usa `git clone` em `bin/cm.js:90`).
- `bin/cm.js status` roda `git status -sb` em cada pacote e só imprime se estiver
  diferente de `## main...origin/main` (`bin/cm.js:106-112`).
- Releases são commits/tags por pacote (`bin/cm.js:221-340`), não um monorepo
  versionado junto.
- Não há banco, cache ou checkpoint.

## 7. Configuração e extensibilidade

- `package.json` declara `workspaces: ["*"]` e é `private: true`
  (`package.json:22-25`); não há versão, porque não é publicado.
- `tsconfig.json` é compartilhado; cada pacote traz o seu (`tsconfig.json:1-20`).
- O conjunto de pacotes é fixo em `bin/packages.js`; adicionar um pacote exige
  editar essa lista e o `install`.
- `buildhelper`/`buildtool` definem o pipeline de build e as opções de bundling
  (`bin/cm.js:117`, `:154`).
- Não há plugins, hooks ou MCP. Extensões do editor são pacotes npm.

## 8. Permissões, sandbox e erros

Não há código de permissão. O risco é de **cadeia de suprimentos**:

| Risco | Evidência | Comentário |
|---|---|---|
| Clonar 38 repositórios e rodar `npm install` | `bin/cm.js:85-99` | executa scripts de instalação de terceiros |
| Build executa código dos pacotes | `bin/cm.js:114-119` | `buildtool.build` importa os pacotes |
| Servidor de dev exposto | `bin/cm.js:129-145` | bind em `127.0.0.1` por padrão; `OPEN` remove o bind |
| Sem lockfile no meta-repo | `package.json:11-17` | dependências de dev com `^`; resolução não reprodutível |
| `execFileSync` com args fixos | `bin/cm.js:65` | não há interpolação de shell nos comandos internos |

Para o nosso app, o risco não é este repo: é instalar um pacote `@codemirror/*`
sem pin e sem auditoria. A recomendação é pin exato + `npm audit` + revisão do
diff de versão.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Testes por pacote | `bin/cm.js:348` | cada pacote roda seu próprio runner |
| Browser tests | `bin/cm.js:130-138` | `@marijn/testtool` monta a página de testes |
| Demo manual | `demo/demo.ts` | editor HTML com syntax highlighting |
| Meta-repo | **não encontrado** | não há testes dos scripts `cm.js` |

O meta-repo não tem CI de testes própria neste clone; a qualidade está nos
pacotes. Como não temos o código deles, não é possível avaliar cobertura.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `@codemirror/merge` para diff/merge | declarado em `bin/packages.js:13`; código no npm | resolve diff lado a lado e `unifiedMergeView` sem escrever algoritmo | MIT | `src/renderer/src/components/ChangesPane.tsx` | 22 |
| `@codemirror/lsp-client` para linguagem | declarado em `bin/packages.js:14`; código no npm | dá hover/definição/rename sobre o editor que já usamos | MIT | `src/renderer/src/editor/lsp.ts` | 18 |
| Mapa de pacotes por família | `bin/packages.js:3-42` | critério para não instalar 25 linguagens de uma vez | MIT | `src/renderer/src/editor/packages.ts` (doc) | 8 |
| Script de release por pacote | `bin/cm.js:221-340` | ideia de versionamento independente | MIT | não se aplica (npm publish) | 6 |
| Demo de `EditorView` + tema | `demo/demo.ts:94-124` | exemplo mínimo de composição | MIT | referência | 7 |

**Nenhum desses é código para copiar deste clone**: `merge` e `lsp-client` são
pacotes publicados. O estudo serve para justificar a dependência e o desenho de
integração, não para transplante.

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| O meta-repo em si | é infraestrutura de desenvolvimento, não runtime |
| `bin/cm.js` (clone/build/release) | não temos 38 pacotes; usamos npm |
| `demo/` | demo de HTML, não arquitetura |
| `packages.js` como lista fixa | nosso bundler já resolve imports |
| `collab` | colaboração em tempo real não é requisito atual e adiciona rede/CRDT |
| `legacy-modes` | peso e modos antigos; usar `lang-*` específicos |
| Abas/explorer | não fazem parte do CodeMirror (não encontrado); o host compõe `EditorView`s |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto para o nosso editor atual:

1. **Diff/merge**: instalar `@codemirror/merge` e trocar o `DiffView` caseiro
   (`ChangesPane.tsx:54-141`) por um `MergeView` somente-leitura com
   `unifiedMergeView` para o modo inline. O “aceitar/rejeitar” deve aplicar um
   `ChangeSet` no documento original, não editar o texto renderizado.
2. **LSP**: instalar `@codemirror/lsp-client` e ligar a um servidor no main
   (`src/core/lsp/session.ts`), com `Content-Length`, timeout e kill de árvore.
   O cliente só troca mensagens; o filesystem é do main.
3. **Linguagens**: carregar `@codemirror/lang-*` sob demanda por extensão, com
   `Compartment` (o `FilesPane` já usa compartments:
   `FilesPane.tsx:91-98`). Não importar 25 linguagens no bundle inicial.
4. **Tema**: manter o `oneDark` atual e um tema claro; o `Compartment` de tema já
   existe (`FilesPane.tsx:92`).
5. **Teste**: abrir dois arquivos, aplicar um patch, verificar que o merge view
   mostra as linhas e que o “aceitar” altera o arquivo certo; um teste LSP com
   `typescript-language-server` e um erro de tipo.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/codemirror--dev rev-parse HEAD
c010426d06689a7115aa9df08425126b6d3ead2f

$ sed -n '1,13p' README.md
"This repository has moved to https://code.haverbeke.berlin/codemirror/dev"
"It holds the bug tracker and development scripts."
"If you want to use CodeMirror, install the separate packages from npm..."

$ sed -n '3,16p' bin/packages.js
exports.core = ["state","view","language","commands","search","autocomplete","lint",
"collab","language-data","merge","lsp-client","codemirror"]

$ sed -n '81,99p' bin/cm.js
function install(arg = null) { ... git clone ... npm install ... build() }

$ sed -n '149,156p' bin/cm.js
buildtool.watch(...); startServer(); // 8090

$ grep -n "from \"codemirror\"\|@codemirror/lang-html" demo/demo.ts
1: import {EditorView, basicSetup} from "codemirror";
2: import {html} from "@codemirror/lang-html";

$ find . -maxdepth 2 -type d
./.git ./bin ./demo ./.github
```

Limitações: o clone tem 16 arquivos e **não contém o código dos pacotes**; não
foi possível analisar `merge`/`lsp-client` por dentro. As afirmações sobre eles
são sobre a existência e o papel declarado, não sobre implementação.
