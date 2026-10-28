# tree-sitter

| Campo | Valor |
|---|---|
| Repositório | https://github.com/tree-sitter/tree-sitter |
| Clone local | `repositorios/_research/code-analysis/tree-sitter--tree-sitter` |
| Commit | `dfe770858e3cfd8e8b29a79ea17da390a6f60319` |
| Licença | MIT — `LICENSE`, `Cargo.toml:22` |
| Categoria | code-analysis / parsing incremental |
| Stack | C11 (runtime do parser, ~15k linhas em `lib/src`), Rust 2024 (binding + CLI + crates), Node/WASM bindings |
| Tamanho | 641 arquivos, ~98k linhas (código + docs + fixtures); `lib/src` concentra 14 arquivos C com ~13k linhas |

## 1. O que é (verificado no código)

Um gerador de parser e um runtime de parsing incremental LR(1)-ish, mais três bibliotecas de
alto nível construídas sobre ele: **highlight**, **tags** (índice de símbolos) e **query**
(busca estrutural por S-expression). O runtime C é a peça central: `ts_parser_new`
(`lib/src/parser.c:1983`), `ts_parser_set_language` (`lib/src/parser.c:2036`) e
`ts_parser_parse` (`lib/src/parser.c:2124`).

O entrypoint de produto é a CLI Rust `tree-sitter` (`crates/cli/src/main.rs:47`), que gera
gramáticas, compila parsers e roda parse/query/tags/highlight. O README fala em "parser
generator tool"; o código mostra que o valor real entregue é o **runtime de árvore
reutilizável**, com API de edição e de ranges alterados.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `tree-sitter parse <arquivo>` | `crates/cli/src/main.rs:57` | imprime a árvore e erros de parse |
| `tree-sitter query <arquivo.scm> <fonte>` | `crates/cli/src/main.rs:65` | roda uma query S-expression |
| `tree-sitter tags <arquivo>` | `crates/cli/src/main.rs:69` | emite símbolos via `tags.scm` + `locals.scm` |
| `tree-sitter highlight <arquivo>` | `crates/cli/src/main.rs:67` | aplica `highlights.scm`, saída ANSI/HTML |
| `tree-sitter build` | `crates/cli/src/main.rs:55` | compila a gramática para `.so/.dll/.dylib` |
| `tree-sitter generate` | `crates/cli/src/main.rs:53` | gera `parser.c` a partir de `grammar.js` |
| `tree-sitter test` / `fuzz` | `crates/cli/src/main.rs:59`, `:63` | corpus de teste e fuzzing do parser |
| `tree-sitter dump-languages` | `crates/cli/src/main.rs:73` | lista parsers conhecidos pelo loader |

Superfície: 15 subcomandos (`crates/cli/src/main.rs:47-76`), sem servidor e sem IPC. O
consumo por programa se dá pela biblioteca Rust (`lib/binding_rust/lib.rs`), por C
(`lib/include/tree_sitter/api.h`) ou por WASM/Node (`lib/binding_web`).

## 3. Arquitetura e fluxo

```
grammar.js → tree-sitter generate → parser.c (tabelas LR)
  → ts_parser_set_language (lib/src/parser.c:2036)
    → ts_parser_parse(texto, old_tree) (lib/src/parser.c:2124)
      → subtree reuse (lib/src/reusable_node.h) → TSTree
        → ts_tree_edit (lib/src/tree.c:97) → ts_tree_get_changed_ranges (lib/src/tree.c:114)
          → QueryCursor / tags / highlight (lib/src/query.c:3030, crates/tags, crates/highlight)
```

- Entry point da biblioteca: `ts_parser_new` (`lib/src/parser.c:1983`).
- Reuso incremental: `ReusableNode` e `reusable_node_tree/reusable_node_descend`
  (`lib/src/parser.c:228-235`), com a decisão de token reutilizável em
  `lib/src/parser.c:487-502`.
- Edição: `Tree::edit` na binding Rust (`lib/binding_rust/lib.rs:1543`) e
  `ts_tree_edit` em C (`lib/src/tree.c:97`).
- Diff de árvore: `Tree::changed_ranges` (`lib/binding_rust/lib.rs:1564`),
  implementado em `lib/src/get_changed_ranges.c` (497 linhas).
- Query: compilação `ts_query_new` (`lib/src/query.c:3030`), execução com cursor
  (`lib/src/query.c:3488`), restrição de janela por bytes
  (`lib/src/query.c:3552`) e iteração (`lib/src/query.c:4659`).
- Parse em streaming: `parse_with_options` com callback de leitura
  (`lib/binding_rust/lib.rs:959`) — permite parsear sem carregar o arquivo inteiro.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Parse de arquivo | `lib/binding_rust/lib.rs:932` | árvore sintática concreta (CST) com nós `ERROR`/`MISSING` | baixo |
| Parse incremental | `lib/src/parser.c:2124` | reusa subárvores ao receber `old_tree` | baixo |
| Edição + changed ranges | `lib/src/tree.c:97`, `:114` | informa o que mudou após um edit | baixo |
| Query S-expression | `lib/src/query.c:3030` | padrões com capturas e quantificadores | baixo |
| Predicados de texto | `lib/binding_rust/lib.rs:2718-2860` | `#eq?`, `#match?`, `#any-of?`, `#is?` | baixo |
| Tags (símbolos) | `crates/tags/src/tags.rs:129`, `:281` | símbolos+escopos a partir de `tags.scm`/`locals.scm` | baixo |
| Highlight | `crates/highlight/src/highlight.rs:136`, `:294` | classificação léxica para tema | baixo |
| Loader dinâmico | `crates/loader/src/loader.rs:1232` | `dlopen` de gramática compilada (`libloading`, `:22`) | **alto** (carrega código nativo arbitrário) |
| Parsers WASM | `lib/src/wasm_store.c:1` | executa scanner/gramática em wasm store | médio |
| Parse UTF-16/encoding custom | `lib/binding_rust/lib.rs:1052`, `:1314` | parseia texto UTF-16 LE/BE e decoder plugável | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente. O análogo do loop é o ciclo **parse → query → consume**:

- O `QueryCursor` roda sobre uma subárvore (`ts_query_cursor_exec`,
  `lib/src/query.c:3488`) e pode ser limitado por bytes
  (`lib/src/query.c:3552`) e por número de matches
  (`QueryCursor::set_match_limit`, `lib/binding_rust/lib.rs:3152`). Isso é o que evita
  varrer um arquivo de 5 MB inteiro para responder "onde estão as funções?".
- `Query::matches` é um *streaming iterator* (`lib/binding_rust/lib.rs:3177`), não um
  vetor: memória constante por padrão.
- Predicados são avaliados **depois** do casamento estrutural, na binding Rust
  (`lib/binding_rust/lib.rs:2718` em diante), com regex para `#match?`. Um porte para TS
  precisa reimplementar essa camada, não só o parser.
- Cancelamento: não há `AbortSignal`; o jeito é parar de iterar ou fechar o cursor. A CLI
  usa timeouts (`ts_parser_set_timeout` no runtime C).

## 6. Sessões, estado e persistência

Sem sessão. O que existe é a **árvore em memória** e o cache do loader:

- `Tree` guarda ranges e ponteiros para subtrees compartilhadas; `Tree::edit` invalida
  apenas os caminhos afetados (`lib/src/tree.c:97`).
- `changed_ranges` produz os intervalos alterados, que é a base para reindexar só o que
  mudou (`lib/src/get_changed_ranges.c:1`).
- `Loader` mantém cache de bibliotecas compiladas em diretório de cache do usuário
  (`crates/loader/src/loader.rs:804`), com escrita atômica do `.so` (`:1174`).
- Configuração de gramáticas/highlights fica em `crates/config/src/tree_sitter_config.rs`
  (191 linhas).

## 7. Configuração e extensibilidade

- A extensibilidade real é **por gramática**: `grammar.js` gera `parser.c`; campos e
  `node-types.json` definem `child_by_field_name` (`lib/binding_rust/lib.rs:1873`).
- Queries são arquivos `.scm` versionados junto da gramática: `tags.scm` e `locals.scm`
  alimentam `TagsConfiguration::new(language, tags_query, locals_query)`
  (`crates/tags/src/tags.rs:129`); `highlights.scm` alimenta o `Highlighter`
  (`crates/highlight/src/highlight.rs:294`).
- `wasm_store.c` (1983 linhas) permite rodar gramáticas/scanners em WASM — a única forma
  de extensibilidade que não exige carregar código nativo no processo.
- Não há MCP, hooks ou plugins; a integração é sempre "traga sua gramática compilada".

## 8. Permissões, sandbox e erros

- O loader faz `dlopen`/`LoadLibrary` de código nativo (`crates/loader/src/loader.rs:22`,
  `:1232`). Em um app Electron isso é execução de código arbitrário no processo principal —
  inaceitável sem isolamento. WASM (`lib/src/wasm_store.c`) é a alternativa segura.
- Erros de sintaxe não lançam: viram nós `ERROR`/`MISSING` na árvore. `Pattern::has_error`
  no ast-grep usa isso (`repositorios/.../ast-grep/crates/core/src/matcher/pattern.rs:292`).
- A CLI `fuzz` (`crates/cli/src/main.rs:63`) existe porque gramática errada pode gerar
  loop/stack overflow; não há limite de profundidade por padrão na API.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Corpus de gramáticas | `test/fixtures/grammars` | árvores esperadas por linguagem |
| Corpus de erro | `test/fixtures/error_corpus` | recuperação de erro |
| Corpus de template | `test/fixtures/template_corpus` | gramáticas de template |
| Testes Rust | `lib/binding_rust/**/tests.rs` | query, wasm, loader |
| Testes de query da CLI | `crates/cli/src/tests/query_test.rs` (6260 linhas) | predicados, capturas, ranges |
| Fuzz | `crates/cli/src/fuzz.rs` (357 linhas) | edições aleatórias + reparse |

O ponto forte é o par **corpus + fuzz de edição**: o teste não valida só o parse inicial,
valida que reparse após edição produz a mesma árvore que parse do zero.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Modelo de edição + `changed_ranges` | `lib/src/tree.c:97`, `:114` | permite reindexar só o trecho alterado, em vez de re-varrer o arquivo | MIT | `src/core/code-intelligence/incremental.ts` | 17 |
| Forma de saída de `tags` | `crates/tags/src/tags.rs:59` (`Tag`), `:281` | símbolo+kind+range+escopo prontos para consumo | MIT | `src/core/code-intelligence/symbols.ts` | 16 |
| Ideia de `locals.scm` (definição vs referência por escopo) | `crates/tags/src/tags.rs:129` | separa definição de uso sem compilador | MIT | `src/core/code-intelligence/scope.ts` | 15 |
| Limite de cursor (bytes + match limit) | `lib/src/query.c:3552`, `lib/binding_rust/lib.rs:3152` | orçamento de trabalho explícito por consulta | MIT | contrato de tool | 12 |
| `parse_with_options` (leitura em chunks) | `lib/binding_rust/lib.rs:959` | parse sem carregar arquivo gigante | MIT | `src/core/code-intelligence/parse.ts` | 8 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Runtime C / `parser.c` gerado | binário nativo por linguagem; portar para TS é reescrever um gerador LR — fora de escopo |
| `lib/src/query.c` (4479 linhas) | motor de query em C com predicados; usar via binding, não reimplementar |
| Loader com `dlopen` | carrega código nativo arbitrário no processo do Electron |
| `crates/generate` (gerador de grammar.js → C) | ferramenta de autor de gramática, não de consumidor |
| `crates/highlight` | highlighting é problema de UI (CodeMirror já resolve no renderer) |

## 12. Modelo de exemplo para o nosso harness

Caminho realista, porque o runtime não é portável:

1. **Decisão de dependência**: `web-tree-sitter` (WASM) no processo de código, com
   gramáticas `.wasm` empacotadas em `resources/grammars/`. Nada de `dlopen`.
2. **`parse.ts`**: mantém um `Tree` por arquivo aberto e, a cada `write`, chama
   `tree.edit({startIndex, oldEndIndex, newEndIndex, ...})` antes do reparse —
   exatamente o contrato de `lib/binding_rust/lib.rs:1543` — e usa `changedRanges` para
   invalidar só os símbolos afetados.
3. **`symbols.ts`**: substituir o regex de `src/core/code-intelligence/index.ts:95-117`
   por queries `tags.scm` por linguagem, devolvendo o mesmo `CodeSymbol`
   (`index.ts:16-22`) para não quebrar o tool `code_intelligence`.
4. **Fallback**: quando a gramática não existir, manter o regex atual. O agente precisa
   saber qual motor respondeu (`engine: 'tree-sitter' | 'regex'`) — nunca fingir precisão.
5. **Teste**: para cada linguagem suportada, um arquivo com 3 símbolos aninhados; verificar
   (a) nomes, (b) ranges, (c) que editar uma linha mantém os outros ranges estáveis.

## 13. Evidências da análise

```text
$ git -C ... rev-parse HEAD
dfe770858e3cfd8e8b29a79ea17da390a6f60319

$ Select-String Cargo.toml -Pattern "^version|^license"
22: license = "MIT"
25: version = "0.28.0"

$ Select-String lib/src/parser.c -Pattern "ts_parser_new|ts_parser_set_language|ts_parser_parse"
1983: TSParser *ts_parser_new(void) {
2036: bool ts_parser_set_language(TSParser *self, const TSLanguage *language) {
2124: TSTree *ts_parser_parse(

$ Select-String lib/src/tree.c -Pattern "ts_tree_edit|ts_tree_get_changed_ranges"
97:  void ts_tree_edit(TSTree *self, const TSInputEdit *edit) {
114: TSRange *ts_tree_get_changed_ranges(const TSTree *old_tree, const TSTree *new_tree, uint32_t *length) {

$ Select-String lib/binding_rust/lib.rs -Pattern "pub fn parse|pub fn edit|pub fn changed_ranges|pub fn child_by_field_name|pub fn new\(language"
932:  pub fn parse(&mut self, text: impl AsRef<[u8]>, old_tree: Option<&Tree>) -> Option<Tree> {
1543: pub fn edit(&mut self, edit: &InputEdit) {
1564: pub fn changed_ranges(&self, other: &Self) -> impl ExactSizeIterator<Item = Range> {
1873: pub fn child_by_field_name(&self, field_name: impl AsRef<[u8]>) -> Option<Self> {
2496: pub fn new(language: &Language, source: &str) -> Result<Self, QueryError> {

$ Select-String crates/tags/src/tags.rs -Pattern "pub struct TagsConfiguration|pub fn generate_tags"
29:  pub struct TagsConfiguration {
281: pub fn generate_tags<'a>(

$ Select-String crates/loader/src/loader.rs -Pattern "libloading|pub fn load_language\("
22:  use libloading::{Library, Symbol};
1232: pub fn load_language(path: &Path, function_name: &str) -> LoaderResult<Language> {
```
