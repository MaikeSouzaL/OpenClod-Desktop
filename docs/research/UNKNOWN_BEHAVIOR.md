# Comportamento desconhecido

Itens que **não** foram determinados. Cada um indica por que, o que foi tentado
e como resolver, para não confundir hipótese com fato.

Status atualizado na rodada 2 (2026-10-23). Detalhes em
`CLAUDE_DESKTOP_OBSERVATIONS.md`, seção "Rodada 2".

| # | Desconhecido | Status | O que se sabe agora | Próximo passo |
|---|---|---|---|---|
| 1 | Nomes dos canais IPC do Claude Desktop | **resolvido** | 1.400 métodos em 19 namespaces; formato `$eipc_message$_<uuid>_$_<ns>_$_<Interface>_$_<método>` (§2.4) | — |
| 2 | Formato exato do stream de eventos do Claude Code | **parcial** | argv stream-json + família de `control_request` (§2.5); o esquema completo é o do Claude Agent SDK, que é público | ler a documentação oficial do Agent SDK antes de implementar o adaptador |
| 3 | Como o app gerencia worktrees | **parcial** | pasta `.claude/worktrees/`; métodos `discardKeptWorktree`, `checkBranchSwitchConflict`, `commitWipForBranchSwitch` | observar 2 sessões no mesmo repo |
| 4 | Estratégia de compactação de contexto | aberto | roda no CLI, não no app | teste comportamental com sessão longa |
| 5 | Persistência de histórico | **parcial** | transcript paginado (`getTranscriptPage`, `getTranscriptRetentionDays`), busca em worker (`transcript-search-worker`), importação de sessões do CLI | inspecionar `%LOCALAPPDATA%\Claude-Data` |
| 6 | Mecanismo de permissão/aprovação na UI | **parcial** | `onToolPermissionRequest`/`respondToToolPermission`; modos Ask, Accept edits, Plan, Auto, Bypass; confiança de pasta (`checkTrust`) | capturar a tela durante uma aprovação |
| 7 | Suporte a imagens/visão no app | aberto | `readSessionImageAsDataUrl`, `getSessionImageStreamUrl` sugerem suporte | teste funcional colando uma imagem |
| 8 | Se o app aceita MCP de terceiros | **resolvido** | sim: em execução, o CLI tem `rea` e `bridge_gpt` (terceiros) como filhos; `setMcpServers`, `mcpAuthenticate` | — |
| 9 | Custo/consumo exibido | **parcial** | `getPeriodUsage`, `PlanUsage`, `getContextUsageSummary` | — |
| 10 | Comportamento do harness do DeepSeek | **resolvido por outra via** | repositório clonado (MIT); estudado pelo código-fonte em vez do asar (ver `REPOSITORIES.md`) | — |
| 11 | APIs internas dos binários nativos | **parcial** | Ghidra 12.1.4 está instalado em `Desktop\REA\ferramentas` e funciona pela CLI do REA com o ambiente de `rea-local.json` (o MCP desta sessão não recebe essas variáveis). Linguagens identificadas por strings: `cowork-svc.exe` Go (VM via HCS), `chrome-native-host.exe` Rust, instalador Go. A 1ª análise Ghidra do `chrome-native-host.exe` estourou o limite de 330 s de inicialização. | repetir com `REA_GHIDRA_STARTUP_TIMEOUT_MS` maior; `Claude.exe` (247 MB) é Electron e tem pouco valor nativo |
| 12 | Se o Claude Desktop usa o mesmo harness do CLI | **resolvido** | sim: um processo `claude.exe` (CLI 2.1.308) por sessão Code, filho de `Claude.exe` (§2.5) | — |
| 13 | Fuses do Electron do Claude Desktop (permitem `--inspect`?) | aberto (novo) | determina se `capture_electron_scenario`/`observe_javascript_runtime` funcionam no app real | REA `inspect_electron_fuses` no `Claude.exe` (existe no REA do repositório clonado, `1de720e`; não está no servidor MCP instalado) |
| 14 | Conteúdo da VM do Cowork (`smol-bin.x64.vhdx`) | aberto (novo) | serviço `CoworkVMService` em localSystem | fora do escopo do Openclod por ora |

## Hipóteses explicitamente NÃO adotadas

- "O Claude Desktop tem computer use embutido": não observado.
- "O app executa comandos shell diretamente": não observado; provavelmente
  delega ao harness/CLI.
- "O layout de três painéis é obrigatório": é escolha de produto, não requisito
  técnico.

## Método para reduzir incerteza (quando autorizado)

1. `rea inspect-analysis-view` sobre as fronteiras e endpoints já coletados.
2. Captura de cenário com `rea capture-electron-scenario` em uma instância
   controlada.
3. Comparação de versões (`rea compare-application-versions`) após update.
4. Testes comportamentais no Openclod, que é o que realmente importa para a
   paridade funcional.
