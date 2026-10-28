# ast-grep

| Campo | Valor |
|---|---|
| Repositório | https://github.com/ast-grep/ast-grep |
| Clone local | `repositorios/_research/code-analysis/ast-grep--ast-grep` |
| Commit | `aaa80f08698dee907402f844da06850c435c431e` |
| Licença | MIT — `LICENSE`, `Cargo.toml:16` |
| Categoria | code-analysis / busca e reescrita estrutural |
| Stack | Rust 2024, workspace com 10 crates, `tree-sitter` 0.27, 30+ gramáticas embutidas, bindings `napi`/`wasm`/`pyo3` |
| Tamanho | 325 arquivos, ~45k linhas; `crates/core` ~6.2k linhas, `crates/config` ~9.9k, `crates/cli` ~13.4k |

## 1. O que é (verificado no código)

Busca e reescrita de código por **padrão AST**, não por texto: você escreve
`$A.to($B)` e ele casa nós da árvore, captura metavariáveis e pode reescrever o nó com um
template. Depois adiciona uma camada de **regras** (YAML/JSON) com `id`, `message`,
`severity`, `fix`, `files`, `ignores`, e uma CLI que roda isso em paralelo no repositório.

O entrypoint é a CLI `sg` (`crates/cli/src/main.rs:6` chama `execute_main`;
`crates/cli/src/lib.rs:57` define os subcomandos). O núcleo reutilizável está em
`crates/core/src/matcher.rs:27` (`trait Matcher`) e
`crates/core/src/matcher/pattern.rs:355` (`Pattern::new`).

Ponto importante: o ast-grep **não é um language server**. O LSP dele
(`crates/lsp/src/lib.rs`) implementa `hover`, `codeAction` e `executeCommand` — não
`definition`, `references` nem `rename`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `sg -p '$A' -r 'foo($A)'` | `crates/cli/src/run.rs:64-66`, `:131` | busca pontual com reescrita; `run` é o comando default (`lib.rs:97-106`) |
| `sg scan` | `crates/cli/src/scan.rs:240` | roda todas as regras do `sgconfig.yml` em paralelo |
| `sg scan --interactive` | `crates/cli/src/scan.rs:110-113` | revisão match a match (diff) |
| `sg scan --json` | `crates/cli/src/scan.rs:48` | saída estruturada para consumo |
| `sg test` | `crates/cli/src/lib.rs:63` (`verify.rs`) | testa regras contra casos com snapshot |
| `sg new` | `crates/cli/src/lib.rs:65` | cria projeto/regra/teste |
| `sg lsp` | `crates/cli/src/lib.rs:67` | sobe o language server mínimo |
| `sg outline` | `crates/cli/src/lib.rs:69` | símbolos, imports, exports e membros |
| `sg completions` | `crates/cli/src/lib.rs:71` | script de shell completion |

Flags de `run`: `-p/--pattern`, `-k/--kind`, `-s/--selector`, `--strictness`,
`-r/--rewrite`, `-l/--lang`, `--json`, `--interactive`, `--stdin`, `--debug-query`
(`crates/cli/src/run.rs:64-109`).

## 3. Arquitetura e fluxo

```
sg run/scan (crates/cli/src/run.rs, scan.rs)
  → SgLang (crates/language) — gramática tree-sitter + regras de identificador
    → Pattern::new (crates/core/src/matcher/pattern.rs:355)
      → PatternNode (kind + filhos + metavars)
        → Matcher::match_node_with_env (matcher.rs:31)
          → MetaVarEnv (meta_var.rs) → NodeMatch
            → Fixer::generate_replacement (config/src/fixer.rs:177) → edit
```

- Entry point: `crates/cli/src/main.rs:6` → `crates/cli/src/lib.rs:143` (`main_with_args`).
- Loop de arquivos: `WalkParallel` do crate `ignore` (`crates/cli/src/scan.rs:12`,
  `:240`) — o mesmo walker do ripgrep.
- Casamento: `Pattern::match_node_with_env` (`pattern.rs:388`) faz poda por `kind_id`
  antes de descer (`:393-397`) e usa `Cow` para **não poluir o ambiente** quando o
  padrão falha (`:398-404`).
- Poda por tipo: `potential_kinds` devolve um `BitSet` de kinds possíveis
  (`matcher.rs:37-41`, implementação em `pattern.rs:408`), aplicado pelo walker.
- Fix: `Fixer` (`config/src/fixer.rs:68`) com `template`, `expand_start/end` e
  `Trans` para transformar metavars antes de interpolar (`transform/trans.rs:107`).
- Saída: `crates/cli/src/print` (4 arquivos, 583 linhas) com `JSONPrinter`,
  `InteractivePrinter`, `Diff`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Padrão estrutural | `crates/core/src/matcher/pattern.rs:355` | casa subárvore por forma, com `$VAR`/`$$$VARS` | baixo |
| Casamento por kind | `crates/core/src/matcher/kind.rs:1` | casa só o tipo do nó (`-k function_declaration`) | baixo |
| Regex sobre texto do nó | `crates/core/src/matcher/text.rs:1` | híbrido AST + regex | baixo |
| Regras compostas | `crates/config/src/rule/relational_rule.rs:39` | `inside`, `has`, `precedes`, `follows` + `stopBy` | baixo |
| nthChild | `crates/config/src/rule/nth_child.rs:1` | posição posicional (`An+B`) | baixo |
| Fix com template | `crates/config/src/fixer.rs:68` | reescreve nó usando metavars | **alto** (escrita) |
| Transformações | `crates/config/src/transform/trans.rs:107` | `substring`, `replace`, `convert`, `rewrite` | médio |
| Outline | `crates/outline/src/model.rs:90` | símbolos + imports/exports + membros | baixo |
| LSP mínimo | `crates/lsp/src/lib.rs:197` | code action aplicando fix | **alto** (edita workspace) |
| Bindings nativos | `crates/napi/src/lib.rs:88` | `parse`, `findInFiles`, `registerDynamicLanguage` | médio |

Operadores de regra disponíveis em `crates/config/src/rule/*`: `all`, `any`, `not`,
`matches`, `inside`, `has`, `precedes`, `follows`, `nthChild`, `range`, `pattern`,
`kind`, `regex`, `constraints` por metavar (`rule_core.rs:52`), `utils` para regras
nomeadas (`:54`) e `transform` (`:58`).

## 5. Loop do agente, contexto e streaming

Sem agente; o "loop" é o walk paralelo + primeiro match por nó. O que importa:

- **Ambiente de metavars com rollback**: `MetaVarEnv` e `Cow` garantem que uma tentativa
  falha não contamine a próxima (`pattern.rs:398-405`). Sem isso, `$A` de um match
  parcial vazaria para outro nó.
- **Ellipsis**: `$$$ARGS` casa zero ou mais irmãos; `is_trivial` (`pattern.rs:181`) pula
  pontuação ao casar depois de uma ellipsis, para não exigir vírgula exata.
- **Strictness**: `cst`/`smart`/`ast`/`relaxed`/`signature`/`template`
  (`pattern.rs:359`, `:410`), que muda se nós anônimos contam.
- **Escopo de busca**: `find`/`find_all` descem em DFS (`crates/core/src/node.rs:329`,
  `:333`); não há índice — cada consulta varre o arquivo.
- **Limite**: `scan` ordena regras com fix primeiro (`config/src/combined.rs:249-251`)
  para aplicar correções em ordem determinística; sem isso, duas regras podem brigar pelo
  mesmo intervalo.
- **Cancelamento/retry**: inexistentes na CLI; o paralelismo é por arquivo.

## 6. Sessões, estado e persistência

- Sem sessão. Projeto é definido por `sgconfig.yml` (`crates/cli/src/config.rs`,
  `crates/cli/src/lib.rs:48-50`) com `ruleDirs`, `testConfigs`, `utilDirs`,
  `customLanguages` (aceita política `ignore`/`load`, `lib.rs:51-53`).
- Regras são arquivos YAML carregados em `RuleCollection`
  (`crates/config/src/rule_collection.rs`) com validação de variáveis usadas/definidas
  (`check_var.rs`, `fixer.rs:167`).
- Testes de regra são snapshot em disco (`crates/cli/src/verify.rs`), o que dá um formato
  de "golden file" por regra.
- Nada de índice persistente: cada execução relê as regras e reparseia os arquivos.

## 7. Configuração e extensibilidade

- `sgconfig.yml` + `ruleDirs` + `utilDirs` (regras globais reutilizáveis,
  `rule_core.rs:54`) + `transform` (`:58`) + `constraints` por metavar (`:52`).
- Linguagens customizadas: `registerDynamicLanguage` via napi
  (`crates/napi/src/lib.rs:124`) ou `customLanguages` no config, carregando `.so`/`.dll`
  de gramática — mesmo risco do tree-sitter loader.
- Fixers são dados, não código: template + transformações (`fixer.rs:153`), o que torna a
  regra auditável antes de aplicar.
- `rewriters` permitem reescrever o *padrão* antes de casar
  (`rule_config.rs:91`, `transform/rewrite.rs:13`).

## 8. Permissões, sandbox e erros

- `scan --interactive` mostra diff e pede confirmação (`scan.rs:110-113`), mas
  `--update-all` aplica sem perguntar (`scan.rs:113`). Em agente, o default tem que ser
  dry-run.
- Erro de parse do padrão é tipado: `PatternError::{Parse, NoContent, MultipleNode,
  RootMultiMetaVar}` (`pattern.rs:252-270`) — mensagens boas o suficiente para devolver ao
  modelo e ele corrigir o padrão.
- Erro de regra: `RuleConfigError` + `check_var` detectam metavar não definida antes de
  rodar (economiza um scan inteiro).
- Não há sandbox de execução; regras não executam código, só casam/reescrevem. O vetor é
  carregar gramática nativa (`customLanguages`) — deve ficar desligado.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Testes de núcleo | `crates/core/src/matcher/pattern.rs:584+` | `potential_kinds`, padrões contextuais |
| Testes de regra | `crates/config/src/rule_config.rs:388+` | mensagem com metavar, regra global parametrizada |
| Snapshot de regras | `crates/cli/src/verify.rs` | caso de teste por regra |
| Fixtures | `fixtures/` | projetos de exemplo para scan |
| CLI | `crates/cli/src/tests` | parse, print, scan |
| Bindings | `crates/napi/__test__` | API Node |

Qualidade acima da média em *erros de uso*: as mensagens de `PatternError` e de regra
inválida são o que um agente precisa para se autocorrigir.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Schema de regra (id/message/severity/fix/files/ignores) | `crates/config/src/rule_config.rs:84` | formato declarativo, validável, com fix separado do match | MIT | `src/core/quality/rules/schema.ts` | 19 |
| Modelo de padrão com metavar + ellipsis | `crates/core/src/matcher/pattern.rs:355`, `:181` | é o que torna "busca estrutural" utilizável por LLM | MIT | `src/core/code-intelligence/patterns.ts` | 18 |
| Poda por `potential_kinds` | `crates/core/src/matcher.rs:37-41` | evita varrer a árvore inteira por consulta | MIT | idem | 14 |
| Rollback de ambiente (`Cow`) | `crates/core/src/matcher/pattern.rs:398-405` | correção semântica em padrões com alternância | MIT | idem | 11 |
| Outline (role/símbolo/assinatura/membros) | `crates/outline/src/model.rs:90-117` | formato pronto para "visão geral do arquivo" | MIT | `src/core/code-intelligence/outline.ts` | 17 |
| Transformações de fix (substring/replace/convert) | `crates/config/src/transform/trans.rs:107` | cobre 90% dos codemods reais sem plugin | MIT | `src/core/quality/rules/fix.ts` | 12 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `crates/core` em Rust | reimplementar o matcher em TS é viável; portar o crate não (sem FFI no renderer, napi exige binário por plataforma) |
| `crates/language` (30+ gramáticas compiladas) | peso de build e licenças de terceiros por gramática |
| `customLanguages` / `registerDynamicLanguage` | carrega biblioteca nativa; risco de execução |
| LSP do ast-grep | só code action/hover; não substitui um LS de verdade |
| `crates/cli/src/print` | formatação de terminal; nosso consumo é JSON |

## 12. Modelo de exemplo para o nosso harness

Duas camadas, com decisão explícita de dependência:

1. **Se aceitarmos binário**: usar `@ast-grep/napi` (`crates/napi/package.json:2`,
   alvos `win32-x64-msvc` etc.) em processo separado, com `parse`/`findInFiles`, e nunca
   `registerDynamicLanguage`. Vantagem: 30+ linguagens prontas. Custo: binário por
   plataforma (já empacotamos `rg.exe`, então o precedente existe).
2. **Se ficarmos em TS puro**: portar só o *schema* — `pattern` + `kind` + `inside/has` +
   `fix` — sobre `web-tree-sitter`, com `potential_kinds` como filtro. O schema de
   `SerializableRuleConfig` (`rule_config.rs:84`) é pequeno o suficiente para virar um
   `zod` schema e reusar o validador que já existe em `src/core/tools/types.ts:202`.

Integração com o agente: uma tool `code_rule` com ações `search`, `preview_fix`,
`apply_fix`; `apply_fix` sempre devolve o diff e exige confirmação, no espírito de
`scan --interactive` (`scan.rs:110-113`). O `outline` vira uma ação do
`code_intelligence` existente (`src/core/tools/code-intelligence.ts:26`).

## 13. Evidências da análise

```text
$ git -C ... rev-parse HEAD
aaa80f08698dee907402f844da06850c435c431e

$ Select-String Cargo.toml -Pattern "^version|^license"
13: version = "0.51.0"
16: license = "MIT"

$ Select-String crates/core/src/matcher.rs -Pattern "pub trait Matcher|potential_kinds"
27: pub trait Matcher {
39:   fn potential_kinds(&self) -> Option<BitSet> {

$ Get-Content crates/core/src/matcher/pattern.rs (388-405)
pub fn match_node_with_env<'tree, D: Doc>(
  ...
  if let Some(k) = self.root_kind && node.kind_id() != k { return None; }
  // do not pollute the env if pattern does not match
  let mut may_write = Cow::Borrowed(env.as_ref());
  let node = match_node_non_recursive(self, node, &mut may_write)?;

$ Select-String crates/config/src/rule_config.rs -Pattern "pub struct SerializableRuleConfig"
84: pub struct SerializableRuleConfig<L: Language> {

$ Select-String crates/config/src/transform/trans.rs -Pattern "pub enum Trans"
107: pub enum Trans<T> {

$ Select-String crates/cli/src/lib.rs -Pattern "enum Commands"
57: enum Commands {

$ Select-String crates/lsp/src/lib.rs -Pattern "async fn (hover|code_action|did_open)"
170: async fn did_open(&self, params: DidOpenTextDocumentParams) {
197: async fn code_action(&self, params: CodeActionParams) -> Result<Option<CodeActionResponse>> {
205: async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
```
