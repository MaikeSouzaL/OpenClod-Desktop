# Mem0

| Campo | Valor |
|---|---|
| Repositório | https://github.com/mem0ai/mem0 (`git remote get-url origin`) |
| Clone local | `repositorios/_research/memory/mem0ai--mem0` |
| Commit | `2c81af3bbe27d9bccb09c772d583df9e9be72ee5` |
| Licença | Apache-2.0 (`LICENSE:1-2`, `pyproject.toml:13`) |
| Categoria | memória de agente / extração de fatos + busca híbrida |
| Stack | Python 3.9–3.12, Pydantic v2, hatch, pytest; SDK TypeScript irmão em `mem0-ts/` |
| Tamanho | 1.843 arquivos versionados; 878 fontes Python/TS (~190 mil linhas); 102 arquivos `test_*.py` |

> Convenção de caminhos: caminhos sem prefixo são relativos a `mem0/`
> (ex.: `memory/main.py` = `mem0/memory/main.py`); `cli/...`, `tests/...`,
> `README.md`, `AGENTS.md`, `pyproject.toml` e `LICENSE` são relativos à raiz
> do clone.

## 1. O que é (verificado no código)

Mem0 é uma camada de memória para agentes, não um banco vetorial. O entrypoint
self-hosted é `Memory` (`mem0/memory/main.py:487`), com `add()` (`memory/main.py:760`),
`search()` (`memory/main.py:1393`), `update()` (`memory/main.py:1829`) e `delete()`
(`memory/main.py:1883`). O `add()` não grava a mensagem crua: ele recupera memórias
parecidas, chama **um** LLM para extrair fatos atômicos e grava os fatos como
vetores (`memory/main.py:918-1041`). O README confirma o desenho atual: "Single-pass
ADD-only extraction — one LLM call, no UPDATE/DELETE" (`README.md:68`).

O ponto importante para nós: o valor não está no vector store (25 backends
plugáveis), está no **pipeline de extração + dedup + ranqueamento híbrido**.
O grafo de memória que o `AGENTS.md` do próprio repositório promete
(`mem0/AGENTS.md`, tabela "Graph stores | 4") **não existe neste commit**:
`git ls-files mem0/graphs` retorna 0 arquivos e `MemoryConfig` não tem
`graph_store` (`mem0/configs/base.py:29-48`). README e código divergem nesse ponto.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pip install mem0ai` | `pyproject.toml:6-13` | instala o SDK self-hosted |
| `from mem0 import Memory` | `mem0/__init__.py:1-4` | instancia o núcleo |
| `memory.add(messages, user_id=...)` | `mem0/memory/main.py:760` | extrai e grava fatos |
| `memory.search(query, filters={...})` | `mem0/memory/main.py:1393` | busca híbrida |
| `mem0 add/search/list/...` | `cli/python/src/mem0_cli/app.py:254-616` | CLI Typer; entrypoint em `cli/python/pyproject.toml` (`mem0 = "mem0_cli.app:main"`) |
| `make test` / `make lint` | `mem0/AGENTS.md` (comandos) | pytest e ruff no pacote Python |

Superfície: `add`, `get`, `get_all`, `search`, `update`, `delete`, `delete_all`,
`history`, `reset`, `close` (`memory/main.py:1222-2185`). O CLI adiciona `entity`,
`event`, `config`, `agent-rush`, `import` (`cli/python/src/mem0_cli/app.py:729-1409`). O servidor REST
self-hosted fica em `server/` (FastAPI + pgvector + Neo4j, conforme
`AGENTS.md` da raiz), mas não foi exercitado nesta análise.

## 3. Arquitetura e fluxo

```
Memory.add → normaliza mensagens → embed da conversa → top-10 existentes
  → 1 chamada LLM (ADD-only) → dedup md5 → embed em lote → insert em lote
  → history SQLite → entity store (spaCy) → salva mensagens (últimas 10)
```

- Entry point: `mem0/memory/main.py:487` (`class Memory`) e `memory/main.py:760` (`add`).
- Pipeline: `memory/main.py:881` (`_add_to_vector_store`), fases comentadas em
  `memory/main.py:918-1207`.
- Recuperação de contexto: `memory/main.py:925-933` (busca top-10 no vector store).
- Extração: `memory/main.py:942-986` (system prompt + user prompt, JSON).
- Persistência de histórico: `mem0/memory/storage.py:11` (`SQLiteManager`),
  schema em `memory/storage.py:102-148`.
- Busca: `memory/main.py:1642-1745`; scoring em `mem0/utils/scoring.py:60-130`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Extração aditiva de fatos | `mem0/configs/prompts.py:468-520` | um LLM lê mensagens novas + memórias existentes e devolve só `ADD`, com `linked_memory_ids` | médio (custo/latência; prompt injection no conteúdo) |
| Dedup exata por hash | `mem0/memory/main.py:1022-1026` | `md5(texto)` comparado com hashes existentes e com o lote atual | baixo |
| Dedup semântica | `configs/prompts.py:501-516` | o LLM recebe "Recently Extracted" e "Existing Memories" e deve pular equivalentes | médio (depende do modelo) |
| Embedding em lote com fallback | `memory/main.py:993-1005` | `embed_batch`; se falhar, embed individual | baixo |
| Busca híbrida | `memory/main.py:1642-1701` | semântica + BM25 + boost de entidade, normalizados | baixo |
| Normalização BM25 por sigmoide | `mem0/utils/scoring.py:43-54` | converge score lexical para [0,1] | baixo |
| Boost por entidade | `memory/main.py:1747-1827` | entidades da query casam com `linked_memory_ids` | baixo |
| Reranker opcional | `memory/main.py:1513-1519`; `mem0/reranker/*` | Cohere, HF, LLM, sentence-transformers, ZeroEntropy | médio (rede/custo) |
| Expiração por data | `memory/main.py:427-449`, `1684` | `expiration_date` esconde memórias vencidas | baixo |
| Histórico append-only | `memory/storage.py:150-191` | ADD/UPDATE/DELETE com `old_memory`/`new_memory` | baixo |
| Entity store | `memory/main.py:1100-1204` | entidades spaCy, embed, merge exato ou ≥0.95 | médio |
| Memória procedural | `memory/main.py:2007-2050` | resume a conversa em um procedimento | médio |

## 5. Loop do agente, contexto e streaming

Mem0 não tem loop de agente. O "loop" é o pipeline de escrita:

1. **Fase 0** — escopo (`user_id`/`agent_id`/`run_id`) e últimas 10 mensagens
   da sessão (`memory/main.py:920-923`; `memory/storage.py:257-286`).
2. **Fase 1** — embeda a conversa inteira e busca 10 memórias existentes;
   troca UUIDs por inteiros "anti-alucinação" (`memory/main.py:925-940`).
3. **Fase 2** — uma chamada `generate_response(..., response_format=json)`
   (`memory/main.py:957-964`). Falha de LLM **é relançada** como `LLMError`, não
   silenciada (`memory/main.py:965-971`). O prompt ancora datas relativas na
   "Observation Date" (`configs/prompts.py:524-540`), o que é uma boa ideia para
   memória de projeto.
4. **Fase 3** — `embed_batch` dos fatos (`memory/main.py:993-1005`).
5. **Fase 4/5** — hash md5 e dedup (`memory/main.py:1007-1026`).
6. **Fase 6** — insert em lote com fallback um-a-um; só o que persistiu entra
   no histórico e no retorno (`memory/main.py:1047-1076`).
7. **Fase 7** — entidades e links (`memory/main.py:1100-1204`).
8. **Fase 8** — salva mensagens e retorna `ADD` (`memory/main.py:1206-1220`).

Não há streaming, cancelamento, retry de LLM nem compactação de contexto. A
"compactação" é o corte para 10 mensagens por escopo (`memory/storage.py:281-286`).

## 6. Sessões, estado e persistência

- Escopo: string determinística `agent_id=...&run_id=...&user_id=...`
  (`memory/main.py:412-419`); os delimitadores são escapados (`memory/main.py:407-409`).
- Histórico: SQLite em `~/.mem0/history.db` por padrão
  (`mem0/configs/base.py:42-45`; `mem0/memory/setup.py:13-14`), com lock de
  thread (`memory/storage.py:14-18`) e migração de schema antigo (`memory/storage.py:20-100`).
- Vetores: onde o backend escolhido guardar; o SDK só conhece a interface
  (`mem0/vector_stores/base.py:4-66`). O default de configuração é Qdrant
  (`mem0/vector_stores/configs.py:6-9`), mas isso é dependência opcional.
- Mensagens: tabela `messages`, uma linha por mensagem, retenção de 10 por
  escopo (`memory/storage.py:128-148`, `257-286`).
- Não há fork, checkpoint, versão de coleção nem transação entre vector store
  e SQLite. O histórico pode ficar à frente ou atrás dos vetores se o processo
  morrer no meio.
- **Proveniência**: `actor_id`, `role`, `attributed_to` e `created_at`/
  `updated_at` no payload (`memory/main.py:1704-1713`); não há campo de
  confiança nem de evidência.

## 7. Configuração e extensibilidade

- `MemoryConfig` agrega `vector_store`, `llm`, `embedder`, `history_db_path`,
  `reranker` (`mem0/configs/base.py:29-57`).
- 25 módulos de vector store, 18 de LLM, 12 de embedder e 5 de reranker
  (contagem de arquivos em `mem0/*/`), todos por arquivo + `base.py` +
  registro em `__init__.py`.
- Variáveis: `MEM0_DIR` (`memory/setup.py:14`), `MEM0_TELEMETRY` (`memory/telemetry.py:14`).
- O CLI tem `config show/get/set` (`cli/python/src/mem0_cli/app.py:729-780`) e plugins
  (`cli/python/src/mem0_cli/plugin_sync.py`).
- Não há hooks, MCP, skills ou agentes. Extensibilidade = trocar provider.

## 8. Permissões, sandbox e erros

Não há permissão por ferramenta, sandbox de execução nem isolamento de
conteúdo. O que existe:

- Validação de escopo: `search`/`get_all` exigem ao menos um de
  `user_id`/`agent_id`/`run_id` e rejeitam esses parâmetros no topo
  (`memory/main.py:1449-1475`).
- Validação de query: trim e tamanho (`memory/main.py:239-252`); `top_k`/`threshold`
  validados em `memory/main.py:212-237`.
- Erros tipados: `ValidationError` (importado como `Mem0ValidationError`),
  `LLMError`, `VectorStoreError`, `EmbeddingError` (`mem0/exceptions.py:138-346`);
  falha de insert em lote cai para insert individual e, se nada persistir,
  levanta `VectorStoreError` (`memory/main.py:1063-1076`).
- Telemetria **ligada por padrão** para PostHog (`memory/telemetry.py:14-23`), com
  amostragem configurável (`memory/telemetry.py:31-72`). Isso é um motivo para não
  copiar o código como está.
- Conteúdo de memória é tratado como dado, não como instrução? O prompt não
  diz isso explicitamente; só há a separação de seções (`configs/prompts.py:478-521`).
  **Não encontrado** um guarda contra prompt injection vindo de memória.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| memória | `tests/memory/test_main.py`, `test_storage.py`, `test_session_scope.py` | add/search/update/delete, escopo, SQLite |
| utilidades | `tests/utils/*` | scoring, lemmatização, entidades |
| providers | `tests/vector_stores/`, `tests/llms/`, `tests/embeddings/` | contrato de cada backend |
| notices | `tests/memory/test_*_notice.py` | mensagens de feature não suportada (decay/temporal) |
| total | 102 `test_*.py` em 7 diretórios | — |

A qualidade é boa no que testa, mas o teste de dedup é por hash e por prompt;
não há teste de "fato semanticamente equivalente com texto diferente". O
`test_main.py` usa mocks de LLM/embedder, então o comportamento real do
extrator não é exercitado.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Pipeline ADD-only + dedup por hash | `mem0/memory/main.py:918-1041` | grava fato atômico, não despeja a conversa; dedup barato antes do embed | Apache-2.0 | `src/core/memory/extract.ts` | 18 |
| Prompt de extração com data de observação | `mem0/configs/prompts.py:468-540` | resolve "ontem/semana passada" e separa o que é fato do que é eco | Apache-2.0 | `src/core/memory/prompts.ts` | 16 |
| Score híbrido semântica+BM25+entidade | `mem0/utils/scoring.py:60-130`; `memory/main.py:1642-1701` | combina três sinais com normalização e `score_details` | Apache-2.0 | `src/core/memory/rank.ts` | 14 |
| Entidades com merge exato/0.95 | `mem0/memory/main.py:1100-1204` | liga memórias por entidade sem grafo dedicado | Apache-2.0 | `src/core/memory/entities.ts` | 11 |
| Expiração por data | `mem0/memory/main.py:427-449`, `1684` | esquecimento explícito e reversível (`show_expired`) | Apache-2.0 | `src/core/memory/decay.ts` | 8 |
| Histórico append-only | `mem0/memory/storage.py:102-191` | auditoria de ADD/UPDATE/DELETE por memória | Apache-2.0 | `src/core/memory/history.ts` | 10 |

**O que falta de verdade na nossa memória wiki:** hoje `ProjectMemory.search`
é lexical sobre título/tags/termos (`src/core/memory/project.ts:379-399`) e o
`index.json` guarda `terms` (`project.ts:588-607`). Não há embedding, não há
busca semântica, não há fusão de sinais e não há extração automática de fatos:
`rememberTurn` grava pedido+resultado inteiros em uma página de sessão
(`project.ts:334-365`). O maior ganho do Mem0 é justamente o par
"extração atômica + dedup antes de indexar".

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| 25 vector stores / 18 LLMs | custo de manutenção; nós temos um store local e um sidecar |
| Telemetria PostHog | ligada por padrão e envia ids; viola nossa postura local-first |
| SQLite de histórico separado do store | cria consistência eventual; nosso markdown é a fonte da verdade |
| Entity store com spaCy | dependência pesada; nosso grafo por tags/termos já resolve o caso simples |
| `LLMError` relançado sem retry | em um turno de agente isso derruba a escrita; precisamos de fallback |
| Prompt de extração de 1.400+ linhas | monolito difícil de testar; portar as regras, não o texto inteiro |
| ADD-only sem update automático | memória antiga e nova coexistem; nosso `supersedes`/`invalidated` já é melhor |

## 12. Modelo de exemplo para o nosso harness

1. **Separar "turno" de "fato".** Manter `rememberTurn` como está (é o seguro
   determinístico), mas adicionar um extrator opt-in que roda depois do turno
   e produz 0..N fatos com `text`, `type`, `confidence`, `evidence` e
   `sourceSession`. Isso já cabe no `MemoryPageInput` atual
   (`project.ts:17-28`).
2. **Dedup em duas camadas.** (a) hash normalizado do texto (custo zero);
   (b) similaridade de cosseno contra os vetores dos últimos N fatos do mesmo
   projeto, com limiar alto (ex.: 0.95). Só depois chamar o embed definitivo.
3. **Busca híbrida real.** Índice lexical atual + vetores; fundir por RRF ou
   por soma normalizada, e devolver `score_details` para o agente explicar por
   que lembrou. O `memory_recall` (`src/core/memory/tools.ts:246-277`) já é o
   ponto de entrada; ele só precisa de um backend semântico.
4. **Esquecimento explícito.** Reaproveitar `status: invalidated` e adicionar
   `expiresAt` no frontmatter. `brief()` já filtra `superseded`/`invalidated`
   (`project.ts:405`); passa a filtrar vencidos também.
5. **Proveniência como cidadã de primeira classe.** Já temos
   `memoryType`/`confidence`/`evidence`/`context` (`project.ts:30-51`), o que
   é melhor que o Mem0. O que falta é **usar** isso no ranking e no briefing:
   hoje `search` ignora confiança e tipo (`project.ts:386-393`).
6. **Como testar.** Fixtures de conversa em pt-BR com fato explícito, fato
   implícito, eco do assistente e duplicata parafraseada; assert de 1 fato
   gravado, 0 duplicatas e data resolvida. Testar também o caminho "LLM
   falhou": o turno continua e a página de sessão é gravada.

## 13. Evidências da análise

```text
git -C repositorios/_research/memory/mem0ai--mem0 rev-parse HEAD
  → 2c81af3bbe27d9bccb09c772d583df9e9be72ee5

git ls-files mem0/graphs | wc -l
  → 0

mem0/memory/main.py:918  # === V3 PHASED BATCH PIPELINE ===
mem0/memory/main.py:1022 mem_hash = hashlib.md5(text.encode()).hexdigest()
mem0/memory/main.py:1023 if mem_hash in existing_hashes or mem_hash in seen_hashes:
mem0/memory/main.py:1166 semantic_match = matches[0] if matches and matches[0].score >= 0.95 else None
mem0/utils/scoring.py:118 raw_combined = semantic_score + bm25_score + entity_boost
mem0/memory/main.py:1684 if not show_expired and _payload_is_expired(payload): continue
mem0/memory/storage.py:281-286  # retenção de 10 mensagens por sessão
mem0/memory/telemetry.py:14 MEM0_TELEMETRY = os.environ.get("MEM0_TELEMETRY", "True")
README.md:68  # "Single-pass ADD-only extraction -- one LLM call, no UPDATE/DELETE"
```

Leituras: `mem0/memory/main.py` (3.378 linhas), `configs/prompts.py`,
`memory/storage.py`, `utils/scoring.py`, `utils/entity_extraction.py`,
`vector_stores/base.py`, `configs/base.py`, `tests/memory/*`.
