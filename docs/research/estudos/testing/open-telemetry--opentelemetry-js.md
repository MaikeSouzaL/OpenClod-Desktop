# OpenTelemetry JS

| Campo | Valor |
|---|---|
| Repositório | https://github.com/open-telemetry/opentelemetry-js |
| Clone local | `repositorios/_research/testing/open-telemetry--opentelemetry-js` |
| Commit | `44be44c2ed8a1e0fb0fd06a2142fca49c0ebbec3` (2026-10-22) |
| Licença | Apache-2.0 (`LICENSE:1`; `package.json:53`) |
| Categoria | testing / observabilidade (SDK e protocolo) |
| Stack | TypeScript, monorepo Nx, npm workspaces, Mocha + Karma + NYC, protobuf via submodule (`experimental/packages/otlp-transformer/protos`) |
| Tamanho | 1.533 arquivos rastreados; 899 arquivos TS em `packages/`, `api/` e `experimental/` (110.384 linhas); 248 arquivos `*.test.ts` |

## 1. O que é (verificado no código)

Implementação de referência em JavaScript/TypeScript da **API e do SDK do
OpenTelemetry**: traces, métricas, logs, propagação de contexto, recursos,
amostragem e exporters OTLP. É a biblioteca que outros projetos (Langfuse,
promptfoo, Vercel AI SDK) usam para produzir spans.

O clone está no meio da transição para o **SDK 3.x** (out/2026). Os pacotes
antigos `opentelemetry-sdk-trace-base`, `-node` e `-web` foram **removidos** e
substituídos por `@opentelemetry/sdk-trace` 3.0.0
(`packages/opentelemetry-sdk-trace-base/README.md:1-6`;
`packages/sdk-trace/package.json:3`). O guia de migração diz que o 2.x será
suportado por um ano a partir do 3.0.0 (`doc/3.x/migration-guide.md:3,16`).

Isso importa: promptfoo ainda está na linha 2.x
(`promptfoo/package.json:301`, `sdk-trace-node ^2.6.0`) e fixa o core 2.12.0
nos overrides (`:139-160`); qualquer código novo nosso deve nascer no 3.x.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm test` | `package.json:13` | `nx run-many -t test` em todos os pacotes |
| `npm run test:browser` | `package.json:15` | Karma/Chrome nos pacotes web |
| `npm run test:webworker` | `package.json:16` | Testes em Web Worker |
| `npm run test:bench` | `package.json:17` | Benchmarks |
| `npm run compile` | `package.json:8` | Build de todos os pacotes |
| `npm run lint` | `package.json:24` | ESLint + markdown + semconv + knip |
| `npm run submodule` | `package.json:11` | Inicializa o submodule do proto |
| `npm run docs` | `package.json:21` | Typedoc |
| `npm run test:scripts` | `package.json:32` | Testes dos scripts de release |
| exemplos | `examples/`, `experimental/examples/` | Apps Node/browser |

Não há CLI de produto: é biblioteca. A superfície é a API pública de cada
pacote (`TracerProvider`, `BatchSpanProcessor`, `OTLPTraceExporter`,
`W3CTraceContextPropagator`, `NodeSDK`).

## 3. Arquitetura e fluxo

```
@opentelemetry/api (no-op / proxy global)
  → TracerProvider                              packages/sdk-trace/src/TracerProvider.ts
    → Tracer.startSpan()                        Tracer.ts
      → Sampler (ParentBased/AlwaysOn/...)      sampler/
      → Span (atributos, eventos, links)        Span.ts
    → SpanProcessor                            SpanProcessor.ts
      → BatchSpanProcessorBase                 export/BatchSpanProcessorBase.ts
        → SpanExporter (OTLP/HTTP/proto/zipkin) export/
          → Collector / backend
```

- Entry point da API: `api/src/index.ts` (re-exporta trace, metrics, logs,
  context, propagation, diag).
- Provider: `packages/sdk-trace/src/TracerProvider.ts:54-70`.
- Processador em lote: `packages/sdk-trace/src/export/BatchSpanProcessorBase.ts:26-70`.
- Export OTLP HTTP: `experimental/packages/exporter-trace-otlp-http`;
  transporte em `experimental/packages/otlp-exporter-base/src/platform/node/transport/http-transport-utils.ts`.
- Serialização: `experimental/packages/otlp-transformer/src/trace/{json,protobuf}`.
- Contexto e propagação: `packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts`.
- Auto-configuração: `experimental/packages/opentelemetry-sdk-node/src/sdk.ts` e
  `create-from-env.ts`.

## 4. Catálogo de ferramentas / capacidades

| Capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| API de trace | `api/src/api/trace.ts` | `trace.getTracer`, spans, context | baixo |
| SDK de trace | `packages/sdk-trace/src/index.ts` | Provider, Tracer, Span, samplers | baixo |
| Batch processor | `packages/sdk-trace/src/export/BatchSpanProcessorBase.ts:26-257` | Fila, lote, timeout, flush, shutdown | baixo |
| Simple processor | `packages/sdk-trace/src/export/SimpleSpanProcessor.ts` | Exporta no `end()` | baixo |
| Export OTLP/HTTP | `experimental/packages/otlp-exporter-base/src/otlp-http-export-delegate.ts` | POST `/v1/traces` com gzip | baixo |
| Serializer protobuf | `experimental/packages/otlp-transformer/src/trace/protobuf/` | `ExportTraceServiceRequest` | baixo |
| Serializer JSON | `experimental/packages/otlp-transformer/src/trace/json/` | Variante JSON do OTLP | baixo |
| Retry de export | `experimental/packages/otlp-exporter-base/src/retrying-transport.ts:10-103` | Backoff, jitter, deadline, `Retry-After` | baixo |
| Propagador W3C | `packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts:20-100` | `traceparent`/`tracestate` | baixo |
| Samplers | `packages/sdk-trace/src/sampler/` | AlwaysOn/Off, ParentBased, TraceIdRatio | baixo |
| Recursos | `packages/opentelemetry-resources/src/` | `service.name`, host, processo, env | baixo |
| Métricas | `packages/sdk-metrics/src/` | Counter, Histogram, Observable | baixo |
| Logs | `packages/sdk-logs/src/` | LoggerProvider, LogRecord | baixo |
| NodeSDK | `experimental/packages/opentelemetry-sdk-node/src/sdk.ts:1-90` | Junta traces, métricas, logs e env | médio |
| Instrumentação HTTP | `experimental/packages/opentelemetry-instrumentation-http` | Spans automáticos de HTTP | médio |
| Exporters alternativos | `packages/opentelemetry-exporter-zipkin`, `experimental/.../exporter-prometheus` | Zipkin e Prometheus | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente. O ciclo de vida relevante é o do **span**:

1. `Tracer.startSpan()` consulta o sampler; `ParentBasedSampler` decide pelo
   pai quando existe (`packages/sdk-trace/src/sampler/ParentBasedSampler.ts`).
2. `Span` aplica limites de atributos em `setAttribute` (`Span.ts:167-189`),
   de eventos em `addEvent` (`:217-233`) e de links no construtor
   (`:141-151`), incrementando contadores de descarte.
3. Ao final, `Span.end()` entrega um `ReadableSpan` ao processor
   (`Span.ts:340-347` mostra o log de descartes).
4. `BatchSpanProcessor` enfileira até `maxQueueSize` (2048), descarta o excedente
   e conta (`BatchSpanProcessorBase.ts:114-132`), dispara por lote
   (`maxExportBatchSize` 512) ou por tempo (`scheduledDelayMillis` 5000)
   (`:45-48,223-247`).
5. `forceFlush` esvazia em lotes e respeita `exportTimeoutMillis` (30000)
   (`:72-77,143-170`).
6. `shutdown` faz flush e desliga o exporter (`:94-110`).

Contexto: `AsyncLocalStorage` no Node (`packages/opentelemetry-context-async-hooks`)
ou Zone.js no browser. Streaming não existe; spans são imutáveis após `end()`.

## 6. Sessões, estado e persistência

- O SDK é **stateless por design**: o único estado é a fila do
  `BatchSpanProcessor` e o `Context` ambiente.
- Não há sessão, turno ou banco. Persistência é responsabilidade do backend.
- Em processo, `InMemorySpanExporter` (`export/InMemorySpanExporter.ts`) serve
  para testes.
- `resource` carrega `service.name`, `service.version` e atributos de host
  (`packages/opentelemetry-resources/src/`), mas não identifica sessão de
  usuário — isso é convenção (`session.id`) e não API.
- Shutdown gracioso: `NodeSDK.shutdown()`
  (`experimental/packages/opentelemetry-sdk-node/src/sdk.ts:351`) e `start()`
  (`:236`).

## 7. Configuração e extensibilidade

Configuração por variáveis de ambiente, com precedência usuário > env > default
(`experimental/packages/otlp-exporter-base/src/configuration/`):

| Variável | Efeito | Onde |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | URL base do collector | `shared-env-configuration.ts` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | URL específica de traces | idem |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Timeout de export (ms) | `shared-env-configuration.ts:27-30` |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `gzip` ou `none` | `:55-58` |
| `OTEL_TRACES_SAMPLER` | `always_on`, `parentbased_traceidratio` etc. | `sdk-node/src/create-from-env.ts:32-57` |
| `OTEL_TRACES_SAMPLER_ARG` | Razão [0,1] | `:64-79` |
| `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` | Limite de atributos | `:85-96` |
| `OTEL_BSP_MAX_QUEUE_SIZE` | Fila do batch | `:108` |
| `OTEL_BSP_SCHEDULE_DELAY` | Intervalo de flush | `:110` |
| `OTEL_BSP_EXPORT_TIMEOUT` | Timeout por export | `:112` |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Tamanho do lote | `:114` |
| `OTEL_SERVICE_NAME` | `service.name` | `resources` |

Extensibilidade: `SpanExporter`, `SpanProcessor`, `Sampler`, `IdGenerator`,
`ResourceDetector` e `TextMapPropagator` são interfaces públicas. É possível
plugá-las sem fork.

## 8. Permissões, sandbox e erros

- Não há sandbox nem permissões: a biblioteca roda no processo do host.
- Erros de export não derrubam o app; vão para `globalErrorHandler`
  (`packages/sdk-trace/src/export/BatchSpanProcessorBase.ts:214-216,235-237`).
- Retry somente para `429`, `502`, `503`, `504`
  (`experimental/packages/otlp-exporter-base/src/is-export-retryable.ts:6-13`),
  com `Retry-After` em segundos ou data (`:15-33`).
- Backoff: 5 tentativas, 1s inicial, fator 1,5, teto 5s, jitter ±20%, e desiste
  se o próximo retry passa do deadline
  (`retrying-transport.ts:10-14,42-73`).
- Resposta 2xx é sucesso; corpo grande é descartado como erro não
  retentável (`http-transport-utils.ts:71-101`).
- Atributos sensíveis: o SDK **não redige** nada. Redação é responsabilidade de
  quem cria o span (nós).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| SDK trace | `packages/sdk-trace/test/` | span, sampler, batch, limites |
| Core/propagadores | `packages/opentelemetry-core/test/` | W3C, baggage, composite |
| Recursos | `packages/opentelemetry-resources/test/` | detectores e merge |
| Métricas | `packages/sdk-metrics/test/` | instrumentos, readers, views |
| Logs | `packages/sdk-logs/test/` | processor e exporter |
| OTLP | `experimental/packages/otlp-exporter-base/test/` | retry, gzip, timeout, headers |
| Transformer | `experimental/packages/otlp-transformer/test/` | protobuf/JSON round-trip |
| NodeSDK | `experimental/packages/opentelemetry-sdk-node/test/` | env, sinais, shutdown |
| E2E | `e2e-tests/`, `integration-tests/`, `bundler-tests/` | apps reais e bundlers |

248 arquivos `*.test.ts`; Mocha no Node, Karma no browser, NYC para cobertura,
Nx para orquestração. Qualidade: ESLint 10, `knip`, `linkinator` para docs,
`verify-pack` para o pacote publicado.

## 10. O que vale portar

**Recomendação central: usar como dependência, não portar.** O SDK é grande,
maduro e versionado; copiar código criaria dívida de manutenção. Ainda assim,
os padrões abaixo valem reimplementação pontual se decidirmos não depender:

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Política de retry de export | `experimental/packages/otlp-exporter-base/src/retrying-transport.ts:10-103` + `is-export-retryable.ts:6-33` | 5 tentativas, jitter, deadline e `Retry-After` — pronto para produção | Apache-2.0 | dependência (`@opentelemetry/*`) | 24 |
| Batch processor com fila limitada | `packages/sdk-trace/src/export/BatchSpanProcessorBase.ts:45-247` | Descarte contado, flush em lotes, timer `unref` | Apache-2.0 | dependência | 23 |
| Validação de `traceparent` | `packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts:20-53` | Regex compatível com versões futuras e rejeição de zeros | Apache-2.0 | `src/core/observability/traceparent.ts` (se não usar o SDK) | 22 |
| Limites de span + contadores de descarte | `packages/sdk-trace/src/TracerProvider.ts:59-70`; `Span.ts:141-151,340-347` | Impede span gigante e torna descarte observável | Apache-2.0 | dependência | 21 |
| Gzip e content-type no exporter | `experimental/packages/otlp-exporter-base/src/platform/node/transport/http-transport-utils.ts:41-178` | Detalhes fáceis de errar (headers, `Content-Encoding`) | Apache-2.0 | dependência | 20 |
| Config por env (`OTEL_*`) | `experimental/packages/opentelemetry-sdk-node/src/create-from-env.ts:32-114` | Interoperável com qualquer collector | Apache-2.0 | `src/core/observability/config.ts` | 19 |
| Samplers parent-based/ratio | `packages/sdk-trace/src/sampler/` | Evita trace quebrado e controla custo | Apache-2.0 | dependência | 18 |
| Serializer protobuf OTLP | `experimental/packages/otlp-transformer/src/trace/protobuf/` | Binário menor que JSON e padrão de mercado | Apache-2.0 | dependência | 18 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Copiar o SDK inteiro | ~110k linhas, 248 suítes; manutenção inviável |
| API de métricas e logs | Não usamos ainda; dependência pesada sem retorno |
| Instrumentações automáticas (HTTP/GRPC/fetch) | Criariam spans fora do nosso modelo de sessão |
| `NodeSDK` como dependência obrigatória | Ele puxa exporters gRPC/Prometheus; usar `sdk-trace` + um exporter |
| Pacotes 2.x (`sdk-trace-base/node/web`) | Removidos no 3.x; não criar código novo neles |
| Zipkin/Prometheus exporters | Fora do nosso caso OTLP |
| Testes Karma/browser | Stack diferente da nossa (Vitest/Electron) |
| Protobuf gerado à mão | Usar `otlp-transformer` pronto |

## 12. Modelo de exemplo para o nosso harness

1. **Dependências** (no `package.json` do main, não do renderer):
   `@opentelemetry/api`, `@opentelemetry/sdk-trace` 3.x,
   `@opentelemetry/exporter-trace-otlp-proto` (ou `-http`),
   `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`.
2. **`src/core/observability/otel.ts`** — inicialização preguiçosa, opt-in:
   - `enabled` só quando `OPENCLOD_OTEL_ENDPOINT` existe;
   - `BatchSpanProcessor` com `maxQueueSize: 2048`,
     `maxExportBatchSize: 512`, `scheduledDelayMillis: 5000`,
     `exportTimeoutMillis: 30000` (mesmos defaults do SDK, explícitos);
   - `resource` com `service.name=openclod`, `service.version` e
     `deployment.environment`;
   - `shutdown` no `before-quit` do Electron e `forceFlush` no fim de cada turno
     quando o eval depende de trace.
3. **`src/core/observability/span-map.ts`** — traduzir `HarnessEvent` em spans:
   - `turn_start` → span raiz `chat.turn` (`traceId` derivado de `sessionId`);
   - `tool_start` → span filho `tool.<name>` com atributos
     `gen_ai.tool.name`, `gen_ai.tool.call.id`, `openclod.tool.risk`;
   - `usage` → atributos `gen_ai.usage.input_tokens`,
     `gen_ai.usage.output_tokens`, `openclod.cost.usd`;
   - `subagent` → span `agent.<name>` com `parentChildId` como parent.
4. **Redação antes do export** — um `SpanProcessor` próprio que aplica
   `redactDiagnosticText` (`src/core/observability/service.ts:80-92`) em
   `input`/`output`/`tool.args`, mantendo o JSONL local como fallback quando não
   há collector.
5. **Teste** — `tests/observability-otel.test.ts` com
   `InMemorySpanExporter` (do próprio SDK): dois turnos, três tools, um erro;
   verificar hierarquia, atributos de uso e que nenhum segredo sai no payload.

Ordem: dependência + `otel.ts` opt-in → `span-map.ts` → redação → teste com
exporter em memória → só então avaliar collector externo.

## 13. Evidências da análise

```text
git rev-parse HEAD
44be44c2ed8a1e0fb0fd06a2142fca49c0ebbec3

package.json:8-32               scripts nx (compile, test, test:browser, lint)
doc/3.x/migration-guide.md:3    release do SDK 3.x em outubro/2026
doc/3.x/migration-guide.md:16   2.x suportado por 1 ano
packages/sdk-trace/package.json:3            @opentelemetry/sdk-trace 3.0.0
packages/opentelemetry-sdk-trace-base/README.md:1-6  pacote removido
packages/sdk-trace/src/TracerProvider.ts:54-70       sampler + span limits
packages/sdk-trace/src/export/BatchSpanProcessorBase.ts:45-48,114-132,143-170,223-247
packages/sdk-trace/src/Span.ts:141-151,217-233,340-347
experimental/packages/otlp-exporter-base/src/retrying-transport.ts:10-14,42-88
experimental/packages/otlp-exporter-base/src/is-export-retryable.ts:6-33
experimental/packages/otlp-exporter-base/src/platform/node/transport/http-transport-utils.ts:41-178
experimental/packages/opentelemetry-sdk-node/src/create-from-env.ts:32-114
packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts:20-53

contagem: 1.533 arquivos rastreados
          899 arquivos TS (110.384 linhas)
          248 arquivos *.test.ts
```

Não encontrado: persistência de sessão, redação de atributos, amostragem por
usuário e qualquer noção de "turno" — o SDK trata apenas spans e contexto.
