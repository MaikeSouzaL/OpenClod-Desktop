# Catálogo de testes — a lista viva

> Checklist da fase de PLANO do `qa-total`. Cada linha que se aplica a um item da superfície vira
> pelo menos um caso no ledger (`cobertura.json`). O que não se aplica vira `nao-aplicavel`, com
> motivo. O catálogo cresce a cada rodada: ver a seção 10.
>
> Este arquivo diz **o que** testar. **Onde** e **como** (produção somente leitura, efeito externo
> só com autorização, nada de senha nem login, escrita no banco só pela aplicação) estão no
> `SKILL.md` e no `.qa/PERFIL.md` — eles mandam. Caso que exige algo não autorizado vira `bloqueado`
> dizendo o que falta; nunca é pulado em silêncio.

## Sumário

1. Como usar este catálogo
2. Técnicas de desenho de teste
3. Massa de teste de bolso
4. Por tipo de elemento (UI) — prefixo `EL-`
5. Fluxos de negócio recorrentes — prefixo `PF-`
6. Dimensões transversais — prefixo `DM-`
7. Por tipo de projeto — prefixo `PJ-` (7.12 mensagens SMS, push e WhatsApp; 7.13 aplicação com modelo de
   linguagem; 7.14 desktop; 7.15 jogo e canvas; 7.16 site estático)
8. Testes estáticos e de build — prefixo `ES-`; 8.1 Qualidade de código — prefixo `QC-`
9. Lições reais que viraram regra — prefixo `LI-`
10. Como acrescentar uma lição
11. Módulos avançados (sempre que o projeto permitir) — prefixo `MA-`
12. Módulos opcionais (ligados no PERFIL ou a pedido) — prefixo `MO-`
13. Provas, entrega e comunicação — prefixo `EN-`

Arquivo grande: não carregue inteiro. Liste as seções com `grep -n "^##" references/catalogo-de-testes.md`
e leia só as que o alvo pede; para achar uma linha, `grep -n "EL-DAT-" references/catalogo-de-testes.md`.

---

## 1. Como usar este catálogo

### 1.1 O roteiro

1. Abra o `.qa/PERFIL.md`, identifique o tipo de projeto e marque as seções obrigatórias (tabela 1.4).
   A tabela é piso, não teto: se o alvo toca uma seção que ela não lista, a seção entra.
2. Para cada item do ledger (`itens`), aplique:
   - o **mínimo por tipo de item** (1.3);
   - a seção do **tipo de elemento** correspondente (seção 4), se for UI;
   - o **fluxo de negócio** que ele integra (seção 5);
   - as **dimensões transversais** que tocam o item (seção 6).
3. Cada linha aplicável vira caso com `item_id`, `tecnica` (1.5), `resultado_esperado` e `oraculo`
   (1.6). Comece o `titulo` do caso pelo código da linha: `[EL-TXT-04] Nome só com espaços`. Assim dá
   para auditar de onde cada caso veio e o que ficou de fora (`cobertura.py listar` + grep do código).
4. Linha com variantes (cinco valores inválidos, três papéis): uma variante por caso quando o
   resultado esperado difere; um caso com as entradas listadas quando o esperado é o mesmo — mas cada
   variante precisa aparecer na evidência.
5. Linha que não se aplica: não invente caso, mas registre a decisão.
   - Dentro da seção de um elemento: agrupe as linhas n/a num caso só, com os códigos e o motivo
     (`[EL-UPL-*] a tela não tem upload`).
   - Seção inteira que não se aplica ao projeto: um caso `nao-aplicavel` com item
     `dimensao:<prefixo>` (ex. `dimensao:DM-I18`) e o motivo ("produto só em pt-BR, sem seletor de
     idioma"). Prova que a seção foi considerada.
   - Cada seção pede o **seu** porquê. Três ou mais casos `nao-aplicavel` em itens `dimensao:` com a
     mesma justificativa são erro de validação (`na-em-lote`): é o "marcar em lote" que a fase 9
     proíbe.
   - As seções P0 de autorização, isolamento, segurança e sessão (`DM-TEN`, `DM-AUT`, `DM-SEC`,
     `DM-SES`) e o módulo `MA-6`, com ou sem sufixo `-NN`, num projeto `front-web`, `full-stack`,
     `api`, `mobile`, `desktop` ou `llm`: o `nao-aplicavel` só passa com `arquivo:linha` na
     justificativa (o que no código prova que não há o que testar) ou com evidência em disco
     (ex.: `notas/NN-por-que-nao-se-aplica.txt`). Sem isso, `na-p0-sem-prova`.
   - `dimensao:QC` (8.1) só é `nao-aplicavel` com "sem código-fonte acessível: <porquê>".
6. Antes de executar, rode a checagem de completude (1.7).

Cada linha deste catálogo segue o formato **faça X → verifique Y**. Linha que não diz como verificar
é defeito do catálogo: corrija-a ao usar.

As etiquetas entre parênteses nas linhas da seção 4 indicam o resultado exercitado: **acerto**,
**erro**, **limite**, **bloqueio** e **risco** (o que pode dar errado). Toda ação da superfície precisa
dos cinco.

### 1.2 Prioridade define a ordem, nunca o corte

| Prioridade | O que entra | Por quê |
|---|---|---|
| P0 | fluxo feliz até gravar; obrigatórios; autorização e isolamento; dinheiro, quantidade e cálculo; integridade (o que não deve mudar); efeito externo | erro aqui custa dinheiro, vaza dado ou some com dado |
| P1 | validação, limites, estados e transições, navegação, persistência, concorrência, mensagens | é onde mora a maioria dos defeitos |
| P2 | i18n, acessibilidade, responsivo, design, desempenho fino | importa, mas raramente destrói dado |

Sem tempo para tudo: pare, deixe o resto `pendente` e diga. O gate não deixa chamar de pronto — não
use prioridade para esconder corte.

`bloqueado` exige dizer **o que falta**: qual papel, qual autorização, qual dado, qual ambiente.
"Não testei" não é justificativa.

### 1.3 Mínimo obrigatório por tipo de item do ledger

O gate final (`cobertura.py gate` sem `--so-cobertura`, e o `fechar`) cobra estas linhas nos itens com
escopo `dentro`: as cinco dimensões (acerto, erro, limite, bloqueio, risco) em toda ação — `elemento:`,
`api:`, `comando:`, `funcao:`, `job:`, `consumidor:`, `ipc:`, `menu:` e `ferramenta:` —; em `tela:`,
pelo menos um `elemento:` filho (campo `pai`) ou o caso `nao-aplicavel` "tela sem controles: <porquê>",
um caso `[EL-EST-NN]` e um `[DM-NAV-NN]`, e um item `i18n:<locale>:<rota>`, `tema:<tema>:<rota>` e
`viewport:<largura>:<rota>` com caso para cada valor de `rodada --locales`, `--temas` e `--viewports`;
em `papel:`, um caso `--dimensao bloqueio` com técnica `rbac` ou `seguranca`; em `estado:`, a transição
inválida (`transicao-estado` + `bloqueio`); em `efeito:`, o "não dispara quando não deve" (`bloqueio`);
em `flag:`, dois casos concluídos (ligada e desligada) ou um `bloqueado` "falta como alternar: …"; em
`elemento:` com `tipo_elemento` (upload, exportar, data, select, select-busca, link-externo), o caso da
subseção (`EL-UPL`, `EL-EXP`, `EL-DAT`, `EL-SEL`, `EL-SBU`, `EL-LNK`). O resto da tabela é o piso do
plano, conferido pelo crítico.

| Tipo de item | Casos mínimos (cada linha é pelo menos um caso) |
|---|---|
| `tela:` | carrega com dado real; vazio; carregando; erro de API; papel sem acesso; link direto e F5; voltar do navegador; troca de idioma; teclado (Tab, Enter, Esc); largura de celular quando a tela é usada fora do escritório; leitura de design (6.19); console sem erro novo |
| `elemento:` campo | acerto com persistência após F5 (tela + payload + banco); vazio; formato inválido; limites; colar; erro no próprio campo; marca de obrigatório coerente com a regra |
| `elemento:` botão/ação | acerto com efeito conferido; erro; bloqueio (desabilitado com motivo visível ou oculto, e chamada direta à API); clique duplo; estado "salvando"; teclado; ação no registro novo e no registro fechado |
| `api:` | 2xx com contrato do corpo; 400/422 de validação; 401 sem sessão; 403 papel errado; 404 inexistente; id de outro tenant; tempo medido |
| `regra:` | n-1, n, n+1 (ou a tabela de decisão completa); aplicada no front e no back; mensagem cita o mesmo valor que barra; dado legado que viola a regra |
| `papel:` | a linha inteira da matriz RBAC (2.7) |
| `estado:` | entrar; cada saída válida; cada transição inválida pela UI e pela API; F5 no estado; reflexo em listagem, badge e KPI |
| `fluxo:` | cada bifurcação até o fim, com registro novo por caminho; interromper no meio (F5, voltar, fechar) |
| `dado:` | matriz CRUD (2.6) por papel; órfãos depois de excluir; auditoria |
| `efeito:` | disparou; para quem (e quem não deveria); conteúdo certo; uma vez só; falha do efeito trata a ação principal como a regra diz |
| `job:` / `comando:` | seção 7.5 / 7.2 |
| `funcao:` | partição; limites; valores falsos que são válidos (`0`, `""`, `[]`, dia 1); entrada real colhida da rede; chamada direta numa tabela de entradas (script ou REPL do projeto), sem passar pela tela |
| `flag:` | cada estado da tela com a flag ligada e com ela desligada, sem resto da outra variante (DM-AMB-07) |
| `tema:` | contraste medido e nada invisível (texto, ícone, borda, foco) em cada tema |
| `componente:` | seção 6.20 (`DM-CMP`) + um uso real de cada configuração usada no alvo |
| `arquivo:` | modo PR (`MA-4`, §11.4): o comportamento novo ou a regressão do que o arquivo faz |
| `i18n:` | seção 6.12 (`DM-I18`) no locale e na rota do id |
| `viewport:` | seção 6.14 (`DM-RES`) na largura e na rota do id |
| `seguranca:` | seção 11.6 (`MA-6`) para o assunto do id |
| `estatico:` | seção 8: o número antes e depois (baseline × fim) em arquivo de texto |
| `modulo:` | seção 8.1 (`QC`) no módulo do id |
| `fila:` / `consumidor:` | seção 7.5 (`PJ-JOB`) |
| `prompt:` / `ferramenta:` / `fonte:` | seção 7.13 (`PJ-LLM`) |
| `janela:` / `ipc:` / `menu:` | seção 7.14 (`PJ-DSK`) |
| `cena:` | seção 7.15 (`PJ-GAM`) |
| `dimensao:` | só para registrar seção inteira não aplicável (1.1, passo 5) |

### 1.4 Tipo de projeto → seções obrigatórias

| Projeto | Seções |
|---|---|
| Front web (SPA/SSR) | 2, 3, 4 (todo elemento presente), 5 (fluxos presentes), 6 (todas), 7.8; 7.9 se houver embed; 7.10 se envia e-mail; 7.11 se tem painel; 7.12 se envia SMS, push ou WhatsApp; 8, 8.1, 9 |
| Full-stack | tudo do front + 7.1, 7.5, 7.6, 7.7; as linhas de 6.6, 6.7 e 6.8 testadas também pela API direta |
| API/backend | 2, 3, 5 (regras dos fluxos), 6 exceto 6.13, 6.14, 6.19, 6.26; 7.1, 7.5, 7.6, 7.7; 7.10/7.11/7.12 se houver; 8, 8.1, 9 |
| CLI | 2, 3, 6.3, 6.8 (entrada hostil), 6.9, 6.11, 6.12 (mensagens), 6.15, 6.16, 6.17, 6.18, 6.21, 6.23; 7.2; 8, 8.1, 9 |
| Biblioteca/SDK | 2, 3, 6.11, 6.15, 6.16, 6.17, 6.18, 6.20; 7.3; 8, 8.1, 9 |
| Mobile | como front web (sem 7.8) + 7.4 |
| Jobs, filas, cron | 2, 3, 6.3, 6.4, 6.9, 6.10, 6.16, 6.17, 6.21, 6.23; 7.5, 7.6; 7.12 se envia mensagem; 8, 8.1, 9 |
| LLM (aplicação com modelo de linguagem, RAG ou agente) | 7.13; 6.7, 6.8 e 6.24 com o prompt e o documento indexado como entrada hostil; 7.12 se o agente manda mensagem; 8, 8.1, 9 — declare também o tipo de base (front-web, full-stack ou api) em --tipo-projeto |
| Desktop (Electron/Tauri) | como front web (sem 7.8) + 7.14; 6.8 também pelo IPC; 8, 8.1, 9 |
| Jogo (canvas/WebGL) | 2, 3, 6.2, 6.3, 6.13, 6.14, 6.15, 6.16, 6.19, 6.26; 7.15; 12.1 (MO-7) com tolerância; 8, 8.1, 9 |
| Site estático (landing, documentação, blog) | 2, 3, 4.31, 4.34, 4.44, 6.1, 6.12, 6.13, 6.14, 6.15, 6.19, 6.24, 6.25, 6.26; 7.8; 7.16; 8, 8.1, 9 |
| Monorepo (vários pacotes) | 6.20 (regressão nos consumidores internos de todo pacote alterado); 8 (build na ordem do grafo do workspace); 8.1, 9 — declare também o tipo de cada pacote em --tipo-projeto |

O projeto pode ter mais de um tipo (full-stack com LLM, monorepo com front e biblioteca): declare
todos (`cobertura.py rodada <rodada> --tipo-projeto full-stack,llm`, repetível ou separado por
vírgula). O gate cobra a **união** das seções; `llm` sem `front-web`, `full-stack` ou `api` e
`monorepo` sozinho reprovam. Item que pede um tipo não declarado (`prompt:`, `ipc:`, `cena:`, `job:`,
`comando:`…) gera aviso. Seção condicional (7.9, 7.10, 7.11, 7.12) vira obrigatória quando o ledger já
tem o item que a dispara: `efeito:email.*` → 7.10; `efeito:sms|push|whatsapp.*` → 7.12; id com `embed`
→ 7.9; `tela:/relatorios…` ou caso `[EL-KPI]` → 7.11.

Em **todo** tipo de projeto, além da tabela:

- **8 (`ES`) e 8.1 (`QC`) são cobradas separadamente**: um caso `[ES-NN]` não cobre a 8.1. A 8.1 vale
  sempre que o código-fonte do alvo estiver acessível; `dimensao:QC` com `nao-aplicavel` só com "sem
  código-fonte acessível: <porquê>".
- **11 (`MA`)** sempre que o projeto permitir. Módulo que não se aplica vira caso `nao-aplicavel`
  no item `dimensao:MA-<n>`, com o motivo ("sem banco acessível", "não há diff").
- **12 (`MO`)** só os módulos ligados no PERFIL ou pedidos; desligado também vira `nao-aplicavel` em
  `dimensao:MO-<n>`. A parte passiva de desempenho (`MO-10-01` a `-04`) roda sempre que há UI.
- **13 (`EN`)** em toda rodada com correção, relatório, entrega por bloco ou mensagem para o time:
  o `cobertura.py fechar` cobra ao menos um caso `[EN-NN]` e os entregáveis da fase 10 (provas.pdf,
  relatório sem `{{`, painel mais novo que o ledger, oráculo agrupado e replay).

### 1.5 Origem do caso → `tecnica` no ledger

| Origem | `tecnica` |
|---|---|
| linhas (acerto) e (erro) da seção 4 | `particao` |
| linhas (limite); itens `regra:` | `valor-limite` |
| várias condições combinadas decidem o resultado | `tabela-decisao` |
| itens `estado:`; fluxos de etapas | `transicao-estado` |
| combinação de fatores (papel × produto × idioma × navegador) | `pairwise` |
| itens `dado:` | `crud` |
| itens `papel:`; 6.6; 6.7 | `rbac` |
| linhas (risco); heurísticas de 2.8; lições `LI-` | `erro-adivinhado` |
| charter de 2.9 | `exploratorio` |
| 6.20; reteste de correção | `regressao` |
| 6.8 | `seguranca` |
| 6.13 | `a11y` |
| 6.12 | `i18n` |
| 6.14 | `responsivo` |
| 6.15 | `desempenho` |
| seção 8 | `estatico` |
| 7.1 e toda chamada direta à API | `api` |
| prova no banco (6.9, 6.10) | `banco` |
| 8.1 (`QC`) | `estatico`; caracterização depois de refatorar → `regressao` |
| 11.1 (`MA-1`, log do servidor) | `api` |
| 11.2 (`MA-2`, front × back) | `api`; membro de enum → `particao`; campo enviado e ignorado → `banco`; precisão → `valor-limite` |
| 11.3 (`MA-3`, integridade do banco) | `banco` |
| 11.4 (`MA-4`, modo PR/diff) | `regressao` e a técnica do comportamento novo |
| 11.5 (`MA-5`, regressão automática) | `regressao` |
| 11.6 (`MA-6`, segurança funda) | dependências e segredos → `estatico`; cabeçalhos, CORS, IDOR, upload e limite de taxa → `seguranca`; autorização no back → `rbac` |
| 12.1 (`MO-7`, comparação visual) | `visual`; reteste contra a mesma baseline → `regressao` |
| 12.2 (`MO-8`, axe-core) | `a11y` |
| 12.3 (`MO-9`, fuzz) | pela UI → `erro-adivinhado`; XSS, injeção e mass assignment → `seguranca`; corpo malformado → `api` |
| 12.4 (`MO-10`, desempenho) | `desempenho` |
| 13 (`EN`) | prova e reteste → `regressao`; patch, soma e typecheck por bloco → `estatico` |
| 6.4 (`DM-CON`); duas sessões ou duas requisições ao mesmo tempo | `concorrencia` |
| carga e rajada autorizadas (`MO-10-12`, `DM-SEC-11`) | `carga` |
| invariante que vale para toda entrada, com gerador de casos (itens `funcao:`, `PJ-LIB`) | `propriedade` |
| contrato entre camadas ou versões (`PJ-API-01`, `PJ-API-14`, `PJ-LIB-07`, `PJ-LIB-08`, `PJ-JOB-10`) | `contrato` |
| 7.12 (`PJ-MSG`, mensagens) | `api`; destinatário, opt-out e ambiente → `seguranca` |
| 7.13 (`PJ-LLM`, modelo de linguagem) | mesma entrada N vezes e conjunto de avaliação → `avaliacao`; injeção, vazamento, dado de outro tenant e conteúdo proibido (`PJ-LLM-14`) → `seguranca`; tokens, custo e timeout → `desempenho`; saída fora do esquema e stream interrompido (`PJ-LLM-11` e `PJ-LLM-13`) → `api`; janela de contexto estourada (`PJ-LLM-12`) → `valor-limite` |
| 7.14 (`PJ-DSK`, desktop) | IPC, protocolo customizado e updater → `seguranca`; janelas, menus e bandeja → `particao` |
| 7.15 (`PJ-GAM`, jogo e canvas) | cenas e estados → `transicao-estado`; FPS e memória → `desempenho`; print entre rodadas → `visual` |
| 7.16 (`PJ-SIT`, site estático) | links, metadados, sitemap e robots → `estatico`; formulário e consentimento → `api` |

### 1.6 De onde vem o resultado esperado (oráculo)

Escreva o oráculo em todo caso. Ordem de confiança:

1. Regra explícita do usuário ou do dono do produto (com data e quem disse).
2. Especificação, ticket, documentação do projeto — e desconfie: changelog e documentação já
   descreveram a regra errada.
3. A regra que o servidor aplica (o que o back valida é o que vale para o dado).
4. O código do front.
5. O comportamento anterior (`git log -S"<símbolo>"`, versão em produção) — mudança recente pode ser
   decisão, não regressão.
6. Telas irmãs da mesma aplicação (consistência).
7. Normas: HTTP, WCAG, LGPD/GDPR, convenções de locale.
8. Expectativa razoável de quem usa.

Quando dois oráculos discordam, **a divergência é o achado**. Se resolver exige escolher a regra de
negócio, é `decisao-de-produto`: relate e não altere.

Sem especificação, use as heurísticas de consistência — o produto deve ser consistente:

- consigo mesmo: a tela não se contradiz (ícone vermelho com texto "Ativo"; badge "acima do limite"
  com total maior que o uso);
- com o histórico: fazia diferente antes? por quê?
- com comparáveis: telas irmãs, produtos do mesmo tipo;
- com o que afirma: rótulo, tooltip, mensagem, documentação, revisão do wizard;
- com o propósito: o que o usuário tenta fazer ali;
- com normas e leis;
- com defeitos já vistos: este catálogo.

### 1.7 Checagem de completude do plano

Antes de executar, responda sim a todas:

- [ ] Todo item do ledger tem pelo menos um caso (`cobertura.py validar` aponta item sem caso).
- [ ] Toda ação tem acerto, erro, limite, bloqueio e risco.
- [ ] Toda regra numérica tem n-1, n, n+1, nos dois lados quando há mínimo e máximo.
- [ ] Todo papel conhecido passou pela matriz RBAC, incluindo "dado de outro tenant".
- [ ] Todo estado tem entrada, saídas válidas e transições inválidas (UI e API).
- [ ] Toda bifurcação de fluxo tem caminho próprio, com registro novo.
- [ ] Todo efeito a jusante tem caso de conteúdo, não só de existência.
- [ ] Toda seção aplicável do catálogo aparece no plano (como casos ou como `nao-aplicavel`).
- [ ] A seção 8 tem baseline medido antes de qualquer mudança.
- [ ] Todo componente compartilhado tocado tem caso de regressão em outro uso real.

---

## 2. Técnicas de desenho de teste

### 2.1 Partição de equivalência

- **O que é:** dividir as entradas em grupos que o sistema deve tratar igual e testar um
  representante de cada grupo — inclusive dos grupos inválidos.
- **Quando:** todo campo, parâmetro, filtro e opção.
- **Como:** liste as classes válidas e inválidas a partir da regra (código do back, schema, spec).
  Uma classe inválida por caso; não junte dois erros na mesma entrada, senão o primeiro esconde o
  segundo.
- **Exemplo:** "e-mail" → válido comum; válido incomum (`a+tag@sub.dominio.com.br`); sem `@`; sem
  domínio; com espaço; vazio; duplicado; maiúsculas de um já existente.
- **Armadilha:** a classe "vazio" se divide em `""`, só espaços, `null`, campo ausente do payload —
  o back pode tratar cada uma diferente.

### 2.2 Valor-limite

- **O que é:** defeitos se juntam nas fronteiras. Para cada limite, teste **n-1, n e n+1**.
- **Quando:** toda regra com número, tamanho, data, quantidade, página, percentual.
- **Como:** os dois lados (mínimo e máximo). Limites declarados (regra de negócio) e implícitos
  (tamanho da coluna no banco, tipo numérico, página 0 e última+1, 23:59/00:00, 28/29/30/31).
- **Exemplo:** "mínimo de 51 unidades para plano mensal" → 50 barra, 51 passa, 52 passa; e a mensagem
  mostra 51, o mesmo número que barra.
- **Armadilhas:** `<` × `<=` (o 50 passava onde a regra dizia "acima de 50"); a mesma regra em duas
  constantes com valores diferentes; mensagem com um número e checagem com outro; limite no front
  diferente do limite no back.

### 2.3 Tabela de decisão

- **O que é:** quando o resultado depende de várias condições ao mesmo tempo, monte a tabela com
  todas as combinações relevantes; cada coluna é um caso.
- **Quando:** botão habilitado por papel + estado + dado; preço por plano + moeda + desconto; regras de
  elegibilidade.
- **Exemplo:** "Concluir" habilitado se (papel tem a permissão) E (registro aberto) E (item
  selecionado) E (venda > custo). 4 condições → até 16 colunas; reduza só as impossíveis, e diga quais.
- **Armadilha:** para cada coluna bloqueada, o **motivo exibido** também é resultado esperado. Botão
  cinza sem explicação é defeito mesmo quando o bloqueio está certo.

### 2.4 Transição de estado

- **O que é:** modelar a entidade como máquina de estados e testar estados e transições.
- **Quando:** qualquer entidade com status, etapa, ciclo de vida ou aprovação.
- **Como:**
  1. Tire do código a lista de estados (enum, campo de status) e de transições (guards, endpoints).
  2. Monte a matriz N×N: cada par é válido ou inválido.
  3. Cada transição válida: pela UI, com efeito conferido (banco, listagem, contadores, notificação).
  4. Cada transição inválida relevante: a UI não oferece (oculto ou desabilitado com motivo) **e** a
     API direta recusa com 4xx de negócio.
  5. Em cada estado: o que fica editável, quais botões aparecem, o que acontece com F5.
  6. Estados terminais: o que ainda é possível (reativar? excluir?) e o que não deveria ser.
  7. Transição repetida (clicar duas vezes) não duplica efeito.
  8. Estado inalcançável pela tela: documente qual caminho e qual papel levam até ele — não marque
     "não testado".
- **Armadilha:** a tela do formulário nem sempre reflete o estado fechado; confira o estado no dado
  (API ou banco) e na listagem antes de concluir.

### 2.5 Pairwise (combinações)

- **O que é:** quando há muitos fatores, garantir que **todo par de valores** apareça em pelo menos um
  caso, em vez do produto cartesiano.
- **Quando:** papel × tipo de produto × moeda × idioma × navegador; flags de CLI.
- **Como:** até 3–4 fatores, monte à mão; mais que isso, use uma ferramenta de pairwise se houver.
- **Armadilha:** para dinheiro e autorização, use combinação **completa**, não pairwise — o defeito
  costuma estar numa tripla específica.

### 2.6 Matriz CRUD por entidade

Uma linha por entidade; colunas: Criar, Ler (detalhe), Listar, Buscar, Editar, Excluir/Inativar,
Restaurar, Exportar, Importar, Auditoria. Em cada célula: a tela e o endpoint, quem pode, o resultado.

| Entidade | Criar | Ler | Listar | Editar | Excluir | Restaurar | Exportar | Auditoria |
|---|---|---|---|---|---|---|---|---|
| Cliente | tela /clientes/novo · POST /cliente · papéis A, B | ... | ... | ... | ... | ... | ... | ... |

Confira também: exclusão lógica ou física; exclusão com dependentes (mensagem de negócio ou erro
cru de chave estrangeira?); órfãos nas tabelas filhas; o que some de listas, buscas, combos e
contadores depois de excluir.

### 2.7 Matriz RBAC: papel × ação × dado

Para cada ação sensível, cruze **papéis** com **dados**:

| Dado ↓ / Papel → | anônimo | papel A | papel B | admin | papel com flag global | papel recém-alterado |
|---|---|---|---|---|---|---|
| próprio | | | | | | |
| do mesmo tenant, de outro usuário | | | | | | |
| de outro tenant | | | | | | |
| sem dono | | | | | | |
| excluído/arquivado | | | | | | |
| inexistente / id malformado | | | | | | |

Em cada célula, dois resultados: **UI** (vê? habilita? diz o motivo?) e **API direta** (status e
corpo). "Papel recém-alterado" mede se a mudança vale na hora ou só após novo login.

Nunca troque de usuário digitando senha: peça ao usuário que logue com o papel necessário; enquanto
isso, siga com o resto.

### 2.8 Adivinhação de erro (heurísticas)

Percorra a lista para cada item; cada pergunta com resposta "pode ser" vira caso:

- **Zero, um, muitos:** nenhum registro, um, dois, a página exata, a página + 1, milhares.
- **Começo, meio, fim:** primeiro e último item, primeira e última página, início e fim de período.
- **Nada:** vazio, nulo, ausente, só espaços, lista vazia.
- **Demais:** longo, grande, muitos itens, muitos cliques.
- **Duplicado:** mesmo valor, mesmo arquivo, mesma ação duas vezes.
- **Fora de ordem:** passos invertidos, respostas de rede chegando trocadas.
- **Interrompido:** F5, voltar, fechar aba, rede cai, servidor reinicia, timeout.
- **Duas vezes:** clique duplo, duas abas, dois usuários.
- **De outro:** dado de outro usuário ou tenant; id trocado na URL.
- **Velho:** dado legado, link antigo, token usado, sessão expirada, cache.
- **Mudou embaixo:** outra pessoa editou ou excluiu enquanto a tela estava aberta.
- **Formato:** locale, fuso, encoding, separador decimal, máscara.
- **Verdadeiro/falso:** `0`, `""`, `[]`, `"novo"`, GUID zero — o código trata como deveria?
- **Copiar e colar:** com formatação, espaços, quebra de linha.
- **Teclado em vez de mouse.**
- **Fronteira entre camadas:** o front aceita e o back recusa (mensagem?); o back aceita e o front
  esconde (proteção falsa).

### 2.9 Exploratório com charter

- **Charter:** "Explorar `<alvo>` com `<recurso: papel, dado, ferramenta>` para descobrir
  `<informação ou risco>`."
- **Tempo:** caixa de 30 a 60 minutos.
- **Nota da sessão:** o que tentou, o que viu, defeitos, dúvidas, o que não deu tempo. A nota é a
  evidência do caso `exploratorio`.
- **Roteiros úteis:**
  - do dinheiro — onde o produto calcula, cobra ou soma;
  - do novato — primeiro uso, tudo vazio, sem configuração;
  - do vândalo — massa hostil da seção 3 em todo campo;
  - do vizinho — logado como outro tenant, procurando o dado alheio;
  - do arqueólogo — registros antigos, criados antes das regras atuais;
  - da madrugada — virada de dia, mês, fuso, jobs agendados;
  - do suporte — cada mensagem de erro: quem atende consegue diagnosticar a partir dela?
  - da sala de espera — rede lenta, servidor lento, tudo demorando;
  - do impaciente — clicar de novo, voltar, recarregar no meio.
- Exploratório **complementa** o plano; não substitui a enumeração.

### 2.10 Regressão dirigida pelo diff

1. `git diff` (ou a lista de arquivos alterados) → componentes, utilitários, endpoints tocados.
2. Para cada um: liste os usos (grep), agrupe por configuração (props, parâmetros, contexto).
3. Teste pelo menos um uso **real** de cada grupo, na tela de produto — vitrine e mock não contam.
4. Procure cópias: a mesma função colada em outras telas recebeu a correção?

### 2.11 Caminhos e bifurcações

- Liste cada ponto de decisão do fluxo: botões alternativos (concluir × perder × cancelar), valores
  que mudam o caminho (mensal × anual, Sim × Não, com × sem anexo), papéis diferentes.
- Percorra cada caminho até o estado final com um **registro novo** — não reaproveite um registro que
  já passou por outro caminho, porque ele carrega efeitos do primeiro.
- Teste cada ação também **antes de salvar** (rota de criação) e **depois de fechar** (registro em
  estado terminal).

### 2.12 Consistência entre camadas e lugares

- A mesma regra no front e no back: mesmo limite, mesma obrigatoriedade, mesma mensagem.
- O mesmo número em card, listagem filtrada, detalhe, relatório, exportação e e-mail.
- A mesma função ou regra copiada em vários lugares: todas as cópias dão o mesmo resultado.

---

## 3. Massa de teste de bolso

### 3.1 Texto

- vazio `""`; só espaços `"   "`; espaços nas pontas `"  Ana  "`; tabulação e quebra de linha.
- acentos e cedilha `"Ação Ñandú Çé"`; caixa mista para busca `"aÇÃo"` × `"acao"`.
- emoji e sequências `"👍🏽 👨\u200d👩\u200d👧"` (conta como 1 ou vários caracteres?); combinante `"é"`;
  largura zero `"a\u200bb"`; espaço não separável `"\u00a0"`; RTL `"مرحبا"`; CJK `"测试"`.
- longo: exatamente o limite, limite + 1, dez vezes o limite; palavra sem espaço com 300 caracteres.
- especiais: `' " < > & ; -- /* \ % _ *` (`%` e `_` são curingas de LIKE).
- HTML e script: `<b>negrito</b>`, `<img src=x onerror=alert(1)>`, `"><svg onload=alert(1)>`,
  `javascript:alert(1)` (em campo de URL).
- injeção (só em dev/teste; a prova é a resposta, não o estrago): `' OR '1'='1`, `{{7*7}}`, `${7*7}`,
  `../../etc/passwd`.
- fórmula de planilha: `=1+1`, `+1+1`, `-1+1`, `@SOMA(1)`.
- colado da área de transferência: com formatação, com quebra de linha no fim, com NBSP.

### 3.2 Números

- `0`, `-0`, `-1`, `1`; `0,1` e `0.1`; `1.000,50` e `1,000.50`; `1e3`; `0,1 + 0,2`.
- `2147483647` e `+1` (int32); `9007199254740993` (perde precisão em JavaScript).
- muitas casas: `3,14159265`; letras `abc`; `NaN`; `Infinity`; `" 12 "`; `R$ 10`; `10%`.

### 3.3 Datas e horas

- hoje, ontem, amanhã; 29/02 em ano bissexto e não bissexto; dia 31 em mês de 30.
- 31/12 23:59 → 01/01 00:00; virada de horário de verão onde existir; 1900, 2100.
- `03/04` no locale errado (3 de abril ou 4 de março?); `AAAA-MM-DD` cru.
- vencimento no dia 31 → fevereiro; meia-noite UTC = dia anterior em fuso negativo.

### 3.4 Contato e documento

- e-mail válido incomum: `a+tag@dominio.com.br`, `nome.sobrenome@sub.dominio.io`, `Ana@X.COM`
  (deduplica com `ana@x.com`?). Inválido: `a@`, `@b.com`, `a b@c.com`, `a@b`, `a@@b.com`, espaço
  no fim. Use caixas de teste autorizadas no PERFIL quando o e-mail for disparado de verdade.
- telefone: fixo, celular, com código do país, internacional, só dígitos, com máscara, curto, longo.
- documento (CPF, CNPJ e equivalentes): válido pelo dígito, inválido pelo dígito, todos iguais, com e
  sem máscara, alfanumérico onde a norma permite, já cadastrado, de outro tenant. Gere documento de
  teste pelo algoritmo; se o sistema consulta um órgão oficial, use documento público de empresa,
  conferido no banco — nunca dado pessoal de terceiros.
- CEP válido, inexistente, com e sem hífen; endereço sem número.

### 3.5 Arquivos

- 0 byte; mínimo válido; no limite de tamanho; acima do limite.
- extensão permitida com conteúdo de outro tipo; extensão dupla `nota.pdf.exe`; `.PDF` maiúsculo;
  sem extensão.
- nome com acento, espaço, `#`, `..`, `/`, 255 caracteres.
- SVG com `<script>`; imagem enorme em pixels e pequena em bytes; arquivo corrompido.
- o mesmo arquivo duas vezes; vários de uma vez.
- arquivo de teste antivírus EICAR (inofensivo), só se houver varredura e autorização.

### 3.6 Identificadores

- inexistente; de outro tenant; excluído; GUID zero `00000000-0000-0000-0000-000000000000`.
- malformado `abc`, `1 OR 1=1`; negativo; enorme.
- sentinelas que vazam para a URL: `novo`, `new`, `undefined`, `null`, `[object Object]`.

### 3.7 Volume

- 0, 1, 2 registros; exatamente o tamanho da página; tamanho da página + 1; milhares.
- um registro com todos os campos no máximo.

---

## 4. Por tipo de elemento (UI)

### 4.1 Texto livre (input, textarea) — `EL-TXT`

- **EL-TXT-01** (acerto) Digite valor típico, salve, recarregue → o mesmo valor na tela, no payload enviado e no banco.
- **EL-TXT-02** (acerto) Cole da área de transferência (com quebra de linha e NBSP) → aceito e normalizado igual à digitação.
- **EL-TXT-03** (erro) Obrigatório vazio → bloqueia sem requisição; mensagem no campo; campo destacado; foco ou rolagem até ele.
- **EL-TXT-04** (erro) Só espaços → tratado como vazio (ou como a regra disser); nunca grava `"   "`.
- **EL-TXT-05** (erro) Espaços nas pontas → aparados ao salvar e ao buscar; `"Ana"` e `"Ana "` não viram duplicados distintos.
- **EL-TXT-06** (limite) Tamanho máximo n-1, n, n+1 → contador (se houver) bate; n+1 barrado no input ou com mensagem; o banco aceita n (limite do front ≤ tamanho da coluna); erro de banco nunca aparece cru.
- **EL-TXT-07** (limite) Tamanho mínimo, quando existir: n-1 barra, n passa.
- **EL-TXT-08** (risco) Acentos, emoji, CJK, RTL → gravam e voltam iguais, sem `?` nem caracteres trocados; contagem de caracteres coerente.
- **EL-TXT-09** (risco) `<img src=x onerror=alert(1)>` → exibido como texto em TODO lugar onde o valor reaparece: listagem, detalhe, tooltip, título da página, e-mail, PDF, exportação, notificação.
- **EL-TXT-10** (risco) Palavra de 300 caracteres sem espaço → não estoura o layout (quebra ou trunca com `title`).
- **EL-TXT-11** (risco) `=1+1` → a exportação para planilha não vira fórmula.
- **EL-TXT-12** (risco) Textarea: quebra de linha preservada na exibição; Enter não envia o formulário.
- **EL-TXT-13** (risco) Placeholder não substitui rótulo (some ao digitar); asterisco não aparece duplicado no placeholder.
- **EL-TXT-14** (bloqueio) Campo somente leitura para o papel → não editável na UI e o back ignora ou recusa o valor enviado pela API.
- **EL-TXT-15** (risco) Atributo `autocomplete` adequado ao campo (nome, e-mail, endereço); preenchimento automático do navegador não quebra a validação.

### 4.2 Número inteiro e decimal — `EL-NUM`

- **EL-NUM-01** (acerto) Valor típico, salvar, recarregar → persistido igual.
- **EL-NUM-02** (acerto) Separador decimal do locale (vírgula em pt-BR, ponto em en-US) → aceito; o outro aceito ou recusado com mensagem; nunca `1,5` vira `15`.
- **EL-NUM-03** (limite) Zero válido → aceito e NÃO tratado como vazio ou padrão (`x || padrão`); exibido como `0`, não `-`.
- **EL-NUM-04** (erro) Negativo onde não faz sentido → recusado com mensagem.
- **EL-NUM-05** (limite) Mínimo e máximo: n-1, n, n+1 nos dois lados → a mensagem cita o mesmo número que barra.
- **EL-NUM-06** (erro) Decimal em campo inteiro → recusado ou arredondado conforme a regra, nunca truncado em silêncio.
- **EL-NUM-07** (limite) Muito grande → sem estouro de tipo nem perda de precisão no caminho front → back → banco → front.
- **EL-NUM-08** (erro) Letras, `e`, `+`, `--` → um `input type=number` aceita `e` e entrega vazio: o valor some em silêncio?
- **EL-NUM-09** (risco) Rolar o mouse ou usar as setas com o campo focado muda o valor sem querer?
- **EL-NUM-10** (risco) Apagar tudo → vazio, não `NaN`, não `0` escondido.
- **EL-NUM-11** (risco) Digite tecla a tecla cruzando um limite de regra (5 → 50 → 51) → o foco continua no campo (`document.activeElement`); a árvore não remonta.
- **EL-NUM-12** (risco) Campo calculado a partir deste atualiza ao digitar, ou deixa claro quando atualiza (não só no blur sem aviso).
- **EL-NUM-13** (acerto) Exibição em tabela: à direita, `tabular-nums`, separador de milhar do locale.

### 4.3 Moeda — `EL-MOE`

- **EL-MOE-01** (acerto) Valor típico → igual na tela, no payload e no banco, sem erro de ponto flutuante nos centavos.
- **EL-MOE-02** (acerto) Máscara: digitar `2500` vira R$ 25,00 ou R$ 2.500,00? → o mesmo comportamento em todos os campos de moeda da aplicação; colar `R$ 1.234,56` e `1234.56`.
- **EL-MOE-03** (limite) Zero, negativo (estorno?), máximo → conforme a regra.
- **EL-MOE-04** (acerto) Moeda diferente da padrão (USD, EUR) → símbolo, casas e posição certos; símbolo vem do dado, não fixo no código.
- **EL-MOE-05** (risco) Locale en-US exibindo valor em BRL, e o inverso.
- **EL-MOE-06** (risco) Arredondamento: total é a soma das linhas arredondadas ou o total arredondado? Confira à mão com `3 × 33,33`.
- **EL-MOE-07** (risco) Apagar o campo → não vira `NaN` nem `0` escondido; não envia string.
- **EL-MOE-08** (limite) Regra entre dois campos (venda > custo): igual, menor, maior por um centavo → a mensagem aponta o campo certo.
- **EL-MOE-09** (acerto) Exportação: número como número (não texto), formato e símbolo corretos na planilha.
- **EL-MOE-10** (bloqueio) Campo travado para o papel (preço definido por tabela) → não editável e o back ignora o valor enviado; o valor gravado é o da tabela, não o digitado.

### 4.4 Porcentagem — `EL-PCT`

- **EL-PCT-01** (limite) `0`, `100`, `100,01`, negativo → conforme a regra (teto e piso existem?).
- **EL-PCT-02** (risco) Apagar o campo → não vira `NaN%` nem número absurdo; custo derivado não vira zero.
- **EL-PCT-03** (acerto) Percentual calculado a partir de dois valores → confira à mão; dízima arredondada na exibição (2 casas), não `39,393939%`.
- **EL-PCT-04** (risco) Escala consistente: 0–1 ou 0–100 em toda a aplicação e no payload.
- **EL-PCT-05** (acerto) Exibição com `%` e separador do locale.

### 4.5 Data, hora, fuso e intervalo — `EL-DAT`

- **EL-DAT-01** (acerto) Escolher pelo calendário e digitar (se permitido) → persistido; exibido no formato do locale.
- **EL-DAT-02** (risco) Campo somente-calendário → dá para limpar? Há botão Limpar?
- **EL-DAT-03** (limite) Botão "Hoje" respeita mínimo e máximo.
- **EL-DAT-04** (limite) Mínimo e máximo comparados por DIA, não por hora → hoje selecionável quando mínimo = hoje; dias fora desabilitados E visualmente distintos.
- **EL-DAT-05** (limite) Passado, futuro, data distante, 29/02, dia 31 em mês de 30 → conforme a regra.
- **EL-DAT-06** (erro) Intervalo com fim antes do início; mesmo dia; intervalo que cruza mês e ano.
- **EL-DAT-07** (risco) Data pura `AAAA-MM-DD` exibida sem voltar um dia em fuso negativo; datetime gravado e exibido no fuso esperado; hora do servidor exibida como UTC (deslocamento de horas).
- **EL-DAT-08** (limite) Datetime: meia-noite, 23:59, segundos.
- **EL-DAT-09** (risco) Calendário dentro de modal: abre dentro da área visível; clicar no rodapé do calendário não fecha o modal (clique fora) nem apaga o formulário.
- **EL-DAT-10** (risco) A mesma data mostrada em etapas diferentes (dados × revisão) é igual.
- **EL-DAT-11** (acerto) Troca de idioma → nomes de mês e dia, primeiro dia da semana e formato mudam sem recarregar.
- **EL-DAT-12** (risco) Data relativa ("há 3 dias") e contagem regressiva calculadas pelo relógio: aba em segundo plano não atrasa a contagem.
- **EL-DAT-13** (risco) Sessão aberta na virada do dia → prazos e "atrasado" recalculam.

### 4.6 Select simples — `EL-SEL`

- **EL-SEL-01** (acerto) Cada opção selecionável → enviada com o valor certo (não o rótulo, não o índice).
- **EL-SEL-02** (erro) Placeholder em obrigatório → barra; em opcional, dá para voltar ao vazio.
- **EL-SEL-03** (limite) Lista vazia → mensagem com o motivo; lista com uma opção → vem pré-selecionada (deveria?).
- **EL-SEL-04** (risco) Opções com rótulos idênticos (duas linhas do mesmo produto) → distinguíveis por quantidade, data ou código.
- **EL-SEL-05** (risco) Ordem (alfabética, por código) e itens repetidos.
- **EL-SEL-06** (risco) Opções aparecem sem texto → o componente lê uma propriedade (`name`) e o dado traz outra (`nome`).
- **EL-SEL-07** (risco) Valor salvo que saiu da lista (inativado) → a edição mostra o quê?
- **EL-SEL-08** (acerto) Teclado: abrir com Enter/Espaço/seta, navegar, Esc fecha sem mudar.
- **EL-SEL-09** (risco) Dentro de modal ou tabela: não é cortado (overflow), fica acima de tudo, e ao fechar sai do DOM de verdade (não fica invisível interceptando cliques).
- **EL-SEL-10** (bloqueio) Opções filtradas por papel e tenant → nada de outro tenant.
- **EL-SEL-11** (acerto) Trocar o valor atualiza os campos dependentes (4.16).

### 4.7 Select com busca, combobox — `EL-SBU`

- **EL-SBU-01** (acerto) Buscar e escolher → o item escolhido é o que entra no payload.
- **EL-SBU-02** (risco) Escolher COM a busca ativa, limpar a busca → o item marcado continua o mesmo e é ele que entra (índice da lista filtrada × lista completa).
- **EL-SBU-03** (erro) Busca sem resultado → "nenhum resultado para X", não "não há itens".
- **EL-SBU-04** (acerto) Acento e sem acento, maiúscula e minúscula, espaço nas pontas, trecho do meio da palavra.
- **EL-SBU-05** (acerto) Busca pelos outros campos exibidos (código, documento).
- **EL-SBU-06** (risco) Busca remota: digitar rápido → a resposta antiga não sobrescreve a nova; carregando visível; erro tratado.
- **EL-SBU-07** (risco) Digitar sem escolher e sair do campo → limpa ou deixa texto solto que parece selecionado?
- **EL-SBU-08** (limite) Milhares de opções → rolagem ou paginação; sem travar.

### 4.8 Multi-select, chips, tags — `EL-MSE`

- **EL-MSE-01** (acerto) Nenhum, um, todos → payload é lista (não string concatenada); volta selecionado após F5.
- **EL-MSE-02** (limite) Mínimo e máximo de itens.
- **EL-MSE-03** (acerto) Remover um chip; Backspace remove o último (se esse for o padrão).
- **EL-MSE-04** (risco) Duplicado; tag nova igual a uma existente com outra caixa.
- **EL-MSE-05** (acerto) Chip é `<button>` com `aria-pressed`; selecionado marcado por cor E ícone; texto em caixa normal.
- **EL-MSE-06** (risco) Texto longo no chip; muitos chips (quebra de linha).
- **EL-MSE-07** (risco) Clique sintético muda a cor mas não o estado → confira o payload, não o visual.

### 4.9 Checkbox — `EL-CHK`

- **EL-CHK-01** (acerto) Marcar e desmarcar → persiste; desmarcado vai como `false`.
- **EL-CHK-02** (erro) Aceite obrigatório desmarcado → bloqueia (o `false` não conta como resposta).
- **EL-CHK-03** (acerto) Rótulo clicável; Espaço alterna; foco visível.
- **EL-CHK-04** (risco) "Selecionar todos" com seleção parcial → estado indeterminado coerente.
- **EL-CHK-05** (risco) Marcar um desmarca outro → então é rádio; o visual engana.
- **EL-CHK-06** (risco) Marcado no DOM e desmarcado no estado do framework → o próximo render apaga; confira payload.

### 4.10 Rádio — `EL-RAD`

- **EL-RAD-01** (acerto) Cada opção → payload certo; volta após F5.
- **EL-RAD-02** (erro) Nenhuma marcada em obrigatório → barra.
- **EL-RAD-03** (risco) "Não" em aceite ou termo → passa? Deveria? (a regra decide; se passa e não deveria, é defeito).
- **EL-RAD-04** (risco) Duas cópias do formulário na página com o mesmo `name` → os grupos se fundem e marcar um desmarca o outro.
- **EL-RAD-05** (acerto) Setas do teclado mudam a opção; rótulo clicável.
- **EL-RAD-06** (risco) Rádio estilizado com `<input>` escondido atrás de um botão → o clique no rótulo marca o input mas não o visual (ou o contrário).

### 4.11 Toggle, switch — `EL-TGL`

- **EL-TGL-01** (acerto) Ligar e desligar → persiste; fica claro se grava na hora ou só no Salvar.
- **EL-TGL-02** (risco) Desligar e religar não altera outro atributo (ex.: rebaixa um nível 3 para 1).
- **EL-TGL-03** (risco) "Ligar tudo" em massa → grava o valor certo em cada item.
- **EL-TGL-04** (bloqueio) Desabilitado → motivo visível.
- **EL-TGL-05** (acerto) Teclado; rótulo diz o que "ligado" significa.

### 4.12 Upload de arquivo — `EL-UPL`

- **EL-UPL-01** (acerto) Arquivo válido → sobe, aparece na lista, baixa idêntico (tamanho e hash), nome preservado.
- **EL-UPL-02** (erro) Tipo não permitido por extensão e por conteúdo; extensão dupla; extensão maiúscula.
- **EL-UPL-03** (limite) 0 byte, no limite, acima → mensagem com o limite, de preferência antes de enviar.
- **EL-UPL-04** (risco) Nome com acento, espaço, `..`, `/`, muito longo → salvo e baixado sem quebrar.
- **EL-UPL-05** (risco) Vários arquivos; o mesmo duas vezes; cancelar no meio; rede cai no meio.
- **EL-UPL-06** (risco) SVG ou HTML com script → servido sem executar (`Content-Type` e `Content-Disposition: attachment`).
- **EL-UPL-07** (acerto) Arrastar e soltar, além do clique.
- **EL-UPL-08** (acerto) Excluir → some da lista e do armazenamento; quem pode excluir arquivo de outro?
- **EL-UPL-09** (bloqueio) URL do arquivo sem sessão ou de outro tenant → negada.
- **EL-UPL-10** (acerto) Obrigatoriedade do upload bate com a regra atual (regra mudou e o front ainda exige?).
- **EL-UPL-11** (risco) Pré-visualização de imagem grande e de PDF.

### 4.13 Editor rico, markdown — `EL-RIC`

- **EL-RIC-01** (acerto) Formatação persiste e é exibida igual.
- **EL-RIC-02** (risco) Colar de processador de texto → lixo de estilo controlado.
- **EL-RIC-03** (risco) Link `javascript:` e HTML/script → sanitizados na exibição, no e-mail e no PDF.
- **EL-RIC-04** (limite) Limite conta texto ou HTML? `<p></p>` conta como vazio?
- **EL-RIC-05** (acerto) Desfazer e refazer; imagem colada.
- **EL-RIC-06** (risco) Exibição resumida em lista: sem tags cruas.

### 4.14 Máscara: CPF, CNPJ, telefone, CEP, placa — `EL-MSK`

- **EL-MSK-01** (acerto) Digitar com e sem pontuação; colar formatado e cru → mesmo resultado.
- **EL-MSK-02** (erro) Dígito verificador inválido; todos iguais; curto; longo.
- **EL-MSK-03** (acerto) Alfanumérico onde a norma permite → `inputmode` não força teclado numérico no celular.
- **EL-MSK-04** (risco) Valor enviado com ou sem máscara → consistente com o que o back espera e com o que a busca usa.
- **EL-MSK-05** (acerto) Exibição com máscara em tabela, modal, PDF e exportação, não só no input.
- **EL-MSK-06** (acerto) Busca encontra com e sem máscara.
- **EL-MSK-07** (erro) Duplicidade detectada independentemente da máscara.
- **EL-MSK-08** (risco) Consulta automática por documento (dados oficiais): lenta, fora do ar, devolve campo vazio ou mascarado (`****`) → o campo preenchido continua editável e o placeholder não é gravado.

### 4.15 Autocomplete de entidade — `EL-ACP`

- **EL-ACP-01** (acerto) Escolher → preenche os campos relacionados.
- **EL-ACP-02** (risco) Escolher sobrescreve o que o usuário já tinha digitado? Avisa?
- **EL-ACP-03** (risco) Escolher e depois apagar → os dependentes limpam.
- **EL-ACP-04** (bloqueio) Resultados de outro tenant ou entidade inativa → ausentes.
- **EL-ACP-05** (limite) Mínimo de caracteres para buscar.
- **EL-ACP-06** (risco) Escolher abre um modal obrigatório (ex.: "adicionar responsável") → cancelar o modal deixa o quê?

### 4.16 Campo dependente, condicional ou calculado — `EL-DEP`

- **EL-DEP-01** (acerto) Condição liga → campo aparece e passa a ser obrigatório (se for a regra).
- **EL-DEP-02** (acerto) Condição desliga → o campo some, sai da validação e sai do payload (ou vai o valor neutro definido).
- **EL-DEP-03** (risco) Religar → o valor anterior volta ou zera, conforme a regra.
- **EL-DEP-04** (acerto) Trocar o pai (estado → cidade) limpa o filho.
- **EL-DEP-05** (acerto) Calculado → confira à mão; atualiza ao mudar qualquer entrada; arredonda conforme a regra.
- **EL-DEP-06** (risco) Obrigatório oculto ou com id divergente entre validação e gravação → nunca se satisfaz e trava o envio para sempre.

### 4.17 Senha e campos secretos — `EL-SEG`

Não digite senha: quem loga é o usuário. Verifique sem digitar, e só digite valor de teste do próprio
projeto se o PERFIL autorizar.

- **EL-SEG-01** (acerto) `type=password`; mostrar e ocultar; `autocomplete` adequado (`current-password`, `new-password`, `one-time-code`).
- **EL-SEG-02** (risco) O valor nunca aparece em URL, console, resposta da API, mensagem de erro ou auditoria.
- **EL-SEG-03** (acerto) Regras de complexidade descritas antes do erro; colar permitido (gerenciador de senhas).

### 4.18 Formulário como um todo — `EL-FRM`

- **EL-FRM-01** (acerto) Valores padrão já nascem válidos e coerentes (não nasce reprovado, nem com GUID zero contado como preenchido).
- **EL-FRM-02** (erro) Salvar tudo vazio → TODOS os obrigatórios apontados, sem requisição (não um toast citando 1 de N).
- **EL-FRM-03** (erro) O erro aparece no PRIMEIRO clique (validação que lê estado antigo só mostra no segundo).
- **EL-FRM-04** (erro) Campo com erro destacado, com foco ou rolagem até ele; o destaque some ao corrigir.
- **EL-FRM-05** (erro) Erro do servidor (422) mapeado para o campo certo; mensagem diz o que fazer; dados digitados preservados.
- **EL-FRM-06** (risco) Validação nativa do navegador e validação própria competindo → uma experiência só (`noValidate` + `aria-required` quando a validação é própria).
- **EL-FRM-07** (acerto) Enter envia quando faz sentido; Enter em textarea não envia.
- **EL-FRM-08** (risco) Salvar sem alterar nada → grava? gera auditoria? apaga campo que a tela não carregou (PUT parcial)? Compare o registro inteiro antes e depois.
- **EL-FRM-09** (risco) Sair com alteração não salva (link, voltar, fechar, trocar de aba) → aviso, ou perda documentada.
- **EL-FRM-10** (acerto) Asterisco nos obrigatórios, uma vez só; opcionais sem; a marca bate com a regra do back.
- **EL-FRM-11** (acerto) Criação e edição: campos certos em cada; após criar, redireciona para o registro com id real (não `[object Object]`); mensagem diz "criado" na criação e "atualizado" na edição, com gênero e número certos.
- **EL-FRM-12** (acerto) Depois de criar, os campos automáticos aparecem (código, data, status, autor).
- **EL-FRM-13** (risco) Duas cópias do formulário na página (layout responsivo) não compartilham `id`/`name`.
- **EL-FRM-14** (risco) Envio demorado → "Salvando…", botão desabilitado, um envio só.
- **EL-FRM-15** (risco) Erro de rede no envio → dados preservados, dá para tentar de novo.
- **EL-FRM-16** (risco) O que a tela mostra e o que o payload leva são a mesma coisa → compare campo a campo, inclusive logo após editar rápido e salvar.

### 4.19 Tabela e listagem — `EL-LST`

- **EL-LST-01** (acerto) Carrega com dado real; "N itens" bate com o banco aplicando o filtro de papel e tenant.
- **EL-LST-02** (acerto) Cabeçalhos traduzidos; nenhuma coluna com cabeçalho vazio (chave inexistente); nenhuma coluna sempre vazia.
- **EL-LST-03** (acerto) Números à direita, `tabular-nums`, cabeçalho alinhado ao dado; valores formatados (moeda, data, máscara).
- **EL-LST-04** (acerto) Texto longo truncado com `title`; status como ícone + texto, não só cor.
- **EL-LST-05** (acerto) Linha clicável também pelo teclado; abrir em nova aba funciona.
- **EL-LST-06** (acerto) Atualiza após criar, editar e excluir, sem F5.
- **EL-LST-07** (acerto) Vazio ≠ sem resultado da busca ≠ erro ao carregar (três mensagens diferentes).
- **EL-LST-08** (risco) Carga progressiva ou infinita → total final correto, sem duplicados (confira soma e distintos).
- **EL-LST-09** (limite) Milhares de linhas → não trava; pagina no servidor?
- **EL-LST-10** (acerto) Colunas configuráveis → mostrar e ocultar persiste?

### 4.20 Paginação — `EL-PAG`

- **EL-PAG-01** (limite) Primeira, última, "anterior" na primeira e "próxima" na última (desabilitados).
- **EL-PAG-02** (acerto) Trocar o tamanho da página; total de páginas certo; vazio não mostra "Página 1 de 0".
- **EL-PAG-03** (acerto) Filtrar ou buscar volta para a página 1.
- **EL-PAG-04** (risco) F5 e link direto mantêm a página; página além da última pela URL.
- **EL-PAG-05** (risco) Ordem estável entre páginas: sem repetir nem omitir (ordenação com desempate único).
- **EL-PAG-06** (risco) Paginação no cliente com a lista inteira trafegando → tempo e tamanho anotados.

### 4.21 Ordenação — `EL-ORD`

- **EL-ORD-01** (acerto) Cada coluna ordenável: ascendente, descendente, volta ao padrão.
- **EL-ORD-02** (risco) Coluna numérica ordena como número (10 depois de 9); data como data, não texto `dd/mm`.
- **EL-ORD-03** (risco) Texto com acento e caixa (Á junto de A); nulos sempre no começo ou sempre no fim.
- **EL-ORD-04** (risco) Ordena o conjunto inteiro, não só a página visível.
- **EL-ORD-05** (acerto) Indicador visual e `aria-sort`; a ordem persiste ao voltar para a tela.

### 4.22 Filtro — `EL-FIL`

- **EL-FIL-01** (acerto) Cada valor do filtro; contador muda.
- **EL-FIL-02** (acerto) Filtros combinados (E ou OU?); limpar filtros volta ao total.
- **EL-FIL-03** (acerto) Filtrar pelo card ou KPI dá o mesmo número que o card mostra.
- **EL-FIL-04** (limite) Filtro de data inclusivo nas pontas (o último dia inteiro, até 23:59).
- **EL-FIL-05** (limite) Filtro que não retorna nada; filtro por valor nulo.
- **EL-FIL-06** (risco) Persistência no F5 e na URL, conforme a regra.
- **EL-FIL-07** (bloqueio) Nenhum filtro deixa passar dado de outro tenant.

### 4.23 Busca — `EL-BUS`

- **EL-BUS-01** (acerto) Termo exato, parcial, trecho do meio.
- **EL-BUS-02** (acerto) Acento e caixa: use um termo sem acento que só exista no campo testado (ex.: duas palavras do nome) e o par com acento → as duas buscas devolvem a mesma linha; termo que outra coluna também contém (e-mail, slug) não prova nada (correção da banca).
- **EL-BUS-03** (erro) Espaços nas pontas encontram o mesmo; só espaços mostra tudo, não nada.
- **EL-BUS-04** (risco) Nome com número no meio ("Alfa3", "Grupo 2B") não casa com todas as linhas por uma regra de "só dígitos".
- **EL-BUS-05** (acerto) Documento com e sem máscara.
- **EL-BUS-06** (risco) `%`, `_`, `'`, termo muito longo.
- **EL-BUS-07** (erro) Sem resultado → mensagem cita o termo.
- **EL-BUS-08** (acerto) Cobre as colunas visíveis que o usuário espera.
- **EL-BUS-09** (risco) Contador antes e depois: "N de N" depois de buscar = a busca não filtrou.
- **EL-BUS-10** (risco) Busca durante carga progressiva: busca só no que já chegou? Então fica desabilitada com o motivo.
- **EL-BUS-11** (risco) Digitar rápido: respostas fora de ordem não sobrescrevem a última.
- **EL-BUS-12** (risco) Busca ou deduplicação "por parecido": teste uma paráfrase e um texto sem relação que use palavras comuns → a paráfrase é achada e o texto sem relação fica abaixo do limiar. — Porque: uma razão de sequência dava cerca de 0,5 entre textos sem relação e não achava a paráfrase escrita com outras palavras.

### 4.24 Seleção múltipla e ação em lote — `EL-LOT`

- **EL-LOT-01** (acerto) Selecionar um, vários, todos da página, todos do conjunto → a diferença fica clara.
- **EL-LOT-02** (risco) A seleção sobrevive à troca de página ou de filtro? (Deveria?)
- **EL-LOT-03** (acerto) Ação em lote pede confirmação com a contagem.
- **EL-LOT-04** (erro) Falha parcial → resultado informado item a item.
- **EL-LOT-05** (bloqueio) Autorização do lote = autorização unitária (o back exige o mesmo papel nos dois).
- **EL-LOT-06** (risco) Checkbox de seleção que não liga nenhuma ação → remover ou ligar.
- **EL-LOT-07** (erro) Lote vazio → ação desabilitada.

### 4.25 Exportar CSV, Excel, PDF — `EL-EXP`

- **EL-EXP-01** (acerto) Exporta o filtrado e ordenado (ou tudo, se for a regra) → abra o arquivo e confira linha a linha com a tela.
- **EL-EXP-02** (erro) Sem dados → aviso, não arquivo vazio em silêncio.
- **EL-EXP-03** (acerto) Cabeçalhos traduzidos; números como número; datas como data; moeda com formato e símbolo certos.
- **EL-EXP-04** (risco) Acentos no CSV aberto em planilha (BOM); separador do locale.
- **EL-EXP-05** (risco) Valor começando com `=` neutralizado.
- **EL-EXP-06** (acerto) Nome do arquivo com contexto e data.
- **EL-EXP-07** (limite) Volume grande → não congela a aba.
- **EL-EXP-08** (bloqueio) Só dados permitidos ao papel e ao tenant.
- **EL-EXP-09** (acerto) PDF: quebra de página, cabeçalho repetido, caracteres especiais.

### 4.26 Importar — `EL-IMP`

- **EL-IMP-01** (acerto) Modelo baixável; arquivo válido importa tudo; contagem confere.
- **EL-IMP-02** (erro) Linhas com erro → relatório por linha; parcial ou tudo-ou-nada, conforme a regra.
- **EL-IMP-03** (risco) Duplicados no arquivo e com o banco.
- **EL-IMP-04** (risco) Encoding (UTF-8, Latin-1), separador `;` × `,`, colunas fora de ordem, cabeçalho diferente.
- **EL-IMP-05** (limite) Arquivo enorme; arquivo vazio; só cabeçalho.
- **EL-IMP-06** (risco) Reimportar o mesmo arquivo → idempotente ou duplica?
- **EL-IMP-07** (risco) Datas e números no formato do locale; fórmulas.
- **EL-IMP-08** (acerto) Desfazer importação, se existir.

### 4.27 Modal, drawer, diálogo de confirmação — `EL-MOD`

- **EL-MOD-01** (acerto) Abre pelo gatilho; título bate com o botão que o abriu.
- **EL-MOD-02** (acerto) Esc fecha; X fecha; foco entra no modal e volta ao gatilho ao fechar; Tab preso dentro.
- **EL-MOD-03** (risco) Clique fora fecha e perde o formulário? Clique num popup interno (calendário, select) conta como "fora"?
- **EL-MOD-04** (risco) Rolagem interna sem rolar a página atrás; modal maior que a tela (celular).
- **EL-MOD-05** (acerto) Confirmação destrutiva: botão vermelho, texto com a consequência ("não pode ser desfeita").
- **EL-MOD-06** (acerto) Confirmar → fecha antes de recarregar os dados (não congela com "carregando"); fecha após sucesso.
- **EL-MOD-07** (erro) Erro → modal fica aberto com os dados.
- **EL-MOD-08** (risco) Clique duplo no Confirmar → uma ação só.
- **EL-MOD-09** (risco) Modais aninhados: Esc fecha só o de cima.
- **EL-MOD-10** (risco) Abrir, fechar, abrir → estado limpo ou preservado conforme a regra.
- **EL-MOD-11** (risco) Dois modais em sequência para a mesma decisão → um basta.
- **EL-MOD-12** (acerto) Toast visível acima do modal.

### 4.28 Wizard, etapas — `EL-WIZ`

- **EL-WIZ-01** (erro) Avançar com a etapa inválida → bloqueia e diz o que falta.
- **EL-WIZ-02** (risco) Voltar preserva o que foi digitado.
- **EL-WIZ-03** (risco) Número de etapas estável (etapa que aparece e some enquanto algo carrega).
- **EL-WIZ-04** (acerto) Indicador mostra concluída, atual e pendente por forma, não só por cor.
- **EL-WIZ-05** (risco) Pular etapa pela URL ou pelo indicador → permitido?
- **EL-WIZ-06** (acerto) A revisão final mostra exatamente o que será gravado, nos mesmos formatos; não promete o que o back descarta.
- **EL-WIZ-07** (risco) Campo de "quantidade a alterar": delta ou valor final? A revisão deixa claro.
- **EL-WIZ-08** (erro) Confirmar sem nenhuma alteração → barrado com mensagem.
- **EL-WIZ-09** (risco) F5 ou cancelar no meio → nada gravado (confira no banco).
- **EL-WIZ-10** (risco) Duplo confirmar → uma gravação.

### 4.29 Abas — `EL-ABA`

- **EL-ABA-01** (acerto) Cada aba carrega seu conteúdo.
- **EL-ABA-02** (acerto) A aba ativa é visível e não parece botão de ação.
- **EL-ABA-03** (acerto) A URL reflete a aba; link direto abre a aba; nomes antigos de aba ainda funcionam.
- **EL-ABA-04** (acerto) Contador da aba bate com o conteúdo e atualiza sem F5.
- **EL-ABA-05** (bloqueio) Aba sem permissão oculta ou com motivo.
- **EL-ABA-06** (risco) Trocar de aba com edição não salva.
- **EL-ABA-07** (acerto) Teclado; `role=tablist/tab`, `aria-selected`.
- **EL-ABA-08** (risco) Requisições duplicadas ao abrir a aba; transbordo horizontal em tela estreita.

### 4.30 Menu de linha (⋮), menu de contexto, dropdown de ações — `EL-MNU`

- **EL-MNU-01** (acerto) Abre → confirme pelos itens com `role=menuitem` e pelo print; "não há menu" só depois de ver aberto.
- **EL-MNU-02** (acerto) Cada item faz o que diz, com efeito conferido.
- **EL-MNU-03** (bloqueio) Itens condicionados ao papel e ao estado (Excluir em registro com dependentes; Editar em registro fechado).
- **EL-MNU-04** (risco) Coluna "Ações" sem nenhum item (cabeçalho órfão).
- **EL-MNU-05** (risco) Menu cortado pela tabela (overflow); fecha com clique fora e Esc; teclado.
- **EL-MNU-06** (acerto) O mesmo item tem o mesmo efeito do botão equivalente em outra tela.

### 4.31 Botão e ação — `EL-BTN`

- **EL-BTN-01** (acerto) Efeito conferido em três lugares: rede, banco e tela.
- **EL-BTN-02** (bloqueio) Desabilitado → motivo visível no hover E no toque (sem hover no celular); o motivo é o verdadeiro, inclusive quando o bloqueio vem de um eixo secundário (plano, nível, tier).
- **EL-BTN-03** (bloqueio) Regra de estado: desabilitado = "não pode, e nada que fizer muda isso"; habilitado = "pode; se faltar dado, eu aponto o que falta". Botão cinza que só se explica no hover é achado.
- **EL-BTN-04** (risco) Durante a requisição: "Salvando…", desabilitado, `aria-busy`; reabilita depois de erro.
- **EL-BTN-05** (risco) Clique duplo ou rápido → uma requisição (confira no banco).
- **EL-BTN-06** (risco) Durante o carregamento inicial (esqueleto), ações principais e destrutivas desabilitadas.
- **EL-BTN-07** (acerto) Hierarquia: um primário por área; destrutivo em vermelho; Cancelar secundário.
- **EL-BTN-08** (acerto) Rótulo diz o que faz (verbo + objeto); ação irreversível dita no rótulo ou na confirmação.
- **EL-BTN-09** (acerto) Teclado: foco visível; Enter e Espaço; é `<button>`, não `<span onClick>`.
- **EL-BTN-10** (bloqueio) Ação no registro ainda não salvo (rota de criação) e no registro em estado terminal.
- **EL-BTN-11** (risco) Elemento fixo (chat flutuante, toast, rodapé) não cobre o botão: `document.elementFromPoint` no centro do botão devolve o próprio botão.

### 4.32 Toast, notificação, alerta inline, banner — `EL-TST`

- **EL-TST-01** (acerto) Aparece no lugar padrão da aplicação, inclusive com modal aberto.
- **EL-TST-02** (acerto) Diz o que aconteceu e o que fazer.
- **EL-TST-03** (erro) Sucesso só depois do sucesso real; falha nunca mostra "salvo com sucesso".
- **EL-TST-04** (erro) Erro do servidor com mensagem útil (detalhe por campo), não "Erro inesperado".
- **EL-TST-05** (risco) Dois toasts seguidos → o segundo apaga o primeiro? Alguma mensagem se perde?
- **EL-TST-06** (acerto) Tempo suficiente para ler; fechar manual.
- **EL-TST-07** (risco) A área do toast não engole cliques do que está atrás.
- **EL-TST-08** (acerto) `role=status` ou `role=alert`.
- **EL-TST-09** (acerto) Banner persistente some quando a condição some, sem F5; não aparece em estado onde não se aplica (registro fechado).
- **EL-TST-10** (acerto) Centro de notificações: contador, marcar como lida, link abre o registro certo.

### 4.33 Tooltip, popover — `EL-TIP`

- **EL-TIP-01** (acerto) Aparece no hover e no foco do teclado; no toque existe alternativa.
- **EL-TIP-02** (erro) Conteúdo nunca vazio (tooltip vazio em botão desabilitado).
- **EL-TIP-03** (risco) Não cobre o próprio alvo; não é o único lugar de informação crítica.
- **EL-TIP-04** (risco) O invólucro do tooltip não quebra o alinhamento do conteúdo (coluna numérica à direita).

### 4.34 Link, navegação, breadcrumb — `EL-LNK`

- **EL-LNK-01** (acerto) Destino certo, com id real na URL.
- **EL-LNK-02** (risco) Link externo com `target=_blank` tem `rel="noopener noreferrer"` e indica que sai do sistema.
- **EL-LNK-03** (acerto) Link de e-mail ou notificação abre o registro certo, com e sem sessão (login e volta ao destino).
- **EL-LNK-04** (acerto) Breadcrumb leva aos níveis certos.
- **EL-LNK-05** (erro) Link quebrado → 404 da aplicação, não tela branca.
- **EL-LNK-06** (risco) Parâmetro de redirecionamento aceita só destinos internos (sem open redirect).
- **EL-LNK-07** (risco) Faça HEAD ou GET em cada link externo do alvo, só leitura (`mailto:`, `tel:` e `wa.me` conferidos no formato) → 2xx ou 3xx, domínio do ambiente certo, nenhum link de dev ou de homologação em produção.

### 4.35 Download e arquivo gerado — `EL-DWN`

- **EL-DWN-01** (acerto) Baixa com nome e extensão certos; abre sem corromper; conteúdo confere com a tela.
- **EL-DWN-02** (bloqueio) Nenhum dado de outro tenant no arquivo.
- **EL-DWN-03** (risco) Documentos gerados distintos não saem com o mesmo nome.
- **EL-DWN-04** (risco) Geração lenta → feedback de progresso.
- **EL-DWN-05** (risco) Download automatizado repetido bloqueado pelo navegador é efeito da automação, não defeito; confirme com um clique único.

### 4.36 Gráfico, KPI, card, contador, badge — `EL-KPI`

- **EL-KPI-01** (acerto) O número confere com uma consulta independente (banco ou listagem filtrada pelo mesmo critério).
- **EL-KPI-02** (acerto) Clicar no card filtra a listagem e o total bate.
- **EL-KPI-03** (acerto) Atualiza após ação, sem F5, por TODOS os caminhos (criar, concluir, excluir, mudar estado).
- **EL-KPI-04** (acerto) Zero real ≠ sem dado (`-`).
- **EL-KPI-05** (risco) O rótulo diz o que o número é ("Abertas" não pode mostrar o total; "pendentes" não pode contar todos).
- **EL-KPI-06** (risco) Card sempre zero → suspeite de constante errada, filtro errado ou dado não carregado.
- **EL-KPI-07** (acerto) Unidade e período; gráfico com eixos, legenda, valor exato no tooltip e cores acessíveis.
- **EL-KPI-08** (risco) Número parcial durante carga progressiva → avisado.
- **EL-KPI-09** (risco) Painel com várias chamadas: uma lenta ou travada não zera os outros números.

### 4.37 Estados da tela: vazio, carregando, erro, parcial, sem permissão — `EL-EST`

- **EL-EST-01** (acerto) Vazio explica e oferece a ação certa (não oferece "Adicionar" onde não há botão de adicionar).
- **EL-EST-02** (acerto) Carregando com esqueleto ou indicador; nunca mostra zeros falsos antes do dado real.
- **EL-EST-03** (erro) Erro com mensagem útil e "tentar de novo"; nunca tela branca.
- **EL-EST-04** (erro) Parcial: o que falhou é indicado e o resto funciona.
- **EL-EST-05** (bloqueio) Sem permissão: página dedicada ou redirecionamento, sem vazar dado.
- **EL-EST-06** (risco) O estado de carregamento sempre termina, inclusive quando uma requisição falha no meio.

### 4.38 Arrastar e soltar, reordenar — `EL-DND`

- **EL-DND-01** (acerto) Reordenar persiste após F5.
- **EL-DND-02** (acerto) Alternativa por teclado.
- **EL-DND-03** (risco) Soltar fora da área; arrastar entre listas; rolagem durante o arraste; toque.

### 4.39 Copiar para a área de transferência — `EL-CLP`

- **EL-CLP-01** (acerto) Conteúdo copiado é o atual, inclusive logo depois de uma ação que o regenerou.
- **EL-CLP-02** (acerto) Feedback "copiado".
- **EL-CLP-03** (risco) O que foi copiado funciona colado em outra aba ou navegador.

### 4.40 Link público, token, formulário externo — `EL-PUB`

- **EL-PUB-01** (acerto) Token válido abre o formulário com o contexto certo.
- **EL-PUB-02** (erro) Token inválido, expirado ou já usado → mensagem clara, não formulário vazio.
- **EL-PUB-03** (risco) Reenviar gera token novo e invalida o anterior → a tela interna passa a copiar o novo sem F5.
- **EL-PUB-04** (risco) Envio uma vez só; recarregar depois de enviar mostra "já respondido".
- **EL-PUB-05** (acerto) Recusa ("não quero preencher") grava algo distinguível de "respondido em branco".
- **EL-PUB-06** (risco) A página pública não apaga a sessão de quem está logado no mesmo navegador quando recebe 401.
- **EL-PUB-07** (bloqueio) O externo não vê dado interno.
- **EL-PUB-08** (risco) Validação das duas camadas (nativa e própria) numa experiência só.

### 4.41 Árvore, hierarquia — `EL-ARV`

- **EL-ARV-01** (acerto) Expandir e recolher; nível profundo; item sem filhos.
- **EL-ARV-02** (acerto) Mover entre pais; selecionar o pai seleciona os filhos (se for a regra).
- **EL-ARV-03** (acerto) Busca encontra o filho e expande o caminho.
- **EL-ARV-04** (erro) Ciclo (item filho de si mesmo) barrado.

### 4.42 Timeline, histórico, auditoria — `EL-HIS`

- **EL-HIS-01** (acerto) Cada ação relevante gera registro com autor, data e hora no fuso certo e o que mudou.
- **EL-HIS-02** (acerto) Ordem cronológica; filtros; paginação.
- **EL-HIS-03** (acerto) Falhas também registradas (ex.: "envio falhou").
- **EL-HIS-04** (risco) Sem segredo nem dado pessoal desnecessário.
- **EL-HIS-05** (risco) "De → para" só quando os dois valores são de fato antes e depois.

### 4.43 Elemento fixo e sobreposto — `EL-SOB`

- **EL-SOB-01** (risco) Rodapé, cabeçalho ou botão flutuante fixo não cobre conteúdo nem botão (`elementFromPoint`).
- **EL-SOB-02** (risco) O fim da página é alcançável (espaço inferior suficiente).
- **EL-SOB-03** (risco) Ordem de sobreposição coerente entre modal, toast, dropdown e o fixo.

### 4.44 Imagem e mídia — `EL-MID`

- **EL-MID-01** (acerto) Texto alternativo; imagem quebrada com fallback; avatar sem foto com iniciais.
- **EL-MID-02** (limite) Imagens grandes; carregamento preguiçoso.

---

## 5. Fluxos de negócio recorrentes

### 5.1 Cadastro com documento e consulta automática — `PF-CAD`

- **PF-CAD-01** Documento vazio, inválido, duplicado, de outro tenant, real e novo → cada um com a resposta certa (o duplicado de outro tenant não revela o dono).
- **PF-CAD-02** Consulta automática (órgão oficial, CEP): sucesso, lentidão, fora do ar, campo devolvido vazio ou mascarado → campos editáveis e nenhum placeholder gravado.
- **PF-CAD-03** Responsável ou contato principal: obrigatório; só um principal (marcar outro desmarca o anterior); e-mail e documento validados.
- **PF-CAD-04** Depois de salvar: endereço, contatos e campos opcionais preservados (salvar de novo não apaga).
- **PF-CAD-05** O que acontece depois de criar: tela de confirmação, e-mail, próximo passo — sem mandar para uma tela que exige login que a pessoa ainda não tem.

### 5.2 Solicitação e aprovação — `PF-APR`

- **PF-APR-01** Solicitar → aparece como pendente para o aprovador certo e só para ele.
- **PF-APR-02** Aprovar, rejeitar, aprovar com valor diferente → efeito aplicado, notificação a cada parte, histórico.
- **PF-APR-03** Quem solicita não aprova o próprio pedido (mesmo usuário nas duas pontas, pela UI e pela API).
- **PF-APR-04** O valor pré-preenchido no modal de aprovação é aceito pela validação do próprio modal.
- **PF-APR-05** A lista de pendentes atualiza após aprovar; aprovar duas vezes dá mensagem de negócio.
- **PF-APR-06** Pedido sem saída (não dá para aprovar nem rejeitar por conflito) → é defeito.
- **PF-APR-07** O dado base mudou entre o pedido e a aprovação → a aprovação usa qual valor?
- **PF-APR-08** As respostas do questionário da solicitação ficam gravadas e visíveis ao aprovador, formatadas (data, número, moeda).
- **PF-APR-09** A lista de pendentes é filtrada por tenant mesmo quando montada em segundo plano (sem o usuário da sessão no escopo).

### 5.3 Cancelamento, rescisão, reativação — `PF-CAN`

- **PF-CAN-01** Motivo obrigatório (com asterisco); confirmação destrutiva em vermelho; título e botão com o mesmo verbo.
- **PF-CAN-02** Efeito nos filhos (itens, pedidos, acessos); o que continua visível e editável depois.
- **PF-CAN-03** Efeito imediato ou no fim do ciclo, conforme a regra (cobrança já paga).
- **PF-CAN-04** Cancelamento parcial: o que diminui e o que deve permanecer (contratado × comprometido); mínimo restante.
- **PF-CAN-05** Reativar devolve tudo o que o cancelamento tirou; texto do modal descreve o que de fato acontece.
- **PF-CAN-06** Cancelamento que exige aprovação × aprovado automaticamente → quem tem cada permissão.

### 5.4 Pipeline com etapas (venda, ticket, processo) — `PF-PIP`

- **PF-PIP-01** Promover cada etapa, com as pré-condições de cada uma; o que barra é explicado.
- **PF-PIP-02** Pular etapa, voltar etapa, tentar a etapa final direto.
- **PF-PIP-03** Fechamentos alternativos (ganho, perda, cancelamento) → cada um com registro novo; o que cada um gera (documento, contrato, notificação) aberto e conferido.
- **PF-PIP-04** Questionário de perda ou cancelamento: obrigatórios, cancelar o questionário não deixa a etapa marcada como erro.
- **PF-PIP-05** Regras por papel em cada etapa (quem pode promover, quem pode fechar), na UI e na API.
- **PF-PIP-06** Cards e filtros por etapa contam cada registro uma vez, no balde certo.
- **PF-PIP-07** Ações disponíveis num registro fechado (excluir registro que gerou documento?).

### 5.5 Convite, primeiro acesso, ativação — `PF-ACE`

- **PF-ACE-01** Convite: e-mail chega (quando autorizado), link abre, expira, não reabre depois de usado.
- **PF-ACE-02** Primeiro acesso força o que a regra manda (troca de senha, segundo fator) — sem digitar senha: peça ao usuário.
- **PF-ACE-03** Papéis iniciais clonados do modelo certo; nada a mais, nada a menos.
- **PF-ACE-04** Etapas da ativação avançam sem F5 e na ordem certa; nenhuma é pulada.

### 5.6 Pedido, saldo, cobrança e faturamento — `PF-FAT`

- **PF-FAT-01** Quantidades: contratada, comprometida, disponível, em uso — cada uma confere com a soma dos itens ativos (cancelados fora).
- **PF-FAT-02** Pedido acima do saldo; item de recorrência diferente (mensal × anual) com regras diferentes.
- **PF-FAT-03** Primeira cobrança, próxima cobrança, pro rata, vencimento no fim do mês.
- **PF-FAT-04** O preço histórico do pedido não muda quando a tabela de preço muda.
- **PF-FAT-05** Total = soma das linhas; impostos, descontos e moeda conferidos à mão.
- **PF-FAT-06** "Sem dado de uso" exibido como `-`, não como `0`.

### 5.7 Alteração versionada (aditivo, revisão, nova versão) — `PF-VER`

- **PF-VER-01** Cada tipo de alteração disponível ao papel → aplica de verdade no registro principal, não só registra a alteração.
- **PF-VER-02** A revisão mostra o que será gravado; delta × valor final claro.
- **PF-VER-03** A alteração cria uma segunda linha do mesmo item? É a regra? Os totais tratam certo?
- **PF-VER-04** Elegibilidade: quais itens podem sofrer cada operação (o filtro de elegíveis pode excluir tipos inteiros).
- **PF-VER-05** Alteração que exige aprovação vira solicitação, com o que foi pedido gravado.
- **PF-VER-06** Desfazer pela interface uma alteração feita por engano: existe caminho?

### 5.8 Tarefas, follow-ups, comentários — `PF-TAR`

- **PF-TAR-01** Criar (título obrigatório, vencimento, prioridade, tipo) vinculado à entidade certa.
- **PF-TAR-02** "Atrasado" só quando atrasado; vencimento hoje não é atrasado.
- **PF-TAR-03** Concluir: só quem pode (criador, responsável ou admin, conforme a regra), por TODOS os caminhos (botão e combo de status).
- **PF-TAR-04** Editar, excluir, atribuir; contadores do cabeçalho atualizam por todos os caminhos.
- **PF-TAR-05** Visibilidade: a lista mostra o mesmo que a API devolve ao papel.

### 5.9 Plano, assinatura, limite de uso — `PF-PLA`

- **PF-PLA-01** Limite do plano atingido → mensagem e caminho para resolver.
- **PF-PLA-02** Período de teste expirado → redireciona para a página de assinatura sem quebrar o resto.
- **PF-PLA-03** Recurso bloqueado pelo plano explicado no motivo do botão.

---

## 6. Dimensões transversais

### 6.1 Navegação e roteamento — `DM-NAV`

- **DM-NAV-01** Link direto para cada tela, aba e registro, logado e deslogado → deslogado vai ao login e volta ao destino.
- **DM-NAV-02** F5 em cada tela e no meio de cada fluxo → documente o que persiste e o que se perde.
- **DM-NAV-03** Voltar e avançar do navegador depois de salvar, abrir modal, trocar de aba, filtrar.
- **DM-NAV-04** Abrir em nova aba (Ctrl+clique, botão do meio) funciona em links e linhas de lista (são `<a>`).
- **DM-NAV-05** Rota inexistente → 404 da aplicação; registro inexistente → mensagem, não tela vazia.
- **DM-NAV-06** Sentinela na URL (`novo`, `undefined`, `[object Object]`) não dispara chamadas com id inválido.
- **DM-NAV-07** Redirecionamentos preservam a mensagem necessária (ex.: "sessão expirada").
- **DM-NAV-08** Navegar com requisição em andamento → a resposta tardia não sobrescreve a tela nova.
- **DM-NAV-09** Menu: item ativo correto; itens por papel.

### 6.2 Estado e persistência — `DM-PER`

- **DM-PER-01** Salvar e recarregar → tudo volta igual (tela, leitura da API, banco).
- **DM-PER-02** Tela e payload leem a mesma fonte → compare campo a campo.
- **DM-PER-03** Editar várias vezes → uma linha no banco com o valor novo (sem linhas duplicadas; a leitura não devolve a antiga).
- **DM-PER-04** Estado local (filtros, colunas, aba, rascunho) persiste onde a regra diz; com o armazenamento local limpo, a tela funciona.
- **DM-PER-05** Dado derivado regenerado por uma ação (token, código, total) atualiza na tela sem F5.
- **DM-PER-06** Edição perdida ao trocar de aba ou fechar → avisada.
- **DM-PER-07** Depois de um deploy, a versão nova carrega (sem tela branca por arquivo antigo em cache).

### 6.3 Idempotência, clique duplo, reentrada — `DM-IDE`

- **DM-IDE-01** Clique duplo em todo botão que grava (Salvar, Confirmar, Aprovar, Enviar, Pagar) → uma gravação, conferida no banco.
- **DM-IDE-02** Enter repetido no formulário.
- **DM-IDE-03** Repetir a mesma requisição (retry) → servidor idempotente onde deve (constraint única, chave de idempotência).
- **DM-IDE-04** Repetir uma ação já concluída (aprovar o aprovado) → mensagem de negócio, não 500.
- **DM-IDE-05** Transição aplicada duas vezes → sem efeito duplicado (dois e-mails, dois registros).
- **DM-IDE-06** Requisição longa + usuário recarrega a página → o que acontece com a primeira?

### 6.4 Concorrência — `DM-CON`

- **DM-CON-01** Duas abas do mesmo usuário editando o mesmo registro → conflito avisado, ou "último vence" documentado; nada perdido em silêncio.
- **DM-CON-02** Um usuário exclui enquanto outro edita e salva.
- **DM-CON-03** Dois aprovadores aprovam a mesma solicitação ao mesmo tempo.
- **DM-CON-04** Saldo, estoque ou limite consumido em paralelo → duas requisições simultâneas não passam do limite.
- **DM-CON-05** Lista aberta enquanto outra aba cria ou exclui → ação sobre item já excluído dá mensagem clara.
- **DM-CON-06** Dois usuários diferentes no mesmo navegador (cookie compartilhado, armazenamento por aba) → cada aba age como o usuário dela.

### 6.5 Sessão e autenticação — `DM-SES`

- **DM-SES-01** Responda 401 na próxima chamada da ação (`route.fulfill` com status 401) no meio do fluxo → a tela renova sozinha e conclui, ou leva ao login com mensagem e volta ao destino; nenhuma requisição fica pendurada para sempre. Como provocar: `execucao-e-evidencias.md` §3.10 (só no perfil de QA do Playwright ou em aba de teste, nunca na sessão logada do usuário).
- **DM-SES-02** Sem renovação possível → login, sem laço.
- **DM-SES-03** Logout em outra aba → esta aba reage na próxima ação.
- **DM-SES-04** Token alterado ou invalidado → 401 tratado.
- **DM-SES-05** Permissão alterada → vale na hora ou só após novo login (documente).
- **DM-SES-06** Página pública que recebe 401 não apaga a sessão guardada.
- **DM-SES-07** "Lembrar-me" ligado e desligado: onde a sessão fica e quanto dura.
- **DM-SES-08** Recuperação de senha (sem digitar senha): mensagem neutra para conta inexistente; reenvio com espera; erro real quando o envio falha; a senha antiga não é perdida se o envio falhar.
- **DM-SES-09** Segundo fator: código errado, expirado, reenviar.
- **DM-SES-10** Tela autenticada sem sessão → login, sem mostrar dado por um instante.

### 6.6 Autorização: papéis, permissões, flags — `DM-AUT`

- **DM-AUT-01** Matriz RBAC completa (2.7) para cada ação sensível.
- **DM-AUT-02** Cada permissão granular com e sem a flag global ("lê tudo", "bloqueia escrita"); teste inverso: remover a permissão → a ação some ou é barrada.
- **DM-AUT-03** O nível exigido pelo código é concedível pela tela de perfis.
- **DM-AUT-04** Ação escondida no front chamada direto na API com a sessão do papel sem permissão → o back barra? Se a regra é só de front, registre isso explicitamente.
- **DM-AUT-05** O mesmo efeito por dois caminhos → os dois protegidos.
- **DM-AUT-06** Autorização de lote = unitária.
- **DM-AUT-07** Segregação de funções: quem solicita não aprova.
- **DM-AUT-08** Durante o carregamento das permissões, nada fica liberado (falha fechada).
- **DM-AUT-09** Bloqueio por eixo secundário (plano, nível, tier) explicado no motivo, não só "sem permissão".
- **DM-AUT-10** Permissões checadas pelo front que não existem no cadastro (só passam por flag global).
- **DM-AUT-11** Campo travado por papel: o back ignora ou recusa o valor enviado.
- **DM-AUT-12** Telas administrativas (organização, perfis, configurações) inacessíveis ou vazias para papel externo.
- **DM-AUT-13** Nome de permissão que engana (o nome sugere o oposto do que libera) → teste o efeito, não o nome.

### 6.7 Isolamento multi-tenant e IDOR — `DM-TEN`

- **DM-TEN-01** Em toda tela: nenhum dado de outro tenant em listas, combos, avisos, contadores, gráficos, exportações e e-mails.
- **DM-TEN-02** Trocar o id na URL e na requisição por um de outro tenant (detalhe, editar, excluir, anexos, sub-recursos) → 403 ou 404, nunca 200 com dado.
- **DM-TEN-03** Endpoints "todos", "pendentes", "busca", "exportar", "estatísticas" filtram pelo tenant da sessão.
- **DM-TEN-04** Listagem vazia para o papel mas acesso direto por URL abre (e o inverso).
- **DM-TEN-05** Painel ou relatório embutido (link público) não mostra números da plataforma inteira.
- **DM-TEN-06** Anexo de outro tenant acessível por URL adivinhável.
- **DM-TEN-07** Criar registro apontando para entidade de outro tenant → recusado.
- **DM-TEN-08** Campo de tenant ou dono enviado no corpo (mass assignment) → ignorado.
- **DM-TEN-09** BaaS (Firebase/Firestore, Supabase, Appwrite): para cada coleção ou tabela, use o SDK ou o REST com a chave pública + a própria sessão → ler, listar e (em teste, com autorização) gravar linha de outro usuário é negado; listar sem filtro devolve só as próprias; bucket de storage idem.

### 6.8 Segurança — `DM-SEC`

Só em ambiente de teste e dentro do que o PERFIL autoriza. A prova é a resposta, não o estrago.

- **DM-SEC-01** XSS armazenado: payload em todo campo de texto → aparece como texto em toda saída (lista, detalhe, tooltip, título, e-mail, PDF, notificação, exportação).
- **DM-SEC-02** XSS refletido: parâmetros de URL e mensagens de erro que repetem a entrada.
- **DM-SEC-03** Injeção (SQL, NoSQL, comando, template) em busca, filtro e ordenação (`sort` com coluna arbitrária) → erro de validação, sem rastro de pilha.
- **DM-SEC-04** Open redirect em `redirect`, `returnUrl`, `next`.
- **DM-SEC-05** Upload malicioso (4.12).
- **DM-SEC-06** Mass assignment: campos extras no corpo (`isAdmin`, `tenantId`, `status`, `preco`) → ignorados.
- **DM-SEC-07** Dado sensível na resposta (hash de senha, token, dado de outro usuário, campo interno), na URL, no console, na mensagem de erro (pilha, SQL, caminho do servidor).
- **DM-SEC-08** Segredo embutido no código do front (chave de API de terceiro) → liste onde está, sem copiar o valor.
- **DM-SEC-09** Cabeçalhos: CSP, `frame-ancestors` (exceto rotas de embed), HSTS; cookies `HttpOnly`, `Secure`, `SameSite`.
- **DM-SEC-10** CSRF em ações autenticadas por cookie.
- **DM-SEC-11** Limite de taxa em login, recuperação de senha, envio de código ou e-mail e busca pesada (rajada pequena, com autorização).
- **DM-SEC-12** Enumeração de contas: mensagem ou tempo diferentes para conta existente e inexistente.
- **DM-SEC-13** CORS aceita origem arbitrária com credenciais?
- **DM-SEC-14** Dependências com vulnerabilidade conhecida (auditoria do gerenciador de pacotes, somente leitura).
- **DM-SEC-15** Segredos e strings de conexão em texto puro em arquivos versionados → relate a existência, nunca copie o valor.

Automação e varredura funda: §11.6 (`MA-6`) — `segredos.py` para DM-SEC-08/15, auditoria de
dependências para DM-SEC-14, matriz endpoint × proteção e IDOR em todo endpoint com id. Massa
hostil sistematizada para DM-SEC-01/03/06: §12.3 (`MO-9`, `fuzz_valores.py`).

### 6.9 Integridade de dados — `DM-INT`

- **DM-INT-01** O que NÃO deveria mudar não muda: depois de salvar uma tela, compare o registro inteiro (e os relacionados) antes e depois — campo não exibido não pode ser apagado.
- **DM-INT-02** Excluir: cascata certa e sem órfãos (procure o id em todas as tabelas filhas), ou bloqueio com mensagem de negócio quando há dependentes.
- **DM-INT-03** Exclusão lógica ou física conforme a regra; o excluído some de listas, buscas, combos, contadores e relatórios.
- **DM-INT-04** Soma das partes = total (linhas, cabeçalho, relatório); inativos e cancelados fora das somas onde a regra diz.
- **DM-INT-05** Duplicidade barrada no back (constraint), não só no front; variações de caixa, espaço e máscara.
- **DM-INT-06** Trocar o pai atualiza os filhos; registro apontando para entidade inativa.
- **DM-INT-07** Dado legado que viola a regra atual: editar outro campo não fica bloqueado; exibição não quebra.
- **DM-INT-08** Valores monetários em decimal, sem erro de ponto flutuante acumulado.
- **DM-INT-09** Campos de auditoria (criado por, criado em, alterado por, alterado em) preenchidos certo.
- **DM-INT-10** Operação com várias escritas: falha no meio não deixa meio-gravado (transação).

### 6.10 Efeitos a jusante — `DM-JUS`

Para cada ação com efeito: disparou? para quem? conteúdo certo? uma vez só? a falha do efeito trata a
ação principal como a regra diz?

- **DM-JUS-01** E-mail: destinatários certos e só eles (ambiente de teste não atinge pessoas reais fora das caixas autorizadas).
- **DM-JUS-02** E-mail: assunto e corpo identificam o registro (nome, código, ambiente); placeholders resolvidos (sem `%NOME%`, `{{x}}`); links abrem o registro certo no ambiente certo; idioma; remetente e domínio.
- **DM-JUS-03** E-mail: envio e falha registrados na auditoria; quando o envio é real e autorizado, peça ao usuário para conferir a caixa.
- **DM-JUS-04** Notificação no sistema: destinatários, link, contador; o mesmo fato não gera dois avisos por eventos equivalentes (conte por destinatário e por evento).
- **DM-JUS-05** Registros gerados (pedido, contrato, fatura, documento): abra e confira o conteúdo, não só a existência.
- **DM-JUS-06** Integração externa (webhook, provisionamento, pagamento): só com autorização; payload enviado, resposta, retry; falha não deixa estado meio-gravado.
- **DM-JUS-07** Preferências de notificação: desligar impede; sem preferência, o padrão faz o que a regra diz.
- **DM-JUS-08** Ordem das operações: efeito irreversível (trocar senha, cobrar, enviar) antes de um passo que pode falhar → procure compensação.
- **DM-JUS-09** Efeito assíncrono que sai minutos depois → espere e confira; não conclua ausência cedo.

### 6.11 Valores padrão, nulos e tipos — `DM-NUL`

- **DM-NUL-01** `0` válido não vira vazio ou padrão (`x || padrão`); enum com valor 0.
- **DM-NUL-02** String vazia, `null` e campo ausente no payload → o back trata igual?
- **DM-NUL-03** Array vazio tratado como "tem dado" (`if (lista)`); resposta "não encontrado" com 200 e lista vazia.
- **DM-NUL-04** GUID zero contado como preenchido.
- **DM-NUL-05** `undefined`, `null`, `NaN`, `[object Object]` na tela, na URL ou no payload.
- **DM-NUL-06** Booleano desmarcado = `false`; aceite obrigatório considera `false` como não aceito.
- **DM-NUL-07** Data nula exibida como `-`, nunca 01/01/1970 nem 0001-01-01.
- **DM-NUL-08** Número nulo (`-`, sem dado) ≠ zero medido.
- **DM-NUL-09** Novo registro nasce válido e coerente.

### 6.12 Textos, i18n e l10n — `DM-I18`

- **DM-I18-01** Troque o idioma PELA TELA para cada idioma suportado, em cada tela do escopo → nenhuma chave crua (`modulo.tela.chave`), nenhum texto cravado no idioma padrão, nenhum rótulo em branco.
- **DM-I18-02** Texto vindo do banco (cadastro) não traduz → ao relatar, separe dado de código.
- **DM-I18-03** Datas, números, moeda, nomes de mês e dia no formato do locale; o que deriva do idioma recalcula ao trocar, sem recarregar.
- **DM-I18-04** Plural e singular ("1 itens"), gênero ("adicionado" × "adicionada"), concordância.
- **DM-I18-05** Acentos e ortografia em todos os idiomas; blocos inteiros faltando em algum idioma.
- **DM-I18-06** Textos longos (francês, alemão) cabem nos botões; CJK; RTL se suportado.
- **DM-I18-07** Mesma chave usada em contextos com sentidos diferentes → renomear o texto quebra o outro uso.
- **DM-I18-08** Mensagens de erro do back traduzidas ou neutras.
- **DM-I18-09** E-mails e PDFs no idioma do destinatário.
- **DM-I18-10** Terminologia: a mesma coisa com o mesmo nome em todas as telas.

### 6.13 Acessibilidade — `DM-A11`

- **DM-A11-01** Tab alcança todo controle na ordem visual; sem armadilha de foco fora de modal.
- **DM-A11-02** Foco visível em tudo, com contraste.
- **DM-A11-03** Enter e Espaço ativam; Esc fecha modal, menu e popover.
- **DM-A11-04** Controle clicável é `<button>` ou `<a>`, não `<span>`/`<div>` com onClick.
- **DM-A11-05** Todo campo com rótulo visível (`<label>` associado; placeholder não conta como rótulo); botão de ícone com `aria-label`; imagem com `alt`.
- **DM-A11-06** Obrigatório anunciado (`aria-required`); erro ligado ao campo (`aria-invalid`, `aria-describedby`).
- **DM-A11-07** Contraste WCAG AA medido com a cor real do tema: texto 4,5:1 (3:1 se grande), ícones e bordas de controle 3:1; sobre fundo configurável pelo cliente, o conteúdo tem superfície própria.
- **DM-A11-08** Cor nunca é o único canal (status com ícone ou texto; etapa com forma).
- **DM-A11-09** Um `h1` por página, `h2` nas seções; landmarks (`main`, `nav`).
- **DM-A11-10** ARIA dos componentes: `tablist/tab`, `aria-selected`, `aria-expanded`, `aria-sort`, `role=status/alert`, `aria-busy`.
- **DM-A11-11** Zoom de 200% sem perder conteúdo.
- **DM-A11-12** `prefers-reduced-motion` respeitado; nada pisca mais de 3 vezes por segundo.
- **DM-A11-13** Alvo de toque com pelo menos 24×24 px (ideal 44×44) nas telas de celular.
- **DM-A11-14** Emoji usado como ícone (lido em voz alta, desenho muda por sistema).

Automação: §12.2 (`MO-8`, `axe-inject.js`). O axe não substitui DM-A11-01 a -06 e -11 a -13:
eles continuam manuais, com caso próprio. O -05 entra na lista porque o axe aceita o placeholder como
nome acessível e aprova campo obrigatório sem rótulo visível (rótulo visível; placeholder não conta
como rótulo).

### 6.14 Responsivo e layout — `DM-RES`

- **DM-RES-01** Larguras reais: 360/390, 768, 1024, 1280, 1440, 1920 → confirme `innerWidth` e `matchMedia` (zoom do navegador não é viewport).
- **DM-RES-02** Sem rolagem horizontal da página; tabelas com rolagem própria; nada cortado.
- **DM-RES-03** Cada bloco troca de layout no breakpoint certo.
- **DM-RES-04** Modais e calendários cabem na altura; o teclado virtual não cobre o campo.
- **DM-RES-05** Nomes longos, números grandes, muitos itens.
- **DM-RES-06** Rotação (celular e tablet).
- **DM-RES-07** Se a tela é impressa, emule a mídia de impressão (`page.emulateMedia({ media: 'print' })` ou a prévia do Ctrl+P) → nada cortado, sem menu nem botão na folha, tabela quebra entre linhas. Como provocar: `execucao-e-evidencias.md` §3.10 (só no perfil de QA do Playwright ou em aba de teste, nunca na sessão logada do usuário).

### 6.15 Desempenho — `DM-DES`

- **DM-DES-01** Tempo de cada requisição: anote as acima de 3 s; acima de 10 s é achado. Tempo até a primeira linha e até completar.
- **DM-DES-02** Número de requisições por carga de tela: duplicadas, N iguais, N+1 por linha. Separe efeito do modo de desenvolvimento (efeitos dobrados) confirmando no build.
- **DM-DES-03** Endpoint sem paginação devolvendo milhares; tamanho do payload.
- **DM-DES-04** Digitação lenta ou erro de "atualizações aninhadas demais" depois de ~50 teclas em ritmo humano.
- **DM-DES-05** Aba congelada com listas grandes; memória crescendo ao navegar.
- **DM-DES-06** Painel com várias chamadas: a mais lenta não segura as outras.
- **DM-DES-07** Busca e filtro em listas grandes.
- **DM-DES-08** Ações que disparam efeitos em série dentro da requisição.
- **DM-DES-09** Primeira carga depois de deploy ou reinício.
- **DM-DES-10** Registre o ambiente junto do número (local contra banco remoto infla os tempos).

Medição sistematizada (passiva sempre; Lighthouse, bundle e SQL quando ligados): §12.4 (`MO-10`).

### 6.16 Resiliência e falhas — `DM-FAL`

- **DM-FAL-01** Responda 500 (ou aborte com `route.abort`) na chamada principal da tela com `route.fulfill` → a tela mostra erro que orienta, sem tela branca nem laço, e nada fica meio gravado. Como provocar: `execucao-e-evidencias.md` §3.10 (só no perfil de QA do Playwright ou em aba de teste, nunca na sessão logada do usuário).
- **DM-FAL-02** 500 em cada chamada principal (simule com interceptação, se der) → erro útil; o resto da tela funciona.
- **DM-FAL-03** Atrase a resposta da chamada (`route` com espera antes do `continue`, ou rede lenta emulada) até passar do timeout → carregamento visível, botão travado, sem envio duplicado e mensagem de tempo esgotado. Como provocar: `execucao-e-evidencias.md` §3.10 (só no perfil de QA do Playwright ou em aba de teste, nunca na sessão logada do usuário).
- **DM-FAL-04** Ponha o contexto offline (`context.setOffline(true)`) entre preencher e enviar → dados do formulário preservados, mensagem clara e dá para tentar de novo quando voltar. Como provocar: `execucao-e-evidencias.md` §3.10 (só no perfil de QA do Playwright ou em aba de teste, nunca na sessão logada do usuário).
- **DM-FAL-05** Resposta em formato inesperado (campo nulo, lista vazia, 200 sem corpo).
- **DM-FAL-06** Serviço externo fora (consulta, e-mail, provedor) → a ação principal segue ou falha conforme a regra, com mensagem verdadeira.
- **DM-FAL-07** Mensagem genérica que esconde a causa → diga onde está o log real, ou que ele não existe.
- **DM-FAL-08** A API volta → a tela volta a funcionar sem novo login.
- **DM-FAL-09** Estado de carregamento sempre termina, inclusive com erro no meio.

### 6.17 Datas, horas e fusos — `DM-DTH`

- **DM-DTH-01** Data pura (dia civil) nunca passa por conversão de fuso.
- **DM-DTH-02** Rode o navegador em outro fuso (`timezoneId` do contexto do Playwright) e, onde der, o servidor em fuso diferente → datetime gravado em UTC (ou documentado) e exibido no fuso do usuário; o mesmo registro mostra a mesma hora local nas duas sessões. Como provocar: `execucao-e-evidencias.md` §3.10 (só no perfil de QA do Playwright ou em aba de teste, nunca na sessão logada do usuário).
- **DM-DTH-03** "Atrasado" e vencimentos calculados no dia certo; fim de dia inclusivo.
- **DM-DTH-04** Vigências com meses de 28/29/30/31 e ano bissexto; renovação.
- **DM-DTH-05** Filtros por período: inclusivos e com fuso aplicado.
- **DM-DTH-06** Relatório mensal: a virada do mês acontece no fuso certo.
- **DM-DTH-07** Jobs agendados no horário e fuso certos.
- **DM-DTH-08** Ordenação por data real, não por texto.

### 6.18 Cálculo, arredondamento e moeda — `DM-CAL`

- **DM-CAL-01** Confira à mão toda conta exibida: quantidade × unitário, subtotal, desconto, imposto, margem, comissão, total, pro rata, percentual.
- **DM-CAL-02** Regra de arredondamento (por linha ou no total; meio para cima ou bancário) e casas decimais; soma das linhas = total exibido.
- **DM-CAL-03** Desconto: 0%, 100%, acima de 100%, preço final abaixo do custo.
- **DM-CAL-04** Moedas diferentes nunca somadas sem conversão.
- **DM-CAL-05** Períodos (mensal, anual, N meses) aplicados nas contas.
- **DM-CAL-06** Itens cancelados e inativos entram nas contas só se a regra mandar.
- **DM-CAL-07** A mesma conta em tela, PDF, e-mail, exportação e back dá o mesmo resultado.

### 6.19 Design e consistência visual — `DM-VIS`

- **DM-VIS-01** Sinais de "feito por IA": ícone decorativo colorido em todo título; subtítulo que repete o título; rótulo sobre rótulo; frase redundante em modal; emoji no lugar de ícone; gradiente e animação sem função; toast genérico.
- **DM-VIS-02** Hierarquia: um primário por área; Cancelar sem peso de ação; destrutivo em vermelho; aba ativa sem aparência de botão de ação.
- **DM-VIS-03** Cor é canal de STATUS, não de tipo de dado: valor monetário e quantidade em texto neutro; o mesmo status com a mesma cor em toda a aplicação; a mesma cor não carrega dois sentidos na mesma tela.
- **DM-VIS-04** Consistência: o mesmo botão com o mesmo estilo e rótulo em todas as telas; espaçamento, raio e fonte dentro da escala do design system; uma linguagem de elevação (borda ou sombra, não as duas).
- **DM-VIS-05** Números à direita, `tabular-nums`, sem quebra de linha.
- **DM-VIS-06** Erro exibido antes da interação (campo vermelho ao abrir a tela).
- **DM-VIS-07** Caixa alta forçada em texto longo; texto cortado; desalinhamentos.
- **DM-VIS-08** Sugestões sempre dentro do design system do projeto (ver o PERFIL); nunca paleta nova.

### 6.20 Componentes compartilhados e regressão — `DM-CMP`

- **DM-CMP-01** Componente ou utilitário alterado (ou suspeito): liste os usos, agrupe por configuração e teste ao menos um uso real de cada grupo, na tela de produto.
- **DM-CMP-02** Prop descartada em silêncio por um construtor que reescreve o objeto com lista fixa de campos.
- **DM-CMP-03** Função copiada em várias telas: a correção chegou a todas as cópias?
- **DM-CMP-04** A mesma regra em duas constantes ou arquivos: valores iguais?
- **DM-CMP-05** Mudança de padrão de um componente afeta telas que dependiam do comportamento antigo.

### 6.21 Logs, observabilidade e mensagens de erro — `DM-LOG`

- **DM-LOG-01** Console do navegador sem erro ou aviso novo na tela testada (chave duplicada, hidratação, atualizações aninhadas, 404 de recurso).
- **DM-LOG-02** Erro do servidor registrado com a causa real (não engolido por um filtro que só lê a mensagem genérica); identificador da requisição disponível ao suporte.
- **DM-LOG-03** Logs sem segredo nem dado pessoal.
- **DM-LOG-04** `console.log` e depuração esquecidos no código.
- **DM-LOG-05** Ações sensíveis auditadas.
- **DM-LOG-06** A mensagem mostrada ao usuário permite ao suporte diagnosticar.

### 6.22 Consistência entre lugares e camadas — `DM-CNS`

- **DM-CNS-01** A tela não se contradiz (ícone × texto; badge × número).
- **DM-CNS-02** O mesmo número em card, listagem filtrada, detalhe, relatório, exportação e e-mail.
- **DM-CNS-03** A mesma regra no front e no back (limite, obrigatoriedade, formato, mensagem).
- **DM-CNS-04** A revisão e a confirmação mostram o que de fato será gravado.
- **DM-CNS-05** O histórico mostra o que de fato mudou; "de → para" com o valor anterior real.
- **DM-CNS-06** Campo com o mesmo nome e sentidos diferentes em módulos diferentes → o oráculo é a regra que relaciona os campos, não o nome.

### 6.23 Ambiente e configuração — `DM-AMB`

- **DM-AMB-01** Antes de qualquer escrita, meça para onde a aplicação aponta (URL da API na aba de rede, banco conectado) — ler o arquivo de configuração não basta.
- **DM-AMB-02** Produção é somente leitura; ambiente de teste compartilhado: mínimo de sujeira, toda ela registrada.
- **DM-AMB-03** Códigos e ids que se repetem entre ambientes → cite sempre o ambiente junto.
- **DM-AMB-04** Flags e variáveis que mudam comportamento; diferenças entre modo de desenvolvimento e build.
- **DM-AMB-05** Build que ignora erros de tipo → typecheck rodado à parte (seção 8).
- **DM-AMB-06** Versões de navegador e runtime anotadas na evidência.
- **DM-AMB-07** Alterne cada feature flag do alvo (painel de flags ou configuração do ambiente de teste) → as duas variantes da tela funcionam, cada uma sem resto da outra; flag que não dá para alternar vira `bloqueado` dizendo o que falta.

### 6.24 Privacidade e dados pessoais — `DM-PRI`

- **DM-PRI-01** Dado pessoal só para quem precisa; mascarado onde a regra pede (tela, exportação, e-mail).
- **DM-PRI-02** Dado pessoal fora de URL e de log.
- **DM-PRI-03** Consentimento ou aceite registrado com data e versão do termo.
- **DM-PRI-04** Exclusão ou anonimização a pedido alcança anexos e relacionados.
- **DM-PRI-05** Prints de evidência sem dado pessoal real desnecessário.

### 6.25 Cache e dado obsoleto — `DM-CAC`

- **DM-CAC-01** Depois de cada ação, lista, KPI e detalhe mostram o novo, sem F5, por todos os caminhos.
- **DM-CAC-02** Cache de cliente com validade: invalidado em criar, editar e excluir; alteração de configuração aparece quando a regra diz.
- **DM-CAC-03** Ação sobre dado velho numa segunda tela aberta → tratada.
- **DM-CAC-04** Service worker ou CDN servindo versão antiga depois de deploy.

### 6.26 Compatibilidade — `DM-COM`

- **DM-COM-01** Navegadores-alvo (Chrome, Edge, Firefox, Safari) nas versões mínimas.
- **DM-COM-02** Tema escuro do sistema; fonte maior do sistema; zoom.
- **DM-COM-03** Idioma do navegador × idioma da conta.
- **DM-COM-04** Bloqueadores de conteúdo (iframes, scripts de terceiros).

---

## 7. Por tipo de projeto

### 7.1 API e backend — `PJ-API`

- **PJ-API-01** Contrato de cada endpoint: tipos, obrigatórios, nulos, enums na requisição e na resposta; campos extras ignorados; o mesmo envelope de erro em todos.
- **PJ-API-02** Códigos HTTP corretos: 200/201/204; 400 ou 422 para validação; 401 só para falta de autenticação (nunca para validação — o cliente pode deslogar); 403 sem permissão; 404 inexistente (não 200 vazio); 409 conflito ou duplicado; 413 payload grande; 415 tipo; 429 limite; 5xx só para falha real.
- **PJ-API-03** Validação no servidor de cada regra que o front aplica.
- **PJ-API-04** Varredura de autorização: lista de endpoints × exige sessão? × papel? × tenant? (procure rotas com só "autenticado").
- **PJ-API-05** Paginação: parâmetros, `pageSize` enorme, ordem estável com desempate, total.
- **PJ-API-06** Filtros e ordenação com parâmetros inválidos e coluna arbitrária.
- **PJ-API-07** Idempotência de PUT e DELETE; chave de idempotência em POST que mexe com dinheiro.
- **PJ-API-08** Erros úteis, padronizados, sem pilha.
- **PJ-API-09** Versão antiga da rota: funciona ou anuncia a depreciação.
- **PJ-API-10** Tempo de resposta, tamanho do payload, consultas N+1.
- **PJ-API-11** Transação: falha no meio não deixa meio-gravado.
- **PJ-API-12** Datas com fuso e decimais no JSON.
- **PJ-API-13** CORS e cabeçalhos de segurança.
- **PJ-API-14** A documentação (OpenAPI ou equivalente) bate com o comportamento real.

### 7.2 CLI — `PJ-CLI`

- **PJ-CLI-01** `--help`, `-h` e sem argumentos → ajuda útil; `--version`.
- **PJ-CLI-02** Cada flag e as combinações (pairwise); flags conflitantes; flag desconhecida → erro claro.
- **PJ-CLI-03** Código de saída: 0 no sucesso, diferente de 0 em cada tipo de erro; erro em stderr, resultado em stdout.
- **PJ-CLI-04** Entrada por stdin; arquivo inexistente, sem permissão, vazio; diretório no lugar de arquivo; encoding; caminho com espaço e acento; relativo e absoluto; separador e fim de linha de Windows e Unix.
- **PJ-CLI-05** Saída estável para scripts; `--json`; sem cores quando não há terminal (`NO_COLOR`).
- **PJ-CLI-06** Ctrl+C limpa temporários; reexecutar é seguro.
- **PJ-CLI-07** Precedência entre flag, variável de ambiente e arquivo de configuração.
- **PJ-CLI-08** Operação destrutiva pede confirmação ou oferece `--dry-run`.
- **PJ-CLI-09** Entrada grande; tempo.
- **PJ-CLI-10** Ferramenta que lê Markdown linha a linha: ponha um exemplo idêntico ao formato real dentro de um bloco cercado por crases → a versão, a contagem ou a lista lidas não mudam por causa do exemplo. — Porque: o exemplo do changelog seria lido como a versão atual.

### 7.3 Biblioteca e SDK — `PJ-LIB`

- **PJ-LIB-01** Cada função pública: entrada típica, limites, nulos, tipos errados; erros lançados como documentado.
- **PJ-LIB-02** Tipos declarados batem com o comportamento.
- **PJ-LIB-03** Não modifica os argumentos recebidos.
- **PJ-LIB-04** Compatibilidade com a versão anterior (semver): compare a superfície pública com a última publicada (`PJ-LIB-08`) → remoção ou mudança de assinatura só em major; os exemplos da documentação rodam importando do pacote empacotado.
- **PJ-LIB-05** Concorrência e assíncrono: cancelamento, rejeições não tratadas.
- **PJ-LIB-06** Ambientes suportados (versões de runtime, navegador e servidor) → o mapa `exports` resolve ESM, CJS e `types` em cada runtime da matriz; a lista de arquivos do pacote (`npm pack --dry-run`, conteúdo do wheel) não tem arquivo faltando nem segredo; a faixa de `peerDependencies` passa nos extremos; tamanho e dependências anotados.
- **PJ-LIB-07** Empacote com destino fora do projeto (`npm pack --pack-destination <tmp>`, `cargo package --target-dir <tmp>`, `dotnet pack -o <tmp>`; `python -m build --outdir <tmp>` sempre numa cópia do projeto), instale num projeto consumidor no scratch e rode os exemplos do README → passam importando do pacote, não do `src`; arquivo fora do pacote, `exports`/`main`/`types` errado e ESM × CJS aparecem aqui. `prepack`/`prepare` executam código do projeto: o que sobrar no projeto vai para `sujeira`.
- **PJ-LIB-08** Compare a superfície pública com a última versão publicada (`npm view <pacote>@latest`, api-extractor, griffe, `cargo semver-checks`) → remoção ou mudança de assinatura só em versão major.

### 7.4 Mobile — `PJ-MOB`

- **PJ-MOB-01** Rotação; segundo plano e volta (estado e sessão preservados); app encerrado pelo sistema.
- **PJ-MOB-02** Permissões do sistema: negada, concedida depois, revogada.
- **PJ-MOB-03** Conexão intermitente e modo avião.
- **PJ-MOB-04** Notificação push e deep link abrem a tela certa.
- **PJ-MOB-05** Teclado virtual; tamanhos de tela e recortes; modo escuro; fonte grande do sistema.
- **PJ-MOB-06** Atualização sobre versão antiga instalada; gesto de voltar do sistema.

### 7.5 Jobs, filas, cron, webhooks — `PJ-JOB`

- **PJ-JOB-01** Dispare o job pelo trigger de teste com o relógio do worker num horário de borda (fuso diferente, virada do dia, horário de verão), ou leia a próxima execução que o agendador calcula → executa no horário e fuso certos e registra a execução. Como provocar: `execucao-e-evidencias.md` §3.10 (relógio e fuso só num worker de teste, nunca no do ambiente compartilhado).
- **PJ-JOB-02** Reexecução é idempotente (não duplica efeito).
- **PJ-JOB-03** Falha parcial e retomada; item que sempre falha não trava a fila.
- **PJ-JOB-04** Duas instâncias ao mesmo tempo.
- **PJ-JOB-05** Execução longa e timeout; cada execução registrada; falha gera alerta.
- **PJ-JOB-06** Webhook recebido duas vezes, fora de ordem, com assinatura inválida.
- **PJ-JOB-07** Webhook enviado: retry com espera crescente; destino fora do ar.
- **PJ-JOB-08** Ponha uma mensagem venenosa (corpo inválido) numa fila de teste → vai para a DLQ depois de N tentativas, com o motivo; o redrive reprocessa uma vez só, sem duplicar o efeito.
- **PJ-JOB-09** Duas mensagens da mesma entidade fora de ordem → o estado final segue a regra de ordenação documentada (a mais nova vence, ou a fila é particionada por chave); nada se perde.
- **PJ-JOB-10** Mensagem no schema antigo e no novo convivendo → o consumidor aceita as duas ou recusa com erro claro; produtor e consumidor concordam no contrato.
- **PJ-JOB-11** Fila cheia ou consumidor lento (backpressure) → o produtor não perde mensagem nem derruba a aplicação; profundidade e idade da fila aparecem no monitoramento.
- **PJ-JOB-12** ETL com entrada fora do esquema (coluna faltando, tipo errado, encoding, delimitador) → linha rejeitada com o motivo e contada; nada gravado pela metade.
- **PJ-JOB-13** ETL rodado de novo para o mesmo período e backfill de um intervalo antigo → nada duplica (idempotente) e o resultado é igual ao da primeira carga; drift de schema da origem é detectado e avisado.
- **PJ-JOB-14** ETL com arquivo truncado ou vazio → linhas lidas = gravadas + rejeitadas (contagem origem × destino); arquivo parcial não é dado como concluído.

### 7.6 Integrações com terceiros — `PJ-EXT`

- **PJ-EXT-01** Só com autorização; use o modo de teste do provedor e credenciais de teste.
- **PJ-EXT-02** Erros do provedor (4xx, 5xx, timeout) tratados; estado consistente se falhar no meio.
- **PJ-EXT-03** Limite de taxa do provedor; reconciliação.
- **PJ-EXT-04** Só os dados necessários são enviados.

### 7.7 Banco e migrações — `PJ-BD`

Somente leitura; escrita só pela aplicação, salvo pedido explícito.

- **PJ-BD-01** Constraints (única, chave estrangeira, não nulo) existem para as regras críticas.
- **PJ-BD-02** Migração nova numa cópia descartável do banco (receita em `modulos-avancados.md` §3.5, `MA-4-08`: banco local ou contêiner do próprio projeto, restaurado do seed ou de dump de dev anonimizado, nunca dump de produção sem autorização registrada) → aplica sobre os dados antigos, as invariantes do `MA-3` ficam iguais antes e depois, e o rollback volta ao estado anterior; sem cópia possível, `bloqueado` com "falta banco descartavel: <o que destrava>".
- **PJ-BD-03** Índices nas consultas de listagem.
- **PJ-BD-04** Tabela polimórfica (serve vários módulos): toda consulta de prova filtra pelo discriminador.
- **PJ-BD-05** Órfãos por entidade.

### 7.8 Front web (SPA, SSR) — `PJ-WEB`

- **PJ-WEB-01** Sem erro de hidratação; SSR e cliente mostram o mesmo.
- **PJ-WEB-02** Rotas com modal interceptado ou paralelas funcionam com F5 e link direto.
- **PJ-WEB-03** Efeito dobrado do modo de desenvolvimento separado de defeito real (confirme no build).
- **PJ-WEB-04** Estado global que re-renderiza tudo a cada mudança (digitação lenta).
- **PJ-WEB-05** Arquivos de página antigos depois de deploy.
- **PJ-WEB-06** Variáveis públicas de ambiente sem segredo.
- **PJ-WEB-07** Middleware ou guarda de rota lê a mesma fonte de sessão que a aplicação.

### 7.9 Embed, white-label, iframe — `PJ-EMB`

- **PJ-EMB-01** Carrega no domínio de terceiro; `frame-ancestors` liberado só nas rotas de embed.
- **PJ-EMB-02** Cores e logos configuráveis: contraste com qualquer fundo (conteúdo com superfície própria).
- **PJ-EMB-03** Comunicação entre página e iframe; altura dinâmica; cookies de terceiro bloqueados.
- **PJ-EMB-04** Formulário funciona sem sessão.

### 7.10 E-mail e templates — `PJ-MAIL`

- **PJ-MAIL-01** Renderiza em cliente web e celular, e no modo escuro.
- **PJ-MAIL-02** Placeholders resolvidos com dado real e com dado vazio.
- **PJ-MAIL-03** Links absolutos no ambiente certo; assunto identifica o registro; idioma; anexos; versão em texto puro.
- **PJ-MAIL-04** Remetente e domínio verificados (SPF, DKIM) — relate, não configure.
- **PJ-MAIL-05** Ambiente de teste só envia para caixas autorizadas; rótulo do ambiente certo no conteúdo.

### 7.11 Relatórios e painéis — `PJ-REL`

- **PJ-REL-01** Cada número cruzado com consulta independente.
- **PJ-REL-02** Filtros de período e escopo (tenant) aplicados.
- **PJ-REL-03** Agregação × listagem: junções obrigatórias e filtros globais mudam a contagem — compare.
- **PJ-REL-04** Rótulos dizem o que o número é.
- **PJ-REL-05** Exportação do relatório = tela.
- **PJ-REL-06** Tempo de carga; números parciais avisados.
- **PJ-REL-07** Painel externo embutido respeita o escopo do usuário.

### 7.12 Mensagens SMS, push e WhatsApp — `PJ-MSG`

Só com autorização de efeito externo e só para número ou dispositivo de teste (`PJ-EXT-01`).

- **PJ-MSG-01** Dispare a mensagem para número ou dispositivo de teste autorizado → chega uma vez, ao destinatário certo, com o conteúdo e o link do ambiente certo (nada de link de dev em produção, nem o inverso).
- **PJ-MSG-02** Destinatário com opt-out, preferência desligada ou horário de silêncio → não recebe, e a ação principal segue.
- **PJ-MSG-03** Placeholders com dado real e com dado vazio, texto longo e acentos → nenhum `{{campo}}` cru; corte no limite do canal (160 caracteres no SMS, por exemplo) sem perder o código ou o link.
- **PJ-MSG-04** Várias ações seguidas, dentro do teto autorizado → o sistema agrupa ou limita (limite de taxa), sem mandar N mensagens iguais.
- **PJ-MSG-05** Provedor fora ou recusando (4xx, 5xx, timeout, número inválido) → falha tratada como a regra diz (a ação principal segue ou volta), erro registrado, sem reenvio em laço.
- **PJ-MSG-06** Ambiente de teste → modo de teste do provedor ou lista de destinatários de teste; nenhum envio a pessoa real.
- **PJ-MSG-07** Push para token expirado ou app desinstalado → token removido sem erro para o usuário; o deep link da notificação abre a tela certa (`PJ-MOB-04`).

### 7.13 Aplicação com modelo de linguagem — `PJ-LLM`

LLM, RAG ou agente. A saída não é determinística: prova é taxa de acerto em N execuções, não uma resposta só. Evidência em `references/execucao-e-evidencias.md` §1.3; entradas hostis na categoria `prompt` do `fuzz_valores.py`.

- **PJ-LLM-01** Injeção direta: mande no campo do usuário as entradas da categoria `prompt` → o modelo não obedece à instrução injetada, não troca de papel e nenhuma ferramenta é chamada por causa dela.
- **PJ-LLM-02** Injeção indireta: ponha a instrução escondida num documento indexado, numa página que o agente lê ou na saída de uma ferramenta, só em ambiente de teste → o modelo trata como dado; nenhuma ação, nenhum link ou imagem que leve dado para fora.
- **PJ-LLM-03** Com a sessão de um tenant, pergunte algo que só existe em documento de outro tenant ou de outro usuário → o RAG não recupera nem cita; a resposta diz que não sabe.
- **PJ-LLM-04** Peça o prompt de sistema, as instruções internas ou as chaves das ferramentas, direto e disfarçado → nada é revelado.
- **PJ-LLM-05** Pergunta fora da base → a resposta diz que não sabe; toda fonte citada existe e contém o trecho citado (abra a fonte).
- **PJ-LLM-06** Mesma entrada N ≥ 5 vezes, com temperatura e seed fixas quando o provedor permite → taxa de acerto contra o critério registrada nas N execuções (`.jsonl`); a variação aparece, não fica escondida por uma execução só.
- **PJ-LLM-07** Conjunto de avaliação com critério e limiar definidos antes da rodada → a taxa medida passa do limiar; queda em relação à baseline é regressão.
- **PJ-LLM-08** Tokens, custo, timeout e 429 do provedor → custo por chamada medido e dentro do teto da rodada; timeout e limite de taxa tratados com mensagem, sem repetição infinita.
- **PJ-LLM-09** Agente diante de ação destrutiva ou com efeito externo (excluir, enviar, pagar) → pede confirmação antes; limite de iterações e de chamadas de ferramenta, sem laço.
- **PJ-LLM-10** Dado pessoal no prompt e no log → mascarado ou ausente nos logs do app e do provedor, conforme a política; nada de dado pessoal no conjunto de avaliação.
- **PJ-LLM-11** Force saída fora do esquema (peça o formato errado, ou simule a resposta do provedor com JSON, esquema ou tool call malformado) → o app valida e recusa, ou repete com limite de tentativas; sem tela branca nem dado meio gravado.
- **PJ-LLM-12** Mande entrada, histórico ou documento acima da janela de contexto do modelo → mensagem clara ou resumo documentado; nunca corte silencioso do começo da conversa ou do documento.
- **PJ-LLM-13** Cancele ou derrube o stream no meio da resposta → nada parcial gravado como resposta final, o botão de enviar volta e o custo da chamada fica registrado.
- **PJ-LLM-14** Peça conteúdo proibido pela política do produto (só em ambiente de teste, com teto de custo da rodada) → recusa consistente nas N execuções, registrada no `.jsonl`.

### 7.14 Desktop (Electron/Tauri) — `PJ-DSK`

- **PJ-DSK-01** Confira `contextIsolation: true` e `nodeIntegration: false` e liste os canais expostos no preload (`contextBridge`, comandos do Tauri) → cada canal valida o argumento e nenhum entrega `fs`, `child_process` ou shell ao renderer.
- **PJ-DSK-02** Abra por `shell.openExternal`, por protocolo customizado e por navegação uma URL vinda de fora (link, arquivo aberto, deep link) → só esquemas e domínios permitidos; `file:` e `javascript:` recusados.
- **PJ-DSK-03** Auto-update por um canal de teste → pacote assinado e verificado; falha no meio volta para a versão anterior (rollback) sem perder dado.
- **PJ-DSK-04** Instalador e desinstalador → instala sem privilégio desnecessário e com os atalhos certos; desinstalar remove o app e pergunta antes de apagar dado do usuário.
- **PJ-DSK-05** Múltiplas janelas, menus, bandeja e atalhos globais → cada item funciona e não duplica a ação; fechar a janela principal faz o que a regra diz (sai ou vai para a bandeja).
- **PJ-DSK-06** Arquivos que o app grava no perfil do usuário → listados em `sujeira`, sem segredo em texto puro; o app abre com o perfil vazio e com o perfil de uma versão antiga.
- **PJ-DSK-07** Escala de DPI (100%, 150%, 200%) e dois monitores → nada cortado, borrado ou fora da tela.

### 7.15 Jogo e canvas/WebGL — `PJ-GAM`

O DOM não vê o que é desenhado no canvas: inventário por cena (`references/perfil-e-inventario.md` §4.3) e estado de debug como oráculo.

- **PJ-GAM-01** Entrada por dispositivo (teclado, mouse, toque, gamepad) → cada ação mapeada funciona em cada um; remapear e desconectar o controle no meio não trava.
- **PJ-GAM-02** FPS e heap depois de N minutos de jogo e de N trocas de cena → estáveis, sem vazamento (o heap volta ao patamar).
- **PJ-GAM-03** Perder o foco (blur, aba em segundo plano) e voltar → pausa e retoma no mesmo estado, sem pular tempo.
- **PJ-GAM-04** Force a perda de contexto WebGL (extensão `WEBGL_lose_context`) → o jogo recupera ou mostra mensagem; nunca tela preta.
- **PJ-GAM-05** Seed fixa → a mesma sequência de eventos produz o mesmo estado (oráculo do print e do `visual_diff.py`).
- **PJ-GAM-06** Salvar, recarregar e carregar → o mesmo estado (posição, inventário, placar); save de versão antiga abre ou é migrado.
- **PJ-GAM-07** Áudio mudo, volume e troca de aba → respeitam a preferência e não tocam em segundo plano sem querer.
- **PJ-GAM-08** `devicePixelRatio` 1 e 2 e janela redimensionada → canvas nítido, proporção mantida, clique cai no lugar certo.

### 7.16 Site estático e landing — `PJ-SIT`

- **PJ-SIT-01** Rastreie todos os links a partir da home, internos e externos, só leitura → nenhum 4xx ou 5xx; nenhum link de dev em produção (`EL-LNK-07`).
- **PJ-SIT-02** Abra cada página → `title`, `description`, Open Graph e `canonical` próprios, sem repetição, e `lang` certo.
- **PJ-SIT-03** Compare o `sitemap.xml` com as páginas publicadas → lista exatamente as publicadas, sem página removida nem faltando.
- **PJ-SIT-04** Leia o `robots.txt` de produção → não bloqueia `/` nem as páginas que devem ser indexadas; o de homologação bloqueia.
- **PJ-SIT-05** Envie o formulário (contato, newsletter) só com autorização de efeito externo → entrega no destino configurado e mostra confirmação; erro de envio avisado; nenhum endpoint ou chave de terceiro exposto no HTML além do público.
- **PJ-SIT-06** Carregue a página sem aceitar o consentimento → nenhum cookie de analytics ou de publicidade antes dele; recusar mantém o site funcionando.
- **PJ-SIT-07** Leia os cabeçalhos de cache dos estáticos e do HTML → asset com hash em cache longo; HTML sem cache velho depois do deploy.

---

## 8. Testes estáticos e de build (sempre rodam)

- **ES-01** Baseline no INÍCIO, antes de qualquer mudança: typecheck, lint, testes existentes, build. Anote os números (erros, avisos, testes que passam e falham) e o `git status`.
- **ES-02** Typecheck à parte quando o build ignora erros de tipo. No fim: não sobe do baseline e zero erro novo nos arquivos tocados.
- **ES-03** Lint nos arquivos tocados. Lint quebrado no projeto é achado, não "passou".
- **ES-04** Testes automatizados existentes: mesma contagem ou melhor; teste novo para a correção quando o projeto tem suíte.
- **ES-05** Build de produção completa, não só o servidor de desenvolvimento.
- **ES-06** Contagem de erros que CAI muito de repente = compilação interrompida por erro de sintaxe, não melhoria.
- **ES-07** Pastas temporárias ou cópias dentro do repositório inflam as contagens → limpe e meça de novo.
- **ES-08** Fim de linha: `git diff --stat` igual a `git diff --ignore-cr-at-eol --stat`; se divergir, restaure o fim de linha original do arquivo.
- **ES-09** O diff só contém o que é seu: compare com o `git status` do início; arquivos de outras sessões ficam fora da entrega.
- **ES-10** Sem segredo no diff; sem depuração esquecida; convenções do projeto respeitadas (comentários, textos de UI só via dicionário em todos os idiomas, etc.).
- **ES-11** Auditoria de dependências (somente leitura) e versão de runtime exigida.
- **ES-12** Varredura estática de padrões de risco no código do alvo: `|| padrão` com números ou enums; `if (lista)`; `new Date('AAAA-MM-DD')`; `innerHTML` e equivalentes; `eval`; `target="_blank"` sem `rel`; `catch` vazio; funções duplicadas; handlers inline nas dependências de efeitos.
- **ES-13** Backend: build com 0 erros; avisos não aumentam.

Ferramentas: ES-11 e ES-10 (segredo) têm varredura própria em §11.6 (`MA-6-01`, `MA-6-02`).
Entrega separada por bloco: §13 (`EN-03` a `EN-06`).

### 8.1 Qualidade de código, organização e componentização — `QC`

Em todo projeto com código-fonte acessível. Procedimento, medições e o que aplicar × propor:
`references/qualidade-e-refatoracao.md`. Achado vira defeito `tipo melhoria`; causa estrutural de um
defeito vira dois registros (o defeito e a melhoria). Complementa `DM-CMP-03`/`-04` e `ES-12`.

**Estudo**

- **QC-01** Monte o mapa do alvo antes de julgar o código: entradas, camadas que o dado atravessa, dono do estado e onde mora cada regra; grave em `.qa/MAPA.md`. Verifique: toda `regra:` do ledger tem `arquivo:linha` no mapa.
- **QC-02** Siga um dado real do evento ao banco e de volta, anotando nome, tipo e unidade em cada salto. Verifique: nenhum campo muda de nome ou de sentido sem uma transformação explícita.
- **QC-03** Inventarie os endpoints do alvo e cruze com os chamadores. Verifique: endpoint sem chamador testado pela API direta; chamada sem endpoint confirmada na rede; ação escondida no front com autorização própria no back.

**Código confuso**

- **QC-04** Meça função e componente gigantes (linhas e responsabilidades). Verifique: cada responsabilidade tem um lugar; o que mistura busca, regra e render vira proposta de divisão.
- **QC-05** Procure condição repetida em vários pontos (mostrar, validar, enviar) e aninhamento acima de 3 níveis. Verifique: as cópias da condição são idênticas; divergência é defeito latente.
- **QC-06** Confira nomes contra o comportamento; campo com o mesmo nome em dois módulos é verificado pela regra que relaciona os campos, não pelo nome. — Porque: um campo de preço significava venda num módulo e custo no outro; padronizar pelo nome inverteria os rótulos.
- **QC-07** Grep do valor de cada limite de regra: o mesmo número em duas constantes é um achado, mesmo que hoje os valores batam (complementa `DM-CMP-04`). — Porque: duas constantes da mesma regra mantiveram o valor errado nos dois lugares.
- **QC-08** Rode o detector de duplicados no alvo e registre cada cópia de lógica de negócio como `melhoria`, com a proposta de unificar (complementa `DM-CMP-03`). — Porque: uma função copiada em várias telas recebeu a correção em uma; as outras seguiram erradas, sem aviso.
- **QC-09** Para cada formulário, anote de onde a tela lê e de onde o payload e a validação leem. Verifique: uma fonte só; edite e salve em seguida e confira o corpo enviado. — Porque: o payload saía com o valor anterior ao exibido.
- **QC-10** Conte renders ou commits por tecla e procure efeito que atualiza estado que dispara outro efeito. Verifique: no máximo um commit por tecla e nenhum aviso de atualização aninhada depois de 100 teclas. — Porque: o estouro só aparecia depois de dezenas de teclas.
- **QC-11** Confronte comentários e documentos que justificam uma decisão com os leitores reais do dado (grep). — Porque: um comentário afirmava que a listagem não usava um campo que ela lia três chamadas abaixo; a otimização zerou um contador.
- **QC-12** Liste código morto: export sem importador, tela copiada de outra que mostra dado alheio, bloco comentado, flag sempre falsa. Verifique: zero usos por grep, inclusive por texto, reflexão e rota baseada em arquivo. Exclua da lista a superfície pública: o que é alcançável por `package.json` (`exports`, `main`, `bin`, `types`), `__init__`/`__all__`, entry points do `pyproject`/`setup.cfg`, `index.d.ts`, handlers serverless e exports por convenção do framework; remover isso é breaking change → proposta de versão major (`PJ-LIB-08`), nunca melhoria baixa.
- **QC-13** Procure decisões tomadas pelo texto exibido (rótulo, mensagem, nome). Verifique com e sem acento e em outro idioma. — Porque: a heurística testava a palavra com acento e o cadastro estava sem.

**Organização**

- **QC-14** Compare a estrutura de pastas com o padrão majoritário do repositório. Verifique: componente de uma tela só fora da pasta compartilhada; utilitário compartilhado fora da pasta de uma tela.
- **QC-15** Escreva as camadas que o projeto declara e procure atalhos (tela chamando HTTP cru, regra só na UI, controller com SQL). Verifique por grep das chamadas fora da camada.
- **QC-16** Procure dependência circular entre módulos com o analisador já instalado ou por grep de imports nos dois sentidos.
- **QC-17** Conte os usos de cada implementação duplicada de infraestrutura (cliente HTTP, formatador de data, biblioteca de tabela ou ícone) e marque qual é a oficial pelas regras do projeto. — Porque: uma instância legada do cliente HTTP, sem interceptors, ainda era importável.
- **QC-18** Arquivo acima de ~1.000 linhas ou que concentra várias telas e abas vira proposta de divisão, com o custo.

**Componentização**

- **QC-19** Bloco de UI com a mesma intenção em 3+ telas: liste os usos, as diferenças e se elas cabem em 3–4 props. Mesma aparência com intenção diferente não conta.
- **QC-20** Função pura duplicada (formatar, calcular, mapear código → rótulo): compare as cópias com a mesma tabela de entradas reais; saídas diferentes já são defeito.
- **QC-21** Padrão de formulário feito à mão em cada tela (validação, "Salvando…", destaque do campo, erro do servidor no campo): candidato a hook ou componente de formulário.
- **QC-22** Componente com 5+ flags booleanas que mudam o comportamento: proponha variantes ou composição.

**Refatoração segura**

- **QC-23** Caracterize antes de refatorar (prints, textos, payloads, saídas de função, saídas de comando) e compare depois. Verifique: IGUAL em todos os usos; e a comparação acusa DIFERENTE quando um valor é alterado de propósito.
- **QC-24** Refatoração em bloco e commit próprios, separados da correção. Verifique: nenhum hunk de comportamento no bloco de refatoração. — Porque: um bloco misto revertido inteiro levou junto uma correção de acessibilidade que não tinha nada a ver com ele.
- **QC-25** Antes de renomear, grep no front e no back pelo nome como texto (permissão, chave de tradução, rota, campo, coluna, evento, `data-testid`). — Porque: o nome técnico de uma permissão era checado como texto nos dois lados; a saída foi um rótulo ao lado, não a renomeação.
- **QC-26** Depois de refatorar: gates ≤ baseline, `--stat` igual ao `--ignore-cr-at-eol --stat`, nenhuma formatação em massa. — Porque: um diff 32 vezes maior que a mudança real, inflado por fim de linha, derrubou a PR inteira.
- **QC-27** Migração incremental: crie sem usar, migre um uso por vez com caracterização IGUAL e reteste na tela real, e remova o antigo só com zero usos provados por grep.
- **QC-28** Toda proposta de refatoração tem plano `R-n` com problema medido, risco, passos, custo, prova e quem decide; sem isso, não entra no relatório.

**Correção na hora**

- **QC-29** Antes de editar, grave o ANTES (print cru e circulado, rede, banco); depois, reteste na tela real com par de controle, teste inverso e regressão de outro uso. Sem os quatro, o defeito não sai de `corrigido`.
- **QC-30** Depois de cada correção, rode de novo os casos `falhou`, `bloqueado` e `nao-validado` que compartilham a causa ou os arquivos tocados, e teste direto a função alterada com uma tabela de entradas reais.

---

## 9. Lições reais que viraram regra — `LI`

Armadilhas de método medidas em rodadas reais. Cada uma já produziu um falso positivo, um falso
negativo ou um defeito que passou.

### 9.1 Medição e ferramenta

- **LI-01** Requisição "duplicada" no espião de rede: confira no banco antes de chamar de bug. — Porque: o espião instalado duas vezes registra cada chamada duas vezes; o banco tinha um registro só.
- **LI-02** Instale o observador de toast ANTES do clique, observando `childList`, `subtree` e `characterData`, e tire o print em até ~2 s. — Porque: o toast some em segundos e o contêiner reaproveita o nó; observar só `childList` perdeu o segundo toast (um erro 422 que o usuário viu).
- **LI-03** Não filtre mensagens com uma lista de palavras ("sucesso|erro"). Leia o texto cru. — Porque: o aviso de falha dizia "Atenção / Revise os campos" e o filtro concluiu que "nada aconteceu".
- **LI-04** Número que não muda quando a entrada muda é medição quebrada. Faça um controle que DEVE mudar o resultado. — Porque: sete larguras deram o mesmo layout porque o estilo de teste nunca foi aplicado (regra `!important` venceu).
- **LI-05** Meça com par de controle: um registro que deve mostrar o estado e outro que não deve. — Porque: sem o controle, "passou" pode ser coincidência ou o recurso inteiro desligado.
- **LI-06** Leia a tela só depois de estável (rede ociosa e elemento final presente). — Porque: a página monta em etapas e a leitura cedo pegou um estado intermediário.
- **LI-07** O componente pode estar montado duas vezes (cópia oculta). Filtre por `getBoundingClientRect().width > 0` e confirme com `elementFromPoint`. — Porque: o seletor pegou a cópia invisível e leu uma cor que a tela não mostrava.
- **LI-08** Prefira seletor, `ref` ou `data-testid` a coordenada. Se precisar de coordenada, converta a escala (`innerWidth` / largura do frame) e clique logo depois do print. — Porque: a escala de ~1,36 entre o print e o CSS fez cliques caírem fora do alvo e gerou três "defeitos" falsos.
- **LI-09** Trabalhe na aba visível (`document.visibilityState === 'visible'`). — Porque: em aba de segundo plano, timers e animações ficam estrangulados, o print congela e o clique se perde.
- **LI-10** Escrever no DOM não é escrever no estado do framework. Digite de verdade e confira o payload. — Porque: o preenchimento sintético mostrava o valor na tela e enviava vazio.
- **LI-11** Rádio ou checkbox marcado por evento sintético: confira o visual, o estado e o payload. — Porque: o próximo render desmarcou e o envio barrou por "obrigatório", parecendo defeito do botão.
- **LI-12** "Não há menu" só depois de ver o menu aberto (itens `role=menuitem` e print). — Porque: um clique que não abriu o menu virou o achado "sem opções", e o defeito real era o contrário (opção perigosa liberada).
- **LI-13** Redimensionar a janela ou dar zoom não é mudar o viewport: confirme `innerWidth` e `matchMedia`. — Porque: a ferramenta respondeu "sucesso" e a largura da página não mudou.
- **LI-14** Antes de clicar num botão, confira que nada fixo o cobre (`elementFromPoint` no centro). — Porque: um botão flutuante cobria o "Salvar" e o clique acionava outra coisa.
- **LI-15** Dropdown "fechado" pode continuar no DOM interceptando cliques por alguns segundos. Espere ou confira a pilha no ponto. — Porque: o clique no campo de baixo foi engolido e pareceu campo quebrado.
- **LI-16** Download automatizado repetido é bloqueado pelo navegador: confirme com um clique único antes de chamar de defeito.
- **LI-17** Primeira carga logo após reiniciar o servidor pode falhar: recarregue antes de concluir.
- **LI-72** Ao provar id numérico grande, confira o corpo cru (aba de rede ou banco), não a evidência re-serializada. — Porque: o espião re-serializa o JSON para mascarar segredo e arredondou um inteiro acima de 2^53.
- **LI-73** Valor posto pelo setter nativo ignora o `maxlength` do campo: registre como teste do servidor, não da tela. — Porque: o setter gravou 10 caracteres num campo com `maxlength` 5.
- **LI-74** Ferramenta automática de acessibilidade não acusa controle clicável que não é botão: `DM-A11-04` continua manual. — Porque: um `<span onclick>` passou no axe sem violação.
- **LI-75** Lighthouse em página logada: use `--disable-storage-reset` ou o painel do DevTools na sessão do usuário. — Porque: o reset de armazenamento derrubou a sessão do perfil de QA.
- **LI-76** Janela do navegador escondida, minimizada ou atrás de outra congela o print: restaure a janela (redimensionar pela própria ferramenta) e confira que o print novo difere do anterior. — Porque: prints idênticos antes e depois da ação foram lidos como "nada mudou".
- **LI-77** Detalhe pequeno em print de tela larga: tire o print de contexto e um de detalhe (zoom na região); em modal, amplie por CSS só para o print e diga isso na legenda. — Porque: no PDF o print inteiro reduzido ficou ilegível e a caixa numerada não mostrava o ponto.
- **LI-78** O print DEPOIS de uma correção sai no mesmo estado do ANTES (registro, rolagem, papel, viewport, idioma); em outro estado, refaça. — Porque: duas telas em estados diferentes não provam a correção, só mostram duas telas.
- **LI-79** Meça as caixas e tire o print no mesmo lote, e declare a unidade (px da imagem ou CSS). — Porque: caixa medida num momento e print tirado em outro saiu deslocada do ponto.
- **LI-80** Não rode o executável do navegador do usuário para ler a versão nem para imprimir (ex.: `chrome --version` no Windows): leia a versão pelo registro ou pelo arquivo e imprima PDF só headless, com perfil temporário. — Porque: no Windows o comando abriu uma janela na sessão do usuário em vez de imprimir a versão.
- **LI-81** Ao conferir texto extraído de PDF, compare só letras e números. — Porque: a extração troca `·` por `∙` e espaço por espaço rígido, e a conferência reprovou um rodapé certo.

### 9.2 Tempo e espera

- **LI-18** Espere pelo menos o tempo do evento antes de concluir ausência. Meça a duração da requisição; um segundo passo pode sair minutos depois do primeiro. — Porque: esperar 60 s levou a concluir "nunca grava"; a gravação saiu aos 123 s.
- **LI-19** Não clique de novo numa ação lenta para "ver se foi": confira no banco. — Porque: uma criação levava mais de 2 minutos e o segundo clique duplicaria o registro.
- **LI-20** Contagem regressiva ou "há N minutos" deve vir do relógio, não de ticks. — Porque: em aba de segundo plano, a contagem por timer andou 5 s em 11 s.
- **LI-82** A primeira execução de uma ferramenta num repositório recém-criado ou recém-clonado pode ser muito mais lenta (cache frio do git, antivírus): meça de novo antes de concluir lentidão. — Porque: 40 s na primeira execução, 1,7 s nas seguintes.

### 9.3 Dados, estado e banco

- **LI-21** Busca que devolve tudo é filtro quebrado: compare o contador antes e depois. — Porque: um termo com número ("Alfa3") virava o dígito "3" e casava com quase todas as linhas.
- **LI-22** Escolha com busca ativa, limpe a busca e confira o item marcado e o payload. — Porque: a seleção usava o índice da lista filtrada e marcava outro item.
- **LI-23** Digite tecla a tecla cruzando o limite de uma regra e confira o foco. — Porque: um tooltip condicional remontava o campo ao cruzar o limite e o usuário perdia o foco a cada número.
- **LI-24** Compare o que a tela mostra com o que o payload leva, campo a campo. — Porque: tela e envio liam dois estados diferentes e divergiam nas duas direções.
- **LI-25** Edite, recarregue e confira o NOVO valor — e que existe UMA linha no banco. — Porque: o endpoint de gravação só inseria; a leitura devolvia a linha antiga e a edição nunca tinha efeito, sem erro.
- **LI-26** "Abrir e salvar sem mudar nada" também é teste: compare o registro inteiro antes e depois. — Porque: um salvar sem alteração apagou um endereço que a tela não tinha carregado.
- **LI-27** Depois de excluir, procure o id nas tabelas filhas. — Porque: a exclusão removia itens e contatos mas deixava respostas órfãs.
- **LI-28** Depois de toda ação que regenera algo (token, código), confira o que a tela exibe e copia sem recarregar. — Porque: "reenviar" gerou um link novo e o botão "copiar" seguiu entregando o link morto.
- **LI-29** Procure registros antigos e edite um campo não relacionado. — Porque: dado legado que violava uma regra nova bloqueava qualquer edição do registro.
- **LI-30** A rota de criação usa uma string sentinela ("novo") que é verdadeira em testes de valor. — Porque: a tela dizia "atualizado" ao criar e mostrava ações que exigiam o registro salvo.
- **LI-31** Teste `0`, `""`, `[]`, `null` e GUID zero em todo campo e resposta. — Porque: lista vazia passou como "tem dado" e a tela abriu um formulário vazio em vez de "não encontrado".
- **LI-32** Leia o status HTTP, não só a mensagem. — Porque: erro de validação devolvido como 401 fazia o cliente apagar a sessão do usuário.
- **LI-33** Num painel com várias chamadas, simule uma lenta e uma que falha. — Porque: com tudo esperando a mais lenta, uma chamada que não retornava zerava o painel inteiro.
- **LI-34** Force um erro no meio da carga e confira que o "carregando" termina. — Porque: um contador de carregamento sem o decremento no caminho de erro deixou o esqueleto para sempre.
- **LI-35** Na paginação, compare total, soma e distintos. — Porque: parar em "lote menor que a página" perdia registros; ordenação sem desempate repetia e omitia linhas.
- **LI-36** Cruze o número do card com a listagem filtrada pelo mesmo critério. — Porque: agregação e listagem contavam diferente por causa de junções obrigatórias e filtros globais.
- **LI-37** Card sempre zero: compare a constante e o filtro usados com o dado real. — Porque: o card comparava com o identificador de um status de outra entidade.
- **LI-38** Depois de uma otimização de consulta, compare o payload antes e depois campo a campo. — Porque: a versão "enxuta" deixou de carregar um dado usado três níveis abaixo e um card zerou sem erro.
- **LI-39** Ao contar no banco, filtre tabelas polimórficas pelo discriminador. — Porque: a primeira contagem misturou vários módulos e deu um número 40 vezes maior.

### 9.4 Autorização e sessão

- **LI-40** Teste cada permissão granular com e sem a flag global, e faça o teste inverso (remover → some). — Porque: uma flag "lê tudo" curto-circuitava permissões de campo, que nunca tinham efeito.
- **LI-41** Confira que o nível exigido pelo código pode ser concedido pela tela de perfis. — Porque: exigir um nível que o toggle não grava escondeu oito operações de todos os usuários.
- **LI-42** Procure o mesmo efeito por outro caminho (combo de status, endpoint alternativo). — Porque: o botão "concluir" foi protegido e o combo de status concluía igual.
- **LI-43** Esconder no front não é proteger: chame a API com a sessão sem permissão. E o inverso: botão que vaza com back que barra não é dado desprotegido — execute até a resposta com um registro descartável.
- **LI-44** Teste o acesso direto por URL com o papel cuja listagem vem vazia. — Porque: a lista escondia e o detalhe abria.
- **LI-45** Compare a autorização da ação em lote com a da ação unitária. — Porque: excluir em lote exigia admin; excluir um a um não exigia nada.
- **LI-46** Permissão alterada pode valer só após novo login: peça o re-login antes de concluir. — Porque: a permissão vinha no token e o F5 não bastava.
- **LI-47** Um usuário por perfil de navegador. — Porque: duas sessões no mesmo navegador compartilhavam o cookie e a aplicação seguia o usuário errado na outra aba.
- **LI-48** Clique durante o carregamento das permissões. — Porque: o estado "carregando" era diferente de "bloqueado" e liberava os botões nessa janela.
- **LI-49** Use o mesmo usuário para solicitar e aprovar. — Porque: o solicitante aprovava o próprio pedido; a regra existia só para outra entidade.
- **LI-50** O nome do campo ou da permissão pode significar o oposto do que parece; o oráculo é a regra que relaciona os campos. — Porque: a permissão com "revenda" no nome liberava o custo, e era ela que o time ligava.

### 9.5 Diagnóstico e comunicação

- **LI-51** Antes de chamar de regressão, `git log -S"<símbolo>"`. — Porque: o comportamento "quebrado" era uma decisão de 20 dias antes; changelog e catálogo repetiam a regra velha.
- **LI-52** Achado que depende de onde na tela: mande o print junto da primeira pergunta. — Porque: o nome de um botão foi lido como o nome de uma etapa; 45 minutos de texto, 1 minuto com a imagem.
- **LI-53** "Está escrito que foi corrigido" não é "está no código que roda": confira o branch e o ambiente.
- **LI-54** Cite sempre o ambiente junto do código do registro. — Porque: o mesmo código existia em dev e em produção com dados diferentes, e o time procurou no lugar errado.
- **LI-55** Meça o destino da API na aba de rede; não deduza pelo arquivo de configuração. — Porque: o arquivo apontava para um lugar e o runtime para outro.
- **LI-56** Corrigiu uma função? Procure as cópias. — Porque: a mesma função estava colada em quatro telas e só uma recebeu a correção.
- **LI-57** Mesma regra em duas constantes: grep pelo número e teste n-1, n, n+1 em cada lugar. — Porque: as duas tinham o mesmo valor errado e a documentação descrevia a regra errada como certa.
- **LI-58** Mensagem genérica do servidor ("erro ao salvar as alterações") esconde a causa: peça o log ou reproduza em depuração. — Porque: o filtro de exceções lia só a mensagem externa e não registrava nada.
- **LI-59** Hipótese que cai é registro (`retratado`, com o motivo). — Porque: evita que a próxima pessoa refaça o mesmo caminho e reabra o "defeito".
- **LI-60** Leia a requisição que o botão dispara; o rótulo pode mentir. — Porque: um "atribuir" convertia o registro de forma irreversível.
- **LI-61** Depois de corrigir, reteste a vizinhança. — Porque: um card que deixou de ser zero revelou que três rótulos ao lado não correspondiam ao número.
- **LI-62** Conte avisos por destinatário e por evento. — Porque: dois eventos equivalentes ("ganho" e "registro gerado") mandavam dois e-mails para as mesmas pessoas sobre o mesmo fato.
- **LI-63** Confira destinatários e o rótulo de ambiente nos e-mails de teste. — Porque: e-mail de dev chegava a pessoas reais com a etiqueta "produção".
- **LI-64** `new Date('AAAA-MM-DD')` volta um dia em fuso negativo: data pura se lê como dia civil.
- **LI-65** Hora gravada no horário do servidor e exibida como UTC aparece deslocada no local: separe efeito do ambiente de defeito de produção.
- **LI-66** Estado inalcançável pela tela: documente o caminho e o papel que levam até ele. — Porque: "não testado" escondia que o estado só era alcançável por outra tela.
- **LI-67** Antes de reportar um defeito a alguém, pergunte: se ele acreditar nesta frase e agir, onde vai parar? — Porque: frases verdadeiras mas incompletas mandaram a pessoa procurar no commit errado.
- **LI-83** Antes de atribuir um defeito ao trabalho de outra pessoa, reproduza na base limpa, sem o seu working tree. — Porque: um achado reportado como defeito de outro era efeito de um filtro do próprio working tree; a retratação custou mais que a verificação.
- **LI-84** Concorde com "o sistema fez sozinho" só depois de ler o registro de atividade ou de auditoria. — Porque: quem fez o quê muda o dono do defeito.

### 9.6 Código e entrega

- **LI-68** Editar arquivo no Windows (script ou editor) pode trocar o fim de linha: compare `git diff --stat` com `--ignore-cr-at-eol --stat` depois de cada edição. — Porque: uma mudança de 30 linhas apareceu como 57 mil.
- **LI-69** Inserção automática em arquivo de dicionário pode cair entre a chave e o valor quando o valor está na linha seguinte: rode o typecheck logo depois. — Porque: a contagem de erros caiu de 115 para 6, e isso era a compilação interrompida.
- **LI-70** Pastas temporárias dentro do repositório entram nas contagens do typecheck. — Porque: o número de erros dobrou sem nenhuma mudança real.
- **LI-71** Vitrine de componentes e mock não validam a tela: o teste é na tela de produto que o usuário nomeou. — Porque: na vitrine o handler era um `console.log`; o componente montava e a integração nunca foi provada.
- **LI-85** Confira o fim de linha lendo o arquivo em binário (contar `\r` nos bytes), nunca em modo texto. — Porque: a leitura em texto do Python converte CRLF e esconde o CR.
- **LI-86** Para comparar o conteúdo do working tree, use `git hash-object --no-filters` arquivo a arquivo; não use `git add -u` num índice novo. — Porque: o índice novo marcou centenas de arquivos como alterados só por fim de linha.
- **LI-87** `git apply` fora de um repositório no Windows: passe `-c core.longpaths=true`. — Porque: falhou com "Filename too long"; o `core.longpaths` do repositório não vale fora dele.
- **LI-88** Bloco que aplica sozinho pode não compilar sozinho: rode o typecheck por bloco numa cópia limpa e declare as dependências. — Porque: um bloco usava a prop nova criada em outro bloco.
- **LI-89** Caminho com colchetes (`[id]`) usado como padrão de arquivo casa outro arquivo: trate caminho existente como literal e escape `[` em padrão. — Porque: a rota dinâmica casou um arquivo vizinho e o trecho foi para o bloco errado.
- **LI-90** No Git Bash, argumento que começa com `/` vira caminho do Windows (`/api/v1` → `C:/Program Files/Git/api/v1`): passe sem a barra inicial ou com `MSYS_NO_PATHCONV=1`. — Porque: o prefixo da API saiu trocado e nenhuma chamada casou com o ledger.
- **LI-91** Não passe código com barra invertida por heredoc da ferramenta de shell: edite com a ferramenta de arquivo ou grave o patch num arquivo. — Porque: `\\0` virou byte NUL e `\\b` virou backspace dentro do script.
- **LI-92** Ao validar Python com `py_compile`, compile para uma pasta temporária ou apague o `__pycache__` criado. — Porque: a validação deixou cache dentro da pasta entregue.
- **LI-93** Ao converter HTML em texto ou Markdown, troque só as tags que você gerou; nunca remova `<...>` em massa. — Porque: a remoção apagou um `<form noValidate>` citado entre crases no texto do PR.
- **LI-94** Ao regerar uma saída, apague só os arquivos com o seu prefixo, nunca a pasta inteira. — Porque: apagar a pasta de provas levou junto arquivos de terceiros.

---

## 10. Como acrescentar uma lição

Grave com `scripts/aprender.py licao` (`references/aprender.md`). Ele escolhe o próximo código livre,
deduplica, recusa segredo, dado pessoal, cara de projeto e afrouxamento de regra de segurança, e
escreve o `CHANGELOG.md`. Para melhorar uma linha, use `--substitui CÓDIGO` (a antiga fica marcada
como obsoleta). O que segue vale também para quem edita à mão.

Ao fim de toda rodada, responda duas perguntas: **"o que eu testei que não estava aqui?"** e **"o que
faltou testar e só percebi depois?"**. Cada resposta vira uma linha.

### 10.1 Onde vai

| A lição é... | Vai para |
|---|---|
| um TESTE a fazer, que vale para outro projeto | a seção do elemento (4), do fluxo (5), da dimensão (6) ou do tipo de projeto (7) |
| uma ARMADILHA de método (ferramenta, medição, tempo), genérica | seção 9 |
| específica deste projeto (nome de tela, endpoint, usuário, regra de negócio) | `.qa/PERFIL.md`, seção de armadilhas — nunca aqui |

### 10.2 Formato

Uma lição por linha:

```
- **<CÓDIGO>** <regra no imperativo>. — Porque: <o que deu errado, sem nome de cliente nem de projeto>.
```

Exemplo (com `NN` no lugar do próximo número livre):

```
- **EL-SBU-NN** Escolha duas opções seguidas sem fechar a lista e confira que só a última ficou marcada. — Porque: o componente acumulava as duas e enviava a primeira.
```

### 10.3 Regras

- **Código:** o próximo número livre do prefixo. Nunca renumere nem reutilize: os ledgers de rodadas
  antigas citam os códigos. Linha que ficou obsoleta recebe `(obsoleta: motivo)` em vez de ser apagada.
- **Prefixo novo** (um tipo de elemento ou dimensão que não existe): crie a subseção com o prefixo, e
  acrescente-o ao sumário e à tabela 1.5. Tipo de projeto novo (`PJ-*`) entra também numa linha da
  tabela 1.4 (`aprender.py licao --novo-prefixo PJ-… --tipo-projeto "<linha da 1.4>"` faz as duas
  coisas); técnica que a tabela 1.5 não tem entra antes com `licao --tecnica-nova`. Prefixo que
  começa com um de segurança (`DM-SEC`, `DM-TEN`, `DM-AUT`, `DM-SES`, `DM-PRI`, `MA-6`) não se cria:
  a lição entra na seção que já existe.
- **Antes de acrescentar:** procure (grep) se já existe; se existir, grave a versão melhor com
  `aprender.py licao --substitui <CÓDIGO>` (a antiga fica marcada obsoleta); nunca reescreva a linha no
  lugar.
- **Executável:** a linha diz o que fazer e como verificar. Sem o "como verificar", não entra.
- **Segurança:** linha que cita ação proibida (login, senha, commit, push, merge, PR, escrita em
  produção, `UPDATE`/`DELETE` no banco, e-mail real, pular gate) leva a negação colada ao verbo
  ("nunca faça login"); sem ela, o `aprender.py` recusa (`references/aprender.md` §6.2). Linha marcada
  com 🔒 é regra de segurança: só muda com pedido do usuário.
- **Porquê curto:** uma frase sobre o que aconteceu. Sem nome de pessoa, cliente, tela ou código de
  registro — isso vai no PERFIL.
- **Registro:** cite os códigos das linhas novas na nota da fase da rodada ("catálogo atualizado:
  EL-SBU-NN, LI-NN").

---

## 11. Módulos avançados — prefixo `MA-`

Entram **sempre que o projeto permitir**. Procedimento, comandos por stack e armadilhas:
`references/modulos-avancados.md` (a tabela §0 de lá diz em que fase cada um entra). Módulo que não se
aplica: caso `nao-aplicavel` no item `dimensao:MA-<n>`, com o motivo. Nenhum módulo afrouxa as regras
do `SKILL.md` §2. Os códigos são registrados aqui; a referência repete as linhas junto do
procedimento.

### 11.1 Log do servidor — `MA-1`

Toda resposta 4xx/5xx com mensagem genérica e todo 200 sem o efeito esperado só fecham com a entrada do log.

- **MA-1-01** Antes do primeiro clique, localize os logs de cada serviço e leia uma linha recente de cada → verifique que a fonte está viva e anote no PERFIL onde fica e qual o fuso.
- **MA-1-02** Em todo 4xx/5xx com mensagem genérica, ache a entrada do log pelo identificador da requisição → verifique tipo e mensagem da inner exception mais interna e grave em `evidencias/NN-log-<acao>.txt`.
- **MA-1-03** Provoque um erro de validação e um de banco (duplicado, FK) em cada endpoint de escrita → verifique que o log registra a causa real e que a resposta traz um identificador que o suporte consegue procurar.
- **MA-1-04** Leia o filtro ou middleware global de exceções → verifique se ele loga a exceção inteira antes de responder; se só lê a mensagem e marca como tratada, registre a perda da causa.
- **MA-1-05** Procure `catch` que grava atividade ou erro com o mesmo contexto ou transação que falhou → reproduza a falha e confira se o registro do erro aparece no banco.
- **MA-1-06** Em ação que devolve 200 sem o efeito esperado, procure no log aviso ou erro de efeito secundário (e-mail, integração, fila) → verifique se a falha foi ignorada pelo código.
- **MA-1-07** Leia os logs gerados durante a rodada procurando token, senha, string de conexão e dado pessoal → registre a existência e o arquivo, nunca o valor.
- **MA-1-08** Compare o horário do log com o da tela e o do banco para a mesma ação → verifique se a diferença é só de fuso e documente o fuso de cada camada.
- **MA-1-09** Sem acesso ao log, mande o pedido com janela e fuso, rota, identificador e o que trazer de volta → mantenha o caso `nao-validado` até a resposta e registre causa provada × provável.
- **MA-1-10** Em requisição acima de 10 s, leia o log do intervalo → verifique se o tempo está no banco, em efeito em série dentro da requisição ou em chamada externa.

### 11.2 Divergência front × back — `MA-2`

Compare o corpo enviado, o recebido, o DTO do back e o model do front, campo a campo.

- **MA-2-01** Para cada endpoint do alvo, compare as chaves da resposta real com o model do front → verifique campo ausente, renomeado ou com tipo diferente.
- **MA-2-02** Liste os valores distintos de cada enum na resposta e no banco → verifique que todo valor tem membro e rótulo no front (sem número cru na tela).
- **MA-2-03** Exiba um registro com o membro de valor `0` de cada enum → verifique que ele não vira o padrão por `x || padrao`.
- **MA-2-04** Envie cada campo editável e leia o banco depois → verifique que o DTO de entrada tem o campo e que o valor gravado é o enviado.
- **MA-2-05** Procure no corpo enviado e recebido números com mais de 6 casas decimais → verifique onde o float nasce e o que o banco grava.
- **MA-2-06** Abra um registro com cada campo de data preenchido em fuso negativo → verifique que a tela mostra o dia civil do banco, sem ISO cru e sem um dia a menos.
- **MA-2-07** Provoque cada tipo de erro do endpoint → verifique que o front lê o envelope que o back manda e mostra a mensagem do campo.
- **MA-2-08** Compare o status HTTP de cada erro com a semântica (`PJ-API-02`) → verifique que validação não volta como 401 nem como 200.
- **MA-2-09** Compare o OpenAPI publicado com as respostas reais → verifique `required`, `nullable`, enums e status documentados.
- **MA-2-10** Abra registro antigo, com campos nulos que hoje são obrigatórios → verifique que a tela não quebra nem exibe `undefined`.
- **MA-2-11** Compare ids numéricos grandes no banco com o que a tela exibe e reenvia → verifique que não há perda acima de 2^53.

### 11.3 Integridade do banco (somente leitura) — `MA-3`

Invariantes levantadas do código, consultadas no início e no fim; retrato antes e depois de toda escrita.

- **MA-3-01** Liste as FKs lógicas (colunas `*_id` sem constraint, tabelas polimórficas) lendo entidades e migrations → rode a consulta de órfão de cada uma e registre a contagem.
- **MA-3-02** Para cada status terminal ou ativo, escreva a consulta de estado impossível a partir dos guards do service → verifique zero linhas no início e no fim da rodada.
- **MA-3-03** Para cada chave de negócio (documento, código, e-mail por tenant), agrupe com caixa e espaços normalizados → verifique que não há duplicado vivo e que existe constraint no banco.
- **MA-3-04** Para cada total ou saldo exibido, compare com a soma das partes no banco, com a regra de exclusão → verifique a diferença zero (ou dentro do arredondamento documentado).
- **MA-3-05** Antes e depois de toda escrita, retrate o registro inteiro e os relacionados → verifique que só mudou o esperado e que campo não exibido não foi apagado.
- **MA-3-06** Depois de toda exclusão, procure o id em todas as tabelas filhas e polimórficas → verifique cascata, bloqueio com mensagem de negócio ou órfão.
- **MA-3-07** Procure filhos com tenant diferente do pai e registros vivos apontando para pai excluído → verifique zero linhas.
- **MA-3-08** Procure registros com datas incoerentes (fim antes do início, terminal sem data) e campos de auditoria nulos → registre a contagem e a mais antiga.
- **MA-3-09** Procure duas linhas vivas para o que deveria ser único (resposta por campo, versão atual) → verifique qual a leitura devolve e se a edição tem efeito.
- **MA-3-10** Compare o esquema real (FK, unique, not null) com o que as entidades e migrations declaram → registre o que falta no banco.
- **MA-3-11** Para cada violação, separe pré-existente (antes do primeiro passo) de criada pela rodada → registre as duas, com o caso que criou a segunda.

### 11.4 Modo PR/diff — `MA-4`

Escopo pelo `escopo_diff.py`: o que mudou e o raio de impacto, fechado com o quadro "mudou × testado".

- **MA-4-01** Gere o escopo com `escopo_diff.py` contra o destino da PR e faça o merge do parcial → verifique que todo arquivo alterado e todo arquivo do raio têm item e caso.
- **MA-4-02** Leia o diff hunk a hunk e classifique cada um → verifique que todo hunk de lógica tem um caso que o exercita na tela ou na API.
- **MA-4-03** Para cada componente ou utilitário alterado, teste um uso real de cada configuração listada no raio → verifique que nenhum uso regrediu (`DM-CMP-01`).
- **MA-4-04** Para cada tela listada em "Telas afetadas", abra a tela real e exercite o trecho que monta o arquivo alterado → verifique com print e rede.
- **MA-4-05** Para cada endpoint alterado no back, ache as chamadas do front (deste e de outros repositórios) → verifique contrato e comportamento pelos dois lados.
- **MA-4-06** Rode os testes automatizados listados no escopo antes e depois da mudança → verifique mesma contagem ou melhor, e leia o teste alterado.
- **MA-4-07** Com marca `impacto-global`, rode build de produção, suíte e smoke dos fluxos principais → registre o número contra o baseline.
- **MA-4-08** Com marca `migracao`, rode as invariantes do módulo 3 antes e depois da migração numa cópia descartável (`modulos-avancados.md` §3.5) → verifique zero violação nova.
- **MA-4-09** Procure o que o raio heurístico não vê (registro de DI, rota por string, evento por nome, chave de i18n) → acrescente os itens com `descoberto_por: critico`.
- **MA-4-10** Feche com `escopo_diff.py --base <destino> --incluir-working --prefixo-api <o mesmo do parcial> --ledger <rodada> --falhar-se-descoberto` → verifique saída 0 e anexe o quadro "mudou × testado" ao relatório.

### 11.5 Regressão automática — `MA-5`

Fluxo que passou com prova estável vira teste no framework do projeto; a rodada seguinte roda tudo antes do primeiro clique.

- **MA-5-01** No fim da rodada, liste os fluxos `passou` com prova estável → gere um teste por fluxo no framework do projeto, com `data-testid` e afirmação do efeito.
- **MA-5-02** Antes de gravar o teste, procure segredo, URL fixa de ambiente e dado de terceiro → verifique que tudo vem de variável de ambiente e que o teste cria o próprio dado.
- **MA-5-03** Rode o teste novo duas vezes seguidas e uma vez em ordem diferente → verifique que passa sempre e não depende de outro teste.
- **MA-5-04** No início da rodada seguinte, rode a suíte de regressão antes de qualquer clique → registre o baseline e abra um caso `regressao` por falha.
- **MA-5-05** Para cada falha da suíte, faça a triagem (regra mudou, ambiente, intermitente, regressão) → verifique com `git log -S` e repetição antes de chamar de defeito.
- **MA-5-06** Confira a trava de produção do teste apontando para um host da lista proibida → verifique que o teste se recusa a rodar.
- **MA-5-07** Para cada defeito corrigido na rodada, escreva o teste que falhava antes da correção → verifique que falha no código antigo e passa no novo.

### 11.6 Segurança funda — `MA-6`

Dependências, segredos, cabeçalhos, autorização no back do que o front esconde e IDOR em todo endpoint com id. Só leitura onde o PERFIL não autoriza mais.

- **MA-6-01** Rode a auditoria de dependências de cada ecossistema do projeto, só leitura → registre contagem por severidade, direta × transitiva e correção disponível.
- **MA-6-02** Rode `segredos.py` no repositório e no bundle publicado → verifique zero segredo; cada achado vira defeito com `arquivo:linha`, `id` e a recomendação de rotacionar.
- **MA-6-03** Com autorização, rode `segredos.py --historico` → verifique segredos que saíram do HEAD mas continuam no histórico e precisam de rotação.
- **MA-6-04** Leia os cabeçalhos de segurança da página e de uma rota da API em cada ambiente → verifique CSP, HSTS, `nosniff`, `frame-ancestors`, `Referrer-Policy` e ausência de versão de software.
- **MA-6-05** Leia os atributos do cookie de sessão e onde o token fica guardado → verifique `HttpOnly`, `Secure`, `SameSite` e registre token em armazenamento acessível por script.
- **MA-6-06** Mande preflight com origem falsa a cada API → verifique que a origem não é ecoada junto de credenciais.
- **MA-6-07** Monte a matriz endpoint × proteção lendo controllers e services → verifique que toda ação que o front esconde por papel é barrada no back pela chamada direta.
- **MA-6-08** Em todo endpoint com id (rota, query, corpo, anexo), use o id de outro dono com a própria sessão → verifique 403/404 na leitura e, em teste, banco intacto na escrita.
- **MA-6-09** Procure nas respostas, nas URLs e nos logs da rodada senha, hash, token, documento pessoal e pilha de erro → registre onde aparece, nunca o valor.
- **MA-6-10** Em ambiente de teste, mande campos extras no corpo (`tenantId`, `ownerId`, `status`, preço) → verifique no banco que foram ignorados.
- **MA-6-11** Em ambiente de teste, faça rajada pequena nos endpoints que enviam código, e-mail ou fazem busca pesada → verifique 429 ou limite equivalente e pare no primeiro.
- **MA-6-12** Em ambiente de teste, envie arquivo com extensão trocada, SVG com script, nome com `../` e acima do limite → verifique recusa e o tipo de resposta no download.

---

## 12. Módulos opcionais — prefixo `MO-`

Ligados quando o projeto tem a ferramenta ou o usuário pede; o estado de cada um fica na tabela
"Módulos opcionais" do `.qa/PERFIL.md`. Procedimento: `references/modulos-opcionais.md`. Desligado
também entra no ledger, como `nao-aplicavel` em `dimensao:MO-<n>`. Os códigos são registrados aqui.

### 12.1 Comparação visual entre rodadas — `MO-7`

Mesmas condições de captura; baseline em `.qa/baseline/`; `visual_diff.py`.

- **MO-7-01** Capture com ferramenta, viewport, DPR, zoom, idioma, tema, papel e registro fixos → confira `innerWidth`, `devicePixelRatio` e `matchMedia` e grave no manifesto.
- **MO-7-02** Congele animação, transição e cursor e espere rede, fontes e imagens → o snippet devolve `imagens_pendentes: 0` e `fontes: loaded`.
- **MO-7-03** Capture a mesma tela duas vezes e compare → `igual`; senão, falta espera ou máscara.
- **MO-7-04** Mascare só área dinâmica, com motivo → nenhuma máscara cobre total, status, contagem ou texto de regra.
- **MO-7-05** Todo par tela × estado × viewport do inventário tem print → `so-na-base` investigado, `so-na-atual` revisado antes de promover.
- **MO-7-06** Diferença acima do limiar → `-comparacao.png` aberto e classificado; regressão vira defeito com as regiões circuladas.
- **MO-7-07** Diferença abaixo do limiar em região de dado → olhada e registrada no `--obtido`.
- **MO-7-08** Tamanho mudou → causa encontrada (conteúdo, quebra, rolagem, viewport) antes de olhar o resto.
- **MO-7-09** Componente compartilhado alterado → comparação de todas as telas que o usam, não só a do pedido.
- **MO-7-10** Produto com tema escuro, RTL ou idioma de texto longo → baseline própria para cada um.
- **MO-7-11** Promova para a baseline só o que foi classificado como intencional → manifesto com motivo, commit e data.
- **MO-7-12** Baseline nova só de tela com todos os casos `passou` → nenhum defeito aberto na tela no momento da cópia.

### 12.2 Acessibilidade automática (axe-core) — `MO-8`

`axe-inject.js` em cada tela e estado; o resultado é caso para olhar, não veredito.

- **MO-8-01** Rode o axe em toda tela, no estado carregado com dado real → cada regra violada vira caso, com o JSON e o print.
- **MO-8-02** Rode de novo em cada estado que muda o DOM (modal, menu, erros exibidos, vazio, erro de API, toast) com `contexto` → violações que só existem no estado aparecem.
- **MO-8-03** Formulário com todos os erros exibidos → `aria-invalid`, mensagem ligada ao campo, nenhum rótulo faltando.
- **MO-8-04** Leia os `incompletos` → cada regra vira caso de revisão manual com o resultado medido.
- **MO-8-05** `duplicate-id` → confira se é cópia oculta do componente (achado de comportamento).
- **MO-8-06** Contraste acusado → razão medida na cor real e proposta com token do design system.
- **MO-8-07** Registre `versao_axe`, `tags` e `contexto` → comparação entre rodadas só com os mesmos três.
- **MO-8-08** `iframe` de outra origem e shadow DOM fechado → analisados à parte ou registrados como não cobertos.
- **MO-8-09** Depois do automático, as linhas manuais `DM-A11-01` a `-06` (o `-05` porque o axe aceita placeholder como rótulo), `-11` a `-13` → casos próprios, nunca deduzidos do resultado do axe.
- **MO-8-10** Tela usada no celular → axe na largura do celular (viewport exato), com `wcag22aa` (alvo de toque).
- **MO-8-11** CSP bloqueou o CDN → arquivo local ou Playwright; nunca afrouxar a CSP nem provar com outra rota.
- **MO-8-12** Correção de acessibilidade → axe no mesmo estado (JSON antes/depois) e teclado de novo.
- **MO-8-13** 🔒 Antes de injetar o axe, confira onde a aba está → em produção ou em aba com sessão real, só arquivo local (`node_modules/axe-core`) ou Playwright com perfil de QA; CDN só em host local, sem sessão real e com hash SRI (`origem_axe` do resultado registrada na evidência).

### 12.3 Entradas aleatórias e hostis (fuzz) — `MO-9`

Só em ambiente de teste, no registro do próprio teste, um valor por vez; `fuzz_valores.py`.

- **MO-9-01** Gere a lista por tipo com os limites da regra real e grave em `notas/` → a semente e os parâmetros ficam registrados para o replay.
- **MO-9-02** Em cada campo de texto, aplique vazio, invisível, unicode, especial, limite e gigante → tela, payload e banco iguais, ou recusa com mensagem no campo.
- **MO-9-03** Grave os marcadores de XSS e abra toda saída do valor → `window.__qaXss` vazio e texto literal em todas.
- **MO-9-04** Grave os marcadores de template → `54439` não aparece em tela, e-mail, PDF nem exportação.
- **MO-9-05** Curingas e aspas em busca, filtro e ordenação → sem 500, sem SQL na resposta, busca por `%` não devolve tudo.
- **MO-9-06** Lista numérica em quantidade, preço e porcentagem → nada de `NaN`, notação científica crua, estouro ou casa decimal perdida; tela e banco iguais.
- **MO-9-07** Lista de datas em campos e filtros → inválida recusada, válida gravada e exibida como o mesmo dia civil.
- **MO-9-08** Lista de e-mail com domínio reservado → injeção de cabeçalho não gera cópia, lista com vírgula não envia para dois, duplicidade compara sem caixa e sem espaço.
- **MO-9-09** Lista de documento → DV errado, dígitos iguais e tamanho errado recusados; válido aceito com e sem máscara; alfanumérico onde a norma permite, com teclado que tenha letras.
- **MO-9-10** Corpos JSON malformados e mass assignment pela API, no registro do teste → 400/422, nada gravado além do permitido (registro relido).
- **MO-9-11** Fórmulas de planilha num campo exportado → texto na exportação, não fórmula.
- **MO-9-12** Valor gigante, sem espaço, RTL, zalgo e emoji em lista, card, tooltip e modal → nada estoura nem cria rolagem horizontal.
- **MO-9-13** Valor acima do `maxlength` posto por script → registrado como teste do servidor; recusa ou gravação inteira, nunca corte calado.
- **MO-9-14** URLs hostis em campo de link ou redirecionamento → `javascript:` e `data:` recusados, redirecionamento só para o próprio site.

### 12.4 Desempenho — `MO-10`

Passivo sempre (espião de rede, vitais); Lighthouse, bundle e SQL quando ligados.

- **MO-10-01** Tempo de cada chamada de cada tela pelo espião → acima de 3 s anotado, acima de 10 s caso de achado, com o ambiente.
- **MO-10-02** Agrupe as chamadas da carga da tela por padrão de URL → nenhuma chamada repetida N vezes variando só o id; duplicadas confirmadas no build.
- **MO-10-03** Meça registros e KB de cada listagem → paginação no servidor quando passa de centenas.
- **MO-10-04** Vitais na tela real com interação → LCP, CLS, interação mais lenta e tarefas longas anotados contra a referência.
- **MO-10-05** Lighthouse na build de produção, 3 vezes, mediana → oportunidades de ganho alto viram casos; tela autenticada sem limpar a sessão.
- **MO-10-06** Relatório de build → rota acima do orçamento, lib duplicada, import inteiro e dicionário de todos os idiomas apontados.
- **MO-10-07** Consultas por requisição no log do servidor → número constante, não proporcional às linhas (sem N+1).
- **MO-10-08** Plano da consulta lenta sem executar escrita → índice faltando ou varredura completa apontados com `arquivo:linha` da consulta.
- **MO-10-09** Digitação e rolagem em lista grande com observador de tarefas longas → nenhuma tarefa > 50 ms por tecla; memória estável em 10 idas e voltas.
- **MO-10-10** Painel com várias chamadas, com uma lenta ou falhando → as outras partes preenchem; o carregamento termina (LI-33, LI-34).
- **MO-10-11** Primeira carga depois de reinício ou deploy → medida à parte do número quente.
- **MO-10-12** Carga leve autorizada, em dev, com teto → p95 e erros registrados; nunca produção nem terceiro.
- **MO-10-13** Correção de desempenho → mesma medição antes e depois (mediana de 3) e payload igual campo a campo.

---

## 13. Provas, entrega e comunicação — `EN`

Toda rodada com correção, relatório, entrega por bloco ou mensagem para o time. Procedimento:
`references/provas-antes-depois.md`, `references/entregas-por-branch.md`,
`references/comunicacao-e-painel.md` e `references/aprender.md`.

- **EN-01** 🔒 Toda correção tem par ANTES/DEPOIS no mesmo estado e com as mesmas marcas → `provas.py gerar <rodada> --conferir` sai 0 e a caixa está no ponto nos dois prints (olhe a grade e a página do par).
- **EN-02** 🔒 Cada defeito do PDF em 4 partes (ANTES · POR QUE · DEPOIS · STATUS), com capa e rodapé com o nome em toda página → a conferência não acha placeholder, imagem faltando nem página sem "N / M".
- **EN-03** Entrega separada por bloco: cada patch aplica sozinho na base → `entregas.py verificar` sai 0, com índice e objetos temporários (nada novo no `.git`).
- **EN-04** A soma dos patches reproduz byte a byte os arquivos alterados → `verificar` compara arquivo a arquivo com `git hash-object --no-filters` e sai 0.
- **EN-05** Typecheck por bloco numa cópia limpa → cada bloco sozinho e com as dependências fica ≤ base; dependência descoberta vai para `deps` do mapa.
- **EN-06** Arquivo com trechos de vários blocos (dicionário, tipos) → nenhum trecho sem dono nem com dois donos, e as instruções mandam aplicar por `git apply`, nunca copiando o arquivo inteiro.
- **EN-07** Rode `mensagens.py <rodada> --estrito --alertas-revisados <rodada>/notas/alertas-revisados.txt` e confira cada alerta do checklist (marque-o no arquivo só depois de conferir) → saída 0 e nenhum `[PREENCHA]`.
- **EN-08** 🔒 Toda mensagem ao time termina com a ressalva do que não foi validado → a seção existe e está inteira.
- **EN-09** Dúvida de regra vira pergunta fechada, com o custo de cada opção, mandada uma vez por rodada → `mensagens.py --oraculo` sem lacuna, e os casos que esperam ficam `bloqueado` com "oraculo: …".
- **EN-10** 🔒 Painel regenerado depois da última mudança do ledger → o `cobertura.py fechar` confere que `relatorio/painel.html` é mais novo que o `cobertura.json` (regere o painel depois do último `rodada --fim`) e a faixa do gate no painel bate com `cobertura.py gate`.
- **EN-11** Antes de entregar a mensagem, valide cada frase pelo risco → "se a pessoa acreditar e agir, onde vai parar?" respondido, e afirmação categórica conferida (`LI-67`).
- **EN-12** 🔒 Rascunho de issue só vira issue com ordem explícita do usuário → nenhum `gh issue create` sem a frase dele; o link volta para o ledger.
- **EN-13** 🔒 Fase Aprender: as duas perguntas respondidas e o lote gravado → `aprender.py validar` sai 0 e a nota `10-aprender.md` lista `APRENDI` e `NAO GRAVADA` com o motivo.
