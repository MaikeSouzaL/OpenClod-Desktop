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
