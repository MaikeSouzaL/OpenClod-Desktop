# Resumo — 5 repositórios de memória

| Repositório | Commit | Licença | Fontes | Foco real |
|---|---|---|---|---|
| [mem0](mem0ai--mem0.md) | `2c81af3b` | Apache-2.0 | 878 (~190 k linhas) | extração de fatos + dedup + busca híbrida |
| [Chroma](chroma-core--chroma.md) | `52ce8448` | Apache-2.0 | 1.345 (~430 k linhas) | banco vetorial local/servidor + filtros |
| [Qdrant](qdrant--qdrant.md) | `222b2e44` | Apache-2.0 | 1.993 (~565 k linhas) | motor ANN + fusão + payload index |
| [sqlite-vec](asg017--sqlite-vec.md) | `04d28bd2` | MIT/Apache-2.0 | 108 (~31 k linhas) | extensão SQLite `vec0` |
| [LlamaIndex](run-llama--llama_index.md) | `619d7466` | MIT | 737 no core (~114 k linhas) | RAG, chunking, memória em blocos |

Nenhum dos cinco é "memória de projeto" pronta. Mem0 chega mais perto do
**processo** (extrair, deduplicar e acumular); LlamaIndex chega mais perto do
**orçamento de contexto**; Chroma, Qdrant e sqlite-vec são **índices**.

## 1. O que a nossa memória faz hoje

- Wiki markdown por projeto, com `index.json` derivado e reconstruível
  (`src/core/memory/project.ts:6-15,189-223`).
- Página com `memoryType`, `confidence`, `evidence`, `context`, `status`,
  `supersedes`/`supersededBy` e `possibleConflicts`
  (`src/core/memory/project.ts:30-52,622-647`). Tipo, confiança e evidência são
  campos de primeira classe; Mem0 e Chroma não os têm no schema.
- Busca lexical: título +4, tag +3, termo +1, sem semântica
  (`src/core/memory/project.ts:379-399`).
- Turno automático: `rememberTurn` anexa pedido/resultado/ferramentas/arquivos
  a uma página de sessão (`src/core/memory/project.ts:334-365`).
- Briefing: fixadas + 10 recentes, teto de 14 páginas e 7.000 caracteres
  (`src/core/memory/project.ts:402-433`).
- Handoffs claim-once (`src/core/memory/project.ts:488-538`) e grafo por wikilink/tag/termo
  (`src/core/memory/graph.ts:53-77`).
- Sidecar AI-Memory com FTS5 sobre a mesma wiki
  (`src/main/ai-memory.ts:8-14,528-560`).

## 2. Lacunas reais (confirmadas no código)

1. **Não existe embedding em `src/core`.** `grep -i "embedding|cosine"` em
   `src/core/**/*.ts` só encontra um comentário em
   `src/core/providers/discovery.ts:262`. Toda busca é lexical.
2. **Não existe dedup.** O slug vem do título (`src/core/memory/project.ts:250-251`); duas
   páginas com títulos diferentes e o mesmo fato coexistem. O
   `possibleConflicts` é heurística de sobreposição, não dedup
   (`src/core/memory/project.ts:738-751`).
3. **Não existe extração atômica.** `rememberTurn` grava o turno inteiro
   (`src/core/memory/project.ts:334-365`), não fatos. O agente pode esquecer de chamar
   `memory_page`; o fallback só despeja texto.
4. **Não existe chunking.** O corpo da página é um blob de até 60.000
   caracteres (`src/core/memory/project.ts:122`); o resumo é sempre os primeiros 260
   (`src/core/memory/project.ts:588-589`). Uma página longa não é recuperável por trecho.
5. **Não existe esquecimento automático.** Só `deletePage` e
   `invalidatePage` manuais (`src/core/memory/project.ts:305-318,367-377`). Sem TTL, decay ou
   orçamento de importância.
6. **Não existe fusão de sinais nem reranking.** O score é uma soma fixa
   (`src/core/memory/project.ts:386-393`); `confidence`/`memoryType` não entram no ranking.
7. **O briefing não é orçado em tokens.** É corte de caracteres
   (`src/core/memory/project.ts:125,432`), sem waterfall de turnos nem ejeção para fatos.

## 3. Candidatos (score 0–25)

Legenda de tipo: **código** = algoritmo/estrutura concreta a reimplementar;
**conceito** = decisão de desenho; **dependência** = componente externo que
seria adicionado. Destinos são propostas, não arquivos existentes.

Legenda de origem: `LlamaIndex X` = `run-llama--llama_index/llama-index-core/llama_index/core/X`;
`Mem0 X` = `mem0ai--mem0/mem0/X`; `Chroma X` = `chroma-core--chroma/chromadb/X`;
`Qdrant X` = `qdrant--qdrant/X`; `sqlite-vec X` = raiz de `asg017--sqlite-vec`.
Score: 18–25 = portar agora; 10–17 = portar depois de pré-requisito; 0–9 = só
como referência ou descartar.

| # | Candidato | Origem | Tipo | Destino proposto | Score |
|---|---|---|---|---|---|
| 1 | Waterfall de memória com orçamento de tokens | LlamaIndex `memory/memory.py:188-200,672-809` | conceito | `src/core/agent/compaction.ts` | 18 |
| 2 | Pipeline ADD-only + dedup por hash | Mem0 `memory/main.py:918-1041` | código | `src/core/memory/extract.ts` | 18 |
| 3 | Bloco de fatos com condensação segura | LlamaIndex `memory/memory_blocks/fact.py:10-30,119-167` | conceito | `src/core/memory/facts.ts` | 16 |
| 4 | Prompt de extração com data de observação | Mem0 `configs/prompts.py:468-540` | conceito | `src/core/memory/prompts.ts` | 16 |
| 5 | Ingestão idempotente por hash de documento | LlamaIndex `ingestion/pipeline.py:242-259,451-507` | conceito | `src/core/memory/ingest.ts` | 15 |
| 6 | Score híbrido semântica+BM25+entidade | Mem0 `utils/scoring.py:60-130`; `memory/main.py:1642-1701` | código | `src/core/memory/rank.ts` | 14 |
| 7 | `vec0` com partition key e metadados | sqlite-vec `sqlite-vec.c:2242-2320,2388-2443,3471` | dependência | `src/core/memory/vec-index.ts` | 14 |
| 8 | RRF para fundir rankings | Chroma `execution/expression/operator.py:1145-1180` | conceito | `src/core/memory/fusion.ts` | 12 |
| 9 | RRF/DBSF com pesos e `k` | Qdrant `lib/collection/src/collection/query.rs:366-384`; `lib/segment/src/common/reciprocal_rank_fusion.rs:14-77` | conceito | `src/core/memory/fusion.ts` | 12 |
| 10 | SentenceSplitter (parágrafo→frase→token) | LlamaIndex `node_parser/text/sentence.py:34-115` | código | `src/core/memory/chunk.ts` | 12 |
| 11 | Entidades com merge exato/0.95 | Mem0 `memory/main.py:1100-1204` | conceito | `src/core/memory/entities.ts` | 11 |
| 12 | Hierárquico + auto-merge pai/filho | LlamaIndex `node_parser/relational/hierarchical.py:76-127`; `retrievers/auto_merging_retriever.py:26-92` | conceito | `src/core/memory/retrieve.ts` | 11 |
| 13 | Chunked storage + merge top-k | sqlite-vec `sqlite-vec.c:7238-7260` | código | `src/core/memory/vec-index.ts` | 11 |
| 14 | BM25 com ASCII folding e stemmer | Qdrant `lib/api/src/rest/schema.rs:226-260` | conceito | `src/core/memory/text.ts` | 10 |
| 15 | Histórico append-only por memória | Mem0 `memory/storage.py:102-191` | conceito | `src/core/memory/history.ts` | 10 |
| 16 | Gramática de filtro de metadados | Chroma `base_types.py:128-158` | conceito | `src/core/memory/query.ts` | 9 |
| 17 | IDF calculado só no corpus do projeto | Qdrant `lib/segment/src/types.rs:710-731` | conceito | `src/core/memory/rank.ts` | 9 |
| 18 | Relações `PREVIOUS/NEXT/PARENT/SOURCE` | LlamaIndex `schema.py:207-310,391-456` | conceito | `src/core/memory/schema.ts` | 9 |
| 19 | Expiração por data (`expiresAt`) | Mem0 `memory/main.py:427-449,1684` | código | `src/core/memory/decay.ts` | 8 |
| 20 | Metadados filtráveis no KNN | sqlite-vec `sqlite-vec.c:2388-2443` | conceito | `src/core/memory/query.ts` | 8 |
| 21 | Índice local SQLite + HNSW | Chroma `db/impl/sqlite.py:89`; `segment/impl/vector/local_persistent_hnsw.py:95-152` | dependência | `src/core/memory/local-index.ts` | 8 |
| 22 | Expansão de query + fusão | LlamaIndex `retrievers/fusion_retriever.py:24-41,113-213` | conceito | `src/core/memory/fusion.ts` | 8 |
| 23 | FTS no mesmo SQLite | Chroma `segment/impl/metadata/sqlite.py:124-198` | conceito | `src/core/memory/index.ts` | 7 |
| 24 | Snapshot/WAL com replay | Qdrant `lib/wal/src/segment.rs:1`; `lib/collection/src/collection/snapshots.rs:57` | dependência | `src/core/memory/journal.ts` | 7 |
| 25 | `StorageContext` separando docstore/índice | LlamaIndex `storage/storage_context.py:151-195` | conceito | `src/core/memory/persist.ts` | 7 |
| 26 | Recência e corte por similaridade | LlamaIndex `postprocessor/node.py:70-108`; `postprocessor/node_recency.py:40-163` | código | `src/core/memory/rank.ts` | 6 |
| 27 | Filtro booleano `must/should/must_not` | Qdrant `lib/segment/src/types.rs:4700-4732` | conceito | `src/core/memory/query.ts` | 6 |
| 28 | MMR para diversificar | Qdrant `lib/collection/src/collection/mmr.rs:14-45` | código | `src/core/memory/rank.ts` | 5 |
| 29 | `upsert` por id | Chroma `api/models/Collection.py:515` | conceito | `src/core/memory/store.ts` | 5 |
| 30 | Rescore bit/int8 | sqlite-vec `sqlite-vec.c:2576-2834` | dependência | — (só em escala) | 5 |
| 31 | `vec_each` para iterar chunks | sqlite-vec `sqlite-vec.c:3220-3374` | código | `src/core/memory/chunk.ts` | 4 |
| 32 | Grouping/facetas | Qdrant `lib/collection/src/grouping/group_by.rs:41-69` | conceito | `src/core/memory/brief.ts` | 4 |
| 33 | Fork de coleção | Chroma `api/models/Collection.py:329` | conceito | — (hosted only) | 3 |
| 34 | Janela de 10 mensagens | Mem0 `memory/storage.py:257-286` | conceito | — (já temos transcript) | 3 |
| 35 | Quantização escalar/PQ/binária | Qdrant `lib/segment/src/types.rs:971-1158` | dependência | — (escala) | 2 |

## 4. Leitura do ranking

**Alto valor, baixo custo (15–18).** Os quatro primeiros são todos de
"processo", não de infraestrutura: orçamento de contexto, extração atômica,
condensação segura e dedup por hash. Nenhum exige dependência nova. Eles
atacam diretamente as lacunas 2, 3 e 7.

**Valor médio, custo médio (10–14).** Chunking, fusão RRF e entidades. O
chunking é pré-requisito para embedding; a fusão só faz sentido depois que
existir um segundo ranking; entidades podem esperar.

**Índice (8–14).** `sqlite-vec` é a opção mais alinhada ao nosso stack
(SQLite já existe no sidecar, `src/main/ai-memory.ts:12`), mas **não tem
binding Node** neste repositório e a partition key só compensa com centenas de
vetores por projeto (`site/features/vec0.md:18-24`). Chroma/Qdrant são
dependências pesadas e servidores; o que vale é o desenho, não o runtime. Se a
prioridade for "funcionar hoje sem binário novo", o caminho é um índice
vetorial em arquivo gerenciado por nós, com o mesmo schema lógico do `vec0`.

**Baixo valor (0–7).** Quantização, fork, grouping, rescore. São respostas a
problemas de escala que não temos.

## 5. O que falta de verdade (resposta curta)

1. **Um pipeline de fatos** (extrair → dedup → gravar) desacoplado do turno.
2. **Um índice semântico local** com isolamento por projeto e filtros.
3. **Chunking de páginas** para que uma página longa seja recuperável.
4. **Orçamento de contexto em tokens** com waterfall de turnos.
5. **Esquecimento explícito** (`expiresAt`, decay por importância, archival).
6. **Ranking que usa confiança/tipo/recência**, não só match textual.

O que **não** falta: proveniência (`evidence`, `confidence`, `context` já
existem), handoffs, grafo simples, separação por projeto e markdown como
fonte da verdade. Isso é vantagem nossa; não devemos trocar por um banco
opaco.

## 6. Roadmap sugerido

**Fase 1 — sem dependência nova (1 sprint).**
- `contentHash` no frontmatter e dedup exato na escrita
  (`src/core/memory/project.ts:263-279`).
- Chunking por seção com `prev/next` e `pageSlug`
  (inspirado em `sentence.py:101-115`).
- Briefing por tokens + waterfall de turnos
  (inspirado em `memory.py:672-809`).
- Testes de fixture: fato duplicado, turno longo, página longa.

**Fase 2 — índice semântico plugável (1–2 sprints).**
- Interface `MemoryIndex` com `upsert`, `delete`, `search`, `stats`.
- Backend A: lexical atual (fallback).
- Backend B: vetorial local; se SQLite, schema `vec0`-like com
  `projectId` como partition key.
- Fusão RRF + `score_details`.

**Fase 3 — extração e esquecimento (1 sprint).**
- Extrator opt-in com prompt de data de observação
  (`prompts.py:524-540`), límite de fatos e condensação segura
  (`fact.py:160-166`).
- `expiresAt`/`important` no frontmatter e filtro no `brief`/`search`.
- Métricas: taxa de duplicata, recall@k em fixtures, tokens do briefing.

## 7. Descarte explícito

| Item | Motivo |
|---|---|
| Telemetria PostHog (Mem0/Chroma) | ligada por padrão; viola local-first |
| Servidor Qdrant/Chroma distribuído | peso operacional desproporcional |
| hnswlib/ONNX como dependência obrigatória | binário nativo por plataforma |
| Framework LlamaIndex inteiro | 2.969 integrações; só queremos quatro ideias |
| `fork`/snapshot de coleção | hosted-only ou caro; cópia de diretório resolve |
| Quantização/rescore | escala de milhões, não de milhares de páginas |
| Sumarização por LLM como default | custo e perda; nosso `rememberTurn` determinístico é melhor como base |

## 8. Evidências da consolidação

```text
src/core/memory/project.ts:379-399   busca lexical (title/tags/terms)
src/core/memory/project.ts:334-365   rememberTurn grava turno inteiro
src/core/memory/project.ts:738-751   possibleConflicts por sobreposição
src/core/memory/project.ts:125,432   MAX_BRIEF em caracteres
src/core/memory/project.ts:122       MAX_BODY = 60_000
src/core/memory/graph.ts:53-77       wikilink/tag/termo, sem embedding
src/main/ai-memory.ts:12             sidecar FTS5
grep -i "embedding|cosine" src/core/**/*.ts → só discovery.ts:262
```

Contagens e commits: ver cabeçalho de cada um dos cinco arquivos. Todas as
leituras foram estáticas; nenhum clone foi instalado, buildado ou testado.
