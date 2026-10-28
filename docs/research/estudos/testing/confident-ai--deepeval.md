# DeepEval

| Campo | Valor |
|---|---|
| Repositório | https://github.com/confident-ai/deepeval |
| Clone local | `repositorios/_research/testing/confident-ai--deepeval` |
| Commit | `5410e3822dda5f889d5f35de3325a3738004aeb1` (2026-10-23) |
| Licença | Apache-2.0 (`LICENSE.md:1`; `pyproject.toml:6`) |
| Categoria | testing / avaliação de LLM e agentes |
| Stack | Python >= 3.9 (`pyproject.toml:19`), pytest + pytest-xdist, pydantic v2, Typer/Rich, OpenTelemetry API/SDK (`pyproject.toml:38-39`) |
| Tamanho | 3.181 arquivos rastreados; 669 arquivos `.py` em `deepeval/` (109.533 linhas); 457 arquivos de teste (67.334 linhas) |

## 1. O que é (verificado no código)

Framework Python de avaliação de LLM, **nativo de pytest**. O entrypoint é o
console script `deepeval = deepeval.cli.main:app` (`pyproject.toml:12-13`), e a
API de biblioteca é `evaluate(...)` (`deepeval/evaluate/evaluate.py:212`) e
`assert_test(...)` (`:84`), que levanta `AssertionError` quando uma métrica
falha (`:209`).

O modelo central é: `LLMTestCase` + lista de métricas → cada métrica produz
`score`, `reason`, `success`, custo e tokens (`deepeval/metrics/base_metric.py:111-131`).
O plugin de pytest (`deepeval/plugins/plugin.py:86-124`) agrupa os resultados em
um **test run**, salvo localmente e, opcionalmente, enviado ao Confident AI.

O diferencial em relação a um eval genérico é a **coleção de métricas agênticas
determinísticas**: correção de ferramentas, aderência a plano, eficiência de
passos, detecção de loop e conclusão de tarefa a partir de traces. Não é um
harness de codificação; é uma camada de medição que consome traces de agentes.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `deepeval test run <arquivo|dir>` | `deepeval/cli/test/command.py:44-114` | Roda testes pytest com métricas |
| `deepeval test run -x -r 3 --num-processes 4` | `deepeval/cli/test/command.py:54-71` | Para no primeiro erro, repete, paraleliza |
| `deepeval test run --ignore-errors --skip-on-missing-params` | `deepeval/cli/test/command.py:83-89` | Tolerância a falhas de métrica e params |
| `python -m deepeval` / `deepeval` | `deepeval/cli/main.py:104-123` | CLI Typer |
| `deepeval login` / `logout` | `deepeval/cli/main.py:60-66` | Associa ao Confident AI |
| `deepeval gate` | `deepeval/cli/main.py:343-398` | Gate de governança (nuvem), exit 1 se falhar |
| `deepeval generate` | `deepeval/cli/main.py:61` | Gera casos sintéticos |
| `deepeval inspect` | `deepeval/cli/main.py:62` | TUI de inspeção (extra `inspect`) |
| `deepeval set-local-store json|sqlite` | `deepeval/cli/main.py:167-214` | Escolhe persistência local |
| `deepeval set-eval-mode llm|hybrid|system_one` | `deepeval/cli/main.py:265-327` | Modo de decisão das métricas |
| `pytest` | `pyproject.toml:15-17` | Plugin registrado como `pytest11` |

## 3. Arquitetura e fluxo

```
CLI / pytest / library
  → evaluate(test_cases, metrics)          evaluate.py:212
    → execute_test_cases / a_execute_...   execute/e2e.py:144,483
      → metric.measure(test_case)          base_metric.py:153
        → prompt (template)                metrics/*/schema.py
        → modelo juiz                      models/
        → pydantic schema                  metrics/utils.py
        → score / reason / success         base_metric.py:172-182
    → TestRunManager                       test_run/test_run.py
      → .deepeval/.latest_run_full.json    test_run.py:64-67
      → API Confident AI (opcional)        confident/api.py
```

- Entry point CLI: `deepeval/cli/main.py:104`.
- Loop de avaliação: `a_execute_test_cases` em
  `deepeval/evaluate/execute/e2e.py:483`; concorrência limitada por
  `asyncio.Semaphore(async_config.max_concurrent)` (`:501`).
- Execução de "ferramenta": o framework **não executa** ferramentas; lê
  `tools_called`/`expected_tools` do caso ou spans `tool` do trace
  (`deepeval/metrics/tool_correctness/tool_correctness.py:117-118`;
  `agent_loop_detection.py:223`).
- Streaming: não há; a avaliação é batch.
- Persistência: `TestRunManager` (`deepeval/test_run/test_run.py:504-600`).

## 4. Catálogo de ferramentas / capacidades

| Capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `ToolCorrectnessMetric` | `metrics/tool_correctness/tool_correctness.py:43-136` | Compara tools chamadas × esperadas (exato, ordem, parcial) | baixo |
| `AgentLoopDetectionMetric` | `metrics/agent_loop_detection/agent_loop_detection.py:65-258` | Detecta repetição, estagnação e ciclos | baixo |
| `TaskCompletionMetric` | `metrics/task_completion/task_completion.py:47-135` | Juiz sobre tarefa + outcome + trace | médio |
| `PlanAdherenceMetric` | `metrics/plan_adherence/plan_adherence.py:49` | Aderência ao plano | médio |
| `StepEfficiencyMetric` | `metrics/step_efficiency/step_efficiency.py:41` | Passos desperdiçados | médio |
| `ArgumentCorrectnessMetric` | `metrics/argument_correctness/argument_correctness.py:41` | Args de tool corretos | médio |
| `MCPTaskCompletionMetric` | `metrics/mcp/mcp_task_completion.py:45-131` | Tarefas multi-turn com servidores MCP | médio |
| Métricas RAG | `metrics/faithfulness/faithfulness.py:66`, `contextual_*`, `answer_relevancy` | Fidelidade, recall, precisão | médio |
| Métricas de segurança | `metrics/bias/bias.py:42`, `toxicity`, `pii_leakage`, `misuse` | Viés, toxicidade, PII | médio |
| Métricas conversacionais | `metrics/turn_relevancy/turn_relevancy.py:41`, `conversation_completeness` | Avaliação por turno | médio |
| Arena GEval | `metrics/arena_g_eval`, `evaluate/compare.py:48` | Compara duas saídas | médio |
| Tracing `@observe` | `tracing/tracing.py`; `tracing/otel/exporter.py:100` | Span exporter para o test case | baixo |
| Dataset + Synthesizer | `dataset/dataset.py:92`; `synthesizer/synthesizer.py:118` | CSV/JSON/JSONL e geração | baixo |

## 5. Loop do agente, contexto e streaming

Não há loop de agente. O "loop" é o pipeline de uma métrica:

1. Cada métrica concreta implementa `measure`/`a_measure` e decide o caminho
   assíncrono (`task_completion.py:97-135`); `BaseMetric` só define o contrato
   e `is_successful` (`base_metric.py:152-182`).
2. A métrica monta um prompt a partir de templates
   (`metrics/*/schema.py`, `templates/`) e chama o modelo juiz.
3. A resposta é validada por schema Pydantic e convertida em
   `score`/`reason` (`base_metric.py:173-182`).
4. `is_successful` compara `score >= threshold`; erro ⇒ `False`
   (`base_metric.py:172-182`). `strict_mode` zera scores abaixo do threshold
   (`tool_correctness.py:73,133-135`).
5. Custo e tokens são acumulados por métrica
   (`base_metric.py:188-204`).

Contexto: cada métrica recebe o caso inteiro (input, output, contexto,
retrieval, tools, trace). Não há compactação; traces grandes são compactados
por `compact_trace` antes do juiz (`task_completion.py:14,210-222`).

Retry: políticas em `deepeval/models/retry_policy.py`, usadas pelo executor
(`execute/e2e.py:52`). Cancelamento: não há `AbortSignal`; o controle é
`max_concurrent`, `ignore_errors` e timeout por chamada.

## 6. Sessões, estado e persistência

- Diretório oculto `.deepeval/` (`deepeval/constants.py`, citado em
  `test_run/test_run.py:64-67`).
- `LATEST_TEST_RUN_FILE_PATH = .deepeval/.latest_test_run.json` e
  `LATEST_FULL_TEST_RUN_FILE_PATH = .deepeval/.latest_run_full.json`
  (`test_run.py:65-67`).
- `DEEPEVAL_LOCAL_STORE=json` grava snapshot rolante + arquivo com timestamp;
  `sqlite` grava `deepeval.db` (`test_run.py:1064-1074`).
- Cache de métricas em `.deepeval/.deepeval-cache.json`
  (`test_run/cache.py:40-41`), com chave derivada de um dict serializado do caso
  (`cache.py:146-170`). Isso é o que evita repagar o juiz em re-runs.
- Dataset com alias/versão (`dataset/dataset.py:92-115,166-168`), mas sem fork
  de sessão de agente.
- `test_runs` guardam métricas, custo, tokens e `hyperparameters`
  (`test_run/test_run.py:443-470`).

## 7. Configuração e extensibilidade

- `pyproject.toml` + variáveis de ambiente (`DEEPEVAL_*`,
  `deepeval/config/settings.py:295`); `.env.example` lista as chaves.
- Métrica customizada: subclasse de `BaseMetric` ou `BaseConversationalMetric`
  implementando `measure`/`a_measure` (`base_metric.py:152-170`).
- Modelo juiz: wrappers em `deepeval/models/` e `model_integrations/`
  (OpenAI, Anthropic, Gemini, Ollama, etc.).
- Tracing: decorator `@observe` (`tracing/tracing.py:1408`) e `with trace(...)`;
  exporter OTel próprio (`tracing/otel/exporter.py:100`).
- Plugin pytest: coleta resultados e fecha o run
  (`plugins/plugin.py:86-124`).
- `EvaluationDataset` carrega CSV/JSON/JSONL e mantém alias/versão
  (`dataset/dataset.py:79,92,270,418`).

## 8. Permissões, sandbox e erros

- Não há sandbox: o framework só lê dados e chama APIs de modelo.
- Erros de métrica podem ser ignorados (`error_config.ignore_errors`) ou
  propagados (`evaluate/execute/e2e.py:414,817`).
- Caso marcado `flaky` não bloqueia o CI: emite warning em vez de
  `AssertionError` (`evaluate.py:201-209`).
- `gate` e o envio ao Confident AI exigem API key e assinatura de governança;
  falham com exit code 1 (`cli/main.py:360-398`).
- Dados sensíveis: o exporter envia traces e métricas para a nuvem quando
  logado; não encontrado mascaramento/redação equivalente ao nosso
  `redactDiagnosticText` no caminho de export local.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Métricas | `tests/test_metrics/` | cada métrica, incluindo agenticas |
| Avaliação | `tests/test_evaluate/` | runner, compare, expectativas |
| Dataset | `tests/test_dataset/` | CSV/JSON/JSONL, alias/versão |
| Tracing | `tests/test_tracing/` | `@observe`, exporter, spans |
| Sintetizador | `tests/test_synthesizer/` | evoluções e contextos |
| Integrações | `tests/test_integrations/` | LangChain, CrewAI, PydanticAI, OpenAI Agents |

457 arquivos de teste (67.334 linhas), `pytest` com `-m 'not skip_test'`
(`pyproject.toml:89-95`). Qualidade: Ruff/Black (`pyproject.toml:79-83`),
pre-commit, `asyncio_mode = auto`.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Score determinístico de tools | `metrics/tool_correctness/tool_correctness.py:474-621` | Exato, ordem (LCS ponderada) e parcial com match de dict — sem juiz, sem custo | Apache-2.0 | `src/core/eval/metrics/tool-correctness.ts` | 23 |
| Detecção de loop de agente | `metrics/agent_loop_detection/agent_loop_detection.py:65-258` | Três sinais independentes (repetição, estagnação, ciclo) e score combinado | Apache-2.0 | `src/core/eval/metrics/agent-loop.ts` | 22 |
| Contrato de métrica | `metrics/base_metric.py:111-204` | `score`, `threshold`, `reason`, `success`, `error`, custo e tokens no mesmo objeto | Apache-2.0 | `src/core/eval/metrics/types.ts` | 21 |
| Correlação thread/turn em trace | `tracing/types.py:87-201`; `tracing/otel/exporter.py:77-97` | `thread_id` + `turn_id` + tipos de span + tokens no span | Apache-2.0 | `src/core/observability/types.ts` | 20 |
| Snapshot de test run + store local | `test_run/test_run.py:64-67,1064-1074` | Run reproduzível em JSON/SQLite, sem servidor | Apache-2.0 | `src/core/eval/store.ts` | 19 |
| Cache de métricas por caso | `test_run/cache.py:40-41,139-170` | Evita repagar juiz em re-runs | Apache-2.0 | `src/core/eval/cache.ts` | 18 |
| `Golden` como schema de dataset | `dataset/golden.py:181-239` | Cobre input, output, contexto, tools, tokens e metadados | Apache-2.0 | `src/core/eval/dataset/types.ts` | 18 |
| Métrica de tarefa MCP multi-turn | `metrics/mcp/mcp_task_completion.py:45-131` | Quebra a conversa em tarefas e pontua cada uma, em vez de uma nota única | Apache-2.0 | `src/core/eval/metrics/mcp-task.ts` | 17 |
| Gate de CI por exit code | `cli/main.py:343-398`; `evaluate.py:201-209` | Ideia simples: falha bloqueia pipeline; `flaky` só avisa | Apache-2.0 | `src/core/eval/gate.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| 50+ métricas RAG/segurança | Muitas dependem de juiz e de contexto que não temos; portar só as agenticas |
| Confident AI (nuvem, login, gate) | Serviço proprietário; nosso produto é local-first |
| Simulador de conversa/voice | Stack e domínio diferentes |
| Arena GEval / `compare()` | Comparação A/B de outputs não é nosso caso primário |
| Red teaming (`red_teaming/`) | Já coberto por outros estudos; aqui é periférico |
| Estrutura pytest/`conftest` | Nosso runner é TypeScript/Vitest |
| `system_one`/Jev | Otimização proprietária de custo, pouco documentada no código |
| TUI `inspect` | UI própria, sem valor de harness |

## 12. Modelo de exemplo para o nosso harness

1. **`src/core/eval/metrics/types.ts`** — `MetricResult { name, score, threshold,
   pass, reason, error?, costUsd?, tokens?, breakdown? }`, espelhando
   `BaseMetric` (`base_metric.py:111-131`), mas com `pass` explícito para não
   repetir `score >= threshold` em cada caller.
2. **`src/core/eval/metrics/tool-correctness.ts`** — três modos:
   `exact`, `ordered` e `partial`. Reutilizar a LCS ponderada
   (`tool_correctness.py:561-603`) e o match recursivo de dict
   (`:606-621`). Entrada: `TrajectoryStep[]` vindo dos eventos
   `tool_start`/`tool_end` (`src/shared/types.ts:316-336`).
3. **`src/core/eval/metrics/agent-loop.ts`** — detectar:
   (a) mesma tool + mesmos args repetidos ≥ 3 vezes;
   (b) similaridade de bigramas entre saídas de turnos consecutivos ≥ 0,85;
   (c) ciclo no grafo `parentChildId` de subagentes
   (`src/shared/types.ts:344-364`). Score 1,0 limpo → 0,0 severo.
4. **`src/core/eval/judge.ts`** — schema Zod `{ scoreExplanation: string,
   score: number }` e prompt que proíbe texto fora do JSON; devolver
   `reason` a partir de `scoreExplanation` (lição do Langfuse,
   `llmEvaluatorExecution.ts:72-78`).
5. **`src/core/eval/store.ts`** — um JSON por run em
   `%APPDATA%/Openclod/data/evals/<timestamp>.json`, com `cases`, `metrics`,
   `totals`, `gitSha`, `model`, `startedAt`; sem banco.
6. **Testes** — `tests/eval-metrics.test.ts` com `ScriptedProvider` e traces
   sintéticos: 3 tools na ordem certa, 1 tool a mais, args parciais, loop de 4
   repetições. Nenhuma chamada de rede.
7. **Correlação com o que já existe** — cada `MetricResult` deve carregar
   `sessionId` e `turnId` iguais aos do `ObservabilityService`
   (`src/core/observability/service.ts:184-291`), para abrir o turno exato a
   partir de uma falha de métrica.

Ordem: `types` → `tool-correctness` → `agent-loop` → `store` → juiz → dataset.

## 13. Evidências da análise

```text
git rev-parse HEAD
5410e3822dda5f889d5f35de3325a3738004aeb1

pyproject.toml:3,6,12-13,19   version 4.3.1; Apache-2.0; console script; python >=3.9
deepeval/metrics/base_metric.py:111-131   campos de métrica
deepeval/metrics/base_metric.py:152-182   measure / is_successful
deepeval/evaluate/evaluate.py:212-234     evaluate()
deepeval/evaluate/evaluate.py:201-209     flaky não bloqueia CI
deepeval/evaluate/execute/e2e.py:483-501  a_execute_test_cases + Semaphore
deepeval/metrics/tool_correctness/tool_correctness.py:474-621
deepeval/metrics/agent_loop_detection/agent_loop_detection.py:65,211-247
deepeval/metrics/task_completion/task_completion.py:47,94,206-222
deepeval/tracing/types.py:87-201          BaseSpan / Trace / thread_id / turn_id
deepeval/tracing/otel/exporter.py:100     ConfidentSpanExporter
deepeval/test_run/test_run.py:64-67,1064-1074  paths e store local
deepeval/test_run/cache.py:40-41,139-170  cache de métricas
deepeval/dataset/golden.py:181-239        Golden
deepeval/synthesizer/synthesizer.py:118-160  Synthesizer
deepeval/cli/main.py:343-398              gate
deepeval/cli/test/command.py:44-114       test run flags

contagem: 669 .py em deepeval (109.533 linhas)
          457 arquivos de teste (67.334 linhas)
```

Não encontrado: streaming de tokens, fork/checkpoint de sessão, sandbox de
ferramentas e redação de credenciais no caminho local de export.
