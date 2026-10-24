# Correção, reteste, registro e relatório

Leia este arquivo em três momentos: ao achar o **primeiro defeito** (antes de tocar em qualquer
arquivo), ao **retestar** uma correção (sua ou de outra pessoa) e ao **fechar a rodada**.

Ele responde: o que você pode alterar, como corrigir sem quebrar outra coisa, como provar que
corrigiu, como registrar a cada passo e como entregar (relatório em PDF, replay, mensagem para o
time).

Modelos usados aqui: `templates/defeito.md`, `templates/nota-de-fase.md`,
`templates/relatorio.html`, `templates/passos.yaml`. Scripts: `scripts/cobertura.py`,
`scripts/circular.py`, `scripts/gerar_pdf.py` (sintaxe exata no `--help` de cada um).

## Sumário

1. Fronteira de autorização
2. Antes de corrigir: é defeito mesmo? Onde nasce?
3. Protocolo de correção (com autorização)
4. Reteste de correção feita por outra pessoa ("deu pull", "subi a correção")
5. O ledger durante a correção
6. Registro por fase — a cada passo, nunca só no fim
7. Melhorias — além dos defeitos
8. Relatório final
9. Replay e automação
10. Mensagem para terceiros (o time)
11. Armadilhas desta fase
12. Checklist de saída da rodada

---

## 1. Fronteira de autorização

A autorização vem do **pedido do usuário**, não da gravidade do defeito.

| O usuário disse | Você entrega | Você não faz |
|---|---|---|
| testa, faz QA, E2E, "testa tudo", "valida a tela/o fluxo/o sistema", retesta — atendido por esta skill | a correção na hora de cada **defeito claro** (os seis testes de `references/qualidade-e-refatoracao.md` §1.2), com ANTES/DEPOIS e reteste; o resto vira proposta com `arquivo:linha` | não corrige o que não é claro, nem se o PERFIL diz `corrigir_na_hora: nao`, a camada é só relato, o arquivo é de outra sessão ou o ambiente é produção |
| analisa, olha, varre, investiga, mede, foca, "testa sem corrigir", "revisa e testa", audita/auditoria, "valida <artefato>" (JSON, arquivo, ideia), "o que precisamos fazer?" | diagnóstico com número, lista de correções propostas com `arquivo:linha`, causa e a mudança sugerida | não altera arquivo nenhum |
| corrige, ajusta, muda, aplica, "pode corrigir na hora" | a alteração, o reteste na tela real e o registro | não amplia o escopo além do que a rodada achou |
| sobe, manda para produção, abre o PR | o que falta para **ele** subir: branch sugerida, mensagem de commit, arquivos, o que não foi validado | não roda commit, push, merge nem abre PR, salvo pedido explícito **dessa execução** |

**Desempate:** verbo de leitura + pedido de teste ("revisa a PR e testa", "audita e testa") = só
relato, até o usuário dizer "corrige". O MA-4 define o ESCOPO (o diff e o raio de impacto), não a autorização. Testar uma branch ou PR ("testa a branch X", "dei pull, testa") é pedido de QA: corrige o defeito claro. Auditar executando uma branch ou PR ("audita", "testa sem corrigir") só relata, até o usuário dizer "corrige"; "revisa a PR" só de leitura, sem executar, é do code-review: avise.

Porquê: estar certo não é o ponto. O controle do repositório é do usuário, e ampliar escopo sozinho
tira dele exatamente esse controle. Sinal de que você passou do ponto: precisar escrever "de
passagem, mexi em X". Se a alteração precisa de aviso, ela precisava de permissão antes.

- Correção pequena e óbvia achada durante uma **análise** entra na lista **como item**
  (`arquivo:linha` e o trecho proposto), não no working tree. Se valer a pena fazer na hora, ofereça
  em uma frase e espere. (Num pedido de **QA**, vale a primeira linha da tabela: corrige na hora.)
- Registre a autorização na rodada (`cobertura.json` → `rodada`) com a frase do usuário e a data.
  Autorização vale para a rodada e para o escopo dela; não vale para refactor, para outro módulo nem
  para outra sessão.
- Pedir o texto do commit **não** é pedir a execução do commit.

### 1.1 Decisão de produto nunca se altera

É decisão de produto, e portanto você **relata e não altera**:

- regra de negócio: quem pode, quando pode, limites, cálculos, transições de estado;
- texto que expressa uma regra ("mínimo de 51", "só o criador conclui");
- o que um botão deveria fazer, se deveria existir e para quem aparece;
- comportamento que o código tem **de propósito** (ver 2.2).

Como relatar: defeito com `tipo: decisao-de-produto`, `status: nao-corrigido` e a **pergunta exata**
para quem decide, fechada, com as opções e o efeito de cada uma, e com o print junto:

> Hoje, ao fazer A, a tela faz B (print 07). O código faz assim desde `<commit>` (`<data>`). Deve
> continuar B, ou passar a C? Se C, o efeito é D.

Quando alguém decidir, registre a **fala literal, quem, data e canal**. Se a decisão for "manter", o
item fecha como decidido, sem código.

Porquê do print junto: pergunta ambígua produz resposta certa para a pergunta errada. Num caso real,
45 minutos de troca por texto foram resolvidos em 1 minuto quando o print mostrou **onde** na tela
estava o botão.

### 1.2 Fora do escopo da rodada

Defeito achado fora do alvo: registre (`status: nao-corrigido`, justificativa "fora do escopo desta
rodada"), não corrija sem pedido. Nada que foi visto fica sem registro.

### 1.3 Código que não é seu

Se o PERFIL marca um repositório ou camada como **só relato** (ex.: backend de outro time):

- ler para diagnosticar é certo e necessário — é o que separa "defeito daqui" de "isto espelha o
  servidor";
- a correção para no relato: `arquivo:linha`, método, efeito medido, quem precisa agir;
- contenha do seu lado o estrago que der (sem inventar correção de fachada). Se o seu lado está
  certo e o defeito é só do outro, diga isso com todas as letras.

---

## 2. Antes de corrigir: é defeito mesmo? Onde nasce?

**2.1 Reproduza por um segundo caminho** (detalhes em `references/execucao-e-evidencias.md`). Se o
achado some quando você troca a ferramenta, ele é `retratado`, com o motivo.

**2.2 Foi de propósito?**

```bash
git log -S "<símbolo ou texto>" --oneline -- <arquivo>
git log -L <início>,<fim>:<arquivo>
```

Leia a mensagem do commit e o histórico de decisões do projeto (changelog, ADR, CLAUDE.md). O código
diz o que foi decidido **por último**: se uma trava foi removida de propósito, a ausência dela não é
bug. "O código não faz X, logo X não é a regra" é um salto — quem responde é o histórico.

**2.3 A correção já existe, mas está no que você testa?** "Está escrito que foi corrigido" não é "está
no código". Confira a branch e o commit do ambiente (`git log --oneline -1`,
`git branch --contains <commit>`), e no ambiente publicado a versão ou o hash do build. Ambiente sem
a correção é achado de ambiente, não regressão.

**2.4 Causa raiz, não sintoma.** Siga o dado de onde ele nasce até onde aparece errado: quem escreveu
este valor, quem leu, de onde leu. Sinais de remendo de sintoma, que devem levantar suspeita na hora
de corrigir:

- heurística pelo texto de um rótulo ou mensagem;
- `if` especial para um id ou um caso;
- `try/catch` que engole o erro;
- valor cravado onde deveria haver uma fonte.

Exemplo genérico: o tipo de um campo era mapeado errado na origem, e duas heurísticas por texto do
rótulo tentavam remendar depois. A correção foi no mapa, e as heurísticas saíram.

**2.5 Mapeie o alcance antes de editar.** A lista vai para a nota da fase e define o teste de
regressão.

| Procure | Como | Porquê |
|---|---|---|
| outros usos do componente/função | `grep -rn "<Nome>" <src>` | mudança em compartilhado afeta telas que você não abriu |
| **cópias** da mesma lógica (copia e cola) | grep por um trecho característico do código | corrigir uma cópia deixa as outras erradas, sem erro e sem aviso |
| constantes duplicadas da mesma regra | grep pelo valor e pelo nome | dois nomes para a mesma regra deixam o valor errado sobreviver nos dois |
| todos os caminhos para o mesmo efeito | ler as rotas/handlers que gravam o mesmo campo | guard num caminho só é contornável pelo outro (ex.: concluir por botão **e** por combo de status) |
| todos os leitores do mesmo estado | o que a tela mostra × o que o payload envia × o que a validação lê | corrigir só o payload faz o reteste denunciar a outra metade |

---

## 3. Protocolo de correção (com autorização)

**0. Baseline, antes de tocar em qualquer arquivo.** Anote na nota da fase:

- `git status --porcelain` e `git diff --stat` do início — o que já estava alterado é de **outra
  sessão** e não entra no seu relatório;
- a contagem do typecheck, do lint e dos testes, e se o build passa. Ex.:
  `npx tsc --noEmit 2>&1 | grep -c "error TS"`. Esse número é o baseline;
- o fim de linha de cada arquivo que você vai editar:
  `python -c "import sys;b=open(sys.argv[1],'rb').read();print('CRLF',b.count(b'\r\n'),'LF',b.count(b'\n'))" <arquivo>`.

**1. Corrija a causa**, com a menor mudança que resolve **todos** os leitores e caminhos mapeados
em 2.5.

**2. Siga as regras de código do projeto** (PERFIL, CLAUDE.md, CONTRIBUTING, lint). Exemplos comuns:
sem comentários no código; texto de UI só pelo dicionário, com a chave em **todos** os idiomas e nos
tipos; reaproveitar chave e componente existentes antes de criar; padrão de serviço e de erro do
repositório.

**3. Componente compartilhado:** prefira mudança **aditiva** (prop opcional com padrão que preserva o
comportamento atual) — sem a prop, nenhum outro uso muda. Se a mudança altera o padrão, teste pelo
menos um uso **fora** da tela do alvo, na tela real (vitrine de componentes não conta).

**4. Verificação mecânica** — todas obrigatórias, com o resultado na nota:

- `git diff --stat` igual a `git diff --ignore-cr-at-eol --stat`. Se divergir, quem escreveu (script
  ou editor) trocou o fim de linha. Volte ao fim de linha original gravando em binário
  (`replace(b'\r\n', b'\n')` ou o inverso). Porquê: um diff 30 vezes maior que a mudança é
  irrevisável e já derrubou PR inteira.
- typecheck, lint, build e testes **no baseline ou abaixo dele**. Número **menor** também é alarme:
  um erro de sintaxe (aspa não escapada num dicionário, chave inserida no lugar errado) interrompe a
  análise e esconde o resto.
- dicionários de idioma com as mesmas chaves em todos os arquivos.
- leia o `git diff` linha a linha: só pode haver o que você quis mudar.

**5. Mudança que exige reinício** (servidor, API, worker):

- compile antes, sem travar a IDE (build para pasta temporária se a IDE prende o `bin`);
- **agrupe** tudo que precisa de reinício;
- **avise o usuário na hora** ("preciso que reinicie a API para validar A, B e C") e espere a
  confirmação;
- depois do reinício, a primeira carga pode falhar: recarregue antes de concluir;
- confirme que o binário novo está em uso — o comportamento novo tem que vir **do servidor** (ex.:
  a resposta 422 nova), não do front escondendo o botão.

**6. Reteste na tela real** — a mesma tela do achado, o mesmo papel, o mesmo dado ou um equivalente
novo no estado certo:

- o mesmo roteiro que achou o defeito, com espião de rede e conferência no banco;
- **par de controle**: um caso que **não** deveria mudar (o registro sem a condição), para provar que
  o resto não quebrou;
- **teste inverso**, quando for regra de permissão ou condição: tire a condição → o efeito some;
  devolva → o efeito volta;
- as bordas da regra, dos dois lados do limite;
- print `-CORRIGIDO` no **mesmo enquadramento** do `-ANTES`, circulado em verde no mesmo lugar
  (`scripts/circular.py ... verde`).

**7. Regressão:** re-execute os casos do ledger cujos itens dependem dos arquivos alterados, mais um
uso de cada componente compartilhado que você mexeu. Cada um vira caso `tecnica: regressao`.

**8. Restaure o estado** que o teste mudou (permissão ligada para o teste, configuração, preço) e
confira pelo payload que voltou igual. O que não dá para desfazer vai para `sujeira`, com o estado
final.

**9. Registre:** defeito nas 4 partes (`templates/defeito.md`), ledger, nota da fase e, se o projeto
tiver essa regra, o changelog dele.

Quando a correção não passa no reteste: não empilhe tentativa sobre tentativa; volte ao 2.4. Para
desfazer, desfaça por completo (o arquivo volta ao original, confira no `git diff`) e registre o
trabalho descartado com o motivo, guardando o patch em `.qa/<rodada>/descartado/`.

Correção que contraria uma decisão anterior do time (ex.: trocar uma função de permissão que já foi
trocada e revertida antes): não aplique. Ache a decisão no histórico e proponha o caminho que a
respeita.

---

## 4. Reteste de correção feita por outra pessoa ("deu pull", "subi a correção")

0. **Rodada no modo reteste:** `cobertura.py init <rodada> --modo reteste --reteste-de <rodada-original>
   --alvo "Reteste D-NNN" --inicio agora` (`--defeito D-NNN`, repetível, importa só esses: os do pull). O
   reteste é sempre uma rodada nova (init --modo reteste --reteste-de <rodada-original>): o `rodada --modo`
   sai 2 ao trocar para ou de reteste num ledger com casos. O `--reteste-de` traz da rodada original os
   defeitos não retratados (mesmo id, campo `importado_de`), os casos ligados a eles, os itens desses casos
   e os arquivos de evidência que eles citam, no mesmo caminho relativo; sem `--defeito`, deixa de fora
   (e lista na saída) o defeito já `retestado-ok` na origem e a `decisao-de-produto` `nao-corrigido`, que
   não têm o que retestar no pull (`--todos` traz tudo); não traz `rodada.git`, sujeira, críticas nem
   contagens, e grava `rodada.reteste_de` com a pasta e o commit da origem. O gate desse
   modo não cobra inventário, plano, crítico, seções do catálogo nem as cinco dimensões; cobra
   `rodada.reteste_de`, ao menos um defeito importado, as notas `01-perfil-e-ambiente` e `07-correcao`
   (com RESOLVEU ou PRECISA DE AJUSTE junto de cada D-NNN importado), o `rodada --git` do código testado
   e, para cada defeito importado, um caso `--tecnica regressao --defeito D-NNN` **desta** rodada
   (importado não conta) concluído com evidência `-RETESTE` em disco. O item `estatico:` e o git status
   inicial só entram para o defeito que esta rodada corrigiu (campo `corrigido_em_rodada`, gravado pelo
   `set`/`add-defeito`); nele, e no defeito claro novo achado no entorno e corrigido aqui, `-CORRIGIDO` ou
   `-DEPOIS` também servem como reteste. Defeito importado que esta rodada corrige de novo: grave
   `--correcao` nele (é o que marca `corrigido_em_rodada`); só retestar a correção de outra pessoa não
   leva `--correcao` (descreva o commit dela na nota 07).
1. **A correção está no que você testa?** `git log --oneline origin/<branch> -5` (sem fetch; se a
   base remota estiver velha, peça ao usuário o `git fetch` ou o ok para rodá-lo, como em
   `modulos-avancados.md` §4.2) e `git merge-base --is-ancestor <commit> HEAD`; no ambiente
   publicado, versão ou hash do build. Se não estiver, o status é "não está no ambiente", não "não
   resolveu".
2. Execute o **mesmo roteiro** do achado original, com o mesmo papel. Se o dado original foi
   consumido, crie um equivalente no estado certo e diga isso.
3. Print `-RETESTE` — circulado em verde se resolveu, em vermelho se não.
4. Veredito, com número: **RESOLVEU** ou **PRECISA DE AJUSTE** (e o que falta). Nunca "parece ok".
5. Ledger: caso novo `tecnica: regressao` com o `defeito_id` do original (o defeito já está no ledger,
   trazido pelo `--reteste-de`); o print vai em `evidencias.reteste` do defeito; o defeito vai para
   `retestado-ok` ou volta para `aberto`. Para a rodada fechar, um "precisa de ajuste" que não for
   resolvido nela vira `nao-corrigido` com a justificativa ("precisa de ajuste: falta X; com Fulano").
6. Teste o entorno: o que mudou desde o commit gravado em `rodada.reteste_de.git` (`git diff --stat
   <esse commit>..HEAD`, `git show --stat <commit da correção>`) e que está no seu ledger. Defeito claro
   novo achado no entorno é corrigido na hora, com ANTES/DEPOIS, como em todo pedido de QA.

---

## 5. O ledger durante a correção

O caso que falhou **continua** `falhou` (é o registro do que foi observado no código de então); o
reteste é um caso **novo**. Assim o histórico não se reescreve.

| Momento | Caso | Defeito |
|---|---|---|
| Achou e reproduziu por 2 caminhos | `falhou`, com `defeito_id` | novo `D-NNN`, `status: aberto`, print em `evidencias.antes` |
| O achado caiu | `retratado`, justificativa com o motivo | `tipo: retratado`, `nao-corrigido`, justificativa = o que enganou |
| É regra de negócio | `falhou`, com `defeito_id` | `tipo: decisao-de-produto`, `nao-corrigido`, justificativa = a pergunta e para quem |
| O time decidiu manter | sem mudança | `correcao`: "Decisão: manter — fala, quem, data, canal" |
| Corrigiu | — | `corrigido`, com `onde`, `causa`, `correcao`, print em `evidencias.depois` |
| Retestou e passou | caso novo `regressao` = `passou`, evidência `-CORRIGIDO`/`-RETESTE` | `retestado-ok` |
| Retestou e falhou | caso novo `regressao` = `falhou` | volta para `aberto` |
| Corrigiu e não deu para retestar | — | fica `corrigido`, com o que falta para o reteste: "falta …; destrava: …" (ex.: "falta reiniciar a API; destrava: o usuário reinicia e eu reteste"); "sem tempo" nunca (`add-defeito`/`set` recusam, saída 2). DEPOIS = o diff da correção (`git diff -- <arquivos> > rede/NN-D-NNN-CORRIGIDO.diff`, passado em `--depois`); o print verde entra no reteste |
| Não vai corrigir | — | `nao-corrigido` + justificativa (outro time, decisão de produto, fora do escopo, sem autorização) |
| Melhoria proposta | — | `tipo: melhoria`, `nao-corrigido`, justificativa "proposta: depende de …", `correcao` = a proposta |
| Melhoria aplicada | caso novo `regressao` = `passou` | `tipo: melhoria`, `retestado-ok` |

O gate final só passa com: zero caso `pendente`, zero item sem caso, zero defeito `aberto` e toda
sujeira com `estado_final` (`ficou` pede `como_desfazer`). Todo defeito termina a rodada em
`retestado-ok`, em `nao-corrigido` com o motivo, ou em `corrigido` com o que falta para o reteste
("falta …; destrava: …"); "sem tempo" nunca, e "aberto" nunca. Além disso, o gate exige:

- **`retestado-ok` com reteste de verdade:** um caso `--tecnica regressao --defeito D-NNN` que passou,
  com evidência em disco, e cujo reteste mais recente (por `atualizado_em`) não falhou.
- **ANTES e DEPOIS em arquivo:** todo defeito com `antes` existente (ou justificativa `sem-antes: <motivo>`)
  e todo `corrigido`/`retestado-ok` com `depois` existente.
- **Prova em disco:** todo `passou`/`falhou` com evidência que é arquivo dentro de `evidencias/`, `rede/`,
  `notas/` ou `relatorio/` da rodada (texto livre ou URL não contam).
- **Estático:** para **cada** defeito corrigido, um caso de item `estatico:<gate>` ligado a ele
  (`--defeito D-NNN`, repetível: um caso de typecheck cobre várias correções) com status `passou` e
  evidência de **texto** com o número antes e depois (`antes: 308 erros | depois: 308 erros`; imagem não
  conta), ou `bloqueado` ("gate não executável: <motivo>"), e `notas/00-git-status-inicial.txt` (ou
  `00-snapshot-inicial.txt`). O gate lista os D-NNN sem esse caso.
- **Biblioteca:** um caso `[PJ-LIB-07]` (pacote empacotado instalado num consumidor) que passou, ou
  `bloqueado` com "destrava: …" quando empacotar não funciona (caminho B em
  `references/execucao-e-evidencias.md`, "CLI e biblioteca").
- **Modo PR:** com `rodada.escopo_diff` gravado pelo `--parcial` (base e modo diff), o próprio gate roda
  `escopo_diff.py --base <base> --incluir-working --ledger <rodada> --falhar-se-descoberto` e reprova se
  não sair 0; arquivo de raio não calculado só passa citado na seção "Raio completado à mão" da nota 09.
- **Registro da rodada:** ambiente, início, fim (`rodada --fim agora`), `perfil` existente,
  `ambiente_confirmado` quando houve escrita, tipo(s) de projeto, as notas 01, 02-estudo (com
  "Entendimento"), 02-inventario, 03 e 08 (e 07 com correção), o `.qa/MAPA.md` atualizado na rodada e
  um item `modulo:` com caso, duas passadas do crítico com as duas últimas sem novidade
  (`rodada --critica`), as cinco dimensões em toda ação (`elemento:`, `api:`, `comando:`, `funcao:`,
  `job:`, `consumidor:`, `ipc:`, `menu:`, `ferramenta:`) dentro do escopo, o mínimo por tipo de item
  (catálogo §1.3), uma contagem do inventário por tipo (`rodada --contagem`) e cada seção do catálogo e
  módulo (MA-1..4, MA-6, MO-7..10) com caso ou `nao-aplicavel` (`cobertura.py secoes`). Rodada de tela,
  fluxo, função, comando ou endpoint: seção fora dela em item `dimensao:` `--escopo fora` com "fora do
  escopo da rodada (<escopo>): <motivo>" não conta como lote (P0 seguem com `arquivo:linha`). No modo
  reteste vale a lista do §4, passo 0.
- **`fechar`**, além do gate: `relatorio/provas.pdf` (com defeito ou melhoria), `relatorio.html` sem
  `{{` (ou o `.pdf`), `painel.html` mais novo que o `cobertura.json` (rode o `painel.py` por último),
  `relatorio/oraculo*.md` citando cada caso "oraculo: …", um caso `[MA-5-*]` ou `dimensao:MA-5`
  `nao-aplicavel` com o motivo (MA-5 nasce na fase 10.5), `replay/passos.yaml` com um fluxo da rodada
  quando algum caso passou em `tela:`, `elemento:`, `fluxo:`, `api:`, `comando:`, `funcao:`, `job:`,
  `consumidor:`, `ipc:`, `cena:` ou `prompt:` (só os exemplos do modelo não contam; sem fluxo reproduzível,
  `nao-aplicavel` no item `estatico:replay` com o motivo) e um caso `[EN-NN]`; no modo reteste, só
  provas, oráculo e EN. Por fim ele roda `aprender.py validar` e só fecha com a skill íntegra.

Comandos (a pasta é a da rodada; detalhes em `--help`):

```bash
python scripts/cobertura.py add-defeito .qa/<rodada> --titulo "..." --severidade alto \
  --onde "src/x.tsx:42" --antes evidencias/07-salvar-ANTES-circulado.png --caso C-0012
python scripts/cobertura.py set .qa/<rodada> D-003 --causa "..." --correcao "..." \
  --depois evidencias/07-salvar-CORRIGIDO-circulado.png        # ainda aberto: o reteste vem antes do status
python scripts/cobertura.py add-caso .qa/<rodada> --item "elemento:/clientes#salvar" --tecnica regressao \
  --dimensao acerto --titulo "[EL-BTN-01] Reteste D-003: Salvar" --esperado "..." --status passou \
  --evidencia evidencias/07-salvar-CORRIGIDO-circulado.png --defeito D-003
python scripts/cobertura.py add-caso .qa/<rodada> --item "estatico:typecheck" --criar-item --tecnica estatico \
  --titulo "[ES-02] typecheck depois do D-003" --esperado "nao sobe do baseline" --status passou \
  --evidencia notas/07-typecheck-D-003.txt --defeito D-003   # o arquivo diz "antes: N ... depois: N"
python scripts/cobertura.py set .qa/<rodada> D-003 --status retestado-ok
# sem reteste possivel agora: git diff -- src/x.tsx > .qa/<rodada>/rede/07-D-003-CORRIGIDO.diff e
# set D-003 --status corrigido --depois rede/07-D-003-CORRIGIDO.diff --justificativa "falta ...; destrava: ..."
python scripts/cobertura.py gate .qa/<rodada> --so-cobertura   # no meio da rodada
python scripts/cobertura.py gate .qa/<rodada>                  # para fechar
```

Rode o gate `--so-cobertura` ao fim de cada fase, não só no fim da rodada: ele aponta o que está
`pendente` ou sem justificativa enquanto você ainda tem contexto para resolver.

---

## 6. Registro por fase — a cada passo, nunca só no fim

- **Quando:** a cada caso concluído, a cada print, a cada defeito, atualize o ledger e a nota **na
  hora**. Porquê: a janela de contexto acaba no meio do trabalho. Ver dez telas e escrever no fim é
  exatamente como o material se perde.
- **Onde:** `.qa/<rodada>/notas/NN-<nome>.md`, a partir de `templates/nota-de-fase.md`, com os
  nomes da tabela única do `SKILL.md` §3 (`NN` é sequência de arquivo, não número de fase: a fase 3
  grava `02-inventario.md`, a 11 grava `10-aprender.md`). O gate e a próxima sessão procuram as
  notas por esse nome. Se o PERFIL apontar outra pasta (ex.: um cofre de notas do usuário), use-a.
- **Horário e `modified`:** sempre do relógio (`date -Iseconds`, ou `Get-Date -Format o` no
  PowerShell), nunca estimado. Horário inventado faz o registro parecer mais novo (ou mais velho) do
  que é, e esse é o erro que mais engana depois.
- **Número em tudo.** "73 s para 790 registros", "5 de 44", "typecheck 310, baseline 310". Sem
  número é impressão, não medição.
- **Prints:** `evidencias/NN-<o-que-mostra>[-ANTES|-CORRIGIDO|-RETESTE][-circulado].png`. Guarde o
  cru **e** o circulado; a nota e o relatório usam o circulado. Cada print ganha uma linha dizendo o
  que ele **mostra** — valores, códigos, estado do botão, texto do erro —, não o que ele parece ser.
  "Print do contrato" não serve a ninguém; "Contratado 590 · Comprometido 590 · botão Atualizar
  cinza" resolve um chamado.
- **Rede:** `rede/NN-<chamada>.json` com método, URL, status, tempo, corpo enviado e recebido.
  Nunca copie token, senha ou segredo para esses arquivos: mascare.
- **Sempre registre também:**
  - **retratações**, com o que enganou (a ferramenta, a hora em que você mediu, o dado);
  - **hipóteses que caíram**, e o que as derrubou — evita que a próxima sessão refaça o caminho;
  - **dado alterado só para o teste passar** (ex.: um preço que você mudou) — também é sujeira;
  - **o que não foi validado**, e por quê. A ausência de prova é informação.
- **Em toda resposta ao usuário**, uma linha dizendo o que foi registrado (qual nota, quantos casos
  no ledger, qual defeito) ou "nada novo para registrar".

---

## 7. Melhorias — além dos defeitos

Em cada tela, procure ativamente:

- clique a mais (lista com uma única opção que não vem pré-selecionada);
- mensagem que não diz o que fazer; toast que cita 1 de N erros;
- texto errado, sem acento, plural errado, termo inconsistente entre telas;
- dado cru: data em ISO, número sem máscara, enum numérico, GUID, código interno no lugar do nome;
- obrigatório sem asterisco, ou asterisco duplicado (rótulo e placeholder);
- o campo que barrou o salvar não fica destacado — só o toast avisa;
- falta de feedback de carregamento: o botão não diz "Salvando…" e aceita clique duplo;
- KPI, contador ou badge que só atualiza com F5;
- ação destrutiva sem confirmação, ou confirmação com cor de ação inofensiva;
- botão desabilitado mudo, sem dizer o motivo;
- estado vazio que não orienta;
- "cara de feito por IA": ícone decorativo em todo título, subtítulo que repete o título, vários
  botões primários lado a lado;
- contraste, foco visível, teclado (Tab, Enter, Esc).

O que fazer com cada uma:

- **Pequena e segura** (local, sem regra de negócio, dentro do design system) **e** com autorização
  para alterar: aplique, reteste, registre o ANTES/DEPOIS como qualquer correção.
- **De produto ou grande:** proponha com o motivo e o efeito esperado (`tipo: melhoria`,
  `nao-corrigido`, justificativa "proposta: depende de <decisão, autorização ou time>").
- Design: sempre dentro do design system do projeto. Nunca proponha paleta, fonte ou componente
  novo.

---

## 8. Relatório final

### 8.1 Quando

Ao fim da rodada, depois que `scripts/cobertura.py gate` passa. Se o gate não passa, o relatório não
diz "pronto": diz o que está pendente e por quê.

### 8.2 Como montar

1. `python scripts/cobertura.py relatorio .qa/<rodada>` → números e tabela de cobertura (`--html`
   ou `--md` para colar no relatório).
2. `scripts/circular.py` em todo print de achado (vermelho) e de correção (verde), com a caixa no
   **mesmo lugar** nos dois, para o antes e o depois se lerem lado a lado. Meça uma vez, guarde as
   marcas no mapa `<rodada>/evidencias/marcas.json` (chave = nome do print; o mesmo arquivo serve
   ao `provas.py`) e reutilize:
   `python scripts/circular.py <rodada>/evidencias/07-salvar-ANTES.png --marcas <rodada>/evidencias/marcas.json`
   e o mesmo com `--cor verde` no `-CORRIGIDO` (`references/provas-antes-depois.md` §4).
3. **Caminho padrão** (`SKILL.md` 10.4): `python scripts/cobertura.py relatorio .qa/<rodada> --modelo
   templates/relatorio.html --saida .qa/<rodada>/relatorio/relatorio.html` preenche do ledger o resumo,
   os números por status e severidade, a cobertura por item e por área, as linhas de defeitos (com figura
   ou prova textual, conforme a evidência; data do achado, esperado × obtido e método/URL/status do
   primeiro `rede/*.json` do ANTES; obtido das regressões que passaram no DEPOIS; o "não validado" do
   item), as linhas MA/MO (dos casos `[MA-n-*]`/`dimensao:MA-n`), os gates (baselines e casos
   `estatico:`), os retestes (modo reteste, veredito da nota 07), o replay (`replay/passos.yaml`), a
   sujeira e o "não validado"; tabela que sai do ledger e fica sem linha vira o texto do `SE_NENHUM`
   (as de pessoa, como achados QC sem caso QC e propostas, ficam com o modelo). Passa tudo pela máscara de
   segredos, deixa `[PREENCHA]` só no texto que exige pessoa (veredito, destaques, causa, alcance) e
   imprime quantos sobraram, por marcador. Depois troque cada `[PREENCHA]` restante por texto (seção sem
   conteúdo leva "Nenhum" e o porquê; nunca apague seção). Faça antes o replay (§9), ou rode o
   `--modelo` de novo depois dele. Copiar `templates/relatorio.html` e preencher os `{{...}}` à mão,
   repetindo os blocos `<!-- REPETIR -->` e com imagens por caminho relativo (`../evidencias/...`), é só
   o plano B, para rodada sem ledger.
4. `python scripts/gerar_pdf.py .qa/<rodada>/relatorio/relatorio.html` gera `relatorio.pdf` ao lado.
   Antes de imprimir ele procura `{{`, `}}` e `[PREENCHA` no HTML final (fora de `<style>`, `<script>`
   e comentário HTML): achou, mostra as linhas, não gera o PDF e sai 1 (`--permitir-placeholder` só
   para rascunho). O texto passa pela máscara de segredos em modo estrito (achou: `[REMOVIDO]` e saída
   1). A primeira tentativa de impressão dura `--timeout-primeira` (padrão 30 s) e a segunda
   `--timeout`; o PDF é conferido a cada 1 s e o modo que funcionou fica lembrado em
   `<temp>/qa-total-headless-modo.json`.
5. Confira o PDF antes de entregar: nenhum `{{` sobrando, todas as imagens aparecem, rodapé com o
   nome da rodada, cada defeito começa em página nova, nenhuma seção apagada.
6. **PDF de provas:** `python scripts/provas.py gerar .qa/<rodada> --conferir` monta
   `relatorio/provas.pdf` direto do ledger, no formato fixo (par ANTES vermelho / DEPOIS verde com
   faixa e moldura, caixas numeradas, item em ANTES · POR QUE · DEPOIS · STATUS, capa e rodapé com o
   nome em toda página). Padrão de captura e conferência: `references/provas-antes-depois.md`.

### 8.3 Conteúdo obrigatório, nesta ordem

- **Capa (sem número):** projeto, alvo, rodada, data, ambiente, papéis, código testado (branch e
  commit) e um veredito em uma frase.

1. **Resumo executivo com números:** itens enumerados, casos, quantidade e % por status, defeitos por
   severidade, quantos corrigidos e retestados, quantos não corrigidos.
2. **Escopo e ambiente:** o que foi testado (por tela ou área), papéis, ambientes, autorizações da
   rodada, o que ficou fora do escopo e por quê.
3. **Cobertura:** a saída de `scripts/cobertura.py relatorio`; o **crítico de completude** (passada,
   itens novos, casos novos e origem, de `rodada.criticas`); e as **seções do catálogo e dimensões**
   (a saída de `cobertura.py secoes` e a tabela seção → caso ou `nao-aplicavel` → motivo), para quem
   lê o PDF auditar o que o gate aceitou como não aplicável.
4. **Defeitos corrigidos**, cada um em **4 partes fixas**:
   - **ANTES** — o que estava errado, como quem usa veria, com o print circulado em vermelho e a prova
     de rede ou banco;
   - **POR QUE** — `arquivo:linha` e a causa em 1 a 3 frases;
   - **DEPOIS** — o que mudou (arquivos), com o print circulado em verde e a prova;
   - **STATUS** — retestado-ok, corrigido sem reteste (com o que falta) ou, em reteste de terceiro,
     RESOLVEU / PRECISA DE AJUSTE.
   Defeito sem print (só de API, por exemplo) usa a variante "prova textual" do modelo: o trecho de
   rede ou banco no lugar da figura.
5. **Retestes de correções de outras pessoas:** veredito RESOLVEU / PRECISA DE AJUSTE, com número e
   print `-RETESTE` (§4).
6. **Não corrigidos** (outro time, decisão de produto, fora do escopo), com print, quem precisa agir
   e a pergunta exata.
7. **Decisões do time sem código:** fala literal, quem decidiu, data e canal.
8. **Retratações:** o que parecia, o que era, como se descobriu.
9. **Melhorias:** aplicadas (com reteste) e propostas (com o motivo).
10. **Qualidade de código:** mapa resumido, achados `QC`, refatorações aplicadas com caracterização
    IGUAL, propostas `R-n` com custo, candidatos a componente, o que não foi analisado
    (`references/qualidade-e-refatoracao.md` §7.5).
11. **Módulos:** cada módulo avançado (`MA-1` a `MA-6`) e opcional (`MO-7` a `MO-10`): aplicado, o
    resultado e a evidência, ou o motivo de não se aplicar; no modo PR, o quadro "mudou × testado".
12. **Sujeira:** tudo que o teste criou ou alterou, por ambiente, com o estado final.
13. **O que NÃO foi validado e por quê** (falta o papel X, efeito externo não autorizado, ambiente
    fora do ar, pergunta do oráculo sem resposta). Esta seção nunca se corta.
14. **Arquivos alterados**, separados por repositório, só os desta rodada (compare com o `git status`
    do início), com o `--stat`, a confirmação de fim de linha e os gates (typecheck, lint, build,
    testes contra o baseline).
15. **Entrega:** branch sugerida e mensagem de commit em bloco copiável, com a frase "nada foi
    commitado"; os blocos por branch, quando pedidos.
16. **Replay:** a lista dos `passos.yaml`, os testes de regressão gerados e onde estão as evidências.

Regra de forma: **nunca apague uma seção**. Se ela não tem conteúdo, escreva "Nenhum" e, se couber,
o porquê. A ausência registrada é informação; a seção sumida parece esquecimento.

### 8.4 Branch e mensagem de commit

- Siga a convenção do repositório: rode `git log --oneline -20` e copie o estilo (prefixo
  `fix:`/`feat(escopo):`, idioma, tamanho).
- Branch sugerida no padrão do repositório (`git branch -a | head`), ex.:
  `fix/<assunto-curto>`.
- Mensagem: assunto no imperativo, corpo com o porquê (o "porquê" que não vai em comentário de
  código vai aqui), lista do que mudou, o que **não** foi validado.
- Trailers: nenhum por padrão; só se o PERFIL ou o usuário pedir.
- Bloco copiável, e **não execute**.

### 8.5 Entrega por blocos (só se o usuário pedir para separar por assunto)

Passo a passo, mapa, códigos de saída e armadilhas: `references/entregas-por-branch.md`, com
`scripts/entregas.py` (separa, prova cada bloco sozinho e a soma byte a byte, typecheck por bloco,
gera `APLICAR.txt`, `COMMIT-*.txt`, `PR.md` e o `provas.json` de cada bloco) e `scripts/provas.py`
(PDF por bloco e `00-INDICE.pdf`). O resumo:

- Um patch por assunto, separado por **trecho** (hunk), não por arquivo: arquivos de idioma e de tipos
  costumam misturar assuntos. Instrua `git apply` do patch, nunca "copie o arquivo inteiro".
- Prove a separação: cada patch aplica sozinho na base (`git apply --check` num índice temporário,
  `GIT_INDEX_FILE`), e a soma de todos reproduz byte a byte o que está no working tree (compare com
  `git hash-object` só os arquivos do diff).
- Typecheck por bloco numa cópia limpa revela dependências entre blocos; declare-as.
- Um PDF por bloco, com o nome da branch na capa e no rodapé.
- Bloco com efeito colateral conhecido vai marcado "segurar", com a causa e as saídas.
- Você não cria branch nem commit: quem aplica e sobe é o usuário.

---

## 9. Replay e automação

Todo fluxo executado vira uma entrada em `replay/passos.yaml` (`templates/passos.yaml`), em qualquer
tipo de projeto: CLI, biblioteca, job e API usam as ações `executar`, `chamar`, `disparar` e `api`. Cada
bifurcação percorrida é uma entrada **nova**, não um "se" dentro da mesma. Sem fluxo reproduzível, caso
`nao-aplicavel` no item `estatico:replay` com o motivo concreto (o `fechar` recusa o genérico).

- **Seletores:** `data-testid` > papel + nome acessível > texto visível estável > CSS estável.
  Coordenada, nunca: escala e layout mudam entre máquinas.
- **Valores reais** da execução de referência (códigos, quantidades, preços), não placeholders.
- **Espera por condição observável** (o texto aparece, a requisição X responde), nunca "dormir N
  segundos". `timeout_s` = tempo medido + folga, e o medido fica na nota.
- **Asserções de rede e banco** também (`acao: api` e `acao: banco`, banco só leitura).
- `cria_efeito_externo: true` em todo fluxo que grava dado, envia e-mail ou toca terceiros.
- `erros_esperados`: o que **não** é bug. Evita que quem executa depois reporte falso positivo.
- `limpeza`: o que fica criado e como desfazer, se der.
- **Diga contra qual código foi escrito** (branch e commit). Catálogo sem versão gera falsa regressão
  quando o código muda.
- **Critério de pronto:** uma LLM que nunca viu o projeto executa o fluxo lendo **só a pasta da
  rodada**. Se algum passo exige abrir o código, falta escrever esse algo no `passos.yaml` ou na nota.
- Valide o YAML:
  `python -c "import sys,yaml;yaml.safe_load(open(sys.argv[1],encoding='utf-8'));print('ok')" replay/passos.yaml`.
- Opcional, **com autorização**: converter fluxos em testes e2e do próprio projeto (Playwright,
  Cypress…), no padrão que o repositório já usa. Não crie runner nem infraestrutura nova sem pedido.

---

## 10. Mensagem para terceiros (o time)

Você **escreve** a mensagem; quem envia é o usuário. Enviar mensagem em nome dele exige pedido
explícito. Estilo configurável no PERFIL, o gerador (`scripts/mensagens.py`), o painel, o rascunho
de issue e o oráculo agrupado: `references/comunicacao-e-painel.md`. O resumo abaixo continua
valendo.

- **Valide pelo risco, não só pela verdade.** Para cada afirmação, pergunte: se a pessoa acreditar
  nisto e agir, onde ela vai parar? Frase verdadeira mas incompleta manda consertar metade do defeito;
  frase verdadeira mas mal atribuída ("achei no seu lote") manda procurar no commit errado. Afirmação
  categórica ("isso não existe no servidor") se confere antes de enviar.
- **Sintoma, não nome de classe.** Descreva como quem usou a tela descreveria. Se a pessoa quiser a
  linha do código, ela pergunta — exceto quando ela mesma pediu o detalhe técnico.
- **Print junto** quando o achado depende de onde está na tela.
- **A ressalva do que NÃO foi testado vai no fim e nunca se corta.** É o trecho que mais tenta sumir
  quando a mensagem fica informal, e é o que protege quem vai agir em produção.
- **Formato:** bloco copiável; se o usuário manda uma linha por vez, um bloco por mensagem; bloco sem
  tag de linguagem (tag de shell vira botão "Run"); comando, consulta, caminho e branch em bloco
  próprio; tom do destinatário conforme o PERFIL.
- Errou numa mensagem já enviada? A retratação vai com a mesma visibilidade do erro.

---

## 11. Armadilhas desta fase

- "Corrigido" sem reteste na tela real **não é corrigido**. Compilar não é validar.
- Medir cedo demais: concluir "não salvou" antes de a requisição responder. Espere o evento de rede;
  depois conclua.
- Número que não muda quando a entrada muda é sinal de **medição quebrada**, não de robustez.
- Retestar com um registro que já passou por outro caminho dá falso positivo. Use um registro no
  estado exato que o caso exige.
- Corrigir uma cópia de lógica duplicada e deixar as outras; corrigir um leitor do estado e deixar os
  outros; pôr o guard num caminho e deixar o outro aberto.
- Ferramenta de edição (script ou o próprio editor) trocou o fim de linha do arquivo inteiro.
- Typecheck caiu de repente: é sintaxe quebrada, não melhoria.
- Mudança aplicada com base num achado que depois caiu: desfaça a mudança junto com a retratação.
- Apagar ou alterar o dado de teste antes de registrar a prova.
- "Está no changelog" não é "está no código"; "está no código" não é "está no ambiente".
- Permissão alterada costuma valer só depois de novo login (vem no token); F5 não basta.

---

## 12. Checklist de saída da rodada

- [ ] `scripts/cobertura.py gate` passa: zero caso `pendente`, zero item sem caso, zero defeito
  `aberto`, todo não-ok com justificativa, toda sujeira com estado final, e o resto da lista do §5
  (reteste que passou, ANTES/DEPOIS em arquivo, item `estatico:` ligado a cada defeito corrigido, notas,
  crítico com duas passadas secas, dimensões, mínimo por tipo, contagens, seções, biblioteca no pacote e,
  no modo PR, o `escopo_diff` rodado pelo próprio gate).
- [ ] Fase 2 registrada: `notas/02-estudo.md` com a seção "Entendimento" preenchida, `.qa/MAPA.md` (ou
  o caminho do PERFIL, "Mapa do projeto:") atualizado nesta rodada e ao menos um item `modulo:` com
  caso (alvo de um arquivo só: `modulo:<o arquivo>`), salvo no modo reteste.
- [ ] `scripts/cobertura.py fechar` sai 0 (depois da fase 11): ele confere também provas.pdf,
  relatório sem `{{`, painel mais novo que o ledger, oráculo agrupado, MA-5, replay e o caso `[EN-NN]`,
  e roda `aprender.py validar`.
- [ ] `fechar` roda o `escopo_diff --tudo` (fora do modo PR e do reteste) e sai 0: toda superfície que o
  detector acha no código tem item com caso concluído (item `--escopo fora` com `nao-aplicavel`
  justificado conta); servidor sem rota reconhecida só passa citado na seção "Raio completado à mão" da
  nota 09.
- [ ] Todo defeito corrigido tem reteste na tela real, print `-CORRIGIDO` circulado e regressão.
- [ ] `git diff --stat` igual a `git diff --ignore-cr-at-eol --stat`.
- [ ] Typecheck, lint, build e testes no baseline ou abaixo, sem sintaxe quebrada.
- [ ] Mudança que exige reinício foi validada com o binário novo, depois do aviso ao usuário.
- [ ] Estado restaurado; o que não volta está em `sujeira`.
- [ ] "Não validado" escrito, com o motivo de cada item.
- [ ] Relatório em PDF sem `{{` sobrando, com imagens e rodapé.
- [ ] `replay/passos.yaml` válido.
- [ ] Arquivos alterados só desta rodada, separados por repositório.
- [ ] Branch e mensagem de commit (sem trailer) em bloco copiável; nada executado.
- [ ] `scripts/cobertura.py fechar <rodada>` sai 0, depois da nota `10-aprender.md`.
- [ ] Lição genérica nova → `references/catalogo-de-testes.md` da skill; lição do projeto →
  `.qa/PERFIL.md`.
- [ ] A resposta final diz o que foi registrado e onde.
