?# Resumo — estudos de code-analysis

Sete repositórios lidos estaticamente (sem instalar, sem rodar build/testes dos clones),
um Markdown por repositório em `docs/research/estudos/code-analysis/`. Toda afirmação dos
estudos individuais tem caminho + linha; aqui só consolidamos decisão.

| Repositório | Commit | Licença | Arquivos | Score do repo |
|---|---|---|---|---|
| `BurntSushi--ripgrep` | `6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30` | Unlicense OR MIT | 226 | **18** |
| `tree-sitter--tree-sitter` | `dfe770858e3cfd8e8b29a79ea17da390a6f60319` | MIT | 641 | **17** |
| `ast-grep--ast-grep` | `aaa80f08698dee907402f844da06850c435c431e` | MIT | 325 | **19** |
| `universal-ctags--ctags` | `82494361bb3e7d4f7cf1d2bdc0d0e9001c926e45` | GPL-2.0 (não copiar) | 7.342 | **15** |
| `sourcegraph--scip` | `d556dd3c24b3c1787e0b62cd31f25188300e3098` | Apache-2.0 | 226 | **16** |
| `eclipse-jdtls--eclipse.jdt.ls` | `6d1e57a2b1752adff9bfa767668cf4e78809b625` | EPL-2.0 (não copiar) | 1.828 | **14** |
| `microsoft--language-server-protocol` | `baf2db31b5fb314a8f358f9a839d3c66e9d98734` | CC BY 4.0 (spec) + MIT (código) | 383 | **20** |

## 1. Como o score foi atribuído

Escala 0–25, com quatro fatores:

```
score = impacto no harness (0–10)
      + qualidade da evidência no código (0–6)
      + custo de adoção invertido (0–6)
      + licença permite uso (0–3)
```

- **0–5**: irrelevante ou proibido.
- **6–10**: ideia útil, custo alto ou ganho marginal.
- **11–17**: vale implementar quando a área for tocada.
- **18–25**: vale implementar agora, com teste, e vira padrão do projeto.

`score do repo` = maior score entre seus candidatos, não soma (somar infla repositório com
muitos itens pequenos).

## 2. Candidatos ordenados

| # | Score | Candidato | Origem (arquivo:linha) | Destino proposto | Tipo |
|---|---|---|---|---|---|
| 1 | **20** | `metaModel.json` como fonte de tipos/validadores LSP | `.../language-server-protocol/_specifications/lsp/3.17/metaModel/metaModel.json:1-4` | `src/shared/lsp/` (gerado por script) | spec/gerador |
| 2 | **19** | Schema declarativo de regra (id/message/severity/fix/files/ignores) | `.../ast-grep--ast-grep/crates/config/src/rule_config.rs:84` | `src/core/quality/rules/schema.ts` | formato + algoritmo |
| 3 | **18** | Precedência de ignore em 7 passos (`.ignore` > `.gitignore` > exclude > global) | `.../BurntSushi--ripgrep/crates/ignore/src/walk.rs:454-486` | `src/core/util/ignore-rules.ts` | algoritmo TS |
| 4 | **18** | `positionEncoding` explícito (byte ↔ UTF-16/8/32) | `.../language-server-protocol/_specifications/lsp/3.17/types/position.md:23-63` | `src/core/lsp/position.ts` | algoritmo TS |
| 5 | **18** | Padrão AST com metavar + ellipsis + rollback de env | `.../ast-grep--ast-grep/crates/core/src/matcher/pattern.rs:355`, `:181`, `:398-405` | `src/core/code-intelligence/patterns.ts` | algoritmo TS |
| 6 | **17** | Parser de gitignore (`!`, `/` final, `**`, âncora) | `.../BurntSushi--ripgrep/crates/ignore/src/gitignore.rs:463` | `src/core/util/gitignore.ts` | algoritmo TS |
| 7 | **17** | Edição + `changed_ranges` para reindexar só o alterado | `.../tree-sitter--tree-sitter/lib/src/tree.c:97`, `:114` | `src/core/code-intelligence/incremental.ts` | algoritmo (sobre CST) |
| 8 | **17** | Outline: role + símbolo + assinatura + membros | `.../ast-grep--ast-grep/crates/outline/src/model.rs:90-117` | `src/core/code-intelligence/outline.ts` | formato |
| 9 | **16** | Contrato JSON de resultado de busca (bytes + offsets + submatches) | `.../BurntSushi--ripgrep/crates/printer/src/jsont.rs:86-131` | `src/core/tools/search.ts` (schema interno) | formato |
| 10 | **16** | Gramática de symbol string (scheme/manager/package/descriptors) | `.../sourcegraph--scip/scip.proto:157-180` | `src/core/code-intelligence/symbol-id.ts` | formato + algoritmo |
| 11 | **16** | Negociação de capabilities antes de chamar feature | `.../language-server-protocol/_specifications/lsp/3.17/general/initialize.md:1` | `src/core/lsp/capabilities.ts` | protocolo |
| 12 | **16** | `ParseSymbol`/`FormatSymbol` com round-trip testado | `.../sourcegraph--scip/bindings/go/scip/symbol_parser.go:65`, `symbol_formatter.go:65` | `src/core/code-intelligence/symbol-id.ts` | algoritmo (port do Go) |
| 13 | **15** | Consulta de símbolo dentro de diretório ignorado | `.../BurntSushi--ripgrep/crates/ignore/src/gitignore.rs:234` | `src/core/util/ignore-rules.ts` | algoritmo TS |
| 14 | **15** | Formato JSON de tag (`_type`,`name`,`path`,`pattern`,`kind`,`scope`) | `.../universal-ctags--ctags/man/ctags-json-output.5.rst.in:31-35` | `src/core/code-intelligence/tags-format.ts` | formato |
| 15 | **15** | Pull diagnostics com `resultId`/`previousResultId` | `.../language-server-protocol/_specifications/lsp/3.17/language/pullDiagnostics.md:114-207` | `src/core/lsp/diagnostics.ts` | protocolo |
| 16 | **14** | Poda por `potential_kinds` (bitset de kinds) | `.../ast-grep--ast-grep/crates/core/src/matcher.rs:37-41` | `src/core/code-intelligence/patterns.ts` | algoritmo |
| 17 | **14** | Base protocol: header + `Content-Length` + JSON-RPC | `.../language-server-protocol/_specifications/lsp/3.17/specification.md:26-54` | `src/core/lsp/framing.ts` | protocolo (MIT) |
| 18 | **14** | Dois modos: syntax (rápido, parcial) + full (semântico) | `.../eclipse-jdtls--eclipse.jdt.ls/.../syntaxserver/SyntaxLanguageServer.java:104` | `src/core/code-intelligence/modes.ts` | arquitetura (ideia) |
| 19 | **13** | Ocorrência com papéis (definição/uso/escrita/import/teste) | `.../sourcegraph--scip/scip.proto:692`, `:524-545` | `src/core/code-intelligence/occurrences.ts` | formato |
| 20 | **13** | Rename com prepare + change annotations | `.../language-server-protocol/_specifications/lsp/3.17/language/rename.md:20-40` | `src/core/lsp/rename.ts` | protocolo |
| 21 | **13** | Pseudo-tags de cabeçalho (versão do formato + ordenação) | `.../universal-ctags--ctags/man/tags.5.rst.in:477-492` | `src/core/code-intelligence/tags-format.ts` | formato |
| 22 | **12** | Semântica de glob (`**`, classes, case-insensitive) | `.../BurntSushi--ripgrep/crates/globset/src/glob.rs:142` | `src/core/util/fs-walk.ts:63` (substituir) | algoritmo TS |
| 23 | **12** | `LocationLink` com `targetRange`/`originSelectionRange` | `.../language-server-protocol/.../definition.md:4-12` | `src/core/lsp/locations.ts` | protocolo |
| 24 | **12** | Transformações de fix (substring/replace/convert/rewrite) | `.../ast-grep--ast-grep/crates/config/src/transform/trans.rs:107` | `src/core/quality/rules/fix.ts` | algoritmo |
| 25 | **12** | Kind + role no mesmo índice (definição vs referência) | `.../universal-ctags--ctags/main/parse.c:203` | `src/core/code-intelligence/symbols.ts` | formato |
| 26 | **11** | `enclosing_range` (nó pai para breadcrumb/call hierarchy) | `.../sourcegraph--scip/scip.proto:747-805` | `src/core/code-intelligence/outline.ts` | formato |
| 27 | **11** | Rollback de ambiente em padrão com alternância | `.../ast-grep--ast-grep/crates/core/src/matcher/pattern.rs:398-405` | `src/core/code-intelligence/patterns.ts` | algoritmo |
| 28 | **10** | Relações entre símbolos (`is_implementation`, `is_type_definition`) | `.../sourcegraph--scip/scip.proto:465-516` | `src/core/code-intelligence/references.ts` | formato |
| 29 | **10** | Matriz de capabilities declarada (o que existe / o que é parcial) | `.../eclipse-jdtls--eclipse.jdt.ls/.../handlers/InitHandler.java:118-184` | `src/core/lsp/capabilities.ts` | arquitetura (ideia) |
| 30 | **10** | Leitura de índice ordenado por busca binária | `.../universal-ctags--ctags/libreadtags/readtags.h:179-249` | `src/core/code-intelligence/tags-reader.ts` | algoritmo (domínio público) |
| 31 | **9** | Tipos TS de SCIP prontos no npm (`@scip-code/scip`) | `.../sourcegraph--scip/bindings/typescript/package.json:2` | dependência | dependência |
| 32 | **9** | Campos ligáveis (linha/escopo/assinatura sob demanda) | `.../universal-ctags--ctags/main/field.c` | `src/core/code-intelligence/symbols.ts` | formato |
| 33 | **8** | Optlib: parser por regex + tabela de estados | `.../universal-ctags--ctags/optlib/cmake.ctags:42-93` | `src/core/code-intelligence/optlib.ts` (só se preciso) | algoritmo |
| 34 | **8** | Mensagem degradada "fora do classpath, só sintaxe" | `.../eclipse-jdtls--eclipse.jdt.ls/.../handlers/DiagnosticsHandler.java:63` | contrato de tool | UX |
| 35 | **8** | `parse_with_options` (parse sem carregar arquivo inteiro) | `.../tree-sitter--tree-sitter/lib/binding_rust/lib.rs:959` | `src/core/code-intelligence/parse.ts` | algoritmo |
| 36 | **8** | BrokenPipe como sucesso (não reportar erro falso) | `.../BurntSushi--ripgrep/crates/core/main.rs:55-59` | `src/core/tools/search.ts` | detalhe |
| 37 | **7** | Escopo de busca configurável (sources vs projetos referenciados) | `.../eclipse-jdtls--eclipse.jdt.ls/.../handlers/ReferencesHandler.java:62-65` | `src/core/code-intelligence/references.ts` | ideia |
| 38 | **6** | Rename com condições verificadas antes de aplicar | `.../eclipse-jdtls--eclipse.jdt.ls/.../handlers/RenameHandler.java:44-46`, `:84` | `src/core/tools/fs.ts` | ideia |

## 3. O que é dependência ou binário

Nada aqui é para ser embutido como código no `src/core` sem decisão explícita:

| Item | Forma de distribuição | Onde | Decisão |
|---|---|---|---|
| `rg` (ripgrep) | binário por plataforma | `resources/bin/rg.exe` (já empacotado) | **manter**; o valor do estudo é a semântica de ignore, não o motor |
| tree-sitter runtime | biblioteca C nativa (`dlopen`) ou WASM (`web-tree-sitter`) | `lib/src/*.c`, `lib/src/wasm_store.c` | **WASM** se adotar; nunca `dlopen` no processo principal |
| Gramáticas tree-sitter | `.wasm` ou `.so/.dll` por linguagem | `crates/loader/src/loader.rs:1232` | empacotar só as 5–6 linguagens que usamos |
| `sg` / `@ast-grep/napi` | binário CLI + addon nativo (9 alvos) | `crates/napi/package.json:2`, `crates/napi/npm/*` | opcional, em processo separado; nunca `registerDynamicLanguage` |
| `@scip-code/scip` | pacote npm **sem** binário (só tipos gerados) | `bindings/typescript/package.json:2` | **pode** ser dependência normal |
| `ctags` | binário C (GPL) | `main/main.c:202` | não distribuir; se usar, só como ferramenta de dev |
| jdtls | JVM + RCP (centenas de MB) | `org.eclipse.jdt.ls.product` | só como servidor externo opcional do usuário |

Regra: binário novo só entra se (a) rodar em processo separado, (b) tiver timeout, (c) for
declarado em `resources/MANIFEST.json`, (d) tiver teste que falha se o binário sumir.

## 4. O que é reimplementável em TS (com esforço honesto)

| Item | Esforço | Base de comparação |
|---|---|---|
| Precedência de ignore + parser de gitignore | 300–500 linhas | `walk.rs:454-486` + `gitignore.rs:463` |
| Glob com `**`/classes | 150–250 linhas | `glob.rs:142` (nosso `globToRegExp` atual é ~30 linhas) |
| Framing LSP + posição + capabilities | 250–400 linhas | `specification.md:26-54`, `position.md:23-63` |
| Symbol ID (parse + format + escape) | 300–500 linhas | `symbol_parser.go:65` / `symbol_formatter.go:65` |
| Padrão AST com metavar/ellipsis | 600–900 linhas | `pattern.rs:355-410` + `matcher.rs:37` |
| Schema de regra + fix por template | 400–600 linhas | `rule_config.rs:84` + `fixer.rs:68-177` |
| Parser incremental completo | **não** | é um gerador LR em C; usar WASM |

## 5. O que é proibido por licença

| Item | Licença | Efeito |
|---|---|---|
| Qualquer `.c`/`.h` de `universal-ctags--ctags/main/`, `parsers/`, `optlib/` | **GPL-2.0** (`COPYING:1`) | copiar torna o produto GPL-2.0; usar só formato/ideia |
| `libreadtags/readtags.{c,h}` | **domínio público** (`readtags.h:4`) | único ponto copiável do repo; ainda assim, é C |
| Qualquer `.java` do `eclipse.jdt.ls` | **EPL-2.0** (`LICENSE:1`) | copyleft por arquivo; derivado precisa continuar EPL |
| Texto da especificação LSP | **CC BY 4.0** (`License.txt:1`) | pode citar/atribuir; não copiar blocos grandes para dentro do produto |
| Código do repo LSP (`metaModel`, exemplos) | **MIT** (`License-code.txt:1`) | pode usar com aviso de copyright |
| ripgrep / tree-sitter / ast-grep / SCIP | MIT / MIT / MIT / Apache-2.0 | copiar é permitido com aviso (Apache-2.0 também exige NOTICE) |

Nota: sou analista, não advogado. As conclusões acima vêm do texto dos arquivos de licença
citados; antes de copiar código de ctags ou jdtls, valide com jurídico.

## 6. Sequência recomendada

**Fase 1 — sem dependência nova (2–3 dias, tudo com teste):**

1. `ignore-rules.ts` + `gitignore.ts` (candidatos 3 e 6), validando contra `rg --files`
   como oráculo. Corrige o `DEFAULT_IGNORES` de `src/core/util/fs-walk.ts:4`, que hoje é só
   um `Set` de nomes.
2. `framing.ts` + `position.ts` + `capabilities.ts` (17, 4, 11) — base do cliente LSP.
3. `symbol-id.ts` (10, 12) e `occurrences.ts` (19): dá identidade a
   `CodeSymbol` (`src/core/code-intelligence/index.ts:16-22`), que hoje casa por nome.
4. `rules/schema.ts` (2) sobre o motor regex atual: o schema vale mesmo sem AST.

**Fase 2 — uma dependência WASM:**

5. `web-tree-sitter` + queries `tags.scm` → substitui `declarations()`
   (`src/core/code-intelligence/index.ts:95-117`). Só depois que a Fase 1 estabilizou o
   formato de saída.
6. `incremental.ts` (7) usando `changedRanges` para não re-varrer o arquivo a cada edição.

**Fase 3 — opcional, processo externo:**

7. Cliente LSP real (15, 20, 23) falando com `typescript-language-server`, `pyright` ou o
   próprio jdtls do usuário; tool `lsp` com `definition/references/hover/diagnostics`.
8. `@ast-grep/napi` para reescrita estrutural, se a Fase 2 não cobrir os casos.

## 7. Riscos que os estudos expõem

1. **Precisão falsa**: tree-sitter dá sintaxe, não semântica. `references` sem LSP é
   aproximação; toda resposta precisa de `engine` e `partial`.
2. **Staleness**: nenhum dos sete formatos tem update incremental padronizado (SCIP não
   tem delta; ctags tem `--append`; tree-sitter tem `changed_ranges`, mas o índice é nosso).
   O índice precisa de versão + invalidação por mtime/hash.
3. **Encoding**: SCIP e LSP declaram a unidade de offset; nosso código hoje trabalha em
   bytes/linhas. Misturar UTF-16 (LSP) com byte offset é a fonte nº 1 de bug de range.
4. **Custo escondido**: o gargalo de SCIP/jdtls não é o protocolo, é o indexador/servidor
   (compilador, build tool). Adotar o formato não adoção a capacidade.
5. **Licença**: dois dos sete repositórios (ctags, jdtls) são copyleft e não podem ser
   fonte de código; só de ideia.

## 8. Evidências da consolidação

```text
$ Get-ChildItem docs/research/estudos/code-analysis -File | Measure-Object -Line
7 arquivos, 180–204 linhas cada, 13 seções '## ' cada

$ commits verificados
6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30  BurntSushi--ripgrep
dfe770858e3cfd8e8b29a79ea17da390a6f60319  tree-sitter--tree-sitter
aaa80f08698dee907402f844da06850c435c431e  ast-grep--ast-grep
82494361bb3e7d4f7cf1d2bdc0d0e9001c926e45  universal-ctags--ctags
d556dd3c24b3c1787e0b62cd31f25188300e3098  sourcegraph--scip
6d1e57a2b1752adff9bfa767668cf4e78809b625  eclipse-jdtls--eclipse.jdt.ls
baf2db31b5fb314a8f358f9a839d3c66e9d98734  microsoft--language-server-protocol

$ estado atual do harness (para justificar os destinos)
src/core/util/fs-walk.ts:4            export const DEFAULT_IGNORES = new Set([
src/core/util/fs-walk.ts:63           export function globToRegExp(pattern: string): RegExp {
src/core/code-intelligence/index.ts:95  function declarations(line: string): ...
src/core/code-intelligence/index.ts:119 export async function findSymbols(root, query?, signal?)
src/core/tools/code-intelligence.ts:26  action: z.enum(['overview','symbols','dependencies','impact','diagnostics'])
```
