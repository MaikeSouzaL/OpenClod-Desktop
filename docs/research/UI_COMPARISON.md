# Claude Desktop × Openclod — comparação de interface (2026-10-23)

Base: 20 capturas de tela do Claude Desktop em `prints/` (fornecidas pelo
usuário; o Claude não consegue abrir a própria janela por design). Cada linha
diz o que a tela mostra, o que o Openclod tem agora e **como foi verificado**.
"Verificado" significa que o recurso foi exercitado no app real (Electron, com
`--remote-debugging-port` e um projeto de teste descartável) ou por teste
automatizado; "implementado, não exercitado" significa que o código existe,
compila e tem cobertura parcial, mas não foi acionado numa sessão real.

Capturas do Openclod geradas pelo roteiro `scripts/ui-panes.cjs`
(`tmp/ui-panes/*.png`, ignorado pelo git; rode o roteiro para regerar).

## Painel da sessão (barra de título: sessão · terminal · alterações · navegador · arquivos · ⋮)

| Tela (print) | Claude Desktop | Openclod | Verificação |
|---|---|---|---|
| Terminal (`copy 12`) | PowerShell, abas, ⋮, maximizar, fechar | **PTY real** (ConPTY via `@lydell/node-pty`) + xterm; abas, PowerShell/cmd/Git Bash, histórico restaurado ao remontar, processos encerrados em árvore ao fechar o app | `echo FORJA_TERM_OK` digitado no xterm apareceu na saída do shell (2×); `FORJA_TERM_$((6*7))` → `FORJA_TERM_42` |
| Alterações (`copy 13`) | Lista/árvore; estado vazio "precisam de um repositório Git" | `git status` v2 + diff por arquivo (preparado/não preparado/não rastreado), lista/árvore, filtro, ramo e ahead/behind; sem Git, mostra o que o agente alterou na sessão | repositório de teste: `M README.md +2 −1`, `U src/novo.ts`, diff com 13 linhas adicionadas renderizado; 55 testes do serviço Git |
| Navegador (`copy 14`) | Abas, voltar/avançar/recarregar, URL, detecção de servidor de dev, "Usar esta", `launch.json` | `<webview>` isolado (partição própria, sem preload, sem Node, permissões negadas), abas, DevTools, "abrir no navegador padrão"; detecta `package.json` (dev/start/serve/preview…) e `.claude/launch.json`; "Usar esta" roda num terminal da sessão, espera a URL/porta e grava `.forja/launch.json` | página local abriu (`título: Openclod preview OK`); servidor `npm run dev` do projeto de teste subiu e foi aberto (`Fixture dev server`, `http://localhost:5174/`); `launch.json` gravado; porta 5174 fechada ao final |
| Arquivos (`copy 15–17`) | Árvore, filtro/`?` busca, editor com abas, ⋮ de opções | árvore com pastas recolhíveis, `?termo` busca no conteúdo, **CodeMirror 6** (TS/JS/JSON/MD/CSS/HTML/Python), abas de visualização, Ctrl+S, salvar com checagem de alteração externa, autosave, Tab, quebra de linha, espaços em branco, rolar além do fim, tabulação 2/4/8, árvore à esquerda/direita, Ctrl+Shift+Y | editor abriu `README.md` (5 linhas); digitei no CodeMirror, Ctrl+S, o arquivo **mudou no disco** e o status virou "Salvo"; menu de opções renderizado. Autosave: **implementado, não exercitado** |
| Layout do painel (`copy 18`) | Mover, preencher, nova janela | maximizar/restaurar, esquerda/direita, largura arrastável (lembrada) | maximizar ocultou o chat (`workspace` com `display:none`) e restaurou. "Preencher e organizar" e "nova janela": **não implementados** |
| ⋮ superior (`copy 19`) | Chat lateral, tarefas em segundo plano, manter computador ativo | **Tarefas em segundo plano** (lista processos do agente, lê saída, encerra), **Manter computador ativo** (`powerSaveBlocker`), atalhos para os painéis | diálogo de tarefas abriu; "Manter computador ativo": `keepAwake(true)` → estado `true` → `keepAwake(false)` → `false`. Encerrar um processo do agente: **não exercitado**. **Chat lateral: não implementado** |
| Painel da sessão (`copy 11`) | Ambiente, Contexto detalhado, Conectores, Saídas | já existia (Sessão/Contexto/Conectores/Saídas/Proteções); "Remote Control" e "Salvar ambiente" **não existem** | — |

## Páginas da barra lateral

| Tela | Openclod | Verificação |
|---|---|---|
| Projetos (`copy`) | cartões com caminho, nº de sessões e última atividade; pesquisa; ordenar por atividade/nome; novo projeto; menu (nova sessão, abrir no Explorer, remover) | 2 cartões renderizados |
| Tarefas agendadas (`copy 3–5`) | **Agendador real** no processo principal (a cada hora, diário, dias úteis, semanal, uma vez; execução perdida roda uma vez ao abrir; sem sobreposição), persistido em `schedules.json`; "Nova tarefa" → manual ou 6 modelos para desenvolvedores; ordenar por próxima execução/nome; executar agora/editar/pausar/apagar | criei a tarefa a partir de um modelo (`weekdays 09:00`, próxima `seg 26/10 09:00`) e usei "executar agora": estado `ok`, sessão "Agendada: …" criada e listada na barra lateral; 85 testes do agendador com relógio injetado. **A sessão rodou com o provedor Scripted** (não há modelo real nesta máquina) |
| Personalização (`copy 8`) | abas Skills / Conectores / Hooks; criar skill (grava `SKILL.md`), abrir a pasta, filtro por origem; conectores nativos e MCP com estado e reconexão; **preset do REA** (detectado nesta máquina); hooks configurados | 2 skills listadas; abas renderizadas; criar skill pelo IPC gravou `SKILL.md` e a listou (removida depois). O formulário "Adicionar" e o botão do preset do REA: **não clicados** |
| Rodapé do compositor (`image`, `copy 10`) | "Ignorar permissões", modelo + esforço | seletor de **esforço** (Automático, Baixo, Médio, Alto, Extra, Máximo — só os níveis que o modelo aceita) e troca rápida do **modo de permissão** | permissão: troquei `auto` → `ask` pelo menu, a configuração mudou e foi restaurada (idêntica ao backup). Esforço: com o modelo de teste o menu diz "Este modelo não expõe esforço de raciocínio"; os níveis por modelo e o corpo das requisições são cobertos por 19 testes (Anthropic e OpenAI), **não clicados com um modelo que suporte** |

## Fora de escopo (são serviços de nuvem da Anthropic, não do app)

Artefatos, Design, Dispatch, o banner de uso/limites, Remote Control, Chat vs
Cowork em VM do Claude. O Openclod tem a aba Cowork, mas ela usa o mesmo harness
local, sem VM (ver `GAP_ANALYSIS.md` §8). Não foram simulados com telas
vazias: **o Openclod não finge ter esses recursos**.

## Defeitos encontrados nesta rodada (e corrigidos)

1. **Escape fechava o painel inteiro** ao fechar um menu — agora só fecha o menu.
2. **Editor quebrava ao abrir um arquivo** (`Duplicate use of compartment`) —
   o mesmo compartimento do CodeMirror entrava duas vezes. Corrigido; uma
   `ErrorBoundary` agora impede que uma falha de painel apague a janela.
3. **Menu ⋮ do terminal e do painel ficava fora do lugar** (a classe
   `.menu-anchor` é fixa na barra de título) — usa um âncora relativa.
4. Ferramentas **MCP nunca chegavam ao modelo**: eram registradas, mas
   `availableTools()` só devolvia nomes fixos por modo. Agora entram nos modos
   código, depurar, autônomo, web e computador (nunca nos somente-leitura).
5. PID do terminal aparecia 0 (ConPTY só informa depois de conectar).

## Limitações conhecidas

- O terminal da UI é o shell do **usuário** (como o terminal de uma IDE): não
  passa pelas aprovações do agente. O agente continua usando `run_command`.
- `<webview>` carrega páginas arbitrárias http(s) numa partição isolada;
  conteúdo da página é dado, nunca instrução para o agente (o agente usa o
  navegador Playwright próprio para automação, não esta aba).
- Empacotamento: `asarUnpack` para `@lydell/**` e `*.node` foi configurado, mas
  **o instalador não foi gerado/testado** (`npm run dist`) nesta rodada.

## Segundo print: o agente trabalhando (rodada 2026-10-23, noite)

Referência: tela do Claude Desktop durante uma tarefa longa — resumos como
"Executou 3 comandos, finalizou 2 comandos em segundo plano", cartões de edição
com diff verde/vermelho, a lista de plano presa acima do compositor, o ponto de
"trabalhando" na barra lateral e o painel **Tarefas em segundo plano** à direita
(comandos com tempo e saída, agentes com modelo e contagem de tarefas,
"Concluído N" recolhido, "Falhou" em vermelho).

Verificado com `scripts/ui-work.cjs`: abre o Electron com um **perfil
descartável** e um projeto descartável, usa **ferramentas reais**
(`run_command`, `start_process`, `write_file`, `edit_file`, `update_plan`) e
turnos de modelo roteirizados (`FORJA_MOCK_SCRIPT`, gancho só para testes) — não
há modelo real. Resultados do roteiro:

| O que | Resultado |
|---|---|
| Plano acima do compositor durante o turno | `0/3 Plano`, item ativo em destaque; vira `2/3` com os dois primeiros concluídos |
| Ponto "trabalhando" na sessão da barra lateral | 1 durante o turno, 0 depois |
| Resumo das ferramentas (ao vivo e depois) | "Executando 2 comandos e lendo 1 arquivo…" → "Executou 2 comandos e leu 1 arquivo"; "Executou 1 comando · 1 falha"; `update_plan` fica fora do resumo (o card do plano já mostra) |
| Cartões de edição | `util.ts +1 −0` e `README.md +1 −1`, com as linhas certas; os arquivos no disco conferem |
| Painel Tarefas em segundo plano | serviço iniciado com `start_process` aparece **em execução** com a saída ao vivo (`tick…`), "Concluído 2" com "Falhou" no comando que saiu com código 3; o botão ■ do painel **encerrou o processo** |
| Mensagem de erro | centralizada sobre a coluna do chat: centro da barra = centro do compositor (900 px sem painel; 600 px com o painel aberto). Antes seguia o centro da janela (720 px) |

Defeitos achados pelo roteiro e corrigidos: o resumo contava `update_plan`
("Usou 1 ferramenta"); um serviço em segundo plano aparecia como "concluído"
assim que a chamada voltava (o shell devolve `exitCode: null` enquanto vive);
maiúscula no meio da frase do resumo.

Ainda não verificado nesta etapa: agentes aparecendo no painel com modelo e
"N tarefas" (depende dos eventos do sistema de agentes — ver abaixo), e o
ponto "trabalhando" para sessões que não estão na tela.

## Captura ao vivo do Claude Desktop (rodada 2026-10-23, fim da noite)

Referência: janela principal real, 1440 × 900, aberta pelo pacote MSIX
(`shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude`; o `.exe` direto é negado pelo
Windows). A árvore de acessibilidade expõe apenas os três botões da barra de
título — o conteúdo é renderizado sem UIA —, então a comparação é visual e não
por automação de elementos. A captura fica fora do repositório, em
`%TEMP%\opencode\claude-main.png`, para não versionar conversas privadas.

O que a tela mostra, e o estado do Openclod depois desta rodada:

| Elemento do Claude Desktop | Observação na captura | Openclod agora |
|---|---|---|
| Barra lateral estreita com "Novo chat" no topo | ícone quadrado, rótulo curto, lista de conversas abaixo | mesma estrutura; "Novo chat" e busca de sessões |
| Abas no topo (`Chat`, `Cowork`, `Code`) | três abas, a ativa com sublinhado; `Code` abre o ambiente de projeto | `Home` (chat sem projeto), `Cowork` e `Code`; `Home` não exige pasta |
| Compositor central com modelo e esforço no rodapé | linha discreta, seletor de modelo à direita | seletor de modelo com busca, esforço por modelo, microfone e anel de contexto |
| Anel/medidor de contexto | sem número visível | anel clicável; no hover mostra `% usado`, tokens usados e livres |
| Aviso de limite de uso | faixa fina acima do compositor quando a cota aperta | troca automática de modelo (fallback) com aviso na conversa, preservando contexto e memória |
| Grade de provedores nas configurações | não é a mesma tela; o Claude usa só a conta Anthropic | grade de ícones com 9 provedores; clique abre credenciais e detalhes com botão voltar |
| Tema claro/escuro e tipografia | fundo quente, serifada nos títulos, sans no corpo | mesma direção: fundo quente, `Source Serif` nos títulos, `Inter` no corpo |

Decisões que vieram da comparação:

1. **Home sem projeto**: o aviso "Abra uma pasta de projeto" ficou restrito ao
   `Code`. No `Home`, o Openclod cria `%APPDATA%\Openclod\workspace` na primeira
   mensagem e responde normalmente.
2. **Contexto visível sem poluir**: o número só aparece no hover; em repouso
   fica o anel, como no Claude.
3. **Fallback explícito**: quando o modelo escolhido esgota cota ou fica
   indisponível, o Openclod avisa qual modelo assumiu em vez de mostrar uma faixa
   de limite sem saída.
4. **Modelo lembrado**: a escolha sobrevive ao reinício (`lastModel` em
   `settings.json`), algo que a captura não permite verificar no Claude.

Cobertura desta rodada: `tests/browser-tabs.test.ts` (6 testes de abas) e
`tests/runner.test.ts` (4 testes de fallback: cota, `bad_request`, resposta
parcial e cadeia esgotada). Total: **675 testes**, `typecheck` limpo.
