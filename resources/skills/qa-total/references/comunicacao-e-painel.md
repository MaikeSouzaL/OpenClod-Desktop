# Comunicação, painel, issue e oráculo

Leia este arquivo em quatro momentos:

- ao escrever **qualquer mensagem que o usuário vai mandar a outra pessoa** (time, dono do produto,
  cliente);
- ao **fechar uma fase ou a rodada** (painel da cobertura);
- quando um defeito precisa **virar issue ou chamado**;
- quando você **não sabe qual é o comportamento certo** (oráculo agrupado).

Ferramentas: `scripts/mensagens.py`, `scripts/painel.py` e `templates/issue.md`. Cada script tem
`--help`. Nenhum deles envia nada, cria issue ou publica página.

## Sumário

1. Regras que valem para qualquer mensagem
2. Estilo "whatsapp" (padrão)
3. Configurar o estilo no PERFIL
4. Estilo formal (e-mail, PR, chamado)
5. `mensagens.py`: do ledger ao rascunho
6. Painel da cobertura (`painel.py`)
7. Rascunho de issue (`templates/issue.md`)
8. Oráculo agrupado: quando você não sabe o certo
9. Armadilhas desta parte
10. Checklist de saída

---

## 1. Regras que valem para qualquer mensagem

| # | Regra | Porquê |
|---|---|---|
| 1 | **Você escreve, o usuário envia.** Mandar mensagem, comentar em PR, criar issue ou chamado em nome dele é ação externa: só com ordem explícita **daquela** ação. Pedir o texto não é pedir o envio | o canal e a relação com o time são dele; o que sai em nome dele não volta |
| 2 | **Valide pelo risco, não só pela verdade.** Para cada afirmação: se a pessoa acreditar e agir, onde ela vai parar? | frase verdadeira mas incompleta manda consertar metade do defeito; frase verdadeira mas mal atribuída manda procurar no commit errado |
| 3 | **Confira o dado antes de afirmar, e antes de concordar.** "Quem fez o quê" se lê no registro de atividade, na auditoria, no log ou no `git log`, nunca na memória | "o sistema fez sozinho" e "alguém aprovou" são defeitos diferentes, com donos diferentes |
| 4 | **Antes de atribuir a alguém, reproduza na base limpa.** "Isso é do commit dele / do back / da correção de fulano" só depois de reproduzir sem as suas mudanças do working tree (uma cópia com `git stash`, ou um worktree da base) | um achado reportado como defeito de outra pessoa era efeito de um filtro do próprio working tree de quem testou; a retratação custou mais que a verificação |
| 5 | **Sintoma, não nome de classe.** Descreva como quem usou a tela descreveria. Se a pessoa pedir a linha do código, ela vai em bloco próprio | nome de método no meio da conversa soa como relatório de máquina e esconde o que a pessoa vai ver |
| 6 | **Print junto** quando o achado depende de onde está na tela; o circulado (vermelho = erro, verde = corrigido) | 45 minutos de texto foram resolvidos em 1 minuto quando o print mostrou **qual** botão era |
| 7 | **A ressalva do que NÃO foi testado vai no fim, inteira, em mensagens curtas.** Nunca se corta | é o trecho que mais tenta sumir quando a mensagem fica informal, e é o que protege quem vai agir em produção |
| 8 | **Retratação com a mesma visibilidade do erro**, no mesmo canal | quem leu o erro precisa ler a correção |
| 9 | **Segredo nunca**: token, senha, cookie, connection string, dado pessoal real. Nem no print, nem no JSON anexado | mensagem de grupo e issue ficam para sempre e circulam |
| 10 | **Canal certo.** Achado de QA e dúvida técnica vão para o grupo ou a conversa técnica; o grupo executivo recebe só resumo e decisão, em poucas mensagens; regra de negócio vai para quem decide a regra | uma lista de perguntas técnicas no grupo executivo foi lida como "está tudo quebrado"; no grupo técnico, com print, saiu resposta em 15 minutos |
| 11 | **Código de registro sempre com o ambiente** ("PED-0042 no ambiente de teste") | os códigos se repetem entre ambientes; o time procura no lugar errado |
| 12 | **Número medido, não adjetivo** ("73 s para 790 registros", "5 de 44") | "muito lento" não diz se é o mesmo problema da semana passada |

**Como aplicar o item 2 quando o risco é alto** (alguém vai mexer em produção, decidir deploy ou
apagar dado): entregue as afirmações a um revisor cético (outro agente) com uma ordem só, **derrubar**
cada frase, e exija para cada uma o campo "o que a pessoa faria de errado se acreditasse nisto". É o
campo de risco que pega a frase defensável e enganosa; conferir só a verdade não pega.

---

## 2. Estilo "whatsapp" (padrão)

É o padrão quando o PERFIL não diz outra coisa. Vale para qualquer chat de time (WhatsApp, Slack,
Teams, Discord).

| O quê | Como | Porquê |
|---|---|---|
| **Um bloco copiável por mensagem** | cada mensagem num bloco de código próprio, na ordem de envio | quem envia manda uma linha por vez; um bloco único com 15 linhas obriga a quebrar na mão |
| **Bloco sem tag de linguagem** | ` ``` ` puro, nunca ` ```bash ` | tag de shell vira botão "Run", e mensagem de chat não é comando |
| **Linhas curtas, uma ideia por linha** | 1 a 3 linhas por mensagem, cada uma com uma ideia | é assim que o time escreve; parágrafo bem pontuado denuncia que não foi a pessoa |
| **Minúsculas** | inclusive nome próprio e início de frase; **códigos e ids preservados** (`D-001`, `PED-0042`, `SKU-ABC-M`) | o tom do chat; o código precisa continuar buscável |
| **Sem pontuação de fim** | ponto final some; `?` solto vale; `:` vale quando abre uma lista | idem |
| **Vocabulário do time** | gírias, abreviações e trocas (`pra`, `tá`, `vc`) **só as que o PERFIL registrou** | inventar gíria é tão falso quanto escrever formal |
| **Não "arrume" até virar redação** | sem conectivo de redação ("ou seja", "portanto", "vale ressaltar", "além disso"), sem analogia ("é tipo o carteiro que sumiu"); não invente erro de digitação | mensagem polida demais tem "cara de IA" e o usuário devolve |
| **Sem markdown dentro do bloco** | sem negrito, bullet, tabela, título | o chat mostra os asteriscos crus |
| **Bloco próprio para o que se copia** | query, comando, caminho de arquivo, branch, id: um bloco só deles | a pessoa vai colar no cliente de banco ou no terminal sem arrastar o texto junto |
| **Uma pergunta por mensagem** | e com print se depende da tela | resposta "sim" para duas perguntas não diz qual |
| **Ressalva no fim** | "o que eu não testei:" e cada item numa mensagem curta | regra 7 da §1 |

**Errado** (um bloco só, formal, técnico, sem ressalva):

```
**Resumo:** Ou seja, o método validarDocumento() em schema.ts:14 não confere o dígito verificador. Portanto o backend retorna HTTP 500. Corrigido.
```

**Certo** (um bloco por mensagem):

```
achei um problema no cadastro de cliente
```

```
cnpj com dígito errado passa da tela e a api devolve erro 500
a tela só mostra "erro inesperado"
```

```
corrigi e testei de novo na tela
agora aparece "cnpj inválido" embaixo do campo e não chama a api
```

```
tá na branch
```

```
fix/cnpj-digito-verificador
```

```
o que eu não testei:
```

```
quem chama a api direto continua recebendo 500, isso é do back
```

O conteúdo técnico não diminui: muda a **embalagem**, não o rigor. Uma mensagem informal que esconde
a ressalva é pior que uma formal.

---

## 3. Configurar o estilo no PERFIL

O estilo é do time, não da skill. Grave no `.qa/PERFIL.md`, na seção "Registro e entrega", e o
`mensagens.py` lê sozinho. A linha de comando manda sobre o PERFIL; o PERFIL manda sobre o padrão.

```
- estilo_mensagens: whatsapp
- mensagens_canal_tecnico: <grupo ou conversa técnica, ex.: "grupo do front, com print">
- mensagens_canal_negocio: <quem decide regra, ex.: "dono do produto, no privado">
- mensagens_canal_proibido: <onde não mandar, ex.: "grupo executivo">
- mensagens_abertura: <linha 1> / <linha 2>          ({alvo} vira o alvo da rodada)
- mensagens_fecho: <linha 1> / <linha 2>
- mensagens_trocas: é=eh; você=vc                   (só o que o time realmente usa)
- mensagens_minusculas: sim
- mensagens_pontuacao_final: nao
- mensagens_max_linha: 90
- mensagens_linhas_por_mensagem: 3
- mensagens_dizer_nao_commitado: sim
- mensagens_codigo: nao                             (sim = arquivo:linha e causa em bloco próprio)
- mensagens_numerar: sim
- mensagens_saudacao_formal: Olá,
```

- Formatos aceitos: `- chave: valor`, `**chave:** valor`, `` `chave`: valor `` e linha de tabela
  `| chave | valor |`. Comentário `<!-- -->` e valor entre `<...>` (placeholder) são ignorados.
- **Como descobrir o estilo**: leia mensagens reais do time, se o usuário der acesso (conversa
  exportada, comentários de PR), e as correções que o usuário já fez ("muito cara de IA", "técnico
  demais", "um bloco por mensagem"). Grave com a data. Correção do usuário vale mais que o padrão.
- Destinatários com tons diferentes (técnico × negócio): mesma chave de canal, e o texto da mensagem
  muda; a regra de risco não muda.

---

## 4. Estilo formal (e-mail, PR, chamado)

Use quando o destino for e-mail, descrição de PR, chamado/ticket, pessoa externa, ou quando o usuário
pedir. `mensagens.py <rodada> --estilo formal` gera **assunto** e **corpo** em blocos copiáveis.

Ordem do corpo:

1. saudação (configurável);
2. contexto: alvo, ambiente, código testado (branch @ commit);
3. por item: título (o sintoma) · severidade · tipo · situação; como reproduzir; esperado; obtido;
   papel; onde e causa (para quem desenvolve); correção ou proposta; reteste; evidências;
4. **o que não foi validado**;
5. "Nada foi commitado." e a branch sugerida.

- Descrição de PR: se o repositório tem modelo (`.github/pull_request_template.md` ou equivalente), o
  modelo do repositório manda; encaixe o conteúdo nele.
- As regras da §1 valem iguais: risco, ressalva, segredo, retratação.

---

## 5. `mensagens.py`: do ledger ao rascunho

```bash
python "$QA/scripts/mensagens.py" "$R"                                   # whatsapp, todos os defeitos (sem retratados)
python "$QA/scripts/mensagens.py" "$R" --defeito D-003 --branch fix/x     # só um, com a branch em bloco próprio
python "$QA/scripts/mensagens.py" "$R" --estilo formal --saida "$R/relatorio/email.md"
python "$QA/scripts/mensagens.py" "$R" --formato html                     # página com "copiar" e os prints
python "$QA/scripts/mensagens.py" "$R" --incluir-retratados               # inclui as retratações
python "$QA/scripts/mensagens.py" "$R" --oraculo                          # perguntas de regra agrupadas (§8); tela + relatorio/oraculo.md
python "$QA/scripts/mensagens.py" "$R" --issue                            # rascunhos de issue (§7)
python "$QA/scripts/mensagens.py" "$R" --estrito --alertas-revisados "$R/notas/alertas-revisados.txt"
```

O `--oraculo` em Markdown, sem `--saida`, imprime na tela **e** grava `<rodada>/relatorio/oraculo.md`,
que é o arquivo que o `cobertura.py fechar` procura; `--saida` escolhe outro caminho.

Códigos de saída: **0** rascunho pronto para revisar · **1** gerado com pendência (segredo mascarado,
lacuna `[PREENCHA: ...]`, evidência citada que não existe em disco ou que fica fora de `evidencias/`,
`rede/`, `notas/` ou `relatorio/` da rodada, anexo de texto com segredo ou, no `--oraculo`, caso
bloqueado ou não validado com cara de dúvida de regra fora do formato; com `--estrito`, também alerta
não revisado) · **2** uso, ledger ou defeito inválido. Evidência fora da rodada (caminho com `..`,
absoluto que resolve fora) nunca vira anexo: sai o alerta "ARQUIVO FORA DA RODADA", e a prova vai
copiada para `evidencias/`.

**Tipo de projeto muda o alerta de jargão.** Com `biblioteca`, `cli` ou `api` em `rodada.tipos_projeto`,
o nome que aparece no id de um item `funcao:`, `comando:` ou `api:` do ledger, e o nome terminado em
`Error`/`Exception`, não vira alerta de "nome de código": ali o nome público é o sintoma. A frase do
reteste usa o **Nome** do ambiente de reteste do PERFIL §3.1 ("corrigi e testei de novo em <Nome>";
sem ele, "no alvo") e acrescenta "fora do pacote instalado (ver ressalva)" quando há caso `PJ-LIB-07`
ou de `comando:` bloqueado.

**Alertas e `--estrito`.** Cada alerta do checklist sai com uma impressão de 12 caracteres
(`Alerta [3f9a0c1b2d4e]: ...`). Sem `--estrito` eles não mudam a saída: o 0 diz "nada bloqueante",
não "nada a revisar". Para entregar com prova de revisão, rode com `--estrito` (todo alerta não
revisado vira pendência, saída 1), confira cada um, ponha a impressão (ou o texto inteiro do alerta)
numa linha de um arquivo e passe-o em `--alertas-revisados`. Alerta fixo, como "Nada foi commitado:
confira com git status", só sai da contagem assim: depois de conferir de verdade.

**De onde vem cada mensagem.** O script não inventa: monta com o que está no ledger. Por isso,
**escreva o ledger já pensando na mensagem**:

| Campo do ledger | Vira | Escreva assim |
|---|---|---|
| `defeitos[].titulo` | a primeira linha ("1) …") | o sintoma, como quem usa descreveria |
| caso que falhou → `resultado_obtido` | o que aconteceu | o que se viu, com número, sem nome de classe |
| caso que falhou → `passos` | "como reproduzir" (aberto e não corrigido) | passos separados por `;` |
| caso que falhou → `resultado_esperado` | "o certo seria" | o comportamento, não a implementação |
| caso de regressão que passou → `resultado_obtido` | "agora: …" | o que a tela mostra depois da correção |
| `defeitos[].justificativa` | motivo (não corrigido, corrigido sem reteste) ou a pergunta (decisão) | quem precisa agir e por quê |
| `defeitos[].correcao` | "sugestão" (melhoria: no whatsapp sem `--com-codigo` sai "proposta registrada no relatório"; com `--com-codigo`, em bloco próprio) ou "ficou decidido" | proposta ou decisão literal |
| `onde`, `causa` | só com `--com-codigo`, em bloco próprio (bloco próprio não gera alerta de nome de código; campo do ledger que sai em mensagem com nome de código gera o alerta "campo do ledger com detalhe de codigo", que se marca em `--alertas-revisados`) | `arquivo:linha` e a causa em 1 a 3 frases |
| casos `nao-validado`/`bloqueado`/`pendente` | a ressalva no fim | a justificativa diz o que falta e o que destrava |

**O que o script faz sozinho:** minúsculas preservando códigos; quebra em linhas curtas e em
mensagens de até N linhas sem cortar dentro de parênteses ou aspas; tira ponto final e conectivo de
redação; aplica as trocas do PERFIL; mascara segredo (`[REMOVIDO]`) em modo estrito com o módulo comum
(`scripts/_mascara.py`, as mesmas regras do `segredos.py`) no texto, no alvo e no nome e caminho de cada
anexo, e varre o conteúdo de todo anexo de texto (`.json`, `.txt`, `.log`, `.har`, `.jsonl`, `.ndjson`,
`.md`, `.csv`, `.yaml`, `.yml`, `.xml`, até 3 MB; `.json`, `.har`, `.jsonl` e `.ndjson` também como
estrutura: par nome/valor, JSON dentro de string): achou token, senha, Basic ou cookie de sessão, sai 1; prefere
o print `-circulado`; avisa evidência que não existe em disco (e sai 1: mensagem sem a prova não vai); monta a
ressalva (casos não validados ligados ao defeito e ao item, corrigido sem reteste, o resto da rodada
em uma contagem, rodada aberta); fecha com o checklist "antes de mandar" com alertas por mensagem:
nome de código, caminho de arquivo, afirmação categórica ("nunca", "todos", "não existe"), analogia,
atribuição a alguém.

**O que ele não faz, e é seu trabalho:**

1. **Revise cada bloco.** O rascunho é ponto de partida. Reescreva as linhas apontadas no checklist
   em linguagem de sintoma; troque "o certo seria: <texto técnico>" por como a pessoa diria.
2. **Responda o checklist de verdade**: canal, risco por mensagem, atribuição na base limpa, quem fez
   o quê no registro de atividade, ambiente junto do código, print certo, ressalva inteira.
3. **Saída 1 não se entrega**: preencha as lacunas, tire o segredo do ledger (não só da mensagem),
   salve a evidência citada que falta em disco e, no `--oraculo`, reescreva o caso fora do formato.
4. **Mostre ao usuário** um bloco por mensagem, na ordem, com o anexo indicado ao lado e o canal
   dito explicitamente. Diga quais alertas você resolveu e como.

O formato `html` gera uma página local com número, botão "copiar" e o print embaixo de cada
mensagem: útil quando são muitas. Não abra o navegador do usuário por conta própria; diga onde está o
arquivo.

---

## 6. Painel da cobertura (`painel.py`)

```bash
python "$QA/scripts/painel.py" "$R"                         # grava $R/relatorio/painel.html
python "$QA/scripts/painel.py" "$R" --mesmo-alvo            # evolução só com rodadas do mesmo alvo
python "$QA/scripts/painel.py" "$R" --historico outra/.qa   # evolução com rodadas de outra pasta
python "$QA/scripts/painel.py" "$R" --so-esta --embutir-imagens --saida painel-para-enviar.html
python "$QA/scripts/painel.py" "$R" --exigir-gate           # sai 1 se o gate da rodada não passar
```

Um arquivo HTML autocontido, sem CDN, que funciona offline e abre também como XML bem formado.

**Quando gerar:** ao fim de cada fase, junto com `cobertura.py gate --so-cobertura`, e na entrega.
Ele não substitui o relatório em PDF; é a visão navegável do ledger.

**Como ler, nesta ordem:**

1. **Faixa do gate.** Vermelha = a rodada não está pronta, com os motivos. A origem diz se veio do
   `cobertura.py` ou de um cálculo aproximado (quando o `cobertura.py` não carregou).
2. **Números:** itens, casos, cobertura (concluídos ÷ total), passou, defeitos (abertos, retestados),
   itens sem caso, **aguardando decisão** (casos bloqueados por oráculo, §8) e sujeira.
3. **Barra por status**, com legenda clicável que filtra a tabela de casos. A cor nunca é o único
   sinal: o nome do status está escrito.
4. **Defeitos por severidade × status** e **casos por tipo de item e por técnica**: tipo de item com
   muitos casos e nenhum `falhou` costuma ser teste raso, não sistema perfeito.
5. **Evolução entre rodadas** (gráficos e tabela): cobertura e passou subindo, abertos indo a zero.
   `falhou` subindo numa rodada nova do mesmo alvo é regressão a investigar. Por padrão entram as
   pastas vizinhas que têm `cobertura.json` (a própria `.qa/`).
6. **Itens sem caso** (reprovam o gate).
7. **Casos**: busca (sem acento, várias palavras), filtros por status, técnica, tela e item, "só o
   que não passou", ordenação por coluna. Em CLI, API, biblioteca ou job a coluna e o filtro viram
   **área**: o ancestral de topo `comando:`, `api:<recurso>`, `funcao:<módulo>` ou `job:` (só fica
   "tela" quando todo caso tem ancestral `tela:`). Clique no título para ver passos, esperado, oráculo,
   obtido, justificativa e as miniaturas. Evidência marcada "não existe em disco" derruba o gate.
8. **Defeitos**: clique para ver onde, causa, correção, casos e as miniaturas ANTES (moldura
   vermelha), DEPOIS (verde) e RETESTE (azul).
9. **O que não foi validado**, **sujeira**, **validação do ledger** e **rodada** (autorizações,
   baselines, passadas do crítico: diz se o crítico secou).

**Limites:**

- Os links de evidência são **relativos**: mova o painel junto com a pasta da rodada. Para mandar só
  o arquivo, use `--embutir-imagens` (imagens até `--limite-kb`, padrão 400 KB).
- O painel mostra o que está no ledger, com todo texto passando pela máscara comum de segredos: o que
  casar vira `[REMOVIDO]`, o aviso sai no stderr (sem o valor) e a saída é **1**. Isso protege o
  arquivo, não o ledger: limpe a fonte (o ledger nunca guarda segredo; o `cobertura.py` já recusa na
  entrada e o `validar` acusa `segredo-no-ledger`). Ledger com esquema inválido sai **2**.
- Compartilhar é decisão do usuário (anexar o arquivo, publicar numa página privada). Você diz onde
  ele está.

---

## 7. Rascunho de issue (`templates/issue.md`)

**Quando:** um defeito que outra pessoa ou outro time vai resolver, ou quando o usuário pede "monta a
issue" / "abre o chamado".

```bash
python "$QA/scripts/mensagens.py" "$R" --issue                 # todos que ainda precisam de ação
python "$QA/scripts/mensagens.py" "$R" --issue --defeito D-004 # um só (qualquer status)
```

Gera `<rodada>/relatorio/issues/D-NNN.md` a partir de `templates/issue.md`, com título (o sintoma),
severidade, tipo, situação, ambiente, código testado, papel, resumo, passos numerados, esperado e
oráculo, obtido, evidências, se foi reproduzido por outro caminho, onde e por quê, reteste e **o que
não foi validado**. O que o ledger não tem sai como `[PREENCHA: ...]` e o script sai com 1.

Para não sobrar lacuna, complete o ledger pelo `cobertura.py`, nunca editando o JSON à mão: os passos
do caso com `cobertura.py set "$R" C-NNNN --passos "…"` e o segundo caminho que reproduziu o defeito
(outra ferramenta, API direta, outro registro) com `cobertura.py set "$R" D-NNN --repro "…"`, que vira
"Reproduzido por outro caminho". Sem `--repro`, a linha só sai preenchida quando dois casos `falhou`
do ledger apontam para o defeito.

**Criar a issue de verdade** é ação externa: só com ordem explícita do usuário, naquele repositório,
naquela hora. "Monta a issue" é pedido de texto. Com a ordem:

1. Confirme o repositório e a visibilidade (`gh repo view --json nameWithOwner,visibility`).
   Repositório público: nada de dado de cliente, e-mail real, URL interna ou print sem tarja.
2. Procure duplicata (`gh issue list --search "<sintoma>" --state all`).
3. Use só rótulos que existem (`gh label list`).
4. `gh issue create --title "<sintoma>" --body-file <arquivo>`. O `gh` não sobe imagem: os prints
   entram arrastados pela interface web, ou o usuário anexa. Caminho relativo no corpo não funciona
   fora do repositório.
5. Registre o link no ledger: `cobertura.py set <rodada> D-NNN --obs "issue: <url>"`.

Jira, Azure Boards e outros: o mesmo rascunho serve; crie pela ferramenta que o time usa, com as
mesmas regras.

---

## 8. Oráculo agrupado: quando você não sabe o certo

Situações: não há especificação; os oráculos divergem (código × documentação × regra do usuário ×
tela irmã); a resposta é regra de negócio (quem pode, quando, limites, cálculos, textos de regra).

**Não chute** (escolher é decidir produto no lugar de quem decide) e **não trave** (o resto da rodada
segue).

### 8.1 Antes de perguntar, leia

Pergunta que dava para responder lendo queima a confiança de quem responde. Procure primeiro:
`git log -S"<símbolo>"` e a mensagem do commit; changelog, ADR e documentação do projeto; o PERFIL e
as regras do usuário; o que o backend valida; o comportamento das telas irmãs. Só vira pergunta o
que sobrar.

### 8.2 Marque e siga

```bash
python "$QA/scripts/cobertura.py" set "$R" C-0031 --status bloqueado \
  --justificativa "oraculo: Q3 | Cliente inativo deve aparecer no combo de novo pedido? | A) some do combo => quem reativa precisa ir ao cadastro | B) aparece desabilitado com o motivo => um clique a mais, mas explica | impacto: alto | para: dono do produto | print: evidencias/14-combo-com-inativo-circulado.png"
python "$QA/scripts/cobertura.py" set "$R" C-0032 --status bloqueado --justificativa "oraculo: pergunta Q3"
```

- Partes separadas por `|`: `Qn`, a **pergunta fechada**, as **opções** `A) <opção> => <custo ou
  efeito>`, `impacto: alto|medio|baixo`, `para: <quem decide>`, `print: <caminho>`. Outros casos
  esperando a mesma pergunta levam só `oraculo: pergunta Qn`.
- **Sem decorar o formato:** o `cobertura.py set` monta a justificativa (e põe o caso em `bloqueado`):

  ```bash
  python "$QA/scripts/cobertura.py" set "$R" C-0031 \
    --oraculo-pergunta "Cliente inativo deve aparecer no combo de novo pedido?" \
    --opcao "some do combo => quem reativa precisa ir ao cadastro" \
    --opcao "aparece desabilitado com o motivo => um clique a mais, mas explica" \
    --impacto alto --para "dono do produto"
  ```

  Cada `--opcao` precisa do `=>` com o custo; são pelo menos duas. O print vai como `--evidencia`.
- **Fora do formato não conta.** Caso `bloqueado` ou `nao-validado` cuja justificativa fala de regra,
  decisão, pergunta, oráculo ou produto sem começar por `oraculo:` não entra nas perguntas nem na
  contagem de "quem espera": o `mensagens.py --oraculo` lista cada um no checklist e sai **1**.
  Reescreva com `--oraculo-pergunta` ou, se não é dúvida de regra, diga o que falta e o que destrava.
- Defeito que é regra de negócio: `tipo decisao-de-produto`, `nao-corrigido`, com a justificativa no
  mesmo formato (sem o prefixo, se quiser).
- O caso fica `bloqueado` com justificativa: o gate aceita, e o painel o mostra como **aguardando
  decisão**. Na entrega, ele aparece em "o que não foi validado", com a pergunta.

### 8.3 Uma vez por rodada, tudo junto

```bash
python "$QA/scripts/mensagens.py" "$R" --oraculo            # ou --estilo formal, ou --formato html
```

Por padrão, em Markdown, mostra na tela e grava `<rodada>/relatorio/oraculo.md`; no `--formato html`,
grava `relatorio/perguntas.html`. É esse arquivo que o `fechar` confere.

Sai uma mensagem só, no estilo do time: abertura ("tenho 3 dúvidas de regra… responde só com a
letra"), cada pergunta com as opções e o print, o que fica parado no fim, e os comandos para
registrar a resposta. Mande **uma vez por rodada**, num lote, ordenado por impacto. A exceção é a
pergunta que trava o caminho crítico inteiro: essa vai na hora, sozinha.

**Pergunta boa** (o método do grill-me):

| Faça | Não faça |
|---|---|
| fechada: A, B (e C, se existir), respondível com uma letra | aberta: "como deveria funcionar?" |
| o custo ou o efeito de cada opção | opção sem consequência ("A) mostrar, B) esconder") |
| "manter como está" como opção, quando for real | esconder que o comportamento atual é uma das escolhas |
| print de onde está na tela | descrever a tela em texto e torcer para entenderem |
| ordenada pelo que mais trava ou mais custa errar | ordem de descoberta |
| as que mais travam primeiro; acima de 7, as outras vão no mesmo lote, marcadas como menos urgentes | despejar 20 perguntas sem prioridade |
| diga o que acontece sem resposta: os casos ficam bloqueados e saem como não validados | deixar implícito que você vai decidir sozinho |

Exemplo:

```
3) cliente inativo deve aparecer no combo de novo pedido?
```

```
a) some do combo — quem reativa precisa ir no cadastro
b) aparece desabilitado com o motivo — um clique a mais, mas explica
```

### 8.4 Registre a resposta e reabra

- **Fala literal, quem, data e canal**, no ledger: `--obs "oraculo Q3 respondido: 'b' — <quem>,
  <data>, <canal>"` nos casos; no defeito, `--correcao "Decisão: <o que ficou> — '<fala>', <quem>,
  <data>, <canal>"`.
- Regra que vale para as próximas rodadas vai também para o `.qa/PERFIL.md`, com a data.
- Reabra os casos (`--status pendente`), execute e registre a prova. Se a resposta contradiz o
  código, o caso vira `falhou` com defeito; se a decisão é "manter", o defeito fecha como decidido
  (`nao-corrigido`, justificativa "decidido: manter — <fala>").
- Resposta ambígua: pergunte de novo, com o print, sobre o ponto exato. Não interprete.

---

## 9. Armadilhas desta parte

- **Rascunho entregue sem revisão.** O script gera "o certo seria: <texto técnico>"; quem envia
  percebe que não foi escrito por gente. Revise cada bloco.
- **Ressalva cortada na revisão** para a mensagem "ficar menor". Ela nunca sai.
- **Concordar com uma explicação sem ler o registro** ("o sistema aprovou sozinho"): leia a
  atividade/auditoria e só então concorde ou corrija.
- **Atribuir ao trabalho de outra pessoa o efeito do seu working tree.** Reproduza na base limpa.
- **Mesma pergunta em dois canais**, com respostas diferentes: um canal por assunto, e registre qual.
- **Link relativo do painel quebrado** porque o HTML foi movido sozinho: mova a pasta da rodada, ou
  use `--embutir-imagens`.
- **`gh issue create` não sobe imagem**: anexe pela interface, ou a issue fica sem a prova.
- **Conferir fim de linha lendo o arquivo em modo texto**: o Python converte `\r\n` em `\n` na
  leitura e o CR some. Confira em binário (`open(arq, 'rb').read().count(b'\r')`).
- **Print anexado antes de existir em disco**, ou um print do momento errado: o script avisa
  "não existe em disco"; abra o arquivo antes de citar.
- **Pergunta de regra feita só por texto**, sem print: a resposta certa para a pergunta errada.

---

## 10. Checklist de saída

- [ ] Toda mensagem para o time revisada: alertas do checklist resolvidos, `mensagens.py --estrito
  --alertas-revisados <arquivo>` com saída 0 (ou a pendência dita ao usuário).
- [ ] Canal dito explicitamente em cada lote; nada técnico no canal executivo.
- [ ] Ressalva do que não foi testado no fim de cada lote, inteira.
- [ ] Nenhum segredo em mensagem, print, JSON anexado, issue ou painel.
- [ ] Painel regenerado depois da última mudança do ledger; a faixa do gate bate com o
  `cobertura.py gate`.
- [ ] Issue só como rascunho, salvo ordem explícita; se criada, o link está no ledger.
- [ ] Perguntas de oráculo mandadas uma vez, juntas (`mensagens.py --oraculo` com saída 0: nenhuma
  dúvida de regra fora do formato); respostas registradas com fala literal, quem, data e canal; casos
  reabertos e executados.
- [ ] A resposta ao usuário diz o que foi registrado e onde (ledger, nota, PERFIL, rascunhos).
