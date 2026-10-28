# Langfuse

| Campo | Valor |
|---|---|
| Repositório | https://github.com/langfuse/langfuse |
| Clone local | `repositorios/_research/testing/langfuse--langfuse` |
| Commit | `602cbfdfa8d90be214332a049537e6cb75a50cf3` (2026-10-25) |
| Licença | MIT Expat fora de `ee/` (`LICENSE:1-10`); `ee/LICENSE` é Enterprise — **não usar** |
| Categoria | testing / observabilidade de LLM |
| Stack | TypeScript, Next.js (Pages Router), tRPC, Prisma/Postgres, ClickHouse, Redis/BullMQ, pnpm 12.8.2 (`package.json:12-15`) |
| Tamanho | 7.439 arquivos rastreados; 853 arquivos TS em `packages/shared/src`; 548 arquivos de teste em `web/src` e 227 em `worker/src` |

## 1. O que é (verificado no código)

Plataforma de **observabilidade e avaliação de aplicações LLM**, não uma
biblioteca de teste. Recebe traces por SDK ou por OTLP HTTP
(`web/src/pages/api/public/otel/v1/traces/index.ts:29-138`), normaliza para o
modelo `Trace` + `Observation` (`packages/shared/src/domain/observations.ts:59-107`),
grava em ClickHouse/Postgres e expõe UI, API pública, datasets, experimentos,
prompts versionados e avaliadores LLM-as-judge.

O núcleo conceitual que interessa ao nosso harness:

1. **Trace = execução completa** com `sessionId`, `userId`, `tags`, `release`,
   `version`, `input`/`output` (`domain/traces.ts:12-30`).
2. **Observation = span tipado**: `SPAN`, `EVENT`, `GENERATION`, `AGENT`,
   `TOOL`, `CHAIN`, `RETRIEVER`, `EVALUATOR`, `EMBEDDING`, `GUARDRAIL`
   (`domain/observations.ts:9-33`), com `parentObservationId` e `level`.
3. **Uso e custo separados em "provided" e calculado**
   (`observations.ts:86-97`), para nunca contar duas vezes quando o SDK já manda
   tokens e o servidor também os deriva.
4. **Score é cidadão de primeira classe** com tipo, fonte e nível
   (`domain/scores.ts:5-61`).

O README fala em "LLM engineering platform"; o código confirma, mas o valor
para nós está nos **contratos de dados**, não na infraestrutura.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `docker compose -f docker-compose.dev.yml up -d` | `package.json:21` | Sobe Postgres, ClickHouse, Redis, MinIO |
| `pnpm run dev` | `package.json:36` | Web + worker em watch |
| `pnpm run dx` | `package.json:30` | Reset completo + seed + dev |
| `pnpm run db:migrate` | `package.json:25` | Migrações Prisma |
| `pnpm run db:seed:examples` | `package.json:27` | Dados de exemplo |
| `pnpm --filter web run test` | `web/AGENTS.md` | Testes de servidor |
| `pnpm --filter worker run test` | `worker/AGENTS.md` | Testes do worker |
| `pnpm run typecheck` | `package.json:41` | Typecheck de todos os pacotes |
| API `POST /api/public/otel/v1/traces` | `web/src/pages/api/public/otel/v1/traces/index.ts:29` | Ingestão OTLP |
| API `POST /api/public/ingestion` | `web/src/pages/api/public/` | Ingestão em lote (eventos) |
| API `GET /api/public/traces/{id}` | `web/src/pages/api/public/traces/` | Leitura de trace |
| API `POST /api/public/scores` | `web/src/pages/api/public/scores/` | Cria score externo |

Superfície: API REST pública (`web/src/pages/api/public/*`), tRPC interno
(`web/src/server/api/root.ts`), UI Next.js, worker BullMQ. Não há CLI de
avaliação; avaliação é configurada na UI/API e executada no worker.

## 3. Arquitetura e fluxo

```
SDK / OTLP / API
  → web/src/pages/api/public/otel/v1/traces      index.ts:29
    → processOtelIngestion                       web/src/server/otel/processOtelIngestion.ts:48
      → OtelIngestionProcessor                   packages/shared/src/server/otel/OtelIngestionProcessor.ts:532
        → ObservationTypeMapper                  ObservationTypeMapper.ts:256
        → S3/Redis queue                         packages/shared/src/server/queues.ts
  → worker (BullMQ)                              worker/src/queues/*
    → ClickHouse (observations/traces/scores)    packages/shared/clickhouse/migrations
    → Postgres (datasets, prompts, configs)      packages/shared/prisma/schema.prisma
  → web UI / API pública
```

- Entry point HTTP: `web/src/pages/api/public/otel/v1/traces/index.ts:29-37`.
- Normalização de span: `OtelIngestionProcessor.ts:532-575` (tipo, uso, tools)
  e `:660-709` (modelo, custo, sessão, release).
- Avaliação assíncrona: `worker/src/features/evaluation/evalService.ts:201-268`;
  execução LLM: `packages/shared/src/server/evals/llmEvaluatorExecution.ts:80`.
- Streaming: não é o foco; a UI consome consultas paginadas no ClickHouse.
- Persistência: ClickHouse para traces/observations/scores; Postgres para
  metadados, datasets, prompts e configuração de avaliação.

## 4. Catálogo de ferramentas / capacidades

| Capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Ingestão OTLP HTTP | `web/.../otel/v1/traces/index.ts:29-138` | Aceita OTLP, valida tamanho, enfileira | médio |
| Mapeamento de tipo de observation | `server/otel/ObservationTypeMapper.ts:256` | `gen_ai.*`/`langfuse.*` → tipo | baixo |
| Atributos canônicos | `server/otel/attributes.ts:5-44` | `session.id`, `user.id`, `langfuse.observation.*` | baixo |
| Modelo de trace/observation | `domain/traces.ts:12`; `domain/observations.ts:59` | Contrato de dados | baixo |
| Scores tipados | `domain/scores.ts:47-61` | NUMERIC/CATEGORICAL/BOOLEAN/CORRECTION/TEXT | baixo |
| Avaliador LLM-as-judge | `packages/shared/src/server/evals/llmEvaluatorExecution.ts:80-160` | Prompt + modelo + schema de score | médio |
| Regras de avaliação | `worker/src/features/evaluation/evalService.ts:201-268` | Filtro, alvo, amostragem | médio |
| Amostragem determinística | `worker/.../deterministicSampling.ts:7-30` | Hash SHA-256 → bucket [0,1) | baixo |
| Dataset runs / experimentos | `domain/dataset-run-items.ts:5-27` | Item de dataset ↔ trace/observation | baixo |
| Baseline de experimento | `web/src/features/experiments/components/ExperimentBaselineControls.tsx:27-115` | Compara runs contra um baseline | baixo |
| Montagem de transcript | `server/transcript/transcript.ts:48-89` | Ordena spans e limita caracteres | baixo |
| Ordenação de observações | `server/transcript/ordering.ts:13-50` | Árvore por `parentObservationId` | baixo |
| Precificação por modelo | `server/ingestion/modelMatch.ts:45-76,239-292` | Match por padrão + tiers de preço | baixo |

## 5. Loop do agente, contexto e streaming

Langfuse **não executa agentes**; ele observa e avalia. O "loop" relevante é o
de avaliação:

1. A regra de avaliação define `targetObject` (`TRACE`, `OBSERVATION`,
   `DATASET`, `EXPERIMENT`), filtro e `sampling`
   (`worker/src/features/evaluation/evalService.ts:201-268`).
2. Para cada alvo, `observationForEval` achata input, output, metadata, tools e
   contagens em um objeto plano (`packages/shared/src/features/evals/observationForEval.ts:18-79`).
3. O avaliador compila o template com as variáveis mapeadas
   (`llmEvaluatorExecution.ts:53-70`) e chama o modelo.
4. O modelo devolve `score` + `scoreExplanation`; o resultado é validado contra
   o `outputDefinition` (numérico, categórico ou booleano) e vira `Score`
   (`llmEvaluatorExecution.ts:99-160`;
   `packages/shared/src/features/evals/outputDefinition.ts:4-8`).
5. A amostragem é determinística por `sha256("langfuse:evaluation-sampling:v1\0" + targetId)`
   (`deterministicSampling.ts:4-30`), o que torna re-runs reproduzíveis.

Detalhe importante de prompt: o campo enviado ao modelo se chama
`scoreExplanation`, não `reasoning`, porque modelos com "thinking" tratam
`reasoning` como rascunho e podem omitir o score
(`llmEvaluatorExecution.ts:72-78`). É uma lição de compatibilidade, não um
detalhe de estilo.

Contexto: o transcript é montado por `orderObservations` + `assembleTranscript`,
com limite de caracteres e separação de "turno atual" vs. histórico
(`transcript.ts:48-89`). Cancelamento/streaming não existem nesse caminho: é
batch com retry de fila.

## 6. Sessões, estado e persistência

- `TraceDomain.sessionId` e `userId` (`domain/traces.ts:27-28`); o processor
  extrai `session.id`/`langfuse.session.id` (`OtelIngestionProcessor.ts:686-690`).
- Hierarquia por `parentObservationId` (`domain/observations.ts:69`), com
  ordenação tolerante a ciclos (`ordering.ts:38-50`).
- Sessão = conjunto de traces com o mesmo `sessionId`; a UI agrupa por sessão.
  Não há entidade "turno" persistida: turno é derivado do transcript
  (`splitTurn` em `transcript.ts:10,82`).
- Datasets e experimentos: `domain/dataset-run-items.ts:5-27` liga
  `datasetItemId` a `traceId`/`observationId`, com input e expected output.
- Prompts versionados no Postgres via event sourcing
  (`web/src/features/prompts/server/promptChangeEventSourcing.ts:28`) e
  resolução por `name/version/label`
  (`web/src/features/prompts/server/handlers/promptNameHandler.ts:27-40`).
- Retenção e limpeza são jobs do worker (não relevantes para nós).

## 7. Configuração e extensibilidade

- Variáveis de ambiente em `.env.dev.example` / `.env.prod.example`
  (centenas de chaves; não copiar).
- Conexões de modelo por projeto (`web/src/features/llm-api-key`,
  `packages/shared/src/server/llm/`), com adaptadores OpenAI, Anthropic,
  Bedrock, Azure, Google.
- Avaliadores: prompt + `outputDefinition` + mapeamento de variáveis
  (`web/src/features/evals`, `packages/shared/src/features/evals`).
- Ingestão: SDKs, OTLP/HTTP, API de eventos; mascaramento de ingestão
  (`server/ee/ingestionMasking` — **EE, não usar**).
- Datasets: itens versionados, runs e comparação com baseline.

## 8. Permissões, sandbox e erros

- Multi-tenant por `projectId`; o guard de acesso é
  `hasProjectAccess`/`throwIfNoProjectAccess`
  (`web/src/features/rbac/utils/checkProjectAccess.ts:39-67`).
- Ingestão suspensa por limite de uso devolve `403` explícito
  (`otel/v1/traces/index.ts:38-43`).
- Corpo OTLP limitado por `LANGFUSE_OTEL_INGESTION_MAX_BODY_BYTES` e gzip
  tratado com limite (`index.ts:48-96`).
- Um lote OTLP com qualquer span de id inválido é **rejeitado por inteiro**,
  com motivo explícito na resposta e métrica
  `langfuse.ingestion.otel.rejected_invalid_span_ids`
  (`web/src/server/otel/processOtelIngestion.ts:123-187`). A escolha é não
  descartar spans silenciosamente; o custo é perder o lote inteiro.
- Erros de avaliação são classificados para o worker
  (`worker/src/features/evaluation/evalExecutionMetrics.ts`,
  `evalFailureErrors.ts`), com retry de fila.
- Não há sandbox de ferramentas: Langfuse não executa código do usuário no
  caminho OSS (avaliadores de código existem, mas o dispatcher é separado —
  `server/evals/codeEvalDispatchers.ts`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Domínio | `packages/shared/src/domain/*.test.ts` | schemas, agregações, audit logs |
| Ingestão OTel | `packages/shared/src/server/otel/*.test.ts` | mapeamento, mídia, metadata |
| Transcript | `packages/shared/src/server/transcript/*.test.ts` | ordenação, turnos, limites |
| Web server | `web/src/__tests__/server/*.servertest.ts` | API pública, RBAC, queries |
| Web client | `web/src/**/*.clienttest.tsx` | componentes e tabelas |
| Worker | `worker/src/**/*.test.ts` | filas, avaliação, limpeza |
| E2E | `web/src/__e2e__` | fluxos completos |

548 arquivos de teste em `web/src` e 227 em `worker/src`; Vitest com projetos
separados (server/client/in-source) e Playwright para E2E. Qualidade: ESLint
custom rules, `structure:stats`, golden SQL tests para queries ClickHouse.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Taxonomia de observation + trace | `packages/shared/src/domain/observations.ts:9-33`; `packages/shared/src/domain/traces.ts:12-30` | Nomes estáveis para span, tool, geração, agente e guardrail | MIT | `src/core/observability/types.ts` | 24 |
| Uso/custo "provided" vs. calculado | `packages/shared/src/domain/observations.ts:86-97` | Evita dupla contagem e preserva o que o SDK informou | MIT | `src/core/observability/types.ts` | 23 |
| Mapa de atributos OTLP | `packages/shared/src/server/otel/attributes.ts:5-44`; `packages/shared/src/server/otel/ObservationTypeMapper.ts:256` | Faz qualquer SDK OTel virar o nosso modelo sem adapter por vendor | MIT | `src/core/observability/attributes.ts` | 22 |
| Contrato de score tipado | `packages/shared/src/domain/scores.ts:47-61` | Numérico, categórico, booleano e correção no mesmo modelo | MIT | `src/core/eval/score.ts` | 21 |
| Saída de avaliador LLM | `packages/shared/src/server/evals/llmEvaluatorExecution.ts:29-30,99-160` | `score` + `scoreExplanation` + validação por schema | MIT | `src/core/eval/judge/schema.ts` | 21 |
| Amostragem determinística | `worker/src/features/evaluation/deterministicSampling.ts:4-30` | Re-runs reproduzíveis sem guardar estado | MIT | `src/core/eval/sampling.ts` | 19 |
| Montagem de transcript por turno | `packages/shared/src/server/transcript/transcript.ts:48-89`; `packages/shared/src/server/transcript/ordering.ts:13-50` | Ordena spans, separa histórico e limita tamanho | MIT | `src/core/observability/transcript.ts` | 19 |
| Item de dataset run | `packages/shared/src/domain/dataset-run-items.ts:5-27` | Liga caso, trace e expected output | MIT | `src/core/eval/dataset/types.ts` | 18 |
| Baseline de experimento | `web/src/features/experiments/components/ExperimentBaselineControls.tsx:27-115` | UI e semântica de comparar run atual × baseline | MIT | `src/core/eval/compare.ts` | 17 |
| Precificação por modelo/tier | `packages/shared/src/server/ingestion/modelMatch.ts:45-76,239-292` | Match por padrão + preço por tipo de uso | MIT | `src/core/providers/pricing.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| ClickHouse + Postgres + Redis + S3 | Infra pesada para um app desktop local |
| UI Next.js completa | Produto inteiro; nosso renderer é React/Electron |
| Multi-tenant, RBAC, billing | Não temos contas nem organizations |
| `ee/` (Enterprise) | Licença proprietária; proibido reusar |
| Filas BullMQ e workers | Precisamos de avaliação síncrona/local |
| Mascaramento de ingestão EE | Caminho proprietário; nossa redação já existe |
| Avaliadores de código (Lambda/S3) | Execução remota de código, fora do escopo |
| Datasets versionados com API pública | Complexidade grande para o ganho |

## 12. Modelo de exemplo para o nosso harness

1. **Estender `src/core/observability/service.ts` com spans** — hoje o serviço
   grava `ObservabilityEventInfo` plano (`service.ts:274-287`), sem
   `parentId`, `traceId` ou tipo de span. Criar:
   - `ObservabilitySpanInfo { id, traceId, parentId?, type: 'generation' |
     'tool' | 'agent' | 'span', name, startTs, endTs?, status, usage?,
     cost?, attributes }`.
   - `traceId` = `sessionId` (uma sessão = um trace) e `turnId` = `messageId`,
     mantendo a correlação que já existe em `HarnessEvent`
     (`src/shared/types.ts:309-364`).
2. **`src/core/observability/attributes.ts`** — normalizar nomes no estilo
   Langfuse/OTel (`session.id`, `gen_ai.request.model`,
   `gen_ai.usage.input_tokens`, `langfuse.observation.type`) para que um
   exporter OTLP futuro não precise reescrever o modelo.
3. **`src/core/observability/transcript.ts`** — montar a conversa de um turno a
   partir de `message` + `tool_start`/`tool_end`, com limite de caracteres e
   separação histórico/atual (ideia de `assembleTranscript`).
4. **`src/core/eval/score.ts`** — `Score { name, value, dataType: 'numeric' |
   'categorical' | 'boolean', source: 'api' | 'eval' | 'annotation',
   comment? }`, permitindo que teste automatizado e anotação humana convivam.
5. **`src/core/eval/judge.ts`** — prompt com `{{input}}`, `{{output}}`,
   `{{expected}}`; schema Zod `{ scoreExplanation, score }`; `temperature: 0`;
   custo e tokens registrados no resultado.
6. **Teste** — `tests/observability-spans.test.ts`: um turno com duas tools,
   verificar árvore `root → tool`, custo somado uma única vez, transcript
   ordenado e limite de 10k caracteres.

## 13. Evidências da análise

```text
git rev-parse HEAD
602cbfdfa8d90be214332a049537e6cb75a50cf3

package.json:3-15          versão 4.70.0; MIT; Node 24; pnpm 12.8.2
LICENSE:1-10               MIT fora de ee/; ee/LICENSE é Enterprise
packages/shared/src/domain/traces.ts:12-30        TraceDomain
packages/shared/src/domain/observations.ts:9-33   tipos de observation
packages/shared/src/domain/observations.ts:59-107 ObservationSchema (uso/custo)
packages/shared/src/domain/scores.ts:5-61         fontes e tipos de score
packages/shared/src/server/otel/attributes.ts:5-44 atributos canônicos
packages/shared/src/server/otel/ObservationTypeMapper.ts:256 registry
packages/shared/src/server/otel/OtelIngestionProcessor.ts:532-575,660-709
packages/shared/src/server/evals/llmEvaluatorExecution.ts:29-30,72-160
packages/shared/src/features/evals/outputDefinition.ts:4-8
packages/shared/src/server/transcript/transcript.ts:48-89
packages/shared/src/server/transcript/ordering.ts:13-50
packages/shared/src/domain/dataset-run-items.ts:5-27
packages/shared/src/server/ingestion/modelMatch.ts:45-76,239-292
web/src/pages/api/public/otel/v1/traces/index.ts:29-138
web/src/features/experiments/components/ExperimentBaselineControls.tsx:27-115
worker/src/features/evaluation/deterministicSampling.ts:4-30

contagem: 7.439 arquivos rastreados
          548 testes em web/src; 227 testes em worker/src
```

Não encontrado: fork/checkpoint de trace, execução de ferramentas pelo próprio
Langfuse no caminho OSS e compactação de contexto (o transcript apenas limita
caracteres).
