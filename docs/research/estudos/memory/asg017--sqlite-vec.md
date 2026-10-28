# sqlite-vec

| Campo | Valor |
|---|---|
| Repositório | https://github.com/asg017/sqlite-vec (`git remote get-url origin`) |
| Clone local | `repositorios/_research/memory/asg017--sqlite-vec` |
| Commit | `04d28bd21773981e2d266bbf6aa4efbd011eb4f6` |
| Licença | MIT ou Apache-2.0, à escolha (`LICENSE-MIT:1-3`, `LICENSE-APACHE:1-2`) |
| Categoria | extensão SQLite de busca vetorial (biblioteca nativa) |
| Stack | C99/SQLite virtual table API, SIMD AVX/NEON, bindings Python/Go/Rust; sem Node |
| Tamanho | 325 arquivos versionados; 108 fontes C/Python/Rust/Go (~31 mil linhas); 34 arquivos de teste |

## 1. O que é (verificado no código)

`sqlite-vec` não é um banco: é uma **extensão carregável do SQLite** que
registra funções (`vec_f32`, `vec_distance_*`) e duas virtual tables, `vec0` e
`vec_each` (`sqlite-vec.c:10632-10705`). O `vec0` guarda vetores em tabelas
sombra e responde `WHERE embedding MATCH ? AND k = ?`
(`sqlite-vec.c:6012-6146`; `site/features/knn.md:26-33`). O `vec_each` itera
os vetores de uma linha — útil para chunking/inspeção
(`sqlite-vec.c:3220-3298`).

O projeto é pré-1.0 (`VERSION:1`, `0.1.10-alpha.4`; o README avisa "expect
breaking changes" em `README.md:11`). Não há extração de fatos, embeddings, dedup, atualização
semântica, esquecimento, proveniência ou RAG. É o **tijolo de índice** que
falta na nossa wiki, não uma camada de memória.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `make loadable` | `Makefile:75` | compila `vec0.dll`/`.so`/`.dylib` |
| `make static` | `Makefile:76` | biblioteca estática para embutir no SQLite |
| `make cli` | `Makefile:77` | CLI de teste (`sqlite-vec`) |
| `make test` | `Makefile:188` | pytest + unittest.rs + wasm |
| `.load ./vec0` | `README.md:68-70` | carrega a extensão no SQLite |
| `create virtual table ... using vec0(...)` | `site/features/vec0.md:6-22` | define tabela vetorial |
| `where embedding match ? and k = 10` | `site/features/knn.md:26-33` | KNN |
| `vec_each(?)` | `sqlite-vec.c:3220` | itera vetores de uma linha |

Superfície SQL: `vec_version()`, `vec_debug()`, `vec_f32/vec_int8/vec_bit`,
`vec_length`, `vec_distance_l2/l1/cosine/hamming`, `vec_normalize`,
`vec_slice`, `vec_add/sub`, `vec_quantize_*` (`sqlite-vec.c:10641-10694`).
Não há CLI de aplicação, subcomandos ou flags de memória.

## 3. Arquitetura e fluxo

```
SQLite → vec0 virtual table (xBestIndex lê MATCH + k + filtros)
      → vec0Filter_knn (cursor)
          → por chunk: distância de cada vetor + top-k local
          → merge dos top-k dos chunks → top-k global
      → xColumn devolve rowid, distance, metadados
```

- Entry point: `sqlite3_vec_init` (`sqlite-vec.c:10632`), registro do módulo
  em `:10705`.
- Construção do plano: `vec0BestIndex` (`sqlite-vec.c:6012`), que codifica o
  plano no `idxStr` (`VEC0_IDXSTR_KIND_*`, `:5953-5967`).
- Execução KNN: `vec0Filter_knn_chunks_iter` (`sqlite-vec.c:7238`), que faz
  top-k por chunk e reconcilia (`:7238-7260`).
- Distâncias: `vec0_distance_full` (`sqlite-vec.c:2543-2570`).
- Persistência: tabelas sombra do próprio SQLite (`ARCHITECTURE.md:15-45`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `vec0` KNN | `sqlite-vec.c:6012-6146` | `MATCH` + `k` com distância | baixo |
| Metadados filtráveis | `sqlite-vec.c:2388-2443` | bool/int/float/text no `WHERE` do KNN | baixo |
| Partition key | `sqlite-vec.c:2242-2320`, `3471` | sharda o índice por chave (ex.: projeto) | baixo |
| Auxiliary columns | `site/features/vec0.md:14-24` | texto sem JOIN, fora do filtro | baixo |
| `vec_each` | `sqlite-vec.c:3220-3374` | itera vetores por linha | baixo |
| Distância L2/L1/cosseno/hamming | `sqlite-vec.c:2532-2570` | float32, int8, bit | baixo |
| Rescore quantizado | `sqlite-vec.c:2576-2834` | busca em bit/int8 e reavalia em float | médio (memória) |
| DiskANN | `sqlite-vec-diskann.c`; `sqlite-vec.c:7651` | grafo ANN em disco (build default) | experimental |
| IVF | `sqlite-vec-ivf.c`, `sqlite-vec-ivf-kmeans.c` | clusters invertidos (build flag) | experimental |
| Chunk size | `sqlite-vec.c:4906-4916` | `chunk_size=N` no `CREATE` | baixo |

Limites: 16 colunas vetoriais, 4 partition keys, 16 auxiliary, 16 metadata,
8.192 dimensões (`sqlite-vec.c:3470-3475`).

## 5. Loop do agente, contexto e streaming

Não há loop de agente. O fluxo de uma consulta é o `xBestIndex`:

1. O SQLite passa as restrições disponíveis (`embedding MATCH ?`, `k = ?`,
   `rowid IN (...)`, `partition = ?`, `metadata > ?`).
2. `vec0BestIndex` escolhe o plano e monta o `idxStr`; se não houver `MATCH`,
   o plano é full scan (`ARCHITECTURE.md:51-57`).
3. `vec0Filter_knn_chunks_iter` abre o blob de vetores por chunk, calcula
   distâncias e mantém top-k local; ao final, reconcilia os chunks
   (`sqlite-vec.c:7238-7260`).
4. `xColumn` devolve `distance`, `k` e as colunas pedidas.

Não há streaming (o resultado é um cursor), cancelamento (usa
`sqlite3_interrupt` do host), retry ou orçamento de contexto.

## 6. Sessões, estado e persistência

- Tudo vive no arquivo SQLite do host; não há arquivo próprio, serviço ou
  diretório.
- `vec0` cria tabelas sombra: `_chunks`, `_rowids`, `_vector_chunksNN`,
  `_auxiliary`, `_metadatachunksNN`, `_metadatatextNN`
  (`ARCHITECTURE.md:15-45`).
- Escrita: `vec0Update_Insert` (`sqlite-vec.c:9169`), delete
  `vec0Update_Delete` (`:9880`) e limpeza de chunk vazio
  (`sqlite-vec.c:4703`).
- Não há WAL próprio: herda o journal do SQLite. Não há sessão, fork,
  checkpoint, TTL ou versão de schema (além do `user_version` do host).
- O `rowid` é a identidade; `INTEGER PRIMARY KEY` do `vec0` mapeia para ele
  (`site/features/knn.md:15-20`).
- **Proveniência**: só as colunas de metadados definidas no `CREATE`
  (`sqlite-vec.c:2388-2443`); não há confiança, evidência ou origem.

## 7. Configuração e extensibilidade

- Configuração é o `CREATE VIRTUAL TABLE`: tipo do vetor (`float[N]`,
  `int8[N]`, `bit[N]`), `chunk_size`, `partition key`, colunas `+aux`,
  metadados e `distance_metric` (`site/features/vec0.md`).
- `INDEXED BY rescore(quantizer=bit, oversample=8)` para busca quantizada
  (`sqlite-vec.c:2731-2834`).
- Features de compilação: `SQLITE_VEC_ENABLE_AVX`, `NEON`,
  `SQLITE_VEC_ENABLE_RESCORE` (`Makefile:35-60`; `sqlite-vec.c:2576`).
- Extensibilidade real: carregar a extensão em qualquer SQLite; bindings
  Python/Go/Rust em `bindings/`. **Não há binding Node/Electron neste repo**
  (`Get-ChildItem bindings` → `go`, `python`, `rust`).
- Sem hooks, plugins, MCP ou agentes.

## 8. Permissões, sandbox e erros

- Não há permissões: a extensão roda no processo do host e tem os mesmos
  privilégios do arquivo SQLite.
- Validação de dimensão: `ensure_vector_match` (`sqlite-vec.c:1297-1346`) e
  `validate_vector` no índice.
- Erros voltam como `sqlite3_result_error` / `pzErr` com mensagem textual
  (`sqlite-vec.c:867-888`); não há códigos tipados além dos do SQLite.
- Limites de colunas/dimensão são checados no `CREATE`
  (`sqlite-vec.c:3470-3475`).
- Como toda extensão C, um bug de memória é execução arbitrária no processo.
  Isso é um risco de supply chain, não uma feature de sandbox.
- Conteúdo é opaco: não há defesa contra prompt injection em texto.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| geral | `tests/test-general.py` | create/insert/select, erros |
| KNN | `tests/test-knn-distance-constraints.py` | `MATCH`+`k`, distâncias |
| metadados | `tests/test-metadata.py` | 16 colunas, filtros, shadow tables |
| partição | `tests/test-partition-keys.py` | 4 keys, isolamento |
| insert/delete | `tests/test-insert-delete.py` | rowid, chunk vazio |
| rename | `tests/test-rename.py` | rename de tabela/coluna |
| rescore | `tests/test-rescore.py`, `test-rescore-mutations.py` | quantização bit/int8 |
| DiskANN | `tests/test-diskann.py` | grafo ANN |
| IVF | `tests/test-ivf*.py` | kmeans, mutações, quantização |
| C | `tests/test-unit.c` | funções de distância |
| wasm | `tests/test-wasm.mjs` | build WASM |
| fuzz | `tests/fuzz.py` | parsing de vetores |

A cobertura é boa para uma extensão C, incluindo snapshots de shadow tables
(`test-metadata.py:1-50`). O que não existe é teste de "memória": o projeto
não tem essa camada.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `vec0` com partition key | `sqlite-vec.c:2242-2320`, `3471` | isola projeto no próprio índice, não no `WHERE` | MIT/Apache-2.0 | `src/core/memory/vec-index.ts` | 14 |
| Chunked storage + merge top-k | `sqlite-vec.c:7238-7260` | memória constante e I/O sequencial | MIT/Apache-2.0 | `src/core/memory/vec-index.ts` | 11 |
| Metadados no KNN | `sqlite-vec.c:2388-2443` | filtra tipo/status sem pós-processar | MIT/Apache-2.0 | `src/core/memory/query.ts` | 8 |
| Rescore bit/int8 | `sqlite-vec.c:2576-2834` | reduz memória sem perder recall | MIT/Apache-2.0 | — (só em escala) | 5 |
| `vec_each` | `sqlite-vec.c:3220-3374` | itera chunks de uma página | MIT/Apache-2.0 | `src/core/memory/chunk.ts` | 4 |

**O que falta na nossa memória:** um índice vetorial local, sem servidor, com
isolamento por projeto. Hoje o `ProjectMemory` tem diretório por projeto
(`src/core/memory/project.ts:136-140`), mas a busca é lexical
(`project.ts:379-399`). O `sqlite-vec` mostra o caminho: **partition key =
projectId** e metadados (`status`, `type`) no próprio `WHERE` do KNN. Isso
evita o vazamento entre projetos que um índice global com filtro posterior
permitiria.

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| C/SIMD e virtual table | reimplementar em C no Electron é risco de crash e build por plataforma |
| DiskANN/IVF | experimentais e desproporcionais para milhares de páginas |
| Rescore quantizado | complexidade sem ganho no nosso tamanho |
| Falta de binding Node | exigiria escrever um binding ou carregar `.dll` manualmente |
| `vec_each` como API pública | é detalhe interno; podemos fatiar no JS |
| Ausência de versão/schema | pré-1.0; não é modelo de durabilidade |

## 12. Modelo de exemplo para o nosso harness

1. **Se formos usar SQLite, usar o desenho do `vec0`.** Tabela
   `memory_vectors(project_id TEXT, page_slug TEXT, chunk_no INT, vector BLOB,
   dim INT, status TEXT, type TEXT, updated TEXT)` com índice por
   `(project_id, status)`. O `project_id` é a partition key lógica: toda query
   começa por ele. **Cuidado:** a doc do `vec0` recomenda centenas de vetores
   por valor de partition key (`site/features/vec0.md:18-24`); com projetos
   pequenos, é melhor um filtro de metadado do que uma partição física.
2. **Chunking antes do vetor.** Uma página de 60 KB (`project.ts:122`) não
   cabe em um embedding útil. Cortar em seções de ~512 tokens com overlap de
   64, guardar `page_slug + chunk_no` e manter o markdown como fonte.
3. **Merge top-k por chunk.** Consultar cada chunk e reconciliar por
   `distance`; nunca concatenar tudo e embeddar de novo.
4. **Metadados no filtro.** `status='active'`, `type IN (...)`,
   `confidence >= 'inferred'` e `updated >= ?` entram no SQL, não no pós.
5. **Sem dependência nativa obrigatória.** O índice pode ser um arquivo JSON
   binário ou um SQLite comum com vetores serializados; a extensão é uma
   otimização opcional, não um requisito de boot.
6. **Como testar.** Dois projetos com textos idênticos; query em A não pode
   retornar B. Chunk de 10 KB com overlap não pode duplicar o mesmo trecho no
   top-3. Deletar uma página remove todos os chunks.

## 13. Evidências da análise

```text
git -C repositorios/_research/memory/asg017--sqlite-vec rev-parse HEAD
  → 04d28bd21773981e2d266bbf6aa4efbd011eb4f6

VERSION:1                       0.1.10-alpha.4
sqlite-vec.c:10632              SQLITE_VEC_API int sqlite3_vec_init(...)
sqlite-vec.c:10705              sqlite3_create_module_v2(db, aMod[i].name, ...)
sqlite-vec.c:6012               static int vec0BestIndex(...)
sqlite-vec.c:7238               int vec0Filter_knn_chunks_iter(...)
sqlite-vec.c:3470-3475          16 vector cols, 4 partition, 16 aux, 16 metadata, 8192 dims
sqlite-vec.c:2532-2536          L2 / COSINE / L1 (+ HAMMING em 2570)
sqlite-vec.c:2576-2582          SQLITE_VEC_ENABLE_RESCORE / quantizer bit|int8
ARCHITECTURE.md:15-45           shadow tables _chunks/_rowids/_vector_chunksNN/...
site/features/vec0.md:14-24     metadata vs auxiliary vs partition key
```

Leituras: `sqlite-vec.c` (10.700+ linhas), `ARCHITECTURE.md`,
`site/features/knn.md`, `site/features/vec0.md`, `Makefile`,
`tests/test-metadata.py`, `tests/test-partition-keys.py`,
`tests/test-knn-distance-constraints.py`.
