# ripgrep

| Campo | Valor |
|---|---|
| Repositório | https://github.com/BurntSushi/ripgrep |
| Clone local | `repositorios/_research/code-analysis/BurntSushi--ripgrep` |
| Commit | `6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30` |
| Licença | `Unlicense OR MIT` — `Cargo.toml:14`, `UNLICENSE`, `LICENSE-MIT` |
| Categoria | code-analysis / busca textual |
| Stack | Rust 2024 (rust-version 1.96), workspace com 9 crates, `lexopt` para CLI, `serde_json` para saída |
| Tamanho | 226 arquivos (sem `.git`), ~54k linhas de código+docs; ~45k linhas de Rust em `crates/` |

## 1. O que é (verificado no código)

Um buscador de texto orientado a linha que percorre diretórios respeitando regras de
ignore (`.gitignore`, `.ignore`, exclude global do git, overrides por glob). O binário é
`rg` e o entrypoint real é `crates/core/main.rs:32` (`[[bin]] path = "crates/core/main.rs"`),
com `fn main` em `crates/core/main.rs:43` e o roteamento em `fn run`
(`crates/core/main.rs:77`).

O README promete "recursivamente busca o diretório atual respeitando gitignore"; o código
confirma e vai além: a ordem de precedência das regras está escrita como contrato em
`crates/ignore/src/walk.rs:454-486` e implementada em `WalkBuilder::build` /
`skip_entry` (`crates/ignore/src/walk.rs:593`, `:1149`).

O projeto não é uma biblioteca de índice: não há parsing, AST nem semântica. É um motor de
varredura + casamento de regex com um modelo de "o que ignorar" muito bem especificado.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `rg <pattern> [path]` | `crates/core/main.rs:77` | busca padrão (modo `SearchMode::Standard`) |
| `rg --files` | `crates/core/main.rs:89` | lista arquivos que sobrevivem ao filtro de ignore |
| `rg --type-list` | `crates/core/main.rs:91` | imprime tipos de arquivo embutidos (`crates/ignore/src/default_types.rs:1`) |
| `rg --json` | `crates/core/flags/lowargs.rs:212-213` | saída JSON Lines (`type` = begin/end/match/context) |
| `rg -l`, `-c`, `-o`, `-r` | `crates/core/flags/defs.rs` (`FLAGS`) | lista/count/only-matching/replace |
| `rg -g <glob>`, `--iglob` | `crates/ignore/src/overrides.rs:1` | overrides que precedem todo o resto |
| `rg --no-ignore*`, `--hidden`, `-uu` | `crates/core/flags/lowargs.rs:80-86`, `:61` | desliga camadas de ignore, inclui ocultos |
| `rg -U` (multiline), `--crlf`, `-E enc` | `crates/core/flags/lowargs.rs:77-78`, `:50`, `:52` | multiline/dotall, CRLF, encoding |
| `rg -z` (search-zip), `--pre` | `crates/core/search.rs:71-76`, `:92` | descompacta ou roda preprocessador antes de buscar |

Superfície de CLI: 104 flags lógicas em `FLAGS` (`crates/core/flags/defs.rs:50` adiante),
cada uma podendo ter nome longo, curto, negação e aliases (comentário em
`crates/core/flags/defs.rs:1-17`). Famílias: padrão (`-e`, `-f`, `-F`, `-P`), filtros
(`-g`, `-t`, `-T`, `--max-depth`, `--max-filesize`), contexto (`-A/-B/-C`, `--passthru`),
formatação (`--json`, `--vimgrep`, `--column`, `--heading`), modo (`--files`, `--type-list`,
`--generate`, `--pcre2-version`).

## 3. Arquitetura e fluxo

```
flags::parse (crates/core/flags/parse.rs) → HiArgs
  → run (crates/core/main.rs:77)
    → mode Search/Files/Types/Generate
      → WalkBuilder::build(_parallel) (crates/ignore/src/walk.rs:593 / :701)
        → Haystack (path+reader) (crates/core/haystack.rs)
          → SearchWorker::search (crates/core/search.rs:245)
            → Searcher (crates/searcher) → Matcher (crates/matcher) → Printer (crates/printer)
```

- Entry point: `crates/core/main.rs:43`; dispatch em `crates/core/main.rs:85-93`.
- Loop de arquivos: `crates/core/main.rs:124-142` (sequencial) e `:175-205` (paralelo).
- Execução da busca: `crates/core/search.rs:245`; `SearchWorker` é o ponto onde entram
  preprocessador e descompressão (`crates/core/search.rs:1-8`, `:71-76`).
- Paralelismo: vem do walker, não de um pool de arquivos — `build_parallel().run(...)`
  (`crates/core/main.rs:175`), com `WalkState` controlando parada antecipada
  (`crates/core/main.rs:186`, `:194`).
- Ordenação: `--sort path` desliga paralelismo (`crates/core/main.rs:158-159`).
- Streaming: o `Sink` do printer recebe eventos linha a linha; no modo paralelo cada
  worker escreve num buffer e o printer é limpo por arquivo (`crates/core/main.rs:189`).
- Persistência: nenhuma. Sem cache, sem índice em disco, sem estado entre execuções.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Busca regex por linha | `crates/core/search.rs:245` | casa padrão por linha com contexto | baixo |
| Busca multiline | `crates/core/flags/lowargs.rs:77` | `-U` + `--multiline-dotall` | baixo |
| Listagem filtrada | `crates/core/main.rs:89` | `--files` com todas as regras de ignore | baixo |
| Overrides por glob | `crates/ignore/src/overrides.rs:1` | `-g` vence tudo, inclusive gitignore | baixo |
| Tipos embutidos | `crates/ignore/src/default_types.rs:1` | ~200 definições de `--type` | baixo |
| Ignore em cascata | `crates/ignore/src/walk.rs:454` | `.ignore` > `.gitignore` > exclude > global | baixo |
| Preprocessador | `crates/core/search.rs:92` | executa comando externo por arquivo | **alto** (executa binário arbitrário) |
| Decompressão | `crates/core/search.rs:123` | abre `.gz/.bz2/.xz/.zst` via binário externo | médio |
| Saída JSON | `crates/printer/src/json.rs:504` | contrato estável para consumo por programa | baixo |
| Substituição | `crates/printer/src/jsont.rs:136-153` | `-r` com `replacement` nas submatches | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente. O análogo do "loop" é `run` → walker → `SearchWorker::search`
(`crates/core/search.rs:245`). O que interessa para nós:

- **Contrato de evento por arquivo**: `begin` (path) → N × `match`/`context` → `end`
  (path, binary_offset, stats) — `crates/printer/src/jsont.rs:11-16`, `:65-69`.
- **Dados por match**: `path{text,bytes}`, `lines{text,bytes}`, `line_number`,
  `absolute_offset`, `submatches[{match:{text,bytes},start,end}]`
  (`crates/printer/src/jsont.rs:86-131`). Note que bytes e texto vêm juntos: offsets são
  confiáveis mesmo em arquivo com encoding misto.
- **Cancelamento**: não existe sinal; o padrão é `--quit-after-match` / `-q` (`-q` + parada
  no primeiro match, `crates/core/main.rs:139`) e a quebra por `BrokenPipe`
  (`crates/core/main.rs:129`).
- **Retry**: inexistente. Erro por arquivo é reportado e o loop continua
  (`crates/core/main.rs:130-133`).
- **Contexto**: `-A/-B/-C` são resolvidos no searcher; `ContextMode` também suporta
  `passthru` (`crates/core/flags/lowargs.rs:361-362`), que emite todas as linhas marcando
  as que casaram.

## 6. Sessões, estado e persistência

Nenhuma sessão e nenhum estado persistido. O único estado de processo é o contador de
estatísticas (`crates/printer/src/stats.rs`) e o `messages::errored()` usado para o código
de saída (`crates/core/main.rs:94-100`). Configuração opcional vem de um arquivo de config
via `RIPGREP_CONFIG_PATH`; o harness já neutraliza isso com `RIPGREP_CONFIG_PATH: ''`
(`src/core/tools/search.ts:84-85`), o que é a decisão correta: config de usuário não pode
mudar o que o agente vê.

## 7. Configuração e extensibilidade

- Precedência de ignore documentada em `crates/ignore/src/walk.rs:454-486`: (1) overrides
  por glob, (2) arquivos de ignore na ordem `.ignore` > `.gitignore` > `.git/info/exclude` >
  gitignore global > ignores adicionados por API, com aninhamento vencendo dentro de cada
  nível, (3) tipo de arquivo, (4) ocultos, (5) tamanho máximo, (6) entrega.
- Whitelist (`!`) pode ser reaberta por regra posterior; `matched_path_or_any_parents`
  (`crates/ignore/src/gitignore.rs:234`) existe justamente para responder "este caminho
  dentro de um diretório ignorado deve ser ignorado?" — necessário quando a ferramenta
  recebe um arquivo explícito.
- `GitignoreBuilder::add_line` (`crates/ignore/src/gitignore.rs:463`) é o parser real de
  sintaxe gitignore (barra inicial, barra final = só diretório, `**`, `!`, comentário).
- Extensibilidade de comportamento: só por flags e por `--pre` (comando externo). Não há
  plugins, hooks ou API de extensão em processo.

## 8. Permissões, sandbox e erros

- Sem sandbox. `--pre` executa qualquer binário com o path do arquivo como argumento
  (`crates/core/search.rs:87-91`); `-z` invoca descompactadores externos
  (`crates/core/search.rs:71-76`). Ambos são vetores de execução e devem ficar fora do
  caminho padrão de uma ferramenta de agente.
- Erro de I/O por arquivo não aborta: `err_message!` e `continue`
  (`crates/core/main.rs:130-133`). `BrokenPipe` encerra com sucesso (`crates/core/main.rs:55-59`).
- Códigos de saída: 0 com match, 1 sem match, 2 em erro (`crates/core/main.rs:94-100`).
- Detecção de binário é heurística configurável (`crates/searcher/src/line_buffer.rs:42-77`);
  por padrão desligada no search worker (`crates/core/search.rs:33-34`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Integração de CLI | `tests/tests.rs:35` (`[[test]] name = "integration"`) | flags, saída, exit codes |
| JSON | `tests/json.rs` (387 linhas) | schema begin/match/context/end |
| Regressão | `tests/regression.rs` (1500 linhas) | bugs históricos |
| Multiline | `tests/multiline.rs` (109 linhas) | `-U`, dotall, limites de linha |
| Binário | `tests/binary.rs` (410 linhas) | NUL, `--binary`, offsets |
| Unidades por crate | `crates/*/src/**` (`#[cfg(test)]`) | globset, gitignore, walker |
| Fuzz | `fuzz/` | parser de gitignore/glob |

Qualidade notável: `AI_POLICY.md:1-30` proíbe agente autônomo contribuindo no projeto.
Isso não afeta o uso do código (licença permite), mas é um sinal do nível de exigência.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Modelo de precedência de ignore | `crates/ignore/src/walk.rs:454-486` | 7 regras explícitas, testadas; hoje nosso `DEFAULT_IGNORES` é só um `Set` de nomes (`src/core/util/fs-walk.ts:4`) | Unlicense/MIT | `src/core/util/ignore-rules.ts` | 18 |
| Parser de gitignore | `crates/ignore/src/gitignore.rs:463` | trata `!`, `/` final, `**`, âncora e negação parcial | Unlicense/MIT | `src/core/util/gitignore.ts` | 17 |
| Matching de caminho dentro de ignorado | `crates/ignore/src/gitignore.rs:234` | responde o caso "arquivo explícito dentro de pasta ignorada" | Unlicense/MIT | `src/core/util/ignore-rules.ts` | 15 |
| Contrato JSON de resultado | `crates/printer/src/jsont.rs:86-131` | offsets em bytes + texto, submatches com start/end | Unlicense/MIT | `src/core/tools/search.ts` (schema interno) | 16 |
| Semântica de glob | `crates/globset/src/glob.rs:142` | `**`, classes, case-insensitive opcional | Unlicense/MIT | `src/core/util/fs-walk.ts:63` (substituir `globToRegExp`) | 12 |
| Flags de segurança de saída | `crates/core/main.rs:55-59` | BrokenPipe como sucesso evita erro falso no agente | Unlicense/MIT | `src/core/tools/search.ts` | 8 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Motor de regex + `pcre2` | Rust, acoplado a `grep-regex`; já usamos `rg.exe` empacotado (`resources/bin/rg.exe`) |
| `--pre` e `-z` | execução de binário externo por arquivo; risco alto sem ganho para o agente |
| Searcher com mmap | decisão de performance de processo único; irrelevante no Electron |
| CLI (`crates/cli`, `flags/defs.rs`) | 104 flags e geração de man page; nosso contrato é tool schema, não argv |
| `crates/printer/src/standard.rs` (3688 linhas) | formatação de terminal com cor/hyperlink; não consumimos TTY |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem inventar API:

**Dependência/binário**: `rg.exe` continua sendo o motor (já empacotado em
`resources/bin/rg.exe`). O que se reimplementa em TS é a camada de decisão (ignore/glob)
e o contrato de saída — nada de reescrever o casamento de regex.

1. **`ignore-rules.ts`**: uma função `shouldSkip(relPath, isDir, { overrides, layers })`
   que aplica a ordem de `walk.rs:454-486` e devolve também *qual* regra decidiu (para
   explicar ao agente por que um arquivo não apareceu). Entrada: `DEFAULT_IGNORES`
   (`src/core/util/fs-walk.ts:4`) + `.gitignore`/`.ignore` lidos sob demanda com cache por
   diretório, no espírito de `incremental.rs:58` (`IncrementalIgnore`).
2. **`search.ts`**: manter o spawn de `rg.exe`, mas padronizar o parse em cima de
   `begin/match/end` com `absolute_offset` e `submatches`, e expor `truncated` quando
   `RG_GLOB_CAP` (`src/core/tools/search.ts:20`) estourar.
3. **Teste**: corpus com (a) `.gitignore` aninhado, (b) `!` reabrindo arquivo em pasta
   ignorada, (c) arquivo oculto, (d) `-g` vencendo gitignore, (e) CRLF. Comparar nossa
   decisão com `rg --files` no mesmo diretório — o binário vira oráculo de teste, não
   dependência de runtime para a regra.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/code-analysis/BurntSushi--ripgrep rev-parse HEAD
6892bc2b7efe5909cbbeec8f757ed2c4c76b1d30

$ Select-String Cargo.toml -Pattern "license|^version|^name"
2:  name = "ripgrep"
3:  version = "15.2.0"  #:version
14: license = "Unlicense OR MIT"

$ Select-String crates/core/main.rs -Pattern "fn main|fn run|fn search"
43: fn main() -> ExitCode {
77: fn run(result: crate::flags::ParseResult<HiArgs>) -> anyhow::Result<ExitCode> {
107: fn search(args: &HiArgs, mode: SearchMode) -> anyhow::Result<bool> {
160: fn search_parallel(args: &HiArgs, mode: SearchMode) -> anyhow::Result<bool> {

$ Select-String crates/ignore/src/walk.rs -Pattern "Ignore rules"
454: /// # Ignore rules
464: /// * Second, ignore files are checked...
468: /// is: `.ignore`, `.gitignore`, `.git/info/exclude`, global gitignore and

$ Select-String crates/core/flags/lowargs.rs -Pattern "no_ignore"
80:     pub(crate) no_ignore_dot: bool,
81:     pub(crate) no_ignore_exclude: bool,
82:     pub(crate) no_ignore_files: bool,
83:     pub(crate) no_ignore_global: bool,
84:     pub(crate) no_ignore_messages: bool,
85:     pub(crate) no_ignore_parent: bool,
86:     pub(crate) no_ignore_vcs: bool,

$ (Select-String crates/core/flags/defs.rs -Pattern "^    &[A-Z][A-Za-z0-9]*,$").Count
104

$ Get-Content crates/printer/src/jsont.rs (86-92)
pub(crate) struct Match<'a> {
    pub(crate) path: Option<&'a Path>,
    pub(crate) lines: &'a [u8],
    pub(crate) line_number: Option<u64>,
    pub(crate) absolute_offset: u64,
    pub(crate) submatches: &'a [SubMatch<'a>],
}
```
