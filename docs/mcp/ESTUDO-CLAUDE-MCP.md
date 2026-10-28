# MCP no Openclod: estudo do Claude e o que foi feito

Data: 2026-10-27. Escopo: núcleo MCP (protocolo, cliente, ferramentas). OAuth/segredos/UI ficam com o agente AUTH; catálogo e
sondagem com o agente DIRETÓRIO.

Este documento separa o que foi **lido na documentação**, o que foi **medido** (testes e servidores reais) e o que **ficou de fora**.
Nada aqui foi inferido sem fonte; onde não deu para verificar, está dito.

## 1. Fontes consultadas

| Fonte | O que sustentou |
|---|---|
| https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle | `initialize`, negociação de versão (o cliente manda a mais nova que suporta; o servidor responde a mesma ou outra; se o cliente não suporta a resposta, desconecta), capabilities de cliente (`roots`, `sampling`, `elicitation`) e de servidor, `notifications/initialized`, timeouts (cancelar e parar de esperar; sempre ter um máximo) |
| https://modelcontextprotocol.io/specification/2025-06-18/basic/transports | stdio (fechar stdin, esperar, SIGTERM, SIGKILL); Streamable HTTP: POST com `Accept` JSON + SSE, 202 para notificação/resposta, resposta JSON **ou** SSE, `Mcp-Session-Id`, **404 com sessão = iniciar nova sessão**, `MCP-Protocol-Version`, GET opcional para stream do servidor (405 se não oferece), DELETE para encerrar, compatibilidade com o transporte HTTP+SSE antigo (POST `initialize`; se 4xx, GET e esperar o evento `endpoint`) |
| https://modelcontextprotocol.io/specification/2025-06-18/server/tools | `tools/list` paginado, `tools/call`, tipos de conteúdo (text, image, audio, `resource_link`, recurso embutido), `structuredContent`/`outputSchema`, anotações (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) e a regra **"clientes DEVEM tratar anotações como não confiáveis a menos que o servidor seja confiável"**, erro de protocolo x `isError`, `list_changed` |
| https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress | `_meta.progressToken` na requisição, `notifications/progress` (`progress`, `total`, `message`), o token deve ser único entre requisições ativas |
| https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation | `notifications/cancelled` com `requestId` e `reason`; `initialize` não pode ser cancelado; quem cancela ignora a resposta tardia |
| https://code.claude.com/docs/en/mcp | escopos (local, project em `.mcp.json`, user), `claude mcp add`, limites de saída, tool search, `alwaysLoad`, prompts como comandos, recursos por `@servidor:uri`, `list_changed`, reconexão, `/mcp`, elicitação, timeouts, `_meta` `anthropic/*`, esquema de entrada com combinadores na raiz, nomes longos |
| https://code.claude.com/docs/en/permissions | regras `mcp__servidor`, `mcp__servidor__ferramenta`, precedência deny > ask > allow (o Openclod já tinha isso em `security/rules.ts`) |

Servidores reais usados para medir (seção 6): DeepWiki (`mcp.deepwiki.com`), Notion (`mcp.notion.com`), Atlassian Rovo
(`mcp.atlassian.com`) e `@modelcontextprotocol/server-everything` por `npx`.

## 2. O que o Claude faz (da documentação)

- **Nomes**: `mcp__<servidor>__<ferramenta>`; caracteres fora de `A-Za-z0-9_-` viram `_`. O mesmo nome é usado em regras de permissão, `allowed-tools` de skill, campo `tools` de subagente e matchers de hook.
- **Tool search**: por padrão **todas** as ferramentas MCP ficam adiadas; só os nomes e as `instructions` do servidor entram no contexto, e o modelo as acha com a ferramenta de busca. `ENABLE_TOOL_SEARCH=auto` carrega tudo se couber em 10% do contexto. `alwaysLoad: true` isenta um servidor; `false` adia tudo. Descrições passam por corte (4 096 caracteres inline, 16 384 se adiada).
- **Saída grande**: aviso acima de 10 000 tokens, limite padrão 25 000 (`MAX_MCP_OUTPUT_TOKENS`); acima disso o texto vai para arquivo e o modelo recebe o caminho; texto de sucesso > 50 000 caracteres também. Erro > ~11 000 caracteres mantém os 5 000 primeiros e os 5 000 últimos. Servidor pode subir o limite de uma ferramenta com `_meta["anthropic/maxResultSizeChars"]` (teto 500 000).
- **Aprovação**: `_meta["anthropic/requiresUserInteraction"] === true` faz a ferramenta pedir aprovação **em toda chamada, inclusive em `bypassPermissions`**, e regras de allow não pulam o prompt. Esse é o modelo do `'ask'` do Openclod.
- **Anotações**: `readOnlyHint` faz as chamadas rodarem em paralelo com outras de leitura; `idempotentHint`/`readOnlyHint` permitem repetir a chamada uma vez numa conexão nova.
- **Reconexão**: HTTP/SSE que cai no meio da sessão: até 5 tentativas, 1 s dobrando; primeira conexão remota: 3 tentativas em erro transitório (5xx, recusada, timeout); autenticação e "não encontrado" não são repetidos; stdio que morre: marcado como falho (reconexão manual em `/mcp`). `tools/list`/`prompts/list`/`resources/list`: 3 tentativas.
- **Dinâmico**: `list_changed` recarrega só a lista afetada; se falhar, mantém a anterior.
- **Prompts** viram comandos `/mcp__servidor__prompt args`; **recursos** entram por `@servidor:uri` e o Claude ganha ferramentas para listar/ler recursos.
- **Elicitação** (modo formulário e modo URL): diálogo interativo, resposta devolvida ao servidor; um hook `Elicitation` pode responder sozinho.
- **Esquemas**: combinador (`anyOf`/`oneOf`/`allOf`) na raiz é achatado num objeto; nome de propriedade fora de `[A-Za-z0-9_.-]{1,64}` exclui só aquela ferramenta (a API recusaria o pedido inteiro); nome completo > 128 caracteres exclui a ferramenta.
- **Timeouts**: partida (`MCP_TIMEOUT`), por chamada (`MCP_TOOL_TIMEOUT`, ou `timeout` do servidor), tempo ocioso 5 min (remoto) / 30 min (stdio).
- **Resposta HTTP/SSE** acima de 16 MiB é abortada.

## 3. Estado do Openclod antes (o que faltava)

Do caso real do Jira e da leitura do código (`docs/audit/claude-code-capacidades.md`, item 7, também apontava isto):

1. As ferramentas MCP só existiam por trás de `mcp_servers`/`mcp_catalog`/`mcp_call`. O modelo nunca via `mcp__servidor__ferramenta`, então regras de permissão por ferramenta e matchers de hook **nunca casavam**.
2. `approvalTools` era configurado, exibido e **nunca aplicado**: `mcp_call` tinha risco fixo `exec`.
3. Nenhum jeito de recarregar MCP depois de mudar a configuração; `list_changed` reiniciava **todos** os servidores (com limite de 5 s).
4. Um servidor que travava na partida segurava o `await` de todos (só havia timeout por requisição, e o processo ficava vivo); o filho nunca era morto (em Windows, `npx` roda por `cmd.exe`, o servidor de verdade é neto).
5. `spawn ENOENT` sem listener de `error` (derruba o processo); só o `stderr` do último chunk virava erro.
6. Transporte `sse` era tratado como POST na URL do SSE (não funciona com servidor HTTP+SSE de verdade); resposta SSE era lida inteira antes de entregar (nenhum progresso durante a chamada); sem renovação de sessão no 404; sem reconexão; sem progresso, sem elicitação, sem limite de saída, sem templates de recurso.
7. O texto de erro era cru ("You don't have permission to connect via API token") sem dizer o que fazer.

## 4. O que foi implementado

| Arquivo | O quê |
|---|---|
| `src/core/mcp/policy.ts` (novo) | `resolveToolPolicy(config, tool, annotations, meta)` puro: filtro include/exclude, `toolPolicy` (nome exato > glob mais específico > `'*'`), `_meta` de interação obrigatória, `approvalTools`, padrão pelas anotações; risco `read`/`exec`/`destructive`; `approvalOf` |
| `src/core/mcp/hints.ts` (novo) | `hintForMcpError(servidor, config, mensagem)` em pt-BR: Atlassian "API token"/"scope claim", 401 com `resource_metadata` (OAuth), credencial estática recusada, comando não encontrado (npx/uvx/docker/python), registro dinâmico recusado, timeout de partida, 404, rede, nenhum transporte, versão de protocolo, `-32602` |
| `src/core/mcp/sse.ts` (novo) | parser SSE incremental (CRLF, `data` em várias linhas, comentários, evento final sem linha em branco) |
| `src/core/mcp/output.ts` (novo) | limites de saída: 25 000 tokens (config `maxOutputTokens` > `_meta` > `MAX_MCP_OUTPUT_TOKENS` > padrão), corte 70% início / 30% fim com aviso, erro mantém as pontas |
| `src/core/mcp/client.ts` (reescrito) | ver 4.1 |
| `src/core/mcp/tools.ts` (novo) | ferramentas de primeira classe, nomes, schemas, adiamento, elicitação -> `ask_user`, resumo para o prompt |
| `src/core/tools/mcp.ts` | `mcp_reload`, `mcp_read_resource`, `mcp_get_prompt`; `mcp_call` com política por chamada, dica e progresso; `mcp_servers` com dica, ocultas, adiadas, ignoradas, reconexão |
| `src/core/tools/types.ts` | `ToolDef.approval`, `ToolDef.mcp`, `ToolDef.resolveCall`; `McpToolService` ganhou `policy`, `hint`, `reload`, opções de chamada |
| `src/core/security/permissions.ts` | `approval: 'ask'` pede em **todos** os modos, inclusive `unrestricted`; `'allow'` dispensa o prompt (nunca passa por cima de deny, somente-leitura, rede desligada ou bloqueio de credencial); `resolveCall` para `mcp_call`; `Evaluation.risk` |
| `src/core/agent/runner.ts` | ferramentas MCP entram em `availableTools`/`tool_search`/`tool_load` (curinga `mcp__srv__*`, busca por palavras); modos plan/review só recebem as que se declaram somente leitura; ferramentas MCP carregadas ficam carregadas na sessão; aprovação mostra o risco real; resumo dos servidores no prompt; filhos podem achar as ferramentas MCP do chamador |
| `src/core/agent/context.ts` | seção "Integrações MCP" reescrita (caminho direto, adiadas, dicas, reload) |
| `src/main/orchestrator.ts` | partida por servidor com prazo (`Promise.allSettled`), registro reconstruído a cada servidor que termina, recarga de um servidor só (`startMcpServers(only)`, `reloadMcpServers`), `list_changed` sem reiniciar nada, política sincronizada das configurações a cada `rebuildRegistry`, `reconnect` ligado, instalação e login reiniciam só o servidor afetado |
| `src/shared/types.ts` | `McpServerSettings.toolPolicy`, `maxOutputTokens`, `alwaysLoad` |

### 4.1 O cliente (`McpClient`)

- **Transportes**: stdio; Streamable HTTP (resposta JSON **ou** SSE, lida em fluxo: o progresso chega durante a chamada); HTTP+SSE legado de verdade (GET, evento `endpoint`, POST no endpoint anunciado, **mesma origem obrigatória**). Fallback nos dois sentidos: URL `http` que responde 400/404/405 tenta o legado; URL `sse` que não é fluxo (4xx exceto 401/403/408/429, ou 200 sem SSE) tenta Streamable HTTP. Se nenhum funciona, o erro diz o que cada um respondeu.
- **Versão**: oferece `2025-06-18`; aceita `2025-06-18`, `2025-03-26`, `2024-11-05`; erro de versão do servidor com `data.supported` escolhe a melhor em comum, sem isso cai em `2024-11-05`; resposta fora da lista = erro claro.
- **Sessão**: `Mcp-Session-Id` reenviado; 404 com sessão reinicializa **uma vez** e repete a chamada (reinicialização compartilhada entre chamadas simultâneas); DELETE ao parar.
- **Partida limitada**: `startTimeoutMs` (padrão 20 s) vale para **a partida inteira**, não por requisição; em falha o processo/conexão é encerrado. Primeira conexão remota: 3 tentativas em erro transitório. `spawn ENOENT` vira erro com a mensagem; `stderr` do servidor entra no erro quando ele sai na partida.
- **Parada limitada**: fecha stdin, espera `graceMs` (2 s), mata a **árvore** (`taskkill /T /F` no Windows; grupo de processos no POSIX), espera no máximo mais 2 s.
- **Reconexão** (opt-in por `reconnect`; o orquestrador liga): backoff 1, 2, 4, 8, 16 s (limite 30 s), 5 tentativas; estado visível (`state`, `reconnectAttempt`, `nextRetryAt`, `lastError` com "reconexão esgotada"); 401/404 não são repetidos; `reconnectNow()` manual. Chamada somente-leitura/idempotente interrompida por queda é repetida uma vez na conexão nova.
- **Cancelamento e progresso**: `notifications/cancelled` ao abortar e ao estourar o tempo (nunca para `initialize`); `progressToken` = id da requisição, `onProgress` por chamada (o orquestrador liga ao card da ferramenta).
- **`list_changed`** (tools/resources/prompts) com debounce de 250 ms recarrega só aquela lista **neste servidor**; falha mantém a lista anterior; avisa `onToolsChanged(kind)`. Em Streamable HTTP, o GET de escuta só é aberto se o servidor anuncia `listChanged`, e para de insistir se recebe 405.
- **Saída**: limite 25 000 tokens (configurável), aviso acima de 10 000, `structuredContent` preservado em `data`, conteúdo de áudio/`resource_link`/recurso embutido descritos, erros longos mantêm as pontas. Respostas HTTP > 16 MiB abortam.
- **Recursos e prompts**: `listResources`, `listResourceTemplates`, `readResource`, `listPrompts`, `getPrompt`; paginação por `nextCursor` com proteção contra cursor repetido (até 50 páginas).
- **Política**: `setPolicy` troca `includeTools`/`excludeTools`/`approvalTools`/`toolPolicy` sem reconectar; `toolsList()` (o que o usuário configura, inclui `deny`), `exposedToolsList()` (o que o modelo pode chamar), `toolPolicies()`, `policyFor`.

### 4.2 Ferramentas de primeira classe

- Cada ferramenta vira `mcp__<servidor>__<ferramenta>`: só `[a-zA-Z0-9_-]`, até 64 caracteres (limite dos provedores; o Claude Code aceita 128 mas a OpenAI/Anthropic API aceitam 64). Nome longo ganha um hash estável; colisões resolvidas de forma determinística (o primeiro fica com o nome limpo).
- **Risco** pelas anotações: `readOnlyHint` -> `read`; `destructiveHint: true` -> `destructive`; sem anotação -> `exec`. `approvalTools` -> `destructive` + pede. `parallelSafe` quando somente leitura.
- **Adiamento**: servidores com `alwaysLoad` fora do cálculo; os demais, do menor para o maior enquanto o total fica em 15 ferramentas; o servidor que estoura é adiado **inteiro** (achado com `tool_search("jira")`, habilitado com `tool_load(["mcp__jira__*"])`). O prompt lista cada servidor com a contagem direta/sob demanda (só nomes e números, nunca texto do servidor).
- **Esquema**: `$schema` removido; raiz com `anyOf/oneOf/allOf` achatada (com nota de grupos alternativos); propriedade com nome inválido ou `type` diferente de `object` **ignora só aquela ferramenta** e aparece em `mcp_servers` ("ferramenta ignorada"). Argumentos recebem coerção de tipo ("5" -> 5, "true" -> true, JSON em string) e `required` ausente volta um erro útil antes de chamar o servidor.
- **Execução**: o servidor é procurado **na hora da chamada**, então um servidor recarregado funciona sem reconstruir nada; falha vira resultado `ok:false` com a **Dica**.
- `mcp_servers`, `mcp_catalog`, `mcp_call`, `mcp_search` continuam (diagnóstico/reserva); `mcp_call` agora obedece à mesma política (nega ferramenta oculta, pede aprovação igual à direta).

## 5. Decisões

| Tema | Decisão | Por quê |
|---|---|---|
| **Elicitação** | **Implementada, modo formulário.** O cliente anuncia `elicitation: {}`; o pedido do servidor durante uma chamada vira perguntas do `ask_user` (enum e booleano viram opções, número/texto livre) e a resposta volta tipada. Sem como perguntar (subagente) ou fora de uma chamada: `cancel`. Modo URL **não** anunciado | existe o canal (`ctx.ask`) e é o que o Claude faz; modo URL exigiria abrir navegador com validação própria |
| **Sampling** | **Não implementado, não anunciado** | o servidor pediria ao app que chame um LLM por conta dele: exige UI de aprovação do pedido e decisão de custo/provedor que não é do núcleo; servidor que o exige não oferecerá as ferramentas dependentes (como o server-everything faz) |
| **Roots** | Não anunciado | o cliente não conhece a pasta da sessão; um servidor que pergunta recebe `-32601` |
| **Tasks** (spec 2025-11-25) | Fora | versão posterior à que o Openclod suporta |
| **`'ask'` e modo irrestrito** | `'ask'` pede **mesmo em `unrestricted`** | pedido do usuário e é o que o Claude faz com `requiresUserInteraction`. **Confirmei no código: `approvalTools` NÃO fazia isso** (nunca foi aplicado; e `unrestricted` retornava `allow` antes de qualquer verificação). Agora faz. É a única exceção do modo irrestrito |
| **Anotações** | confiamos em `readOnlyHint` para classificar como `read` (nenhum prompt em `ask`) | exigência do pedido; a spec manda tratar anotações como não confiáveis. O usuário pode forçar `ask`/`deny` por ferramenta e `toolPolicy` sempre vence a anotação. Risco aceito: um servidor hostil poderia marcar uma ferramenta destrutiva como somente leitura |
| **Ordem de precedência** | exato > glob mais específico > `_meta` do servidor > `'*'` > `approvalTools` > anotações | alinhada ao `effectiveToolPolicy` do agente AUTH (o "definir todas" do usuário vale mais que a lista do catálogo) |
| **plan/review** | só ferramentas `read` sem `ask` | a regra antiga ("MCP nunca em modo somente leitura") impedia consultar Jira num plano; somente leitura declarada é seguro o bastante |
| **Persistência do carregamento** | ferramentas MCP carregadas ficam na sessão | evita repetir `tool_search`/`tool_load` a cada turno (as outras continuam por turno) |

## 6. Verificação real

Testes automatizados (todos rodados; saída real no relatório do agente):

- `tests/mcp-policy.test.ts` (política, risco, decisão de permissão, dicas, nomes, schemas, adiamento, elicitação, limites, SSE)
- `tests/mcp-client-stdio.test.ts` (paginação, versão, política no cliente, tipos de resultado, saída grande, progresso, elicitação, partida travada, `ENOENT`, `stderr`, stop com processo teimoso, **árvore de processos por `.cmd`**, reconexão, `list_changed`)
- `tests/mcp-client-http.test.ts` (sessão, 404 -> nova sessão, SSE com progresso, elicitação dentro do fluxo, cancelamento, GET de escuta, 401 com `resource_metadata`, recusa de token da Atlassian, SSE legado e os dois fallbacks, 5xx transitório, queda e volta do servidor)
- `tests/mcp-first-class.test.ts` (nomes, classificação, adiamento, execução, e pelo runner real: `tool_search` -> `tool_load` com curinga -> chamada, aprovação por modo, `toolPolicy`, plan/review, `mcp_call`)
- `tests/mcp-orchestrator-robust.test.ts` (Orquestrador com processos reais: servidor travado não segura os outros, recarga de um servidor só, `mcp_reload`, `list_changed` sem reiniciar, política vinda da tela de conectores, reconexão)
- servidor falso: `tests/support/fake-mcp-core.cjs` (protocolo), `fake-mcp-stdio.cjs`, `fake-mcp-http.ts`, `fake-mcp.ts`

Servidores reais (script temporário, apagado depois; medidas desta máquina):

| Servidor | Resultado |
|---|---|
| DeepWiki, Streamable HTTP (`/mcp`) | conectou em 2,6 s, versão `2025-06-18`, `instructions` recebidas, 3 ferramentas; `read_wiki_structure` retornou dados reais com `structuredContent` |
| DeepWiki, `/sse` com `type: sse` | o endpoint foi aposentado (HTTP 410): erro "nenhum transporte MCP funcionou ... HTTP 410; HTTP 405 em initialize" com a dica de usar `/mcp` |
| Notion (`/mcp`) sem login | HTTP 401 com desafio `Bearer realm="OAuth", resource_metadata=...` preservado no erro; dica de OAuth gerada |
| Atlassian Rovo (`/v1/mcp`) com cabeçalho `Basic` falso | **não reproduz o erro do Jira**: `initialize` e `tools/list` funcionam sem credencial válida e devolvem só 4 ferramentas genéricas (`getContentFormatGuide`, `getTeamworkGraphContext`, `getTeamworkGraphObject`, `addTeamworkGraphContext`); a chamada falha com `-32602`. A recusa "You don't have permission to connect via API token" só aparece com credencial real; **a dica foi validada contra o texto informado e o servidor falso, não contra a Atlassian com token** |
| `@modelcontextprotocol/server-everything` por `npx` (Windows, via `cmd.exe`) | conectou em 8,4 s, 14 ferramentas, 7 recursos, 4 prompts; `echo` respondeu; `stop()` em 385 ms |
| binário embutido `open-computer-use` (stdio) | continua conectando com a nova negociação (teste `harness.test.ts` do binário passou) |

## 7. O que ficou de fora e limitações

- **Sampling, roots, tasks, elicitação em modo URL**: não implementados (seção 5).
- **Prompts como comandos (`/mcp__servidor__prompt`) e menção `@servidor:uri`**: só a camada de dados (`listPrompts`, `getPrompt`, `readResource`, `listResources`, ferramentas `mcp_get_prompt`/`mcp_read_resource`); a interface e o parser de menções não foram feitos (são da camada da UI).
- **Texto do servidor no prompt**: `instructions` do servidor ficam disponíveis em `client.instructions`/`describe()`, mas **não** entram no system prompt (vetor de injeção: texto controlado pelo servidor dentro de instruções do sistema). O Claude as inclui; aqui seria preciso um bloco rotulado como dado não confiável.
- **Resultado grande não vai para arquivo**: é cortado no meio (70/30) com aviso; o Claude grava em arquivo e devolve o caminho. O runner já grava saídas acima de 16 000 caracteres em arquivo, então na prática o modelo recebe o trecho + caminho do que sobrou após o corte de 100 KB.
- **Adiamento por contagem, não por tamanho do schema**: 15 ferramentas no total (servidores pequenos primeiro). O Claude usa 10% do contexto. `alwaysLoad` cobre o resto.
- **Descrições**: corte em 2 048 (inline) / 4 096 (adiada) caracteres; o Claude usa 4 096 / 16 384.
- **Nome da ferramenta**: 64 caracteres (o Claude aceita 128; os provedores aceitam 64).
- **Sem renovação de token por `headersHelper`** e sem expansão de `${VAR}` em `url`/`headers` (o agente AUTH cuida de segredos).
- **Reconexão do stdio**: reinicia o processo; ferramentas com efeito colateral e sem dica de idempotência **não** são repetidas.
- **Sessão do `loadTools` entre turnos**: só ferramentas MCP persistem; o resto do mecanismo lazy continua por turno.
- **Escopos `.mcp.json` (project/local/user) e `claude mcp add`**: não implementados; o Openclod guarda tudo em `settings.mcpServers` (há importação do catálogo do Claude Desktop/Code no orquestrador, de outro agente).
- A recusa de token da Atlassian não pôde ser reproduzida sem credencial real (seção 6).

## 8. Pontos de contato com os outros agentes

- **AUTH** (`src/main/connector-service.ts`): `effectiveToolPolicy` é uma função própria; a ordem de precedência foi **alinhada** (exato > glob > `'*'` > `approvalTools` > anotações). Diferença que ficou: para uma ferramenta **sem anotação e sem configuração**, `effectiveToolPolicy` mostra `allow` e `resolveToolPolicy` devolve `ask` (porque o modo `ask` do app **de fato** pede). Recomendo a tela usar `client.toolPolicies()` (traz `policy`, `explicit`, `source`, `reason` e `risk` de cada ferramenta, incluindo as negadas) ou importar `resolveToolPolicy` de `src/core/mcp/policy.ts`.
- `connectors.tools()` deve continuar usando `client.toolsList()`: ela inclui as ferramentas com `deny` (para o usuário poder reativar); o que o modelo vê é `exposedToolsList()`.
- `refreshTools: () => this.rebuildRegistry()` já basta para uma mudança de política valer na hora: `rebuildRegistry` copia `toolPolicy`/`approvalTools`/`includeTools`/`excludeTools` das configurações para os clientes vivos.
- `restartMcp()` continua reiniciando todos; para um servidor só use `reloadMcpServers(nome)` (relatório por servidor) ou `startMcpServers(nome)` (privado).
- **DIRETÓRIO**: nada a mudar; `approvalTools`/`oauth*` do catálogo seguem valendo (`approvalTools` agora é aplicado de verdade).
