# Procedência do código de terceiros

Registro do código efetivamente adaptado de repositórios estudados. Cada item
liga o arquivo de destino ao commit de origem, à licença e às alterações feitas.

> Estudos e candidatos que **não** entraram no código estão em
> [`CODE_REUSE_MATRIX.md`](./CODE_REUSE_MATRIX.md). Avisos de licença de
> dependências estão em [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## `src/core/computer/settle.ts`

- **Origem**: `munim-computer-use` — `windows-linux/src/settle.rs:38-228`
  (algoritmo `wait_for_quiet` / `watch` / `settle`).
- **Commit**: `c7ce4fc9ae8abcf7e4869e3645b54953a3711e77`
- **Licença**: Apache-2.0 (`repositorios/munim-computer-use/LICENSE`; sem `NOTICE`).
- **Alterações**:
  - portado de Rust para TypeScript, sem dependências;
  - o probe passou de contagem de WinEvents para assinatura de snapshot da
    árvore de acessibilidade, porque o backend atual é `open-computer-use` e não
    expõe eventos;
  - `baseline = null` ganhou um caminho próprio (primeira amostra como
    referência e espera só por quietude);
  - tempos padrão ajustados para o custo de um snapshot: reação 600 ms,
    quietude 200 ms, teto 1.600 ms, poll 200 ms (origem: 600/150/2.000/20);
  - API com `SettleClock` injetável para testes determinísticos.
- **Integração**: `src/core/computer/layer.ts` — `snapshotSettled()` substitui
  a leitura única após uma ação e reporta `settle_ms`, `settle_reacted` e
  `settle_timed_out`.
- **Testes**: `tests/computer-settle.test.ts` (6 casos: sem reação, rajada,
  reação tardia, loop infinito, sem linha de base, primeira amostra diferente).

## `resources/harvested/` — arquivo de assets

- **Origem**: 56 repositórios de estudo (ver `resources/harvested/manifest.json`).
- **Licenças**: MIT e Apache-2.0; textos em `resources/harvested/LICENSES/`.
- **Conteúdo**: 387 skills, 21 agentes, 23 comandos, 168 prompts e 25 fontes de
  ferramentas, copiados por `scripts/harvest-research-assets.mjs`.
- **Alterações**: os assets são cópias fiéis; a curadoria de runtime adiciona
  `source`, `origin` e `license` ao frontmatter.
- **Runtime**: apenas `resources/skills` e `resources/agents` são carregados.

### Skills curadas para runtime

| Skill | Origem | Licença |
|---|---|---|
| `agent-delegation` | `QwenLM--qwen-code/packages/core/src/skills/bundled/agent-delegation` | Apache-2.0 |
| `structured-debugging` | `QwenLM--qwen-code/.qwen/skills/structured-debugging` | Apache-2.0 |
| `e2e-testing` | `All-Hands-AI--OpenHands/.agents/skills/e2e-testing` | MIT |
| `create-pull-request` | `cline--cline/.agents/skills/create-pull-request` | Apache-2.0 |
| `harness-eval` | `openharness/.claude/skills/harness-eval` | MIT |

### Agentes empacotados

| Agente | Origem | Licença |
|---|---|---|
| `test-engineer` | `QwenLM--qwen-code/.qwen/agents/test-engineer.md` | Apache-2.0 |
| `css-specialist` | `opencode/packages/console/app/.opencode/agent/css.md` | MIT |
| `playwright-test-generator` | `playwright/packages/playwright/src/agents/playwright-test-generator.agent.md` | Apache-2.0 |
| `playwright-test-healer` | `playwright/packages/playwright/src/agents/playwright-test-healer.agent.md` | Apache-2.0 |
| `playwright-test-planner` | `playwright/packages/playwright/src/agents/playwright-test-planner.agent.md` | Apache-2.0 |

Os agentes foram adaptados para as ferramentas do Openclod (`browser_*`,
`read_file`, `edit_file`, `run_command`) e para as regras de trabalho do harness.

## `src/core/agents/definitions.ts`

- **Origem**: `opencode` — prompts de agente.
- **Licença**: MIT.
- **Registro anterior**: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
  §4.2. O cabeçalho no arquivo identifica a origem.

## `src/renderer/src/lib/graph-layout.ts`

- **Origem**: `ai-memory` — `crates/ai-memory-web/src/routes/graph.rs`
  (`circular_layout`).
- **Licença**: MIT (`resources/licenses/ai-memory/MIT.txt`).
- **Registro anterior**: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
  §4.2. O cabeçalho no arquivo identifica a origem.
