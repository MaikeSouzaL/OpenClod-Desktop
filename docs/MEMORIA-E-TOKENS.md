# Memória em grafo e economia de tokens

O pedido: a memória deve funcionar como um **índice em grafo** ("sinapses": cada página ligada a outras). Qualquer LLM, inclusive uma
que entra depois que outra acabou os tokens, deve **continuar o trabalho buscando o contexto na memória**, sem o usuário passar tudo de
novo; o harness faz essa busca sozinho; MCPs, skills e agentes só entram no contexto quando necessário; e tudo isso tem que
**economizar o máximo de tokens**. Este documento diz o que foi medido, o que estava errado, o que mudou e o que ainda não foi feito.

Todos os números abaixo vêm de execuções reais (sessões do próprio usuário e scripts com modelo real). Os arquivos de medição estão em
[`docs/medicoes/`](medicoes/).

## 1. O que estava acontecendo (medido antes de mexer)

**Nas sessões reais do usuário** (4 sessões com uso gravado, 412 chamadas ao modelo):

| | |
|---|---|
| Entrada média por chamada | 98 839 tokens |
| 1ª chamada de uma sessão nova ("ola" / "oi") | 8 891 e 12 203 tokens |
| Fração vinda do cache do provedor, 1ª chamada de cada turno | **2%** (81 815 tokens sem cache em média) |
| Fração vinda do cache, chamada logo depois de `update_plan` | **9%** (105 118 sem cache) |
| Fração vinda do cache, as demais chamadas | 92% |

Essas 8,7% das chamadas (a primeira de cada turno e a seguinte a um `update_plan`) concentram **50% de todos os tokens sem cache**,
que são os caros. O total do DeepSeek no `provider-usage.json` do usuário: 989 chamadas, 237 milhões de tokens de entrada, 91% em cache,
US$ 6,54.

**Causa:** o prompt do sistema carregava o plano, o briefing da wiki (que muda a cada turno, porque cada turno grava uma nota nova), o
recall do AI-Memory (que depende do pedido) e a lista de servidores MCP. Os provedores guardam em cache o **prefixo** do prompt: quando
o começo muda, o histórico inteiro que vem depois é cobrado de novo a preço cheio. Havia até um `refreshMemory()` no meio do turno,
depois de ferramentas de memória.

**Reprodução controlada** (build congelado, projeto com 8 arquivos, 3 turnos, DeepSeek real,
[`tokens-baseline.json`](medicoes/tokens-baseline.json)): a 1ª chamada do turno 2 teve 53 552 tokens de entrada e **só 2 560 (5%) em
cache**; a do turno 3, 59 614 e 2 816 (5%); as 5 chamadas após `update_plan`, 2%. Dos 436 mil tokens sem cache da conversa, **90% vieram
dessas chamadas**.

**A memória em si**, no maior projeto real (73 páginas): 24 eram "Índice: <palavra>" gerados de palavras como *abre*, *falta*, *afzer*
(um erro de digitação do usuário virou um nó do grafo); 3 eram páginas duráveis; 43 eram logs de turno; **nenhum link entre páginas
duráveis**. A busca do índice para "como conectei o Jira no harness" devolvia dois hubs primeiro e deixava de fora, dos 8 primeiros
resultados, a única página que responde; "ola" recuperava 7 páginas sem relação.

**Outros achados:** o painel *Contexto* mostrava números fixos (sistema 1 100, skills 320), não reais; `memory_page read` só abria slugs
nativos (o que `memory_recall` achava só no índice não dava para abrir); a passagem de bastão (`memory_handoff`) era manual, e a troca de
modelo (ou o fallback por cota) reenviava o histórico inteiro ao modelo novo.

## 2. O que mudou

1. **Prompt do sistema estável + contexto do turno** (`src/core/agent/context.ts`, `turn-context.ts`). O prompt do sistema não tem mais
   nada que mude durante a sessão. O que varia (plano, memória que casa com o pedido, sugestões, servidores MCP, mapa da memória) vai
   numa **mensagem oculta** logo depois da mensagem do usuário, que o provedor passa a guardar em cache a partir da chamada seguinte.
   Só entra o que mudou (o plano que o próprio modelo escreveu não se repete; páginas já enviadas não se repetem) e um pedido que não
   precisa de nada ("ola") não ganha nada. Depois de uma compactação a mensagem do turno volta.
2. **Pacote de memória, a busca automática** (`src/core/memory/pack.ts`). Páginas ranqueadas pelo que *são* (decisão, solução,
   convenção > sessão > log de turno; hub automático nunca), pela cobertura do pedido (com radical das palavras: *conectei* casa com
   *conectado*) e pela recência; os três melhores puxam seus vizinhos duráveis por **links e backlinks** (as sinapses); no máximo 2 logs
   de turno quando há páginas duráveis; orçamento de ~3 200 caracteres; página antiga vem marcada "confira".
3. **Higiene e grafo de verdade** (`project.ts`). Hubs só para assunto que alguma página durável carrega; os antigos vão para
   `wiki/.archive` (nada é apagado). `memory_page write` liga a página nova às duráveis relacionadas (`## Relacionados`).
   `memory_recall`, `memory_page search` e `memory_search` usam o mesmo ranking, mostram links/backlinks, e `memory_page read` abre
   também o que só existe no índice.
4. **Cápsula de continuidade** (`state-page.ts`, gravada depois de cada turno). Uma página por sessão com situação, objetivo, último
   pedido e resultado, plano, **próximo passo** e arquivos. Uma sessão nova no mesmo projeto recebe a cápsula do trabalho em aberto (ou
   a da última sessão concluída) no contexto do turno. Quando **outro modelo assume uma conversa longa** (troca de modelo ou fallback
   por cota) o runner resume o histórico antes da primeira chamada: o modelo novo parte do resumo e da memória.
5. **Skills, agentes e ferramentas sob demanda** (`suggest.ts`). Em vez de catálogo no prompt, o harness sugere, uma vez e só quando o
   pedido casa (palavra do nome, ou a maior parte da descrição; verbos em português casam com nomes em inglês: *busque* → `search`),
   as skills, agentes e ferramentas adiadas (inclusive MCP) que servem. `list_skills` e `list_agents` aceitam `query` e devolvem só os
   melhores. O índice de skills no prompt encolheu (150 caracteres por linha, teto de 3 200).
6. **Medidor de contexto com números reais** (`runner.contextBreakdown()` → painel *Contexto*): sistema, instruções do projeto, skills,
   schemas de ferramentas e de MCP, memória/contexto do turno, resumo, mensagens, resultados e chamadas de ferramentas.

## 3. Resultados depois

### 3.1 Cache e tokens (mesma conversa de 3 turnos, DeepSeek real, build antigo × novo)

Mesmo script e mesmos prompts nos dois builds ([`tokens-baseline.json`](medicoes/tokens-baseline.json) e
[`tokens-new.json`](medicoes/tokens-new.json); `scripts/ui-token-economy.cjs`). O turno 1 lê 8 arquivos, o 2 monta um plano de 3 passos
com `update_plan` e o executa, o 3 é uma pergunta curta.

| | build antigo | build novo |
|---|---:|---:|
| 1ª chamada de uma sessão nova ("ola") | 9 959 tokens | 10 031 tokens (+0,7%) |
| fração em cache na 1ª chamada de cada turno | **6%** (41 253 sem cache em média) | **99%** (340 sem cache) |
| fração em cache na chamada seguinte a `update_plan` | **1%** (60 561 sem cache) | **100%** (201 sem cache) |
| tokens sem cache, turno 2 (plano) | 176 642 | 1 291 |
| tokens sem cache, turno 3 (pergunta curta) | 60 533 | 246 |
| tokens sem cache, conversa inteira | 291 324 em 19 chamadas | 47 993 em 21 chamadas |
| sem cache por chamada, em média | 15 333 | 2 285 (**−85%**) |
| fração em cache da conversa | 61% | 94% |

O que sobra sem cache no build novo é o que é novo de verdade: os ~46 mil tokens dos arquivos lidos no turno 1. A 1ª chamada do turno 1
já vem 95% do cache porque o prompt do sistema agora é o mesmo de uma sessão para outra (a sessão "ola" rodou antes e deixou o prefixo).
O piso de uma sessão nova ficou onde estava (+0,7%): as instruções novas e o parâmetro `query` de `list_skills`/`list_agents`
custaram o que o encurtamento das descrições das ferramentas de memória e do índice de skills devolveu.

### 3.2 A memória do maior projeto real (cópia; nada foi alterado no original)

| | antes | depois |
|---|---:|---:|
| páginas da wiki | 73 | 54 (19 hubs de palavras soltas arquivados) |
| hubs que sobram | 24 | 5 (`config`, `atlassian`, `mcp`, `jira`, `backlog`) |
| o que entrava no prompt a cada turno | briefing de até 7 000 caracteres + recall de até 7 000, mudando a cada turno | 133 tokens de mapa no 1º turno + ~550 tokens de páginas **só** quando o pedido tem assunto |
| "como conectei o Jira no harness" | a página que responde fora dos 8 primeiros do índice | 1ª colocada (4,37 contra 1,8 do melhor log de turno) |
| "o que falta fazer no backlog CNC" | 3ª, atrás de dois hubs | 1ª (7,04) |
| "ola", "tente novamente" | 7 páginas sem relação | nada (0 tokens) |

### 3.3 Passagem de bastão entre dois modelos (`scripts/ui-handoff.cjs`, DeepSeek real)

O cenário: a **sessão A** (`deepseek-flash`) recebe seis decisões de uma pequena biblioteca (separador `;`, linhas em CRLF, dinheiro com
vírgula e duas casas, nomes das funções, mensagem exata de um erro, rodapé `# total;…`) e a ordem "faça só os passos 1 e 2 e pare" (um
modelo que ficou sem tokens). Depois entra a **sessão B**, uma sessão **nova** no mesmo projeto, com **outro modelo**
(`deepseek-v4-pro`, o único outro para o qual há chave neste computador) e uma única frase: "Continue de onde paramos." Testes ocultos,
que só passam se as decisões foram respeitadas, rodam no código no fim (4 testes: passo 1, passo 2 e dois do passo 3). O **controle**
é a mesma pasta de código, o mesmo modelo e a mesma frase, num projeto que não tem a memória de A.

| cenário | build | testes ocultos | chamadas de B | tokens de entrada de B | ferramentas de memória que B usou |
|---|---|---:|---:|---:|---:|
| A grava páginas de memória por conta própria | antigo (2 execuções) | 4/4 · 4/4 | 15 · 8 | 301 042 · 133 393 | 5 · 5 |
| idem | novo (2 execuções) | 4/4 · 4/4 | 6 · 14 | 118 651 · 244 342 | 5 · 6 |
| A é proibido de usar `memory_*` (só o que o app grava sozinho) | antigo | 4/4 | 8 | 153 248 | 1 |
| idem | novo | 4/4 | 7 | 119 686 | **0** |
| idem, **mais 8 sessões de outros assuntos** entre A e B | antigo | 4/4 | 10 | 232 587 | 4 |
| idem | novo | 4/4 | **5** | **100 059** | **0** |
| **controle: sem a memória de A** | — | **2/4** (só o que A fez) | 18 | 293 867 | — (**perguntou ao usuário** o que fazer) |

O que isso mostra, sem exagero:

- **A memória é o que faz a continuação funcionar.** Sem ela, o segundo modelo não tem como saber o separador, o CRLF, o formato do
  dinheiro nem o rodapé: ele pergunta ao usuário (que aqui responde "não vou repassar o contexto") e entrega só o que já existia.
- **Os dois builds conseguiram continuar em todas as execuções.** O modelo B do build antigo achou o que precisava procurando por
  conta própria (`memory_brief`, `memory_recall`, `memory_page`): com um projeto pequeno e um modelo diligente isso basta. Por isso
  não há uma diferença de sucesso a mostrar, e a comparação do primeiro cenário (modelo A diligente) é ruidosa (6 a 15 chamadas
  nas duas versões).
- **No build novo a continuação não depende de o modelo procurar.** Nos dois cenários em que A não grava memória nenhuma, B recebeu
  a cápsula (objetivo com as seis decisões, plano, próximo passo) já na primeira mensagem e terminou **sem chamar nenhuma ferramenta de
  memória**; no cenário com 8 sessões no meio usou 5 chamadas e 100 mil tokens, contra 10 chamadas e 233 mil no build antigo.
  Cada cenário foi rodado uma vez em cada build (exceto o primeiro, duas vezes): é um indício consistente, não uma estatística.

### 3.4 Skills, agentes e ferramentas sugeridos (catálogo real: 7 skills, 107 agentes)

Dez pedidos típicos contra o catálogo real do usuário. "ola" e "continue de onde paramos" não sugerem nada. "crie um ícone SVG…" →
`svg-master`, `svg-designer`, `svg-verifier`; "revise o código… vulnerabilidades de segurança" → `security-auditor`, `code-reviewer`;
"rode os testes e corrija o que falhar" → `debugger`, `test-automator`; "QA total do login" → `qa-total`; "consulta SQL lenta no
Postgres" → `sql-pro`; "animação CSS" → `animation-master`. Dois pedidos ("explore o projeto…", "escreva um README…") não receberam
sugestão (falso negativo; o modelo ainda tem `list_agents query`); nenhum recebeu sugestão sem relação.

### 3.5 O painel Contexto (`scripts/ui-context-meter.cjs`, app real, 12 checagens)

Antes do primeiro turno o painel mostra a estimativa antiga e diz que é estimativa. Depois de um turno mostra o medido: sistema
2 948, instruções do projeto 453, skills 250, schemas de ferramentas 6 075 (total 10 305, contra 11 055 que o provedor cobrou na
última chamada: 7% de diferença). O painel antigo mostrava 1 100 para o sistema, 320 para skills e não mostrava as ferramentas.

### 3.6 O piso de uma sessão nova: nove ferramentas saíram da lista essencial (`scripts/ui-floor.cjs`, `scripts/ui-deferred-tools.cjs`)

**O que mudou.** A lista que vai em toda chamada de toda sessão (`CORE_TOOL_NAMES`) caiu de 31 para 22 ferramentas. Saíram as pouco
usadas que já têm substituto: `memory_brief` e `memory_search` (o harness põe o mapa e as páginas que casam no contexto do turno),
`memory_handoff` (o app grava a cápsula de continuidade), `list_skills` (índice no prompt e sugestões), `mcp_servers`, `mcp_catalog` e
`mcp_call` (as ferramentas MCP são de primeira classe; estas são diagnóstico e reserva) e `list_agents` e `task` (só no modo equipe ou
para um agente que pode chamar outros). Nas 509 chamadas de 5 sessões reais, `memory_brief`, `memory_search`, `memory_handoff` e
`list_skills` não apareceram nenhuma vez e `list_agents`/`task` uma vez cada; `mcp_call`, `mcp_catalog` e `mcp_servers` somaram 84, 65
delas numa sessão de 26/10 em que o agente tentava usar o Jira só por `mcp_call`, antes das ferramentas MCP de primeira classe (as
outras 19 estão numa sessão que atravessa a mudança, sem como separar). `report_limitation`, `ask_user` e `agent` ficaram (o primeiro
precisa funcionar quando a descoberta é o que falhou).

Como o modelo as alcança, em ordem de quem faz o trabalho:

1. **O harness, pelas palavras do usuário.** Se o pedido diz "catálogo de skills", "agentes", "handoff" ou "passagem de bastão",
   "servidores" (os mesmos apelidos de busca) ou cita o nome da ferramenta, ela já entra na lista de ferramentas na primeira chamada do
   turno. Só vale o texto do próprio usuário (não um resultado de ferramenta nem uma mensagem oculta), as checagens de modo e de
   permissão continuam valendo, e a palavra `task` sozinha não carrega o `task`. Isso existe porque um modelo pequeno não procura uma
   ferramenta que não vê (abaixo) e porque o modelo forte gasta uma chamada de `tool_load` a menos.
2. **O modelo, pelo nome.** Chamar `list_skills`, `memory_handoff` etc. direto já carrega e executa. A recusa da chamada direta era o
   desenho anterior e saiu caro com o Gemma: recusado em `memory_handoff`, gravou uma página em vez de carregar a ferramenta, e levou 6
   chamadas (um desvio por `tool_list` e `grep`) para chegar em `mcp_servers`.
3. **O modelo, por `tool_search` e `tool_load`**, que também entendem os apelidos.

Depois de carregadas ficam até o fim da sessão: a lista de ferramentas é o começo do prompt que o provedor guarda em cache, então uma
lista que encolhe a cada turno quebra o cache de novo a cada vez. Um agente que pode chamar outros continua recebendo
`list_agents`/`task` na lista, e um especialista cuja definição cita `memory_search` ou `list_skills` continua podendo carregá-los (o pool
dele vem do chamador).

**Onde foram feitas as medições.** O saldo do DeepSeek acabou (HTTP 402) e a nuvem gratuita do Ollama bateu no limite mensal. Os
modelos gratuitos do OpenRouter, que o Ollama local repassa, estão no limite diário (`free-models-per-day`; 1 000 por dia só com US$ 10
de crédito) e o app não tem chave própria do OpenRouter: quando o usuário disse que tinha posto a chave ou o crédito, o cofre do app
(`secrets.bin`) seguia como das 08:00, não havia `OPENROUTER_API_KEY` e os 20 modelos `openrouter/*` do Ollama continuavam recusando.
Responderam os modelos que o Ollama local serve: o **DeepSeek V4.1 flash** (a mesma família das medições anteriores), o **Qwen 3.8
flash** e o **Beam** (gratuito) pelo OpenCode Go, e o **Qwen 3.5 4B** rodando no próprio computador, gratuito e fraco (aceitou o prompt
inteiro, 11,7 mil tokens num teste). A reserva automática entre provedores (recurso novo de outra frente) trocava de modelo em silêncio
quando um falhava: um "piso" saiu de um Qwen 4B local. Por isso os scripts agora desligam a reserva no perfil de teste e conferem que a
sessão **terminou no modelo pedido**; também trocam a porta de depuração quando a pedida está ocupada (uma execução se conectou ao app de
outra sessão), registram como resultado um cenário que o modelo não termina (`--timeout`) e recusam gravar uma execução vazia.

**Comparação limpa: a mesma árvore de código, só a lista essencial muda.** O build "antes" é uma cópia da árvore atual com a lista de
31 ferramentas e as frases do prompt anteriores restauradas; o "depois" é a árvore como está. DeepSeek V4.1 flash, primeira chamada de
uma sessão nova que só diz "ola", contada pelo provedor:

| | antes (31) | depois (22) | diferença |
|---|---:|---:|---:|
| amostra 1 | 9 398 | **8 273** | −1 125 (−12,0%) |
| amostra 2 (inclui ~350 tokens da cápsula da amostra 1) | 9 750 | **8 627** | −1 123 (−11,5%) |
| a sessão "ola" que abre a conversa de 3 turnos | 8 881 | **7 723** | −1 158 (−13,0%) |
| schemas das ferramentas, estimativa do app | 6 075 | 4 548 | −1 527 |
| prompt do sistema + instruções do projeto, estimativa do app | 3 511 | 3 637 | +126 (as frases novas) |

As seis medições do piso (três rodadas) deram o mesmo −1,1 mil tokens por chamada. Com o DeepSeek pela API (antes de o saldo acabar, no
primeiro build novo) foi 10 553 → 8 974 (−15%): o tokenizador muda o tamanho do ganho, não o sentido. As frases novas custam 126 tokens
estimados, a maior parte na que diz que as nove se chamam direto e na do handoff; dá para encurtá-las em uns 60.

**O que custa quando o pedido precisa de uma delas** (4 sessões novas, uma por ferramenta, mesmos pedidos em cada build; chamadas ·
tokens de entrada somados):

| modelo | antes (31 ferramentas) | depois, **sem** a pré-carga | depois, **com** a pré-carga |
|---|---|---|---|
| DeepSeek V4.1 flash | 9 · 90 106, 4/4 | 14 · 123 609 (+37%), 4/4 | **9 · 80 487 (−10,7%), 4/4** |
| Qwen 3.8 flash | 9 · 73 478, 4/4 | 13 · 95 355 (+30%), 4/4 | **9 · 66 395 (−9,6%), 4/4** |
| Beam (gratuito) | 8 · 62 483, 4/4 | 10 · 70 136 (+12%), 4/4 | **8 · 56 841 (−9,0%), 4/4** |
| Qwen 3.5 4B (local, gratuito, fraco) | 9 · 83 709, 4/4 | 11 · 97 021, **2/4**; depois 9 · 81 464, **2/4** | **8 · 65 678 (−21,5%), 4/4** |

"4/4" é a ferramenta certa usada com sucesso nos quatro cenários (estado dos servidores MCP, handoff, busca no catálogo de skills,
busca no catálogo de agentes). Com a pré-carga os 16 cenários foram por chamada direta, sem `tool_search` nem `tool_load`, e custaram o
mesmo número de chamadas do build antigo (o 4B, uma a menos) com o piso menor.

Sem a pré-carga, cada uso custou de 1 a 3 chamadas a mais (o `tool_load` e, quando o modelo não sabia o nome, uma busca), e o modelo foi
por `tool_load` ou `tool_search` em 8 de 12 casos em que uma chamada direta bastava. **O modelo pequeno falhou em metade**: perdeu-se
em `tool_list` e respondeu "nenhum agente" quando o catálogo tem o `security-auditor`; noutra rodada inventou a ferramenta
`mcp__memoryhandoff__register` e travou 305 s; gravou uma lista de skills tirada do índice do prompt em vez de consultar o catálogo.
Uma segunda tentativa, só com uma linha na mensagem do turno ("ferramenta list_skills … chame direto, pelo nome"), não resolveu: o 4B
errou outros dois cenários de quatro, e ela foi tirada. O que resolveu foi pôr a ferramenta na lista.

Os pedidos dos cenários usam as palavras que uma pessoa usa ("catálogo de skills", "handoff"), de propósito. **Sem essas palavras** o
modelo tem de achar a ferramenta sozinho, e valem os números da coluna do meio: 1 a 3 chamadas a mais e, num modelo pequeno, falha
em metade. A conta por sessão nesse caso: o piso menor poupa ~1,1 mil tokens de entrada em cada chamada; um uso custa ~1 a 3
chamadas a mais (6 a 12 mil), então uma sessão que usa uma delas passa a compensar a partir de umas **5 a 11 chamadas**; as 5 sessões
reais tinham, em média, cem.

**A ressalva do preço.** Isso conta tokens enviados (janela e provedores sem cache de prefixo: Ollama local, vários compatíveis com a API
da OpenAI). Num provedor com cache, como o DeepSeek, o piso poupado custa 10% a partir da 2ª chamada (~110 tokens por chamada), e uma
mudança na lista de ferramentas no meio da conversa, ou na primeira chamada de um turno (a pré-carga), refaz o prompt inteiro uma vez a
preço cheio (na 1ª rodada com o DeepSeek pela API: 2,2 a 2,8 mil tokens sem cache a mais por uso, numa conversa curta; numa de 50 mil
tokens, 50 mil). Em preço, deferir só ganha onde o modelo raramente precisa de uma delas no meio de uma conversa longa: por isso as
carregadas ficam até o fim da sessão (uma quebra por conjunto, não por turno). **Nas 5 sessões reais, 3 usaram ao menos uma das nove**
(duas pelas `mcp_*`, de antes das ferramentas MCP de primeira classe, e uma por `list_agents`/`task`): a aposta é que o MCP direto tire
as `mcp_*` desse conjunto. Para quem fala de "skills" e "agentes" o tempo todo, como este projeto, a pré-carga põe `list_skills` e
`list_agents` (uns 150 tokens cada) na lista logo no começo da maioria das sessões: o ganho de janela some para elas.

**A conversa de 3 turnos** (`scripts/ui-token-economy.cjs`, DeepSeek V4.1 flash): nos dois builds terminou, com a mesma resposta certa
(`src/core/memory/project.ts`, 1 359 linhas), e **nenhum precisou de `tool_search` nem de `tool_load`**: só usou ferramentas essenciais.
A sessão "ola" que a abre custou 8 881 → 7 723 tokens. Os totais não se comparam: o modelo escolheu caminhos diferentes (10 chamadas e
163 666 tokens de entrada no antigo; 7 chamadas e 129 089 no novo) e o cache deste caminho oscila (49% da entrada veio do cache no
antigo, 84% no novo), então não atribuo essa diferença à mudança.

**Defeitos achados pelas baterias e o que foi feito:**

1. *O modelo nunca soube que `memory_handoff` existia* (o prompt não o citava mais) e gravou uma página de memória em vez de um handoff
   (DeepSeek pela API; depois o Gemma 4 31B, mesmo com o carregamento por chamada direta). O prompt passou a dizer "se o usuário
   pedir um handoff, chame `memory_handoff` com action=begin", os apelidos de busca a achá-lo e a pré-carga a pô-lo na lista quando o
   pedido o menciona. Verificado no build final com quatro modelos.
2. *Recusar a chamada direta* fazia o modelo desistir ou improvisar (Gemma: gravou uma página no lugar do handoff e levou 6 chamadas
   para chegar em `mcp_servers`). Agora a chamada é executada e a ferramenta fica carregada.
3. *Um modelo pequeno não acha uma ferramenta que não está na lista*, nem com `tool_search` à mão nem com o nome no prompt (acima). A
   pré-carga pelas palavras do usuário levou o 4B de 2/4 a 4/4 (uma amostra pequena de um modelo instável: duas rodadas sem a
   pré-carga, uma com).
4. Duas execuções vazias (saldo esgotado) sobrescreveram resultados bons; um piso foi "medido" num modelo local que a reserva
   automática escolheu. Os scripts agora recusam gravar sem resposta do modelo e conferem o modelo em que a sessão terminou.

Resultados em `docs/medicoes/` (`piso-*.json`, `sob-demanda-*.json`, `tokens-ocds-*.json`; `*-r1-*` é a primeira rodada, com a frase antiga;
`*-r3-*` a das sugestões por palavra, que foi descartada; `*-final-*` é o build final; os dois reconstruídos da saída do console dizem
isso no próprio arquivo).

## 4. Limites e o que não foi feito

- **O cenário de continuação é pequeno**: uma biblioteca de três funções, um projeto, até 10 sessões. Não mostra como a busca e a
  cápsula se comportam numa memória com centenas de páginas e várias sessões abertas ao mesmo tempo (a cápsula entrega até 2 trabalhos
  em aberto; o objetivo cabe em ~1 800 caracteres, o resto está em `memory_page read`).
- **Uma execução de cada cenário.** O comportamento dos modelos varia de uma execução para outra (o número de chamadas e de
  ferramentas muda). O efeito do cache por posição é determinístico o bastante (99% contra 6%, em todas as chamadas medidas), mas a
  passagem de bastão foi rodada uma vez com cada configuração: é uma prova de que o caminho funciona, não uma taxa de sucesso.
- **O "outro LLM" do teste de passagem de bastão é outro modelo do mesmo provedor** (`deepseek-v4-pro` assumindo o trabalho do
  `deepseek-flash`), porque o DeepSeek é o único provedor com chave neste computador (o Ollama não estava rodando). O mecanismo é
  independente de provedor, já que a memória viaja como texto na mensagem do turno, mas a troca entre fabricantes diferentes não foi
  exercitada.
- **O cache depende do provedor.** Ele só ajuda se a chamada seguinte chega antes de o provedor descartar o prefixo (o DeepSeek guarda
  por horas; outros, por minutos). Depois de uma pausa longa a primeira chamada volta a ser cheia.
- **O piso de uma sessão nova ainda passa de 8 mil tokens** (−12% no A/B limpo com o DeepSeek V4.1 flash, 9 401 → 8 274; −15% com o
  DeepSeek pela API, 10 553 → 8 974; §3.6; o cache faz esse piso custar 10% a partir da 2ª chamada, mas ele ocupa janela). Sobram ~4,5
  mil de schemas de 22 ferramentas e ~3 mil de prompt do sistema. Os maiores: `memory_page` (572 tokens), `report_limitation` (~450 depois de encurtada), `ask_user` (457) e
  `agent` (350); encurtar as descrições deles pouparia algumas centenas de tokens (estimativa, não feita), sem mexer em nenhum
  contrato. Fora do que se mediu aqui: no app do
  usuário as ferramentas MCP de servidores pequenos entram direto em toda chamada (até 15, `MCP_INLINE_TOOL_LIMIT`); o painel Contexto
  mostra quantas, e baixar esse limite é a próxima alavanca se elas pesarem.
- **A pré-carga só vale quando o pedido usa as palavras.** Sem elas ("quem pode revisar a segurança?" em vez de "catálogo de agentes"),
  o modelo precisa achar a ferramenta sozinho: de 1 a 3 chamadas a mais, uma quebra do cache num provedor que tem cache (2,2 a 2,8 mil tokens
  sem cache numa conversa curta; o histórico inteiro, uma vez, numa longa) e, num modelo pequeno, falha em metade dos cenários (Qwen 3.5 4B,
  2/4 duas vezes sem a pré-carga). As sugestões de skills e agentes por assunto cobrem parte desses pedidos. A pré-carga também pode
  carregar sem necessidade (uma palavra como "skills" num log colado): custa uns 150 tokens e uma quebra do cache, uma vez por ferramenta e sessão.
  Em preço, num provedor com cache, a economia do piso é pequena (10% a partir da 2ª chamada): ver a "ressalva do preço" na §3.6.
- **A conversa de 3 turnos só mostra que nada quebrou**, não o ganho: nos dois builds ela usou só ferramentas essenciais e os
  caminhos do modelo foram diferentes (10 e 7 chamadas), então os totais não se comparam (§3.6).
- **Nenhuma medição foi feita com o OpenRouter**, que era o pedido, mesmo depois de o usuário dizer que pôs a chave ou o crédito: o cofre
  do app não mudou, não há `OPENROUTER_API_KEY` e a cota diária de modelos gratuitos que o Ollama repassa seguia esgotada. As medições usaram
  o DeepSeek V4.1 flash, o Qwen 3.8 flash e o Beam (OpenCode Go) e o Qwen 3.5 4B local. Um modelo fraco do OpenRouter e o piso medido pela
  API do OpenRouter continuam por fazer: bastam a chave salva em Configurações → Provedores → OpenRouter (ou a variável) e rodar
  `scripts/ui-floor.cjs` e `scripts/ui-deferred-tools.cjs` com `--provider openrouter --model deepseek/deepseek-v4.1-flash`.
- **A busca é lexical** (radical das palavras, sinônimos de verbos pt→en só nas sugestões), não semântica: "fatura" não acha "nota
  fiscal". O sidecar tem um modelo de embeddings (`data/ai-memory/models`), que não é usado.
- **A cápsula só sabe que o trabalho está em aberto se houver plano com item pendente ou se o turno terminou com erro.** Uma sessão
  sem plano que parou no meio aparece como "última sessão, concluída": ainda é entregue à sessão nova, mas sem o aviso de pendência.
- **As sugestões não carregam nada sozinhas.** O harness nomeia a skill/agente/ferramenta que casa; o modelo ainda precisa de
  `use_skill`, `agent` ou `tool_load`. Carregar sozinho foi descartado por risco (uma ferramenta de escrita carregada sem o modelo pedir).
  As exceções são só duas, e só para as nove ferramentas que saíram da lista essencial (§3.6): a chamada direta, feita pelo próprio
  modelo, e as palavras do usuário ("catálogo de skills", "handoff"), que as põem na lista. Uma sugestão comum só aparece quando o
  pedido diz boa parte do que a ferramenta diz: num pedido longo que cita "handoff" ela não vinha, e por isso a pré-carga não depende dela.
- **O resumo na troca de modelo custa uma chamada** que lê o histórico inteiro uma vez, no modelo novo; só se paga em conversas
  acima de ~20 mil tokens, que é onde ela compensa.
- **A limpeza dos hubs mexe na pasta da wiki do usuário** (move 19 arquivos gerados automaticamente para `wiki/.archive` no primeiro
  uso do projeto com este build; apagar o `.archive` não afeta nada, e mover de volta restaura) e apaga do índice AI-Memory as cópias
  deles na próxima sincronização.
- **O app aberto do usuário ainda não tem nada disto:** é preciso reiniciar no build novo (a sessão que cuida dos reinícios faz isso).
- **O medidor de contexto só mede sessões que já tiveram um turno desde que o app abriu** (precisa do runner); antes disso mostra a
  estimativa antiga, marcada como tal.

## 5. Como reproduzir

```powershell
npm run build                                     # ou: npx electron-vite build --outDir <pasta>\out  (não mexe no out/ do app aberto)
node scripts/snapshot-app.cjs <rótulo> [--from <pasta>\out]   # congela o build; imprime a pasta
node scripts/ui-token-economy.cjs --label <rótulo> --root <pasta do snapshot>   # tokens e cache por posição (DeepSeek real)
node scripts/ui-handoff.cjs --label <rótulo> --root <pasta do snapshot>         # passagem de bastão entre dois modelos
node scripts/ui-floor.cjs --label <rótulo> --root <pasta do snapshot> --samples 2   # 1ª chamada de uma sessão nova, como o provedor conta
node scripts/ui-deferred-tools.cjs --label <rótulo> --root <pasta do snapshot>      # o que custa precisar de uma ferramenta adiada
# outro provedor/modelo (o saldo do DeepSeek acabou): --provider ollama --model gemma4:31b-cloud ; OPENCLOD_E2E_LOG=<arquivo> guarda o log do app
npx vitest run tests/memory-pack.test.ts tests/turn-context.test.ts tests/runner-prompt-cache.test.ts tests/runner-continuity.test.ts
```
