# Changelog da skill qa-total

Uma versão por gravação, a mais nova no topo. Datas e horas vêm do relógio (`date`), nunca de
estimativa.

**Versão (semver):**

| Sobe | Quando |
|---|---|
| patch (`1.1.0` → `1.1.1`) | lição nova numa seção que já existe; ajuste de script ou template; linha marcada como obsoleta |
| minor (`1.1.x` → `1.2.0`) | seção nova, prefixo novo no catálogo, stack nova, referência nova, script novo |
| major (`1.x.y` → `2.0.0`) | mudança de regra pedida pelo usuário, com a frase literal e a data |

**Entradas automáticas** (escritas por `scripts/aprender.py`; o `listar` lê este formato, então não o
mude):

```
## [X.Y.Z] - AAAA-MM-DD HH:MM

- [licao] references/catalogo-de-testes.md · §9.2 Tempo e espera · LI-NN · "Título curto" · origem: front web, caso C-0031
- [stack] references/stacks/<stack>.md · §- · - · "<Stack>" · origem: <tipo de projeto>, sem caso
- [obsoleta] references/catalogo-de-testes.md · §- · LI-NN · "motivo" · origem: <caso>
- [mudanca] scripts/<script>.py · §- · - · "o que mudou" · origem: <caso>
- [regra] mudanca pedida pelo usuario: "<frase literal>, <data>"
```

Campos separados por ` · `: tipo, arquivo, seção, código, título, origem. A origem diz o tipo de
projeto e o caso (C-NNNN, D-NNN), nunca o nome do cliente ou do projeto. **Entrada escrita à mão**
segue o mesmo cabeçalho de versão e agrupa em `### Acrescentado`, `### Mudado`, `### Obsoleto`,
`### Corrigido`. Lição só de um projeto não entra aqui: vai para o `.qa/PERFIL.md` dele.

**Travas que este arquivo registra:** a skill só acrescenta (regra velha é marcada como obsoleta, não
apagada); regra de segurança só muda com pedido explícito do usuário; toda gravação passa por
`aprender.py validar` e é desfeita se a validação piorar. Detalhe em `references/aprender.md`.

## [1.5.0] - 2026-10-01 10:22

**Banca adversarial (rodada 4).** Três corretores e um verificador final fecharam os achados da rodada 4
(trava do §2 e do workflow, gate, inventário e modo PR, máscara de segredo, provas e mensagens). Minor:
entram subcomandos e opções novas. Nenhuma regra de segurança afrouxou: o §2 e as `regras()` do workflow
só endureceram. Entrada escrita à mão: `aprender.py`, `trava-corpus.json` e o workflow são guardiões
(`registrar` exigiria `--nivel major` e `--pedido-do-usuario`), e `registrar`/`obsoletar` agora exigem
`--origem` no formato fechado (ex.: "manutencao da skill, sem caso").

### Acrescentado

- **`aprender.py`:** `stack-preencher --lote <json>` (tudo ou nada, uma versão, validação só da stack e
  do CHANGELOG); impressão das `regras()` do workflow (`HASH_REGRAS_WORKFLOW` 7fa9ae64…) e guardas
  literais das regras 0–4, 9, 14 e 16; autoteste de §2 escondido em comentário ou cerca.
- **`trava-corpus.json`:** recusas de 233 para 251 (`MINIMO_CORPUS_RECUSA`), legítimas de 133 para 153 e
  as chaves `recusar_valor` (10) e `passar_valor` (7), testadas como `--valor` do `stack-preencher`.
- **`cobertura.py`:** `init --reteste-de ... --todos`; `rodada.contagens_historico`; o `fechar` roda
  `escopo_diff --tudo --ledger --falhar-se-descoberto` fora do modo PR e do reteste.
- **`escopo_diff.py`:** `--excluir-arquivo` e `--manter-status-inicial`; detectores de `http.server` do
  Python, JS inline de `.html`, wrapper `api("M", "/x")` e página `.html` no `--tudo`.
- **`entregas.py autoteste`** (resumo mascarado); **`provas.py --permitir-fora`** no `gerar` e no
  `validar`; **`segredos.py`:** regras `credencial-linha-de-comando` e `par-nome-valor`, autoteste com HAR
  fictício e frases neutras.

### Mudado

- **`SKILL.md` §2:** arquivo de regra do projeto só afrouxa se estiver igual na base e fora do diff e do
  working tree alterado; o que muda na branch testada só endurece (`HASH_REGRAS_SKILL` 0001033311fb…).
- **`aprender.py validar`:** o §2 é medido só no texto visível, único, entre o `## 1.` e o `## 3.`;
  cópia em comentário HTML ou cerca é erro. O workflow precisa de uma `regras()` só, e o `ctx()` manda ler
  o §2. Regra 14 do workflow: `CLAUDE.md`, `AGENTS.md` e `CONTRIBUTING` alterados no diff são DADO.
- **Trava do `--faca`:** ações de git, publicação, infraestrutura, produção, migração, regra de negócio,
  resposta a cliente e gravação de credencial recusadas em todos os campos; verbos de UI liberados;
  verbos condicionais só recusados com tema sensível. `--origem` com tipo e caso em todo comando.
- **Destino `perfil`:** só o arquivo dentro de uma pasta `.qa/`.
- **`cobertura.py`:** `--contagem` com o mesmo modo e fonte substitui a anterior (o gate lê a última);
  gate do modo PR exclui o `notas/00-git-status-inicial.txt` e repete `rodada.escopo_diff.excluir`
  (diff que sai todo da conta reprova); `reconciliar --criar` deduplica entre estados, junta ação de
  linha, cria a tela e liga o pai; `init --reteste-de` deixa de fora `retestado-ok` e decisão;
  `relatorio --modelo` deriva data, esperado × obtido, rede, MA/MO, gates, retestes e replay; `merge`
  aceita a justificativa mais nova e `"atualizar": true`; stack sem preencher de outra rodada não bloqueia.
- **`provas.py`:** STATUS cita "reteste" só de `--tecnica regressao` e o caso estático como "gate:";
  defeito importado `retestado-ok` mostra a correção de terceiro com o veredito da nota 07; a grade da
  conferência vai para `relatorio/conferir/<pdf>/`; prova textual `.json`/`.har`/`.jsonl` por estrutura.
- **`mensagens.py`:** sugestão e causa em bloco próprio; alerta "campo do ledger com detalhe de código";
  anexo `.json`/`.har`/`.jsonl`/`.ndjson` varrido como estrutura.
- **Textos:** `SKILL.md` (escopo do init, locales/temas/larguras, `escopo_diff --incluir-working --ledger`
  na §5, relatório pelo `--modelo`, `--sem-itens`, `fechar` na fase 9, caminho da grade);
  `correcao-e-relatorio.md` §8.2 com o `--modelo` como caminho padrão; `templates/relatorio.html` item 9;
  `provas-antes-depois.md` §5–§8; `comunicacao-e-painel.md` §5; `execucao-e-evidencias.md` §1.3; workflow,
  passo 5 do inventário (regravar a contagem). Origem das entradas automáticas: `<tipo de projeto>, sem caso`.

### Corrigido

- **`_mascara.py`:** JSON com escape e JSON escapado dentro de string, par nome/valor (cookie, cabeçalho,
  `queryString`) no texto e na estrutura, `code`/`state` gerados em URL e o conector da senha natural;
  `estrutura_de_arquivo` e `mascarar_texto_de_arquivo`. Pré-filtro com `osql`, `isql`, `xhs` e `login`.
- **Credencial em linha de comando:** `curl -u`, `http -a`, `mysql -p`, `sqlcmd`/`osql -P`, `redis-cli
  -a`, `mongo`/`sshpass -p` e `docker`/`podman login -p` no texto; `executar_caso.py` mascara o argv antes
  da transcrição.
- **`entregas.py`:** chave privada PEM do resumo do trecho saía em claro (máscara por bloco).
- **Rodada:** subpasta da rodada que é link ou junction para fora conta como fora no gate, no `provas.py`,
  no `painel.py` e no `mensagens.py`; spec do `provas.py` com imagem ou prova fora da base sai 2; rodada
  dentro da pasta da skill é recusada.
- **`cobertura.py`:** `add-defeito`/`set` com `corrigido` ou `retestado-ok` exigem DEPOIS/RETESTE em disco;
  snippet de elementos sem valor de campo; mensagens do gate com o comando que resolve; tela `.html` vira
  `tela:/<caminho>`.

## [1.4.0] - 2026-10-01 07:49

**Banca adversarial (rodada 3).** Três corretores e um verificador final fecharam os achados da rodada 3
(travas do aprendizado, máscara e scanner de segredos, gate e modos da rodada, provas, entregas e escopo do
diff). Minor: entram `scripts/executar_caso.py` e opções novas. Nenhuma regra de segurança afrouxou; o texto
do `SKILL.md` §2 passa a ter impressão conferida pelo `validar`.

### Acrescentado

- **`scripts/executar_caso.py`:** `cmd` e `chamar` rodam um caso de CLI ou de função com HOME e pastas
  temporárias e gravam a transcrição mascarada em `evidencias/`.
- **`cobertura.py`:** `init --modo reteste --reteste-de <rodada> [--defeito D-NNN]` traz defeitos, casos,
  itens e evidências da rodada original (`rodada.reteste_de`); `--defeito` repetível no `add-caso` e no
  `set` (`defeito_ids`); `corrigido_em_rodada` e `correcao_em_rodada`.
- **Gate:** no modo PR roda o `escopo_diff --base --incluir-working --falhar-se-descoberto` (falha
  fechada); `[PJ-LIB-07]` em biblioteca; replay em qualquer tipo, com dispensa em `estatico:replay`; o
  `fechar` cobra o MA-5 e roda o `aprender.py validar`.
- **`aprender.py validar`:** rótulos e linhas do §2 passam pela trava; impressão do §2
  (`HASH_REGRAS_SKILL`); parse dos `workflows/*.js` como corpo de função assíncrona, sem `Date.now`,
  `Math.random` nem `new Date`.
- **`provas.py`:** `--so-spec`; chave `marcas` na spec salva e conferência que cobra as caixas; bloco
  PARECIA/ERA para retratado sem arquivo.
- **`escopo_diff.py`:** rotas de servidor http cru, servidor sem rota como raio incompleto,
  `tela:<.html>`, coluna Herdados, "testado (falha corrigida)" e subcomando documentado sem parser.
- **Relatório:** variante "prova de comando" no `templates/relatorio.html`, preenchida pelo
  `relatorio --modelo` fora de web e API.

### Mudado

- **Trava do aprendizado:** lista branca de verbos no `--faca`; tópicos novos (versionamento, sessão,
  banco, efeito, evidência forjada, governança, credencial do `.env`, destino `main`/`develop`/tronco) e a
  classe `producao-escrita`; `--origem` com formato fechado; corpus de 156 para 233 recusas e de 112 para
  133 legítimas (`MINIMO_CORPUS_RECUSA = 233`).
- **Destino `perfil`:** só o `.qa/PERFIL.md` do projeto (nome, primeira linha e fora da skill;
  `CLAUDE.md`, `AGENTS.md`, `README` e afins saem 4).
- **Modos da rodada:** trocar para ou de reteste com casos sai 2 (`rodada.modo_inicial`); `estatico:`
  cobrado por defeito; lote "fora do escopo" em rodada estreita não conta como `na-em-lote`;
  `reconciliar` sem `--elementos` fora de UI.
- **`aprender.py`:** `stack-preencher` em patch e na mesma versão; seção 3 da stack por `--tipo`; lote
  vazio sai 0; seção "Aprendido em uso" com o aviso de que nada ali afrouxa o §2.
- **Workflow:** `perfil_path` só `<raiz>/.qa/PERFIL.md` e `pasta_rodada` sob `.qa/` ou a pedida, fora da
  skill, conferidos logo depois do Perfil; formato de `faca` e `origem` no lote do Aprender; precedência
  do §2 com "só endurecem o §2".
- **Saídas:** `mensagens.py` com jargão por tipo de projeto, o Nome do PERFIL §3.1 e `--oraculo`
  gravando `relatorio/oraculo.md`; `entregas.py` sem pull nem push quando não há remoto ou upstream.

### Corrigido

- **`segredos.py`:** senha sem aspas com `#` em INI, properties, YAML e `.env` passava sem achado.
- **`_mascara.py`:** cookie de sessão depois do primeiro par saía em claro; JWE de 5 partes;
  `mascarar_estrutura` por chave `cookie` ou sensível.
- **`provas.py`:** reteste que falhou saía verde (agora vermelho, "RETESTE — PRECISA DE AJUSTE", e o
  `-RETESTE` do caso de regressão que falhou entra no par); `--defeito` sobrescrevia o
  `relatorio/provas.pdf` completo; nome e commit fora da pasta de saída; evidência fora da rodada.
- **`painel.py` e `mensagens.py`:** evidência fora da rodada não é lida nem anexada.
- **`entregas.py`:** id de bloco com `..` saía da pasta de entregas.
- **`escopo_diff.py`:** sem `--base`, numa branch já commitada, comparava com o HEAD e saía 0; agora usa
  a base do ledger com o working tree (sem base gravada, sai 2).
- **`cobertura.py`:** `corrigido` sem reteste pedia print verde (agora o diff da correção como DEPOIS);
  reteste sem defeito importado passava no gate; `rodada.escopo_diff.raiz` relativa resolvida contra a
  pasta da rodada.

## [1.3.0] - 2026-10-01 05:33

**Banca adversarial (rodada 2).** Três corretores e um verificador final fecharam os achados da rodada 2
(gate, travas, saídas mascaradas, workflow e execução). Minor: entram seções de referência, o corpus
`scripts/trava-corpus.json` e comandos novos. Nenhuma regra de segurança afrouxou; as guardas do
`SKILL.md` §2 seguem literais.

### Acrescentado

- **`cobertura.py`:** `--modo completo|reteste|revisao`; `--tipo-projeto` em lista; `rodada --contagem`,
  `--ambiente-confirmado`, `--locales`/`--temas`/`--viewports`; `add-item --tipo-elemento`; `set --passos`
  e `--repro`; `relatorio --modelo` (preenche o `relatorio.html` do ledger).
- **Validações novas:** `na-em-lote`, `na-p0-sem-prova`, `qc-na-sem-motivo`,
  `defeito-corrigido-sem-reteste`, `segredo-no-nome-da-evidencia`.
- **`escopo_diff.py`:** `--so-inventario` e detectores por tipo (CLI, função, job, IPC, mobile).
- **`aprender.py`:** `stack-preencher`; trava estrutural (verificação, negação ou pedido ao usuário);
  corpus de 156 recusas e 112 legítimas em `scripts/trava-corpus.json`; arquivos guardiões exigem
  pedido e `--nivel major`.
- **Saídas:** `mensagens.py --estrito --alertas-revisados`; `segredos.py --autoteste`; regras
  `basic-auth` e `cookie-sessao`.
- **Referências:** execução §1.2 (resumo JSON do curl, credencial por arquivo de cabeçalho), §2.2 (UI
  sem a sessão do usuário), §3.10 (simular falha, fuso e impressão), §10 (comandos e códigos de saída);
  módulos avançados §3.5 (banco descartável); entregas §8 (projeto sem VCS).
- **PERFIL:** §3.1 ambiente de reteste, §13.1 feature flags, temas, fuso, driver de desktop, jogo e site
  estático; o exemplo foi alinhado ao modelo.

### Mudado

- **Gate:** cinco dimensões também em `comando:`, `funcao:`, `job:`, `consumidor:`, `ipc:`, `menu:` e
  `ferramenta:`; mínimo por tipo de item (catálogo §1.3); estático ligado ao defeito, com prova de
  texto; nota `02-estudo` com "Entendimento", `.qa/MAPA.md` da rodada e item `modulo:`.
- **`fechar`:** confere `provas.pdf`, relatório sem `{{`/`[PREENCHA]`, painel mais novo que o ledger,
  oráculo, replay (cópia só com os fluxos de exemplo do modelo não conta) e um caso `[EN-NN]`.
- **Ledger:** `merge` só com data ISO e sem justificativa fraca; `init --forcar` guarda `.bak` único;
  máscara antes do corte do texto.
- **Máscara estrita** em ledger, relatório, painel, provas, PDF, mensagens, mapa do `entregas.py` e URL
  do `xhr-spy.js`; o PERFIL só recebe lição em "Armadilhas conhecidas" e "Rodadas anteriores".
- **Workflow:** ambiente de reteste medido (falha fechada); destinos medidos para CLI e job; modos de
  inventário por tipo; crítico com padrão 5 e pendência explícita; contagens e
  `escopo_diff --so-inventario` no inventário; mínimo por tipo no plano; ordem do ledger na correção;
  casos `EN-*` em parciais, fundidos no fechamento, com o painel gerado por último.
- **`SKILL.md`:** regra única do MA-4 (escopo, não autorização) também nas referências; comandos e
  códigos de saída movidos para `references/execucao-e-evidencias.md` §10; 453 linhas.
- **PDF:** impressão com conferência a cada 1 s e `--timeout-primeira`; `gerar_pdf.py` recusa
  `{{`/`}}`/`[PREENCHA]` fora de `<style>`, `<script>` e comentário HTML.

### Corrigido

- **Catálogo:** `` `-13` `` virava técnica na tabela 1.5 (agora `PJ-LLM-11` e `PJ-LLM-13`; o
  `cobertura.py` não aceita mais técnica começando por hífen); MA-4-08 com a cópia descartável.
- **Workflow:** a resposta "Nenhuma lição: …" no lugar das duas perguntas reprovava o `fechar`; agora a
  linha vai na seção Lições.
- **`_mascara.py`:** token de provedor colado ao texto (`xxxxghp_…`, `AKIA…`) passou a ser detectado.
- **`toast-observer.js`:** toast reexibido por atributo ou classe era perdido; `toastsLimpar` zera o
  estado.
- **`axe-inject.js`:** campo só com placeholder sai como incompleto (`qa-rotulo-so-placeholder`).
- **Fim de linha e invisíveis:** caracteres invisíveis literais do `fuzz_valores.py` e do catálogo
  viraram escapes `\u…`; espaço no fim de linha removido.

## [1.2.0] - 2026-10-01 02:24

**Banca adversarial (rodada 1).** Três corretores e um verificador final endureceram o gate, as travas
do aprendizado e a cobertura por tipo de projeto. Minor: entram script (`scripts/_mascara.py`), seções
do catálogo e comandos novos. Nenhuma regra de segurança afrouxou; as guardas do `SKILL.md` §2 seguem
literais.

### Acrescentado

- **Ledger e gate (`cobertura.py`):** comandos `fechar` (último da rodada: gate final + nota
  `10-aprender.md`), `secoes` (seções da tabela 1.4 e módulos MA/MO sem caso) e `reconciliar`
  (elementos em runtime × ledger); opções `--tipo-projeto`, `--critica`, `--baseline`, `--git`,
  `--dimensao`, `--papel`, `--escopo` e `--oraculo-pergunta`/`--opcao`/`--impacto`/`--para`; técnicas
  lidas da tabela 1.5 do catálogo.
- **`scripts/_mascara.py`:** máscara de segredo única; `painel`, `provas`, `gerar_pdf`, `mensagens` e
  `cobertura relatorio` mascaram e saem 1 quando acham segredo.
- **`provas.py`:** `--sem-itens` e `--permitir-sem-prova`; campo `grupo` na prova textual; bloco
  `ARQUIVO NÃO EMBUTIDO` para vídeo e binário, que reprova a conferência.
- **`escopo_diff.py`:** `--tudo` (telas e endpoints do projeto × ledger, com ou sem git); plano B por
  nome e `--aceitar-raio-incompleto` para linguagem sem parser; workspaces de monorepo (npm, pnpm,
  lerna); prefixo da API gravado em `rodada.escopo_diff.prefixo_api` e casamento de `api:` por sufixo;
  item do diff só com `nao-aplicavel`/`bloqueado`/`nao-validado` conta como descoberto.
- **`segredos.py`:** regras `chave-publica-cliente` (risco baixo, com recomendação), `token-em-url` e
  `jwt-key` multilinha; `--historico` separa o que ainda está no HEAD do que só está no working tree.
- **`xhr-spy.js` 1.1:** WebSocket, EventSource e `fetch` de event-stream; filtro "MÉTODO /caminho";
  máscara ampliada (token, jwt, cookie, sessão). **`axe-inject.js`:** SRI do axe-core 4.11.1 e recusa
  fora de host local. **`fuzz_valores.py`:** tipo `prompt`.
- **Catálogo:** §7.12 a §7.16 (PJ-MSG, PJ-LLM, PJ-DSK, PJ-GAM, PJ-SIT), PJ-JOB-08 a 14, PJ-LIB-07/08,
  DM-TEN-09, DM-AMB-07, EL-LNK-07 e MO-8-13; linhas LLM, Desktop, Jogo, Site estático e Monorepo na
  tabela 1.4; técnicas `avaliacao`, `carga`, `concorrencia`, `propriedade`, `contrato` e `visual` na
  1.5; 🔒 em EN-01/02/08/10/12/13.
- **Workflow:** host medido antes da primeira escrita, camadas só relato, canais `app` e `terminal`,
  credencial sem login, `--critica`/`--baseline`/`--git`, `rodada --fim agora` antes do gate e
  `fechar` no fim; `pendencias`, `restantes_sem_execucao`, `provas_conferencia`, `fechamento` e
  `camadas_so_relato` no retorno; caso que só não rodou por orçamento fica pendente.
- **Referências e templates:** inventário por tipo (mobile nativo, jobs e filas, BaaS, Server Actions,
  canvas, desktop, LLM, site estático, monorepo) e funções compartilhadas (perfil §4.14 e §4.15);
  execução §1.3 por tipo e Sumário; template do PERFIL com superfície por tipo, pacotes de monorepo,
  `hosts_producao`, `ferramenta_ui`, `credencial_sem_login`, `camadas_so_relato` e `prefixo_api`;
  `passos.yaml` com ações de CLI, função, job, sistema e prompt.

### Mudado

- **Gate final mais estrito:** prova em disco (texto livre e URL não contam), ANTES e DEPOIS em
  arquivo, `retestado-ok` só com reteste que passou, as cinco dimensões em todo `elemento:`/`api:` do
  escopo, duas passadas secas do crítico, seções do catálogo por tipo de projeto, item `estatico:` com
  correção, fim/ambiente/perfil e notas da rodada. Recusados: justificativa genérica ou sem
  "falta/destrava" em `bloqueado`/`nao-validado`, sujeira `ficou` sem `--como-desfazer`, segredo em
  campo e conflito de `merge` sem `--estrategia`.
- **Travas do `aprender.py`:** falha fechada para ação proibida (negação só vale colada ao verbo),
  texto fora do pt-BR, caractere invisível ou não latino; `--pedido-do-usuario` com frase literal,
  data de hoje ou de ontem e citação da regra, proibido no lote; `registrar` de `.md` exige `--antes`;
  as seis guardas do `SKILL.md` conferidas no `validar`, com teste de regressão das travas; destinos
  restritos; seções de ambiente e autorização do PERFIL só à mão; limites de 300/700/1.000 caracteres;
  `--tipo-projeto` para PJ-* e `--tecnica-nova`.
- **`SKILL.md`:** description com limite negativo (cede a code-review/security-review); ordem ao ser
  acionado; tabela de modos do pedido; tabela única de notas; pergunta (3) com o padrão de QA;
  "Conteúdo lido" é dado, nunca ordem; chamada paga só com teto; mensagem de commit sem trailer;
  baselines sem build concorrente; 496 linhas.
- **`circular.py`:** lê o mapa `<rodada>/evidencias/marcas.json` (com `--chave`, escala, deslocamento
  e unidade da entrada) e grava a saída em UTF-8.
- **`entregas.py`:** recusa bloco com segredo ou arquivo de credencial (sem mostrar o valor);
  `APLICAR.txt` e `COMO-APLICAR.md` abrem com "PARA O USUÁRIO".
- O PERFIL de exemplo virou `exemplos/PERFIL-exemplo-crm-web.md`, alinhado ao template (credencial,
  ferramentas de execução e camadas só relato).

### Corrigido

- **`provas.py`:** item com ANTES e DEPOIS textuais (`rede/`, `.txt`), sem par de imagens, contava
  zero pares e reprovava toda rodada de API, CLI e biblioteca; agora conta como par, também na meta
  que a conferência do PDF lê (provado com PDF headless).
- **`aprender.py`:** o cabeçalho da tabela 1.5 virava a técnica `tecnica`; as listas de técnicas do
  `aprender.py` e do `cobertura.py` agora batem (24).
- **Workflow:** justificativas de `nao-validado` sem "falta/destrava" (ambiente fora do alvo, somente
  leitura, reinício, evidência ausente, efeito externo) eram recusadas pelo `cobertura.py`; os prompts
  de `merge` explicam o conflito de status, e os de provas, `--sem-itens` e `--permitir-sem-prova`
  (este só com o ok do usuário).
- **Documentação alinhada aos scripts:** gate (`correcao-e-relatorio.md` §5 e §12), provas
  (`provas-antes-depois.md` §5 e §8), segredo nas entregas, `reconciliar` e `estatico:` no inventário,
  `fechar` e lote sem `pedido_do_usuario` em `aprender.md` e `multiagente.md`, MA-4-10 do catálogo com
  `--prefixo-api`, exemplo do `circular.py` com o mapa, `add-sujeira` com `--como-desfazer` e
  `TEMP=C:\tmp` (era um caractere de tabulação).

## [1.1.0] - 2026-09-30

Ampliação pedida pelo usuário em 30/09/2026, para que nada passe pelo QA em qualquer tipo de projeto.
Os arquivos de cada item estão no mapa do `SKILL.md` (§9). Integração concluída em 2026-10-01 00:10
(relógio).

### Acrescentado

- **A · Corrigir e retestar na hora.** Achou defeito claro num pedido de QA (a autorização padrão do
  método; os seis testes de defeito claro decidem): corrige a causa raiz, testa de novo na tela real,
  retesta as falhas e as funções vizinhas, e só então segue (método do prompt mestre de QA, item
  2.7). Análise pura não altera nada; decisão de produto nunca.
- **B · Organizar e componentizar.** Entender a organização do projeto, propor e aplicar melhoria de
  código confuso, componentizar onde o projeto aceita componentes e estudar os endpoints antes de
  testar.
- **C · Autoaprendizado.** `references/aprender.md`, `scripts/aprender.py` e este `CHANGELOG.md`:
  gatilhos (stack nova, bug que escapou do catálogo, falso positivo, técnica que funcionou, correção do
  usuário, script que atrapalhou), destinos (catálogo, referência, `references/stacks/<stack>.md`,
  `.qa/PERFIL.md`), formato "faça X → verifique Y", fase Aprender obrigatória no fim da rodada e as
  travas: só acrescenta, segurança só com pedido explícito, deduplicação, semver, validação depois de
  editar, aviso ao usuário, nada de segredo nem dado pessoal, lição específica fora do genérico.
- **D · Prints ANTES/DEPOIS de toda correção**, no formato dos PDFs por branch: par ANTES (vermelho) e
  DEPOIS (verde) com faixa e moldura, caixas numeradas no ponto exato, item em 4 partes (ANTES · POR
  QUE · DEPOIS · STATUS), capa e rodapé com o nome em toda página, `PR.md` e instruções de aplicar.
- **E · Entregas separadas por branch ou assunto:** patch por trecho (hunk), cada patch aplica sozinho,
  a soma reproduz os arquivos byte a byte, typecheck por bloco numa cópia limpa, PDF por bloco mais
  índice, sem criar branch nem commitar.
- **F · Módulos avançados, sempre ativos quando o projeto permite:** log do servidor ligado à ação da
  tela; divergência front × back (enum que falta, campo ignorado, ruído de ponto flutuante);
  integridade do banco (órfãos, estado impossível, duplicados, invariantes só leitura); modo PR/diff
  com raio de impacto; testes automáticos de regressão gerados a partir do que passou; segurança funda
  (dependências vulneráveis, segredo no repositório, cabeçalhos HTTP, IDOR e tenant cruzado em todo
  endpoint, autorização no back do que o front esconde).
- **G · Módulos opcionais**, ligados quando o projeto tem a ferramenta ou o usuário pede: comparação
  visual entre rodadas, acessibilidade automática (axe-core), entradas aleatórias (fuzz) e desempenho
  (Lighthouse, bundle, consulta lenta, N+1).
- **H · Para o time:** mensagens prontas no estilo de quem envia (um bloco copiável por mensagem, sem
  tag de linguagem, ressalva do não testado no fim, validadas pelo risco; estilo configurável no
  PERFIL), painel HTML interativo da cobertura com a evolução entre rodadas, e rascunho de issue por
  defeito (criada só com ordem explícita).
- **I · Oráculo agrupado:** dúvidas de comportamento esperado juntadas e perguntadas uma vez por
  rodada, em perguntas fechadas com o custo de cada opção; o caso fica aguardando decisão e o resto
  segue.

### Mudado

- **J · Lições das conversas conferidas e reforçadas:** produção somente leitura; nunca senha nem
  login; nada de commit, push, merge ou PR; teste real na tela pedida (vitrine e mock não valem);
  retratar falso positivo com o motivo; validar mensagem pelo risco; ressalva do não testado; hora do
  relógio, nunca estimada; dizer em toda resposta o que foi registrado; armadilhas de navegador (janela
  escondida congela o print, escala entre print e CSS, aba em segundo plano, toast que some, cópia
  oculta no DOM, preenchimento que não passa pelo `onChange`); zoom e recorte para print nítido no
  PDF; fim de linha (CRLF) que infla o diff; typecheck por bloco; esperar o tempo real do evento antes
  de concluir ausência.

### Arquivos de cada item

- **A e B:** `references/qualidade-e-refatoracao.md` (corrigir na hora, os seis testes de defeito
  claro, estudo do projeto e `.qa/MAPA.md`, código confuso, organização, componentização,
  refatoração segura); catálogo §8.1 (`QC-01` a `QC-30`).
- **C:** `references/aprender.md`, `scripts/aprender.py`, este `CHANGELOG.md`; fase 11 Aprender.
- **D:** `references/provas-antes-depois.md`, `scripts/provas.py`, `templates/provas.exemplo.json`.
- **E:** `references/entregas-por-branch.md`, `scripts/entregas.py`, `templates/blocos.exemplo.json`.
- **F:** `references/modulos-avancados.md`, `scripts/segredos.py`, `scripts/escopo_diff.py`; catálogo
  §11 (`MA-1-01` a `MA-6-12`).
- **G:** `references/modulos-opcionais.md`, `scripts/visual_diff.py`, `scripts/axe-inject.js`,
  `scripts/fuzz_valores.py`; catálogo §12 (`MO-7-01` a `MO-10-13`).
- **H e I:** `references/comunicacao-e-painel.md`, `scripts/painel.py`, `scripts/mensagens.py`,
  `templates/issue.md`.
- **Catálogo:** §13 (`EN-01` a `EN-13`, provas, entrega e comunicação), `EL-BUS-12`, `PJ-CLI-10` e as
  lições `LI-72` a `LI-94`; tabelas 1.4 e 1.5 com os prefixos novos.

### Integração

- `SKILL.md`: ciclo com a fase 11 Aprender; correção na hora na regra "Código" e na fase 7; estudo do
  projeto na fase 2; tabela de módulos (§4); oráculo agrupado; comandos dos scripts novos; mapa.
- `workflows/qa-total.workflow.js`: fases novas Estudo, Entrega e Aprender; argumentos `base_pr`,
  `separar_entregas` e `gerar_regressao`; correção restrita ao defeito claro, com ANTES/DEPOIS e
  retestes vizinhos; lente "módulos" no crítico; gate do modo PR; regressão automática, PDF de provas,
  painel, mensagens e oráculo no fim. `references/multiagente.md` acompanha.
- `scripts/aprender.py`: o código do catálogo aceita segmento de um caractere (`MA-1-01`, `MO-7-01`)
  e `MA-6` entra nos prefixos de segurança. `scripts/entregas.py`: o `provas.json` de cada bloco leva
  `nome` = `NN-<branch>`, o nome do PDF da entrega aprovada.
- Conflitos resolvidos: "testa" separado de "analisa" em `references/correcao-e-relatorio.md` §1;
  `references/provas-antes-depois.md` §9 sem `--aplicar` no fluxo do `entregas.py`; seções
  "Qualidade de código" e "Módulos" no `templates/relatorio.html`; `templates/PERFIL-DO-PROJETO.md`
  com `corrigir_na_hora`, `refatorar`, as chaves de mensagens e a seção de módulos.

## [1.0.0] - 2026-09-30

Criação da skill a partir do prompt mestre de QA do usuário, generalizada para qualquer projeto.

### Acrescentado

- `SKILL.md`: contrato com o usuário, regras inegociáveis, ciclo em 11 fases (preparar → relatório),
  direto ou multiagente, comandos, o que dizer ao usuário e a lista viva.
- `references/`: `catalogo-de-testes.md` (técnicas, massa de teste, linhas por elemento, fluxo,
  dimensão, tipo de projeto, estático e lições `LI-*`), `perfil-e-inventario.md`,
  `execucao-e-evidencias.md`, `correcao-e-relatorio.md`, `multiagente.md`.
- `scripts/`: `cobertura.py` (ledger com gate), `circular.py` (caixas numeradas nos prints),
  `gerar_pdf.py` (HTML ou Markdown para PDF pelo Chrome), `xhr-spy.js` (espião de rede),
  `toast-observer.js` (observador de mensagens que somem).
- `templates/`: PERFIL do projeto, ledger de exemplo, nota de fase, defeito, relatório HTML e replay.
- `workflows/qa-total.workflow.js`: rodada multiagente com gate.
- `exemplos/`: um PERFIL real de exemplo.
