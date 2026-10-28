# Aider

| Campo | Valor |
|---|---|
| Repositório | https://github.com/Aider-AI/aider (`git remote get-url origin`) |
| Clone local | `repositorios/_research/agents/Aider-AI--aider` |
| Commit | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` |
| Licença | Apache-2.0 (`LICENSE.txt:1-2`, `pyproject.toml:8`) |
| Categoria | agents / pair programming em terminal (sem tool calling) |
| Stack | Python 3.10–3.14 (`pyproject.toml:20`), click/rich/prompt_toolkit, litellm, tree-sitter, networkx, git CLI |
| Tamanho | 691 arquivos versionados; 328 fontes (~170 k linhas); 36 arquivos `test_*.py` |

## 1. O que é (verificado no código)

Aider é um par de programação em terminal cujo contrato com o modelo **não é tool calling**: o modelo
devolve texto em um "edit format" (diff, whole file, search/replace, udiff) e o Aider parseia e aplica
(`aider/coders/base_coder.py:2296-2336`). O entrypoint é `aider.main:main`
(`pyproject.toml:26-27`), que constrói `InputOutput` (`aider/main.py:552`) e um `Coder` via
`Coder.create` (`main.py:973,1177`). O loop principal é `Coder.run` com `run_one`
(`base_coder.py:876-892,924-944`). A grande ideia própria é o **repo map**: um grafo de símbolos
extraído por tree-sitter e rankeado por PageRank para escolher o que cabe no contexto
(`aider/repomap.py:365-629`). Não há MCP, nem sandbox de ferramenta, nem catálogo de tools — a
superfície é o shell do usuário (`/run`, `/test`) e o git. O README descreve "AI pair programming";
o código confirma, mas o que o diferencia de um chat é o repo map e o commit automático.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `aider` | `pyproject.toml:26-27` → `aider/main.py:451` | inicia a sessão interativa |
| `aider --message "..."` | `aider/args.py:639` | one-shot: manda a mensagem e sai |
| `aider --model` | `args.py:60` | escolhe modelo (litellm) |
| `aider --edit-format` | `args.py:164` | força o formato de edição |
| `aider --architect` | `args.py:172` | modo dois modelos (arquiteto + editor) |
| `aider --map-tokens` | `args.py:248` | orçamento do repo map (default 1024, `repomap.py:49`) |
| `aider --auto-commits` | `args.py:440` | commit automático por edição |
| `aider --watch-files` | `args.py:521` | observa arquivos e reage a mudanças |
| `aider --lint-cmd` / `--test-cmd` | `args.py:534,549` | lint/test após edição |
| `aider --read` | `args.py:736` | arquivo somente leitura no contexto |
| `pytest tests/` | `pytest.ini` | suíte de testes |

Slash commands (`aider/commands.py`, todos `cmd_*`): `/add`, `/drop`, `/read-only`, `/model`,
`/editor-model`, `/weak-model`, `/chat-mode`, `/code`, `/architect`, `/ask`, `/context`, `/tokens`,
`/clear`, `/reset`, `/undo`, `/diff`, `/commit`, `/git`, `/lint`, `/test`, `/run`, `/ls`, `/map`,
`/map-refresh`, `/settings`, `/load`, `/help`, `/voice`, `/paste`, `/copy-context`, `/exit`
(`commands.py:337-1466`). O roteamento é por prefixo com desambiguação
(`commands.py:300-330`).

## 3. Arquitetura e fluxo

```
aider/main.py:451 (CLI + config) → InputOutput (io.py) → Coder.create (base_coder.py:125)
  → Coder.run (base_coder.py:876) → get_input → run_one (924)
    → preproc_user_input (912): slash command | file mentions | URLs
      → send_message (1419): format_messages → check_tokens → send → stream
        → apply_updates (2296): get_edits → dry run → apply_edits
          → auto_commit (2375) → git commit
            → reflected_message? → run_one de novo (até max_reflections=3)
```

- Entry point: `aider/main.py:451` (função `main`), `main.py:552` (`InputOutput`),
  `main.py:973` (`Coder.create`).
- Loop do agente: `aider/coders/base_coder.py:876-892`.
- Execução de "ferramenta": não existe; o equivalente é `apply_updates`
  (`base_coder.py:2296-2336`).
- Streaming: `base_coder.py:1442-1444` (`mdstream`) e `send` por coder
  (`base_coder.py:1783`).
- Persistência: histórico markdown em `io.chat_history_file` (`base_coder.py:512-519`) e commits git
  (`aider/repo.py:131`).

O ciclo de reflexão é o "retry" do Aider: se o parse do edit falhar, `reflected_message` recebe o erro
e o `while` de `run_one` reenvia ao modelo, até 3 vezes (`base_coder.py:932-944`, `max_reflections =
3` na linha 101).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `/run <cmd>` | `aider/commands.py:1013` | executa comando shell e adiciona saída ao chat | alto |
| `/test <cmd>` | `commands.py:993` | roda teste e usa falha como contexto | alto |
| `/lint` | `commands.py:356` | roda linter configurado | médio |
| `/git <args>` | `commands.py:967` | executa git arbitrário | alto |
| `/add` / `/drop` | `commands.py:799,912` | gerencia arquivos no contexto | baixo |
| `/read-only` | `commands.py:1328` | adiciona arquivo sem permitir edição | baixo |
| `/undo` | `commands.py:553` | desfaz último commit do aider | médio |
| `/diff` | `commands.py:657` | mostra diff pendente | baixo |
| `/map` / `/map-refresh` | `commands.py:1418,1426` | inspeciona/refaz repo map | baixo |
| `/tokens` | `commands.py:445` | mede uso de contexto | baixo |
| `/voice` | `commands.py:1252` | entrada por voz | baixo |
| edit formats (diff/whole/search-replace/udiff) | `aider/coders/*_coder.py` | "ferramentas" de edição via texto | médio |

A ausência de tool calling é deliberada: cada formato tem um coder e um prompt próprio
(`aider/coders/patch_coder.py`, `editblock_coder.py`, `wholefile_coder.py`, `udiff_coder.py`), e o
`Coder.create` escolhe pelo modelo/edit format (`base_coder.py:125-201`). O `functions` existe só para
os modos `*_func_coder`, que usam JSON Schema (`base_coder.py:96,533-542`).

## 5. Loop do agente, contexto e streaming

**Montagem do prompt.** `format_messages` (chamado em `base_coder.py:1429`) produz `ChatChunks` com
system prompt, examples, repo map, arquivos read-only, arquivos do chat, histórico e mensagem atual
(`base_coder.py:637-817`). Antes de enviar, `check_tokens` compara a estimativa com
`max_input_tokens` e, se estourar, **pede confirmação ao usuário** em vez de truncar
(`base_coder.py:1396-1417`). `warm_cache` aquece o cache do provedor antes do request
(`base_coder.py:1433`).

**Streaming.** `send_message` escolhe `mdstream` quando `show_pretty()` e `stream`
(`base_coder.py:1439-1447`); o `send` específico do coder consome o stream e alimenta
`partial_response_content` e `partial_response_function_call`. No `finally`, o conteúdo parcial é
consolidado e o raciocínio removido (`base_coder.py:1513-1523`).

**Falhas.** O `while True` de retry trata `ContextWindowExceededError` (marca `exhausted` e sai),
erros retryable com backoff dobrando de 0,125 s até `RETRY_TIMEOUT`, `KeyboardInterrupt` e
`FinishReasonLength` (`base_coder.py:1456-1512`). `FinishReasonLength` só continua se o modelo suporta
`assistant_prefill`; senão considera contexto esgotado (`1492-1505`). Ao esgotar, injeta uma mensagem
assistente "you sent too many tokens" e mostra erro (`1536-1547`).

**Compactação.** É assíncrona e baseada em thread: `summarize_start` só dispara se
`summarizer.too_big(done_messages)`; o worker resume em background e `summarize_end` troca o histórico
se nada mudou durante o trabalho (`base_coder.py:1002-1034`). O ponto fino: `summarize_end` compara
`summarizing_messages == done_messages` para não sobrescrever mensagens novas (1031-1032). A troca
acontece em `move_back_cur_messages` (1036-1046).

**Repo map.** `get_ranked_tags` monta grafo de definições/referências e roda
`nx.pagerank(G, weight="weight")` (`repomap.py:525-529`); `get_ranked_tags_map` pagina o resultado em
`max_map_tokens` com cache por conjunto de arquivos e modo de refresh (`repomap.py:576-627`). Esse é o
mecanismo que permite contexto útil sem embeddings.

## 6. Sessões, estado e persistência

Não há banco: o estado é (a) histórico markdown, (b) arquivos em memória e (c) git.

- **Histórico**: `io.chat_history_file` é lido na inicialização quando `restore_chat_history` está
  ligado e dividido por `utils.split_chat_history_markdown` (`base_coder.py:512-519`); o formato é
  markdown legível, não JSON.
- **Retomada**: `--restore-chat-history` + arquivos do chat; não há ID de sessão nem fork nativo.
  Fork é "copiar o arquivo de histórico".
- **Undo**: `cmd_undo` usa os commits do aider (`commands.py:553`), e `repo.py:131` separa commit
  gerado por IA (`aider_edits=True`) de commit do usuário, inclusive com `Co-authored-by` opcional
  (`repo.py:242-259`).
- **Auto-commit**: `auto_commit` commita apenas os arquivos editados com contexto da conversa
  (`base_coder.py:2375-2395`); `commit_before_message` guarda o SHA para o hint de `/undo`
  (2405-2409).
- **Checkpoint**: não existe snapshot de worktree; o git do usuário é o checkpoint, e `dirty_commit`
  decide se commita mudanças pendentes antes de editar (`base_coder.py:2411-2415`).

## 7. Configuração e extensibilidade

- **Precedência**: `.aider.conf.yml` no CWD → raiz do git → home, nessa ordem
  (`aider/main.py:466-484`); `--config` sobrepõe.
- **Modelos**: `ModelSettings` (`aider/models.py:128-146`) define `edit_format`, `weak_model_name`,
  `use_repo_map`, `editor_edit_format`. O catálogo embute capacidades por modelo (ex.: `edit_format =
  "diff"` e `use_repo_map = True` em `models.py:439-485`). `--weak-model` e `--editor-model` permitem
  um modelo barato para commits/resumos e outro para o modo architect (`models.py:361-369`).
- **Prompts por coder**: cada formato tem seu `*_prompts.py` (`editblock_prompts.py`,
  `patch_prompts.py`, `udiff_prompts.py`, `wholefile_prompts.py`), o que mantém o contrato textual
  explícito.
- **Extensibilidade real**: não há plugin system. O que existe é (a) novos coders, (b) `--lint-cmd` /
  `--test-cmd`, (c) slash commands, (d) `conventions`/`read` files. MCP e hooks: **não encontrado**.
- **Voz**: `aider/voice.py` + `/voice` (`commands.py:1252`).

## 8. Permissões, sandbox e erros

Não há modelo de permissão por ferramenta, porque não há ferramentas. O controle é:

1. **Confirmação humana** para ações de risco: `io.confirm_ask` com default e cache de "não perguntar
   de novo" por `question_id` (`aider/io.py:807-903`); `--yes` responde tudo.
2. **Arquivos read-only**: `abs_read_only_fnames` são enviados ao modelo mas excluídos de edição
   (`base_coder.py:659-671,900`).
3. **Dry run**: `--dry-run` impede aplicar edições e commitar (`base_coder.py:2330-2334,2376`).
4. **Reflexão em vez de bloqueio**: edição malformada não derruba a sessão; vira mensagem de erro para
   o modelo e nova tentativa (`base_coder.py:2305-2316`).

Sandbox de processo, seccomp, seatbelt: **não encontrado**. `/run` executa no shell do usuário com o
ambiente dele (`aider/run_cmd.py`). O risco é mitigado por confirmação, não por isolamento.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| unit | `tests/test_*.py` (36 arquivos) | coders, repo map, commands, io, models |
| edit formats | `tests/test_editblock.py`, `test_patch.py`, `test_udiff.py` | parsing e aplicação de cada formato |
| repo map | `tests/test_repomap.py` | tags, ranking, cache |
| integração manual | `benchmark/` | exercícios de edição por modelo |

A suíte é pequena para o tamanho do código e depende de fixtures de arquivos. O aprendizado não é
copiar os testes, e sim o padrão de teste por formato: cada coder tem caso feliz, caso malformado e
caso de "quase certo" (indentação, cercas de código).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Repo map com PageRank | `aider/repomap.py:365-629` | seleciona símbolos relevantes sem embeddings, com cache e orçamento | Apache-2.0 | `src/core/code-intelligence/repomap.ts` | 24 |
| Resumo assíncrono com checagem de corrida | `base_coder.py:1002-1034` | troca o histórico só se nada mudou durante o resumo | Apache-2.0 | `src/core/agent/compaction.ts` | 21 |
| Reflexão de edição malformada | `base_coder.py:924-944,2296-2316` | erro de parse vira nova tentativa, não falha de sessão | Apache-2.0 | `src/core/agent/reflection.ts` | 20 |
| Commit automático com autoria separada | `repo.py:131-259` | distingue commit de IA de commit humano e preserva `/undo` | Apache-2.0 | `src/core/git/service.ts` | 19 |
| Read-only files no contexto | `base_coder.py:659-671,900` | contexto sem permissão de escrita, por arquivo | Apache-2.0 | `src/core/tools/fs.ts` | 17 |
| Orçamento de contexto com confirmação | `base_coder.py:1396-1417` | usuário decide prosseguir acima do limite | Apache-2.0 | `src/core/agent/context.ts` | 15 |
| `--weak-model` para tarefas baratas | `models.py:361-369` | modelo barato para resumo/commit, forte para edição | Apache-2.0 | `src/core/providers/index.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Edit formats textuais (diff/whole/udiff) | nosso harness já usa tool calling; parser textual é regressão |
| Python/litellm | stack incompatível com TypeScript |
| Ausência de sandbox | não é uma feature; é uma lacuna de segurança que não devemos copiar |
| Slash commands como único controle | já temos UI de aprovação; comandos de texto não bastam |
| PageRank sobre tree-sitter em Python | o algoritmo serve, a implementação não; portar a ideia, não o código |
| Histórico em markdown | sem IDs, sem fork, sem versionamento — nosso `session/store.ts` é melhor |

## 12. Modelo de exemplo para o nosso harness

1. **Repo map como camada de contexto, não como ferramenta.** Criar `repomap.ts` que indexa
   definições/referências por linguagem e ranqueia por centralidade, respeitando um orçamento de
   tokens. Ele entra no prompt **antes** do histórico, como o Aider faz em `get_repo_messages`
   (`base_coder.py:750-762`). Vantagem sobre "listar arquivos": escolhe por relevância estrutural.
2. **Resumo com detecção de corrida.** Se copiarmos a compactação assíncrona, guardar o snapshot das
   mensagens no início do resumo e só aplicar se `snapshot === atual`. O Aider faz isso com igualdade
   de lista (`base_coder.py:1031-1032`); nós devemos usar um hash/seq para evitar comparação cara.
3. **Reflexão limitada.** Quando o parse de uma edição falhar, devolver o erro ao modelo com um teto
   (3 tentativas) e registrar o motivo. Isso é melhor que abortar a sessão e melhor que tentar
   "consertar" o patch com heurística.
4. **Read-only por arquivo.** Nosso `fs.ts` deve aceitar `readonly: Set<path>` e recusar escrita com
   erro tipado — não apenas omitir do prompt.
5. **Commit com autoria explícita.** Ao commitar edição do agente, usar mensagem + trailer
   `Co-authored-by` distinto, permitindo `/undo` cirúrgico sem reverter mudanças humanas.
6. **Como testar.** Fixtures de repositório pequeno para o repo map (assert do top-N), testes de
   resumo concorrente (mensagem nova durante o resumo não é perdida) e testes de reflexão (parse
   inválido → 1 retry → sucesso).

## 13. Evidências da análise

```text
git -C repositorios/_research/agents/Aider-AI--aider rev-parse HEAD
  -> 5dc9490bb35f9729ef2c95d00a19ccd30c26339c

Leituras:
  aider/main.py:451-560,940-1000,1160-1190
  aider/coders/base_coder.py:88-210,500-560,637-820,859-1046,1396-1548,2296-2420
  aider/repomap.py:42-170,365-395,520-635,700-760
  aider/commands.py:30-90,276-340,337-1466 (amostra de cmd_*)
  aider/models.py:128-170,329-380,430-490
  aider/repo.py:131-200,240-262
  aider/io.py:269-300,799-930
  aider/args.py:60-180,240-260,430-560,630-740

Contagens:
  git ls-files           -> 691
  fontes (py/md/toml...) -> 328
  linhas somadas         -> 170092
  tests/test_*.py        -> 36
  pyproject.toml:20      -> requires-python = ">=3.10,<3.15"
```

Lacunas: não li `aider/watch.py` nem `aider/gui.py`; a afirmação de que não há MCP/hooks vem de busca
por nome (`mcp`, `hook`) sem ocorrências relevantes, não de leitura exaustiva de todos os 328 arquivos.
O comportamento exato de `summarizer` (classe em `aider/history.py`) não foi aberto.
