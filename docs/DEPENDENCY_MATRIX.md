# Matriz de dependências e compatibilidade

Documento de referência para build, auditoria e suporte. Reflete o estado do
repositório em **2026-10-23**, com versões resolvidas em `package-lock.json`.

## 1. Dependências de runtime

| Dependência | Faixa em `package.json` | Versão instalada | Licença | Propósito | Suporte a Windows | Observações |
|---|---|---|---|---|---|---|
| `diff` | `^5.2.0` | 5.2.2 | BSD-3-Clause | Diff textual de arquivos para a UI e o rastreador de mudanças | Sim (JavaScript puro) | API síncrona; sem binários nativos. |
| `dompurify` | `^3.2.4` | 3.4.17 | MPL-2.0 OR Apache-2.0 | Sanitizar o HTML gerado pelo markdown | Sim (executa no renderer) | Esta distribuição usa a opção Apache-2.0. |
| `marked` | `^15.0.7` | 15.0.12 | MIT | Markdown → HTML | Sim (JavaScript puro) | Saída sempre passa pelo DOMPurify. |
| `playwright` | `^1.64.1` | 1.64.1 | Apache-2.0 | Automação de navegador (Chrome/Edge/Chromium) | Sim (win32 x64) | Inclui `playwright-core` (Apache-2.0). O Forja não baixa navegador em runtime: usa Chrome/Edge instalados ou um Chromium instalado manualmente com `npx playwright install chromium`. |
| `zod` | `^3.24.1` | 3.25.76 | MIT | Validação de entrada das ferramentas | Sim (JavaScript puro) | Schemas Zod também geram JSON Schema. |
| `zod-to-json-schema` | `^3.24.1` | 3.25.2 | ISC | Converter Zod → JSON Schema para o modelo | Sim (JavaScript puro) | Usa `$refStrategy: 'none'` e `jsonSchema7`. |
| `react` | `^19.0.0` | 19.3.1 | MIT | Biblioteca da interface | Sim (renderer) | Declarado em `devDependencies`, mas empacotado no bundle final. |
| `react-dom` | `^19.0.0` | 19.3.1 | MIT | Renderização DOM da interface | Sim (renderer) | Idem. |

Dependência transitiva de runtime: `playwright-core` 1.64.1 (Apache-2.0).

## 2. Dependências de desenvolvimento (não distribuídas)

| Dependência | Faixa | Versão instalada | Licença | Papel |
|---|---|---|---|---|
| `electron` | `^45.0.0` | 45.0.0 | MIT | Runtime desktop |
| `electron-builder` | `^26.0.0` | 26.15.3 | MIT | Empacotamento NSIS |
| `electron-vite` | `^3.0.0` | 3.1.0 | MIT | Build main/preload/renderer |
| `vite` | `^6.1.0` | 6.4.5 | MIT | Bundler do renderer |
| `@vitejs/plugin-react` | `^4.3.4` | 4.x | MIT | Plugin React |
| `typescript` | `^5.7.3` | 5.9.3 | Apache-2.0 | Typecheck e compilação |
| `vitest` | `^3.0.5` | 3.2.7 | MIT | Testes do núcleo |
| `@types/node` | `^22.13.1` | 22.x | MIT | Tipos do Node |
| `@types/react` | `^19.0.8` | 19.x | MIT | Tipos do React |
| `@types/react-dom` | `^19.0.3` | 19.x | MIT | Tipos do React DOM |
| `@types/diff` | `^5.2.3` | 5.x | MIT | Tipos do diff |

## 3. Componentes externos opcionais

| Componente | Licença | Distribuído com o app? | Observação |
|---|---|---|---|
| `@opensymph/open-computer-use` | MIT | **Não** | Instalado globalmente pelo usuário; detectado em runtime. Sem ele, Computer Use por UI Automation fica indisponível, mas a captura de tela nativa continua. |
| Google Chrome | Licença proprietária Google | Não | Usado como canal do Playwright quando instalado. |
| Microsoft Edge | Licença proprietária Microsoft | Não | Segundo canal do Playwright. |
| Chromium via Playwright | BSD-3-Clause + terceiros | Não (baixado pelo usuário) | `npx playwright install chromium`. |
| Git | GPL-2.0 | Não | Necessário apenas para as ferramentas de git. |

## 4. Compatibilidade de plataforma

| Plataforma / versão | Situação | Notas |
|---|---|---|
| **Windows 11 x64** | Suportado | Alvo principal do instalador NSIS. |
| **Windows 10 x64** | Suportado | Requer sessão interativa para Computer Use/captura GDI. |
| Windows 10/11 ARM64 | Não suportado nesta versão | O alvo do electron-builder é apenas `x64`. |
| macOS / Linux | Fora do escopo | Computer Use é implementado só para Windows; não há instalador para outras plataformas. |

### Node.js e ferramentas de build

| Versão | Situação | Notas |
|---|---|---|
| **Node 22.12+ (22 LTS)** | **Recomendado** | Ambiente usado neste repositório: `v22.22.1`, npm `10.9.4`. É o mínimo declarado pelo próprio pacote `electron@45` (`engines.node >= 22.12.0`). |
| Node 20.x | Limitado | Vite 6/Vitest 3 funcionam, mas `electron@45` declara `node >= 22.12.0`; `npm install` pode emitir `EBADENGINE` e o pós-instalação do Electron pode falhar. Prefira Node 22. |
| Node 24.x | Não validado | Pode funcionar, mas não foi testado neste repositório. |
| npm 10.x | Suportado | Usado no ambiente atual. |
| npm 11.x | Não validado | — |

> O aplicativo **empacotado** não usa o Node do sistema: o Electron 45 carrega o
> próprio runtime. A versão do Node importa para `npm install`, build e testes.

### Electron e empacotamento

| Item | Versão / configuração | Situação |
|---|---|---|
| Electron | 45.0.0 (`^45.0.0`) | Fixado no lockfile |
| Chromium | Embutido no Electron 45 | Sem download separado para o app |
| electron-builder | 26.15.3 | Configurado por `electron-builder.yml` |
| Alvo | NSIS, `x64` | `release/Forja-Setup-<versão>.exe` |
| Instalação | Por usuário (`perMachine: false`) | `%LOCALAPPDATA%\Programs\Forja` |
| Assinatura | Nenhuma | SmartScreen pode alertar |
| Auto-update | Nenhum | Atualização manual |

## 5. Compatibilidade de provedores

| Provedor | Tipo de adaptador | Chave obrigatória | Ferramentas | Visão (preset) | Notas |
|---|---|---|---|---|---|
| Anthropic (Claude) | `anthropic` | Sim (`ANTHROPIC_API_KEY` ou cofre) | Sim | Sim | Usa `/v1/messages` com blocos `tool_use`/`tool_result`. |
| OpenAI | `openai` | Sim (`OPENAI_API_KEY`) | Sim | Sim | `/chat/completions` com streaming. |
| DeepSeek | `openai` | Sim (`DEEPSEEK_API_KEY`) | Sim | Não | OpenAI-compatível. |
| Kimi / Moonshot | `openai` | Sim (`MOONSHOT_API_KEY`) | Sim | Não | OpenAI-compatível. |
| Qwen (DashScope) | `openai` | Sim (`DASHSCOPE_API_KEY`) | Sim | Não | Endpoint compatible-mode. |
| OpenRouter | `openai` | Sim (`OPENROUTER_API_KEY`) | Sim | Sim | Modelo precisa do prefixo do provedor (ex.: `deepseek/deepseek-chat`). |
| Ollama | `openai` | Não (localhost) | Depende do modelo | Não | Servidor em `127.0.0.1:11434`; o modelo precisa suportar tool calling para o loop completo. |
| LM Studio | `openai` | Não (localhost) | Depende do modelo | Não | Servidor em `127.0.0.1:1234`; idem. |
| OpenAI-compatível (custom) | `openai` | Depende | Depende | Configurável | Basta URL base + modelo; a chave pode ser cofre, `env:` ou vazia em localhost. |
| **Scripted (mock)** | `mock` | Não | Sim (roteiro) | Sim (preset) | **Não é um modelo real.** Determinístico, sem rede, apenas autoteste. |

Observações:

- O campo **Modelo** é sempre editável e enviado literalmente; nomes de modelo
  envelhecem rápido.
- `contextWindow`, `supportsVision` e custos por milhão de tokens são apenas
  padrões do preset e podem ser ajustados.
- Provedores locais sem chave são aceitos quando a URL base contém
  `127.0.0.1`/`localhost`.
- Sem credencial válida, o turno falha com mensagem explícita; não há fallback
  silencioso para o mock.

## 6. Matriz de recursos por ambiente

| Recurso | Sem chave de API | Com provedor remoto | Com provedor local |
|---|---|---|---|
| Conversa com modelo real | Não | Sim | Sim (modelo local) |
| Ferramentas de arquivo/shell/git | Sim (via mock/roteiro) | Sim | Sim |
| Navegador Playwright | Sim, se houver Chrome/Edge/Chromium | Sim | Sim |
| Computer Use (UI Automation) | Sim, se `open-computer-use` existir | Sim | Sim |
| Captura de tela nativa | Sim (Windows) | Sim | Sim |
| MCP | Sim | Sim | Sim |
| Skills e memória | Sim | Sim | Sim |

> As ferramentas funcionam sem chave porque o harness é independente do modelo;
> o que não funciona sem chave é **raciocínio real**. Nesse caso, o único provedor
> disponível é o Scripted, que apenas reproduz um roteiro fixo.
