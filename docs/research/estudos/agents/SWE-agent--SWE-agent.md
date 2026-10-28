# SWE-agent

| Campo | Valor |
|---|---|
| Repositório | https://github.com/SWE-agent/SWE-agent |
| Clone local | `repositorios/_research/agents/SWE-agent--SWE-agent` |
| Commit | `3ea751c087f32b16e039a2233dd6eefecef325d5` |
| Licença | MIT (`LICENSE:1`, `pyproject.toml:19`) |
| Categoria | agents (harness de pesquisa / Agent-Computer Interface) |
| Stack | Python >= 3.11 + pydantic + litellm + Jinja2 + tenacity + SWE-ReX + Flask (API) + pytest; setuptools |
| Tamanho | 409 arquivos; `sweagent/` com 60 `.py` e 9.567 linhas; `tests/` com 31 `.py` |

## 1. O que é (verificado no código)

É um harness de linha de comando que resolve issues de repositórios: monta um
prompt Jinja a partir de um problem statement, deixa o modelo emitir **uma
ação** (comando bash ou chamada de ferramenta), executa num ambiente isolado
via SWE-ReX e devolve a observação truncada (`sweagent/agent/agents.py:1006-1045`,
`:936-1004`). O loop para quando o agente roda o comando `submit` (ou `exit`),
e o diff é extraído de `/root/model.patch` (`agents.py:870-905`).

O README avisa que o desenvolvimento migrou para `mini-swe-agent`
(`README.md:19-24`) — ou seja, este repo é a geração "completa", com catálogo de
ferramentas configurável, reviewer e retry. O entrypoint real é
`sweagent/__main__.py:1` → `sweagent/run/run.py:70`.

Divergência confirmada: o subcomando `run-api` é anunciado
(`run.py:105-108`) e importa `sweagent.api.server`, **não encontrado** neste
commit. Toda a análise abaixo ignora esse caminho.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `sweagent` | `pyproject.toml:67` | console script → `sweagent.run.run:main` |
| `sweagent run` / `r` | `run.py:89-91` | uma instância, com `--config` |
| `sweagent run-batch` / `b` | `run.py:93-95`; `run_batch.py:87` | muitas instâncias, `num_workers` paralelos |
| `sweagent run-replay` | `run.py:97-100` | reexecuta uma trajetória salva |
| `sweagent traj-to-demo` | `run.py:101-104` | converte `.traj` em demonstração |
| `sweagent inspector` / `I` | `run.py:113-116`; `inspector/server.py:295` | servidor HTTP local com UI de inspeção |
| `sweagent inspect` / `i` | `run.py:117-120` | CLI de inspeção |
| `sweagent merge-preds` | `run.py:109-112` | junta predições |
| `sweagent compare-runs` | `run.py:125-128` | compara execuções |
| `sweagent quick-stats` | `run.py:133-136` | estatísticas rápidas |
| `sweagent shell` / `sh` | `run.py:137-140` | sessão interativa no ambiente |
| `sweagent remove-unfinished` | `run.py:129-132` | limpa trajetórias incompletas |

Flags vêm do `simple-parsing`/pydantic dos dataclasses de config
(`run_single.py`, `run_batch.py:82-97`), não de um argparse central. Exemplo de
superfície: `num_workers`, `progress_bar`, `skip_existing`, `redo_existing`
(`run_batch.py:82-95`).

## 3. Arquitetura e fluxo

```
sweagent/__main__.py → run/run.py (dispatch)
  → run_single.RunSingle → Agent.from_config
  → DefaultAgent.run: while not done → step → forward_with_handling
  → model.query (litellm) → tools.parse_actions → env.communicate (SWE-ReX)
  → observation → history → save_trajectory (.traj)
```

- Entry point: `sweagent/__main__.py:1-4`; dispatch em `sweagent/run/run.py:70-143`.
- Loop do agente: `sweagent/agent/agents.py:1284-1287` (`while not step_output.done`).
- Um passo: `agents.py:1235-1263` (forward → histórico → trajectory → info).
- Execução de ferramenta: `agents.py:936-1004` (`handle_action` → `env.communicate`).
- Streaming: **não existe** streaming de token; a resposta chega inteira por
  `model.query` (`agents.py:1042`) e o evento é logado por hook
  (`agents.py:1029`). Para a UI, o "stream" é o trajectory.
- Persistência: `.traj` JSON reescrito a cada passo (`agents.py:1284-1287`,
  `:779-787`).

## 4. Catálogo de ferramentas / capacidades

O catálogo é **dados**, não código: bundles YAML + scripts bash/python em
`tools/*/bin` (`sweagent/tools/tools.py:83-84`, `:252-308`). O default carrega
`registry`, `edit_anthropic` e `review_on_submit_m`
(`config/default.yaml:41-44`), com `USE_FILEMAP=true` (`:46`).

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `bash` (embutida) | `tools/tools.py:173-175`; `config/tools/...` | executa qualquer comando no ambiente | alto |
| `str_replace_editor` | `tools/edit_anthropic/bin/str_replace_editor` | view/create/str_replace/insert/undo | médio |
| `submit` | `tools/review_on_submit_m/bin/submit:13-46` | faz `git add -A`, gera patch e aplica review em estágios | médio |
| `find_file` | `tools/search/config.yaml:2-13` | busca por nome/glob | baixo |
| `search_dir` / `search_file` | `tools/search/config.yaml:14-37` | grep no diretório/arquivo | baixo |
| `filemap` | `tools/filemap/bin/filemap` | mapa de arquivos para orientação | baixo |
| `view_image` | `tools/image_tools/bin/view_image` | imagem multimodal | baixo |
| `exit_forfeit` | `tools/forfeit/bin/exit_forfeit` | desistir com status próprio | baixo |
| web browser (bundle opcional) | `tools/web_browser/bin/*` | abrir site, clicar, digitar, screenshot | alto |
| janela de arquivo (opcional) | `tools/windowed/bin/{open,goto,scroll_up,scroll_down}` | leitura paginada em vez de `cat` | baixo |

Documentação das ferramentas é **gerada** a partir das assinaturas e injetada
no prompt como `command_docs` (`tools/tools.py:122-125`, `:214`;
`agents.py:666-673`).

## 5. Loop do agente, contexto e streaming

Um passo = `forward_with_handling` → `forward` → `model.query`. O modelo recebe
o histórico inteiro (processado) e devolve `thought` + `action`
(`agents.py:1043-1045`). O parser depende do modo: `function_calling`
(`config/default.yaml:65-66`), `thought_action` ou `action_only`
(`agents.py:467-470`).

Erros não derrubam o loop: `forward_with_handling` reexecuta o modelo até
`max_requeries` (3 por padrão, `agents.py:158-161`) para erro de formato,
ação bloqueada, sintaxe bash inválida e timeout, injetando um template
corretivo específico (`agents.py:998-1004`, `:1106-1120`,
`get_model_requery_history` em `:789-822`). Esgotou? O agente encerra com
`exit_format` (`agents.py:1216-1218`).

Contexto: `history_processors` é uma cadeia plugável
(`agents.py:155`) com `DefaultHistoryProcessor`
(`history_processors.py:74-82`), `LastNObservations`
(`:85-177`), `ClosedWindowHistoryProcessor` (resume janelas fechadas, `:215-259`),
`CacheControlHistoryProcessor` (`:261-303`, marca as últimas N mensagens para
cache) e `RemoveRegex` (`:305-338`). Observação é truncada em 100 000
caracteres com um aviso explícito de "use head/tail/grep"
(`agents.py:69-79`). Custo e chamadas têm teto por instância e global
(`models.py:632-670`), e contexto estourado vira `ContextWindowExceededError`
antes da chamada (`models.py:690-703`).

Retry de API é `tenacity` com espera exponencial aleatória e uma lista de
exceções que **não** devem ser repetidas (`models.py:809-833`).

## 6. Sessões, estado e persistência

Não há sessão interativa persistente por conversa; a unidade é a **instância**
(problem statement). Cada execução grava `<instance_id>.traj` (JSON com
`trajectory`, `info`, `history`) a cada passo (`agents.py:589-590`,
`:779-787`, `:1284-1287`). O trajectory guarda `action`, `observation`,
`response`, `thought`, `execution_time`, `state` e a query exata
(`agents.py:1220-1233`).

Retomada: `run-replay` reexecuta um `.traj`
(`sweagent/run/run_replay.py`), e `run_batch` pode pular ou refazer instâncias
existentes (`run_batch.py:82-95`). O `RetryAgent` mantém tentativas com
orçamento de custo e escolhe a melhor submissão
(`agents.py:257-441`; `reviewer.py:180-230`), gravando o resultado escolhido.

## 7. Configuração e extensibilidade

Tudo é YAML + pydantic com `extra="forbid"` (`agents.py:167`). Precedência:
default do modelo pydantic → arquivo `--config` → `--overrides` (CLI de
`run_single.py`). O `config/` traz variantes: `default.yaml`, `bash_only.yaml`,
`human.yaml`, `demo/*`, `exotic/windowed_replace.yaml`, `sweagent_0_7/*`
(`config/`), além de benchmarks versionados (`config/benchmarks/*`).

Extensões reais:

- **Bundles de ferramentas**: pasta com `config.yaml` + `bin/` +
  `install.sh` (`tools/tools.py:292-308`).
- **Hooks**: `AbstractAgentHook` com `on_model_query`, `on_action_started`,
  `on_action_executed`, `on_step_done`, `on_run_done`
  (`agents.py:1029`, `:959-992`, `:1262-1287`); implementações em
  `sweagent/run/hooks/open_pr.py`.
- **Reviewer**: `ChooserRetryLoop` e `ScoreRetryLoop`
  (`reviewer.py:180-230`).
- **Parser**: `FunctionCallingParser`, `ThoughtActionParser`,
  `ActionOnlyParser` (`sweagent/tools/parsing.py`).
- Sem MCP, sem skills, sem subagentes: não encontrado.

## 8. Permissões, sandbox e erros

Não há aprovação humana por ação. A proteção é **filtro de comandos**:
blocklist por prefixo (`vim`, `nano`, `tail -f`, `make`…), blocklist exata
(`python`, `bash`, `su`…) e "block unless regex" (`tools/tools.py:37-72`),
aplicada antes de executar (`tools/tools.py:353-367`) e convertida em
`_BlockedActionError` (`agents.py:946-947`), que gera requery em vez de morte.

O isolamento é do SWE-ReX: `EnvironmentConfig.deployment` default é
`DockerDeploymentConfig(image="python:3.11")` (`environment/swe_env.py:24-29`);
`start/reset/close` controlam o container (`:109-171`). Não há sandbox de
sistema operacional além do container.

Limites de execução: 30 s por comando, 1800 s no total, 3 timeouts
consecutivos antes de abortar (`tools/tools.py:139-152`), com template
explicando que comandos interativos nunca terminam (`agents.py:112-120`).
Custo, chamadas de API e contexto têm exceções próprias
(`sweagent/exceptions.py`), e falha de infraestrutura tenta autosubmit do
último diff (`agents.py:824-868`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| `test_agent.py` | `tests/test_agent.py` | loop, templates, requery, submissão |
| `test_tools_command_parsing.py` | `tests/` | DSL de comandos e geração de docs |
| `test_parsing.py` | `tests/` | parsers de ação |
| `test_history_processors.py` | `tests/` | janelas, cache control, remoção |
| `test_models.py` | `tests/` | custo, tokenizer, retry |
| `test_env.py` | `tests/` | SWE-ReX, reset, repo |
| `test_run*.py` | `tests/` | single, batch, replay, hooks |
| E2E de ferramentas | `tests/tools/` | `str_replace`, split, utils |
| Lint/format | `pyproject.toml:112-150` | Ruff, 120 colunas |
| CI | `.github/workflows/` | pytest com cobertura (`codecov.yml`) |

Config de teste: `testpaths=["tests"]`, `xfail_strict=true`, marker `slow`
(`pyproject.toml:101-110`).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Submit em dois estágios com review | `tools/review_on_submit_m/bin/submit:23-46`; `config/default.yaml:47-63` | força o agente a revisar o próprio diff antes de entregar | MIT | `src/core/tools/submit-review.ts` | 24 |
| Blocklist de comandos interativos | `tools/tools.py:37-72`, `:353-367` | evita travar o terminal com `vim`/`tail -f`/`python` nu | MIT | `src/core/permissions/command-filter.ts` | 23 |
| Truncamento com instrução acionável | `agents.py:69-79` | ensina `head/tail/grep` em vez de só cortar | MIT | `src/core/context/observation.ts` | 23 |
| Requery com template por tipo de erro | `agents.py:789-822`, `:1106-1120` | recupera erro de formato sem perder o turno | MIT | `src/core/agent/requery.ts` | 22 |
| `LastNObservations` | `history_processors.py:85-177` | compressão simples e previsível sem resumir | MIT | `src/core/context/history.ts` | 21 |
| Limites de custo/chamadas | `models.py:632-670` | orçamento duro por instância e global | MIT | `src/core/budget.ts` | 20 |
| DSL de comandos + docs geradas | `tools/commands.py:52-120`; `tools/tools.py:214` | prompt e executor saem da mesma fonte | MIT | `src/core/tools/spec.ts` | 20 |
| Patch com contexto por arquivo | `utils/patch_formatter.py:6-50`, `agents.py:907-934` | mostra só hunks editados, economiza contexto | MIT | `src/core/patch/context.ts` | 19 |
| `.traj` incremental | `agents.py:1220-1233`, `:1284-1287` | retomada e inspeção baratas | MIT | `src/core/session/trajectory.ts` | 18 |
| Retry de API com lista de não-retry | `models.py:809-833` | não repete erro de auth/contexto | MIT | `src/core/provider/retry.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Loop de shell puro (sem tool calls) como default | nosso harness é multi-tool; isso é regressão |
| `litellm` como camada de provider | já temos providers próprios; dependência pesada |
| SWE-ReX / Docker por instância | nosso sandbox é o próprio desktop |
| Configuração por `simple-parsing`/dataclass | TypeScript strict + Zod já resolve |
| Reviewer com LLM juiz e `ScoreRetryLoop` | custo alto e sem prova; melhor gate determinístico |
| Ferramentas em bash dentro de `tools/*/bin` | difícil de testar/portar; preferir tools nativas |
| `run-api` | código ausente neste commit (`run.py:105-108`) |
| Web browser bundle (Playwright embutido) | já temos browser próprio |

## 12. Modelo de exemplo para o nosso harness

Copiar o **contrato de entrega**, não o loop:

1. `submit` de dois estágios: primeiro devolve ao modelo o diff completo com
   instruções (rodar de novo o script de reprodução, remover o script, reverter
   testes, reenviar); só o segundo `submit` emite o patch final entre
   marcadores. Isso transforma "terminar" em "revisar e terminar".
2. Filtro de comando antes da execução, com três níveis: prefixo, exato e
   regex-de-exceção; ao bloquear, devolver template de erro em vez de matar o
   turno.
3. Observação com teto e mensagem que ensina a alternativa (`head`, `tail`,
   `grep`, redirecionar para arquivo).
4. `max_requeries` por passo + templates por classe de erro (formato, sintaxe,
   timeout, bloqueio).
5. Orçamento: custo por sessão, custo global e número de chamadas, checados
   **após** cada resposta (como `_update_stats`).
6. Trajectory como artefato de primeira classe: um JSON por passo com ação,
   observação, query e estado, para replay e inspeção.

Teste: um caso por classe de erro garantindo que o requery consome o template
certo, e um teste que prove que `submit` estágio 1 não altera o patch final.

## 13. Evidências da análise

```text
git rev-parse HEAD → 3ea751c087f32b16e039a2233dd6eefecef325d5
sweagent/*.py → 60 arquivos, 9.567 linhas
tests/*.py → 31 arquivos
pyproject.toml:67        → sweagent = "sweagent.run.run:main"
run.py:70-143            → dispatch de subcomandos
run.py:105-108           → "run-api" importa sweagent.api.server (ausente)
agents.py:1284-1287      → while not step_output.done: step(); save_trajectory()
agents.py:936-1004       → handle_action: blocklist, exit, communicate, tokens
agents.py:870-905        → handle_submission lê /root/model.patch
agents.py:69-79          → max_observation_length 100_000 + aviso
agents.py:1106-1120      → loop de max_requeries
config/default.yaml:41-66 → bundles + registry_variables + function_calling
tools/tools.py:37-72     → blocklists; 353-367 should_block_action
tools/tools.py:139-152   → 30s / 1800s / 3 timeouts
tools/review_on_submit_m/bin/submit:23-46 → git add -A, stages, marcadores
history_processors.py:85-177 → LastNObservations
models.py:632-670        → limites de custo e chamadas
models.py:809-833        → tenacity com exceções não repetíveis
environment/swe_env.py:24-29 → DockerDeploymentConfig default
```
