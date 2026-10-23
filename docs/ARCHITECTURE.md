# Arquitetura do Forja

> Documento de decisão. Reflete o código em `src/`. Onde a implementação ainda
> não cobre o desenho, isso é dito explicitamente.

## 1. Princípios

1. **O harness é o produto.** A UI existe para tornar visível e aprovável o que
   o harness faz. Não há caminho em que a UI "finja" uma ação.
2. **Núcleo sem Electron.** `src/core` é TypeScript puro e roda em Node. Isso
   permite testar o loop inteiro em milissegundos, sem janela.
3. **Uma única porta para decisões de risco.** Toda ferramenta passa por
   `evaluateTool` antes de executar. Não existe ferramenta que "escapa" da
   política.
4. **Dados de ferramenta não são instruções.** Conteúdo de arquivo, página e
   tela é tratado como não confiável, marcado como tal e escaneado.
5. **Degradação explícita.** Sem chave de API, sem `ocu`, sem Chrome: o sistema
   diz o que falta e continua útil no que for possível. Nunca inventa sucesso.

## 2. Mapa de módulos

```
src/
  shared/types.ts            contratos compartilhados (sem Node/Electron)
  core/
    agent/
      context.ts             system prompt, AGENTS.md, skills, memória
      compaction.ts          sumarização estruturada de contexto com fallback
      runner.ts              AgentLoop (o coração)
    providers/
      http.ts                SSE + retry com backoff + classificação de erro
      openai.ts              /chat/completions (OpenAI, DeepSeek, Kimi, Qwen,
                             OpenRouter, Ollama, LM Studio)
      anthropic.ts           /v1/messages (content blocks, tool_use, thinking
                             com assinatura reenviada, cache_control)
      compat.ts              diferenças por modelo (temperature, max tokens…)
      discovery.ts           lista modelos de Ollama/LM Studio/OpenAI/Anthropic
      mock.ts                ScriptedProvider (testes determinísticos)
      presets.ts             catálogo de provedores
    tools/                   fs, search, shell, git, web, browser, computer,
                             plan/skills/memory/task, external-agent
    security/
      policy.ts              WorkspaceGuard, blocklist, injection scan, redact
      permissions.ts         allow/ask/deny + filtro de ferramentas por modo
      rules.ts               regras Tool(padrão), deny > ask > allow
      sensitive.ts           credenciais do usuário: negadas em qualquer modo
    hooks/runner.ts          hooks command/http (formato do Claude Code)
    config/project.ts        .forja/settings*.json, regras "permitir sempre"
    git/                     status/diff por arquivo, worktrees (service.ts)
    scheduler/               tarefas agendadas (nextRun, persistência atômica)
    session/
      store.ts               persistência (JSON atômico + JSONL de eventos)
      tracker.ts             arquivos lidos/alterados + diffs
    skills/library.ts        SKILL.md sob demanda
    memory/store.ts          fatos explícitos por projeto
    memory/project.ts        wiki markdown + índice + briefing + handoffs por projeto
    memory/tools.ts          memory_brief, memory_page, memory_handoff
    mcp/client.ts            cliente MCP stdio (filtros, aprovações, timeouts)
    mcp/presets.ts           preset do REA
    browser/layer.ts         Playwright (Chrome/Edge instalado)
    computer/layer.ts        UI Automation (ocu) + captura GDI nativa
  shared/reasoning.ts        esforço de raciocínio por família de modelo
  main/                      Electron: janela, IPC, segredos, orquestração,
                             terminal PTY (terminal.ts), preview de dev server
                             (preview.ts), arquivos do projeto, agendador,
                             voz (stt.ts: supervisor do Python/Whisper) e
                             ditado global (dictation.ts: atalho + pílula)
  preload/                   ponte mínima (contextBridge)
  renderer/                  React 19 + Vite
tests/                       Vitest (núcleo) + scripts de aceitação
```

## 3. Agent loop

```
usuário → mensagem
   │
   ├─ checa limites (iterações, ferramentas, tempo, tokens, custo)
   ├─ compacta contexto se > 75% da janela
   ├─ provider.stream()
   │    ├─ text_delta / reasoning_delta → UI em tempo real
   │    └─ end{stopReason, toolCalls}
   ├─ sem tool calls → fim do turno
   └─ para cada tool call:
        schema (Zod) → política → (aprovação?) → executar → resultado
        └─ resultado volta como mensagem role=tool
   └─ repete
```

### Garantias

- **Sem loop infinito:** `maxIterations`, `maxToolCalls`, `maxWallClockMs`,
  `maxTokens`, `maxCostUsd`. Ao estourar, o turno termina com erro explícito.
- **Cancelamento:** `AbortController` por turno; mata processos filhos
  (`taskkill /T /F`) e fecha o browser da sessão.
- **Chamada repetida:** o mesmo `tool+args` 3 vezes seguidas gera um resultado
  de erro instruindo o modelo a mudar de abordagem.
- **Paralelismo seguro:** só ferramentas `parallelSafe` rodam juntas; escritas e
  comandos são sequenciais. O executor de arquivos mantém trava por caminho.
- **Erro de provedor:** `postStream` tenta de novo (429/5xx) **antes** do
  primeiro byte; depois disso, o erro é reportado, nunca re-transmitido
  (evita duplicar texto).

### Estados emitidos

`idle → thinking → streaming → tool → waiting_approval → (done | error |
cancelled)`. A UI nunca deriva estado por conta própria: ela consome eventos.

## 4. Ferramentas

Contrato:

```ts
interface ToolDef {
  name: string
  description: string
  schema: z.ZodTypeAny         // valida entrada e gera JSON Schema
  risk: 'read'|'write'|'exec'|'network'|'destructive'
  parallelSafe: boolean
  requires?: 'network'|'computer'|'coding'
  describe(args): { title, detail, preview }
  execute(args, ctx): Promise<ToolResult>
}
```

`describe()` existe para que a aprovação mostre **exatamente** o que será feito
(comando, caminho, URL) — e é esse `preview` que a política avalia.

Catálogo atual: leitura/escrita/edição cirúrgica (`edit_file`, `patch_file`),
listagem/remoção, grep/glob, execução de comando, processos em background,
portas, git (status/diff/log/commit/checkout), web (fetch/search/research/
download), browser (10 ferramentas), computer (14), plano, skills, memória
(fatos + wiki + handoffs), `task` (subagente), `agent`/`list_agents` e
`create_agent` (Agent Smith).

## 5. Permissões

| Modo | leitura | escrita | exec | rede interativa | destrutivo |
|---|---|---|---|---|---|
| `readonly` | allow | deny | deny | deny | deny |
| `ask` (padrão) | allow | ask | ask | ask | ask |
| `accept-edits` | allow | allow¹ | ask | ask | ask |
| `auto` | allow | allow | allow | allow | ask |

¹ exceto remoção. Além disso: blocklist fixa (format, diskpart, `curl|bash`,
`-EncodedCommand`, desativação de antivírus/firewall, coleta de credenciais) e
blocklist configurável pelo usuário. `WorkspaceGuard` resolve symlinks e recusa
qualquer caminho fora das raízes autorizadas.

Aprovação é um request assíncrono ao renderer, com timeout e persistência por
sessão ("permitir sempre"). Conteúdo de página **não** pode alterar a política:
não existe ferramenta que escreva em `PolicyConfig`.

## 6. Contexto e memória

- **Contexto de trabalho:** histórico da sessão, truncado por ferramenta
  (saída de shell limitada, diff limitado, árvore de acessibilidade limitada).
- **Contexto de projeto:** `CLAUDE.md` é o arquivo canônico (lido primeiro);
  `AGENTS.md`, `FORJA.md` e `.forja/AGENTS.md` continuam suportados e conteúdo
  idêntico não é duplicado. `ensureProjectInstructions` cria um `CLAUDE.md`
  modelo quando ele não existe, sem sobrescrever o arquivo do usuário. Também
  entram skills instaladas, branch git, fatos e a wiki de memória do projeto.
- **Compactação:** quando a estimativa ultrapassa 75% da janela, as mensagens
  antigas são resumidas por uma chamada sem ferramentas; se falhar, há fallback
  determinístico que preserva a última troca e os arquivos alterados. O corte
  nunca separa um `tool_call` do seu `tool_result`.
- **Memória:** só fatos escritos por `memory_write`. Conteúdo de arquivo/página
  não é persistido automaticamente.

## 7. Persistência

```
%APPDATA%/Forja/
  settings.json           provedores, política, limites (sem chaves)
  secrets.bin             chaves cifradas com safeStorage (DPAPI)
  projects.json
  sessions/<id>.json      meta + mensagens + plano + changes + usage
  sessions/<id>.events.jsonl   trilha de auditoria (append-only)
  memory/<projectId>.json
  skills/<nome>/SKILL.md
```

Gravação atômica (tmp + rename). A sessão é retomável: o runner reconstrói o
histórico e continua de onde parou, sinalizando que houve interrupção.

## 8. Subagentes

`task` cria uma sessão filha com:

- histórico próprio (o prompt deve ser autocontido);
- subconjunto de ferramentas (padrão: leitura, busca, shell de teste, browser);
- limites menores (iterações e tempo);
- profundidade máxima 2 (um subagente não cria netos).

Eventos `subagent` aparecem na UI. Escritas concorrentes no mesmo arquivo são
serializadas por trava por caminho no processo principal.

### 8.1 Modo equipe e criação dinâmica de agentes

- Com `effort === 'max'` **ou** `settings.autoAgents === true`, o system prompt
  recebe a seção "Modo equipe": dividir em subtarefas independentes, chamar
  vários agentes no mesmo turno e consolidar/verificar o resultado.
- `agent-smith` é um agente visível que estuda o caso e, quando nenhum agente
  existente cobre o assunto, chama `create_agent`. A ferramenta grava um
  arquivo markdown em `<userData>/agents/<nome>.md` (ou `.forja/agents` com
  `scope: project`), valida a definição e a registra **no registry da sessão**
  imediatamente; o agente criado pode ser chamado no passo seguinte.
- O registro é o mesmo objeto compartilhado pelo runner e pelo runtime de
  subagentes; criar um agente não derruba a sessão. Outras sessões o veem ao
  reconstruir o registry (próximo turno/runner).
- O catálogo é limitado por `canCall`, profundidade (`maxAgentDepth`), caps de
  concorrência e repetição (`agents/limits.ts`).

## 9. Computer Use

Ordem de percepção, obrigatória:

1. `computer_list_windows` → janela e id;
2. `computer_snapshot(app)` → árvore UI Automation com `element_index`;
3. ação por `element_index` (`computer_click`, `computer_set_value`,
   `computer_type_text`);
4. verificação por nova árvore **e/ou** `computer_screenshot`;
5. coordenadas (`x`,`y`) apenas quando 1–3 falham.

Captura: GDI nativo (`CopyFromScreen`) no virtual desktop, reduzido para 1600 px
de largura antes de ir ao modelo. O screenshot do `open-computer-use` falhou
nesta máquina (`GetDIBits failed`), por isso a captura é própria.

Ações de mouse/teclado exigem `allowComputerControl=true` **e** aprovação no
modo `ask`. O backend recebe `OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOREGROUND_INPUT=1`
somente nesse caminho.

## 10. Navegação web

Playwright com `channel: 'chrome'` → `'msedge'` → chromium empacotado. Sem
download automático de navegador. Percepção por árvore de acessibilidade
(`ariaSnapshot`), não por coordenadas. Console e erros de rede são coletados e
expostos por `browser_console`. Não há `browser_eval`: executar JS arbitrário na
página seria um bypass da política.

## 11. Provedores

Interface única `Provider.stream()`. Dois adaptadores reais:

- **OpenAI-compatível:** OpenAI, DeepSeek, Kimi/Moonshot, Qwen/DashScope,
  OpenRouter, Ollama, LM Studio e qualquer endpoint compatível.
- **Anthropic:** blocos `text`/`image`/`tool_use`/`tool_result`, streaming
  `content_block_delta`, `input_json_delta`.

O terceiro é `ScriptedProvider`, usado **somente** em testes e rotulado como
"autoteste" na UI. Ele existe para provar o loop sem chave de API — não para
simular um modelo real.

## 12. Segurança

- `readonly` por decisão do usuário, nunca por padrão implícito.
- Segredos: `safeStorage` (DPAPI), nunca no renderer, nunca em log; `redactSecrets`
  cobre `sk-*`, `sk-ant-*`, `ghp_*`, `AKIA*`, `Bearer`.
- Filhos herdam ambiente **sem** variáveis de segredo (`sanitizedEnv`).
- Prompt injection: 9 padrões detectados; achados viram evento de auditoria e o
  conteúdo é marcado como não confiável no contexto.
- Auditoria: todo comando bloqueado, aprovação, ferramenta e mudança de plano
  gera evento em JSONL.
- Operações irreversíveis sempre pedem confirmação, inclusive em `auto`.

## 13. Não-objetivos desta versão

- Edição colaborativa e relay remoto. Worktrees têm código e testes, mas não
  estão ligadas à criação de sessões. O terminal integrado é o shell do usuário
  e não passa pelas aprovações do agente.
- Paridade visual com o Claude Desktop: a identidade é própria, por exigência
  legal e de produto.
- Execução de código não confiável em sandbox de SO (VM/container). O isolamento
  atual é de política + diretório, documentado como limitação.

## 14. Voz e memória

### 14.1 Ditado (Whisper local + fluxo Wispr Flow)

```
atalho global (main) ─┐
botão de microfone ───┤→ dictation-toggle → DictationHost (renderer)
                      │      ├─ getUserMedia + AudioWorklet 16 kHz
                      │      ├─ window.forja.stt.audio() → SttService (main)
                      │      │      └─ Python embutido + faster-whisper + Silero VAD
                      │      └─ partial/final → dictation-store (UI) + pílula
                      └─ stop → dictation:insert
                             ├─ Forja em foco: dictation:composer → inserção no caret
                             └─ outro app: clipboard + Ctrl+V (Sendable via PowerShell)
```

- `src/main/stt.ts` é o supervisor: resolve `resources/runtime/python`,
  `resources/stt/forja_stt.py` e `resources/models/whisper`, fala JSON-line com
  o sidecar e repassa eventos. O sidecar carrega o modelo uma vez e mantém
  decoder/áudio em threads separadas.
- A pílula é uma `BrowserWindow` transparente, always-on-top, `focusable:false`,
  que não rouba o foco de quem está digitando.
- O mesmo motor atende atalho e botão de microfone (`dictation-store.ts`), para
  não existirem dois comportamentos.
- Áudio e transcrição ficam na máquina. O "polish" é opt-in e usa o provedor
  padrão; sem ele, nenhum texto sai do processo por causa do ditado.

### 14.2 Memória por projeto

- `ProjectMemory` (uma instância por `projectId`): `wiki/<slug>.md` é a fonte da
  verdade; `index.json` é derivado e reconstruído quando a pasta muda;
  `handoffs.json` guarda handoffs claim-once.
- O briefing (páginas fixadas + recentes + handoffs abertos, limitado a ~7k
  caracteres) entra no system prompt e pode ser pedido com `memory_brief`.
- Ferramentas: `memory_brief`, `memory_page` (write/read/list/delete) e
  `memory_handoff` (begin/list/accept/cancel). `memory_search` consulta fatos e
  páginas.
- Isolamento: o diretório inclui o `projectId`; nenhuma leitura cruza projetos.
  Conteúdo de página é dado não confiável, igual a qualquer resultado de
  ferramenta.
- O binário oficial `ai-memory` (Rust, MIT) pode ser ligado como MCP
  (`ai-memory mcp-bridge`) para FTS5/vetores/decay; o Forja não depende dele.

## 15. Build & packaging

- `electron-vite build` gera `out/main` (Node/Electron), `out/preload` e
  `out/renderer` (React). O main externiza as dependências de produção, que vão
  em `node_modules` dentro do `asar`.
- `electron-builder.yml` define o pacote: `appId com.forja.desktop`, produto
  `Forja`, alvo NSIS x64, saída em `release/` e artefato
  `Forja-<versão>-setup.exe`. O electron-builder lê o bloco `build` do
  `package.json`; o `electron-builder.yml` repete os mesmos campos para
  referência (mantenha os dois em sincronia).
- Ícones (`build/icon.ico`, `build/icon.png`) são opcionais: sem eles o build usa
  o ícone padrão do Electron e não falha (ver `build/README.md`).
- Não há assinatura de código nem auto-update configurados; o instalador é por
  usuário (`perMachine: false`) e preserva `%APPDATA%\Forja` ao desinstalar.
- Dados em runtime: `%APPDATA%\Forja\config` (settings/secrets) e
  `%APPDATA%\Forja\data` (projetos, sessões, memória), além de `skills` e `logs`.
  Observação: a árvore mostrada na seção 7 está desatualizada quanto a esse
  layout; a referência correta é o README (§12).
- Passo a passo reproduzível em `docs/INSTALL.md`; licenças em
  `THIRD_PARTY_NOTICES.md`.
