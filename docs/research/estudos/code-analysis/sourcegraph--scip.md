# SCIP (Semantic Code Intelligence Protocol)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/scip-code/scip |
| Clone local | `repositorios/_research/code-analysis/sourcegraph--scip` |
| Commit | `d556dd3c24b3c1787e0b62cd31f25188300e3098` |
| Licença | Apache-2.0 — `LICENSE:1`; bindings TS publicados como `@scip-code/scip` (`bindings/typescript/package.json:12`) |
| Categoria | code-analysis / formato de índice semântico |
| Stack | Go 1.26 (CLI + bindings), Protobuf (`scip.proto`), SQLite + zstd para servir, bindings em TS/Java/Kotlin/Rust/Haskell |
| Tamanho | 226 arquivos, ~49k linhas; `scip.proto` 919 linhas; `cmd/scip` ~1.9k linhas de Go; `bindings/go/scip` ~6k |

## 1. O que é (verificado no código)

Não é um indexador: é o **formato** do índice e as ferramentas para manipulá-lo. Um
`Index` (`scip.proto:26`) contém `Metadata` (`:41`), uma lista de `Document` (`:76`) e
`external_symbols`. Cada documento tem ocorrências (`Occurrence`, `:692`), símbolos
(`SymbolInformation`, `:253`) e, opcionalmente, o texto.

A peça central é o **symbol string** com gramática própria (`scip.proto:157-180`):
`<scheme> ' ' <manager> ' ' <package> ' ' <version> ' ' (<descriptor>)+`, onde cada
descriptor tem sufixo que codifica o tipo (`/` namespace, `#` tipo, `.` termo, `(...)`
método, `[]` type parameter, `()` parâmetro, `:` meta, `!` macro). É isso que dá um
identificador estável e comparável entre indexadores.

O CLI (`cmd/scip/main.go:22-30`) tem seis subcomandos: `lint`, `print`, `snapshot`,
`stats`, `test`, `convert`. Não há servidor nem consulta: quem consulta é o consumidor
(Sourcegraph, editor) lendo o índice.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `scip lint index.scip` | `cmd/scip/lint.go:41` | valida símbolos/documentos/relacionamentos |
| `scip print index.scip` | `cmd/scip/print.go:1` | imprime o índice em forma legível |
| `scip snapshot index.scip` | `cmd/scip/snapshot.go:1` | gera "snapshot" com anotações por linha |
| `scip stats index.scip` | `cmd/scip/stats.go:1` | contagens (docs, ocorrências, símbolos) |
| `scip test index.scip` | `cmd/scip/test.go:1` | verifica invariantes de teste |
| `scip convert index.scip -o out.db` | `cmd/scip/convert.go:74` | converte para SQLite com chunks zstd |
| `--from`, `--project-root`, `--comment-syntax` | `cmd/scip/main.go:71-95` | origem, raiz e sintaxe do snapshot |

O índice em si é produzido por indexadores de terceiros (scip-java, scip-typescript,
scip-python, rust-analyzer, etc.) — o repositório não contém nenhum indexador de linguagem.

## 3. Arquitetura e fluxo

```
indexer (externo) → Index (scip.proto:26)
  → Document (:76) → Occurrence (:692) { range, symbol, symbol_roles, diagnostics }
  → SymbolInformation (:253) { documentation, signature, relationships }
    → consumidor: lint (cmd/scip/lint.go:41) / convert → SQLite (cmd/scip/convert.go:74)
      → consulta: símbolo → ocorrências (Definition / Reference)
```

- Entry point do CLI: `cmd/scip/main.go:15` (`main`), comandos em `:22`.
- Validação: `lintMainPure` (`cmd/scip/lint.go:41`) percorre external symbols, documentos,
  símbolos e ocorrências, acumulando `errorSet`.
- Conversão: `convertMain` (`cmd/scip/convert.go:74`) cria o schema
  (`prepareIndexes`, `:131`), insere ocorrências (`insertOccurrenceData`, `:320`) e
  quebra em chunks comprimidos (`chunkOccurrences`, `:584`).
- Parsing/formatação de símbolo: `parseSymbolV2` (`bindings/go/scip/symbol_parser.go:65`),
  `FormatSymbol` (`bindings/go/scip/symbol_formatter.go:65`).
- Normalização: `canonicalize.go`, `sanitize.go`, `sort.go` em `bindings/go/scip`.
- Streaming: o proto exige que `metadata` venha primeiro e apareça uma única vez
  (`scip.proto:19-25`), justamente para permitir consumo em stream.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Identidade de símbolo | `scip.proto:190`, `:157` | string única e comparável entre índices | baixo |
| Ocorrência com papel | `scip.proto:692`, `:524` | definição/import/leitura/escrita/teste/forward | baixo |
| `enclosing_range` | `scip.proto:747-805` | intervalo do nó pai (breadcrumb, call hierarchy) | baixo |
| Relações entre símbolos | `scip.proto:465-516` | `is_implementation`, `is_type_definition`, `is_reference` | baixo |
| Hover documentado | `scip.proto:253-263`, `:236` | `documentation[]` + `signature_documentation` | baixo |
| Diagnóstico por ocorrência | `scip.proto:810` | severidade/código/mensagem/tags no range | baixo |
| Papel de leitura/escrita | `scip.proto:533-535` | distingue `x` de `x = 1` | baixo |
| Chunking para servir | `cmd/scip/convert.go:584` | ocorrências em blocos zstd por documento | baixo |
| Lint de índice | `cmd/scip/lint.go:41` | detecta símbolo vazio/duplicado/relação órfã | baixo |
| Snapshot legível | `cmd/scip/snapshot.go:1` | prova visual para revisão | baixo |

## 5. Loop do agente, contexto e streaming

O SCIP não tem loop; ele é o **substrato** para o loop de um agente:

- **Definição**: ocorrência com `SymbolRole.Definition` (`0x1`) no mesmo `symbol` →
  `Location` direta, sem heurística.
- **Referências**: todas as ocorrências com o mesmo `symbol`; se o símbolo tem relação
  `is_reference`, o consumidor deve incluir os símbolos relacionados
  (`scip.proto:467-491`) — é o que faz "referências" incluir overrides em Java/TS.
- **Hover**: `SymbolInformation.documentation` + `signature_documentation`
  (`scip.proto:257-263`), com `Occurrence.override_documentation` para tipos
  instanciados (`:729-737`).
- **Contexto**: `enclosing_range` dá o nó pai — usado para breadcrumb, "expand selection"
  e call hierarchy (`scip.proto:747-757`).
- **Streaming**: `Index` pode ser lido campo a campo; `Document.text` é opcional, então é
  possível servir índice sem carregar código-fonte.
- **Cancelamento/retry**: fora do escopo do formato; é responsabilidade do consumidor.

## 6. Sessões, estado e persistência

- O índice é **artefato de build** (`.scip`), não estado de sessão. Versionamento é por
  `Metadata.version` + `ToolInfo` (`scip.proto:41-51`).
- `project_root` é URI absoluta e todos os documentos são relativos a ela
  (`scip.proto:47-49`) — permite mover o checkout sem invalidar o índice.
- `TextEncoding` e `PositionEncoding` por documento (`scip.proto:52`, `:122`): o índice diz
  em que unidade os offsets estão (UTF-8/16/32).
- `scip convert` materializa em SQLite (`cmd/scip/convert.go:146`), com tabela de
  documentos, símbolos e chunks comprimidos — um formato de persistência consultável.
- Não há formato de *delta*: atualização = reindexar o arquivo/projeto e regravar.

## 7. Configuração e extensibilidade

- Extensibilidade = escrever um indexador. O protocolo não tem plugins.
- `SymbolInformation.kind` (`scip.proto:266-269`) é um enum com ~80 valores
  (`SymbolInformation.Kind`), o que evita cada indexador inventar seu vocabulário.
- `SyntaxKind` (`:548`) permite highlight sem parser no consumidor.
- Bindings gerados a partir do proto: Go (`bindings/go/scip/scip.pb.go`), TS
  (`bindings/typescript/scip_pb.ts:9`, `@bufbuild/protobuf`), Java, Kotlin, Rust, Haskell.
- `buf.yaml`/`buf.gen.yaml` na raiz definem geração de código.

## 8. Permissões, sandbox e erros

- Formato passivo: ler um índice não executa nada.
- O risco está no **indexador** (roda compilador/build do projeto) e no
  `scip convert` (escreve SQLite). Nenhum dos dois deve rodar no processo principal do app.
- `lint` é a rede de segurança: símbolo vazio, documento duplicado, `SymbolInformation`
  duplicado, relação apontando para símbolo inexistente (`cmd/scip/lint.go:46-95`).
- Erros de range: `Range.Validate` (`bindings/go/scip/position.go:87`) rejeita
  `end < start`, linha negativa e range de 5 elementos.
- Compatibilidade: campos `range`/`enclosing_range` antigos (`repeated int32`) convivem com
  os tipados (`single_line_range`/`multi_line_range`); o leitor deve preferir o tipado
  (`scip.proto:715-722`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Parser de símbolo | `bindings/go/scip/symbol_parser` + `parse_test.go` | gramática completa, escapes, disambiguadores |
| Formatação | `symbol_formatter_test.go` | round-trip parse→format |
| Ranges | `position_test.go` (240 linhas) | validação, comparação, encoding |
| Ocorrências | `occurrence_range_test.go` (172 linhas) | range antigo vs tipado |
| Lint | `cmd/scip/lint_test.go` (206 linhas) | cada classe de erro |
| Snapshot/print | `cmd/scip/*_test.go` | saída estável |
| Ordenação/canonicalização | `sort_test.go`, `canonicalize_test.go` | merge de índices |

O round-trip parse↔format de símbolo é o teste que mais importa para nós: é a garantia de
que um identificador gerado por nós será lido por outro consumidor.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Gramática de symbol string | `scip.proto:157-180` | ID estável entre execuções e entre linguagens | Apache-2.0 | `src/core/code-intelligence/symbol-id.ts` | 16 |
| Parser/formatter de símbolo | `bindings/go/scip/symbol_parser.go:65`, `symbol_formatter.go:65` | já resolvido, com testes de round-trip | Apache-2.0 | idem | 14 |
| Modelo ocorrência + papéis (bitset) | `scip.proto:692`, `:524-545` | distingue definição/uso/escrita/import/teste | Apache-2.0 | `src/core/code-intelligence/occurrences.ts` | 13 |
| `enclosing_range` | `scip.proto:747-805` | breadcrumb e "onde estou" sem AST | Apache-2.0 | `src/core/code-intelligence/outline.ts` | 11 |
| Relações (`is_implementation`/`is_type_definition`) | `scip.proto:465-516` | referências corretas em OO sem type checker completo | Apache-2.0 | `src/core/code-intelligence/references.ts` | 10 |
| Tipos TS prontos | `bindings/typescript/package.json:2` | `@scip-code/scip` no npm, sem binário | Apache-2.0 | dependência | 9 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `bindings/go`, `bindings/rust`, `bindings/java` | linguagens diferentes; o TS já existe |
| `cmd/scip` (CLI em Go) | precisaríamos de binário Go por plataforma para lint/convert |
| `scip convert` → SQLite/zstd | decisão de serving do Sourcegraph; nosso volume é de projeto local |
| Escrever indexador próprio em SCIP | o custo é o indexador (compilador/type checker), não o formato |
| `SyntaxKind` (80+ valores) | duplica o que tree-sitter/CodeMirror já resolvem |

## 12. Modelo de exemplo para o nosso harness

**Adotar o formato, não o pipeline.** Hoje nosso índice é regex
(`src/core/code-intelligence/index.ts:95-117`) e não tem identidade de símbolo: dois
`parse` em arquivos diferentes são símbolos distintos sem relação.

1. **`symbol-id.ts`**: implementar `formatSymbol`/`parseSymbol` com a gramática de
   `scip.proto:157-180` adaptada — para nós, `scheme = "openclod"`, `manager = "ts"` e
   descritores derivados do caminho do arquivo + nome qualificado. Guardar o ID no
   `CodeSymbol` (adicionar campo `id` em `index.ts:16-22`).
2. **`occurrences.ts`**: emitir `{ symbolId, path, range, roles }` com `roles` bitset
   mínimo (`definition`, `reference`, `write`, `test`) — o mesmo vocabulário de
   `SymbolRole` (`scip.proto:524`), sem os 7 bits que não usamos.
3. **Impacto**: `impact` do tool `code_intelligence` passa a responder por `symbolId` em
   vez de por nome — elimina falso positivo de homônimo.
4. **Persistência**: JSON Lines por projeto, com cabeçalho `{ version: 1, root }`, sem
   SQLite/zstd até doer.
5. **Teste**: round-trip `format(parse(s)) === s` para 20 símbolos reais (método com
   disambiguador, namespace aninhado, nome com backtick) — copiando a *ideia* dos testes de
   `symbol_formatter_test.go`, não o arquivo.

## 13. Evidências da análise

```text
$ git -C ... rev-parse HEAD
d556dd3c24b3c1787e0b62cd31f25188300e3098

$ Get-Content LICENSE -TotalCount 1
                                 Apache License

$ Select-String scip.proto -Pattern "^message |^enum "
26: message Index {
41: message Metadata {
76: message Document {
190: message Symbol {
205: message Descriptor {
253: message SymbolInformation {
465: message Relationship {
524: enum SymbolRole {
692: message Occurrence {
810: message Diagnostic {

$ Get-Content scip.proto (157-166)
// <symbol>  ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
// <package> ::= <manager> ' ' <package-name> ' ' <version>
// <namespace>  ::= <name> '/'
// <type>       ::= <name> '#'
// <term>       ::= <name> '.'
// <method>     ::= <name> '(' (<method-disambiguator>)? ').'

$ Select-String cmd/scip/main.go -Pattern "func commands"
22: func commands() []*cli.Command {
29: 	return []*cli.Command{&lint, &print, &snapshot, &stats, &test, &convert}

$ Select-String cmd/scip/convert.go -Pattern "func convertMain|func NewConverter|func chunkOccurrences"
74:  func convertMain(indexPath, sqliteDBPath, cpuProfilePath string, chunkSize int) (err error) {
244: func NewConverter(conn *sqlite.Conn, chunkSize int, writer *zstd.Encoder) *Converter {
584: func chunkOccurrences(occurrences []*scip.Occurrence, chunkSize int) []Chunk {

$ Select-String bindings/go/scip/symbol_parser.go -Pattern "func parseSymbolV2"
65: func parseSymbolV2(symbolUTF8 beaut.UTF8String, includeDescriptors bool, out *Symbol) error {
```
