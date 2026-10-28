# Qdrant

| Campo | Valor |
|---|---|
| Repositório | https://github.com/qdrant/qdrant (`git remote get-url origin`) |
| Clone local | `repositorios/_research/memory/qdrant--qdrant` |
| Commit | `222b2e44ab1c3f17e8246396ead6558e45041df7` |
| Licença | Apache-2.0 (`LICENSE:1-2`, `Cargo.toml:6`) |
| Categoria | motor de busca vetorial (servidor, Rust) |
| Stack | Rust 2024 / rust-version 1.98, Actix Web (REST), Tonic (gRPC), WAL próprio, blobstore + mmap para payload/vetores |
| Tamanho | 2.556 arquivos versionados; 1.993 fontes Rust (~565 mil linhas); 398 arquivos de teste/bench |

> Convenção de caminhos: `src/...` e `lib/...` são relativos à raiz do clone;
> `collection/...`, `segment/...`, `api/...` e `wal/...` são relativos ao crate
> correspondente em `lib/` (ex.: `collection/query.rs` =
> `lib/collection/src/collection/query.rs`); `LICENSE`, `Cargo.toml`,
> `config/` e `openapi/` são relativos à raiz.

## 1. O que é (verificado no código)

Qdrant é um servidor de busca vetorial com payload. O binário é um peer que
sobe REST + gRPC e mantém coleções em disco (`src/main.rs:76-140`;
`src/actix/mod.rs:44-153`). O que o distingue de uma biblioteca ANN:

- **Query plan com prefetch**: uma consulta pode ter sub-consultas e fundir os
  resultados com RRF ou DBSF (`lib/collection/src/collection/query.rs:344-385`).
- **Filtro de payload com índices**: `must`/`should`/`must_not`/`min_should`
  (`lib/segment/src/types.rs:4700-4732`) e índices por tipo
  (`lib/segment/src/types.rs:2695-2704`).
- **Texto BM25 de verdade**: tokenizer, lowercase, ASCII folding, stopwords,
  stemmer Snowball e `avg_len` (`lib/api/src/rest/schema.rs:190-260`).
- **WAL por segmento e snapshots** (`lib/wal/src/segment.rs:1`;
  `lib/collection/src/collection/snapshots.rs:57`).

Não há extração de fatos, dedup semântica, TTL ou "memória": é infraestrutura
de busca. O código acrescenta híbrida (RRF/DBSF), MMR, grouping e facetas.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `qdrant` | `src/main.rs:76` | sobe o peer com `config/config.yaml` |
| `--config-path` | `src/main.rs:113-118` | configuração alternativa |
| `--snapshot PATH:NAME` | `src/main.rs:97-103` | recupera coleção de snapshot no boot |
| `--storage-snapshot PATH` | `src/main.rs:105-111` | recupera o storage inteiro |
| `--disable-telemetry` | `src/main.rs:120-124` | desliga telemetria |
| `--bootstrap URI` | `src/main.rs:84-89` | entra em cluster existente |
| `GET /dashboard` | `src/actix/web_ui.rs:11` | Web UI estática |
| REST `/collections/{collection_name}/points/query` | `src/actix/api/query_api.rs:32` | busca (o verbo principal) |
| gRPC | `lib/api/src/grpc/qdrant.rs:1` | mesma superfície em protobuf |
| `cargo test` | `Cargo.toml:1` / `tests/` | suíte Rust |

A superfície não é de subcomandos: é REST/gRPC. As famílias são
`collections`, `points`, `snapshots`, `cluster`, `service`, `shards`,
`quotas` (ver `openapi/openapi-main.ytt.yaml:1`).

## 3. Arquitetura e fluxo

```
main → Settings → TableOfContent → Collection → Shard → Segment
                                              ├─ id_tracker
                                              ├─ payload_storage + field_index
                                              ├─ vector_storage (HNSW/plain)
                                              └─ WAL
query → prefetch(es) → por shard/segment → fusão (RRF/DBSF) → offset/limit
```

- Entry point: `src/main.rs:76` (`Args`), `src/main.rs:376` (`fn main`).
- Roteamento REST: `src/actix/mod.rs:44-153`.
- Query com prefetch/fusão: `lib/collection/src/collection/query.rs:344-385`.
- Busca por segmento: `lib/segment/src/segment/segment_ops.rs` e
  `lib/segment/src/index/hnsw_index/hnsw.rs`.
- Persistência: WAL em `lib/wal/src/segment.rs`; flush ordenado em
  `lib/segment/src/segment/entry.rs:410-468`.
- Snapshot: `lib/collection/src/collection/snapshots.rs:57-70`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Query com prefetch | `lib/api/src/rest/schema.rs:575-600` | sub-consultas + `fusion` | baixo |
| RRF | `lib/segment/src/common/reciprocal_rank_fusion.rs:14-77` | funde rankings por posição, `k` (padrão 2) e pesos | baixo |
| DBSF | `lib/collection/src/collection/query.rs:376` | funde por distribuição de scores | baixo |
| MMR | `lib/collection/src/collection/mmr.rs:14-45` | diversifica resultados | baixo |
| Filtro booleano | `lib/segment/src/types.rs:4700-4732` | `must/should/must_not/min_should` | baixo |
| Índices de payload | `lib/segment/src/types.rs:2695-2704` | keyword, integer, float, geo, text, bool, datetime, uuid | baixo |
| Texto BM25 | `lib/api/src/rest/schema.rs:190-260` | tokenizer + idioma + stemmer + stopwords | baixo |
| Busca exata | `lib/segment/src/types.rs:681-702` | `exact`, `hnsw_ef`, `indexed_only` | baixo |
| Quantização | `lib/segment/src/types.rs:971-1158` | scalar, product, binary | baixo |
| Grouping | `lib/collection/src/grouping/group_by.rs:41-69` | agrupa por payload e `group_size` | baixo |
| Facetas | `lib/collection/src/collection/facet.rs` | contagem por valor com oversampling | baixo |
| Snapshot | `lib/collection/src/collection/snapshots.rs:57` | backup consistente por coleção | médio (I/O) |
| Alias | `lib/storage/src/content_manager/toc/mod.rs:499-530` | troca de coleção sem mudar o cliente | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente nem prompt. O "loop" é o plano de consulta:

1. O cliente envia `query` + `prefetch` + `fusion` + `filter` + `limit`.
2. Cada shard resolve os prefetches; o resultado intermediário é uma lista de
   `ScoredPoint` por prefetch (`lib/collection/src/collection/query.rs:348-364`).
3. Se a raiz é `Fusion::Rrf`, aplica `rrf_scoring` com `k` e pesos; se é
   `Dbsf`, aplica `score_fusion(..., ScoreFusion::dbsf())`
   (`lib/collection/src/collection/query.rs:366-384`).
4. Aplica `score_threshold`, depois offset/limit (`query.rs:378-383`).
5. MMR roda **antes** do offset, para selecionar a página inteira
   (`query.rs:386-396`).

Streaming de resultados: não encontrado no caminho REST principal; a resposta
é uma lista. Cancelamento por timeout existe no nível da coleção
(`query.rs:390-392`). Retry é do cliente.

## 6. Sessões, estado e persistência

- **WAL por segmento**: cada operação recebe um `SeqNumberType`; o flush
  ordena vector storage, payload index e id tracker, e o id tracker é o último
  para que a presença de versão indique dados completos
  (`lib/segment/src/segment/entry.rs:410-468`).
- **Recuperação**: replay do WAL até `persisted_version`; se o flush foi
  parcial, o WAL reconstrói (`entry.rs:443-468`).
- **Snapshots**: `create_snapshot` cria diretório temporário, snapshot de cada
  shard e manifest (`lib/collection/src/collection/snapshots.rs:44-70`).
- **Metadados**: `PayloadStorageImpl` sobre `Blobstore` + mmap
  (`lib/segment/src/payload_storage/payload_storage_impl.rs:1-40`);
  vetores em memória mapeada (`lib/segment/src/vector_storage/`).
- **Versão por ponto**: `point_version` (`lib/segment/src/segment/entry.rs:47-49`); upsert
  sobrescreve por ID, sem dedup semântica.
- Não há sessão de usuário, fork de coleção (há snapshot/alias), TTL ou
  expiração. `expire|ttl` não encontrado no código de coleção/segmento.
- **Proveniência**: payload é opaco; `with_payload` devolve o que o cliente
  gravou. Não há campo de confiança, evidência ou origem.

## 7. Configuração e extensibilidade

- `config/config.yaml` (default), `config/production.yaml`,
  `config/development.yaml`; `Settings` carrega e valida
  (`src/settings.rs:269`).
- REST/gRPC gerados a partir de `openapi/openapi-main.ytt.yaml:1` e
  `lib/api/src/grpc/qdrant.rs:1`.
- Extensibilidade por **payload index** e **named vectors**; não há plugins de
  código. Features de compilação: `gpu`, `tracing`, `staging`, `chaos-testing`
  (`Cargo.toml:22-38`).
- Auth/RBAC: `lib/storage/src/rbac/auth.rs:14-92` com `Auth`, `Access` e
  `check_collection_access`; auditoria em `auditable_operation.rs`.
- Telemetria ligada por padrão; `--disable-telemetry` desliga
  (`src/main.rs:120-124`).

## 8. Permissões, sandbox e erros

- RBAC por coleção/tenant e token de API (`lib/storage/src/rbac/auth.rs:81-110`).
- Validação de campos no schema REST (`lib/api/src/rest/schema.rs:352-390`).
- Erros tipados por camada (`CollectionError`, `OperationError`,
  `StorageError`), com mapeamento para HTTP/gRPC.
- `indexed_only` evita resultados incompletos por índice atrasado, ao custo de
  excluir pontos ainda não indexados (`lib/segment/src/types.rs:698-702`).
- Não há sandbox de conteúdo: payload é opaco. Prompt injection em payload
  textual é responsabilidade do cliente.
- Concorrência: shards, `update_workers` e WAL serializam por segmento
  (`lib/collection/src/update_workers/flush_workers.rs:1`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| segmento | `lib/segment/src/**/tests` | HNSW, filtros, WAL, quantização |
| coleção | `lib/collection/src/collection/tests` | query, prefetch, fusão, snapshots |
| storage | `lib/storage/tests` | TOC, RBAC, consenso |
| integração | `tests/` (Rust) | cluster, shards, recuperação |
| consistência | feature `data-consistency-check` | verificação de dados |
| benchmarks | `lib/benchmark`, `benches/` | latência/recall |

O nível de teste é alto, mas o custo de portar é altíssimo: é um servidor com
consenso, sharding e WAL. O valor para nós está nos **algoritmos** e nas
**decisões de schema**, não no código.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| RRF/DBSF para híbrida | `lib/collection/src/collection/query.rs:366-384`; `lib/segment/src/common/reciprocal_rank_fusion.rs:14-77` | fusão pronta, com `k` e pesos | Apache-2.0 | `src/core/memory/fusion.ts` | 12 |
| BM25 com ASCII folding e stemmer | `lib/api/src/rest/schema.rs:226-260` | essential para pt-BR: "ação" → "acao" | Apache-2.0 | `src/core/memory/text.ts` | 10 |
| IDF por corpus (filtro) | `lib/segment/src/types.rs:710-731` | estatística calculada só no projeto, não no corpus global | Apache-2.0 | `src/core/memory/rank.ts` | 9 |
| Snapshot/WAL | `lib/wal/src/segment.rs`; `lib/collection/src/collection/snapshots.rs:57` | durabilidade com replay e backup consistente | Apache-2.0 | `src/core/memory/journal.ts` | 7 |
| Filtro booleano | `lib/segment/src/types.rs:4700-4732` | semântica clara para `must/should/must_not` | Apache-2.0 | `src/core/memory/query.ts` | 6 |
| MMR | `lib/collection/src/collection/mmr.rs:14-45` | diversifica memórias repetidas | Apache-2.0 | `src/core/memory/rank.ts` | 5 |
| Grouping/facetas | `lib/collection/src/grouping/group_by.rs:41-69` | agrupar por tipo/tag para o briefing | Apache-2.0 | `src/core/memory/brief.ts` | 4 |

**O que falta na nossa memória:** o `brief()` seleciona fixadas + 10 recentes
e corta em 14 páginas (`src/core/memory/project.ts:402-433`). Não há noção de
relevância por consulta, diversidade (MMR) nem estatística lexical por
projeto. O Qdrant mostra duas peças que resolvem isso sem servidor: **IDF
escopado por filtro** e **fusão por posto**.

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Servidor Rust com consenso/sharding | peso operacional e de build incompatível com Electron |
| WAL/servidor como dependência | já temos markdown + JSON atômico; um journal simples basta |
| Quantização (scalar/PQ/binary) | escala de milhões; nosso corpus é de milhares de páginas |
| Snapshots de coleção | copiar diretório resolve no nosso tamanho |
| gRPC/OpenAPI gerados | superfície enorme sem consumidor |
| `exact`/`indexed_only` | são compensações de ANN distribuído, não de memória local |

## 12. Modelo de exemplo para o nosso harness

1. **Query plan mínimo.** `{ prefetch: [{lexical, limit: 60}, {vector,
   limit: 60}], fusion: 'rrf', filter: {projectId, status, type} }`. Isso cabe
   em uma função pura e testável, sem servidor.
2. **IDF por projeto.** Ao indexar, contar `df` e `avgdl` só das páginas
   ativas do projeto. Uma memória sobre "deploy" não deve ser penalizada por
   outras 500 páginas de outro projeto falarem de deploy.
3. **Filtro antes da busca.** `status != invalidated/superseded`, `expiresAt`
   ausente ou futuro, `confidence >= limiar` quando o agente pedir. O
   `search()` atual só filtra status (`project.ts:385`).
4. **MMR leve.** Se as top-k vierem de páginas quase idênticas (sessões
   repetidas), penalizar similaridade par-a-par e re-ranquear. O
   `possibleConflicts` já detecta sobreposição (`project.ts:738-751`), mas não
   é usado para diversificar.
5. **Journal, não WAL.** Antes de sobrescrever uma página, gravar
   `.history/<slug>/<timestamp>.md`. É o equivalente ao `old_memory` do Mem0
   (`storage.py:150-191`) sem transação distribuída.
6. **Como testar.** Query com duas metades do corpus (metade em pt, metade em
   en) e assert de que o IDF local não explode; filtro por projeto; MMR com
   3 páginas duplicadas devolve no máximo 1.

## 13. Evidências da análise

```text
git -C repositorios/_research/memory/qdrant--qdrant rev-parse HEAD
  → 222b2e44ab1c3f17e8246396ead6558e45041df7

Cargo.toml:2-6                  version = "1.20.0", license = "Apache-2.0"
src/main.rs:120-124             --disable-telemetry
lib/collection/src/collection/query.rs:367-377
  FusionInternal::Rrf { k, weights } => rrf_scoring(...)
  FusionInternal::Dbsf => score_fusion(intermediates, ScoreFusion::dbsf())
lib/segment/src/common/reciprocal_rank_fusion.rs:14
  pub const DEFAULT_RRF_K: usize = 2;
lib/segment/src/types.rs:4700-4732   should / min_should / must / must_not
lib/segment/src/types.rs:710-731     IDF corpus filter
lib/api/src/rest/schema.rs:241-244   ascii_folding ("ação" -> "acao")
lib/api/src/rest/schema.rs:249-252   stemmer Snowball
lib/segment/src/segment/entry.rs:410-468  ordem de flush e replay do WAL
lib/collection/src/collection/snapshots.rs:57  create_snapshot
```

Leituras: `src/main.rs`, `src/actix/mod.rs`, `config/config.yaml`,
`lib/collection/src/collection/query.rs`, `snapshots.rs`, `mmr.rs`,
`lib/segment/src/types.rs`, `lib/segment/src/segment/entry.rs`,
`lib/api/src/rest/schema.rs`, `lib/bm25/src/lib.rs`,
`lib/segment/src/index/field_index/full_text_index/*`,
`lib/quantization/src/*`.
