# Funcionalidades dos repositórios × código do Openclod (2026-10-23)

Pergunta: *"rodas as possíveis funcionalidades dos repositórios estão dentro do
nosso projeto? embarcado no nosso código?"* — **Não todas.** Esta tabela diz,
funcionalidade por funcionalidade, o que está embarcado, o que foi verificado e
o que continua de fora (e por quê). Origem das funcionalidades:
[`REPOSITORIES.md`](REPOSITORIES.md) §"Estudo do código-fonte" (leitura direta
dos clones em `repositorios/`). Nenhum código foi copiado: tudo foi
reimplementado em TypeScript próprio, e dois repositórios sem licença
(claw-code-local, Mcp.ComputerUse) só serviram de referência conceitual.

Legenda — **Embarcado** = existe no código e tem teste automatizado ·
**Parcial** = só parte da funcionalidade · **Sem UI** = módulo pronto e
testado, ainda não ligado à interface · **Não** = ausente.
Nenhum item foi validado com um modelo de linguagem real (não há provedor
configurado nesta máquina); onde digo "verificado", o teste usou servidores
falsos locais, CLIs falsos ou o app real com o provedor de teste (Scripted).

## opencode (MIT)

| Funcionalidade | Estado | Observação |
|---|---|---|
| Provedores OpenAI-compatível e Anthropic; compatibilidade por modelo (`max_completion_tokens`, sem `temperature` em o-series/gpt-5, eco de `reasoning_content`) | **Embarcado** | `compat.ts`; 9 presets (OpenAI, Anthropic, DeepSeek, Kimi, Qwen, OpenRouter, Ollama, LM Studio, Scripted). **Não**: Gemini nativo, Bedrock Converse, OpenAI Responses — os ~50 provedores do opencode vêm de um SDK próprio |
| Classificação de erro, `Retry-After`, timeouts 300 s/600 s, jitter | **Embarcado** | `http.ts`, 6 testes |
| Descoberta de modelos locais (Ollama `/api/tags`+`/api/show`, LM Studio) e de servidores OpenAI/Anthropic | **Embarcado** | `discovery.ts`, botão "Detectar modelos" em Configurações → Provedores. Testado contra servidores HTTP falsos; **não** contra um Ollama/LM Studio real (nenhum instalado aqui) |
| Catálogo models.dev (230 provedores, 8.848 modelos com custo e limites) | **Não** | termos de uso dos dados não verificados; a descoberta ao vivo cobre o caso local |
| Continuação quando a saída é cortada; último passo sem ferramentas | **Embarcado** | `runner.ts` |
| Ferramentas começam a rodar durante o stream | **Não** | o Openclod executa depois do fim do stream |
| Edição tolerante (aspas, travessões, CRLF) | **Parcial** | sem tolerância a espaço no fim da linha |
| Regras `Tool(padrão)` deny > ask > allow, salvas por projeto | **Embarcado** | arquivo JSON, não SQLite. **Não**: análise do shell com tree-sitter |
| Compactação com modelo estruturado (Objective, Requirements, Decisions, Work State, Next Move, Relevant Files) | **Embarcado** | `compaction.ts`; os turnos mantidos perdem os blocos de raciocínio (assinaturas) |
| Servidor HTTP + SSE (OpenAPI), LSP | **Não** | fora de escopo do app desktop |

## openharness (MIT)

| Funcionalidade | Estado | Observação |
|---|---|---|
| Compactar e repetir ao estourar o contexto | **Embarcado** | |
| Compactação em camadas (microcompact, session-memory, context-collapse) | **Parcial** | só o resumo por modelo + fallback determinístico |
| Saída grande de ferramenta vai para arquivo, o modelo vê prévia | **Embarcado** | 60 000 caracteres; cabeça 10k + cauda 4k + caminho; apagada junto com a sessão |
| Hooks: 10 eventos, matcher, timeout | **Embarcado** | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Notification` |
| Hooks tipos `command` e `http` | **Embarcado** | http: só http/https, sem variáveis de ambiente, sem seguir redirecionamento. **Não**: tipos `prompt` e `agent` |
| Caminhos sensíveis (`~/.ssh`, `.aws`, `.kube`, `.gnupg`, credenciais do Windows…) bloqueados em **qualquer** modo | **Embarcado** | `sensitive.ts`; vale até contra regra "permitir" e hook que aprova. Limites conhecidos: ofuscação (`~/.s*h`) e ferramentas MCP não são cobertas |
| Tarefas em segundo plano (`task_create/get/list/output/stop`) | **Parcial** | `start_process`, `read_process_output`, `list_processes`, `stop_process` + diálogo "Tarefas em segundo plano" na UI (listar/ler/encerrar: encerrar não foi exercitado) |
| Subagentes / coordenador / swarm | **Parcial** | `task` com um nível, mesmo modelo, ferramentas restritas. **Não**: enxame, coordenação em paralelo |
| Memória | **Parcial** | fatos por projeto |
| Sandbox | **Não** | sem isolamento do SO |
| Canais (Feishu, Slack, Telegram, Discord), TUI Ink | **Não** | fora de escopo |

## cdesktop (Apache-2.0)

| Funcionalidade | Estado | Observação |
|---|---|---|
| Rodar agentes CLI instalados | **Parcial** | ferramenta `external_agent` para **Claude Code** e **Codex** (`claude -p --output-format stream-json`, `codex exec --json`); nunca usa `bypassPermissions`/`--dangerously-skip-permissions`; prompt por stdin; mata a árvore ao cancelar. Versões detectadas aqui: Claude Code 2.1.308, codex-cli 0.163.0. **Verificado só com CLIs falsos** (rodar o real gastaria a sua conta). **Não**: Gemini, OpenCode, Cursor, Qwen, Copilot, Droid, Amp, Hermes |
| Terminal PTY + xterm | **Embarcado** | verificado no app real |
| Preview de app com detecção do servidor | **Embarcado** | `<webview>` + `launch.json`; verificado com um servidor de dev real. **Não**: devtools injetado no proxy, emulação de dispositivo |
| Worktrees por sessão | **Sem UI** | `createWorktree/listWorktrees/removeWorktree` em `src/core/git/service.ts`, 19 testes (recusa remover o principal, com alterações ou travado). **Falta**: criar a sessão dentro da worktree, botão e IPC |
| Diff do Git | **Embarcado** | painel Alterações |
| Diff com comentários por linha enviados ao compositor | **Não** | |
| Grade de até 4 sessões / split view | **Não** | |
| Rotinas agendadas | **Embarcado** | página Agendados + agendador no processo principal; uma execução real foi disparada com o provedor Scripted |
| PRs, GitHub, times de agentes (`team spawn`), SQLite | **Não** | |

## deepseek-harness (MIT)

| Funcionalidade | Estado | Observação |
|---|---|---|
| Claude Code e Codex como subagentes | **Parcial** | via `external_agent` (acima) |
| Ler `hooks` do Claude Code | **Embarcado** | `.claude/settings.json` do projeto, opcional (Configurações → importar) |
| Aprovação que falha fechada | **Embarcado** | aprovação expira como "negado" |
| Sandbox de escrita no Windows (ACL + integridade Low) | **Não** | candidato a próximo passo de segurança |
| Arquitetura de plugins (Cordis), painéis acopláveis | **Não** | o painel lateral tem esquerda/direita, maximizar e largura |

## claw-code-local (sem licença — só conceitos)

| Funcionalidade | Estado | Observação |
|---|---|---|
| Protocolo de hooks (exit 0/2 + JSON) e regras `Tool(subject)` | **Embarcado** | reimplementado do zero |
| ~143 slash commands (≈27 funcionais) | **Parcial** | o compositor tem 8 comandos embutidos |

## open-computer-use (MIT) e Mcp.ComputerUse (sem licença)

| Funcionalidade | Estado | Observação |
|---|---|---|
| 14 ferramentas de Computer Use com processo MCP persistente | **Embarcado** | leitura verificada no backend real; clique real não foi exercitado |
| DPI Per-Monitor V2 / remapeamento de coordenadas | **Parcial** | origem e escala da captura convertidas (`screenshotToScreen`); o backend Go não declara DPI awareness |

## REA (MIT)

| Funcionalidade | Estado | Observação |
|---|---|---|
| REA como servidor MCP do agente | **Embarcado** | preset detectado em `Desktop\REA\rea`, botão "Adicionar" em Personalização → Conectores. Filtros `includeTools`/`excludeTools`, `approvalTools` (18 de 185 ferramentas pedem aprovação sempre) e timeout de 360 s. Handshake real: pronto em 4,4 s, 185 ferramentas. **Cuidado:** 185 ferramentas ≈ 305 KB de definições a cada pedido — filtre com `includeTools` antes de usar. Nenhum turno de agente com o REA foi rodado |

## Defeito encontrado ao auditar

Ferramentas **MCP eram registradas mas nunca chegavam ao modelo** (o
`runner` só oferecia nomes fixos por modo). Corrigido: entram nos modos
código, depurar, autônomo, web e computador, nunca nos somente-leitura.
Teste: `tests/runner.test.ts` → "offers registered MCP tools in working modes only".

## Ainda em aberto (ordem sugerida)

1. Ligar worktrees à criação de sessão (módulo pronto).
2. Sandbox de escrita por ACL no Windows.
3. Um turno real com um modelo (FreeLLMAPI ou chave de nuvem) para validar o
   loop, o `external_agent` e o REA fora de testes com servidores falsos.
4. Tipos de hook `prompt` e `agent`; análise de shell com tree-sitter.
5. Mais agentes externos (Gemini CLI, OpenCode); Gemini/Bedrock nativos.
6. Rewind/checkpoints, chat lateral, comentários de diff, split view.
