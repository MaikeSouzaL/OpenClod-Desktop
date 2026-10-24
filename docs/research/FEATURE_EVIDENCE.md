# Evidências de funcionalidade

Cada linha liga uma capacidade a uma evidência concreta e ao grau de confiança.
Confiança: **alta** (verificado por execução ou arquivo), **média**
(estrutura/contagem), **baixa** (inferência).

| Capacidade | Evidência | Confiança | Como o Openclod cobre |
|---|---|---|---|
| App Electron com processo principal e renderer | 573 fontes, 93 `contextBridge`, 534 `ipcRenderer`, 45 fronteiras | alta | mesma topologia, com preload mínimo |
| IPC extenso entre main e UI | 153 endpoints, 469 rotas | alta | IPC tipado por canal (`session:*`, `settings:*`, `approval:*`) |
| Execução de ferramentas pelo agente | harness do Claude Code é CLI separado; app é cliente | média | AgentLoop próprio com ToolRegistry |
| Streaming de resposta | `stream` 300 ocorrências; UI mostra texto progressivo | média | SSE incremental + eventos `text_delta` |
| Retomada de sessão | `resume` 22, `session` 1224 | média | sessões em disco + event log |
| Compactação de contexto | `compact` 28 | média | sumarização + fallback determinístico |
| MCP | `mcp` 784 | média | cliente MCP stdio (initialize/tools/list/tools/call) |
| Skills | `skill` 87 | média | `SKILL.md` com frontmatter, carregadas sob demanda |
| Hooks | `hook` 82 | média | hooks before/after tool + auditoria |
| Permissões | `permission` 22, `sandbox` 37 | média | allow/ask/deny + blocklist + path guard |
| Subagentes | `subagent` 6 | baixa | ferramenta `task` com sessão filha e ferramentas restritas |
| Worktrees | `worktree` 9 | baixa | não implementado nesta versão (git_checkout manual) |
| Terminal | `terminal` 277 | média | console de comandos com streaming (sem PTY) |
| Diff | `diff` 30 | média | diff unificado gerado a partir do tracker |
| Computer Use no próprio app | árvore UIA rasa (só regiões e botões de janela) | alta | percepção híbrida com screenshot |
| Múltiplos provedores | app aceita apenas modelos Anthropic desde 2026-05-07 (nota do README do cdesktop) | média | adaptadores OpenAI-compat + Anthropic + locais |

## Evidências de execução (não apenas leitura)

| Item | Comando | Resultado observado |
|---|---|---|
| REA operacional | `npx rea-agents@6.7.0 doctor` | `node 22.22.1`, `host win32 x64` OK; engines nativos ausentes (esperado) |
| Análise JS do Claude Desktop | `rea analyze-javascript-application app.asar` | exit 0; 455 MB de evidência; 573 fontes |
| Computer Use — listar apps | `ocu call list_apps` | lista com `claude` pid 19072, `chrome`, `devenv`, `OpenCode` |
| Computer Use — janelas | `ocu call list_windows` | 7 janelas com ids (ex.: `claude` 458908) |
| Computer Use — árvore UIA | `ocu call get_app_state --args {"app":"explorer"}` | árvore com `element_index` (botões Iniciar/Pesquisar/Relógio) |
| Captura de tela nativa | PowerShell GDI `CopyFromScreen` | PNG 3840×1082 (virtual desktop, 465 KB) |
| Screenshot do `ocu` | `ocu screenshot --output ...` | **falhou**: `GetDIBits failed` — por isso a captura própria |
| Playwright instalado | `npm view playwright` → 1.64.1 | Apache-2.0 |
| Chrome e Edge instalados | `C:\Program Files\Google\Chrome\Application\chrome.exe`, `msedge.exe` | usados via `channel: 'chrome'`/`'msedge'` |

## Falsos positivos que evitamos

- `approval` = 0 ocorrências e `computer` = 5483 no bundle: contagem textual
  não é evidência de recurso. Não usamos esses números como prova.
- `artifact` = 177.249: é nome de campo no JSON de evidência, não recurso do app.
- A presença de `ipcRenderer` não revela os nomes dos canais (o bundle usa
  referências indiretas); a extração de canais retornou 0 — registrado como
  limitação, não como "não há IPC".
