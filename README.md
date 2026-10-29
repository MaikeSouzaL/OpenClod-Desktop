# Openclod Desktop

Openclod Desktop é um ambiente desktop para desenvolvimento assistido por modelos de linguagem,
com **harness próprio**: loop de agente, ferramentas com classificação de risco,
aprovação humana, Computer Use no Windows e navegação web via Playwright.

- Versão atual: **0.1.0**
- Plataforma alvo: **Windows 10/11 x64**
- Interface em português (pt-BR), tema escuro/claro
- Código-fonte próprio, licença MIT (o Openclod não é afiliado à Anthropic)

> **Aviso importante sobre o provedor "Scripted" (mock).**
> O preset **Scripted (autoteste)** **não é um modelo real**. Ele é um provedor
> determinístico, sem rede, usado para testar o loop, o streaming e as ferramentas.
> Ele não raciocina, não entende o seu projeto e não deve ser usado para trabalho real.
> Sem chaves de API configuradas, os testes ponta a ponta de modelo usam esse mock
> local — nenhuma chamada real a modelo acontece. Para uso real, configure OpenAI,
> Anthropic, DeepSeek, Kimi/Moonshot, Qwen, OpenRouter, Ollama, LM Studio ou outro
> endpoint compatível com a API da OpenAI.

---

## Sumário

1. [O que é o Openclod](#1-o-que-é-o-openclod)
2. [Recursos que existem hoje](#2-recursos-que-existem-hoje)
3. [O que não existe nesta versão](#3-o-que-não-existe-nesta-versão)
4. [Requisitos](#4-requisitos)
5. [Instalação e execução](#5-instalação-e-execução)
6. [Configurar provedores](#6-configurar-provedores)
7. [Modelo de segurança](#7-modelo-de-segurança)
8. [Computer Use](#8-computer-use)
9. [Navegação web](#9-navegação-web)
10. [MCP](#10-mcp)
11. [Skills](#11-skills)
12. [Onde ficam os dados](#12-onde-ficam-os-dados)
13. [Solução de problemas](#13-solução-de-problemas)
14. [Desinstalação](#14-desinstalação)
15. [Build e empacotamento](#15-build-e-empacotamento)
16. [Privacidade](#16-privacidade)
17. [Licença e marcas](#17-licença-e-marcas)

---

## 1. O que é o Openclod

O Openclod é um aplicativo Electron (processo principal + preload + renderer React) em
volta de um núcleo TypeScript puro, sem dependência de Electron:

```
src/shared/    contratos compartilhados (tipos e canais IPC)
src/core/      harness: agente, provedores, ferramentas, políticas, sessões,
               memória, skills, MCP, navegador e Computer Use
src/main/      janela, IPC, cofre de segredos, orquestração
src/preload/   ponte mínima via contextBridge
src/renderer/  interface React 19 + Vite
```

O produto é o **harness**: a interface mostra o que o agente está fazendo, permite
aprovar ou negar ações e exibe diffs, plano, uso e auditoria. Não existe caminho em
que a UI finja uma ação que o núcleo não executou.

## 2. Recursos que existem hoje

> **Estado em 2026-10-23:** os defeitos listados em
> [`docs/research/GAP_ANALYSIS.md`](docs/research/GAP_ANALYSIS.md) §5 foram
> corrigidos e cobertos por testes (**475 testes passando**). **Nenhum recurso
> foi validado ainda com um modelo real**: não havia provedor disponível nesta
> máquina. Veja §12–13 da análise para o que falta, e
> [`REPOSITORY_FEATURE_AUDIT.md`](docs/research/REPOSITORY_FEATURE_AUDIT.md)
> para o que veio (e o que não veio) dos repositórios estudados.

### Agente

- Loop de agente com streaming de texto e de raciocínio (quando o provedor expõe).
- Oito modos de trabalho: `ask`, `plan`, `code`, `debug`, `review`, `computer`,
  `web` e `autonomous`. Cada modo libera um subconjunto de ferramentas.
- Limites por turno: iterações, chamadas de ferramenta, tempo, tokens, custo e
  ferramentas em paralelo. Ao atingir o limite de iterações, o modelo recebe
  uma última chamada sem ferramentas e devolve um resumo do progresso.
- Recuperação: falha transitória do provedor tenta de novo; estouro de janela
  de contexto compacta e repete; resposta cortada pelo limite de saída é
  continuada automaticamente (até 2 vezes).
- Argumentos de ferramenta reparados quando o modelo envia `"10"` em vez de
  `10`, JSON entre crases ou JSON duplamente codificado.
- Cancelamento de turno com encerramento de processos filhos e fechamento do
  navegador da sessão.
- Compactação automática de contexto quando a janela do modelo se aproxima do
  limite, com fallback determinístico se a sumarização falhar.
- Subagentes (`task`): sessão filha com histórico próprio, ferramentas restritas,
  limites menores, o mesmo modelo da sessão e profundidade máxima 1 nível.
- Plano de execução visível, atualizado pela ferramenta `update_plan`.
- Memória por projeto: fatos gravados por `memory_write` entram no prompt de
  sistema de toda sessão do projeto e podem ser buscados com `memory_search`.
- **Wiki de longo prazo por projeto** (`memory_brief`, `memory_page`,
  `memory_handoff`): páginas markdown editáveis à mão, índice lexical,
  briefing no início da sessão e handoffs claim-once entre sessões/agentes.
  Nada é enviado a um serviço de memória; ver Configurações → Memória e
  `docs/research/AI_MEMORY.md`.
- **Ditado local** com Whisper embutido: atalho global, pílula flutuante,
  transcrição ao vivo e inserção no campo em foco (inclusive fora do Openclod).
  O mesmo fluxo abre pelo atalho ou pelo botão de microfone.
- **Hooks** no formato do Claude Code (§7.8), com 10 eventos e tipos `command` e `http`.
- **Esforço de raciocínio** por sessão (Automático, Baixo, Médio, Alto, Extra,
  Máximo): `thinking` adaptativo e `output_config.effort` nos Claude 4.6+/5.x,
  orçamento de tokens nos Claude 4.5 e anteriores, `reasoning_effort` no
  o-series/gpt-5. Os blocos de raciocínio do Claude são guardados com a
  assinatura e reenviados sem alteração; o menu só oferece níveis que o modelo
  aceita.
- Saídas de ferramenta acima de 60 000 caracteres vão para um arquivo; o
  modelo recebe o começo, o fim e o caminho.
- Credenciais do usuário (`~/.ssh`, `.aws`, `.kube`, `.gnupg`…) são bloqueadas
  em qualquer modo, mesmo com "ignorar permissões".
- **Agentes externos:** a ferramenta `external_agent` delega uma tarefa ao
  Claude Code ou ao Codex instalados (nunca com `bypassPermissions`).
- **Modo equipe:** com esforço **Máximo** ou com o toggle em Configurações →
  Permissões, o agente principal divide o trabalho e chama especialistas em
  paralelo. Se não houver especialista para o assunto, ele chama `agent-smith`,
  que estuda o caso, cria um agente permanente com `create_agent` em
  `%APPDATA%\Openclod\agents` e delega a tarefa.
- **CLAUDE.md canônico:** o harness lê `CLAUDE.md` (e `AGENTS.md`/`OPENCLOD.md`
  como fallback) e cria automaticamente um `CLAUDE.md` na raiz de cada projeto
  quando ele não existe, sem sobrescrever o que já está lá.
- **Edição cirúrgica:** `edit_file` (trecho exato) e `patch_file` (diff
  unificado) alteram só as linhas necessárias; o prompt proíbe reescrever o
  arquivo inteiro para corrigir um trecho.

### Ferramentas nativas

- **Arquivos:** ler, escrever, editar, aplicar patch, listar e remover (com
  bloqueios por risco). A edição grava o texto literalmente (inclusive `$$`,
  `$&`), preserva CRLF e tolera aspas tipográficas; `patch_file` aplica só os
  hunks de um diff unificado.
- **Busca:** `grep` e `glob`.
- **Shell:** executar comando (também em segundo plano com `run_in_background`),
  iniciar/parar processo, `read_process_output` (saída nova desde a última
  leitura), `list_processes` e listar portas.
- **Git:** status, diff, log, commit e checkout.
- **Web:** `fetch_url`, `web_search`, `web_research` (pesquisa + lê as fontes e
  devolve trechos com URL) e `download_file`.
- **Navegador (10):** abrir, navegar, snapshot por acessibilidade, clicar, digitar,
  teclar, ler texto, screenshot, console/rede e esperar.
- **Computer Use (14):** listar janelas, snapshot de UI Automation (por app ou
  janela, com imagem da janela), screenshot, clique (elemento, coordenada da
  janela ou da captura; botão direito), preencher valor, digitar (focando o
  elemento), tecla, scroll, arrastar, abrir app, ativar janela, ação secundária
  de acessibilidade, esperar e esperar mudança de estado.
- **Plano/skills/memória/agentes (11):** `update_plan`, `list_skills`,
  `use_skill`, `memory_write`, `memory_search`, `memory_brief`, `memory_page`,
  `memory_handoff`, `task`, `agent`, `list_agents` e `create_agent`.

### Voz (Whisper local, fluxo Wispr Flow)

- **Botão de microfone** do compositor: clicar inicia o ditado, o texto parcial
  aparece no próprio campo e o texto final é inserido ao parar. `Esc` cancela.
- **Atalho global opcional**, desligado por padrão; pode ser configurado em
  Configurações → Voz.
- **Pílula flutuante opcional** (desligada por padrão), com estado, medidor e
  partial text, para quem prefere o estilo Wispr Flow.
- **Inserção**: no compositor do Openclod, no cursor; em outro aplicativo, via
  clipboard + `Ctrl+V` (configurável em Configurações → Voz).
- **Polish opcional**: corrige pontuação/vícios com uma chamada curta ao
  provedor padrão antes de inserir; desligado por padrão, porque envia o texto
  ao provedor.
- **100% local**: Python 3.10 embutido + faster-whisper (CTranslate2) + Silero
  VAD; modelos `tiny`, `base` e `small` em `resources/models/whisper`. Nenhum
  áudio sai da máquina.
- **GPU NVIDIA sempre que disponível**: as DLLs de CUDA 12 / cuBLAS / cuDNN 9
  vão embutidas e o motor tenta CUDA automaticamente, caindo para CPU se não
  houver GPU ou driver compatível. A aceleração é o que mantém o modelo
  `small` em tempo real.

### Interface

- Projetos e sessões, com histórico persistido e retomável.
- Arquivar/desarquivar sessões e **compactar o contexto manualmente**.
- Cards de ferramenta com entrada, saída, arquivos tocados e erros.
- Aprovações em um painel dedicado, com "permitir uma vez" e "permitir sempre
  nesta sessão".
- Notificações nativas do Windows para aprovação necessária e fim de turno com a
  janela em segundo plano (quando o sistema suporta).
- **Terminal integrado** (PTY real, várias abas; PowerShell, cmd ou Git Bash).
- **Navegador integrado** (abas, DevTools) com detecção de servidor de dev
  (`package.json` e `.claude/launch.json`); a escolha fica em `.openclod/launch.json`.
- **Alterações via Git** (preparadas, alteradas, não rastreadas; lista ou
  árvore) e **editor de arquivos** CodeMirror com abas, Ctrl+S e salvamento
  automático opcional.
- Painel lateral redimensionável, maximizável e movível para a esquerda.
- **Tarefas em segundo plano** do agente e **Manter computador ativo**.
- Páginas **Projetos**, **Agendados** (tarefas recorrentes que abrem uma
  sessão Cowork ou Code, à sua escolha, no horário, enquanto o app está aberto)
  e **Personalização** (skills,
  conectores MCP com preset do REA, hooks).
- **Revisão de melhorias** (Atividades): conta limitações recorrentes, falhas por
  ferramenta, aprovações recusadas, uso por provedor e a memória do projeto, e
  salva um relatório com evidências como página de memória e nota em Atividades.
  Botão manual e opção semanal em Agendados; um analista de IA opcional (sem
  ferramentas, somente leitura) comenta as evidências. Nada é aplicado sozinho.
  Detalhes e limites: [`docs/IMPROVEMENT-REVIEW.md`](docs/IMPROVEMENT-REVIEW.md).
- Abertura de arquivo/pasta no Explorer, limitada às raízes autorizadas.
- Captura de tela nativa sob demanda.
- Uso de tokens por sessão e orçamento de custo configurável (o bloqueio por
  custo só é efetivo quando custos por milhão de tokens estão definidos no
  provedor).
- Exportação e importação de sessão em JSON (`openclod.session.v1`).
- Configurações de provedores, permissões, limites, MCP, aparência e diagnóstico de
  capacidades em **Configurações → Sobre**.

### Integrações

- Provedores OpenAI-compatíveis e Anthropic, com presets e campos editáveis.
- **Google Colab (GPU) como servidor de LLM**: Configurações → Provedores → *Abrir o Google Colab* grava um notebook (mostrado
  no cartão como um arquivo que você **arrasta para dentro do Colab**) que lê a GPU do Colab (T4 → A100/H100), **lista todos os
  modelos abertos que cabem nela** (agentes, código, raciocínio, visão e **sem censura**) e **para numa caixa de seleção** com o
  botão *Usar este modelo* (2 minutos; sem escolha, roda sozinho o melhor com visão e ferramentas; também dá para escolher pelo
  número ou pelo tipo nas Opções), só depois baixa o modelo, sobe um servidor protegido por chave com túnel e mostra um **código de
  conexão**; colado no app, vira um provedor comum (seletor de modelo e reserva automática). **O Google pode encerrar esse uso
  sem aviso**: limites, termos, segurança e o que foi (e não foi) provado em [`docs/COLAB.md`](docs/COLAB.md).
- Servidores **MCP por stdio e remotos (HTTP/SSE)**, com ferramentas expostas como
  `mcp__servidor__ferramenta`. **Diretório de 900 conectores** (o do Claude + o catálogo próprio) em
  Personalização → Conectores: login OAuth de 1 clique, chave de API ou app OAuth próprio, permissão por ferramenta e
  segredos no cofre do sistema. Detalhes e o que foi testado em [`docs/CONECTORES.md`](docs/CONECTORES.md).
- Skills em markdown (`SKILL.md`) carregadas sob demanda, com sugestão automática das que casam com o pedido.
- **Memória em grafo e economia de tokens**: prompt do sistema estável (o cache do provedor sobrevive entre turnos), busca
  automática de memória por pedido (páginas ranqueadas + vizinhos por links), cápsula de continuidade para outro modelo
  assumir o trabalho, skills/agentes/ferramentas sugeridos só quando servem e nove ferramentas pouco usadas fora da lista de
  toda chamada (o piso de uma sessão nova caiu de 12% a 15%, medido com modelos DeepSeek reais: 9 401 → 8 274 e 10 553 → 8 974 tokens). Medições reais em
  [`docs/MEMORIA-E-TOKENS.md`](docs/MEMORIA-E-TOKENS.md).
- **Áudio e vídeo anexados são processados sozinhos** (sem interface): transcrição com tempos, frames por mudança de cena
  sem repetições, folhas de contato e texto da tela (OCR) vão para a memória do projeto, e qualquer modelo usa isso como
  contexto, inclusive em outra sessão. Lógica do claude-real-video (MIT) portada para o runtime embutido (PyAV, numpy,
  faster-whisper; sem ffmpeg nem Pillow). Medições e limites em [`docs/MIDIA.md`](docs/MIDIA.md).
- Navegador Playwright usando Chrome/Edge instalados ou Chromium do Playwright.
- **Extensão própria para o Chrome** (v0.2.0): opera o seu Chrome já aberto, mostra "Openclod está controlando esta aba"
  com botão Parar e tem popup de status. Instalação guiada e `.zip` para distribuir em
  [`docs/CHROME-EXTENSION.md`](docs/CHROME-EXTENSION.md) (`npm run pack:chrome-extension`).
- Computer Use via `open-computer-use` (opcional) + captura GDI nativa.

## 3. O que não existe nesta versão

Para evitar expectativas erradas:

- **Não há sandbox de sistema operacional.** O isolamento é de política + diretório
  autorizado. Um comando de shell aprovado roda com as permissões do seu usuário.
- **Sem assinatura de código e sem auto-update.** O instalador gerado é NSIS sem
  assinatura; o Windows SmartScreen pode avisar. Atualizações são manuais.
- **Computer Use só no Windows** e depende de um binário opcional instalado à parte.
- **O navegador depende de Chrome/Edge** ou do Chromium baixado pelo Playwright.
  O Openclod não baixa navegador automaticamente.
- **MCP suporta ferramentas** (`tools/list`, `tools/call`). Prompts e resources de
  servidores MCP estão fora de escopo.
- **Só a pasta de skills do usuário é carregada** (`%APPDATA%\Openclod\skills`). A
  origem "projeto" existe no modelo de dados, mas nenhuma pasta de projeto é
  registrada nesta versão.
- **Sem edição colaborativa e sem relay remoto.** As worktrees têm código e
  testes (`src/core/git/service.ts`), mas ainda não estão ligadas à criação
  de sessões.
- **Sem chat lateral, rewind/checkpoints, comentários de diff nem split view.**
- **O ditado alterna no atalho**, não no modo “segurar para falar”. O modo hold
  exige um hook nativo de teclado (`WH_KEYBOARD_LL`), que pode ser um helper
  Go/Rust futuro.
- **A memória por projeto é local** (wiki markdown em `%APPDATA%`), sem sync
  entre máquinas. Para FTS5/vetores/sync, ligue o binário oficial `ai-memory`
  como MCP.
- **`create_agent` grava em `%APPDATA%\Openclod\agents`** (ou `.openclod/agents` com
  escopo de projeto). O agente criado passa pela mesma política de ferramentas;
  não há sandbox de SO para o que ele executar.
- **O terminal integrado é o seu shell**: não passa pelas aprovações do agente.
- **Sem recursos de nuvem do Claude** (Artefatos, Design, Dispatch, Remote Control).
- **Sem paridade visual com o Claude Desktop.** A identidade visual é própria.
- **Sem telemetria.** Nenhum dado é enviado ao projeto Openclod.

## 4. Requisitos

| Item | Requisito |
|---|---|
| Sistema | Windows 10 ou Windows 11, **x64** |
| Node.js | **22.12 ou superior** (22 LTS recomendado) — ver nota abaixo |
| npm | 10 ou superior (acompanha o Node 22) |
| Espaço em disco | ~3 GB para o aplicativo completo (Electron, Python, modelos Whisper e CUDA) |
| Rede | necessária apenas para provedores remotos, web e instalação de dependências |
| Opcional | Microfone para ditado; GPU NVIDIA com driver compatível com CUDA 12 para transcrição em tempo real (sem ela, CPU) |
| Opcional | Git no `PATH` (ferramentas de git) |
| Opcional | Google Chrome ou Microsoft Edge (navegador) |
| Opcional | `@opensymph/open-computer-use` (Computer Use por UI Automation) |

O aplicativo empacotado **não precisa de Node.js instalado**: o Electron traz o
próprio runtime. O Node do sistema é usado só para build, testes e desenvolvimento.

> **Nota sobre Node 20:** o requisito histórico do projeto era "Node 20+", mas o
> pacote `electron@45` declara `engines.node >= 22.12.0`. Com Node 20 o
> `npm install` pode emitir `EBADENGINE` e o pós-instalação do Electron pode
> falhar. Use Node 22.12+ (22 LTS) para desenvolver e empacotar.

## 5. Instalação e execução

```powershell
# 1. Dependências
npm install

# 2. Desenvolvimento (Electron + Vite com recarga)
npm run dev

# 3. Verificação de tipos + build de produção em out/
npm run build

# 4. Pré-visualizar o build (sem empacotar)
npm start

# 5. Testes do núcleo (Vitest)
npm test

# 6. Instalador NSIS em release/
npm run dist

# 7. Build sem instalador (release/win-unpacked)
npm run dist:dir

# 8. E2E em app real, ex.: Provedores → Google Colab (GPU) (dublê local do Colab + modelo real; docs/COLAB.md)
node scripts/ui-colab.cjs
```

- `npm run build` executa `typecheck` antes do bundle. Se o typecheck falhar, o
  build para.
- O instalador sai em `release/Openclod-0.1.0-setup.exe` com a configuração atual
  (`electron-builder.yml`).
- Passo a passo detalhado, incluindo instalação limpa e desinstalação limpa:
  [`docs/INSTALL.md`](docs/INSTALL.md).

## 6. Configurar provedores

Abra **Configurações → Provedores**. Cada provedor tem URL base, modelo, janela de
contexto, suporte a visão e campo de chave. A chave é gravada no cofre do Windows e
**nunca volta para a interface**; a UI só mostra "credencial ok".

> **Primeira execução:** o provedor padrão é o **Scripted (mock)**. Ele não é um
> modelo real e só serve para autoteste. Antes de trabalhar de verdade, escolha um
> provedor real, grave a chave e clique em **Testar**.

### Presets incluídos

| Provedor | Tipo | URL base padrão | Modelo inicial | Variável de ambiente |
|---|---|---|---|---|
| Anthropic (Claude) | `anthropic` | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `gpt-4o` | `OPENAI_API_KEY` |
| DeepSeek | `openai` | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| Kimi / Moonshot | `openai` | `https://api.moonshot.ai/v1` | `kimi-k2-0905-preview` | `MOONSHOT_API_KEY` |
| Qwen (DashScope) | `openai` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-max` | `DASHSCOPE_API_KEY` |
| OpenRouter | `openai` | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | `OPENROUTER_API_KEY` |
| Ollama (local) | `openai` | `http://127.0.0.1:11434/v1` | `qwen3:8b` | não usa chave |
| LM Studio (local) | `openai` | `http://127.0.0.1:1234/v1` | `local-model` | não usa chave |
| Scripted (autoteste) | `mock` | `mock://local` | `scripted` | não usa chave |

Os identificadores de modelo mudam com frequência. O campo **Modelo** é editável e
é enviado literalmente ao provedor — ajuste-o para o modelo que você tem acesso.
Também é possível adicionar um provedor **custom** (OpenAI-compatível) e editar a
URL base, o modelo e a janela de contexto.

### Como gravar a chave

1. Ajuste URL/modelo e clique em **Salvar alterações**.
2. Volte ao cartão do provedor, cole a chave e clique em **Salvar chave**.
   (A UI exige salvar as configurações antes de gravar a chave.)
3. Clique em **Testar**. O teste faz uma chamada curta e informa sucesso ou o erro
   HTTP retornado.

Alternativas à chave no cofre:

- **Variável de ambiente:** o preset já nasce com `env:NOME_DA_VARIAVEL`. Se a
  variável estiver definida no processo que inicia o Openclod, a credencial é aceita.
- **Provedores locais:** Ollama e LM Studio em `127.0.0.1`/`localhost` são aceitos
  sem chave; o servidor local precisa estar rodando e com um modelo carregado.

> Se a criptografia do sistema não estiver disponível, o Openclod **recusa** gravar a
> chave em texto puro e orienta usar variável de ambiente.

### llama.cpp (local) — o motor embutido

O cartão **llama.cpp (local)**, no topo de Provedores, roda modelos GGUF neste
computador com o servidor do próprio llama.cpp, que vem dentro do app (versão
Vulkan: qualquer GPU e a CPU). Não precisa de Ollama nem de chave. O cartão faz:

- acha os modelos que já estão no computador (Ollama, LM Studio, cache do Hugging
  Face, Downloads e pastas suas);
- lista os GGUF do Hugging Face com a quantização que cabe na sua GPU e baixa
  conferindo o SHA-256;
- mostra todas as opções do `llama-server`, com perfis;
- baixa as versões CUDA oficiais para NVIDIA.

Ligado, ele vira o provedor `llama.cpp (local)` no seletor de modelo. Uma conversa
nele inicia o servidor sozinha. Detalhes: [`docs/LLAMACPP.md`](docs/LLAMACPP.md).

## 7. Modelo de segurança

### 7.1 Modos de permissão

| Modo | Leitura | Escrita | Execução | Rede interativa | Destrutivo |
|---|---|---|---|---|---|
| `readonly` (Somente leitura) | permite | nega | nega | nega | nega |
| `ask` (Perguntar) | permite | pergunta | pergunta | leitura de rede permite; ações perguntam | pergunta |
| `accept-edits` (Aceitar edições) | permite | edições permitem; remoção pergunta | pergunta | pergunta | pergunta |
| `auto` (Automático, padrão) | permite | permite | permite | permite | **sempre pergunta** |

- O modo `auto` é o padrão de fábrica desde a versão de configurações 2: o
  agente trabalha sem pedir aprovação para edições, comandos e navegação.
  Instalações que estavam no antigo padrão `ask` foram migradas uma vez para
  `auto` (registrado em `logs/main.log`); uma escolha explícita de `readonly`
  ou `accept-edits` é mantida.
- Em `ask`, ferramentas de rede sem efeito de clique/execução (`fetch_url`,
  `web_search`, `download_file`) passam sem aprovação; `browser_click`,
  `browser_type`, `browser_press` e comandos pedem.
- Operações destrutivas pedem confirmação **inclusive no modo `auto`**, assim
  como ler ou alterar arquivos de segredo (`.env`, `*.pem`, `*.key`, `id_rsa*`).
- O controle real de mouse e teclado continua desligado até ser habilitado em
  Configurações → Permissões.
- Mudanças de política valem a partir do próximo turno.

### 7.1.1 Regras de permissão

Regras na sintaxe do Claude Code, avaliadas **antes** do modo, com precedência
negar > perguntar > permitir:

```
Bash(npm test:*)          comando que começa com "npm test"
Bash(git * --force)       curinga no meio
Edit(src/**)              caminhos dentro de src/
Read(.env)                arquivo com esse nome em qualquer pasta
WebFetch(domain:python.org)
mcp__github               todas as ferramentas do servidor MCP "github"
```

Os nomes do Claude Code (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`,
`WebFetch`, `WebSearch`, `Task`, `TodoWrite`) e os nomes do Openclod
(`run_command`, `read_file`…) são aceitos. Fontes, todas somadas:

- Configurações → Permissões (usuário);
- `<projeto>/.openclod/settings.json` e `settings.local.json`, no formato
  `{ "permissions": { "allow": [], "ask": [], "deny": [] } }`;
- `<projeto>/.claude/settings.json` e `settings.local.json`, só se "Ler também
  .claude/settings.json" estiver ligado;
- escolhas "permitir sempre", gravadas por projeto em
  `%APPDATA%\Openclod\data\permissions\<projeto>.json`.

O modo somente leitura continua sendo um limite rígido: uma regra `allow` não
libera escrita nele.

### 7.2 Aprovações

- Cada pedido mostra ferramenta, risco, título e um **preview** legível (linha de
  comando, caminho, URL).
- Opções: aprovar uma vez, aprovar sempre (vale na sessão e vira uma regra do
  projeto, exceto para ações destrutivas) ou negar.
- O pedido expira em **5 minutos** e é tratado como negado.
- Cancelar o turno nega todas as aprovações pendentes daquela sessão.
- A aprovação é feita no processo principal; o renderer não executa ferramentas.

### 7.3 Blocklist de comandos

Existe uma blocklist fixa, verificada na execução: **mesmo que o usuário aprove**,
um comando que casa com um destes padrões é recusado e gera evento `blocked`.

Padrões bloqueados:

- remoção recursiva de raiz/home, formatação e particionamento de disco;
- desligamento/reinício, alteração de boot e remoção de chaves de registro;
- criação de usuário, escrita em dispositivo (`dd`, `mkfs`);
- execução de script remoto (`curl | bash`, `iwr | iex`), `-EncodedCommand`;
- desativação de antivírus/firewall;
- coleta de credenciais (`mimikatz`, `secretsdump`, `whoami /priv`).

Além disso, o usuário pode adicionar regras próprias (uma por linha, tratadas como
regex, com fallback para comparação textual). Bloqueios em `run_command` geram
evento de auditoria com nível `blocked`.

### 7.4 Restrição de diretório

- Toda ferramenta de arquivo resolve o caminho por um `WorkspaceGuard`, que
  normaliza, resolve symlinks do ancestral existente e recusa qualquer caminho
  fora das raízes autorizadas.
- As raízes são o diretório da sessão/projeto mais as **raízes extras** definidas
  em Configurações → Permissões.
- Leituras de arquivo pedidas pelo renderer são limitadas aos projetos registrados.
- O guard não transforma o shell em sandbox: um comando aprovado roda com as
  permissões do seu usuário no Windows. Trate aprovações de comando como confiança
  total naquele comando.

### 7.5 Segredos (DPAPI)

- Chaves são cifradas com `safeStorage` do Electron, que no Windows usa **DPAPI** e
  ficam em `%APPDATA%\Openclod\config\secrets.bin`.
- O renderer nunca recebe a chave de volta; só um booleano "configurado".
- `settings.json` guarda apenas referências (`env:NOME` ou `secret:id`), nunca a chave.
- Processos filhos recebem ambiente sanitizado: variáveis que casam com
  `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` etc. são removidas.
- Existe um utilitário de redação (`redactSecrets`) para padrões `sk-*`,
  `sk-ant-*`, `ghp_*`, `AKIA*` e `Bearer`, mas nesta versão ele **não é aplicado
  automaticamente a todo log**. Evite colar chaves em mensagens ou comandos.

### 7.6 Auditoria

Cada sessão tem uma trilha append-only em
`%APPDATA%\Openclod\data\sessions\<id>.events.jsonl` com eventos de:

- início/fim de turno, mensagens, plano e diffs;
- início/fim de ferramenta, arquivos tocados e resumo;
- pedidos e resoluções de aprovação;
- bloqueios de comando e avisos de injeção de prompt (nível `warn`/`blocked`).

### 7.7 Outras proteções

- **Injeção de prompt:** conteúdo de arquivo, página e tela entra no contexto como
  resultado de ferramenta (role `tool`), nunca como instrução; o system prompt
  reforça que é dado não confiável. 9 padrões heurísticos geram aviso de auditoria
  (`warn`).
- **Isolamento do renderer:** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, navegação externa bloqueada e abertura apenas de
  `https://` no navegador do sistema.
- **IPC:** apenas a janela principal é aceita como origem; patches de configuração
  passam por saneamento de chaves e limites.
- **Limites de execução:** 60 iterações, 400 chamadas, 45 min, 3 milhões de tokens,
  US$ 10 e 4 ferramentas em paralelo por padrão (todos configuráveis na UI, com
  faixas máximas).
- **Chamada repetida:** o mesmo `ferramenta + argumentos` três vezes seguidas vira
  erro instruindo o modelo a mudar de abordagem.

### 7.8 Hooks

Mesmo formato do Claude Code. Configure em Configurações → Permissões → Hooks
(usuário) ou em `<projeto>/.openclod/settings.json` (projeto):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node scripts/check-cmd.js", "timeout": 30 }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write ." }] }
    ]
  }
}
```

- Eventos: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`,
  `SubagentStop`, `SessionStart`, `PreCompact`, `Notification`.
- `matcher` é uma expressão regular sobre o nome da ferramenta (nome do Claude
  Code ou do Openclod); vazio vale para todas.
- O comando recebe o evento em JSON pela entrada padrão (`session_id`, `cwd`,
  `hook_event_name`, `tool_name`, `tool_input` com `file_path`, `tool_response`,
  `prompt`…) e as variáveis `OPENCLOD_PROJECT_DIR` e `CLAUDE_PROJECT_DIR`.
- Código de saída **2** bloqueia: em `PreToolUse` a ferramenta não roda e o
  stderr vai para o modelo; em `UserPromptSubmit` a mensagem é recusada; em
  `Stop` o agente volta a trabalhar com o stderr como instrução (até 3 vezes).
  Outro código diferente de 0 é um aviso.
- JSON na saída padrão: `hookSpecificOutput.permissionDecision`
  (`allow`/`ask`/`deny`), `updatedInput` (reescreve os argumentos),
  `additionalContext`, `continue: false`. Um `allow` de hook pula a confirmação,
  mas nunca anula uma negação da política.
- Hooks rodam com as permissões do seu usuário. Hooks de `.claude/` só são lidos
  com a opção correspondente ligada.

## 8. Computer Use

Requisitos:

1. **Windows 10/11 x64** com sessão interativa desbloqueada. A captura usa GDI
   (`CopyFromScreen`); em sessão bloqueada ou desktop desconectado a imagem pode
   sair preta.
2. **Backend opcional** `open-computer-use` para UI Automation, listagem de janelas
   e ações por elemento:

   ```powershell
   npm i -g @opensymph/open-computer-use
   ```

   O Openclod procura o executável em:
   - `OPENCLOD_OCU_BIN` (caminho explícito), depois `OCU_BIN`;
   - `%APPDATA%\npm\node_modules\@opensymph\open-computer-use\dist\windows\amd64\open-computer-use.exe`.

3. **Controle de mouse/teclado habilitado** em Configurações → Permissões
   (`Permitir controle real de mouse e teclado`). Sem isso, o agente pode listar
   janelas, ler a árvore de acessibilidade e capturar tela, mas não clicar/digitar.

**Onde ele está liberado:** o **Chat (Início)** abre as conversas novas em Computer Use, com arquivos, terminal e
controle do Windows: um pedido como "crie uma pasta na minha área de trabalho" é feito, e não só explicado. A
política de permissões continua valendo (o que pede aprovação ainda pede). O modo somente leitura (`Conversar`, no
menu do compositor) segue disponível; conversas antigas do Chat ficam no modo em que foram criadas.

**Como ele aponta com o mouse:**
- `computer_screenshot` captura **um monitor por vez** (o principal por padrão; `monitor=2` para o outro; `monitor=0`
  junta todos, com menos detalhe). O resultado lista os monitores e diz para capturar o outro quando o que se procura
  não está na imagem, ou usar a tela que o usuário indicar. Antes, dois monitores de 1920 px viravam uma imagem de
  1600 px (1 px da imagem = 2,4 px reais).
- O resultado também diz **em que coordenadas apontar**: pixels da imagem para a maioria dos modelos, e **relativas de 0
  a 1000** para a família Qwen3-VL (Qwen3.5/3.6/3.8, inclusive o do Colab) e UI-TARS, que são treinados assim. Lidas
  como pixels, as coordenadas desses modelos caíam longe do alvo.
- Depois de `computer_mouse_move` ou de um clique por coordenada, o modelo recebe um **recorte 1:1 de 220x220 px ao redor
  do ponteiro com uma cruz vermelha**, para conferir se parou sobre o alvo antes de clicar.
- Uma ferramenta do modo chamada pelo nome sem `tool_load` (ex.: `computer_screenshot`) é carregada e executada na hora,
  em vez de devolver "não está carregada" (ferramentas de MCP continuam pedindo `tool_load`).
- Provas: `tests/computer-pointer-grid.test.ts`, `node scripts/ui-chat-computer.cjs --mouse` (janela-alvo
  `scripts/lib/click-target.ps1`; mexe no mouse de verdade) e, com o modelo do Colab, `--real --provider colab`.

Ordem de percepção instruída ao agente (prompt + descrições das ferramentas):

1. `computer_list_windows` para descobrir app/janela;
2. `computer_snapshot(app | window)` para a árvore com `element_index` (com
   `window` e `include_screenshot`, também a imagem da janela);
3. ação por índice (`computer_click`, `computer_set_value`, `computer_type_text`,
   `computer_secondary_action`);
4. verificação com `computer_wait_for` (espera um texto ou uma mudança na
   árvore), novo snapshot e/ou `computer_screenshot`;
5. coordenadas `x/y` apenas quando 1–3 falham: da imagem da janela (com
   `window`) ou da última `computer_screenshot`, que o Openclod converte para a
   tela real (origem e escala do desktop virtual, multi-monitor).

Como funciona por dentro: o `open-computer-use` guarda a árvore de cada app
**só na memória do próprio processo**, então o Openclod mantém um único processo
`open-computer-use mcp` vivo. Se ele reiniciar, a ação por elemento tira um
novo snapshot e tenta de novo uma vez. Erros do backend chegam ao agente como
falha (`ok: false`), nunca como sucesso.

As ações de entrada passam pela política (no modo `auto`, sem perguntar). As
travas `ALLOW_FOREGROUND_INPUT`, `ALLOW_APP_LAUNCH` e `ALLOW_FOCUS_ACTIONS` do
backend só são ligadas quando "Permitir controle real de mouse e teclado" está
ativo.

Diagnóstico: **Configurações → Sobre → Capacidades detectadas** mostra backend,
caminho e detalhe do erro.

## 9. Navegação web

- Motor: **Playwright** (Apache-2.0). A ordem de lançamento é
  `channel: 'chrome'` → `'msedge'` → Chromium instalado pelo Playwright.
- O Openclod **não baixa navegador automaticamente**. Se não houver Chrome/Edge:

  ```powershell
  npx playwright install chromium
  ```

- Percepção por árvore de acessibilidade (`ariaSnapshot`), com fallback para texto.
- Ações disponíveis: abrir, navegar, clicar, digitar, teclar, ler, screenshot,
  console/erros de rede e esperar.
- **Não existe `browser_eval`**: executar JavaScript arbitrário na página seria um
  bypass da política.
- A janela do navegador é headless por padrão; `browser_open` aceita `headed: true`.
- Toda ferramenta de navegador exige rede habilitada em Configurações → Permissões.
- O navegador é por sessão e é fechado ao cancelar/excluir a sessão.

## 10. MCP

O Openclod fala **MCP por stdio** (JSON-RPC 2.0 delimitado por linha) e suporta
`initialize`, `tools/list` e `tools/call`.

Configure em **Configurações → MCP**, como um array JSON:

```json
[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\projetos"],
    "env": {},
    "enabled": true
  }
]
```

- As ferramentas aparecem como `mcp__servidor__ferramenta`.
- São tratadas como risco `exec` e passam pela mesma política/aprovação.
- Salvar o MCP reinicia os servidores; o botão **Reiniciar** também força isso.
- Falhas de inicialização aparecem como `state: error` em Configurações → Sobre
  (o erro detalhado fica no estado do servidor e no log).
- Prompts e resources de MCP não são usados nesta versão.

## 11. Skills

Skills são pastas com um `SKILL.md`:

```
%APPDATA%\Openclod\skills\
  revisao-de-codigo\
    SKILL.md
  minha-skill\
    SKILL.md
```

Formato:

```markdown
---
name: minha-skill
description: Quando e como usar esta skill.
---

# Título

Instruções completas que o agente carrega somente quando chamar `use_skill`.
```

- No primeiro início, o Openclod cria duas skills de exemplo:
  `revisao-de-codigo` e `depuracao-sistematica`.
- O agente vê nome/descrição em `list_skills` e carrega o corpo com `use_skill`.
- O corpo é limitado a 20.000 caracteres por skill.
- Apenas a pasta do usuário é registrada nesta versão; reinicie o app após criar
  ou editar skills para recarregar a biblioteca.

## 12. Onde ficam os dados

Tudo fica em `%APPDATA%\Openclod` (o `userData` do Electron):

```
%APPDATA%\Openclod\
  config\
    settings.json              provedores, política, limites, MCP, tema
    secrets.bin                chaves cifradas com DPAPI (safeStorage)
  data\
    projects.json              projetos registrados
    sessions\<id>.json         sessão: mensagens, plano, mudanças, uso
    sessions\<id>.events.jsonl auditoria append-only
    memory\<projectId>.json    fatos de memória do projeto
    memory\projects\<projectId>\
      wiki\<slug>.md           wiki markdown do projeto (fonte da verdade)
      index.json               índice lexical derivado
      handoffs.json            handoffs claim-once
  skills\<nome>\SKILL.md       skills do usuário
  logs\main.log                log do processo principal
```

- `settings.json` **não contém chaves**.
- Gravações de sessão/projetos são atômicas (arquivo temporário + rename).
- Exportação de sessão gera JSON no formato `openclod.session.v1`.
- O código do projeto aberto não é copiado para `%APPDATA%`; só entram no histórico
  os trechos que passaram pelas ferramentas e as mensagens do modelo.

## 13. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "o provedor X não tem credencial configurada" | chave ausente/inválida | Configurações → Provedores → salvar config, salvar chave, **Testar** |
| HTTP 401/403 no teste | chave errada, URL base errada ou conta sem acesso ao modelo | confira URL/modelo e a chave; em OpenRouter, o modelo precisa do prefixo do provedor |
| HTTP 404 no teste | caminho da API incompatível | use a URL base sem `/chat/completions` (ex.: `https://api.openai.com/v1`) |
| Ollama/LM Studio "sem credencial" | servidor local desligado | inicie o servidor, carregue um modelo e confirme a porta (11434/1234) |
| "não foi possível iniciar o Chromium" | sem Chrome/Edge e sem Chromium do Playwright | instale Chrome/Edge ou rode `npx playwright install chromium` |
| "open-computer-use não encontrado" | binário opcional ausente | `npm i -g @opensymph/open-computer-use` e reabra o app |
| O microfone não inicia | microfone bloqueado, modelo ausente ou build antiga | Configurações → Voz mostra o motivo; confira `resources/models/whisper` e rode `npm run build` (o worklet é um arquivo estático) |
| O atalho global não responde | outro aplicativo usa o mesmo atalho | Configurações → Voz → mude o atalho (ex.: `Control+Alt+J`) e salve |
| O texto ditado foi para o app errado | "Inserir em" = qualquer app e o foco mudou | use "Somente no compositor do Openclod" ou mantenha o campo em foco |
| Página nova não aparece em Memória | wiki editada fora do app | Configurações → Memória → **Atualizar** (o índice é reconstruído a partir dos `.md`) |
| "Controle de mouse/teclado desativado" | política | Configurações → Permissões → habilitar controle real |
| Aprovação "sumiu" e o turno falhou | expirou em 5 min | responda o painel de aprovação; repita a ação |
| Janela em branco ou app não abre | erro de inicialização | veja `%APPDATA%\Openclod\logs\main.log`; rode `npm run build` e observe o typecheck |
| `npm install` falha ao baixar Electron | proxy/firewall | configure proxy do npm ou `ELECTRON_MIRROR`; tente novamente |
| SmartScreen bloqueia o instalador | build sem assinatura | "Mais informações" → "Executar assim mesmo"; para distribuir, assine (ver `docs/INSTALL.md`) |
| Antivírus reclama do instalador NSIS | executável não assinado | assine o binário; não desative a proteção do sistema |
| Sessão travada em "aguardando aprovação" | pedido pendente | aprove/negue no painel ou aborte o turno |
| Dados estranhos após atualizar | formato antigo de settings/sessão | feche o app, faça backup e mova `%APPDATA%\Openclod\config` para recriar o padrão |

Log principal: `%APPDATA%\Openclod\logs\main.log`.

## 14. Desinstalação

O instalador NSIS instala por usuário em `%LOCALAPPDATA%\Programs\Openclod` e **não
apaga os dados** ao desinstalar (`deleteAppDataOnUninstall: false`).

1. Feche o Openclod.
2. **Configurações → Aplicativos → Aplicativos instalados → Openclod → Desinstalar**
   (ou execute `%LOCALAPPDATA%\Programs\Openclod\Uninstall Openclod.exe`).
3. Confirme. Atalhos do Menu Iniciar e da área de trabalho são removidos.
4. Para remoção **completa**, apague também:

   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\Openclod"
   ```

   Isso remove configurações, chaves cifradas, sessões, memória, skills e logs.
5. Se restar alguma pasta de instalação:

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Openclod"
   ```

Detalhes e verificação de desinstalação limpa: [`docs/INSTALL.md`](docs/INSTALL.md).

## 15. Build e empacotamento

- Build do código: `npm run build` → `out/main`, `out/preload`, `out/renderer`.
- Empacotamento: `electron-builder.yml` (NSIS x64, `appId com.openclod.desktop`,
  artefato `release/Openclod-<versão>-setup.exe`).
- Ícones são opcionais: `build/icon.ico` (executável/instalador) e
  `build/icon.png` (janela). Sem eles, o build usa o ícone padrão do Electron.
  Veja `build/README.md`.
- Não há assinatura de código nem auto-update configurados.
- Passo a passo reproduzível: [`docs/INSTALL.md`](docs/INSTALL.md).
- Matriz de dependências e compatibilidade: [`docs/DEPENDENCY_MATRIX.md`](docs/DEPENDENCY_MATRIX.md).
- Análise do Wispr Flow (REA) e decisão de implementação: [`docs/research/WISPR_FLOW.md`](docs/research/WISPR_FLOW.md).
- Estudo do ai-memory e da memória por projeto: [`docs/research/AI_MEMORY.md`](docs/research/AI_MEMORY.md).
- Auditoria completa do harness (testes reais, requisitos × código, telas × Claude Desktop, 670 capacidades do Claude Code):
  [`docs/AUDITORIA-HARNESS-2026-10-27.md`](docs/AUDITORIA-HARNESS-2026-10-27.md) e [`docs/audit/`](docs/audit/).
- Avisos de terceiros: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## 16. Privacidade

- **Sem telemetria** (`telemetry: false` no modelo de configurações).
- Chamadas de modelo vão apenas para o provedor que você configurou, usando a sua
  chave. Provedores locais (Ollama/LM Studio) não saem da máquina.
- Ferramentas de rede (fetch, busca, navegador, download) só funcionam com
  `allowNetwork` habilitado.
- Navegação e execução de comandos são auditadas localmente em JSONL.
- O Openclod não envia sessões, chaves ou código para servidores do projeto Openclod.

## 17. Licença e marcas

- Código do Openclod: **MIT** (veja `package.json`).
- Dependências de terceiros: licenças e obrigações em
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- **Nenhum código, logo, ícone ou fonte proprietária da Anthropic/Claude é usado.**
  "Claude" e "Anthropic" são marcas de seus titulares e aparecem apenas para
  identificar o provedor compatível. O Openclod é um projeto independente, sem
  afiliação, patrocínio ou endosso.
- Fontes incluídas: **Inter** e **Source Serif 4**, ambas sob SIL Open Font
  License 1.1.
