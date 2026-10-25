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
- [x] Computer Use real no Windows: matriz do Bloco de Notas com 35 sucessos,
  5 limitações esperadas do backend e 0 falhas inesperadas.
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
  `OPENCODE_PERMISSION`, preservando compatibilidade com a versão instalada.
- [x] Validar o executor com teste focado: **39/39 aprovados**.
- [x] Validar TypeScript estrito em `tsconfig.node.json` e `tsconfig.web.json`.
- [ ] Teste ponta a ponta com o binário OpenCode real e um provedor configurado.
  O CLI `1.2.10` foi encontrado, mas ainda falha antes de iniciar a sessão por
  uma chave `shell` legada no arquivo global do usuário. Esse bloqueio será
  tratado numa tarefa isolada, com backup da configuração.

### 16.3. Próximas tarefas obrigatórias

- [ ] Corrigir a configuração legada do OpenCode sem perder chaves/provedores e
  executar uma resposta real pelo caminho `external_agent`.
- [ ] Fechar o inventário dos repositórios: URL, commit, licença, linguagens,
  dependências e trechos candidatos a reutilização.
- [ ] Integrar o seletor real de ambiente Local/Nuvem/SSH/WSL, respeitando a
  limitação de virtualização desta máquina quando aplicável.
- [ ] Evoluir o editor rico de artefatos para edição visual de slides e designs,
  sem remover o editor de texto atual.
- [ ] Completar MCP: recursos, prompts, instruções, reconexão/status, catálogo e
  aprovação visível; registrar a limitação real de OAuth sem DCR.
- [ ] Integrar worktrees ao fluxo de criação de sessão e à interface.
- [ ] Adicionar checkpoints/rewind, chats laterais, comentários em diffs e
  visualização dividida quando compatíveis com a arquitetura atual.
- [ ] Ampliar a matriz de Computer Use para todos os aplicativos, janelas,
  navegadores, entrada, teclado, tela, acessibilidade e operações de arquivos.
- [ ] Executar a suíte completa, build, teste empacotado e smoke test do
  instalador; registrar evidências e limitações externas no final.

### 16.4. Evidência reproduzível desta etapa

```powershell
npm run typecheck
npx vitest run tests/external-agent.test.ts
```

Resultado observado: typecheck sem erros; 39 testes aprovados.
