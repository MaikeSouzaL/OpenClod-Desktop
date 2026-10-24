# Provas antes e depois de toda correção

Carregue na fase 7 (antes de tocar no primeiro defeito) e na fase 10 (montar o documento). Vale
para qualquer projeto: tela, API, CLI, app móvel, biblioteca.

O script é `scripts/provas.py`; o modelo de entrada é `templates/provas.exemplo.json`. Rode
`python <skill>/scripts/provas.py --help` e o `--help` de cada subcomando se a interface mudar.

## Sumário

0. A regra
1. O ciclo da prova
2. Nomes e lugar
3. Capturar nítido
4. Medir as caixas
5. Prova textual
6. O ledger referencia tudo
7. Montar o documento
8. Conferir antes de entregar
9. Entrega por blocos (branch por assunto)
10. Quando não dá para provar
11. Armadilhas reais

---

## 0. A regra

**Toda correção tem par ANTES/DEPOIS, no mesmo lugar e no mesmo estado.** Sem o ANTES, ninguém
sabe o que estava errado; sem o DEPOIS, "corrigido" é palavra. Defeito sem prova de DEPOIS fica
`corrigido` sem reteste no ledger, nunca `retestado-ok`, com "falta …; destrava: …" na justificativa:
`add-defeito`/`set` recusam `corrigido` sem caso de reteste e com justificativa fraca (saída 2).

O documento que o time recebe segue um formato fixo:

- **Capa:** rótulo, branch em destaque, título, resumo, grade de metadados (repositórios, arquivos,
  linhas) e de onde criar a branch, dependências e ordem.
- **Cada item em 4 partes:** **ANTES** (o que quem usa via, em vermelho) · **POR QUE** (arquivo e
  causa) · **DEPOIS** (o que mudou, em verde) · **STATUS** (com o detalhe: reteste, controle, quem
  precisa agir). Linha **ONDE** com `arquivo:linha` no topo.
- **Prova em par empilhado:** ANTES em cima, faixa e moldura vermelhas; DEPOIS embaixo, faixa e
  moldura verdes; caixas numeradas circulando o ponto exato, nas mesmas coordenadas nos dois.
  **Verde só para o que resolveu:** o `-RETESTE` de defeito `aberto`/`nao-corrigido`, ou citado por um
  caso de regressão que falhou, sai embaixo em vermelho como "RETESTE — PRECISA DE AJUSTE"; o DEPOIS de
  defeito que não está `corrigido`/`retestado-ok` (fora a retratação) sai em âmbar ("NÃO CONFIRMADO").
- **Provas textuais** quando não há tela: payload, consulta ao banco, log do servidor, números.
- **Seções fixas no fim:** o que não foi validado (nunca se corta), atenção do revisor, fora deste
  documento, como aplicar, mensagem de commit, verificação feita.
- **Rodapé em toda página** com o nome (branch ou rodada) e "N / M".
- Ao lado do PDF: o HTML, a pasta `provas/` com os pares compostos, e, quando pedido, `PR.md`,
  `APLICAR.txt` e `COMMIT-<repo>.txt`.

---

## 1. O ciclo da prova

Siga na ordem. Pular o passo 1 é o erro mais caro: depois de corrigir, o ANTES não volta.

1. **Reproduza e capture o ANTES antes de mexer no código.** O print mostra o estado que prova o
   problema: o valor errado no campo, o toast genérico, o botão habilitado que devia estar
   bloqueado, a lista com o item a mais. Junto, no mesmo momento:
   - meça as caixas (seção 4) **na mesma chamada** do print;
   - salve o payload (`rede/NN-<chamada>.json`) e a consulta ao banco
     (`evidencias/NN-banco-<o-que-mostra>.txt`, só leitura);
   - anote papel, registro, URL, viewport (`innerWidth`, `devicePixelRatio`, `scrollY`).
2. **Registre no ledger já com o ANTES.** Defeito já criado na execução (fase 5):
   `cobertura.py set <rodada> D-NNN --antes evidencias/NN-…-ANTES.png --antes rede/NN-….json --onde "arquivo:linha"`.
   Só se ele ainda não existir:
   `cobertura.py add-defeito <rodada> --titulo "…" --severidade medio --onde "arquivo:linha" --antes evidencias/NN-…-ANTES.png --antes rede/NN-….json --caso C-NNNN`.
   Dois `add-defeito` para o mesmo achado geram dois defeitos, e o segundo nasce aberto e trava o gate.
3. **Corrija** (só com autorização, `references/correcao-e-relatorio.md` §3).
4. **Capture o DEPOIS no mesmo lugar e no mesmo estado:** mesmo registro, mesmo papel, mesma
   rolagem, mesmo viewport, mesmos passos. Se o layout mudou com a correção, meça de novo; se não
   mudou, reaproveite as marcas e troque só a cor.
5. **Par de controle e teste inverso** (o caso que não devia mudar continua igual; tirar a condição
   faz o efeito sumir). Cada um vira print ou prova textual.
6. **Reteste** como caso novo (`--tecnica regressao --defeito D-NNN`), com print `-RETESTE` quando
   for de correção de outra pessoa ("dei pull") ou de pendência antiga. Veredito RESOLVEU ou
   PRECISA DE AJUSTE, com número.
7. **Feche o defeito no ledger:** `cobertura.py set <rodada> D-NNN --status retestado-ok --depois evidencias/NN-…-CORRIGIDO.png --reteste evidencias/NN-…-RETESTE.png`.

---

## 2. Nomes e lugar

```text
evidencias/NN-o-que-mostra-ANTES.png          estado com o defeito (cru)
evidencias/NN-o-que-mostra-ANTES-circulado.png  cópia anotada (circular.py), opcional
evidencias/NN-o-que-mostra-CORRIGIDO.png      o mesmo ponto depois da correção
evidencias/NN-o-que-mostra-RETESTE.png        reteste de pendência ou de correção de terceiro
evidencias/NN-banco-o-que-mostra.txt          consulta + resultado
rede/NN-metodo-recurso-status.json            payload enviado e recebido
evidencias/marcas.json                        caixas por imagem (seção 4)
```

- O **mesmo `NN`** agrupa print, payload e consulta do mesmo momento. Kebab-case, sem acento.
- Nomeie com `-ANTES` desde a primeira captura de um achado: o par só se monta se o nome existe.
- Guarde o cru. O `provas.py` desenha as caixas a partir do cru e das marcas; se você já tem o
  `-circulado` (do `circular.py`), ele é usado como está e as marcas são puladas.

---

## 3. Capturar nítido

| Situação | O que fazer |
|---|---|
| Janela do navegador escondida, minimizada ou atrás de outra | O screenshot congela ou sai minúsculo. Restaure a janela (na extensão, `resize_window`; depois confira `document.visibilityState === 'visible'`) **antes** de capturar, e abra o arquivo salvo para conferir |
| Aba em segundo plano | Print velho e clique perdido. Traga a aba para frente; a página da extensão que abriu em segundo plano não serve para o print |
| Tela larga, detalhe pequeno | Faça o print de contexto **e** um de detalhe: `zoom` com `region` (extensão), `target`/`clip` com `scale: "device"` (Playwright). No PDF, o detalhe é o que se lê |
| Modal com texto pequeno | Amplie o modal por CSS só para o print (`document.querySelector('[role=dialog]').style.zoom = '1.4'`) e diga isso na legenda. Esse print nunca prova layout |
| Página inteira | Use print de página inteira só quando a prova exige; nas marcas, some o `scrollY` (campo `deslocamento`) |
| Toast, alerta, validação que some | Clique e capture **na mesma chamada em lote** (ex.: `browser_batch` com o clique e o `screenshot`), com o observador de toast instalado antes. Tire o print em até ~2 s depois da resposta |
| Requisição lenta | Capture o DEPOIS só depois que o evento terminou (espião de rede diz quando). Print tirado no meio mostra estado intermediário |
| Cópia oculta no DOM | Meça e marque o elemento visível (tamanho > 0 e por cima no ponto, `elementFromPoint`), nunca o primeiro do `querySelector` |
| Valor posto por script | Só vale se aparecer no corpo enviado; o print de um campo preenchido por `form_input` que não passou pelo `onChange` mostra um estado que o sistema nunca viu |

A escala entre screenshot e CSS varia (zoom do navegador, DPR, região). Nunca reaproveite marcas
entre prints de tamanhos diferentes sem converter (seção 4).

---

## 4. Medir as caixas

Meça **no mesmo lote** do print, sem rolar entre um e outro:

```js
(() => {
  const visivel = (sel) => [...document.querySelectorAll(sel)].find((e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const topo = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return topo === e || e.contains(topo);
  });
  const marca = (sel, n, texto) => {
    const e = visivel(sel); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), n, texto };
  };
  return JSON.stringify({ largura_css: innerWidth, dpr: devicePixelRatio, scrollY, marcas: [
    marca('[data-testid="<alvo>"]', 1, '<o que esta errado, curto>')
  ].filter(Boolean) });
})()
```

Guarde o resultado em `<rodada>/evidencias/marcas.json` (nunca na raiz do projeto testado), como
um mapa com a chave igual ao nome da imagem:

```json
{
  "07-cnpj-dv-invalido-ANTES.png":     {"largura_css": 1280, "marcas": [{"x": 96, "y": 210, "w": 360, "h": 44, "n": 1, "texto": "DV errado aceito"}]},
  "07-cnpj-dv-invalido-CORRIGIDO.png": {"largura_css": 1280, "marcas": [{"x": 96, "y": 210, "w": 360, "h": 70, "n": 1}]}
}
```

**O mesmo arquivo serve aos dois scripts.** O `provas.py` lê o mapa sozinho
(`<rodada>/evidencias/marcas.json` ou `<rodada>/marcas.json`); o `circular.py` acha a entrada pelo
nome do print (com e sem `-circulado`) ou por `--chave`:

```bash
python "$QA/scripts/circular.py" "$R/evidencias/07-cnpj-dv-invalido-ANTES.png" --marcas "$R/evidencias/marcas.json"
python "$QA/scripts/circular.py" "$R/evidencias/07-cnpj-dv-invalido-CORRIGIDO.png" --marcas "$R/evidencias/marcas.json" --cor verde
python "$QA/scripts/circular.py" "$R/evidencias/07-cnpj-dv-invalido-RETESTE.png" --marcas "$R/evidencias/marcas.json" \
  --chave 07-cnpj-dv-invalido-CORRIGIDO.png --cor verde   # reaproveita a medida de outro print do mesmo estado
```

Cada entrada do mapa também aceita `escala`, `deslocamento` e `unidade` (abaixo), lidos pelos dois
scripts.

**Unidades.** O `provas.py` aceita as duas, e é preciso dizer qual:

| Unidade | Quando | Como declarar |
|---|---|---|
| `css` | números do `getBoundingClientRect` | `{"largura_css": <innerWidth>, "marcas": [...]}` (a presença de `largura_css` já define `css`) |
| `px` | números medidos na própria imagem | lista pura `[...]` ou `{"unidade": "px", "marcas": [...]}` |

Conversão feita pelo script: `px = (css + deslocamento) × (largura_da_imagem / largura_css)`. O
DPR já está dentro dessa razão. Casos especiais:

- **Print de página inteira:** `"deslocamento": [0, <scrollY do momento da medição>]`.
- **Print de região (zoom):** meça a região em CSS (`rx, ry, rlargura`) e passe
  `"escala": <largura_da_imagem / rlargura>` com `"deslocamento": [-rx, -ry]`.
- **Marca fora da imagem** gera aviso no `gerar`: é sinal de unidade errada, `largura_css` de outro
  momento ou rolagem esquecida. Meça de novo; não ajuste no olho.

Formatos aceitos por marca: `{x,y,w,h}`, `{left,top,width,height}`, `{x0,y0,x1,y1}` ou
`[x, y, w, h, "texto"]`; opcionais `n` (número do selo), `texto` (etiqueta ao lado) e `cor`.

---

## 5. Prova textual

Quando a prova não é visual, ela é textual **com números medidos**, nunca adjetivo.

| Fonte | O que mostrar | Tipo na spec |
|---|---|---|
| Rede | método, rota, status, tempo, o trecho do corpo que prova (enviado e recebido) | `cod` com `arquivo: "rede/NN-….json"` ou `texto` |
| Banco (só leitura) | a consulta e o resultado antes e depois | `cod` |
| Log do servidor | a linha do erro real no mesmo minuto da ação; a mensagem genérica da tela ("An error occurred while saving the entity changes") esconde a causa, que está na exceção interna | `cod` |
| Números comparados | antes × depois × esperado, por cenário | `tab` com `linhas` (`classe: "ruim"`/`"bom"` por linha) |
| Teste automatizado | comando, saída resumida, quantos passaram | `cod` |

O `provas.py` mascara o que parece segredo em todo texto do documento (título, onde, causa,
legendas, `nao_validado`, PR, APLICAR e COMMIT) e, em modo estrito, nas provas textuais (Bearer, JWT,
Basic, cookie de sessão, campos `senha`, `password`, `pass`, `pin`, `token`, `api_key`,
`authorization`, `cookie`); quando mascara algo, avisa e **sai 1**. Isso é rede de proteção, não
licença: **não grave segredo** em `rede/*.json` nem em nota.

- **Spec de entrada com segredo é recusada.** No modo spec (`provas.py gerar provas.json`), segredo no
  texto, numa legenda, numa prova textual escrita na spec ou no nome de um arquivo de prova faz o
  `gerar` sair **1 sem gravar HTML nem PDF**, e o `validar` também sai 1. Tire o dado da spec e
  descreva só o tipo.
- **Prova textual de `.json`, `.har`, `.jsonl` ou `.ndjson`** passa inteira por `mascarar_estrutura` (par
  nome/valor de cookie, cabeçalho e `queryString`, JSON dentro de string, chave sensível) antes do corte em
  `max_linhas`; segredo que só aparece nas linhas omitidas vira aviso (o arquivo da rodada continua com o
  valor: mascare-o).
- **Valor que o `segredos.py` já mascarou** (`sk_live_...(39 caracteres)`, `****(15 caracteres)`) e o
  `[REMOVIDO]` não contam de novo: a evidência de um achado de segredo versionado (`MA-6-02`) pode
  citar a saída dele.

**Prova textual como DEPOIS:** ela só conta como DEPOIS com `"grupo": "depois"` (ou `"reteste"`) na
prova, ou com legenda que diga DEPOIS, RETESTE ou CORRIGIDO; sem isso fica no grupo ANTES. Ex.:
`{"tipo": "cod", "arquivo": "rede/09-post-cliente-DEPOIS.json", "grupo": "depois", "legenda": "DEPOIS: 400 com a mensagem do campo"}`.

**Arquivo que não é texto nem imagem** (vídeo, binário): o `provas.py` não o embute; no lugar entra o
bloco `ARQUIVO NÃO EMBUTIDO: <caminho>`, com aviso, e a conferência reprova. Troque por um print
(quadro do vídeo) ou por um trecho textual. Texto é tudo que decodifica em UTF-8 sem byte nulo
(`.txt`, `.log`, `.json`, `.out`, `.diff`, `.sh`, `.py` e afins).

**Backend sem tela:** o par vira prova textual: a chamada direta antes (status e corpo) e depois,
a consulta ao banco antes e depois, e o log. Ex.: `SELECT count(*) … → 2` antes, `→ 1` depois.

---

## 6. O ledger referencia tudo

- Defeito: `evidencias.antes`, `evidencias.depois`, `evidencias.reteste` com caminhos relativos à
  rodada (`cobertura.py add-defeito --antes …` e `set D-NNN --depois … --reteste …`).
- Texto das 4 partes vem do ledger: ANTES = `antes_texto` (se existir) ou esperado/obtido dos casos
  que falharam; POR QUE = `causa`; DEPOIS = `correcao`; STATUS = `status` + `justificativa` +
  os casos ligados (inclusive por `defeito_ids`): "reteste" só cita caso `--tecnica regressao`; caso
  `estatico` sai como "gate: C-NNNN <título> passou". Defeito importado (`--reteste-de`) e `retestado-ok`:
  DEPOIS = "correção de terceiro: <commit de `rodada.git`> — <assunto>", e o STATUS começa pelo veredito
  da nota 07 (RESOLVEU ou PRECISA DE AJUSTE); PRECISA DE AJUSTE, ou veredito ausente, vira caixa de aviso.
- Marcas: `evidencias/marcas.json` (ou `marcas.json` na raiz da rodada) é lido sozinho. Também dá
  para gravar a evidência como objeto `{"arquivo": "...", "rotulo": "...", "legenda": "...", "marcas": {...}}`.
- Pareamento automático: o 1º ANTES com o 1º DEPOIS (depois os RETESTE), em ordem. Imagem sem par
  vira prova única (vermelha se ANTES, verde se DEPOIS). `.json`/`.txt`/`.log` viram prova textual.
- Cor do lado de baixo: DEPOIS verde só com o defeito `corrigido` ou `retestado-ok` (senão âmbar,
  "NÃO CONFIRMADO", ou "PROPOSTA" em melhoria e decisão); RETESTE verde só com o defeito `retestado-ok`
  ou citado por regressão que passou, vermelho ("RETESTE — PRECISA DE AJUSTE") com o defeito `aberto`
  ou `nao-corrigido` ou citado por regressão que falhou, e âmbar ("SEM VEREDITO") no resto. O
  `-RETESTE` de um caso de regressão que falhou entra no par mesmo sem estar nas evidências do defeito, e
  o DEPOIS que um caso de regressão que falhou cita sai vermelho também. Reteste vermelho não conta como
  prova do DEPOIS.
- Só entra evidência dentro de `evidencias/`, `rede/`, `notas/` ou `relatorio/` da rodada (a mesma
  regra do gate). Subpasta da rodada que é link ou junction para outro lugar conta como fora, com aviso.
  Caminho com `..` ou que resolve fora (nota pessoal, `.env`, arquivo de outro projeto)
  não é lido nem embutido: vira o bloco "ARQUIVO FORA DA RODADA" e o `gerar`, o `validar` e a
  conferência saem 1. Copie a prova para `evidencias/` e corrija o caminho no ledger.
- Retratado sem arquivo vira um bloco textual "PARECIA: <título> · ERA: <justificativa>", que conta
  como a prova do item (não precisa de print para retratar).

---

## 7. Montar o documento

Duas entradas, a mesma saída:

| Entrada | Quando |
|---|---|
| **Direto do ledger** — `provas.py gerar <rodada>` | Rodada normal. Cada defeito em página nova, na ordem: retestados, corrigidos, não corrigidos, decisões de produto, retratados |
| **Spec** — `provas.py gerar provas.json` | Entrega por branch, texto revisado à mão, rótulos melhores, itens que juntam vários defeitos |

Para partir do ledger e refinar: `provas.py gerar <rodada> --salvar-spec <rodada>/relatorio/provas.json`,
edite rótulos, legendas e marcas, e gere da spec. A spec salva passa pela mesma máscara estrita do
documento antes de ir para o disco, inclusive as provas textuais e os caminhos de prova: o que for
segredo vira `[REMOVIDO]`, o aviso diz quantos e o comando sai **1**. Essa spec depois vira `PR.md` e
`APLICAR.txt`; por isso ela nunca guarda o valor. Saída 1 aqui pede limpar o ledger (a fonte), não só
a spec.

- **As caixas vão junto.** A spec salva leva a chave `marcas` com o mapa da rodada (`marcas.json`,
  `--marcas`) por caminho absoluto de cada imagem usada, e cada prova marcada com
  `marcas_esperadas_*`. Gerar dessa spec, ou de um `provas.json` de bloco com `itens` e `marcas`
  copiados, desenha as mesmas caixas. Imagem com marca esperada e nenhuma caixa no documento (spec
  sem a chave `marcas`) reprova a conferência com saída 1.
- **Filtro não sobrescreve o completo.** Com `--defeito`, `--tipo`, `--status` ou `--branch` e sem
  `--nome`, o arquivo sai como `provas-<filtro>` (`provas-D-001.pdf`, `provas-defeito.pdf`,
  `provas-<branch>.pdf`); o `relatorio/provas.pdf` da rodada nunca é trocado por um documento filtrado
  (pedir esse nome com filtro sai 2).
- **Só a spec, sem PDF:** `--salvar-spec <arquivo> --so-spec` grava a spec e sai, sem HTML nem PDF. É
  o caminho para os itens de um bloco (`references/entregas-por-branch.md` §3.8).
- Nome (`--nome` ou `nome` da spec) e repo do `commit` viram nome de arquivo sem separador de pasta:
  PDF, HTML, `PR.md`, `APLICAR.txt` e `COMMIT-*.txt` ficam sempre na pasta de saída pedida.

```bash
QA="$HOME/.claude/skills/qa-total"
python "$QA/scripts/provas.py" exemplo "$R/relatorio/provas.json"          # copia o modelo
python "$QA/scripts/provas.py" validar "$R/relatorio/provas.json" --checar-arquivos
python "$QA/scripts/provas.py" gerar "$R/relatorio/provas.json" --pr --aplicar --commit-arquivos --conferir
python "$QA/scripts/provas.py" gerar "$R" --defeito D-001 --defeito D-003  # relatorio/provas-D-001-D-003.pdf
python "$QA/scripts/provas.py" gerar "$R" --defeito D-001 --salvar-spec <pasta-do-bloco>/itens-D-001.json --so-spec  # só a spec
```

**Status do item** (campo `status`):

| Valor | Selo | Rótulo da linha DEPOIS |
|---|---|---|
| `corrigido` | CORRIGIDO | Depois |
| `retestado-ok` | CORRIGIDO E RETESTADO | Depois |
| `resolveu` / `precisa-de-ajuste` | reteste de correção de outra pessoa | Reteste |
| `nao-corrigido` | NÃO CORRIGIDO | Saída |
| `bloqueio` | NÃO CORRIGIDO — bloqueia o merge | Saída |
| `aberto` | ABERTO | Saída |
| `decisao-de-produto` | DECISÃO DE PRODUTO | Pergunta (fechada, com o custo de cada opção) |
| `retratado` | RETRATADO | ANTES vira "Parecia", POR QUE vira "Era", DEPOIS vira "Como caiu" |

Rótulos podem ser trocados por item com `"rotulos": {"depois": "Proposta"}`.

**Campos da spec** (o modelo comentado está em `templates/provas.exemplo.json`):

- Capa: `titulo` (obrigatório), `rotulo`, `branch`, `subtitulo`, `resumo`, `rodape`, `repos`,
  `base`, `depende`, `ordem`, `metadados` (lista `{rotulo, valor}`), `detalhes` (lista
  `{rotulo, texto}`), `alerta` e `aviso` (caixas vermelha e âmbar).
- Arquivos: `arquivos` (`{repo, arquivo, mais, menos}`) ou `patches` (`{repo, arquivo}`; o script
  conta as linhas do patch).
- Imagens: `base_imagens` (relativa à spec), `pastas` (apelidos; a imagem vira `["APELIDO", "arquivo.png"]`),
  `marcas` (mapa ou caminho de `marcas.json`, relativo à spec). No modo spec, imagem (`par`/`uma`) e arquivo de
  prova textual (`cod`) precisam resolver dentro de `base_imagens` (ou `--base`), de uma pasta de `pastas` ou de
  `evidencias/`, `rede/`, `notas/` ou `relatorio/` de uma rodada (pasta com `cobertura.json`); caminho absoluto,
  `..` ou link que sai disso faz o `gerar` sair 2 e o `validar` sair 1, listando o que está fora;
  `--permitir-fora` libera.
- Itens: `cod`, `titulo`, `status`, `tipo` (melhoria etc.), `severidade`, `onde`, `antes`, `causa`,
  `depois`, `status_detalhe`, `pagina_nova`, `rotulos`, `provas`.
- Provas: `par` (`antes`, `depois`, `rotulo_antes`, `rotulo_depois`, `cor_antes`, `cor_depois`
  (padrão vermelho e verde; reteste que falhou leva `cor_depois: "vermelho"`), `marcas_antes`,
  `marcas_depois`, `legenda`), `uma` (`img`, `rotulo`, `cor`, `marcas`), `cod` (`texto` ou
  `arquivo` + `max_linhas`), `tab` (`linhas` ou `html`). Todas aceitam `legenda`, `altura_mm` e
  `grupo` (`antes`, `depois`, `reteste`, `reteste-falho`); as de imagem, `marcas_esperadas*` (o ledger
  preenche; a conferência cobra as caixas).
- Fim: `nao_validado` (sempre presente; `[]` declara que tudo foi provado), `atencao`, `fora`,
  `secoes_extra`, `comandos`, `commit` (texto ou `{repo: mensagem}`), `verificacao`, `pr`.
- Marcação nos textos: `` `código` ``, `**negrito**` e `<b>…</b>`. Todo o resto é escapado: um
  `<form noValidate>` aparece como texto, nunca some.

Imagens maiores que 2400 px de largura são reduzidas (`--max-largura`). A altura de exibição é
limitada para caber na página: par até 235 mm, prova única até 105 mm (`--altura-par`,
`--altura-uma`, ou `altura_mm` na prova).

Sem Pillow, o script ainda gera o documento: faixa e moldura viram CSS e as caixas viram
sobreposição em HTML. O par composto em imagem (o padrão) exige Pillow.

---

## 8. Conferir antes de entregar

`gerar --conferir` (ou `provas.py conferir <pdf>`) reprova com saída 1 quando:

- falta arquivo de imagem referenciado no HTML, ou sobrou um bloco `IMAGEM FALTANDO`;
- sobrou placeholder `{{…}}`;
- falta o rodapé ou o "N / M" em alguma página;
- o HTML tem imagens e o PDF nenhuma (não carregaram na impressão);
- sobrou um bloco `ARQUIVO NÃO EMBUTIDO` ou `ARQUIVO FORA DA RODADA`;
- uma imagem tinha marcas no ledger ou no mapa e saiu sem nenhuma caixa (spec copiada sem `marcas`);
- o documento não tem item, ou não tem nenhum par ANTES/DEPOIS, sem `--sem-itens "<motivo>"` (que
  grava a ressalva "Bloco sem defeito: <motivo>" no PDF);
- há item `corrigido`, `retestado-ok` ou `resolveu` sem DEPOIS (par, caixa verde ou prova textual do
  grupo `depois`/`reteste`; reteste vermelho não conta), ou item sem prova nenhuma (retratado sem
  arquivo já sai com o bloco PARECIA/ERA), sem `--permitir-sem-prova` (que publica com a ressalva no
  PDF; só com o ok do usuário, e diga a ele);
- algum texto teve segredo mascarado.

`gerar` e `validar` aplicam as mesmas regras de item, par e segredo antes de imprimir.

Ele renderiza as páginas em PNG (PyMuPDF) em `<rodada>/relatorio/conferir/<nome do pdf>/` quando o PDF está
numa rodada (fora dela, na pasta temporária, com um hash do caminho; o `conferir` imprime o caminho da
`grade.png`) e monta `grade.png`. **Olhe a
grade e, depois, a página de cada par em resolução de leitura** (`conferir <pdf> --paginas 3 --dpi 110`):

- [ ] cada par tem ANTES em cima e DEPOIS embaixo, com faixa legível;
- [ ] a caixa está no ponto certo nos dois (caixa deslocada = medição de outro momento);
- [ ] o texto do print se lê no tamanho do PDF (senão, troque por print de região);
- [ ] nenhum item `corrigido` sem prova do DEPOIS (o `validar` também avisa);
- [ ] "O que ainda não foi validado" está presente e diz a verdade;
- [ ] rodapé com o nome em toda página.

Se o navegador não imprimir as margens da página (Chrome antigo), o `gerar` carimba rodapé e
"N / M" com PyMuPDF e avisa. Sem PyMuPDF, abra o PDF e confira à mão; `--exigir-render` faz a
conferência sair 5 nesse caso.

---

## 9. Entrega por blocos (branch por assunto)

Quando o usuário pede para separar por assunto (`references/correcao-e-relatorio.md` §8.5):

1. Uma pasta por bloco: `NN-<branch com / trocado por __>/`, com `provas.json`, `front.patch` /
   `back.patch` e as evidências (ou `base_imagens` apontando para a rodada). Os itens saem do ledger
   sem tocar no PDF da rodada: `provas.py gerar <rodada> --defeito D-NNN --salvar-spec
   <bloco>/itens-D-NNN.json --so-spec`, e você copia `itens` **e** `marcas` para o `provas.json` do bloco.
2. Em cada pasta: `provas.py gerar provas.json --pr --conferir`. Quando o `provas.json` veio do
   `entregas.py comandos`, **não** passe `--aplicar` nem `--commit-arquivos`: o `APLICAR.txt` e o
   `COMMIT-*.txt` já saíram de lá, com os caminhos dos patches provados (sem o `entregas.py`, use os
   dois). O nome do PDF sai do campo `nome` da spec (`NN-<branch com / trocado por __>`, que o
   `entregas.py` preenche) ou, sem ele, da branch; o rodapé repete a branch em toda página.
3. Índice: `provas.py indice <pasta-das-entregas>` (acha os `*/provas.json`) ou um `indice.json`
   com `titulo`, `intro`, `blocos` (caminhos das specs), `ordem` (ids), `alerta` e `secoes`. Gera
   `00-INDICE.pdf` com a tabela de blocos: repositórios, arquivos, linhas, dependências e situação
   (`pronto`, `segurar`, `com pendências`, ou o campo `situacao` da spec).
4. Bloco com efeito colateral conhecido: `alerta` na spec (vira "segurar" no índice).
5. **Ninguém cria branch nem commita aqui.** `APLICAR.txt`, `COMMIT-*.txt` e `PR.md` são para quem
   recebe; o documento diz "nada foi commitado".

---

## 10. Quando não dá para provar

- **Falta papel, ambiente ou autorização:** o item vai com o que deu para provar e a pendência
  entra em `nao_validado`, com o que destrava ("logue como aprovador na janela 2").
- **Efeito externo não autorizado** (e-mail real, pagamento): prove até onde o código atua (a
  notificação criada, a fila gravada) e diga que o envio não foi exercitado.
- **Não reproduziu de novo para o DEPOIS:** status `corrigido` (sem reteste), com o motivo no
  `status_detalhe` e "falta …; destrava: …" na justificativa do defeito (`add-defeito`/`set` recusam
  `corrigido` sem caso de reteste e com justificativa fraca, saída 2). Nunca use um print antigo como
  DEPOIS.

---

## 11. Armadilhas reais

- **Print de DEPOIS em outro estado** (outro registro, outra rolagem, outro papel) não é par: o
  revisor compara coisas diferentes. Refaça no mesmo estado.
- **Marcas medidas num momento e print de outro** (modal animando, rolagem, toast empurrando o
  layout): a caixa sai deslocada. Meça e capture no mesmo lote.
- **Marcas em pixels da imagem tratadas como CSS** (ou o contrário) desenham a caixa no lugar
  errado e às vezes fora da imagem. Declare a unidade.
- **Remover tags para gerar o PR.md** apagou `<form noValidate>` de um texto e deixou ``` `` ``` no
  lugar. O `provas.py` só converte `<b>`, nunca remove o resto.
- **Apagar a pasta `provas/` inteira antes de regerar** leva junto o que não é do documento. O
  script só apaga as imagens compostas com o prefixo dele.
- **`chrome.exe --version` no Windows não imprime a versão:** abre uma janela na sessão do usuário.
  Para saber a versão, leia o registro ou as propriedades do executável; para imprimir PDF, o
  script usa perfil temporário e headless, sem tocar na sessão logada.
- **Impressão que leva 3 minutos por PDF.** Medido com o Chromium do Playwright no Windows: o primeiro
  lançamento num perfil novo pode travar sem gerar nada, em qualquer modo headless, e o segundo sai em
  cerca de 1 s. O `provas.py` e o `gerar_pdf.py` conferem o PDF a cada 1 s (tamanho estável e `%%EOF`
  no fim), encerram o navegador assim que ele fica pronto, dão à primeira tentativa só
  `--timeout-primeira` segundos (padrão 30) e à segunda o `--timeout`, e lembram o modo que funcionou
  (`qa-total-headless-modo.json` na pasta temporária). Um PDF passou de ~3 min para ~33 s.
- **Extração de texto do PDF troca caracteres** (ponto médio vira `∙`, espaço vira NBSP): a
  conferência do rodapé compara só letras e números.
- **Imagem gigante** (print de página inteira em tela 4K) estoura o PDF e fica ilegível: reduza
  para 2400 px (automático) e prefira print de região para o detalhe.
