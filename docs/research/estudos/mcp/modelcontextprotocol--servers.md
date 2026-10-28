# MCP reference servers

| Campo | Valor |
|---|---|
| Repositório | https://github.com/modelcontextprotocol/servers |
| Clone local | `repositorios/_research/mcp/modelcontextprotocol--servers` |
| Commit | `ef9808f71090d0db3eda99e2af2ba78f1086f4fb` |
| Licença | transição MIT → Apache-2.0 no root (`LICENSE:1-5`); servidores Python em MIT (`src/git/pyproject.toml:12`) |
| Categoria | mcp (servidores de referência) |
| Stack | TypeScript/Node >= 24 (`src/filesystem/package.json:16`), Python >= 3.10 (`src/git/pyproject.toml:6`), `@modelcontextprotocol/server` 2.x, `mcp` 2.x |
| Tamanho | 344 arquivos; ~29.416 linhas TS e ~8.347 linhas Python; 54 testes `.test.ts` e 12 arquivos `test_*.py` |

## 1. O que é (verificado no código)

Não é um SDK: é o monorepo dos **sete servidores de referência** do MCP —
`everything`, `fetch`, `filesystem`, `git`, `memory`, `sequentialthinking` e
`time` (`src/*`, workspaces em `package.json:10-12`). Cada servidor é um
pacote publicável com binário próprio (`src/filesystem/package.json:18-20`,
`src/memory/package.json:18-20`, `src/everything/package.json:18-20`).

Os quatro servidores TypeScript foram migrados para o SDK v2 e servem as duas
eras do protocolo via `serveStdio` (`src/filesystem/index.ts:4-12`,
`src/everything/transports/stdio.ts:4-10`). Os três Python usam `mcp>=2.3,<3`
(`src/git/pyproject.toml:21`) e o mesmo padrão de fábrica por era
(`src/git/tests/test_eras.py:1`, `src/fetch/tests/test_eras.py:1`).

O README do repositório vende “reference implementations”, e o código confirma:
são exemplos completos e testados, não bibliotecas para importar. O valor para
o Openclod está nas **decisões de segurança** de filesystem/fetch/git e no
**modelo de estado** de memory/sequentialthinking.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run build` | `package.json:16` | build de todos os workspaces |
| `npm run test` | `package.json:34` | Vitest/Pytest por workspace |
| `npm run validate` | `package.json:26` | guards + validação de todos os workspaces |
| `npm run smoke` | `package.json:45` | sobe os servidores e faz smoke real |
| `npm run interface-diff` | `package.json:46` | compara a superfície de tools com o baseline |
| `npm run pack:verify` | `package.json:47` | empacota e verifica o artefato publicado |
| `mcp-server-filesystem <dirs>` | `src/filesystem/package.json:18-20`, `src/filesystem/README.md:24` | stdio com allow-list de diretórios |
| `npx -y @modelcontextprotocol/server-everything` | `src/everything/README.md:51` | everything em stdio |
| `node dist/index.js streamableHttp` | `src/everything/package.json:28-30` | everything em HTTP (porta 3001, `transports/streamableHttp.ts:393`) |
| `uvx mcp-server-fetch` | `src/fetch/README.md:82-83` | fetch em stdio |
| `uvx mcp-server-git --repository <path>` | `src/git/README.md:119-137` | git confinado a um repositório |

Superfície de configuração: argumentos de linha de comando (diretórios do
filesystem, `--repository` do git), variáveis de ambiente
(`MEMORY_FILE_PATH` em `src/memory/README.md:243`,
`DISABLE_THOUGHT_LOGGING` em `src/sequentialthinking/lib.ts:25-27`) e Roots
apenas na era 2025 (`src/filesystem/README.md:29-36`). Não há arquivo de
configuração próprio.

## 3. Arquitetura e fluxo

```
bin (dist/index.js | mcp_server_*.main)
  → createServer()/create_server()  (fábrica por era)
  → serveStdio(factory) | StreamableHTTPServerTransport | SSE
  → McpServer/MCPServer (tools/resources/prompts)
  → implementação local (fs, GitPython, httpx, JSONL)
```

- Entry point TS: `src/filesystem/index.ts:30-85` (argv → diretórios) e
  `:116` (`serveStdio`); `src/sequentialthinking/index.ts:191-194`;
  `src/everything/index.ts:23-38` (dispatch stdio/sse/streamableHttp).
- Entry point Python: `src/git/src/mcp_server_git/__main__.py:1-3` →
  `src/git/src/mcp_server_git/server.py:699-718`; `src/fetch/src/mcp_server_fetch/server.py:540-556`;
  `src/time/src/mcp_server_time/server.py:269`.
- Fábrica por era: `src/filesystem/server.ts:185`; `src/everything/server/index.ts:1-30`.
- Execução de tool: `server.registerTool` (filesystem `server.ts:281-820`) e
  `@server.tool` (git `server.py:529-694`, fetch `server.py:440-515`).
- Estado: memória em JSONL (`src/memory/index.ts:437-515`), sequential em
  memória do processo (`src/sequentialthinking/lib.ts:15-30`), git/fetch/time
  stateless.
- Transporte HTTP: `src/everything/transports/streamableHttp.ts:141-403`
  (Express, `/mcp`, CORS, GET/DELETE legados, handler moderno).

## 4. Catálogo de ferramentas / capacidades

| Servidor | Ferramentas / capacidade | Arquivo:linha | Risco |
|---|---|---|---|
| filesystem | 14 tools: `read_file`, `read_text_file`, `read_media_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `move_file`, `search_files`, `get_file_info`, `list_allowed_directories` | `src/filesystem/server.ts:281-820` | alto (escrita) |
| filesystem | Roots dinâmicos (2025) e allow-list por argv | `src/filesystem/server.ts:821-925`; `src/filesystem/README.md:19-36` | médio |
| git | 12 tools: status, diff (3), commit, add, reset, log, create/checkout branch, show, branch | `src/git/src/mcp_server_git/server.py:60-73`, `:529-694` | alto |
| git | anotações `readOnlyHint`/`destructiveHint` por tool | `src/git/src/mcp_server_git/server.py:471-483` | baixo |
| fetch | 1 tool `fetch` + 1 prompt `fetch` | `src/fetch/src/mcp_server_fetch/server.py:440-537` | médio (SSRF) |
| fetch | robots.txt, bloqueio de IP privado, proxy, truncamento | `src/fetch/src/mcp_server_fetch/server.py:139-166`, `:260-307`, `:458-514` | alto |
| memory | 9 tools: create/delete entities, relations, observations; read/search/open graph | `src/memory/index.ts:779-1110` | médio |
| memory | 1 resource `memory://knowledge-graph` | `src/memory/index.ts:729`, `src/memory/README.md:138` | baixo |
| sequentialthinking | 1 tool `sequentialthinking` com revisão/ramificação | `src/sequentialthinking/index.ts:53`, `src/sequentialthinking/lib.ts:15-30` | baixo |
| time | 2 tools: `get_current_time`, `convert_time` | `src/time/src/mcp_server_time/server.py:41-42`, `:225-264` | baixo |
| everything | 14 tools comuns + 2 legadas + até 5 condicionais + 7 modernas | `src/everything/tools/index.ts:46-127` | alto (demo) |
| everything | resources/templates, prompts, sampling, elicitation, logging, tasks | `src/everything/resources/index.ts:12-24`, `src/everything/prompts/index.ts:10-15`, `src/everything/server/tasks.ts:1` | alto |

## 5. Loop do agente, contexto e streaming

Não existe loop de agente; são servidores passivos. O “loop” é o dispatch de
requests do SDK, com handlers registrados. O que merece estudo:

- **Roots**: o filesystem escuta `notifications/roots/list_changed`, pede
  `roots/list` e troca a allow-list, com geração para descartar resposta velha
  (`src/filesystem/server.ts:821-925`). Uma chamada que chega durante o refresh
  espera uma barreira (`src/filesystem/server.ts:207-223`).
- **Notificações**: memory emite `notifications/resources/updated` em toda
  mutação (`src/memory/README.md:138`); everything tem tools que disparam
  `list_changed`, logging, progresso e atualização de resource
  (`src/everything/tools/index.ts:46-66`).
- **MRTR**: everything usa `requestState` assinado com HMAC-SHA256 e TTL de
  600 s (`src/everything/server/index.ts:72-86`), e declara `requestState.verify`
  no servidor (`:155`).
- **Progresso/cancelamento**: `trigger-long-running-operation` reporta
  progresso e respeita cancelamento (`src/everything/tools/trigger-long-running-operation.ts:1-75`).
- **Streaming**: o transporte HTTP usa SSE por request; a era modern usa
  `createMcpHandler` por request, sem sessão (`transports/streamableHttp.ts:1-21`).

## 6. Sessões, estado e persistência

| Servidor | Estado | Onde | Persistência |
|---|---|---|---|
| memory | grafo (entidades/relações/observações) | `src/memory/index.ts:357-515` | JSONL + lock + rename atômico |
| sequentialthinking | histórico e branches por conexão | `src/sequentialthinking/lib.ts:15-30` | só memória; morre com a conexão |
| filesystem | allow-list mutável | `server.ts:189-200` | só memória (argv/roots) |
| everything | tasks, subscriptions, requestState | `server/tasks.ts`, `server/index.ts:82-86` | memória + codec assinado |
| git/fetch/time | nenhum | — | stateless |

O memory é o caso mais maduro: lock exclusivo por arquivo (`O_EXCL`) com
detecção de dono morto e timeout (`index.ts:232-296`), gravação em temp +
`chmod` + `rename` atômico (`index.ts:461-515`), e migração de `memory.json`
para `memory.jsonl` (`index.ts:45-79`). A concorrência entre dois clientes no
mesmo arquivo é explicitamente tratada (`README.md:247`).

## 7. Configuração e extensibilidade

- Filesystem: diretórios obrigatórios no argv; Roots substitui a lista na era
  2025; na era 2026 só argv vale (`README.md:19-36`).
- Git: `--repository` limita todo acesso; sem ele, cada tool recebe `repo_path`
  e valida contra a raiz permitida (`server.py:351-368`).
- Fetch: flags `--ignore-robots-txt`, `--proxy-url`, `--allow-private-ips`,
  `--user-agent` (`server.py:418-432`, `README.md:53-60`).
- Memory: `MEMORY_FILE_PATH` (`index.ts:52-64`).
- Time: `--local-timezone` (`src/time/src/mcp_server_time/server.py:215-223`, `:269`).
- Extensibilidade: não há plugins; cada servidor é um pacote independente.
  Toda a composição acontece no cliente MCP.

## 8. Permissões, sandbox e erros

O sandbox é **por allow-list**, não por container:

- **filesystem**: normaliza e resolve symlinks na inicialização
  (`src/filesystem/index.ts:31-72`), valida cada caminho contra a lista
  (`path-validation.ts:12-93`) e, para escrita, ancora o diretório e abre o
  arquivo com `O_NOFOLLOW`/`O_EXCL`, comparando o inode para fechar a janela
  TOCTOU (`pinned-directory.ts:173-250`). `move_file` recusa destino existente
  (`lib.ts:380-403`). Não há sandbox de processo.
- **git**: `validate_repo_path` resolve os dois lados e exige
  `relative_to` (`server.py:351-368`); nomes de branch que começam com `-` são
  rejeitados para evitar injeção de flag (`server.py:252-258`, `:286-288`);
  não existe tool de comando git arbitrário — só o enum `GitTools`
  (`server.py:60-73`).
- **fetch**: hook do httpx resolve o host e recusa IP privado/loopback/link-local
  em cada hop de redirect (`server.py:139-166`); robots.txt é consultado antes
  do fetch autônomo e em cada redirect (`:260-307`, `:328-336`); conteúdo é
  truncado por `max_length`/`start_index` (`:458-514`); proxy `socks://` é
  normalizado (`:224-241`).
- **erros**: tools retornam `isError: true` com texto acionável em vez de
  derrubar a conexão (`src/git/README.md:111`); JSON-RPC inválido vira
  `-32602` (`INVALID_PARAMS`).

Não foi encontrado sandbox de SO, seccomp, container obrigatório ou aprovação
humana dentro destes servidores. A aprovação é responsabilidade do host.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| filesystem | `src/filesystem/__tests__/` (13 arquivos; `server-tools.test.ts` 1.796 linhas) | path traversal, symlink, Roots, tools, Windows |
| memory | `src/memory/__tests__/` (12 arquivos) | lock, atomic save, migração, grafo, resource |
| sequentialthinking | `src/sequentialthinking/__tests__/` | histórico, branches, validação |
| everything | `src/everything/__tests__/` (21 arquivos; `streamable-http.test.ts` 776 linhas) | stdio/SSE/HTTP, tasks, sampling, elicitation |
| git (Python) | `src/git/tests/` (4 arquivos; `test_protocol.py` 1.096 linhas) | protocolo, eras, tools, snapshots |
| fetch (Python) | `src/fetch/tests/` (4 arquivos) | SSRF, robots, truncamento, eras |
| time (Python) | `src/time/tests/` (4 arquivos) | timezone, DST, protocolo |

Há testes de protocolo reais que sobem o servidor e falam JSON-RPC
(`src/git/tests/test_protocol.py:1`, `src/fetch/tests/test_protocol.py:1`), e
snapshots da lista de tools (`src/git/tests/snapshots/list_tools.json:1`).
O root ainda roda `validate`, `smoke`, `interface-diff` e `pack:verify`
(`package.json:26-47`), o que é mais rigoroso que a média dos MCPs públicos.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Guard de caminho + abertura ancorada (anti-TOCTOU) | `src/filesystem/path-validation.ts:12-93`, `pinned-directory.ts:173-250` | fecha symlink race e valida Windows/UNC | MIT/Apache-2.0 | `src/core/security/path-guard.ts` | 23 |
| Fetch seguro (SSRF + robots + redirect + truncamento) | `src/fetch/src/mcp_server_fetch/server.py:139-166`, `:260-336`, `:458-514` | protege contra metadata endpoint e redirect cego | MIT | `src/core/browser/fetch-guard.ts` | 22 |
| Superfície git com allow-list e antisflag | `src/git/src/mcp_server_git/server.py:60-73`, `:351-368` | sem shell, sem comando arbitrário, confinado | MIT | `src/core/git/tools.ts` | 20 |
| Store de grafo com lock e rename atômico | `src/memory/index.ts:232-296`, `:437-515` | seguro entre processos e contra crash | MIT/Apache-2.0 | `src/core/memory/graph-store.ts` | 19 |
| Edit file com matching tolerante a whitespace/line ending | `src/filesystem/lib.ts:380-520` | reduz falha de edição por CRLF/indentação | MIT/Apache-2.0 | `src/core/tools/edit.ts` | 16 |
| `serveStdio` com fábrica por era | `src/filesystem/index.ts:18-30` | mesma base para 2025 e 2026 | MIT/Apache-2.0 | `src/core/mcp/server/stdio.ts` | 14 |
| requestState assinado para MRTR | `src/everything/server/index.ts:72-86` | state stateless à prova de adulteração | MIT/Apache-2.0 | `src/core/mcp/request-state.ts` | 13 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| O monorepo inteiro | são 7 produtos independentes, com releases e bins próprios |
| `everything` como dependência | é demo de protocolo, não servidor de produção |
| Implementação Python de git/fetch/time | nosso núcleo é TypeScript; reimplementar só as regras |
| Chalk/ANSI no sequentialthinking | logging de terminal não serve ao app Electron |
| Roots como mecanismo principal | Roots está deprecado em 2026-07-28 (`README.md:14`) |
| A allow-list global do filesystem | nosso sandbox já tem raízes por workspace; portar só a abertura ancorada |
| Testes de snapshot de tools | úteis lá, frágeis aqui; preferir testes de contrato |

## 12. Modelo de exemplo para o nosso harness

1. **`PathGuard`** com `resolveWithin(root, candidate)`, `openPinned(dir, name)`
   e `renameInto(dir, temp, target)`. Regras: resolver symlinks, comparar
   inode, `O_NOFOLLOW`, recusar null byte e drive diferente no Windows. Base:
   `path-validation.ts:12-93` + `pinned-directory.ts:173-250`.
2. **`FetchGuard`** com `assertPublicHost(host)`, `checkRobots(url)`,
   `followRedirectsWithinPolicy` e `truncate(text, start, max)`. Aplicar em
   toda tool de fetch/navegador, não só no MCP.
3. **`GitToolset`** fechado: 12 operações, sem `runCommand`; validar
   `repo_path` contra a raiz e rejeitar refs que começam com `-`. Base:
   `server.py:60-73` e `:351-368`.
4. **`GraphStore`** com `withFileLock`, `load`, `saveAtomic`, `mode` preservado
   e recurso `memory://knowledge-graph` para leitura. Base:
   `src/memory/index.ts:232-515`.
5. **Testes**: um caso por ataque — symlink para fora, hardlink, junction do
   Windows, redirect para `169.254.169.254`, robots disallow, branch `--upload-pack`,
   lock abandonado. O repositório já tem esses casos em
   `pinned-directory.test.ts`, `test_protocol.py` e `test_eras.py`; usar como
   oráculo, não copiar o arquivo inteiro.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/mcp/modelcontextprotocol--servers rev-parse HEAD
ef9808f71090d0db3eda99e2af2ba78f1086f4fb
$ ls src
everything  fetch  filesystem  git  memory  sequentialthinking  time
$ grep -n "server.registerTool" src/filesystem/server.ts | wc -l
14
$ grep -n "registerTool" src/git/src/mcp_server_git/server.py | wc -l
12
$ grep -n "withFileLock\|rename(tempFilePath" src/memory/index.ts
239:export async function withFileLock<T>(
510:      await fs.rename(tempFilePath, this.memoryFilePath);
$ grep -n "O_NOFOLLOW\|openInDirectory" src/filesystem/pinned-directory.ts
53:  return fs.constants.O_NOFOLLOW ?? 0;
178:function openInDirectory(
$ grep -n "_refuse_private_destination\|check_may_autonomously_fetch_url" \
    src/fetch/src/mcp_server_fetch/server.py
139:async def _refuse_private_destination(request: httpx.Request) -> None:
260:async def check_may_autonomously_fetch_url(
$ grep -n "validate_repo_path\|startswith(\"-\")" src/git/src/mcp_server_git/server.py
252:    if branch_name.startswith("-"):
351:def validate_repo_path(repo_path: Path, allowed_repository: Path | None) -> None:
$ find src -name '*.test.ts' | wc -l
54
$ find src -name 'test_*.py' | wc -l
12
```
