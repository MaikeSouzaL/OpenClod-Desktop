?# universal-ctags

| Campo | Valor |
|---|---|
| Repositório | https://github.com/universal-ctags/ctags |
| Clone local | `repositorios/_research/code-analysis/universal-ctags--ctags` |
| Commit | `82494361bb3e7d4f7cf1d2bdc0d0e9001c926e45` |
| Licença | **GPL-2.0** (`COPYING:1`) — **não copiar código**. Exceção: `libreadtags/readtags.{c,h}` são *public domain* (`readtags.h:4`) |
| Categoria | code-analysis / índice de símbolos (tags) |
| Stack | C (autotools/`configure.ac`), 119 parsers em `parsers/`, parsers declarativos em `optlib/*.ctags`, gerador `peg/` (packcc) |
| Tamanho | 7.342 arquivos, ~215k linhas; `main/` 138 arquivos; `parsers/` 119 `.c`; 271 casos em `Tmain/` |

## 1. O que é (verificado no código)

Gera um **arquivo de tags**: uma linha por símbolo (`nome<TAB>arquivo<TAB>endereço`) que
editores usam para pular para definições. Cada linguagem tem um parser (C escrito à mão ou
descrito em `optlib/*.ctags`) que chama `makeTagEntry` (`main/entry.c:1955`); o writer
(`main/writer-ctags.c`, `writer-json.c`, `writer-etags.c`, `writer-xref.c`) formata.

O entrypoint é `main()` em `main/main.c`, com o laço de arquivos em
`createTagsForEntry` (`main/main.c:202`) e a escrita em `writeTagEntry`
(`main/entry.c:1782`). O que o projeto entrega de fato é: (a) um catálogo grande de
parsers, (b) um formato de saída estável, (c) um **sistema de campos** dinâmico
(`main/field.c`, 1764 linhas) que permite ligar/desligar informação por símbolo.

Contraponto verificado: os parsers por regex (`main/lregex.c`, 3995 linhas) usam POSIX ERE
(`docs/optlib.rst:73`), não PCRE — não há backtracking moderno, lookaround nem lazy
quantifier, e `*`/`+` são gulosos por definição (`docs/optlib.rst:95`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `ctags -R .` | `main/main.c:202` | varre recursivamente e escreve `tags` |
| `ctags --output-format=json -R .` | `main/writer-json.c:57` | uma linha JSON por tag (+ ptags) |
| `ctags --output-format=xref` | `main/writer-xref.c:1` | tabela legível para humano |
| `ctags -e` | `main/writer-etags.c:1` | formato etags do Emacs |
| `ctags --list-languages` | `main/parse.c:192` (`countParsers`) | lista linguagens e parsers |
| `ctags --list-kinds-full=<LANG>` | `main/kind.c` | kinds e letras por linguagem |
| `ctags --list-fields` | `main/field.c` | campos disponíveis (`n`, `S`, `s`, `t`, ...) |
| `ctags --fields=+n+S` | `main/field.c` | liga linha e assinatura na saída |
| `ctags --extras=+q` | `main/xtag.c` | tags extras (qualified, reference, ...) |
| `ctags --languages=+Java --kinds-Java=+m` | `main/options.c` | habilita linguagem/kind |
| `ctags --map-Java=+.jav` | `main/selectors.c` | mapeia extensão → linguagem |
| `ctags --_mtable-regex-<LANG>=...` | `main/lregex.c:2472` | define parser por estado (optlib) |
| `readtags -t tags - <nome>` | `libreadtags/readtags.c` | consulta o arquivo de tags |

Superfície: centenas de opções de linha de comando, agrupadas em `main/options.c` (3728
linhas), e um formato de arquivo de configuração (`docs/option-file.rst`). É a maior
superfície de CLI dos sete repositórios.

## 3. Arquitetura e fluxo

```
main (main/main.c) → createTagsForEntry (:202)
  → selectByLanguage (main/selectors.c) → parserDefinition (main/parse.c:137)
    → parser C ou optlib (main/lregex.c:2348)
      → makeTagEntry (main/entry.c:1955)
        → writeTagEntry (main/entry.c:1782)
          → writer (writer-ctags / writer-json / writer-xref / writer-etags)
```

- Entry point: `main/main.c:202`; registro de parsers em `main/parse.c:137`
  (`BuiltInParsers[]`), fábrica em `main/parse.c:243` (`parserNew`).
- Leitura de entrada: `main/read.c` (1406 linhas) + `main/mio.c` (1222 linhas, I/O
  multiplexado para vários arquivos).
- Paralelismo: `main/promise.c` (304 linhas) agenda parsers; parsers de sub-linguagem
  retornam promessas (`main/subparser.h`).
- Emissão: `makeTagEntry` valida e decide se emite (`main/entry.c:1975-1984`), delega ao
  writer ativo.
- Campos: `main/field.c` renderiza cada campo sob demanda (`renderField`,
  `doesFieldHaveValue`), o que mantém a saída enxuta.
- Tipos e escopo: `main/kind.c` (613 linhas) e `main/nestlevel.c` (129 linhas).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Tag de definição | `main/entry.c:1955` | nome + arquivo + linha/padrão | baixo |
| Tag de referência | `main/parse.c:203` (`makeSimpleRefTag`) | registra uso, não só definição | baixo |
| Saída JSON | `main/writer-json.c:46` | `_type` tag/ptag + campos | baixo |
| Pseudo-tags de cabeçalho | `man/tags.5.rst.in:477` | `!_TAG_FILE_FORMAT`, `_SORTED`, `_PROGRAM_VERSION` | baixo |
| Parser por regex | `main/lregex.c:2472` | linguagem nova sem recompilar | médio |
| Parser por tabela de estados | `main/lregex.c:133` | casa bloco multi-linha (`--_mtable-regex-`) | médio |
| Seleção por extensão/pattern | `main/selectors.c:1` | mapeia arquivo → linguagem | baixo |
| Consulta em arquivo ordenado | `libreadtags/readtags.h:179` | busca binária + filtro por campo | baixo |
| Campos configuráveis | `main/field.c` | liga/desliga linha, escopo, assinatura, tipo | baixo |
| `--extras=+q` (qualified) | `main/xtag.c` | nome qualificado (`Classe.metodo`) | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente. O análogo do loop é **selecionar parser → consumir tokens → emitir tag**:

- O parser recebe tokens de `read.c` e chama `makeTagEntry` a cada definição; não há
  construção de AST completa. Isso é o que faz o ctags ser rápido e raso.
- `promise.c` permite que um parser "devolva" o arquivo para outro parser (sub-linguagem),
  com conclusão assíncrona — o modelo de composição de parsers.
- A saída é escrita incrementalmente (`writeTagEntry` por tag), então o arquivo de tags é
  produzido em streaming; só a ordenação exige buffer (`main/sort.c`).
- Não há cancelamento, retry nem compactação de contexto. O "contexto" é o escopo
  (`scope`/`scopeKind`), não o código ao redor.

## 6. Sessões, estado e persistência

- O produto é o **arquivo `tags`**, texto ordenado por nome, com pseudo-tags no topo
  (`man/tags.5.rst.in:459-492`) que versionam o formato e o programa.
- `tagsSetSortType`/`tagsOpen` (`libreadtags/readtags.h:194`, `:179`) permitem consultar
  arquivo ordenado, não ordenado ou *foldcase* sem carregar tudo.
- `--append` (em `main/options.c`) permite atualização incremental por arquivo, mas não há
  invalidação automática: quem chama precisa saber o que mudou.
- Não há banco de dados, nem índice binário, nem estado de workspace.

## 7. Configuração e extensibilidade

- `.ctags.d/*.ctags` e `CTAGS_LIBEXEC_DIR` carregam optlibs; precedência em
  `main/options.c` e `docs/option-file.rst`.
- **Optlib é o mecanismo de extensão real**: uma linguagem nova é um arquivo de texto com
  `--langdef`, `--kinddef-<LANG>=<letra>,<nome>,<descrição>`, `--regex-<LANG>=/re/repl/kind/flags`
  e `--_mtable-regex-<LANG>=estado/re//{tenter=...}` — ver `optlib/cmake.ctags:42`, `:49`,
  `:77`.
- `--map-<LANG>`, `--langmap`, `--languages=+/-` controlam seleção; `--fields`, `--extras`,
  `--kinds-<LANG>` controlam conteúdo.
- Parsers em C podem ser gerados a partir de gramática PEG (`peg/`, packcc) — é assim que
  linguagens com sintaxe complexa entram.
- Não há plugins em processo, RPC ou MCP.

## 8. Permissões, sandbox e erros

- Não executa código do usuário. O risco é o oposto: um optlib mal escrito (regex
  catastrófico) trava a varredura; `main/lregex.c` tem limites de tabela/estado, mas não
  timeout por regex.
- Erros de parser vão para `main/error.c` e não abortam; a tag ruim é omitida.
- `main/seccomp.c` (81 linhas) existe para restringir syscalls em builds específicos — não é
  sandbox de plugin.
- Licença: **GPL-2.0** significa que código derivado precisa ser GPL-2.0. Para um app
  proprietário/MIT isso inviabiliza copiar `main/`, `parsers/` e `optlib/`. `libreadtags`
  é a exceção declarada (domínio público), mas ainda assim é C.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| `Tmain` | `Tmain/` (271 diretórios) | comportamento de CLI/opções por caso |
| `Units` | `Units/*.d` | saída de tags por arquivo de entrada |
| `libreadtags` | `libreadtags/tests/` | API de leitura, unescaping, ordenação |
| Fuzz | `misc/` (afl) | regex/optlib e parsers |
| Docs de teste | `docs/testing-ctags.rst`, `docs/testing-parser.rst` | como adicionar caso |

Modelo de teste exemplar: cada caso é um diretório com entrada + saída esperada,
comparável por `diff`. É o formato que deveríamos copiar para regras de código.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Formato JSON de tag (`_type`,`name`,`path`,`pattern`,`kind`,`scope`) | `man/ctags-json-output.5.rst.in:31-35`, `main/writer-json.c:46` | contrato simples, um objeto por linha, fácil de indexar | GPL-2.0 (formato; **não copiar código**) | `src/core/code-intelligence/tags-format.ts` | 15 |
| Pseudo-tags de cabeçalho (versão do formato + ordenação) | `man/tags.5.rst.in:477-492` | versiona o índice e evita ler arquivo incompatível | idem | idem | 13 |
| Modelo kind + role (definição vs referência) | `main/parse.c:203`, `main/kind.c` | permite "definições" e "usos" no mesmo índice | idem | `src/core/code-intelligence/symbols.ts` | 12 |
| Sistema de campos ligáveis | `main/field.c` | saída sob demanda, sem inflar o índice | idem | `src/core/code-intelligence/symbols.ts` | 9 |
| Optlib como DSL de parser por regex + estado | `optlib/cmake.ctags:42-93`, `main/lregex.c:133` | dá para suportar linguagem exótica sem binário | idem (DSL/ideia) | `src/core/code-intelligence/optlib.ts` (só se necessário) | 8 |
| Consulta em arquivo ordenado | `libreadtags/readtags.h:179-249` | busca sem carregar o índice inteiro | **public domain** | `src/core/code-intelligence/tags-reader.ts` | 10 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Qualquer arquivo de `main/`, `parsers/`, `optlib/` | **GPL-2.0** — copiar contamina o produto |
| 119 parsers em C | manutenção impossível para nós; melhor 5 linguagens bem feitas |
| `main/lregex.c` (3995 linhas) como base de parser | POSIX ERE + tabela de estados é um mundo à parte |
| `peg/` (packcc) | gerador de parser C; não usamos C para isso |
| `main/options.c` (120+ flags) | nosso contrato é schema de tool, não argv |
| Formato etags/xref | só editores legados consomem |

## 12. Modelo de exemplo para o nosso harness

O que faz sentido **não é** portar o ctags; é portar o **contrato de índice**:

- **Dependência/binário**: nenhum. Não distribuímos `ctags`.
- **Proibido por licença**: copiar `main/`, `parsers/` ou `optlib/` (GPL-2.0); só
  `libreadtags` é domínio público, e ainda assim é C.
- **Reimplementável em TS**: o formato de tag, o cabeçalho versionado e a consulta por
  nome — não os parsers.

1. **`symbols.ts`** devolve, por símbolo: `name`, `kind` (enum fechado), `role`
   (`definition` | `reference`), `path`, `range`, `scope` (nome qualificado),
   `signature` opcional, `language`. É a união do que `Tag` do ctags
   (`main/entry.c:1955`) e `OutlineEntry` do ast-grep entregam.
2. **Formato persistido**: JSON Lines com cabeçalho de versão
   (`{ "format": 1, "root": ..., "generatedAt": ... }`), no espírito das pseudo-tags
   (`man/tags.5.rst.in:477`). Sem ordenação obrigatória — nós indexamos em memória/SQLite.
3. **Consulta**: `findByName(prefix, { kind, role, limit })` com busca binária se o arquivo
   for ordenado (modelo `tagsFind`, `readtags.h:249`).
4. **Teste**: um arquivo por linguagem, 3 símbolos com escopo aninhado, comparar
   `name/kind/scope/line` — sem copiar saída do ctags como golden (licença), montando o
   esperado à mão.

## 13. Evidências da análise

```text
$ git -C ... rev-parse HEAD
82494361bb3e7d4f7cf1d2bdc0d0e9001c926e45

$ Get-Content COPYING -TotalCount 3
		    GNU GENERAL PUBLIC LICENSE
		       Version 2, June 1991

$ Get-Content libreadtags/readtags.h -TotalCount 4
/*
*   Copyright (c) 1996-2003, Darren Hiebert
*
*   This source code is released for the public domain.

$ (Get-ChildItem parsers -File -Filter *.c).Count
119

$ Select-String main/entry.c -Pattern "writeTagEntry|makeTagEntry"
1782: static void writeTagEntry (tagEntryInfo *const tag)
1955: extern int makeTagEntry (tagEntryInfo *const tag)

$ Select-String main/writer-json.c -Pattern "oformat"
57:  tagWriter jsonWriter = {
58:  	.oformat = "json",

$ Select-String docs/optlib.rst -Pattern "POSIX Extended"
73: Universal Ctags uses `the POSIX Extended Regular Expressions (ERE)
95: The POSIX Extended Regular Expressions (ERE) does

$ Get-Content man/ctags-json-output.5.rst.in (31-35)
{"_type": "ptag", "name": "JSON_OUTPUT_VERSION", "path": "1.0", "pattern": "in development"}
{"_type": "tag", "name": "Klass", "path": "/tmp/input.py", "pattern": "/^class Klass:$/", "language": "Python", ...}

$ (Get-ChildItem Tmain -Directory).Count
271
```
