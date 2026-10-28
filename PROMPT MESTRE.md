# PROMPT MESTRE — EXPANDIR NOSSO AI DEVELOPMENT HARNESS USANDO CÓDIGO-FONTE OPEN SOURCE

## 1. MISSÃO

Você está trabalhando no nosso AI Development Harness, uma aplicação própria de desktop para desenvolvimento assistido por inteligência artificial.

Sua missão é **analisar o projeto existente, clonar os repositórios fornecidos neste documento, estudar suas implementações e aproveitar o melhor código disponível para ampliar e aprimorar nosso harness**.

Não queremos apenas uma lista de recomendações, uma documentação teórica ou uma proposta de arquitetura.

Queremos evolução real do software, aproveitando implementações existentes sempre que forem melhores do que as nossas ou oferecerem capacidades que ainda não possuímos.

Os repositórios abaixo já foram selecionados para você. Não comece procurando outras listas de ferramentas na internet. Trabalhe inicialmente com os links fornecidos, seus códigos-fonte, suas documentações e seus exemplos.

## 2. REGRAS FUNDAMENTAIS

1. Antes de alterar qualquer coisa, examine o projeto atual e entenda como ele funciona.
2. Identifique as funcionalidades existentes, as incompletas, as que apresentam problemas e as que ainda não foram implementadas.
3. Clone os repositórios listados na pasta repositorios. que esta na raiz do projeto.
4. Examine o código real, não apenas os arquivos README.
5. Identifique os módulos, algoritmos, componentes, interfaces, adaptadores e implementações que podem ser aproveitados.
6. Compare as implementações externas com as nossas.
7. Quando uma implementação externa for melhor, adapte e integre o código correspondente ao nosso harness.
8. Quando não existir uma funcionalidade equivalente, avalie e integre uma implementação adequada.
9. Quando nosso código já for melhor, estiver mais integrado ou atender suficientemente à necessidade, preserve-o.
10. Não substitua uma implementação funcional apenas porque existe uma alternativa conhecida.
11. Não copie cegamente projetos inteiros nem misture vários projetos incompatíveis.
12. Não deixe funcionalidades duplicadas sem uma justificativa técnica.
13. Não interrompa o trabalho após produzir um relatório. Execute as melhorias que forem viáveis e compatíveis com o projeto.
14. Não reescreva o harness inteiro sem necessidade.
15. Preserve a identidade, a interface, as configurações, os dados e os recursos existentes.
16. Não invente funcionalidades concluídas. Tudo o que for implementado deve ser verificado.

O objetivo é aproveitar o conhecimento e o código já desenvolvidos pela comunidade para construir uma solução própria mais completa.

## 3. REPOSITÓRIOS DE AGENTES DE PROGRAMAÇÃO

Estude os seguintes projetos como fontes de implementações de agentes, ferramentas, gerenciamento de contexto, execução de tarefas, edição de arquivos e interação com modelos de linguagem.

### 3.1. OpenCode
https://github.com/anomalyco/opencode

Investigue:
- Arquitetura do agente de programação.
- Abstração de provedores de modelos.
- Ferramentas nativas.
- Gerenciamento de sessões.
- Execução de tarefas.
- Integração com MCP.
- Sistema de comandos, agentes e extensões.
- Tratamento de streaming e chamadas de ferramentas.

### 3.2. OpenHands
https://github.com/All-Hands-AI/OpenHands

Investigue:
- Agentes que trabalham em projetos existentes.
- Execução de comandos e edição de arquivos.
- Organização das ferramentas.
- Ambientes de execução.
- Planejamento e execução de tarefas.
- Integração com ferramentas de desenvolvimento.
- Verificação dos resultados produzidos pelo agente.

### 3.3. Aider
https://github.com/Aider-AI/aider

Investigue:
- Edição de código em repositórios existentes.
- Aplicação de alterações em arquivos.
- Uso de diffs.
- Contexto de repositório.
- Integração com Git.
- Seleção de arquivos relevantes.
- Estratégias para evitar alterações desnecessárias.

### 3.4. OpenAI Codex CLI
https://github.com/openai/codex

Investigue:
- Arquitetura do agente de terminal.
- Ferramentas de leitura e escrita.
- Execução de comandos.
- Gerenciamento de sessões.
- Integração com modelos.
- Planejamento de tarefas.
- Aplicação e revisão de alterações.
- Separação entre agente, ferramentas e interface de execução.

Utilize o código-fonte público desse repositório como referência. Não presuma que ele contém a implementação completa do aplicativo desktop Codex.

### 3.5. Cline
https://github.com/cline/cline

Investigue:
- Ciclo de execução do agente.
- Ferramentas de programação.
- Chamadas de ferramentas.
- Integração com modelos.
- Contexto de arquivos.
- Edição e revisão de código.
- Extensibilidade.
- Interface de acompanhamento das ações.

### 3.6. Goose
https://github.com/block/goose

Investigue:
- Arquitetura de agentes extensíveis.
- Ferramentas integradas.
- Integração com MCP.
- Suporte a diferentes provedores.
- Extensões.
- Gerenciamento de tarefas e contexto.
- Reutilização de capacidades por agentes.

### 3.7. SWE-agent
https://github.com/SWE-agent/SWE-agent

Investigue:
- Resolução automatizada de problemas em repositórios.
- Localização de defeitos.
- Edição de código.
- Execução de testes.
- Ciclo de tentativa, observação e correção.
- Avaliação dos resultados.

### 3.8. Open Interpreter
https://github.com/OpenInterpreter/open-interpreter

Investigue:
- Execução de código por meio de linguagem natural.
- Integração com o ambiente local.
- Interação com processos.
- Execução de tarefas no computador.
- Integração com modelos locais e remotos.
- Arquitetura de ferramentas.

### 3.9. Qwen Code
https://github.com/QwenLM/qwen-code

Investigue:
- Arquitetura de agente de programação.
- Uso de ferramentas.
- Integração com provedores e modelos.
- Sessões e contexto.
- Execução de tarefas no terminal.
- Configuração e extensibilidade.

### 3.10. Kilo Code
https://github.com/Kilo-Org/kilocode

Investigue:
- Modos de trabalho do agente.
- Ferramentas e delegação.
- Integração com provedores.
- Gerenciamento de contexto.
- Execução de tarefas de programação.
- Arquitetura de extensões e personalização.

Não implemente vários agentes completos em paralelo sem necessidade. Aproveite os componentes que complementem melhor a arquitetura atual.

## 4. FRAMEWORKS DE AGENTES E ORQUESTRAÇÃO

### 4.1. LangGraph
https://github.com/langchain-ai/langgraph

Investigue workflows com estado, ramificações, persistência, interrupções e retomada de tarefas.

### 4.2. CrewAI
https://github.com/crewAIInc/crewAI

Investigue agentes especializados, delegação de tarefas, equipes de agentes e workflows.

### 4.3. Pydantic AI
https://github.com/pydantic/pydantic-ai

Investigue ferramentas tipadas, validação, dependências, integração com modelos e execução estruturada.

### 4.4. Agno
https://github.com/agno-agi/agno

Investigue agentes, equipes, memória, ferramentas e execução de tarefas com diferentes modelos.

### 4.5. AutoGen
https://github.com/microsoft/autogen

Investigue coordenação entre agentes, mensagens, ferramentas e execução de workflows.

**Resultado esperado desta categoria:** identificar como ampliar a capacidade de criar agentes especializados, executar tarefas complexas em várias etapas, delegar trabalho e recuperar execuções interrompidas, sem adicionar frameworks desnecessários.

## 5. MCP, FERRAMENTAS E INTEGRAÇÕES

### 5.1. Repositório oficial de servidores MCP
https://github.com/modelcontextprotocol/servers

Examine as implementações disponíveis, especialmente:

- Filesystem.
- Git.
- Fetch.
- Memory.
- Sequential Thinking.
- Everything, para testes de integração.

Verifique a estrutura e o estado atual de cada implementação, pois alguns servidores podem ter sido movidos ou alterados.

### 5.2. SDK oficial MCP para TypeScript
https://github.com/modelcontextprotocol/typescript-sdk

### 5.3. SDK oficial MCP para Python
https://github.com/modelcontextprotocol/python-sdk

### 5.4. Repositório de referência e documentação do protocolo
https://github.com/modelcontextprotocol/modelcontextprotocol

### 5.5. Catálogo comunitário de servidores MCP
https://github.com/BrethofAI/awesome-mcp-servers

Utilize o catálogo para identificar os servidores relevantes presentes na lista e siga os links para seus repositórios oficiais.

Investigue como incorporar ao harness:

- Descoberta de ferramentas.
- Cadastro e configuração de servidores.
- Comunicação com servidores MCP.
- Gerenciamento de processos e conexões.
- Descoberta de ferramentas, recursos e prompts.
- Registro de capacidades disponíveis.
- Integração com GitHub, arquivos, bancos de dados e outros sistemas.
- Tratamento de erros, desconexões e incompatibilidades de protocolo.

Não é necessário embutir todos os servidores MCP no código do harness. Quando for melhor, implemente um sistema de integração que permita instalar, configurar e utilizar servidores separadamente.

## 6. COMPUTER USE E CONTROLE DO COMPUTADOR

Computer Use é apenas um dos módulos do nosso harness.

### 6.1. Win Computer Use
https://github.com/CarlosShao/win-computer-use

Investigue:
- Captura de tela.
- Controle de mouse e teclado.
- Gerenciamento de janelas.
- Automação de aplicativos Windows.
- Reconhecimento de elementos.
- OCR e correspondência visual.

### 6.2. Desktop Use
https://github.com/dutuanan96/desktop-use

Investigue:
- API de automação desktop.
- Comunicação HTTP e WebSocket.
- Captura de tela.
- OCR.
- Clique e digitação.
- Gerenciamento de janelas.
- Integração com agentes externos.

### 6.3. PyAutoGUI
https://github.com/asweigart/pyautogui

Investigue controle de mouse, teclado, screenshots e automação multiplataforma.

### 6.4. Browser Use
https://github.com/browser-use/browser-use

Investigue agentes que interagem com páginas web, navegação, cliques, preenchimento de formulários e execução de tarefas em navegadores.

### 6.5. Playwright
https://github.com/microsoft/playwright

Investigue automação de navegadores, seleção de elementos, navegação, screenshots, interação com páginas e verificação de resultados.

### 6.6. Puppeteer
https://github.com/puppeteer/puppeteer

Investigue controle de Chromium, navegação, interação com páginas e integração com agentes.

### 6.7. Browserbase Stagehand
https://github.com/browserbase/stagehand

Investigue automação web baseada em instruções de alto nível, combinação de seletores tradicionais com capacidades de IA e interação estruturada com páginas.

Avalie separadamente automação web e automação desktop nativa. Não trate essas duas capacidades como se fossem a mesma coisa.

Aproveite os componentes que forem compatíveis com a arquitetura existente e que tragam uma melhoria concreta.

## 7. MODELOS DE LINGUAGEM E ROTEAMENTO

### 7.1. LiteLLM
https://github.com/BerriAI/litellm

Investigue:
- Integração com diferentes provedores.
- Normalização de chamadas.
- Streaming.
- Roteamento de modelos.
- Fallback.
- Controle de custos e consumo.
- Compatibilidade com APIs de diferentes fornecedores.

### 7.2. Ollama
https://github.com/ollama/ollama

Investigue a integração com modelos locais, gerenciamento de modelos e comunicação com serviços locais.

### 7.3. llama.cpp
https://github.com/ggml-org/llama.cpp

Investigue inferência local, compatibilidade com modelos, interfaces de execução e integração com serviços locais.

### 7.4. Vercel AI SDK
https://github.com/vercel/ai

Investigue abstração de provedores, streaming, ferramentas e integração com aplicações TypeScript.

### 7.5. OpenRouter SDK
https://github.com/OpenRouterTeam/typescript-sdk

Investigue o cliente e a integração com o serviço OpenRouter, sem tornar o harness dependente exclusivamente dele.

O objetivo é manter nosso sistema flexível para alternar entre modelos locais e remotos, sem precisar reescrever os agentes para cada provedor.

## 8. SISTEMA DE ARQUIVOS, BUSCA E COMPREENSÃO DE CÓDIGO

### 8.1. ripgrep
https://github.com/BurntSushi/ripgrep

Investigue busca textual rápida em grandes projetos e filtragem de arquivos.

### 8.2. Tree-sitter
https://github.com/tree-sitter/tree-sitter

Investigue análise sintática incremental e compreensão estrutural de diferentes linguagens.

### 8.3. ast-grep
https://github.com/ast-grep/ast-grep

Investigue pesquisa e transformação de código baseada em estruturas sintáticas.

### 8.4. Universal Ctags
https://github.com/universal-ctags/ctags

Investigue indexação de símbolos, definições e referências em diferentes linguagens.

### 8.5. Sourcegraph SCIP
https://github.com/sourcegraph/scip

Investigue indexação de símbolos e informações de navegação semântica de código.

### 8.6. Eclipse JDT Language Server
https://github.com/eclipse-jdtls/eclipse.jdt.ls

Investigue como servidores de linguagem oferecem diagnósticos, navegação e recursos de análise de código.

### 8.7. Language Server Protocol
https://github.com/microsoft/language-server-protocol

Investigue a integração com servidores de linguagem para diagnóstico, autocompletar, navegação e informações estruturadas sobre código.

Use essas referências para melhorar a capacidade do harness de entender projetos, encontrar código relevante, localizar símbolos e produzir alterações mais precisas.

## 9. MEMÓRIA E CONTEXTO PERSISTENTE

### 9.1. Mem0
https://github.com/mem0ai/mem0

Investigue memória persistente para agentes e recuperação de informações relevantes.

### 9.2. Chroma
https://github.com/chroma-core/chroma

Investigue armazenamento e recuperação de dados para busca semântica.

### 9.3. Qdrant
https://github.com/qdrant/qdrant

Investigue busca vetorial, indexação e recuperação de informações.

### 9.4. SQLite Vec
https://github.com/asg017/sqlite-vec

Investigue busca vetorial integrada a SQLite e possibilidades de armazenamento local.

### 9.5. LlamaIndex
https://github.com/run-llama/llama_index

Investigue ingestão de documentos, indexação, recuperação contextual e RAG.

Avalie como oferecer memória de sessões, memória de projetos, recuperação de decisões anteriores e indexação de documentos, mantendo o armazenamento coerente com a arquitetura atual.

Não adicione múltiplos bancos vetoriais se uma única implementação atender ao objetivo.

## 10. INTERFACE DESKTOP E COMPONENTES DE DESENVOLVIMENTO

### 10.1. Electron
https://github.com/electron/electron

Investigue integração entre frontend web e processos desktop.

### 10.2. Tauri
https://github.com/tauri-apps/tauri

Investigue integração entre frontend e backend nativo, IPC, comandos e distribuição desktop.

### 10.3. xterm.js
https://github.com/xtermjs/xterm.js

Investigue terminal integrado, renderização de saída, interação com sessões e extensões.

### 10.4. Monaco Editor
https://github.com/microsoft/monaco-editor

Investigue edição de código, diagnósticos, navegação e integração com serviços de linguagem.

### 10.5. CodeMirror
https://github.com/codemirror/dev

Investigue edição de código, extensibilidade, personalização e suporte a diferentes linguagens.

### 10.6. Zed
https://github.com/zed-industries/zed

Investigue arquitetura de editor, desempenho, interface, colaboração e recursos de desenvolvimento assistido por IA.

### 10.7. Terax
https://github.com/crynta/terax

Investigue como um ambiente desktop reúne terminal, editor, explorador de arquivos, controle de versão, visualização web e recursos de IA.

Use projetos desktop como referências de arquitetura e componentes. Não substitua automaticamente nossa interface nem mude a tecnologia principal sem demonstrar que isso é necessário.

## 11. TESTES, AVALIAÇÃO E OBSERVABILIDADE

### 11.1. promptfoo
https://github.com/promptfoo/promptfoo

Investigue testes de prompts, comparação de modelos e avaliação de respostas.

### 11.2. DeepEval
https://github.com/confident-ai/deepeval

Investigue testes automatizados e métricas de avaliação para sistemas de IA.

### 11.3. Langfuse
https://github.com/langfuse/langfuse

Investigue rastreamento de chamadas, observabilidade, custos, latência e análise de execuções de agentes.

### 11.4. OpenTelemetry
https://github.com/open-telemetry/opentelemetry

Investigue instrumentação, traces, métricas e logs.

### 11.5. Playwright Test
https://github.com/microsoft/playwright

Investigue testes automatizados de interface e fluxos completos de interação.

O objetivo é melhorar a capacidade de identificar falhas, entender o que aconteceu durante uma execução e verificar se as integrações funcionam de verdade.

## 12. PROCESSO DE TRABALHO OBRIGATÓRIO

### Fase 1 — Conhecer o harness existente

Antes de modificar o projeto:

- Identifique a estrutura de diretórios.
- Identifique as tecnologias utilizadas.
- Localize os pontos de entrada da aplicação.
- Identifique os principais módulos.
- Localize as implementações de agentes, ferramentas, modelos, memória, interface e integrações.
- Verifique os testes existentes.
- Identifique as funcionalidades completas e incompletas.
- Registre o estado inicial do Git e das alterações já existentes.
- Execute os testes atuais, quando possível.

Não sobrescreva alterações locais que já existam.

### Fase 2 — Clonar os repositórios

Clone os projetos listados.

Organize os clones por categoria, por exemplo:

- `research/agents/`
- `research/orchestration/`
- `research/mcp/`
- `research/computer-use/`
- `research/browser/`
- `research/models/`
- `research/code-analysis/`
- `research/memory/`
- `research/desktop-ui/`
- `research/testing/`

A estrutura acima é uma sugestão para a área temporária de pesquisa, não uma ordem para reorganizar o projeto principal.

Registre os URLs, os commits examinados, as tecnologias, as dependências e as licenças de cada repositório.

Se algum clone falhar, registre o erro e continue com os demais.

### Fase 3 — Inspecionar o código-fonte

Para cada repositório, examine os arquivos relevantes:

- Código principal.
- Módulos de ferramentas.
- Interfaces públicas.
- Adaptadores.
- Sistemas de configuração.
- Gerenciamento de estado.
- Integrações com LLM.
- Execução de comandos.
- Tratamento de erros.
- Testes.
- Exemplos funcionais.
- Dependências e licenças.

Não conclua que um recurso existe apenas porque aparece na descrição do projeto. Localize a implementação correspondente.

### Fase 4 — Comparar com o nosso código

Para cada capacidade identificada, classifique o estado atual do harness:

- **Já existe e funciona bem:** preservar.
- **Existe, mas está incompleta:** aprimorar.
- **Existe, mas possui uma implementação inferior:** avaliar substituição ou adaptação.
- **Não existe:** avaliar implementação a partir dos projetos disponíveis.
- **Não é compatível ou não oferece benefício concreto:** não integrar.

Essa classificação deve considerar qualidade, compatibilidade, manutenção, desempenho e custo de integração.

### Fase 5 — Aproveitar e integrar o código

Quando uma implementação externa oferecer uma melhoria:

1. Identifique os arquivos e módulos relevantes.
2. Entenda as dependências e interfaces utilizadas.
3. Verifique a compatibilidade com nosso projeto.
4. Adapte o código para nossas convenções e tecnologias.
5. Preserve as interfaces públicas existentes sempre que possível.
6. Evite duplicar funcionalidades.
7. Integre o componente de maneira que possa ser mantido.
8. Atualize as dependências e configurações necessárias.
9. Acrescente ou adapte os testes.
10. Documente a origem do código aproveitado.

Não é obrigatório copiar código literalmente. Quando for tecnicamente melhor, reproduza a abordagem ou adapte a implementação para nossa arquitetura.

Se um projeto completo possuir uma funcionalidade muito superior, avalie a possibilidade de aproveitar um módulo específico ou integrar o projeto como componente separado, em vez de transplantar toda a aplicação.

### Fase 6 — Testar cada melhoria

Após cada integração:

- Execute os testes relevantes.
- Verifique se o harness inicia.
- Verifique se as funcionalidades existentes continuam funcionando.
- Teste os novos recursos.
- Verifique as dependências.
- Analise os erros e logs.
- Corrija regressões causadas pelas alterações.
- Documente as limitações que não puderem ser resolvidas.

Não marque uma funcionalidade como concluída apenas porque o código foi escrito.

### Fase 7 — Consolidar o resultado

Ao final, apresente:

1. Quais repositórios foram clonados e examinados.
2. Quais implementações foram aproveitadas.
3. Quais funcionalidades foram adicionadas.
4. Quais funcionalidades existentes foram aprimoradas.
5. Quais componentes foram preservados por já serem adequados.
6. Quais projetos não puderam ser aproveitados e por quê.
7. Quais dependências foram adicionadas.
8. Quais testes foram executados e seus resultados.
9. Quais problemas permanecem.
10. Quais melhorias são recomendadas para a próxima etapa.

## 13. COMPATIBILIDADE, LICENÇAS E PROCEDÊNCIA DO CÓDIGO

Antes de incorporar código de terceiros, identifique a licença e as condições de reutilização de cada repositório.

Prefira implementações cuja licença seja compatível com o uso pretendido. Preserve avisos de copyright e atribuições exigidas, e registre a procedência dos componentes incorporados.

Quando a licença for restritiva, estiver ausente ou não permitir claramente o uso pretendido, não incorpore o código sem resolver essa questão. Nesse caso, utilize o projeto como referência técnica e procure uma implementação que possa ser aproveitada adequadamente.

Não execute scripts de instalação, binários ou comandos desconhecidos indiscriminadamente. Inspecione o que será executado e as alterações que poderá provocar no ambiente.

Esses cuidados fazem parte da engenharia do projeto e não impedem a integração de recursos que possam ser utilizados legitimamente.

## 14. RESULTADO FINAL ESPERADO

Queremos que nosso harness evolua para uma plataforma modular e extensível que possa reunir, de maneira integrada:

- Diferentes modelos de inteligência artificial.
- Agentes de programação.
- Agentes especializados.
- Execução de workflows.
- Ferramentas nativas.
- Integrações MCP.
- Sistema de skills e instruções reutilizáveis.
- Terminal e execução de comandos.
- Leitura e edição de projetos.
- Análise e busca de código.
- Controle de versão.
- Navegação web.
- Automação de navegador.
- Computer Use.
- Memória persistente.
- Recuperação de contexto.
- Interface desktop integrada.
- Sistema de extensões.
- Testes automatizados.
- Logs, métricas e rastreamento de execuções.

Essa lista representa o objetivo de evolução, não a obrigação de instalar todas as tecnologias ou implementar todos os recursos de uma vez.

A escolha de cada componente deve ser orientada pela qualidade da implementação, pela compatibilidade e pelo benefício real para nosso projeto.

## 15. INSTRUÇÃO FINAL

Comece examinando o harness atual. Depois, clone os repositórios fornecidos, examine o código-fonte e compare suas implementações com as nossas.

Trabalhe de forma incremental, aproveitando o que já existe, substituindo somente o que realmente puder ser melhorado e adicionando capacidades novas quando houver benefício concreto.

**Não entregue somente um plano. Execute as melhorias compatíveis, teste o resultado e documente o que foi efetivamente implementado.**

A meta é construir nosso próprio harness, aproveitando o melhor das implementações open source disponíveis, sem perder as funcionalidades que já desenvolvemos.
---

## 16. LEDGER DE EXECUÇÃO — 2026-10-25

Este bloco é a memória operacional do trabalho. Cada item só pode ser marcado
como concluído quando houver código no repositório e uma verificação reproduzível.

### 16.1. Base já verificada antes desta jornada

- [x] OpenCode como provedor de modelos (`opencode-go`), com chave no cofre DPAPI,
  modelo `beam-free` e teste real respondendo `pong`.
- [x] Modo padrão `unrestricted`, com migração das configurações antigas e sem
  bloqueios locais de ferramentas quando esse modo está ativo.
- [x] Computer Use real no Windows: matriz de todas as janelas abertas no teste,
  incluindo Bloco de Notas, Chrome, Explorer, ChatGPT, OpenCode e Antigravity,
  com 46 sucessos, 4 limitações explícitas do backend e 0 falhas inesperadas.
  Rolagem global passou depois de nova observação do estado.
- [x] Snapshot de acessibilidade, referências estáveis, rejeição de `element_stale`
  e limite explícito de árvores grandes.
- [x] Ponte para o Chrome já aberto, host nativo e extensão unpacked preparados.
  A extensão continua dependendo da confirmação de carregamento feita pelo Chrome.
- [x] Memória wiki por projeto, links `[[...]]`, tags, termos e grafo clicável.
- [x] Importação de ZIP Markdown para a memória, com limites de tamanho e quantidade.
- [x] Capturas da interface do Claude preservadas em `PrintClaude/` (107 imagens
  e índice), conforme solicitado.
- [x] Executável NSIS gerado em `release/Openclod Desktop-0.1.0-setup.exe`.
- [x] Suíte anterior registrada com 743 testes aprovados, além de typecheck e build.

### 16.2. Concluído nesta jornada

- [x] Auditar o `PROMPT MESTRE.md`, o estado das pendências e a documentação de
  comparação já produzida.
- [x] Adicionar OpenCode como terceiro executor externo do harness, junto de
  Claude Code e Codex CLI.
- [x] Interpretar o fluxo JSON do `opencode run --format json`, incluindo texto,
  sessão, progresso de ferramentas, falhas e consumo de tokens/custo.
- [x] Habilitar permissões integrais do OpenCode no modo `unrestricted` por
  `--auto`, mantendo `OPENCODE_PERMISSION` como compatibilidade com versões antigas.
- [x] Permitir modelo `provider/model` por chamada no executor OpenCode, sem
  ignorar a configuração padrão do usuário quando o campo é omitido.
- [x] Validar o executor com teste focado: **40/40 aprovados**.
- [x] Validar TypeScript estrito em `tsconfig.node.json` e `tsconfig.web.json`.
- [x] Atualizar o CLI de `1.2.10` para `1.19.4`, remover a chave `shell` legada
  com backup do arquivo original e validar o JSON da configuração.
- [x] Teste ponta a ponta real: `external_agent` chamou o OpenCode `1.19.4`
  com `opencode/beam-free`, recebeu `PONG`, sessão e uso
  `input 10112 / output 3 / cached 1856`, custo `0`.
- [x] Integrar worktrees ao IPC e à criação de sessões: menu de projeto,
  criação por branch/base, abertura da sessão no checkout isolado, listagem e
  remoção segura sem apagar a branch.
- [x] Corrigir a comparação de caminhos no Windows para aliases 8.3, links e
  diferenças de caixa usando `realpath`, inclusive para projeto e worktree.
- [x] Teste E2E real do Electron: UI criou `openclod/e2e-mvnfbf3o`, a sessão
  herdou o `projectId`, usou o diretório do worktree e a remoção preservou a
  branch. Evidência em `Prints/worktrees-2026-10-25/`.
- [x] Completar a descoberta MCP de ferramentas, recursos e prompts, com
  paginação, atualização por notificação e limpeza ao desconectar.
- [x] Expor `mcp_resource` (listar/ler URI) e `mcp_prompt` (preencher e obter
  prompt) ao agente, além de mostrar as contagens no painel da sessão.
- [x] Validar client e ferramentas MCP com testes focados: **37/37 aprovados**.
- [x] Evoluir o editor visual de slides: título da apresentação, tamanho do
  objeto, duplicar, reordenar, excluir e modo apresentação com teclado.
- [x] Exportar uma apresentação HTML autônoma, com navegação e texto escapado.
- [x] E2E real do editor e da exportação no Electron; evidência em
  `Prints/slides-2026-10-25/` e **4/4 testes** do modelo de slides.
- [x] Adicionar rewind por mensagem, com confirmação explícita de que arquivos
  atuais não são revertidos, e chats laterais que ramificam o contexto.
- [x] Adicionar comentários persistentes em linhas de diff e cópia dos
  comentários para reenviar ao agente.
- [x] Capturar checkpoints Git antes de cada turno, incluindo diff binário de
  arquivos rastreados e cópia limitada de não rastreados; o rewind pode
  restaurá-los após criar um backup de segurança do estado atual.
- [x] Validar checkpoints de arquivos e rewind com **4/4 testes focados**.
- [x] Clonar e validar os 55 repositórios do prompt, com clone raso e filtro
  de blobs; inventário reproduzível com URL, commit, licença, linguagens,
  manifestos e módulos candidatos em
  `docs/research/REPOSITORY_INVENTORY_2026-10-25.md`.
- [x] Resolver os dois links inválidos do prompt para `crynta/terax-ai` e
  `open-telemetry/opentelemetry-js`; os demais 53 links foram preservados.
- [x] Repetir a matriz real de Computer Use: **50 operações, 46 sucessos**, 4 limitações
  esperadas e **0 falhas inesperadas**; evidência atualizada em
  `Prints/computer-use-2026-10-24/computer-use-matrix.json`, com 27 capturas
  da tela e da janela que comprovam a percepção visual.
- [x] Suíte completa final: **38 arquivos, 756/756 testes aprovados**, typecheck
  limpo e build Electron concluído.
- [x] Instalador NSIS atualizado: 833.041.462 bytes, SHA-256
  `14BDBEBFDC106B23839584949E2556442FD4F9FE9C7D5F2C911FD4455CFE3D82`.
- [x] Smoke test do pacote real: `Openclod Desktop.exe` abriu o renderer com
  perfil descartável; evidência em `Prints/packaged-smoke-2026-10-25.json` e
  `Prints/packaged-smoke-2026-10-25.png`.
- [x] Seletor Local/WSL/SSH/Nuvem integrado ao compositor e ao roteamento real
  de comandos; **5/5 testes**. WSL permanece bloqueado pelo firmware desta
  máquina, e SSH/Nuvem exigem um destino configurado pelo usuário.

### 16.3. Limite externo remanescente

- [ ] Validar um login OAuth contra um provedor real que aceite DCR; o fluxo,
  catálogo, reconexão e aprovação já estão implementados.
### 16.4. Evidência reproduzível desta etapa

```powershell
npm run typecheck
npx vitest run tests/external-agent.test.ts
npx esbuild scripts/opencode-executor-live.ts --bundle --platform=node --format=cjs --outfile=.qa/opencode-executor-live.cjs
node .qa/opencode-executor-live.cjs
node scripts/ui-worktrees.cjs
npx vitest run tests/mcp.test.ts tests/mcp-tools.test.ts
npx vitest run tests/slides.test.ts tests/environments.test.ts tests/rewind.test.ts
node scripts/ui-slides.cjs
node .qa/computer-use-live.cjs
.\scripts\clone-research-repos.ps1 -MaxRepos 55
.\scripts\audit-research-repos.ps1
npm run dist
node scripts/smoke-packaged.cjs
```

Resultado observado: typecheck sem erros; **40 testes aprovados**; execução real
do executor OpenCode respondendo `PONG`. O arquivo
`~/.config/opencode/opencode.json` tinha o backup
`opencode.json.openclod-backup-20261025`. O modelo global antigo
`9router/minimax/MiniMax-M3` não está exposto pelo CLI atual; por isso a execução
real usa o argumento opcional de modelo e o provedor livre `opencode/beam-free`.
O E2E de worktrees também passou e gravou `evidence.json` e a captura
`01-worktree-manager.png` em `Prints/worktrees-2026-10-25/`.
MCP: **37 testes aprovados** entre transporte, filtros, recursos e prompts.
Slides: **4 testes aprovados**; o E2E abriu o editor, apresentou e exportou
`demo.slides.html` com 2.307 bytes. Ambientes: **5 testes aprovados**.
Suíte final: **756/756**. Instalador e pacote portátil abriram com sucesso no
smoke test do Electron empacotado.

### 16.5. Módulo 29 — backup, restauração e recuperação

- [x] Bundle local versionado e comprimido com gzip, checksum SHA-256 e limites
  explícitos de tamanho e quantidade de arquivos.
- [x] Inclui projetos, sessões, preferências, memória, agentes, skills e rotinas;
  exclui `secrets.bin`, tokens OAuth, `.env` e caches temporários.
- [x] Pré-backup automático antes de restaurar, preservando o estado atual.
- [x] IPC para criar, inspecionar e restaurar, com validação do checksum e da
  versão antes de qualquer escrita.
- [x] Interface em Configurações → Backup, com caminho, data, tamanho, versão,
  hash e resultado da restauração.
- [x] Verificado com `3/3` testes focados, typecheck estrito e build Electron.
- [x] E2E do renderer: as três funções IPC existem, a aba abre, os três botões
  renderizam e não há erro de console. Evidência em
  `Prints/backup-2026-10-25/01-settings-backup.png` e `evidence.json`.
- [ ] Restauração não altera o código-fonte dos projetos; a interface informa
  que reiniciar o aplicativo aplica integralmente todas as preferências.

Verificação reproduzível:

```powershell
npx vitest run tests/backup.test.ts
npm run build
node scripts/ui-backup.cjs
```

### 16.9. Módulo 23 — leitura em voz alta

- [x] Síntese offline no Windows por `System.Speech`, sem serviço externo.
- [x] Edge Neural TTS gratuito, sem chave, com 316 vozes neurais online e fallback
  automático para `System.Speech` quando o serviço externo falha.
- [x] Vozes brasileiras Francisca, Antônio e Thalita disponíveis; Francisca é o
  padrão inicial. A interface separa “Neural online · grátis” e “Windows offline”.
- [x] Teste de voz diretamente em Configurações → Voz.
- [x] MP3 neural reproduzido no renderer via `blob/data`, com volume, cancelamento
  e CSP restrita a `media-src 'self' data: blob:`.
- [x] Runtime isolado com `edge-tts` 7.3.1 e dependências embarcadas; texto
  passa por variável de ambiente em base64, sem interpolação de comando.
- [x] Licença LGPL-3.0 preservada em
  `resources/licenses/python/edge-tts/LICENSE.txt`; procedência e dependência de
  rede documentadas em `THIRD_PARTY_NOTICES.md`.
- [x] Listagem real das vozes instaladas, seleção de voz, velocidade (-10..10)
  e volume (0..100), persistidos nas preferências.
- [x] Botão de leitura em cada resposta do agente e ação para interromper a fala.
- [x] Texto transferido ao PowerShell por base64 em variável de ambiente, sem
  interpolação de conteúdo no comando.
- [x] Limites de 20.000 caracteres, timeout de enumeração e encerramento da árvore
  de processos ao cancelar.
- [x] Ditado Whisper existente preservado; entrada e saída de voz usam pipelines
  separados e podem operar com teclado normalmente.
- [x] Teste de borda corrigido para volume `0`, sem cair no valor padrão.
- [x] Verificado com `2/2` testes focados, typecheck e build Electron.
- [x] E2E real listou Microsoft Maria (pt-BR) e Microsoft Zira (en-US) e executou
  síntese Windows completa com volume zero.
- [x] E2E atualizado listou 316 vozes Edge + 2 Windows, gerou MP3 neural válido e
  confirmou reprodução pelo botão do transcript com volume zero. Evidência em
  `Prints/tts-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/tts.test.ts
npm run build
node scripts/ui-tts.cjs
```

### 16.10. Módulo 25 — extração de documentos e citações

- [x] Extração local para PDF de texto, DOCX, XLSX, PPTX, HTML, CSV, JSON,
  Markdown e texto simples, em arquivo único ou pasta.
- [x] Páginas, slides e planilhas preservados como referências; células XLSX
  incluem endereço como `A2`.
- [x] Segmentação configurável com sobreposição e ranking por termos.
- [x] Ferramenta `document_extract` disponível em todos os modos, com busca de
  trechos e citações `arquivo#página` / `slide`.
- [x] Limites de 100 MB por arquivo, 50 arquivos por pasta e texto limitado para
  evitar bloquear a interface ou estourar contexto.
- [x] PDF protegido, corrompido, vazio ou digitalizado produz erro/aviso explícito;
  OCR não é fingido quando o ambiente não o oferece.
- [x] Dependência `fflate` adicionada para leitura ZIP local de formatos Office.
- [x] `zod` atualizado para `4.6.7`, conversão migrada para `z.toJSONSchema` e
  `zod-to-json-schema` removido; `npm audit --omit=dev` ficou sem vulnerabilidades.
- [x] Suíte completa após upgrade: **45 arquivos, 780/780 testes**, typecheck e
  build Electron aprovados.
- [x] E2E real no Electron extraiu um DOCX através da ferramenta do agente, com
  citação `brief.docx#1`, trecho correto e resumo da execução. Evidência em
  `Prints/documents-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/document-extractor.test.ts
npm run typecheck
npx vitest run
npm run build
node scripts/ui-documents.cjs
npm audit --omit=dev
```

### 16.11. Módulo 22 — multimodalidade, áudio e vídeo

- [x] Imagens continuam integradas aos provedores que suportam visão, ao compositor,
  ao navegador e ao Computer Use.
- [x] Transcrição offline de áudio/vídeo com o runtime faster-whisper embutido.
- [x] Formatos WAV, MP3, M4A, AAC, FLAC, OGG, Opus, WebM, MP4, MOV, MKV e AVI.
- [x] Resultado com idioma e probabilidade, duração, dispositivo, tipo de computação
  e segmentos com timestamps.
- [x] Ferramenta `media_transcribe`, limites de 2 GB, timeout, cancelamento e
  isolamento de ambiente/rede do Python.
- [x] Teste real: Windows TTS gerou um WAV, faster-whisper transcreveu em `pt`,
  CPU/int8, e o E2E do Electron confirmou idioma, timestamps e texto via ferramenta.
- [x] OCR offline integrado via Windows.Media.Ocr, com linhas e coordenadas das
  palavras para rastrear texto em capturas, fotos e documentos digitalizados.
- [x] Teste real reconheceu “Openclod memoria inteligente 2026” e as quatro palavras
  com posição e tamanho. Evidência em `Prints/ocr-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/media-transcribe.test.ts
npx vitest run tests/ocr.test.ts
npx esbuild scripts/media-transcribe-live.ts --bundle --platform=node --format=cjs --outfile=.qa/media-transcribe-live.cjs
node .qa/media-transcribe-live.cjs
npx esbuild scripts/ocr-live.ts --bundle --platform=node --format=cjs --outfile=.qa/ocr-live.cjs
node .qa/ocr-live.cjs
npm run build
node scripts/ui-media-transcribe.cjs
```

### 16.12. Módulo 24 — imagens e recursos visuais

- [x] Inspeção de dimensões, formato, canais, transparência, cor e tamanho.
- [x] Edição local com recorte, resize/fit, rotação, flip/flop, grayscale,
  PNG/JPEG/WebP, qualidade e transparência.
- [x] Original nunca é sobrescrito por acidente; saída usa arquivo temporário e
  rename atômico.
- [x] Geração opcional por endpoint compatível com OpenAI `/images/generations`,
  com validação real do arquivo e limite de 50 MB.
- [x] Configuração por `OPENCLOD_IMAGE_BASE_URL`, `OPENCLOD_IMAGE_MODEL` e
  `OPENCLOD_IMAGE_API_KEY`; ausência de configuração gera erro explícito.
- [x] Ferramentas `image_inspect`, `image_edit` e `image_generate` integradas.
- [x] Ferramenta `image_ocr` integrada com caixas opcionais por palavra.
- [x] `sharp` atualizado para `0.35.5`; `npm audit --omit=dev` sem vulnerabilidades.
- [x] E2E Electron inspecionou imagem, converteu para WebP 50×50 e gerou PNG
  64×64 via provedor local controlado. Evidência em `Prints/images-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/images.test.ts
npm run typecheck
npm audit --omit=dev
npm run build
node scripts/ui-images.cjs
```

### 16.13. Módulo 18 — notificações e preferências

- [x] Centro de Atividades persistente já integrado ao Agent Core, subagentes,
  ferramentas, aprovações, terminal e configurações.
- [x] Notificações nativas do Windows para conclusão, falha, aviso e aprovação.
- [x] Categorias configuráveis e prioridade mínima.
- [x] Horário silencioso com suporte a intervalos que cruzam a meia-noite.
- [x] Popup apenas quando o app não está em primeiro plano; Atividades continua
  registrando todos os eventos.
- [x] Clique na notificação restaura e foca a janela.
- [x] Interface em Configurações → Aparência com quatro checkboxes, prioridade e
  início/fim do silêncio.
- [x] Verificado com `2/2` testes de regras e `2/2` de atividades; typecheck e build.
- [x] E2E do renderer confirmou 4 categorias, 2 horários e nenhum erro de console.
  Evidência em `Prints/notifications-2026-10-25/`.
- [ ] Canais externos opcionais (webhook/plugin) não foram habilitados por padrão;
  dados sensíveis nunca são enviados sem configuração explícita.

Verificação reproduzível:

```powershell
npx vitest run tests/notifications.test.ts tests/activity-store.test.ts
npm run build
node scripts/ui-notifications.cjs
```

### 16.14. Módulos 11 e 16 — plugins locais e scheduler avançado

#### Plugins locais

- [x] Manifesto `plugin.json` versionado com API 1.x, runtime Node, ferramentas,
  dependências, permissões e contribuições de skills.
- [x] Instalação por pasta, validação de caminho/entrypoint, atualização com
  backup e preservação da pasta `data/` do plugin.
- [x] Ativação/desativação, bloqueio de dependentes e remoção que preserva dados
  em `.data/<plugin>-<timestamp>`.
- [x] Ferramentas dinâmicas `plugin__<id>__<tool>` entram no Agent Core e passam
  pela política normal de risco/cancelamento/timeout.
- [x] Execução em subprocesso Node, inclusive no Electron por
  `ELECTRON_RUN_AS_NODE=1`; não há isolamento de privilégios além do processo.
- [x] Resolvedor de dependências, detecção de ciclos, incompatibilidade de API,
  IDs duplicados e diagnóstico.
- [x] Skills de plugins são adicionadas ao SkillLibrary ao ativar e removidas ao
  desativar.
- [x] UI em Personalização → Plugins para instalar, listar, ativar, desativar e
  remover plugins locais.
- [x] **5/5** testes do manager e **116/116** com runner/agentes; E2E do Electron
  executou `plugin__acme-tool__echo` em subprocesso e confirmou o cartão instalado.
  Evidência em `Prints/plugins-2026-10-25/`.
- [ ] Contribuições de comandos, hooks executáveis, provedores e páginas visuais
  de plugin ainda estão apenas declaradas ou fora do contrato de runtime.

#### Scheduler avançado

- [x] Prioridade alta/normal/baixa, concorrência limitada por passe, retry com
  espera configurável e histórico persistente de até 50 tentativas por tarefa.
- [x] UI permite configurar prioridade, retentativas e espera.
- [x] **87/87** testes do scheduler, incluindo ordem por prioridade e sucesso na
  terceira tentativa após duas falhas.
- [ ] Gatilhos por eventos internos, dependências entre múltiplas etapas e
  exportação/importação de definições continuam pendentes.

Verificação reproduzível:

```powershell
npx vitest run tests/plugins.test.ts tests/runner.test.ts tests/agents.test.ts
npx vitest run tests/scheduler.test.ts
npm run build
node scripts/ui-plugins.cjs
```

### 16.15. Módulo 20 — atualização e distribuição

- [x] Build Windows reproduzível continua usando Electron Builder + NSIS e preserva
  o perfil do usuário na desinstalação.
- [x] Verificação de atualização por manifesto versionado.
- [x] Manifesto exige HTTPS (HTTP permitido apenas em loopback para testes) e
  valida versão, plataforma, URL, tamanho e SHA-256.
- [x] Download do instalador é separado da execução; bytes, tamanho e hash são
  conferidos antes do rename atômico e o app não executa o pacote sozinho.
- [x] Configuração de feed e verificação automática opcional; o resultado aparece
  em Configurações → Sobre com notas, tamanho e hash.
- [x] **3/3** testes do updater e build Electron aprovados.
- [x] E2E confirmou detecção do manifesto 9.9.9, checksum e botão verificado sem
  erros. Evidência em `Prints/updater-2026-10-25/`.
- [ ] Não há feed público de produção configurado; instalação/rollback automáticos
  só podem ser validados quando o projeto tiver uma release server real.

Verificação reproduzível:

```powershell
npx vitest run tests/updater.test.ts
npm run build
node scripts/ui-updater.cjs
```

### 16.16. Módulo 28 — desempenho e recursos

- [x] Limites existentes preservados: itens de atividade, eventos, logs, saídas,
  arquivos de documento, segmentos e concorrência de ferramentas/tarefas.
- [x] Scheduler ganhou limite configurável de concorrência por passe.
- [x] Grafo de memória limita conexões semânticas a 12 por nó, mantendo todos os
  wikilinks explícitos e melhorando legibilidade.
- [x] Benchmark reproduzível com 1.000 páginas/200 tarefas/10.000 eventos e
  1,3 milhão de caracteres.
- [x] Grafo no benchmark: **499.500 → 6.071 arestas**, **943 → 314 ms**, heap
  observado **93 → 14 MB** no mesmo processo.
- [x] Chunking de 1,3 milhão de caracteres: 597 segmentos em 654 ms.
- [x] Scheduler: 200 tarefas registradas e executadas em 2,24 s no teste local.
- [x] Observabilidade: 10.000 eventos oferecidos, 1.000 retidos na consulta, 137 ms.
- [x] Benchmarks não alegam comparação com outro produto; são referências locais.
- [ ] Ganhos permanecem dependentes do hardware e do tamanho real do workspace.

Verificação reproduzível:

```powershell
npx vitest run tests/memory-graph.test.ts
npx esbuild scripts/benchmark-core.ts --bundle --platform=node --format=cjs --outfile=.qa/benchmark-core.cjs
node .qa/benchmark-core.cjs
```

### 16.17. Módulo 30 — integração final e auditoria

- [x] Suíte completa final: **51 arquivos, 801/801 testes aprovados** no Vitest 5.0.5.
- [x] Typecheck dos projetos Node e Web passou.
- [x] Build Electron final passou e gerou `out/` atualizado.
- [x] `npm audit`: **0 vulnerabilidades** em produção e desenvolvimento.
- [x] `zod` 4.6.7, `sharp` 0.35.5 e Vitest 5.0.5 eliminam os alertas conhecidos.
- [x] E2E cobertos nesta etapa: backup, diagnóstico, documentos, imagens/OCR,
  transcrição de áudio, memória com conflitos, notificações, plugins locais,
  leitura em voz alta, updater, slides e worktrees.
- [x] Ícone próprio do Openclod gerado em `build/icon.png` e usado pelo instalador;
  o build não usa mais o ícone padrão do Electron.
- [x] Instalador NSIS definitivo:
  `release/Openclod Desktop-0.1.0-setup.exe`, **840.915.527 bytes**, SHA-256
  `71A87483CC9585DD37567BC040673C50DFCEA3D090CFA6825AB9EE92DA3389DC`.
- [x] Voz neural empacotada: o runtime dentro de `win-unpacked` listou as três
  vozes pt-BR e sintetizou Francisca em um MP3 válido de 17.856 bytes.
- [x] Smoke do pacote real `release/win-unpacked` passou e abriu o renderer.
  Evidência em `Prints/packaged-smoke-2026-10-25.json` e `.png`.
- [x] Benchmark de memória aplicado: grafo de 1.000 páginas caiu de 499.500 para
  6.071 arestas, de 943 para 314 ms e heap observado de 93 para 14 MB.
- [ ] Feed público de produção para updater não existe; o mecanismo foi validado
  com manifesto local controlado.
- [ ] Extensões Chrome, WSL, SSH/Nuvem, OAuth/cliente e sessão do Claude Code
  dependem de confirmações, credenciais, destinos ou firmware externos.
- [ ] Runtime de plugins cobre ferramentas/skills locais; comandos/hooks
  executáveis e contribuições visuais de terceiros ainda são evolução futura.

Verificação final reproduzível:

```powershell
npm run typecheck
npx vitest run
npm audit
npm run dist
node scripts/smoke-packaged.cjs
```

### 16.6. Módulo 27 — observabilidade e diagnóstico

- [x] Serviço central de eventos correlacionados por sessão, turno e ferramenta.
- [x] Métricas persistentes de turnos, falhas, ferramentas, durações, aprovações,
  auditorias bloqueadas, tokens, cache e custo informado pelo provedor.
- [x] Retenção limitada a 4.000 eventos, arquivo de 5 MB e três arquivos rotacionados.
- [x] Logs do processo principal também entram no histórico estruturado sanitizado.
- [x] Verificações de saúde do núcleo, armazenamento, navegador, Computer Use,
  MCP e provedores.
- [x] Interface em Configurações → Diagnóstico com métricas, saúde, ferramentas,
  filtros por nível/tipo/texto e lista de eventos.
- [x] Pacote `.json.gz` sanitizado com versões, capacidades, resumo de configuração,
  métricas, eventos e trecho limitado do log; retorna tamanho e SHA-256.
- [x] Redaction verificada para chaves de API, `Bearer`, senhas, tokens, segredos e
  caminhos pessoais do Windows/Linux.
- [x] Verificado com `4/4` testes focados, typecheck estrito e build Electron.
- [x] E2E do renderer: 6 métricas, 6 componentes de saúde, 5 eventos e nenhum erro
  de console. Evidência em `Prints/diagnostics-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/observability.test.ts
npm run build
node scripts/ui-diagnostics.cjs
```

### 16.7. Módulo 21 — memória avançada, proveniência e conflitos

- [x] Compatibilidade com o formato Markdown anterior, sem migração destrutiva.
- [x] Tipos de memória: decisão, preferência, convenção, solução, pendência e fato.
- [x] Proveniência com origem, confiança (`observed`, `inferred`, `suggested`),
  evidências, contexto e data de atualização.
- [x] Estados `active`, `superseded` e `invalidated`; substituição e invalidação
  preservam corpo e histórico no Markdown.
- [x] Detecção determinística de possíveis conflitos entre memórias semânticas,
  exibida no briefing e na interface em vez de apagar silenciosamente.
- [x] Memórias substituídas/invalidadas saem do briefing e da busca ativa, mas
  continuam legíveis para auditoria.
- [x] Resumo consolidado do projeto com decisões, convenções, pendências e conflitos.
- [x] Ferramenta `memory_page` aceita metadados, substituição, invalidação e resumo.
- [x] UI da Memória mostra tipo, confiança, conflito, estado e ação de invalidar.
- [x] Espelhamento no AI-Memory inclui bloco de proveniência e evidências.
- [x] Verificado com `15/15` testes focados de memória e grafo, typecheck e build.
- [x] E2E do renderer: 3 decisões, 1 conflito e 1 página substituída sem erros.
  Evidência em `Prints/memory-provenance-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/memory-project.test.ts tests/memory-graph.test.ts
npm run build
node scripts/ui-memory-provenance.cjs
```

### 16.8. Módulo 19 — configuração portátil e segura

- [x] Exportação JSON versionada de provedores, permissões, limites, ambientes,
  MCP, hooks, navegador, voz e preferências.
- [x] Validação de tipo, versão, tamanho máximo e estrutura antes de aplicar.
- [x] Credenciais embutidas, headers, tokens, senhas e variáveis sensíveis são
  omitidos e registrados como avisos.
- [x] URLs e argumentos de ferramentas passam por redaction.
- [x] Importação preserva segredos locais equivalentes em servidores MCP, sem
  gravar tokens no arquivo portátil.
- [x] Configurações importadas passam pelo mesmo sanitizador, migração, cofre
  DPAPI, reinício de MCP e registro de atalho de voz do fluxo normal.
- [x] Interface em Configurações → Backup, com avisos e número de campos sensíveis
  preservados.
- [x] Verificado com `3/3` testes focados sobre bytes reais exportados, typecheck
  e build Electron.
- [x] E2E do renderer confirmou as duas novas pontes e cinco ações da tela sem
  erros. Evidência atualizada em `Prints/backup-2026-10-25/`.

Verificação reproduzível:

```powershell
npx vitest run tests/config-transfer.test.ts
npm run build
node scripts/ui-backup.cjs
```
