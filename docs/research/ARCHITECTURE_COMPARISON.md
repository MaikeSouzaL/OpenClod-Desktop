# Comparação de arquiteturas

Quatro caminhos foram avaliados. A pontuação usa critérios do briefing:
funcionalidade real, confiabilidade, manutenção e menor duplicação.

| Critério (peso) | A. Fork cdesktop | B. Tauri + sidecar Python (OpenHarness) | C. Electron + harness TS próprio | D. Web app local (como cdesktop) |
|---|---|---|---|---|
| Harness próprio (25) | 2 — shell de CLIs | 8 — harness pronto | 10 | 10 |
| Computer Use real (20) | 4 | 6 | 10 (verificado) | 9 |
| Navegação web (10) | 6 | 5 | 10 | 9 |
| Esforço de integração (15) | 3 — 2.776 arquivos Rust | 5 — 2 runtimes | 9 | 10 |
| Instalador Windows (10) | 6 — Tauri não lançado | 4 — Python + Rust | 10 — electron-builder | 2 — precisa de servidor |
| Controle de UX/identidade (10) | 4 | 6 | 10 | 9 |
| Manutenção (10) | 4 | 5 | 9 | 8 |
| **Total ponderado** | **3,8** | **6,2** | **9,7** | **8,6** |

## Por que não o fork do cdesktop

1. **Acoplamento invertido.** O cdesktop orquestra CLIs de terceiros: para usar
   nosso harness seria preciso escrever um novo "executor" que fala o protocolo
   de stream do cdesktop. O harness continuaria sendo um processo externo, não
   parte do produto.
2. **Custo de navegação.** ~40 crates, 2.776 arquivos, `relay-*`, `remote`,
   `git-host`, `embedded-ssh`, `trusted-key-auth` — subsistemas que não usamos.
3. **Beta e sem build desktop.** O próprio README diz que o build Tauri está
   "wired up but not yet shipped"; o produto é web.
4. **Identidade.** O layout é declaradamente modelado no app da Anthropic; o
   briefing exige identidade própria. Reaproveitar a UI inteira contraria isso
   (ainda que a licença permita).

O que **foi** aproveitado: o repertório de recursos (sessões paralelas,
worktrees, revisão de diff, preview, presets de provedor) e a organização em
três painéis.

## Por que não o sidecar Python do OpenHarness

O OpenHarness tem módulos maduros (engine, permissions, hooks, swarm), mas é
Python. Integrá-lo significaria: (a) exigir Python 3.10+ no Windows do usuário,
(b) manter dois gerenciadores de dependência, (c) serializar tool calls entre
processos, (d) empacotar dois runtimes no instalador. O ganho seria reutilizar
~5 mil linhas que precisariam de adaptação de protocolo de qualquer forma.
**Decisão:** portar os conceitos para TypeScript, com testes próprios.

## Arquitetura escolhida (C)

```
┌────────────────────────── Electron 45 (Windows) ──────────────────────────┐
│  Renderer (React 19 + Vite)          Preload (contextBridge, mínimo)      │
│  ├─ sessões, transcript, plano        └─ window.forja (IPC tipado)        │
│  ├─ diff, arquivos, terminal                                              │
│  ├─ aprovações, screenshots                                               │
│  └─ seleção de provedor/modelo                                            │
│                                    ▲ IPC (invoke/on)                      │
│  Main process ─────────────────────┴───────────────────────────────────┐  │
│   Harness (TS puro, testável em Node)                                  │  │
│   ├─ AgentLoop: streaming, tool calls, limites, cancelamento           │  │
│   ├─ ContextBuilder + Compaction                                       │  │
│   ├─ ToolRegistry (30+ ferramentas com schema Zod)                     │  │
│   ├─ Permissions (allow/ask/deny, blocklist, path guard)               │  │
│   ├─ Providers (OpenAI-compat, Anthropic, scripted)                    │  │
│   ├─ Sessions (JSON + event log), Memory, Skills, Hooks                │  │
│   └─ Subagents (sessões filhas com ferramentas restritas)              │  │
│   Serviços: BrowserLayer (Playwright) · ComputerLayer (UIA+GDI)        │  │
└────────────────────────────────────────────────────────────────────────┘
        ▲                      ▲                         ▲
        │ stdio MCP (opcional) │ Playwright (Chrome)     │ open-computer-use.exe
   Servidores MCP         Páginas reais            UI Automation / Win32
```

### Fronteiras

- **Renderer não tem Node.** `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`. Só usa a API exposta no preload.
- **Harness não importa Electron.** Todo o núcleo (`src/core`) roda em Node puro
  e é testado com Vitest, sem abrir janela.
- **Segredos nunca vão para o renderer nem para logs.** As chaves ficam em
  `safeStorage` (DPAPI no Windows) e são resolvidas apenas no momento da
  chamada ao provedor.
- **Ferramentas destrutivas passam pelo mesmo ponto** de decisão
  (`evaluateTool`) — não há caminho alternativo.

### Por que Electron e não Tauri

Tauri produziria um binário menor, mas exigiria reimplementar o harness em Rust
ou manter um sidecar Node — e a UI continuaria em React. Electron permite que
harness, ferramentas e UI falem a mesma linguagem e sejam testados no mesmo
runner, além de gerar instalador NSIS estável hoje.

### Consequências assumidas

- Instalador maior (~150 MB) e consumo de memória maior que um app nativo.
- Sem PTY real (detalhado em `FEATURE_MATRIX.md`).
- Computer Use depende do `open-computer-use` instalado; a captura de tela e o
  bloqueio por política continuam funcionando sem ele.
