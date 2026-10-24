# Workflow multiagente da skill qa-total

`workflows/qa-total.workflow.js` aplica o mesmo método do `SKILL.md` em escala: vários agentes
estudam, varrem, planejam, executam, verificam e criticam em paralelo, e o ledger (`cobertura.json`)
continua sendo a única fonte de verdade. Ele não troca o método por outro. Ele só distribui o
trabalho, e o gate de cobertura continua decidindo quando a rodada termina. As fases seguem o ciclo
do `SKILL.md`: Perfil → Estudo (fase 2) → Inventário → Plano → Execução → Verificação → Correção na
hora → Crítico → Relatório → Entrega → Aprender (fase 11).

---

## 1. Quando usar e quando não usar

| Situação | Caminho |
|---|---|
| Escopo `modulo` ou `projeto`: muitas telas, dezenas de endpoints, mais de ~40 itens no inventário | **Workflow** |
| O usuário pediu "multiagente", "ultracode", "teste o sistema inteiro", "auditoria completa" | **Workflow** |
| Precisa de verificação adversarial formal (3 céticos por defeito) antes de reportar ao time | **Workflow** |
| Tela única ou fluxo curto | **Direto pela skill.** O navegador é serial, então orquestrar só acrescenta custo |
| Retestar um defeito, conferir uma correção, responder uma dúvida pontual | **Direto** |
| O usuário quer ver e decidir cada passo enquanto acontece | **Direto**, ou o workflow com `parar_apos` (seção 5) |
| Sem PERFIL confirmado e sem o usuário por perto para confirmar | Só o Perfil: `parar_apos: 'Perfil'` |

⚠️ **O workflow é caro e precisa de opt-in.** Rode quando o usuário pediu multiagente ou ultracode.
Se o escopo é grande e ele só disse "testa", proponha em uma frase, com a ordem de grandeza da
seção 8, e espere o sim. O próprio pedido "testa" não autoriza gastar centenas de agentes.

---

## 2. Antes de chamar: checklist do agente principal

O workflow não para para perguntar nada. Tudo que depende do usuário tem que estar resolvido antes.

1. **PERFIL.** Existe `<raiz>/.qa/PERFIL.md` confirmado? Se não, rode primeiro com
   `parar_apos: 'Perfil'`, mostre o rascunho ao usuário, ajuste, e relance com
   `perfil_confirmado: true`. Um rascunho não confirmado põe a rodada inteira em **somente leitura**,
   sem efeitos externos, de propósito.
2. **Sessões.** Peça ao usuário para deixar logados, na ferramenta de navegador que o PERFIL permite,
   todos os papéis que o alvo exige (admin, usuário comum, outro tenant). O workflow **nunca faz
   login**. Papel sem sessão vira caso `bloqueado` com pedido no retorno.
3. **Servidores no ar.** Front e back-end rodando no ambiente de teste. O workflow pode subir o dev
   server pelo comando do PERFIL, mas **não reinicia** back-end ou serviço que o usuário controla. Para
   corrigir em projeto com UI, deixe também o ambiente de reteste (PERFIL §3.1) aberto na ferramenta
   do PERFIL: o Perfil mede o host dele, e sem medida a correção vira proposta.
4. **Autorizações.** Escrita no ambiente, e-mail real, integração, pagamento de teste: registre no
   PERFIL ou passe em `autorizacoes`, com as palavras do usuário. O que não estiver escrito não é
   disparado.
5. **Alterar código?** O padrão do método é corrigir na hora o **defeito claro** achado num pedido
   de QA (`references/qualidade-e-refatoracao.md` §1). Então: pedido de teste ou QA ("testa",
   "faz QA", "testa tudo", "valida a tela/o fluxo/o sistema", "retesta", "testa a branch X", "dei
   pull, testa") ou de correção ("corrige", "ajusta") → `pode_alterar_codigo: true`. Pedido só de
   análise ("analisa", "olha", "foca em", "investiga", "mede", "revisa a PR/branch", "audita",
   "valida <arquivo, JSON, ideia>") → `false`, e os defeitos viram propostas; verbo de leitura junto
   com pedido de teste também é `false` até o usuário dizer "corrige". O `base_pr` liga o MA-4:
   O MA-4 define o ESCOPO (o diff e o raio de impacto), não a autorização. Testar uma branch ou PR ("testa a branch X", "dei pull, testa") é pedido de QA: corrige o defeito claro. Revisar ou auditar uma branch ou PR ("revisa a PR", "audita") só relata, até o usuário dizer "corrige".
   Testar a PR é `true`; revisar ou auditar a PR é `false`. O argumento **ausente vale `false`**
   (falha fechada), por isso passe-o sempre. Nunca passe `correcao_em_worktree: true` sem o usuário pedir. Mesmo com
   `true`, o workflow só corrige o que passa nos seis testes de defeito claro, respeita
   `corrigir_na_hora: nao` do PERFIL, não toca em camada só relato e deixa de fora o arquivo que
   já estava alterado no `git status` inicial.
5b. **Modo PR e entrega por branch.** Rodada sobre uma branch ou PR: passe `base_pr` (o destino da
   PR); o Estudo gera o escopo do diff e o gate passa a exigir o quadro "mudou × testado". O
   `pode_alterar_codigo` segue o item 5; com os dois juntos, o log diz "modo PR com correção
   autorizada pelo pedido de teste". Pediram a entrega separada por assunto: `separar_entregas: true`.
6. **Pasta da rodada.** O script não lê relógio. Passe `pasta_rodada` com a data de `date +%F`, ou
   deixe o agente de Perfil criar `.qa/<data>-<alvo>`.
7. **Navegador livre.** Durante a execução de UI, nem você nem o usuário usam a aba automatizada.
   Ela é recurso único, e um clique humano no meio de um lote produz falso achado.
8. **Uma rodada por pasta.** Nunca rode dois workflows sobre a mesma `pasta_rodada` ao mesmo tempo:
   seriam dois escritores no ledger.

---

## 3. Como chamar

```js
Workflow({
  scriptPath: 'C:/Users/<usuario>/.claude/skills/qa-total/workflows/qa-total.workflow.js',
  args: {
    raiz_projeto: 'E:/projetos/meu-crm',
    alvo: 'Clientes — listagem, cadastro, edição, follow-up e permissões',
    escopo: 'modulo',
    pasta_rodada: 'E:/projetos/meu-crm/.qa/2026-09-30-clientes',
    skill_dir: 'C:/Users/<usuario>/.claude/skills/qa-total',
    pode_alterar_codigo: true,          // pedido de QA ("testa a PR" também): corrige defeito claro na hora
    base_pr: 'origin/develop',          // opcional: modo PR; muda o escopo, não a autorização ("revisa/audita a PR": false acima)
    separar_entregas: false,            // true quando pedirem a entrega por branch
    max_rodadas_critico: 5,
    autorizacoes: 'pode criar e excluir clientes de teste no dev; e-mail só para caixas +qa@'
  }
})
```

Passe `args` como **objeto JSON**, nunca como texto com JSON dentro. Uma string chega ao script
como um texto só, e ele devolve `erro` com um exemplo de args. Use barras `/` nos caminhos, também
no Windows.

### Argumentos

| Arg | Obrigatório | Padrão | O que faz |
|---|---|---|---|
| `raiz_projeto` | sim | — | Raiz do projeto testado; `.qa/` fica aqui |
| `alvo` | sim | — | O que testar, em linguagem natural; delimita inventário e plano |
| `escopo` | não | `modulo` | `tela`, `fluxo`, `modulo` ou `projeto` |
| `pasta_rodada` | não | `.qa/<date +%F>-<alvo>` | Pasta da rodada. Fora de `<raiz>/.qa/` (ex.: o vault que o PERFIL aponta) só passando-a aqui: o workflow aborta se o Perfil devolver uma pasta fora de `<raiz>/.qa/` e de `pasta_rodada`, ou um `perfil_path` que não seja `<raiz>/.qa/PERFIL.md` |
| `skill_dir` | não | `~/.claude/skills/qa-total` | Onde estão `references/`, `templates/` e `scripts/` |
| `pode_alterar_codigo` | não | `false` | Libera a correção na hora do defeito claro. Em pedido de QA, passe `true`; ausente, só propostas |
| `base_pr` | não | — | Destino da PR (ex.: `origin/develop`): liga o modo PR (escopo do diff no Estudo, lente do crítico e gate "mudou × testado") |
| `separar_entregas` | não | `false` | Fase Entrega separa o trabalho em blocos por branch, com patch, PDF por bloco e índice (`entregas.py`) |
| `gerar_regressao` | não | `true` | Gera testes automáticos de regressão dos fluxos que passaram (MA-5), em `.qa/regressao/` |
| `max_rodadas_critico` | não | `5` | Teto do loop do crítico; ele para antes se secar por 2 rodadas. Bateu o teto sem secar: alerta, pendência "critico: nao secou em N rodadas" e `gate_passou: false`; relance com `retomar_ledger` |
| `autorizacoes` | não | — | Autorizações especiais desta rodada, com as palavras do usuário |
| `perfil_confirmado` | não | `false` | Confirma um PERFIL rascunhado e libera escrita/efeitos que ele permite |
| `parar_apos` | não | — | Para depois da fase com esse título (seção 5) |
| `retomar_ledger` | não | `false` | Pula Inventário e Plano e parte do ledger existente (seção 6) |
| `o_que_mudou` | não | — | Com `retomar_ledger`: o que destravou ("API reiniciada", "papel X logado") |
| `casos_por_lote` | não | `12` | Tamanho máximo de lote de navegador |
| `max_grupos_plano` | não | `60` | Acima disso, grupos são juntados em pacotes. Nenhum grupo fica de fora, e o log diz quantos juntou |
| `revisar_plano` | não | `true` | Revisor independente para cada planejador |
| `correcao_em_worktree` | não | `false` | Projeto sem UI: corrige grupos disjuntos em paralelo, em worktrees, e aplica os patches em série. Cria worktrees e branches no repositório do usuário a partir de `origin/<padrão>`; só com pedido explícito do usuário, e o patch precisa ser conferido contra o HEAD + working tree dele (o retorno traz um alerta lembrando isso) |
| `reserva_orcamento` | não | `150000` | Tokens de saída reservados para gate e relatório quando há orçamento (`+2M` etc.) |
| `limite_agentes` | não | `950` | Teto de agentes da rodada; o runtime corta em 1000 |

---

## 4. O que cada fase faz, e por que roda em paralelo ou em série

| Fase | Agentes | Concorrência | Por quê |
|---|---|---|---|
| **Perfil** | 1 | — | Mede o ambiente (host da API pela rede, nunca pelo `.env`; sem medida, trata como produção). Sem interface (CLI, job, worker), mede cada destino remoto rodando o comando em leitura com log de conexão; `nao-se-aplica` só vale para biblioteca pura com `fala_com_remoto: false` e `arquivo:linha` provando que não há cliente HTTP nem driver de banco. Mede também o **ambiente de reteste** (`ambiente_reteste` com host medido): sem medida ou em produção, ele não serve para reteste, e a correção de projeto com UI vira proposta. Decide modo (escrita ou somente leitura), navegador e ferramenta de UI nativa, papéis logados (ou credencial sem login, para API/CLI), correção na hora (`corrigir_na_hora`), camadas só relato, refatoração, módulos opcionais ligados, logs e banco; cria a pasta e inicia o ledger. PERFIL cuja primeira linha começa com `RASCUNHO` é tratado como rascunho pelo próprio código |
| **Estudo** | 3 lentes (4 com `base_pr`) + fundidor | lentes em **paralelo**, sem navegador | Fase 2 do `SKILL.md`: mapa do projeto e qualidade de código (`.qa/MAPA.md`, `QC`), contratos front × back, invariantes do banco e logs (MA-1 a MA-3), segurança estática e autorização no back (MA-6), escopo do diff (MA-4/5). O fundidor grava o ledger, o MAPA e o PERFIL |
| **Inventario** | 8 modos (mais 1 por tipo especial: llm, desktop, jobs, jogo, site estático) × (varredor + revisor) + fundidor | `pipeline`: cada modo revisa assim que termina, sem esperar os outros | Varredura multi-modal: entradas, elementos de UI, API, regras, papéis/isolamento, estados, efeitos a jusante, transversais e a superfície própria do tipo de projeto (`perfil-e-inventario.md` §4.14, ids da §5.1; `tipo_projeto` pode ter vários slugs separados por vírgula). Cada modo é cego aos outros, então ninguém deixa nada "para o vizinho". Parte do que o Estudo já pôs no ledger. Todo caso nasce com o código da linha do catálogo no título, porque é por ele que o `cobertura.py secoes` conta a seção |
| **Plano** | planejador + revisor por grupo + fundidor | `pipeline` | Cada item ganha acerto, erro, limite, bloqueio e risco, mais as dimensões transversais, `QC`, os módulos aplicáveis (`MA`) e os opcionais ligados (`MO`). O fundidor registra os módulos que não se aplicam e roda o `cobertura.py secoes`: cada seção que falta ganha caso com o código no título ou `dimensao:<PREFIXO>` com `nao-aplicavel` e motivo próprio daquela seção (nunca em lote). Os casos `EN-*` e `MA-5-01` nascem no Relatório e na Entrega |
| **Execucao estatica e API** | organizador de lotes + executores + fundidor | somente leitura em **paralelo**; lotes que gravam em **série** | Ler em paralelo não interfere. Gravar em paralelo cria corrida entre casos que dependem de estado. Cada caso traz o log do servidor quando a mensagem é genérica e o retrato do banco antes e depois da escrita |
| **Execucao UI** | 1 agente por lote | **série**, de propósito | O navegador (ou o dispositivo) é um recurso único: uma sessão, um foco, um espião por página. E o executor de UI escreve direto no ledger. Canal `navegador` (web, com espiões) ou `app` (mobile, desktop, jogo: print do dispositivo, dump da hierarquia de UI, log do app). Antes da primeira escrita, confere o host da API da aba contra o host medido. Opcionais ligados (axe, comparação visual, fuzz) e o desempenho passivo rodam aqui |
| **Verificacao adversarial** | 3 céticos por defeito + aplicador | reprodução no navegador em série; as lentes "causa no código" e "ferramenta/ambiente" em paralelo, ao mesmo tempo | Sobrevive com 2 ou mais votos não-refutados. Com 2 refutações vira `retratado` com o motivo. Votos insuficientes deixam o defeito `inconclusivo`: fica aberto e não é corrigido sozinho. A causa provada vem do log e do banco |
| **Correcao** | organizador + 1 corretor por grupo | **série** (worktree só sem UI) | Só o defeito claro (seis testes) entra; o resto vira proposta. Cada grupo grava o ANTES antes de mexer (no ambiente alvo, só lendo se ele é somente leitura), corrige, registra cada gate como item `estatico:<gate>`, grava o DEPOIS no mesmo estado, retesta na tela real **no ambiente de reteste medido** (escrita só lá, e só se o PERFIL libera), retesta os casos vizinhos e faz regressão. Dois corretores ao mesmo tempo disputariam o navegador e o working tree |
| **Critico de completude** | 6 lentes + fundidor + registro da passada, por rodada | lentes em paralelo; o que acharem é executado, verificado e corrigido em seguida | Loop-until-dry: para com 2 passadas seguidas secas ou no `max_rodadas_critico` (padrão 5). Sem secar, vira alerta e pendência "critico: nao secou em N rodadas; relance com retomar_ledger", e `gate_passou` sai false. As lentes são ledger, código × inventário, papéis × estados, transversais, catálogo item a item (com o tipo de projeto e o `secoes`) e módulos (`QC`, `MA`, `MO`, `EN`, par ANTES/DEPOIS, os cinco valores de dimensão e, no modo PR, o diff). Cada passada é gravada com `cobertura.py rodada --critica` e na nota `08-critico.md` |
| **Relatorio** | gerador de regressão, gate, resolvedor, relator | série | Primeiro os testes automáticos dos fluxos que passaram (MA-5), para o gate cobri-los. O gate marca `rodada --fim agora` antes de rodar. Gate reprovado (e, no modo PR, o `escopo_diff --base <destino> --incluir-working --falhar-se-descoberto`, com o mesmo `--prefixo-api` do parcial; o `cobertura.py gate` já o roda sozinho quando `rodada.escopo_diff` tem base e modo diff): reexecuta o que dá, verifica e corrige o que surgir, e só justifica o que tem causa externa concreta. O resolvedor tem regra para cada motivo do gate: pendente, sem evidência, falhou sem defeito, seção ou módulo sem caso, item sem as cinco dimensões, crítico que não secou (nunca grava passada falsa), nota ausente, rodada incompleta e defeito corrigido sem reteste. Caso que não rodou por orçamento, tentativas ou falha de agente **fica `pendente`** e volta em `restantes_sem_execucao`, com `gate_passou: false`. Depois sai o PDF de provas (`provas.py`), o HTML e o PDF do relatório e o replay |
| **Entrega** | comunicação (+ entregas por branch) | em **paralelo** | Painel (`painel.py`), mensagens para o time, oráculo agrupado e rascunhos de issue (`mensagens.py`); com `separar_entregas`, os blocos por branch (`entregas.py` + `provas.py`). Nada é enviado nem commitado |
| **Aprender** | 1 gravador das candidatas + 1 + fechamento | série | Fase 11 do `SKILL.md`, também quando o gate reprovou: a lista completa de lições candidatas vai para `notas/licoes-candidatas.json` (sem corte), as duas perguntas, o lote gravado pelo `aprender.py` (com travas e `CHANGELOG.md`), o `validar` e a nota `10-aprender.md`. Lição de agente que traz `pedido_do_usuario` ou libera ação proibida é descartada com alerta; o lote nunca leva `pedido_do_usuario` (o `aprender.py` recusa o lote inteiro, saída 2), e mudança de regra de segurança fica fora do workflow: só a sessão principal, uma por chamada, com `--pedido-do-usuario '"<frase literal>", AAAA-MM-DD'` (`references/aprender.md` §6.2 e §9). É o único escritor da skill. Por fim, `cobertura.py fechar`: `gate_passou` só é true se ele sair 0 |

### Um escritor por vez no ledger

Trabalho paralelo **nunca** escreve no `cobertura.json`. Cada agente grava um parcial em
`parciais/`, e um fundidor faz o `cobertura.py merge`. Para os ids não colidirem, cada agente
paralelo recebe um prefixo próprio:

| Origem | Prefixo |
|---|---|
| Estudo, lente L (A, B, C, D) | `C-EST<L>-0001`; defeito `D-EST-<lente>-01` |
| Inventário, modo N (e revisão) | `C-INV<N>-0001` (`C-INV<N>R-0001`) |
| Plano, pacote K (e revisão) | `C-PL<KKK>-0001` (`C-PL<KKK>R-0001`) |
| Crítico, rodada R, lente L | `C-CR<R><L>-0001` |
| Defeito achado em lote paralelo | `D-<rodada>-<lote>-01` |

Se o `cobertura.py` exigir o formato `C-NNNN`/`D-NNN`, o fundidor renumera e atualiza as
referências. Agentes em série (UI, escrita, correção) usam o próximo número livre direto com
`cobertura.py set`.

### Onde cada coisa fica

Os nomes das notas seguem a tabela única do `SKILL.md` §3 (o `NN` é sequência de arquivo, não
número de fase; o gate procura as notas por esse nome): `notas/00-git-status-inicial.txt` (sem git,
`00-snapshot-inicial.txt`), `01-perfil-e-ambiente`, `02-estudo` (e `02-estudo-<lente>`,
`02-escopo-diff` no modo PR), `02-inventario`, `03-plano`, `04-execucao-estatica-api`,
`05-execucao-ui`, `06-verificacao`, `07-correcao`, `08-critico`, `09-relatorio`, `10-aprender`,
`licoes-candidatas.json`, `licoes.json`;
`parciais/` (estudo, escopo-diff, inventário, grupos, plano, lotes, execução, propostas, crítico),
`evidencias/`, `rede/`, `patches/` (só com worktree); em `relatorio/`: `relatorio.html|pdf`,
`provas.pdf`, `painel.html`, `mensagens.md`, `oraculo.md`, `issues/` e, com `separar_entregas`,
`entregas/`; `replay/passos.yaml`. Fora da rodada, e persistentes: `.qa/PERFIL.md`, `.qa/MAPA.md`
e `.qa/regressao/`.

**Oráculo agrupado.** Nenhum agente para a rodada por dúvida de regra: o caso fica `bloqueado` com
a justificativa `oraculo: <pergunta fechada> | A) … => custo | B) … => custo | impacto: … | para: … |
print: …`, sem número (agentes em paralelo colidiriam). Na Entrega, o `mensagens.py --oraculo`
agrupa as perguntas iguais, numera e devolve `perguntas_oraculo` ao agente principal, que as leva ao
usuário numa mensagem só. A resposta volta como `retomar_ledger: true` com `o_que_mudou`, e o
organizador de lotes reabre os casos.

---

## 5. Parar no meio de propósito e intervir

O agente principal só intervém **entre** execuções do workflow. Para ter pontos de decisão, use
`parar_apos` com o título exato de uma fase:

| Parada | Para quê |
|---|---|
| `'Perfil'` | Mostrar o PERFIL rascunhado, confirmar ambientes e autorizações |
| `'Estudo'` | Mostrar o `.qa/MAPA.md`, os achados de qualidade e segurança estática e o escopo do diff antes de enumerar |
| `'Inventario'` | Conferir se o inventário bate com o que o usuário entende por "tudo" |
| `'Plano'` | Mostrar o tamanho (casos por canal) e o custo provável antes da execução cara |
| `'Execucao UI'` | Colher pedidos de sessão antes de verificar |
| `'Verificacao adversarial'` | Mostrar os defeitos confirmados e só então decidir `pode_alterar_codigo` |
| `'Correcao'` | Revisar o diff antes do crítico |
| `'Relatorio'` | Conferir o relatório e o PDF de provas antes das mensagens ao time |
| `'Entrega'` | Revisar painel, mensagens, oráculo e blocos antes da fase Aprender |

**Para continuar:** relance o mesmo `scriptPath`, com os mesmos `args`, **sem** `parar_apos`, e com
`resumeFromRunId` do run anterior. O prefixo de agentes que não mudou volta do cache na hora.

- `pode_alterar_codigo` não entra nos prompts anteriores à correção. Ligar o flag depois de
  `parar_apos: 'Verificacao adversarial'` reaproveita todo o cache.
- `perfil_confirmado`, `autorizacoes` e o próprio PERFIL **mudam o modo**. Eles invalidam o cache a
  partir do Inventário, e isso é o certo: o plano e os lotes dependem do modo.

---

## 6. Retomar

| Situação | O que fazer |
|---|---|
| O run caiu, foi morto ou você editou o script | `Workflow({ scriptPath, args, resumeFromRunId: '<runId>' })`. O prefixo inalterado volta do cache |
| O resultado veio vazio ou estranho | Leia `<transcriptDir>/journal.jsonl` antes de diagnosticar. Ele tem o retorno real de cada agente |
| O usuário logou o papel que faltava, reiniciou a API ou autorizou um efeito | Novo run com a **mesma** `pasta_rodada`, `retomar_ledger: true` e `o_que_mudou: '...'`. Inventário e Plano são pulados, e o organizador de lotes reabre os casos `bloqueado`/`nao-validado` cujo motivo deixou de valer. Depois tudo segue normalmente (execução, verificação, correção, crítico, gate) |
| Sobraram poucos casos (até uns 10) | Faça direto, sem workflow, com `cobertura.py set`, e rode o gate |

---

## 7. O que o workflow NÃO faz sozinho

| Não faz | Como aparece no retorno | O que o agente principal faz |
|---|---|---|
| Login, senha, 2FA | casos `bloqueado` + `pedidos_ao_usuario` ("sessão do papel X") | Pede ao usuário para logar e retoma com `retomar_ledger` |
| Reiniciar back-end ou serviço do usuário | reteste `nao-validado` ("aguardando reinício de X") + pedido | Pede o reinício **uma vez**, com todas as mudanças juntas, e retoma |
| Decidir regra de negócio | defeitos `decisao-de-produto`, fora da correção | Leva ao usuário ou a quem decide, com o print. Nunca altera |
| Disparar efeito externo não autorizado | casos `nao-validado` com o motivo | Pergunta por aquela ação. Se autorizada, registra no PERFIL e retoma |
| Confirmar um PERFIL rascunhado | `modo: somente-leitura` + `perguntas_do_perfil` | Responde às perguntas com o usuário e relança com `perfil_confirmado` |
| Commit, push, merge, PR, criar branch | `branch_sugerida`, `mensagem_commit` e, com `separar_entregas`, `entregas` (blocos com `APLICAR.txt`) | Entrega em bloco copiável. Só versiona se o usuário pedir explicitamente |
| Decidir dúvida de regra | casos `bloqueado` com "oraculo: …" + `perguntas_oraculo` | Leva as perguntas ao usuário numa mensagem só, registra a resposta (fala literal, quem, data, canal) e retoma |
| Enviar mensagem ou abrir issue | `mensagens`, `rascunhos_issue` | Mostra os blocos; quem envia é o usuário. Issue de verdade só com ordem explícita |
| Afrouxar regra da skill | lições recusadas em `aprendizado.recusadas` | Só com pedido explícito do usuário no chat, com a frase literal e a data |
| Defeitos `inconclusivo` | abertos, sem correção | Reproduz direto, com o usuário vendo, e decide |
| Ler o relógio | — | Passa a data em `pasta_rodada` ou deixa o Perfil usar `date` |

---

## 8. Custos e limites

- **Concorrência:** cerca de 10 agentes ao mesmo tempo (`min(16, CPUs − 2)`). O excedente entra
  numa fila.
- **Teto:** 1000 agentes por run no runtime. O script para de abrir trabalho novo perto de
  `limite_agentes` (950) e guarda uma folga para gate e relatório. O que não rodou fica `pendente`,
  e o gate acusa. Nada é cortado em silêncio.
- **Orçamento:** com uma diretiva de tokens do usuário (`+2M`), o script para de abrir trabalho
  quando sobra só `reserva_orcamento`. O log diz o que ficou de fora.
- **Quantidade de agentes:**
  `1 (perfil) + 4 ou 5 (estudo) + 2·M + 1 (inventário; M = 8 modos + os do tipo) + 2·P + 1 (plano) + 1 + Lp + 1 + Le + Lu
  (execução) + 3·D + 2 (verificação) + 1 + G (correção) + R·8 + novidades do crítico + ~4
  (relatório e regressão) + 1 ou 2 (entrega) + 3 (candidatas, aprender e fechar)`.
  Aqui P = pacotes de plano, Lp/Le/Lu = lotes paralelos/de escrita/de UI, D = defeitos, G = grupos
  de correção e R = rodadas do crítico.
  - Módulo médio (6 telas, ~10 defeitos): da ordem de **130 a 200 agentes**.
  - Projeto inteiro (30+ grupos, 40+ defeitos): da ordem de **370 a 650 agentes**.
- **Tempo:** a fase de UI domina, porque é serial. O total cresce com o número de lotes de navegador
  e com a lentidão da API. Para reduzir, aumente `casos_por_lote` ou recorte o `alvo`, nunca
  `max_rodadas_critico` abaixo de 2.

---

## 9. Depois que termina

1. Leia o retorno. Com **`gate_passou: false`** a rodada **não está pronta**: diga isso ao usuário,
   com as `pendencias` (inclusive as `diff:<caminho>` do modo PR e as do `fechamento`), os
   `restantes_sem_execucao` (casos que ficaram `pendente` porque não rodaram) e a
   `provas_conferencia`, e não use "testei tudo". `gate_passou` só é true com o gate, o
   `cobertura.py fechar` saindo 0 e nenhum caso restante sem execução.
2. Abra `relatorio_html`, o `provas_pdf` e o `painel_html`, e envie os PDFs ao usuário.
3. Responda com: números do ledger, defeitos (confirmados, corrigidos na hora com o par
   ANTES/DEPOIS, retestados, propostas), retratações com o motivo, **o que não foi validado e por
   quê**, pedidos ao usuário, sujeira deixada em cada ambiente, e **o que foi registrado** (notas,
   ledger, relatório, MAPA, PERFIL, testes de regressão).
4. `perguntas_oraculo` não vazio: mande as perguntas ao usuário numa mensagem só, fechadas e com o
   custo de cada opção; a resposta volta como `retomar_ledger: true` com `o_que_mudou`.
5. Houve código alterado: arquivos separados dos que já estavam no `git status` inicial, branch
   sugerida e mensagem de commit em bloco copiável, e os blocos de `entregas` quando pedidos. Sem
   commitar.
6. Mensagens para o time: mostre os blocos de `mensagens` e diga o canal; quem envia é o usuário.
7. Diga o que a skill aprendeu (`aprendizado`: lições gravadas, recusadas e o motivo, versão antes e
   depois). É assim que a próxima rodada começa sabendo mais.

---

## 10. Problemas comuns

| Sintoma | Causa provável | Saída |
|---|---|---|
| Retorno `erro: faltam args obrigatórios` | `args` passado como string, ou sem `raiz_projeto`/`alvo` | Passe um objeto JSON |
| Tudo `nao-validado` por "somente leitura" | Ambiente de produção, PERFIL sem escrita ou rascunho não confirmado | Confira `motivo_modo`; aponte o ambiente de teste no PERFIL ou confirme o rascunho |
| Casos de UI todos `nao-validado` | PERFIL sem ferramenta de navegador | Declare a ferramenta no PERFIL e retome |
| Muitos `bloqueado` por sessão | Papéis não logados antes do run | Seção 2, item 2; depois `retomar_ledger` |
| Gate não passa | Agente morreu (lote volta `null`) ou caso sem justificativa | Veja `pendencias` e `restantes_sem_execucao`; o resolvedor só justifica o que tem causa externa concreta, e o que não rodou continua `pendente`. Retome com `retomar_ledger` ou faça direto. Nunca force `passou` |
| Defeito some na verificação | Era artefato da ferramenta: 2 céticos refutaram | Está em `notas/06-verificacao.md` como retratado, com o motivo. Isso é o sistema funcionando |
| Sintaxe do `cobertura.py` diferente do esperado | O script evoluiu | Os agentes rodam `--help` antes. Se falhar, veja a saída do fundidor no journal |
| Diff inflado depois da correção | Fim de linha CRLF | O corretor compara `git diff --stat` com `--ignore-cr-at-eol`. Se diferem, corrige antes de entregar |
| Defeitos viraram propostas com `pode_alterar_codigo: true` | Falharam um dos seis testes de defeito claro, o PERFIL diz `corrigir_na_hora: nao` ou o arquivo era de outra sessão | O motivo está em `notas/07-correcao.md` e no `fora` do log; decida com o usuário |
| `provas_pdf` vazio ou conferência reprovada | Print ANTES ou DEPOIS faltando, ou sem navegador para imprimir | Veja `provas_conferencia` no retorno; recapture o que falta no mesmo estado e rode `provas.py gerar` de novo |
| Tudo `nao-validado` por "host não medido" | O Perfil não conseguiu ler na rede para qual host a API fala; em CLI ou job, devolveu `nao-se-aplica` sem prova | Deixe a aplicação aberta no ambiente de teste, na ferramenta do PERFIL, e retome; em CLI ou job, rode o comando em leitura com log de conexão para medir os destinos. Sem a medida a rodada é tratada como produção |
| `fechamento.saiu_zero: false` | Nota `10-aprender.md` sem as respostas ou sem linha `APRENDI`/`NAO GRAVADA`/`Nenhuma lição`, ou o gate final reprovou | Leia `fechamento.saida`, complete e rode `cobertura.py fechar <rodada>` direto |
| Gate reprova só no modo PR | Arquivo, tela ou endpoint do diff sem caso | As pendências `diff:<caminho>` dizem o quê; o resolvedor cria os casos |
| Pendência `critico — nao secou em N rodadas` | O crítico ainda achava lacunas no `max_rodadas_critico` | Relance com `retomar_ledger: true` (o crítico continua de onde parou); nunca grave passada seca sem rodar o crítico |
| Gate reprova com seção do catálogo sem caso | Caso sem o código da linha no título, ou seção que ninguém classificou | Rode `cobertura.py secoes`; crie o caso com o código ou `dimensao:<PREFIXO>` com motivo próprio daquela seção |
| Correção virou proposta por "ambiente de reteste" | `ambiente_reteste` não medido, ou medido em produção | Abra a aplicação no ambiente de reteste na ferramenta do PERFIL (§3.1 do PERFIL) e retome |
| `aprendizado.validar_ok: false` | Uma gravação piorou a validação da skill (o `aprender.py` desfaz) | Rode `aprender.py validar` e leia o erro; quase sempre o `SKILL.md` passou do limite de linhas |
| `entregas.verificar_ok: false` | Trecho sem dono, dois donos, patch que não aplica sozinho ou soma diferente | Não entregue os blocos; corrija o mapa e rode `entregas.py tudo` de novo |
