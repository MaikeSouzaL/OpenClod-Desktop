# Medições de memória e tokens (27/10/2026)

Evidência de [`docs/MEMORIA-E-TOKENS.md`](../MEMORIA-E-TOKENS.md). Tudo veio de execuções reais (DeepSeek pela API; depois do saldo
acabar, DeepSeek V4.1 flash, Qwen 3.8 flash e Beam servidos pelo Ollama local/OpenCode Go e o Qwen 3.5 4B no próprio computador; o
Gemma 4 31B só em duas baterias), nenhum número
foi estimado à mão, e o que foi reconstruído do console diz isso no próprio arquivo.

| arquivo | o que é | script |
|---|---|---|
| `sessoes-reais-2026-10-27.json` | cache por posição da chamada nas sessões reais do usuário (só números) | análise das sessões gravadas |
| `tokens-baseline.json` / `tokens-new.json` | mesma conversa de 3 turnos no build antigo e no novo | `scripts/ui-token-economy.cjs` |
| `handoff-baseline.json` | passagem de bastão, build antigo, A grava memória | `scripts/ui-handoff.cjs --no-control` |
| `handoff-new.json` | idem, build novo, **com o controle sem memória** | `scripts/ui-handoff.cjs` |
| `handoff-*-lazy.json` | A é proibido de usar `memory_*` | `--lazy-a` |
| `handoff-*-lazy-interleaved.json` | idem, com 8 sessões de outros assuntos antes de B | `--lazy-a --interleave 8` |
| `piso-before.json` | 1ª chamada de uma sessão nova ("ola"), DeepSeek, 31 ferramentas essenciais | `scripts/ui-floor.cjs` |
| `piso-after-1a-build.json` | idem, 22 ferramentas essenciais (1º build; **reconstruído do console**, o original foi sobrescrito) | idem |
| `piso-gemma-before.json` / `piso-gemma-after.json` | idem com o Gemma 4 31B (nuvem do Ollama). Os números do Ollama dependem de cache de prefixo entre amostras: servem de direção, não de tamanho | `--provider ollama --model gemma4:31b-cloud` |
| `sob-demanda-before.json` / `sob-demanda-after-1a-rodada.json` | o que custa precisar de `mcp_servers`, `memory_handoff`, `list_skills`, `list_agents` (DeepSeek, builds antigo e 1º novo) | `scripts/ui-deferred-tools.cjs` |
| `sob-demanda-gemma-before.json` | idem, Gemma, build antigo (o cenário `agents` ficou com 0 chamadas: a nuvem recusou) | idem |
| `sob-demanda-gemma-after3.json` | idem, Gemma, build com carregamento por chamada direta (**reconstruído do console**) | idem |

**A comparação limpa** (mesma árvore, só a lista essencial muda; modelos servidos pelo Ollama local: DeepSeek V4.1 flash, Qwen 3.8 flash e Beam pelo OpenCode Go, Qwen 3.5 4B no próprio computador):

| arquivo | o que é | script |
|---|---|---|
| `piso-ocds-final-legacy.json` / `piso-ocds-final-current.json` | 1ª chamada de uma sessão nova, build final: 31 ferramentas (9 398 / 9 750) contra 22 (8 273 / 8 627). `piso-ocds-legacy/current.json` é a rodada anterior (9 401 / 9 751 contra 8 274 / 8 624) | `scripts/ui-floor.cjs --provider ollama --model opencode-go/deepseek-v4.1-flash` |
| `sob-demanda-ocds-legacy.json` | quatro sessões que pedem `mcp_servers`, `memory_handoff`, `list_skills`, `list_agents`, build antigo, DeepSeek V4.1 flash: 9 chamadas · 90 106, 4/4 | `scripts/ui-deferred-tools.cjs` |
| `sob-demanda-ocds-current.json` | idem, build novo **sem** a pré-carga pelas palavras do usuário: 14 · 123 609, 4/4 | idem |
| `sob-demanda-ocds-final-current.json` | idem, build final **com** a pré-carga: 9 · 80 487, 4/4, tudo por chamada direta | idem |
| `sob-demanda-qwenflash-{legacy,current,final-current}.json` | idem, Qwen 3.8 flash: 9 · 73 478; 13 · 95 355; 9 · 66 395 | idem |
| `sob-demanda-beamfree-{legacy,current,final-current}.json` | idem, Beam (gratuito): 8 · 62 483; 10 · 70 136; 8 · 56 841 | idem |
| `sob-demanda-qwen4b-legacy.json` | idem, Qwen 3.5 4B local (gratuito, fraco), build antigo: 9 · 83 709, 4/4 | idem |
| `sob-demanda-qwen4b-r1-current.json` / `-r3-current.json` | idem, build novo sem a pré-carga: 11 · 97 021, **2/4**; 9 · 81 464, **2/4** (a 2ª com uma linha de sugestão na mensagem do turno, descartada) | idem |
| `sob-demanda-qwen4b-final-current.json` | idem, build final com a pré-carga: 8 · 65 678, **4/4** | idem |
| `tokens-ocds-legacy.json` / `tokens-ocds-current.json` | a conversa de 3 turnos: mesma resposta certa nos dois, sem `tool_search`/`tool_load`; os totais não se comparam (10 e 7 chamadas) | `scripts/ui-token-economy.cjs` |
| `*-ocds-r1-*.json` | a 1ª rodada, com a frase do prompt sobre chamadas diretas ainda na forma antiga (piso 9 402 / 9 749 contra 8 273 / 8 630; cenários 10 · 99 715 contra 16 · 144 123) | idem |
| `*-r3-*.json` | a rodada da sugestão por linha na mensagem do turno ("chame direto, pelo nome"), descartada: DeepSeek 12 · 107 204 e o 4B 2/4 | idem |

Como o build "antes" foi feito: uma cópia da árvore de código no momento da medição, com a lista de 31 ferramentas e as frases do prompt
anteriores restauradas; o "depois" é a mesma cópia sem isso. O saldo do DeepSeek acabou (HTTP 402), a nuvem do Ollama atingiu o limite
mensal e os modelos gratuitos do OpenRouter, repassados pelo Ollama, a cota diária; o app não tem chave do OpenRouter (nem a variável
`OPENROUTER_API_KEY`), mesmo depois de o usuário dizer que a colocou. Os scripts agora recusam gravar uma execução em que o modelo não
respondeu ou em que a sessão terminou em outro modelo (a reserva automática entre provedores trocava em silêncio), trocam a porta de
depuração quando a pedida está ocupada, e um cenário que o modelo não termina (`--timeout`) vira resultado: duas execuções vazias tinham
sobrescrito resultados bons e um "piso" saiu de um modelo local de 4B.

Duas execuções do primeiro cenário (A grava memória) foram interrompidas antes de gravar o JSON e seus números vêm das sessões que ficaram
no disco: build antigo, 15 chamadas e 301 042 tokens de entrada em B; build novo (um build intermediário, anterior à compressão do
prompt e às sugestões), 6 chamadas e 118 651 tokens. Os testes ocultos delas foram rodados à mão sobre as pastas dos projetos com
`node scripts/lib/handoff-fixture.cjs <pasta>`: 4/4 nas duas. As demais execuções gravaram o próprio JSON.

Os builds foram congelados com `electron-vite build --outDir <pasta>` e `node scripts/snapshot-app.cjs <rótulo> --from <pasta>`, e os
scripts rodam com `--root <pasta do snapshot>`: o `out/` do app aberto do usuário não foi tocado.
