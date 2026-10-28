# Chroma

| Campo | Valor |
|---|---|
| Repositório | https://github.com/chroma-core/chroma (`git remote get-url origin`) |
| Clone local | `repositorios/_research/memory/chroma-core--chroma` |
| Commit | `52ce8448cb38a498f1660d55ea80df25b78f000a` |
| Licença | Apache-2.0 (`LICENSE:1-2`) |
| Categoria | banco de vetores embutível + servidor distribuído |
| Stack | Python 3.9+, SQLite, hnswlib; Rust (frontend/segment/WAL) para o servidor; TypeScript/Go clients |
| Tamanho | 2.188 arquivos versionados; 1.345 fontes Python/Rust/TS/C/Go (~430 mil linhas); 236 arquivos de teste |

> Convenção de caminhos: caminhos sem prefixo são relativos a `chromadb/`
> (ex.: `api/models/Collection.py` = `chromadb/api/models/Collection.py`);
> `rust/...` e `LICENSE` são relativos à raiz do clone.

## 1. O que é (verificado no código)

Chroma é um banco de vetores com duas caras. A primeira é a biblioteca local:
`PersistentClient` grava em um diretório e usa SQLite + HNSW em processo
(`chromadb/__init__.py:201-230`; `chromadb/db/impl/sqlite.py:89`;
`chromadb/segment/impl/vector/local_persistent_hnsw.py:95-152`). A segunda é o
servidor Rust com frontend HTTP, WAL e segmentos distribuídos
(`rust/frontend/src/server.rs:273`). O cliente Python fala com o servidor por
FastAPI (`chromadb/__init__.py:262-309`).

O produto não extrai fatos, não deduplica semanticamente e não decide o que
esquecer: ele indexa o que o chamador mandar. O diferencial é a combinação de
**metadados filtráveis + full-text no mesmo SQLite + HNSW**, com uma API
pequena (`add`, `query`, `get`, `update`, `upsert`, `delete`) em
`chromadb/api/models/Collection.py:61-559`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `chromadb.PersistentClient(path=...)` | `chromadb/__init__.py:201` | abre/cria o banco local em disco |
| `chromadb.EphemeralClient()` | `chromadb/__init__.py:172` | banco em memória |
| `chromadb.HttpClient(...)` | `chromadb/__init__.py:262` | cliente do servidor |
| `chromadb.RustClient(path=...)` | `chromadb/__init__.py:233-259` | usa os bindings Rust (`chromadb.api.rust.RustBindingsAPI`) |
| `chroma` | `chromadb/cli/cli.py:36-43` | delega ao CLI Rust; `chroma update` checa releases |
| `docker compose up` | `docker-compose.yml` | servidor + dependências |
| `pytest` | `pyproject.toml` (dev) | suíte Python |

Superfície de coleção: `add` (`Collection.py:96`), `get` (`147`), `peek`
(`194`), `query` (`212`), `modify` (`299`), `fork` (`329`), `update` (`459`),
`upsert` (`515`), `delete` (`559`). O servidor expõe REST v2 por tenant/
database/collection (`rust/frontend/src/server.rs:343-360`).

## 3. Arquitetura e fluxo

```
cliente → Collection (valida ids/embeddings) → segmento
  ├─ metadata segment (SQLite: embeddings, metadata, FTS5)
  └─ vector segment (HNSW local ou Rust)
       → query: filtro SQL primeiro, KNN depois (ou o inverso)
```

- Entry point local: `chromadb/__init__.py:201` → `chromadb/api/client.py:76`.
- Escrita: `chromadb/api/models/CollectionCommon.py:209-249` (normaliza,
  valida, embeda se não veio embedding).
- Metadados/FTS: `chromadb/segment/impl/metadata/sqlite.py:111-221`
  (`get_metadata` junta `embeddings`, `embedding_metadata` e
  `embedding_fulltext_search`).
- Vetores: `chromadb/segment/impl/vector/local_persistent_hnsw.py:95-152`
  (carrega pickle + HNSW; `METADATA_FILE = "index_metadata.pickle"` na linha 96).
- Persistência: `chromadb/db/impl/sqlite.py:89`
  (`<persist_directory>/chroma.sqlite3`).
- Servidor: `rust/frontend/src/server.rs:273` (`run`), rotas em `343-360`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `add` | `chromadb/api/models/Collection.py:96` | insere registros; embeda se necessário | baixo |
| `upsert` | `Collection.py:515` | cria/atualiza por **ID** | baixo |
| `query` | `Collection.py:212` | KNN denso + `where`/`where_document` | baixo |
| `get` | `Collection.py:147` | leitura por id ou filtro; exige um dos dois | baixo |
| `delete` | `Collection.py:559` | por id ou filtro de metadados | médio (irreversível) |
| `fork` | `Collection.py:329` | cópia de coleção — **só hosted** (`:334`) | baixo |
| Filtro de metadados | `chromadb/base_types.py:128-149` | `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$contains/$and/$or` | baixo |
| Filtro de documento | `base_types.py:151-158` | `$contains/$not_contains/$regex/$not_regex/$and/$or` sobre FTS | médio (regex) |
| HNSW configurável | `chromadb/api/types.py:1625-1648` | `ef_construction`, `max_neighbors`, `ef_search`, `batch_size` | baixo |
| Índice FTS | `chromadb/api/types.py:1615-1623` | configuração de full-text por coleção | baixo |
| Índice esparso/BM25 | `chromadb/api/types.py:1736-1795`; `chromadb/utils/embedding_functions/bm25_embedding_function.py:19-65` | vetores esparsos com BM25 | baixo |
| Busca híbrida com RRF | `chromadb/execution/expression/operator.py:1043-1180` | `Knn`, `Rrf`, expressões de rank | experimental |
| `Search` API | `chromadb/api/models/Collection.py:368-374` | híbrido — **só distributed/hosted** | experimental |

## 5. Loop do agente, contexto e streaming

Não há loop de agente. O fluxo de uma query local é:

1. `CollectionCommon._validate_and_prepare_query_request` valida `n_results`,
   `where` e `where_document` (`CollectionCommon.py:295-356`).
2. O segmento de metadados resolve o filtro no SQLite
   (`chromadb/segment/impl/metadata/sqlite.py:162-198`), inclusive full-text
   (`:184-190`).
3. O segmento vetorial faz KNN com `allowed_ids` (filtro do hnswlib)
   (`chromadb/segment/impl/vector/local_hnsw.py:134-166`; HNSW em
   `rust/index/src/hnsw.rs:215-281`).
4. O resultado é montado com `ids`, `documents`, `metadatas`, `distances` e
   `embeddings` conforme `include` (`CollectionCommon.py:511-547`).

Não há prompt, compactação, cancelamento, retry ou streaming de tokens. O
"contexto" é responsabilidade do cliente.

## 6. Sessões, estado e persistência

- Local: um arquivo `chroma.sqlite3` no `persist_directory`
  (`chromadb/db/impl/sqlite.py:89`), com migrações versionadas
  (`chromadb/db/migrations.py`; tabela `migrations` em `chromadb/db/impl/sqlite.py:169-181`).
- Índice vetorial: pasta por segmento com `index_metadata.pickle` e arquivos
  do hnswlib (`chromadb/segment/impl/vector/local_persistent_hnsw.py:96,201-243`).
  O pickle é lido com `SafeUnpickler` restrito a classes conhecidas
  (`:43-59`), mitigando CWE-502.
- Escrita: `_persist_data` é salvo após `_sync_threshold`; o índice é
  reaberto no startup (`chromadb/segment/impl/vector/local_persistent_hnsw.py:116-152`).
- Não há sessão, fork local, checkpoint ou TTL. `fork` é hosted
  (`Collection.py:334`).
- **Proveniência**: só `metadatas` livres por registro (`Collection.py:96-146`);
  não há campo de confiança, evidência ou origem.
- Servidor: WAL3 e segmentos em `rust/wal3/src/` e `rust/segment/src/`; o
  frontend Rust mantém o estado autoritativo (`rust/frontend/src/server.rs:273`).

## 7. Configuração e extensibilidade

- `Settings` (`chromadb/config.py:159-227`): `is_persistent`,
  `persist_directory`, `allow_reset`, `anonymized_telemetry`,
  `chroma_api_impl`.
- Embedding functions: interface `EmbeddingFunction` + dezenas de provedores
  em `chromadb/utils/embedding_functions/` (OpenAI, Cohere, Ollama, HF, ONNX
  MiniLM, Jina, Voyage, BM25 esparso etc.). Default é ONNX MiniLM
  (`CollectionCommon.py:122-128`).
- Schema por coleção: `Schema`, `HnswIndexConfig`, `SpannIndexConfig`,
  `FtsIndexConfig`, `SparseVectorIndexConfig` (`chromadb/api/types.py:1615-1795`).
- Auth: token, basic e RBAC simples (`chromadb/auth/`), com `AuthzAction` no
  servidor Rust (`rust/frontend/src/server.rs:484-520`).
- Hooks/plugins/MCP: **não encontrado**.

## 8. Permissões, sandbox e erros

- `allow_reset=False` por padrão; `reset()` levanta erro se não habilitado
  (`chromadb/config.py:165,478-480`).
- Duplicatas de ID na mesma requisição são rejeitadas com `DuplicateIDError`
  (`chromadb/api/types.py:1029-1046`; `errors.py:56-60`). Não há dedup
  semântica: o contrato é por ID (`add` vs `upsert`).
- Validação de `include` e de filtros antes de ir ao store
  (`CollectionCommon.py:274-290`).
- Erros são mapeados por classe (`chromadb/errors.py:1-181`); o servidor
  devolve 4xx/5xx tipados (`rust/frontend/src/server.rs:2036-2178`).
- Telemetria PostHog **ligada por padrão** (`chromadb/config.py:227`).
- Não há sandbox de conteúdo nem defesa contra instruções embutidas em
  documentos; o banco só armazena.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| API | `chromadb/test/test_api.py`, `test_chroma.py` | add/query/get/delete, filtros, persistência |
| cliente | `chromadb/test/test_client.py` | criação, tenant/database, settings |
| config | `chromadb/test/test_config.py` | `Settings` e ambiente |
| CLI | `chromadb/test/test_cli.py` | `chroma update` |
| concorrência | `chromadb/test/test_multithreaded.py` | acesso concorrente ao SQLite |
| propriedades | `chromadb/test/property/` | estratégias Hypothesis para filtros e embeddings |
| Rust | `rust/*/tests`, `rust/frontend` | WAL, segmentos, frontend |

A suíte é grande, mas o caminho híbrido `Search` é explicitamente experimental
e restrito a hosted/distributed (`Collection.py:373-374`). Para nós, o que
importa é o **formato do índice local** e o filtro SQL, não o servidor.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| RRF para fundir rankings | `chromadb/execution/expression/operator.py:1145-1180` | fusão determinística, sem calibrar scores entre índices | Apache-2.0 | `src/core/memory/fusion.ts` | 12 |
| Gramática de filtro de metadados | `chromadb/base_types.py:128-158` | operadores claros e testáveis para filtrar memória | Apache-2.0 | `src/core/memory/query.ts` | 9 |
| Índice local SQLite + HNSW | `chromadb/db/impl/sqlite.py:89`; `chromadb/segment/impl/vector/local_persistent_hnsw.py:95-152` | prova de que dá para ter ANN local sem servidor | Apache-2.0 | `src/core/memory/local-index.ts` | 8 |
| FTS no mesmo SQLite | `chromadb/segment/impl/metadata/sqlite.py:124-198` | combina metadado e full-text sem outro banco | Apache-2.0 | `src/core/memory/index.ts` | 7 |
| `upsert` por id | `chromadb/api/models/Collection.py:515` | semântica simples de atualização | Apache-2.0 | `src/core/memory/store.ts` | 5 |
| Fork de coleção | `chromadb/api/models/Collection.py:329` | snapshot barato para experimentos | Apache-2.0 | — (só hosted) | 3 |

**O que falta na nossa memória:** não temos índice vetorial nem um índice
lexical persistente com filtros estruturados. O `index.json` é reconstruído do
markdown (`src/core/memory/project.ts:189-223`) e a busca é `includes()` sobre
título/tags/termos (`project.ts:379-399`). O Chroma mostra o desenho que
falta: **um store local com três vistas do mesmo registro** — texto,
metadados e vetor — e filtro antes do KNN.

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Servidor Rust/distribuído | complexidade desproporcional para um app desktop |
| `Search`/RRF como API pública | experimental e só hosted; podemos implementar a fusão em 40 linhas |
| SPANN / quantização | só faz sentido em escala de milhões |
| `fork` | hosted-only; nosso snapshot pode ser cópia de diretório |
| ONNX MiniLM como default | 80 MB de modelo embutido; precisamos de embedding plugável e leve |
| Telemetria PostHog | ligada por padrão |
| Dependência de hnswlib | binário nativo por plataforma; Electron já sofre com isso |

## 12. Modelo de exemplo para o nosso harness

1. **Um registro, três índices.** Cada página/fato da wiki vira uma linha
   `{id, projectId, text, metadata, vector}`. O markdown continua sendo a
   fonte da verdade; o índice é derivado e reconstruível, como já acontece
   (`project.ts:161-207`).
2. **Filtro primeiro, KNN depois.** Aplicar `projectId`, `status`,
   `memoryType`, `confidence` e `expiresAt` no índice lexical/SQL antes de
   calcular similaridade. Isso evita o erro clássico de buscar globalmente e
   filtrar depois, que vaza memória entre projetos.
3. **Fusão por RRF, não por soma crua.** Dois rankings (lexical e vetorial)
   com `k=60` (ou 2, como o Qdrant) são suficientes; RRF não exige calibrar
   escalas. Guardar `score_details` para auditoria.
4. **Atualização idempotente.** `writePage` já usa slug derivado do título
   (`project.ts:250-251`). Acrescentar `contentHash` no frontmatter para que
   reindexar não reembede conteúdo idêntico.
5. **Sem servidor.** O índice pode ser um arquivo binário ou SQLite; o app
   não deve abrir porta. O sidecar AI-Memory já cobre FTS5
   (`src/main/ai-memory.ts:12`); o que falta é o vetor.
6. **Como testar.** Índice com 3 projetos, query em um só, assert de que
   nenhum id de outro projeto aparece; filtro `status=invalidated` não volta;
   reindexação do mesmo conteúdo não duplica.

## 13. Evidências da análise

```text
git -C repositorios/_research/memory/chroma-core--chroma rev-parse HEAD
  → 52ce8448cb38a498f1660d55ea80df25b78f000a

chromadb/__init__.py:3            __version__ = "1.6.0"
chromadb/__init__.py:201-224      PersistentClient → persist_directory + is_persistent
chromadb/db/impl/sqlite.py:89     self._db_file = ... + "/chroma.sqlite3"
chromadb/segment/impl/metadata/sqlite.py:124-126
  embeddings_t, metadata_t, fulltext_t = Tables("embeddings", "embedding_metadata", "embedding_fulltext_search")
chromadb/api/models/Collection.py:373-374
  "This is an experimental API that only works for distributed and hosted Chroma for now."
chromadb/api/models/Collection.py:334
  "This only works for Hosted Chroma for now."
chromadb/base_types.py:131-145    operadores $gt/$gte/$lt/$lte/$ne/$eq/$in/$nin/$contains
chromadb/config.py:227            anonymized_telemetry: bool = True
rust/index/src/hnsw.rs:22-26      m, ef_construction, ef_search
```

Leituras: `chromadb/api/models/Collection.py`, `CollectionCommon.py`,
`base_types.py`, `config.py`, `chromadb/db/impl/sqlite.py`,
`chromadb/segment/impl/metadata/sqlite.py`, `chromadb/segment/impl/vector/local_persistent_hnsw.py`,
`execution/expression/operator.py`, `rust/frontend/src/server.rs`,
`rust/index/src/hnsw.rs`, `chromadb/test/*`.
