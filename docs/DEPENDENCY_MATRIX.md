# Matriz de dependÃªncias e compatibilidade

Documento de referÃªncia para build, auditoria e suporte. Reflete o estado do
repositÃ³rio em **2026-10-23**, com versÃµes resolvidas em `package-lock.json`.

## 1. DependÃªncias de runtime

| DependÃªncia | Faixa em `package.json` | VersÃ£o instalada | LicenÃ§a | PropÃ³sito | Suporte a Windows | ObservaÃ§Ãµes |
|---|---|---|---|---|---|---|
| `diff` | `^5.2.0` | 5.2.2 | BSD-3-Clause | Diff textual de arquivos para a UI e o rastreador de mudanÃ§as | Sim (JavaScript puro) | API sÃ­ncrona; sem binÃ¡rios nativos. |
| `dompurify` | `^3.2.4` | 3.4.17 | MPL-2.0 OR Apache-2.0 | Sanitizar o HTML gerado pelo markdown | Sim (executa no renderer) | Esta distribuiÃ§Ã£o usa a opÃ§Ã£o Apache-2.0. |
| `marked` | `^15.0.7` | 15.0.12 | MIT | Markdown â†’ HTML | Sim (JavaScript puro) | SaÃ­da sempre passa pelo DOMPurify. |
| `playwright` | `^1.64.1` | 1.64.1 | Apache-2.0 | AutomaÃ§Ã£o de navegador (Chrome/Edge/Chromium) | Sim (win32 x64) | Inclui `playwright-core` (Apache-2.0). O Openclod nÃ£o baixa navegador em runtime: usa Chrome/Edge instalados ou um Chromium instalado manualmente com `npx playwright install chromium`. |
| `zod` | `^3.24.1` | 3.25.76 | MIT | ValidaÃ§Ã£o de entrada das ferramentas | Sim (JavaScript puro) | Schemas Zod tambÃ©m geram JSON Schema. |
| `zod-to-json-schema` | `^3.24.1` | 3.25.2 | ISC | Converter Zod â†’ JSON Schema para o modelo | Sim (JavaScript puro) | Usa `$refStrategy: 'none'` e `jsonSchema7`. |
| `react` | `^19.0.0` | 19.3.1 | MIT | Biblioteca da interface | Sim (renderer) | Declarado em `devDependencies`, mas empacotado no bundle final. |
| `react-dom` | `^19.0.0` | 19.3.1 | MIT | RenderizaÃ§Ã£o DOM da interface | Sim (renderer) | Idem. |

DependÃªncia transitiva de runtime: `playwright-core` 1.64.1 (Apache-2.0).

## 2. DependÃªncias de desenvolvimento (nÃ£o distribuÃ­das)

| DependÃªncia | Faixa | VersÃ£o instalada | LicenÃ§a | Papel |
|---|---|---|---|---|
| `electron` | `^45.0.0` | 45.0.0 | MIT | Runtime desktop |
| `electron-builder` | `^26.0.0` | 26.15.3 | MIT | Empacotamento NSIS |
| `electron-vite` | `^3.0.0` | 3.1.0 | MIT | Build main/preload/renderer |
| `vite` | `^6.1.0` | 6.4.5 | MIT | Bundler do renderer |
| `@vitejs/plugin-react` | `^4.3.4` | 4.x | MIT | Plugin React |
| `typescript` | `^5.7.3` | 5.9.3 | Apache-2.0 | Typecheck e compilaÃ§Ã£o |
| `vitest` | `^3.0.5` | 3.2.7 | MIT | Testes do nÃºcleo |
| `@types/node` | `^22.13.1` | 22.x | MIT | Tipos do Node |
| `@types/react` | `^19.0.8` | 19.x | MIT | Tipos do React |
| `@types/react-dom` | `^19.0.3` | 19.x | MIT | Tipos do React DOM |
| `@types/diff` | `^5.2.3` | 5.x | MIT | Tipos do diff |

## 3. Componentes externos opcionais

| Componente | LicenÃ§a | DistribuÃ­do com o app? | ObservaÃ§Ã£o |
|---|---|---|---|
| `@opensymph/open-computer-use` | MIT | **NÃ£o** | Instalado globalmente pelo usuÃ¡rio; detectado em runtime. Sem ele, Computer Use por UI Automation fica indisponÃ­vel, mas a captura de tela nativa continua. |
| Google Chrome | LicenÃ§a proprietÃ¡ria Google | NÃ£o | Usado como canal do Playwright quando instalado. |
| Microsoft Edge | LicenÃ§a proprietÃ¡ria Microsoft | NÃ£o | Segundo canal do Playwright. |
| Chromium via Playwright | BSD-3-Clause + terceiros | NÃ£o (baixado pelo usuÃ¡rio) | `npx playwright install chromium`. |
| Git | GPL-2.0 | NÃ£o | NecessÃ¡rio apenas para as ferramentas de git. |

## 4. Compatibilidade de plataforma

| Plataforma / versÃ£o | SituaÃ§Ã£o | Notas |
|---|---|---|
| **Windows 11 x64** | Suportado | Alvo principal do instalador NSIS. |
| **Windows 10 x64** | Suportado | Requer sessÃ£o interativa para Computer Use/captura GDI. |
| Windows 10/11 ARM64 | NÃ£o suportado nesta versÃ£o | O alvo do electron-builder Ã© apenas `x64`. |
| macOS / Linux | Fora do escopo | Computer Use Ã© implementado sÃ³ para Windows; nÃ£o hÃ¡ instalador para outras plataformas. |

### Node.js e ferramentas de build

| VersÃ£o | SituaÃ§Ã£o | Notas |
|---|---|---|
| **Node 22.12+ (22 LTS)** | **Recomendado** | Ambiente usado neste repositÃ³rio: `v22.22.1`, npm `10.9.4`. Ã‰ o mÃ­nimo declarado pelo prÃ³prio pacote `electron@45` (`engines.node >= 22.12.0`). |
| Node 20.x | Limitado | Vite 6/Vitest 3 funcionam, mas `electron@45` declara `node >= 22.12.0`; `npm install` pode emitir `EBADENGINE` e o pÃ³s-instalaÃ§Ã£o do Electron pode falhar. Prefira Node 22. |
| Node 24.x | NÃ£o validado | Pode funcionar, mas nÃ£o foi testado neste repositÃ³rio. |
| npm 10.x | Suportado | Usado no ambiente atual. |
| npm 11.x | NÃ£o validado | â€” |

> O aplicativo **empacotado** nÃ£o usa o Node do sistema: o Electron 45 carrega o
> prÃ³prio runtime. A versÃ£o do Node importa para `npm install`, build e testes.

### Electron e empacotamento

| Item | VersÃ£o / configuraÃ§Ã£o | SituaÃ§Ã£o |
|---|---|---|
| Electron | 45.0.0 (`^45.0.0`) | Fixado no lockfile |
| Chromium | Embutido no Electron 45 | Sem download separado para o app |
| electron-builder | 26.15.3 | Configurado por `electron-builder.yml` |
| Alvo | NSIS, `x64` | `release/Openclod-Setup-<versÃ£o>.exe` |
| InstalaÃ§Ã£o | Por usuÃ¡rio (`perMachine: false`) | `%LOCALAPPDATA%\Programs\Openclod` |
| Assinatura | Nenhuma | SmartScreen pode alertar |
| Auto-update | Nenhum | AtualizaÃ§Ã£o manual |

## 5. Compatibilidade de provedores

| Provedor | Tipo de adaptador | Chave obrigatÃ³ria | Ferramentas | VisÃ£o (preset) | Notas |
|---|---|---|---|---|---|
| Anthropic (Claude) | `anthropic` | Sim (`ANTHROPIC_API_KEY` ou cofre) | Sim | Sim | Usa `/v1/messages` com blocos `tool_use`/`tool_result`. |
| OpenAI | `openai` | Sim (`OPENAI_API_KEY`) | Sim | Sim | `/chat/completions` com streaming. |
| DeepSeek | `openai` | Sim (`DEEPSEEK_API_KEY`) | Sim | NÃ£o | OpenAI-compatÃ­vel. |
| Kimi / Moonshot | `openai` | Sim (`MOONSHOT_API_KEY`) | Sim | NÃ£o | OpenAI-compatÃ­vel. |
| Qwen (DashScope) | `openai` | Sim (`DASHSCOPE_API_KEY`) | Sim | NÃ£o | Endpoint compatible-mode. |
| OpenRouter | `openai` | Sim (`OPENROUTER_API_KEY`) | Sim | Sim | Modelo precisa do prefixo do provedor (ex.: `deepseek/deepseek-chat`). |
| Ollama | `openai` | NÃ£o (localhost) | Depende do modelo | NÃ£o | Servidor em `127.0.0.1:11434`; o modelo precisa suportar tool calling para o loop completo. |
| LM Studio | `openai` | NÃ£o (localhost) | Depende do modelo | NÃ£o | Servidor em `127.0.0.1:1234`; idem. |
| OpenAI-compatÃ­vel (custom) | `openai` | Depende | Depende | ConfigurÃ¡vel | Basta URL base + modelo; a chave pode ser cofre, `env:` ou vazia em localhost. |
| **Scripted (mock)** | `mock` | NÃ£o | Sim (roteiro) | Sim (preset) | **NÃ£o Ã© um modelo real.** DeterminÃ­stico, sem rede, apenas autoteste. |

ObservaÃ§Ãµes:

- O campo **Modelo** Ã© sempre editÃ¡vel e enviado literalmente; nomes de modelo
  envelhecem rÃ¡pido.
- `contextWindow`, `supportsVision` e custos por milhÃ£o de tokens sÃ£o apenas
  padrÃµes do preset e podem ser ajustados.
- Provedores locais sem chave sÃ£o aceitos quando a URL base contÃ©m
  `127.0.0.1`/`localhost`.
- Sem credencial vÃ¡lida, o turno falha com mensagem explÃ­cita; nÃ£o hÃ¡ fallback
  silencioso para o mock.

## 6. Matriz de recursos por ambiente

| Recurso | Sem chave de API | Com provedor remoto | Com provedor local |
|---|---|---|---|
| Conversa com modelo real | NÃ£o | Sim | Sim (modelo local) |
| Ferramentas de arquivo/shell/git | Sim (via mock/roteiro) | Sim | Sim |
| Navegador Playwright | Sim, se houver Chrome/Edge/Chromium | Sim | Sim |
| Computer Use (UI Automation) | Sim, se `open-computer-use` existir | Sim | Sim |
| Captura de tela nativa | Sim (Windows) | Sim | Sim |
| MCP | Sim | Sim | Sim |
| Skills e memÃ³ria | Sim | Sim | Sim |

> As ferramentas funcionam sem chave porque o harness Ã© independente do modelo;
> o que nÃ£o funciona sem chave Ã© **raciocÃ­nio real**. Nesse caso, o Ãºnico provedor
> disponÃ­vel Ã© o Scripted, que apenas reproduz um roteiro fixo.

