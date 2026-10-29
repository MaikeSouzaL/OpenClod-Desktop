# Catálogo de ferramentas para portar

Cópias de referência das implementações mais valiosas encontradas nos clones.
Elas **não são compiladas**: servem para ler e portar para `src/core` quando a
fatia correspondente for implementada.

| Ferramenta | Origem | Licença | Destino no harness | Estado |
|---|---|---|---|---|
| `apply-patch` | `OpenInterpreter--open-interpreter` | Apache-2.0 | `src/core/tools/apply-patch/` | queued |
| `apply-patch-spec` | `OpenInterpreter--open-interpreter` | Apache-2.0 | `src/core/tools/apply-patch/` | queued |
| `repo-map` | `Aider-AI--aider` | Apache-2.0 | `src/core/code-intelligence/repomap.ts` | queued |
| `prior-read` | `QwenLM--qwen-code` | Apache-2.0 | `src/core/tools/prior-read.ts` | queued |
| `shell-arity` | `Kilo-Org--kilocode` | MIT | `src/core/permissions/arity.ts` | queued |
| `tool-output-truncate` | `Kilo-Org--kilocode` | MIT | `src/core/tools/truncate.ts` | queued |
| `submit-review` | `SWE-agent--SWE-agent` | MIT | `src/core/tools/submit-review.ts` | queued |
| `mcp-stdio-lifecycle` | `modelcontextprotocol--python-sdk` | MIT | `src/core/mcp/transport/stdio.ts` | queued |
| `mcp-streamable-http` | `modelcontextprotocol--typescript-sdk` | Apache-2.0 | `src/core/mcp/transport/http.ts` | queued |
| `mcp-path-guard` | `modelcontextprotocol--servers` | MIT | `src/core/security/path-guard.ts` | queued |
| `mcp-fetch-guard` | `modelcontextprotocol--servers` | MIT | `src/core/browser/fetch-guard.ts` | queued |
| `provider-retry` | `vercel--ai` | Apache-2.0 | `src/core/providers/http.ts` | queued |
| `tool-call-parser` | `ggml-org--llama.cpp` | MIT | `src/core/providers/tool-parse.ts` | queued |
| `eval-trajectory` | `promptfoo--promptfoo` | MIT | `src/core/eval/assertions/trajectory.ts` | queued |
| `observability-taxonomy` | `langfuse--langfuse` | MIT | `src/core/observability/types.ts` | queued |
| `browser-snapshot` | `browserbase--stagehand` | MIT | `src/core/browser/snapshot/capture.ts` | queued |
| `browser-element-identity` | `browser-use--browser-use` | MIT | `src/core/browser/element-identity.ts` | queued |
| `pty-flow-control` | `crynta--terax-ai` | Apache-2.0 | `src/main/terminal/flow.ts` | queued |
| `keymap` | `asweigart--pyautogui` | BSD | `src/core/computer/keymap.ts` | queued |
| `computer-settle` | `munim-computer-use` | Apache-2.0 | `src/core/computer/settle.ts` | ported |
| `operation-state-machine` | `block--goose` | Apache-2.0 | `src/core/agent/state-machine.ts` | queued |
| `exec-policy` | `openai--codex` | Apache-2.0 | `src/core/security/exec-policy.ts` | queued |
| `durable-operation` | `pydantic--pydantic-ai` | MIT | `src/core/session/run-journal.ts` | queued |
| `memory-extraction` | `mem0ai--mem0` | Apache-2.0 | `src/core/memory/extract.ts` | queued |
| `memory-waterfall` | `run-llama--llama_index` | MIT | `src/core/agent/compaction.ts` | queued |

O estado `ported` significa que já existe uma adaptação nossa; `queued` é a
fila de portas seletivas. O código original completo continua no repositório de
origem até a porta ser feita; a cópia aqui preserva o arquivo decisivo.
