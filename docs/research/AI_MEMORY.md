# ai-memory — estudo e integração

Data: **2026-10-23**. Repositório: `https://github.com/akitaonrails/ai-memory`
(clone em `repositorios/ai-memory`, commit `1bd8663`, versão 3.2.2). Licença:
**MIT**. Linguagem: **Rust** (edition 2024, toolchain 1.95), binário único.

## 1. O que o projeto faz (fatos do código e da documentação)

- **Wiki markdown em git é a fonte da verdade**: `<data_dir>/wiki/*.md`,
  editável à mão; o SQLite é um índice derivado que pode ser reconstruído.
- **SQLite com FTS5** (`<data_dir>/db/memory.sqlite`, WAL): sessões,
  observações, handoffs, páginas, entidades, links, embeddings e auditoria.
- **Isolamento por projeto por construção**: toda linha é chaveada por
  `(workspace_id, project_id, path)`, resolvido pelo cwd, por um
  `.ai-memory.toml` ou por argumentos explícitos.
- **Captura automática por hooks** de ciclo de vida (Claude Code, Codex,
  OpenCode, Cursor, Gemini, Qwen, Copilot, DSH, etc.), com sanitização e
  limites; o servidor consolida as observações em páginas.
- **Handoffs claim-once**: um handoff tem dono e é reivindicado exatamente uma
  vez (`memory_handoff_begin/list/accept/cancel`).
- **Zero-LLM por padrão**: captura, busca FTS e handoffs funcionam sem chave;
  consolidação, embeddings e "dream" são opt-in.
- **24 ferramentas MCP** (`memory_briefing`, `memory_search`,
  `memory_write_page`, `memory_read_page`, `memory_handoff_*`,
  `memory_consolidate`, `memory_feedback`, ...), com escopos `project`,
  `global` e `profile`.
- **Aging**: decay por tier, compactação extrativa, dedup e flag de contradição
  sem LLM; nada é apagado de verdade (supersede + git + `restore-page`).
- **Multi-usuário e multi-máquina** opcionais: servidor HTTP, auth, auditoria,
  wiki sync.

O README é explícito: a memória é **deste repositório**, não um cofre geral; o
perfil cross-project é um complemento.

## 2. Decisão para o Forja

O Forja é um app Electron/TypeScript com um núcleo puro; adicionar um binário
Rust de 20 MB + servidor HTTP + SQLite + hooks para a memória básica aumentaria
a superfície de instalação e criaria dois runtimes. A decisão foi:

1. **Implementar nativamente o modelo essencial** (wiki markdown por projeto,
   índice derivado, briefing, busca lexical, páginas e handoffs claim-once),
   sem LLM e sem rede. Isso já funciona com qualquer provedor porque é
   ferramenta do harness, não plugin de um modelo.
2. **Deixar o binário oficial como opção** via MCP (`ai-memory mcp-bridge`),
   para quem quiser FTS5, embeddings, decay, consolidação e multi-máquina.
3. **Não copiar código Rust**; a implementação é independente e menor, com os
   mesmos invariantes que importam para o produto.

## 3. O que foi implementado

| Arquivo | Papel |
|---|---|
| `src/core/memory/project.ts` | `ProjectMemory`: wiki markdown, índice lexical, briefing, busca, páginas e handoffs |
| `src/core/memory/tools.ts` | ferramentas `memory_brief`, `memory_page`, `memory_handoff` |
| `src/core/memory/store.ts` | fatos explícitos existentes (mantido, compatível) |
| `src/core/agent/runner.ts` | injeta o briefing no system prompt e atualiza após ferramentas de memória |
| `src/main/orchestrator.ts` | uma `ProjectMemory` por `projectId`, compartilhada por sessões e subagentes |
| `src/main/index.ts` + `src/preload/index.ts` + `src/shared/api.ts` | IPC `memory:status/list/read/delete/open` |
| `src/renderer/src/components/SettingsDialog.tsx` | aba **Memória**: stats, lista, leitura, exclusão e abrir pasta |
| `tests/memory-project.test.ts` | isolamento por projeto, round-trip markdown, busca, segredo redigido, handoff claim-once, rebuild do índice |

Layout em disco (por projeto):

```
%APPDATA%\Forja\data\memory\projects\<projectId>\
  wiki/<slug>.md       fonte da verdade, editável à mão
  index.json           índice derivado (reconstruído quando a wiki muda)
  handoffs.json        handoffs abertos/reivindicados/cancelados
```

O briefing é limitado (~7.000 caracteres), inclui páginas fixadas + recentes +
handoffs abertos e é tratado como **dado não confiável** no prompt, igual a
qualquer conteúdo de ferramenta.

## 4. Equivalências e diferenças

| ai-memory | Forja |
|---|---|
| Wiki markdown em git | Wiki markdown em `%APPDATA%` (sem git por projeto; o projeto pode versionar se quiser) |
| SQLite FTS5 + entidades + links + vetores | Índice lexical em JSON (título/tags/corpo); sem vetores |
| `memory_briefing` | `memory_brief` + injeção automática no system prompt |
| `memory_write_page` / `memory_read_page` / `memory_delete_page` | `memory_page` com `action` write/read/list/delete |
| `memory_search` | `memory_search` (fatos + páginas) |
| `memory_handoff_begin/list/accept/cancel` | `memory_handoff` com as mesmas ações, claim-once |
| Captura automática por hooks | Briefing + páginas explícitas; sem captura de cada tool call |
| Decay, dedup, contradição, consolidação | Fora do escopo desta versão |
| Multi-usuário, servidor, sync | Fora do escopo; memória local por projeto |
| 24 ferramentas MCP | 3 ferramentas nativas + MCP opcional do binário |

## 5. Como usar o binário oficial (opcional)

Instale o release `ai-memory-windows-x86_64.zip` (v3.2.2) e adicione em
**Configurações → MCP** um servidor com:

```json
{
  "name": "ai-memory",
  "command": "C:\\caminho\\ai-memory.exe",
  "args": ["mcp-bridge"],
  "env": {},
  "enabled": true,
  "cwd": "C:\\caminho\\do\\projeto",
  "timeoutMs": 120000
}
```

O `cwd` é o que define o projeto para o servidor; use um servidor por projeto
ou um `.ai-memory.toml` na raiz. As ferramentas aparecem como
`mcp__ai-memory__*` e passam pela mesma política de aprovação do Forja. O
bridge exige o servidor `ai-memory serve` em execução (HTTP local) ou o modo
suportado pela sua instalação; consulte `ai-memory install-mcp` e
`docs/install.md` do projeto.

## 6. Limitações honestas

- A busca do Forja é lexical (título, tags, corpo), não FTS5/BM25 nem vetorial.
- Não há captura automática de cada prompt/tool call; a memória cresce por
  páginas explícitas e pelo briefing.
- Não há decay, dedup, contradição ou consolidação por LLM.
- Não há multi-usuário, servidor remoto ou sync entre máquinas.
- O índice é reconstruído quando a pasta `wiki` muda (arquivo externo é
  detectado no próximo `list/search/brief`), mas não há watcher em tempo real.
