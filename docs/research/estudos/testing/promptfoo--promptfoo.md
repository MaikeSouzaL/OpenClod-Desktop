# promptfoo

| Campo | Valor |
|---|---|
| Repositório | https://github.com/promptfoo/promptfoo |
| Clone local | `repositorios/_research/testing/promptfoo--promptfoo` |
| Commit | `d7473995939fea50459ac4ec89d4411a8530a07c` (2026-10-25) |
| Licença | MIT (`LICENSE:1`; `package.json:6`) |
| Categoria | testing / avaliação de prompts e agentes |
| Stack | TypeScript ESM, Node >= 22.22 (`package.json:50`), React 19 + Vite na UI (`src/app`), Drizzle + libSQL (`src/database/index.ts:22-23`), Vitest |
| Tamanho | 5.975 arquivos rastreados; 1.676 TS em `src` (420.853 linhas) e 1.149 TS em `test` (540.046 linhas); 1.096 arquivos `*.test.ts` |

## 1. O que é (verificado no código)

CLI e biblioteca de **avaliação de prompts, modelos e agentes**, não um harness
de codificação. O binário `promptfoo`/`pf` (`package.json:52-55`) entra por
`src/entrypoint.ts` e monta o programa Commander em `src/main.ts:71`. Cada
execução transforma uma matriz `prompt × test case × provider` em
`EvaluateResult` com `pass`, `score`, `reason` e tokens (`src/evaluator.ts:1358`).

O núcleo real são três camadas:

1. **Providers** (`src/providers/`, dezenas de APIs e CLIs) devolvem
   `ProviderResponse` com `output`, `tokenUsage`, `cost`, `latencyMs` e `traceId`.
2. **Assertions** (`src/assertions/`, registry em `src/assertions/index.ts:229`)
   convertem saída + trace + custo + latência em `GradingResult`.
3. **Tracing** (`src/tracing/`) cria spans OTEL para a chamada ao modelo, para o
   grader e para o caso de teste (`src/tracing/targetTracer.ts:52,184,280`).

O README promete "testar prompts como código"; o código confirma, mas vai além:
há red team, scan de modelos, receiver OTLP e um servidor web próprio
(`src/server/`, `src/app/`). Nada disso é necessário para usar a biblioteca.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `promptfoo eval -c promptfooconfig.yaml` | `src/main.ts:88`, `src/commands/eval.ts:36-181` | Executa a matriz de avaliação |
| `promptfoo eval --repeat 3 --no-cache` | `src/commands/eval.ts:92-94` | Repete cada caso e ignora cache |
| `promptfoo eval --filter-sample 20 --filter-sample-seed 7` | `src/commands/eval.ts:120-121` | Amostragem reprodutível |
| `promptfoo eval --retry-errors` | `src/commands/eval.ts:156` | Repete somente linhas em erro |
| `promptfoo validate` | `src/commands/validate.ts` | Valida config e assertions |
| `promptfoo generate dataset` | `src/main.ts:104-117`; `src/testCase/synthesis.ts:170` | Sintetiza casos a partir de personas |
| `promptfoo redteam {init,generate,run,report}` | `src/main.ts:124-135` | Red team completo |
| `promptfoo export` / `import` | `src/main.ts:103,106` | Exporta/importa resultados e datasets |
| `promptfoo mcp` | `src/main.ts:92` | Expõe ferramentas do promptfoo por MCP |
| `npm run local -- eval -c ...` | `package.json:90` | Roda o build local |
| `npx vitest run test/tracing` | `src/tracing/AGENTS.md` | Suíte de tracing |

Superfície de configuração: `promptfooconfig.yaml` com `prompts`, `providers`,
`tests`, `defaultTest`, `deriveMetrics`, `tracing`, `redteam`. Flags principais:
`-o/--output` (`src/commands/eval.ts:144`), `--no-cache` (`:94`),
`--repeat` (`:92`), `--delay` (`:93`), `--max-concurrency` (`:89`),
`--grader` (`:165`), `--filter-*` (`:103-126`), `--watch` (`:173`),
`--share` (`:150`).

## 3. Arquitetura e fluxo

```
entrypoint.ts → main.ts (Commander)
  → commands/eval.ts → evaluate()
    → evaluator.runEval()                    evaluator.ts:1759
      → renderRunEvalPrompt()                 evaluator.ts:857
      → callActiveProvider()                  evaluator.ts:1091
        → withTracedProviderCall()            targetTracer.ts:184
      → gradeRunEvalResponse()                evaluator.ts:1532
        → runAssertions()                     assertions/index.ts:757
          → ASSERTION_HANDLERS[type]          assertions/index.ts:229
      → TraceStore (SQLite/libSQL)            database/tables.ts:58-155
```

- Entry point: `src/main.ts:71-135`.
- Loop por caso: `runEvalInternal` em `src/evaluator.ts:1767`; o agendamento
  concorrente fica em `src/scheduler/` (`slotQueue.ts`, `providerCallQueue.ts`).
- Execução de ferramenta: não há loop de ferramentas próprio; ferramentas são
  chamadas pelo provider (agentes externos) e observadas via spans. O
  `agent-rubric` dá ferramentas ao **grader** (`src/prompts/grading.ts:32-55`).
- Streaming: o evaluator não faz streaming de tokens para a UI; providers
  expõem `stream` quando o teste usa `providerOutput`/agente externo. O ponto de
  streaming real é o servidor web (`src/server/`).
- Persistência: `src/database/index.ts` (libSQL) + `src/tracing/store.ts:91`.

## 4. Catálogo de ferramentas / capacidades

| Capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Registry de assertions (~70 tipos) | `src/assertions/index.ts:229-330` | Mapeia tipo → handler | baixo |
| `llm-rubric` | `src/assertions/llmRubric.ts:9`; `src/matchers/llmGrading.ts:181` | Juiz LLM com JSON `{reason,pass,score}` | médio (custo) |
| `agent-rubric` | `src/prompts/grading.ts:32-55` | Juiz com acesso a ferramentas | alto (ação externa) |
| `trajectory:tool-used` | `src/assertions/trajectory.ts:130-172` | Exige/proíbe ferramentas | baixo |
| `trajectory:tool-sequence` | `src/assertions/trajectory.ts:420-492` | Ordem exata ou `in_order` | baixo |
| `trajectory:tool-args-match` | `src/assertions/trajectory.ts:400-550` | Casa argumentos (`partial`/`exact`) | baixo |
| `trajectory:step-count` | `src/assertions/trajectory.ts:555-600` | Limita número de passos | baixo |
| `tool-call-f1` | `src/assertions/toolCallF1.ts:204-260` | Precisão/recall/F1 de nomes de tools | baixo |
| `cost` / `latency` | `src/assertions/cost.ts:3`; `latency.ts:3` | Threshold de custo e ms | baixo |
| `trace-span-count/duration/error` | `src/assertions/index.ts:317-319` | Asserts sobre spans | baixo |
| Receiver OTLP HTTP | `src/tracing/otlpReceiver.ts:272-520` | Aceita JSON/protobuf em `/v1/traces` | médio |
| Export OTLP externo | `src/tracing/otelSdk.ts:96-103` | `BatchSpanProcessor` + OTLP/HTTP | baixo |
| Síntese de dataset | `src/testCase/synthesis.ts:170-311` | Personas → casos | baixo |
| Red team (plugins/strategies) | `src/redteam/plugins`, `strategies` | Ataques e guardrails | alto |

## 5. Loop do agente, contexto e streaming

Não existe "loop do agente" no sentido de um coding agent: o loop é
**avaliação**. Para cada `(prompt, test, provider)`:

1. Renderiza o prompt com Nunjucks e injeta `vars`, `_conversation` e runtime
   vars (`renderRunEvalPrompt`, `src/evaluator.ts:857-896`).
2. Cria workspace efêmero quando o provider é um agente
   (`createAgentWorkspaceForConfig`, `src/evaluator.ts:1839-1844`).
3. Gera contexto de trace e span de teste (`generateTraceContextIfNeeded`,
   `src/evaluator.ts:1847-1860`; `withTestCaseSpan`, `targetTracer.ts:52`).
4. Chama o provider com `delay` e rate limit
   (`callProviderForRunEval`, `src/evaluator.ts:918-1022`).
5. Se o teste tem assertions cientes de trace, faz `flushOtel()` antes de ler
   (`src/evaluator.ts:1582-1588`) e o loader tenta várias vezes até o número de
   spans estabilizar (`loadTraceData`, `src/assertions/index.ts:183-210`).
6. Avalia; se `deferGrading`, agenda a nota em paralelo
   (`src/evaluator.ts:1598-1618`).
7. Acumula tokens/custo em `updateDerivedMetrics`
   (`src/evaluator.ts:2192-2222`).

Contexto: o prompt é sempre re-renderizado por caso; não há compactação de
contexto. Cancelamento vem de `abortSignal`/`pauseSignal`
(`src/evaluator.ts:1790`), e `isGradingAbort` separa cancelamento de erro real
(`src/evaluator.ts:646`). Retry é do provider
(`src/scheduler/retryPolicy.ts:10-37`, backoff exponencial) e de
`--retry-errors` no nível do run.

## 6. Sessões, estado e persistência

- Banco local: `~/.promptfoo/promptfoo.db` (libSQL) via `src/database/index.ts:22-23`.
- Tabelas: `evals` (`src/database/tables.ts:58`), `eval_results` (`:79`),
  `datasets` (`:257`), `tracesTable` e `spansTable` (importadas em
  `src/tracing/store.ts:3`).
- O `TraceStore` grava spans por `traceId` e ignora spans que chegam antes do
  trace existir (`src/tracing/store.ts:148-157`), o que evita órfãos.
- Cache de respostas em `~/.promptfoo/cache` (`src/cache.ts:84`), com namespace
  por `repeatIndex` (`src/evaluator.ts:474-489`).
- Export: JSON/CSV/HTML (`src/commands/export.ts:116`, `src/csv.ts:340`,
  `src/tableOutput.html`); `share` publica um snapshot
  (`src/share.ts:809`).
- Não há fork/checkpoint de sessão de agente; "sessão" aqui é `evalId` +
  `testIdx` + `promptIdx` + `repeatIndex`.

## 7. Configuração e extensibilidade

Precedência: CLI > env > `promptfooconfig.yaml` > defaults
(`src/main.ts:71-88`, `src/commands/eval.ts:36-60`). Extensões:

- Assertions em arquivo (`--assertions`), `assert-set` aninhado
  (`src/assertions/index.ts:153-181`).
- Código do usuário: JavaScript (`src/assertions/javascript.ts:239`), Python
  (`python.ts:8`), Ruby (`ruby.ts:8`), SQL (`sql.ts:134,366`) e webhook
  (`webhook.ts:7`).
- Providers customizados e `transform`/`output` por teste.
- Hooks de tracing: `tracing.provider` externo e receiver OTLP.
- Red team: plugins e strategies registrados em `src/redteam/`.

## 8. Permissões, sandbox e erros

- Assertions `javascript` (`src/assertions/javascript.ts:239`), `python`
  (`python.ts:8`), `ruby` (`ruby.ts:8`) e `webhook` (`webhook.ts:7`)
  **executam código fornecido pelo usuário**. JavaScript usa `new Function`
  com um shim de `process` (`javascript.ts:268-282`); o "safe mode" só bloqueia
  JS inline (`:268-272`). Python roda em processo separado via
  `runPythonCode` (`src/python/wrapper.ts:16-26`). Não há isolamento de
  filesystem/rede no caminho de assertion.
- O grader agêntico recebe ferramentas reais; o prompt manda tratar saída,
  arquivos e web como **evidência não confiável** e não seguir instruções
  (`src/prompts/grading.ts:37`). É mitigação de prompt, não isolamento.
- Falha de grading que não é abort vira erro de linha, não "pass"
  (`src/evaluator.ts:1637-1642`; `src/matchers/llmGrading.ts:256-266`).
- Provider com status não transitório é tratado em `getNonTransientTargetStatus`
  (`src/evaluator.ts:685`), evitando retry infinito.
- O receiver OTLP limita corpo e formato e devolve `415`/`400` explícitos
  (`src/tracing/otlpReceiver.ts:389-460,655-656`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Assertions | `test/assertions/` (inclui `trajectory.test.ts`, `trace.test.ts`) | contrato de cada handler |
| Matchers | `test/matchers/` | rubrica, RAG, similaridade |
| Evaluator | `test/evaluator/` | matriz, cache, grading, trace-integration |
| Tracing | `test/tracing/` | SDK, receiver, store, sanitização |
| Scheduler | `test/scheduler/` | concorrência, rate limit, retry |
| Red team | `test/redteam/` | plugins, strategies, guardrails |
| App/UI | `src/app/**/*.test.tsx` | React |

Total: 1.096 arquivos `*.test.ts` em `test/` (mais testes dentro de `src/app`).
Qualidade: Biome + Prettier, Knip no CI (`package.json:82`), `tsc`, Vitest. O CI
falha por código morto (Knip) e por limite arquitetural
(`package.json:59`, `scripts/checkArchitectureBoundaries.ts`).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Assertions de trajetória | `src/assertions/trajectory.ts:130-600` | Cobre ferramenta usada, ordem, args e contagem — exatamente o que falta no nosso harness | MIT | `src/core/eval/assertions/trajectory.ts` | 24 |
| Contrato `GradingResult` + registry | `src/assertions/index.ts:229-330`; `src/types/index.ts:546` | Um registry tipado evita `if` gigante e padroniza reason/score/tokens | MIT | `src/core/eval/assertions/index.ts` | 22 |
| Rubrica LLM com JSON estrito e exemplos | `src/prompts/grading.ts:11-30`; `src/matchers/llmGrading.ts:181-267` | Prompt curto, saída validável, exemplos positivos/negativos | MIT | `src/core/eval/judge/prompt.ts` | 21 |
| Split uso/custo e thresholds | `src/assertions/cost.ts:3-28`; `latency.ts:3-27` | Regras objetivas de orçamento e latência por caso | MIT | `src/core/eval/assertions/budget.ts` | 20 |
| Loader de trace com polling estabilizado | `src/assertions/index.ts:183-210` | Tolera trace assíncrono sem flake | MIT | `src/core/observability/trace-loader.ts` | 19 |
| Role de span (`target`/`grader`) + filtro | `src/tracing/targetTracer.ts:280-317`; `spanFilter.ts:15-39` | Impede que spans do juiz poluam a trajetória avaliada | MIT | `src/core/observability/span-roles.ts` | 19 |
| Receiver OTLP tolerante | `src/tracing/otlpReceiver.ts:272-520` | JSON e protobuf, limites, `partialSuccess` | MIT | `src/core/observability/otlp-receiver.ts` | 18 |
| Init OTEL com local + externo e shutdown | `src/tracing/otelSdk.ts:55-213` | Padrão correto de flush em `beforeExit` | MIT | `src/core/observability/otel.ts` | 18 |
| Síntese de dataset por personas | `src/testCase/synthesis.ts:170-311` | Gera casos a partir de prompts reais | MIT | `src/core/eval/dataset/synthesize.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| UI React de avaliação (`src/app`) | Produto inteiro; nosso renderer tem outro modelo |
| Servidor Express + OpenAPI (`src/server`) | Não precisamos de API pública de eval agora |
| Red team completo (`src/redteam`) | Grande, acoplado a providers e ao servidor; importar só ideias |
| 60+ providers | Já temos camada própria de providers |
| Drizzle/libSQL e schema de 20 tabelas | Nosso estado é JSONL + memória de projeto |
| Nunjucks como engine de prompt | Duplicaria nosso renderer e cria SSTI se mal usado |
| `tool-call-f1` como métrica principal | F1 de nomes é grosseiro; trajetória por passos é melhor |
| OTel 2.x (`package.json:297-301`, overrides em `:139-160`) | Em out/2026 o 3.0 já existe e removeu `sdk-trace-node` |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem inventar código:

1. **`src/core/eval/types.ts`** — `EvalCase { id, input, expected?, tags? }`,
   `EvalAssertion` (união discriminada), `EvalResult { caseId, pass, score,
   reason, tokens, costUsd, latencyMs, traceId }`, `TrajectoryStep { type,
   name, args, ok, durationMs }`.
2. **`src/core/eval/run.ts`** — recebe `RunnerDeps` (já existe em
   `src/core/agent/runner.ts:182`) e um provider; para cada caso, cria sessão
   temporária, assina `HarnessEvent`, converte `tool_start`/`tool_end`/`usage`
   em `TrajectoryStep` e fecha com `turn_end`.
3. **`src/core/eval/assertions/`** — registry com: `equals`, `contains`,
   `regex`, `json`, `cost`, `latency`, `tool-used`, `tool-sequence`,
   `tool-args-match`, `step-count`, `llm-rubric`. Cada handler devolve
   `{ pass, score, reason }`; erro de handler vira `error`, nunca `pass`.
4. **`src/core/eval/judge.ts`** — prompt de sistema curto com JSON
   `{reason, pass, score}`, `temperature: 0`, `maxTokens` baixo, timeout e
   orçamento por execução; valida com Zod e rejeita saída fora do schema.
5. **`src/core/eval/report.ts`** — grava `eval-runs/<timestamp>.json` com
   resultados + agregados (pass rate, p50/p95 de latência, custo total) e
   imprime tabela; exit code 1 se algum caso falhar.
6. **Testes** — usar `ScriptedProvider` (`src/core/providers/mock.ts:23`, já
   usado em `tests/runner.test.ts:4`) para trajetórias determinísticas: chamada
   de tool proibida, ordem errada, args parciais, loop de 3 passos, custo acima
   do limite. Sem chamada de rede no CI.
7. **Integração com observabilidade** — `EvalResult.traceId` deve ser o mesmo
   `sessionId`/`turnId` do `ObservabilityService` (`src/core/observability/service.ts:274-287`),
   para que a falha de eval abra o turno exato no visualizador.

Ordem sugerida: tipos + runner com ScriptedProvider → assertions
determinísticas → custo/latência → juiz LLM → trajetória sobre traces reais.

## 13. Evidências da análise

```text
git -C ... rev-parse HEAD
d7473995939fea50459ac4ec89d4411a8530a07c

package.json:5-6        "version": "0.125.1"; "license": "MIT"
src/main.ts:71-135      Commander + comandos eval/redteam/generate/validate
src/commands/eval.ts:92-95   --repeat / --delay / --no-cache
src/evaluator.ts:1759   export async function runEval
src/evaluator.ts:1532   gradeRunEvalResponse
src/evaluator.ts:1582-1588  flushOtel antes de assertions de trace
src/evaluator.ts:1699-1725  validação de traceparent
src/assertions/index.ts:229-330  ASSERTION_HANDLERS
src/assertions/index.ts:183-210  loadTraceData com polling estabilizado
src/assertions/trajectory.ts:420-492  tool-sequence exact/in_order
src/prompts/grading.ts:11-30    DEFAULT_GRADING_PROMPT
src/prompts/grading.ts:32-55    DEFAULT_AGENT_GRADING_PROMPT
src/tracing/otelSdk.ts:55-103   NodeTracerProvider + LocalSpanExporter + OTLP
src/tracing/otlpReceiver.ts:389-460  POST /v1/traces, 10mb, 415/400
src/tracing/store.ts:91-157     TraceStore.addSpans
src/assertions/cost.ts:3-28     threshold de custo
src/assertions/latency.ts:3-27  threshold de latência

contagem: 1.676 arquivos TS em src / 420.853 linhas
          1.149 arquivos TS em test / 540.046 linhas
          1.096 arquivos *.test.ts
```

Não encontrado: compactação de contexto, fork de sessão, checkpoint de agente e
streaming de tokens dentro do evaluator (o streaming existe apenas nos
providers/server, não como recurso do loop de avaliação).
