# LlamaIndex

| Campo | Valor |
|---|---|
| Repositório | https://github.com/run-llama/llama_index (`git remote get-url origin`) |
| Clone local | `repositorios/_research/memory/run-llama--llama_index` |
| Commit | `619d74664e8404612038bc15a1a40c686037277c` |
| Licença | MIT (`LICENSE:1-3`, `llama-index-core/pyproject.toml:42`) |
| Categoria | framework de RAG / indexação / memória de conversa |
| Stack | Python ≥3.10, Pydantic v2, SQLAlchemy async, hatch; 2.969 fontes Python em integrações |
| Tamanho | 9.798 arquivos versionados; `llama-index-core` com 737 fontes Python (~114 mil linhas); 1.036 arquivos de teste |

> Convenção de caminhos: caminhos sem prefixo são relativos a
> `llama-index-core/llama_index/core/` (ex.: `memory/memory.py` =
> `llama-index-core/llama_index/core/memory/memory.py`); `tests/...` é
> relativo a `llama-index-core/tests/`; `LICENSE` é relativo à raiz do clone.

## 1. O que é (verificado no código)

LlamaIndex é um framework de RAG em camadas: leitores → node parsers →
índices → retrievers → response synthesizers, com um subsistema de memória de
conversa. Não é um banco nem um agente pronto; é a "cola" entre documentos,
embeddings e LLMs.

Para nós, interessam três partes que o núcleo entrega:

1. **Memória em blocos com orçamento de tokens** (`Memory`, 
   `llama-index-core/llama_index/core/memory/memory.py:188-200`).
2. **Ingestão com dedup por hash de documento** (`IngestionPipeline`,
   `llama-index-core/llama_index/core/ingestion/pipeline.py:242-262,451-507`).
3. **Chunking + retriever hierárquico** (`SentenceSplitter`,
   `HierarchicalNodeParser`, `AutoMergingRetriever`).

A qualidade do núcleo está nos detalhes de orçamento de tokens e nas relações
`PREVIOUS/NEXT/PARENT` dos nós
(`llama-index-core/llama_index/core/schema.py:207-310`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pip install llama-index-core` | `llama-index-core/pyproject.toml:36-42` | instala o núcleo |
| `Memory.from_defaults(...)` | `memory/memory.py:288-341` | memória com blocos |
| `SentenceSplitter(...)` | `node_parser/text/sentence.py:34-115` | chunking por frase/token |
| `VectorStoreIndex.from_documents(...)` | `indices/base.py:89` | indexa documentos |
| `IngestionPipeline(...).run(...)` | `ingestion/pipeline.py:539` | transforma + dedup + persiste |
| `pipeline.persist(...)` / `StorageContext.persist(...)` | `ingestion/pipeline.py:374`; `storage/storage_context.py:151` | grava docstore/índice no disco |
| `python -m pytest` | `llama-index-core/tests/` | suíte do núcleo |

Superfície: `Memory`, `ChatMemoryBuffer`, `ChatSummaryMemoryBuffer`,
`SimpleComposableMemory`, `VectorMemory`, `FactExtractionMemoryBlock`,
`VectorMemoryBlock`, `StaticMemoryBlock` (`memory/__init__.py:1-25`).
Chunkers: `TokenTextSplitter`, `SentenceSplitter`, `SemanticSplitterNodeParser`,
`SemanticDoubleMergingSplitterNodeParser`, `CodeSplitter`,
`HierarchicalNodeParser`, `SentenceWindowNodeParser`, `MarkdownNodeParser`
(`node_parser/__init__.py:1-69`).

## 3. Arquitetura e fluxo

```
Document → NodeParser (chunk + metadata + relações) → IngestionPipeline
  → docstore (hash) → vector store → Index
Query → Retriever (dense/fusion/auto-merge) → Postprocessor
  → ResponseSynthesizer → resposta + source_nodes
```

- Entry point de memória: `memory/memory.py:188` (`class Memory`).
- Ingestão: `ingestion/pipeline.py:262` (`IngestionPipeline`), dedup em
  `:451-507`.
- Índice vetorial: `indices/vector_store/base.py:36`; retriever em
  `indices/vector_store/retrievers/retriever.py:24-141`.
- Chunking: `node_parser/text/sentence.py:34-115`.
- Persistência: `storage/storage_context.py:151-195`;
  `storage/docstore/simple_docstore.py:43-91`.
- Relações de nó: `schema.py:207-310`; `source_node`/`ref_doc_id` em
  `schema.py:391-456`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `Memory` com FIFO + waterfall | `memory/memory.py:188-200,672-809` | ejeta turnos antigos para blocos | baixo |
| Blocos com prioridade | `memory/memory.py:103-186` | `priority=0` nunca trunca; os demais são cortados | baixo |
| `FactExtractionMemoryBlock` | `memory/memory_blocks/fact.py:74-167` | extrai fatos por LLM e condensa ao passar de `max_facts` | médio (custo) |
| `VectorMemoryBlock` | `memory/memory_blocks/vector.py:33-174` | embeda mensagens e recupera top-k por sessão | médio |
| `StaticMemoryBlock` | `memory/memory_blocks/static.py` | texto fixo no prompt | baixo |
| `ChatSummaryMemoryBuffer` | `memory/chat_summary_memory_buffer.py:26-40` | sumariza o histórico antigo (deprecated) | médio |
| `SentenceSplitter` | `node_parser/text/sentence.py:34-115` | chunk por parágrafo/frase/token com overlap | baixo |
| `SemanticSplitterNodeParser` | `node_parser/text/semantic_splitter.py:35-73` | quebra por dissimilaridade de embeddings | médio (custo) |
| `HierarchicalNodeParser` | `node_parser/relational/hierarchical.py:76-127` | chunks 2048/512/128 com parent/child | baixo |
| `IngestionPipeline` | `ingestion/pipeline.py:262-507` | transforma, deduplica por hash e faz upsert | baixo |
| `QueryFusionRetriever` | `retrievers/fusion_retriever.py:24-41,113-213` | gera N queries e funde (RRF/simple/dist) | médio |
| `AutoMergingRetriever` | `retrievers/auto_merging_retriever.py:26-92` | sobe para o pai quando muitos filhos batem | baixo |
| `SimilarityPostprocessor` | `postprocessor/node.py:70-108` | corta por `similarity_cutoff` | baixo |
| Recência | `postprocessor/node_recency.py:40-163` | prioriza mensagens recentes | baixo |
| `StorageContext.persist` | `storage/storage_context.py:151-195` | grava docstore, index store e vetores | baixo |

## 5. Loop do agente, contexto e streaming

LlamaIndex não tem loop de agente; tem **montagem de contexto** e **síntese**.

**Memória.** `Memory.aget()` lê a fila ativa do SQLAlchemy chat store
(`memory/memory.py:629-634`), coleta os blocos em ordem de prioridade
(`:446-479`), trunca o que não cabe (`:481-544`) e injeta no system message ou
na última mensagem do usuário (`:574-622`). A fila é gerenciada por
`_manage_queue` (`:672-809`): quando passa de `token_limit *
chat_history_token_ratio`, remove os turnos mais antigos em lotes de
`token_flush_size`, preserva um turno completo (user + assistant/tool) e
arquiva o resto (`:781-797`). Isso é exatamente o "waterfall" que falta no
nosso `brief()`.

**Chunking.** `SentenceSplitter` combina `split_by_sep(paragraph_separator)`,
tokenizer de frases e regex secundária (`sentence.py:101-115`). O
`SemanticSplitterNodeParser` calcula similaridade entre sentenças e corta no
percentil configurado (`semantic_splitter.py:35-73,173-180`). O hierárquico
cria três níveis e relações parent/child (`hierarchical.py:76-127`).

**Recuperação.** `VectorIndexRetriever` monta `VectorStoreQuery` com modo,
filtros, `doc_ids`/`node_ids` e `similarity_top_k`
(`indices/vector_store/retrievers/retriever.py:130-144`). O
`QueryFusionRetriever` gera queries extras por LLM e funde por RRF, score
relativo ou soma simples (`fusion_retriever.py:113-213`).

**Streaming.** Fica nos LLMs e no `ResponseSynthesizer`; a memória em si é
síncrona/async, sem streaming de tokens. Cancelamento: não encontrado no
núcleo da memória; depende do LLM.

## 6. Sessões, estado e persistência

- **Fila curta**: `SQLAlchemyChatStore` com tabela `{table_name}` e colunas
  `key`, `timestamp`, `message`, `status` (`storage/chat_store/sql.py:93-169`).
  `MessageStatus.ACTIVE` vs `ARCHIVED` (`storage/chat_store/base_db.py:9-18`):
  arquivar não apaga, só sai da fila ativa.
- **Blocos**: `FactExtractionMemoryBlock.facts` é uma lista em memória; não é
  persistida pelo `Memory` automaticamente. `VectorMemoryBlock` persiste no
  vector store escolhido.
- **Docstore**: `SimpleDocumentStore` grava JSON em `docstore.json`
  (`storage/docstore/simple_docstore.py:20-91`); `StorageContext.persist`
  grava `docstore.json`, `index_store.json` e os vector stores
  (`storage/storage_context.py:151-195`).
- **Relações**: cada nó tem `SOURCE`, `PREVIOUS`, `NEXT`, `PARENT`, `CHILD`
  (`schema.py:207-310`); `ref_doc_id` liga o chunk ao documento
  (`schema.py:451-456`). Metadados e `excluded_embed_metadata_keys`/
  `excluded_llm_metadata_keys` controlam o que entra no embedding e no prompt
  (`schema.py:294-316`).
- Não há fork, checkpoint transacional nem versionamento de schema. A
  persistência é "gravar arquivos JSON" (`SimpleKVStore`), sem WAL.

## 7. Configuração e extensibilidade

- `Settings` global (LLM, embed model, node parser, callback manager) +
  `StorageContext` explícito. Não há arquivo de config canônico; é código.
- Integrações: 2.969 fontes Python em `llama-index-integrations/` (LLMs,
  embeddings, vector stores, readers, tools). Cada uma é um pacote separado.
- Extensibilidade real: subclasses de `BaseMemoryBlock`, `NodeParser`,
  `BaseRetriever`, `BaseNodePostprocessor`, `BaseVectorStore`.
- `IngestionPipeline` tem cache (`IngestionCache`) e `docstore_strategy`
  (`pipeline.py:242-259,279-341`).
- Hooks/MCP: não fazem parte do núcleo; há integrações separadas.

## 8. Permissões, sandbox e erros

- Não há permissões nem sandbox: o framework roda no processo do usuário e
  chama LLMs/vector stores diretamente.
- Erros são exceções Python; `Memory` valida `token_limit > 0` e nomes únicos
  de blocos (`memory/memory.py:264-286`).
- `FactExtractionMemoryBlock` tem uma proteção importante: se a resposta de
  condensação vier vazia/ilegível, **não** substitui a lista
  (`fact.py:160-166`). Isso evita perda silenciosa de memória.
- `IngestionPipeline` evita apagar o docstore quando a resposta do LLM é
  vazia? Não no nível do pipeline; a proteção é do bloco.
- Conteúdo de documento não é tratado como instrução; o risco de prompt
  injection via retrieval existe e não é mitigado no núcleo.
- PII: `PIINodePostprocessor` e `NERPIINodePostprocessor` existem
  (`postprocessor/pii.py:40-98`), mas são opt-in, não default.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| memória | `llama-index-core/tests/memory/` (7 arquivos) | FIFO, blocos, fact extraction, custom store |
| node parser | `tests/node_parser/` | sentence, semantic, hierarchical, code |
| ingestão | `tests/ingestion/` | pipeline, cache, upserts, docstore |
| índices | `tests/indices/` | vector store index, insert/delete |
| retrievers | `tests/retrievers/` | fusion, auto-merging, recursive |
| storage | `tests/storage/` | docstore, index store, chat store |
| integrações | `llama-index-integrations/**/tests` | cada provider |

A suíte é grande e cobre o "caminho feliz" e casos de borda de orçamento. O
teste mais valioso para nós é `test_fact_extraction_memory_block.py`: ele
verifica extração, dedup exato e condensação — o trio que falta na nossa
wiki.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Waterfall de memória com orçamento | `memory/memory.py:188-200,672-809` | ejeta turnos completos e preserva o turno atual | MIT | `src/core/agent/compaction.ts` | 18 |
| Bloco de fatos com condensação | `memory/memory_blocks/fact.py:10-30,119-167` | extrai, deduplica exato e condensa sem apagar tudo | MIT | `src/core/memory/facts.ts` | 16 |
| Dedup por hash de documento no pipeline | `ingestion/pipeline.py:242-259,451-507` | reingestão idempotente, com `UPSERTS_AND_DELETE` | MIT | `src/core/memory/ingest.ts` | 15 |
| SentenceSplitter | `node_parser/text/sentence.py:34-115` | chunk por parágrafo/frase com overlap e tokenizer | MIT | `src/core/memory/chunk.ts` | 12 |
| Hierárquico + auto-merge | `node_parser/relational/hierarchical.py:76-127`; `retrievers/auto_merging_retriever.py:26-92` | recupera folha e sobe para o pai quando faz sentido | MIT | `src/core/memory/retrieve.ts` | 11 |
| Relações de nó/proveniência | `schema.py:207-310,391-456` | `SOURCE/PREVIOUS/NEXT/PARENT` + `ref_doc_id` | MIT | `src/core/memory/schema.ts` | 9 |
| `QueryFusionRetriever` | `retrievers/fusion_retriever.py:24-41,113-213` | expande a query e funde rankings | MIT | `src/core/memory/fusion.ts` | 8 |
| `StorageContext` | `storage/storage_context.py:151-195` | separa docstore, índice e vetores | MIT | `src/core/memory/persist.ts` | 7 |
| Postprocessors de recência/corte | `postprocessor/node.py:70-108`; `node_recency.py:40-163` | remove ruído e prioriza o recente | MIT | `src/core/memory/rank.ts` | 6 |

**O que falta na nossa memória:** o `brief()` é um corte fixo de 14 páginas e
7.000 caracteres (`src/core/memory/project.ts:408,432`), sem orçamento por
tokens e sem ejeção para um bloco de fatos. O `rememberTurn` grava o turno
inteiro (`project.ts:334-365`), sem chunking e sem dedup por hash de
documento. LlamaIndex resolve os três com um modelo simples: **fila curta +
blocos priorizados + pipeline idempotente**.

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Framework inteiro (2.969 integrações) | peso e superfície incompatíveis com um app desktop |
| `SimpleVectorStore` em JSON | não escala e reescreve o arquivo inteiro |
| `ChatSummaryMemoryBuffer` | deprecated pelo próprio projeto; nosso resumo é determinístico |
| `SemanticSplitter` com embeddings | custo por chunk; útil só quando o corpus é grande |
| SQLAlchemy async | nossa persistência é markdown + JSON atômico; não precisamos de ORM |
| `PIINodePostprocessor` com NER | dependência pesada; nossa `redactSecrets` já cobre segredos |
| `Memory` como classe mutável global | preferimos store por projeto, sem singleton |

## 12. Modelo de exemplo para o nosso harness

1. **Orçamento de briefing por tokens, não por páginas.** Calcular
   `estimateTokens(page.summary)` e encher até um teto (ex.: 2.000 tokens);
   fixadas primeiro, depois recentes, depois conflitos. O `MAX_BRIEF` atual é
   em caracteres (`project.ts:125,432`) e não reflete o custo real.
2. **Waterfall de turnos.** Quando a sessão passa do teto, arquivar o turno
   mais antigo **completo** (user + assistant + tools) e passá-lo a um bloco
   de fatos. Nunca cortar no meio de um turno; o LlamaIndex faz isso em
   `memory.py:761-797`.
3. **Bloco de fatos com condensação segura.** Extrair fatos, deduplicar por
   igualdade exata, e ao passar de N condensar com LLM. Se a resposta vier
   vazia, manter a lista anterior (`fact.py:160-166`). Isso é uma lição de
   segurança, não de feature.
4. **Chunking de páginas.** `SentenceSplitter` equivalente: parágrafo →
   frase → token, com overlap de 10–15%. Guardar `chunkNo`, `pageSlug`,
   `contentHash` e as relações `prev/next`.
5. **Ingestão idempotente.** Se o hash do markdown não mudou, não reembeddar
   nem reescrever; se mudou, apagar os chunks antigos e reinserir. É o
   `_handle_upserts` (`pipeline.py:469-507`) aplicado à wiki.
6. **Como testar.** Turno de 10 mensagens com teto de 3: assert de que só
   turnos completos foram arquivados e que o atual ficou. Reingerir o mesmo
   markdown duas vezes: 0 chamadas de embedding na segunda. Condensação com
   resposta vazia: lista intacta.

## 13. Evidências da análise

```text
git -C repositorios/_research/memory/run-llama--llama_index rev-parse HEAD
  → 619d74664e8404612038bc15a1a40c686037277c

llama-index-core/pyproject.toml:36-42   name/version 0.14.25, license MIT
memory/memory.py:188-200                "waterfalls into memory blocks"
memory/memory.py:696-702                token_limit * chat_history_token_ratio
memory/memory.py:781-797                archive_oldest_messages + block.aput
memory/memory_blocks/fact.py:144-147    "avoiding exact-match duplicates"
memory/memory_blocks/fact.py:160-166    só substitui se condensed_facts não vazio
ingestion/pipeline.py:242-259           DocstoreStrategy UPSERTS/DUPLICATES_ONLY/UPSERTS_AND_DELETE
ingestion/pipeline.py:481-493           compara hash, apaga e reinsere
node_parser/text/sentence.py:43-59      chunk_size, chunk_overlap, paragraph_separator
node_parser/relational/hierarchical.py:126-127  chunk_sizes = [2048, 512, 128]
retrievers/fusion_retriever.py:24-30    RECIPROCAL_RANK/DIST_BASED_SCORE/SIMPLE
schema.py:207-310                       NodeRelationship SOURCE/PREVIOUS/NEXT/PARENT/CHILD
```

Leituras: `llama-index-core/llama_index/core/memory/*`,
`memory_blocks/*`, `ingestion/pipeline.py`, `node_parser/text/sentence.py`,
`node_parser/relational/hierarchical.py`, `retrievers/*`,
`storage/storage_context.py`, `storage/docstore/*`, `schema.py`,
`llama-index-core/tests/memory/*`.
