# Módulos opcionais: comparação visual, acessibilidade automática, fuzz e desempenho

> Quatro módulos que entram **quando o projeto tem a ferramenta ou o usuário pede**: 7 (comparação
> visual entre rodadas), 8 (acessibilidade automática com axe-core), 9 (entradas aleatórias, fuzz) e
> 10 (desempenho). Eles **acrescentam** casos ao ledger; não substituem nenhuma fase nem o teste
> manual. As regras do `SKILL.md` e do `.qa/PERFIL.md` mandam: produção é somente leitura, nada de
> senha nem login, escrita só pela aplicação, efeito externo só com autorização.
>
> Carregue só a seção do módulo que vai usar, na fase em que ele entra (tabela da seção 0.1).

> Os códigos `MO-*` estão registrados no catálogo (`references/catalogo-de-testes.md` §12), que é a
> fonte do próximo código livre: linha nova entra pelo `scripts/aprender.py` (`--secao MO-<n>`).

## Sumário

0. Regras comuns aos quatro módulos
7. Comparação visual entre rodadas — `MO-7`
8. Acessibilidade automática (axe-core) — `MO-8`
9. Entradas aleatórias e hostis (fuzz) — `MO-9`
10. Desempenho — `MO-10`
11. Resumo dos códigos e dos comandos

---

## 0. Regras comuns aos quatro módulos

### 0.1 Ligar, desligar e em que fase entra

O estado de cada módulo fica no `.qa/PERFIL.md`, numa tabela própria, com data e motivo:

```markdown
## Módulos opcionais
| Módulo | Estado | Ferramenta | Por quê | Desde |
|---|---|---|---|---|
| 7 visual | ligado | Playwright (viewport exato) + visual_diff.py | baseline em .qa/baseline/ | 2026-09-30 |
| 8 a11y | ligado | axe-core do node_modules (CSP barra CDN) | projeto web | 2026-09-30 |
| 9 fuzz | ligado só em dev | fuzz_valores.py | escrita de dado de teste autorizada no dev | 2026-09-30 |
| 10 desempenho | passivo ligado; Lighthouse desligado | xhr-spy + snippet de vitais | sem build de produção local | 2026-09-30 |
```

| Módulo | Liga sozinho quando | Precisa de pedido ou autorização | Nunca | Fase |
|---|---|---|---|---|
| 7 visual | existe `.qa/baseline/` do alvo; rodada é reteste, regressão ou modo PR; mudança de CSS, tema, componente compartilhado ou biblioteca de UI | criar a primeira baseline de um projeto (avise e siga) | atualizar a baseline para "fazer passar" | 5 (captura), 6 (triagem), 7 (reteste) |
| 8 a11y | projeto com UI web e axe disponível (`node_modules/axe-core`, `@axe-core/*`, ou CDN com hash SRI em host local, sem sessão real) | instalar o axe no projeto | afrouxar a CSP para o axe carregar; injetar por CDN em produção ou em aba com sessão real | 5, em cada tela e estado |
| 9 fuzz | ambiente de teste com escrita de dado de teste autorizada no PERFIL | campo que dispara efeito externo (e-mail, SMS, cobrança); chamada direta de escrita na API | produção; dado de outra pessoa; rajada | 5, depois do caminho feliz de cada campo |
| 10 desempenho | **parte passiva sempre**: tempos e contagem do espião de rede, vitais na tela | Lighthouse e build de produção (reescrevem pastas e ocupam a máquina); log de SQL que exige mudar configuração | carga em produção ou contra terceiro; carga sem autorização | 5 (medição), 6 (causa), 7 (antes/depois) |

**Ferramenta ausente:** pergunte antes de instalar (inclusive `npx`, que baixa o pacote) e registre
a resposta no PERFIL. Sem a ferramenta, o módulo fica desligado com o motivo — não invente
substituto que meça outra coisa.

**Módulo desligado também entra no ledger**, para provar que foi considerado:

```bash
python "$QA/scripts/cobertura.py" add-caso "$R" --item "dimensao:MO-7" --criar-item --tecnica regressao \
  --titulo "[MO-7-*] Comparação visual" --esperado "n/a" --oraculo "PERFIL" \
  --status nao-aplicavel --justificativa "primeira rodada do projeto: sem baseline; prints desta rodada viram a baseline"
```

### 0.2 Como cada módulo vai para o ledger

Os casos se penduram nos **itens que já existem** (`tela:`, `estado:`, `elemento:`, `api:`). O item
`dimensao:MO-<n>` serve só para o resumo do módulo e para o registro de "desligado".

| Módulo | Item | `tecnica` | Título começa com | Evidência (relativa à rodada) |
|---|---|---|---|---|
| 7 | `tela:` ou `estado:` | `regressao` | `[MO-7-NN]` | `evidencias/visual/NN-<tela>__<estado>__<L>x<A>.png`, `evidencias/visual-diff/*-comparacao.png`, `relatorio/visual-diff.md` |
| 8 | `tela:` ou `estado:` | `a11y` | `[MO-8-NN]` | `evidencias/NN-a11y-<tela>-<estado>.json` + o print do estado `evidencias/NN-a11y-<tela>-<estado>.png` |
| 9 | `elemento:` (campo) ou `api:` | `erro-adivinhado` (UI), `seguranca` (XSS, injeção, mass assignment), `api` (corpo malformado) | `[MO-9-NN]` | `notas/fuzz-<campo>.json` (a lista usada), `rede/NN-fuzz-<campo>.json`, print de cada anomalia |
| 10 | `tela:` ou `api:` | `desempenho` | `[MO-10-NN]` | `rede/NN-tempos-<tela>.json`, `evidencias/NN-vitais-<tela>.txt`, `evidencias/NN-lighthouse-<tela>.report.{json,html}`, `evidencias/NN-bundle.txt`, `evidencias/NN-sql-<consulta>.txt` |

- **O oráculo vem do PERFIL** quando houver número combinado (orçamento de bundle, limite de tempo,
  nível WCAG). Sem número combinado, use o da seção do módulo e diga isso no oráculo.
- **Resultado do automático não é veredito.** Violação do axe, pixel diferente e tempo alto viram
  caso para **olhar**. Só vira defeito depois da fase 6 (reproduzir por outro caminho, descartar a
  ferramenta, melhor argumento contra).
- **Severidade** sai do impacto no usuário, não da ferramenta. Tabelas em cada seção.
- **Todo achado do módulo segue o protocolo comum**: print `-ANTES` circulado, POR QUE com
  `arquivo:linha`, `-CORRIGIDO`, reteste com a mesma ferramenta e o mesmo estado.

### 0.3 O que nenhum módulo faz

- Não muda configuração de segurança para o teste passar (CSP, CORS, rate limit, autenticação).
- Não instala dependência no projeto nem mexe em `package.json`, `requirements`, `.csproj` sem pedido.
- Não grava em produção. Lighthouse e vitais em produção são leitura, mas só na sessão do usuário e
  sem carga.
- Não atualiza baseline, não "ignora" regra do axe e não sobe limiar para esconder diferença.
- Não substitui o manual: teclado, leitor de tela, regra de negócio e leitura do resultado continuam
  com você.

---

## 7. Comparação visual entre rodadas — `MO-7`

**Para quê:** pegar a mudança visual que ninguém pediu — o botão que desalinhou, a cor que mudou, a
coluna que sumiu — quando a rodada mexe em CSS, tema, componente compartilhado ou dependência de UI.
Diferença **não** é defeito: é um caso para abrir o par e decidir.

### 7.1 Quando ligar

- Há `.qa/baseline/` com prints do alvo, e a rodada é reteste, regressão ou modo PR.
- A mudança toca componente compartilhado, tema, design system, biblioteca de componentes ou
  layout global (o raio de impacto é visual, e grande).
- Primeira rodada com o módulo: os prints aprovados desta rodada **viram** a baseline (7.4).

Não serve para tela cujo dado muda a cada carga sem como fixar (painel ao vivo): aí compare só a
estrutura (recorte sem o dado) ou deixe `nao-aplicavel` com o motivo.

### 7.2 Capturar sempre nas mesmas condições

Tudo que não for igual entre rodadas vira ruído. Fixe e anote no `MANIFESTO.json` (7.4):

| Condição | Como fixar | Como conferir |
|---|---|---|
| Ferramenta e navegador | Playwright (viewport exato); o mesmo canal do Chromium | versão no manifesto |
| Viewport | `browser_resize` para as larguras do PERFIL (ex.: 390, 768, 1280, 1440) | `innerWidth`, `innerHeight`, `matchMedia` (LI-13: redimensionar janela não é viewport) |
| DPR e escala do print | o mesmo em toda rodada (`scale: "device"` ou `"css"`, um só) | `devicePixelRatio` e largura do arquivo |
| Zoom | 100% | `visualViewport.scale` = 1 |
| Idioma, tema, fuso | os mesmos; tema escuro e RTL têm baseline própria | `document.documentElement.lang`, `matchMedia('(prefers-color-scheme: dark)')` |
| Papel e dado | o mesmo usuário e o **mesmo registro de teste**, nunca "o primeiro da lista" | nome na tela e id na URL |
| Movimento | animação, transição e cursor congelados (snippet abaixo) | dois prints seguidos dão `igual` (7.5) |
| Estado estável | rede ociosa, fontes e imagens carregadas, sem skeleton, sem toast, rolagem no topo, mouse fora, foco tirado | `__qa.esperarRede`, `document.fonts.status === 'loaded'` |

Cole antes de cada print (usa folha de estilo construída, que a CSP não bloqueia como bloquearia um
`<style>` injetado):

```js
(async () => {
  const css = '*,*::before,*::after{animation:none!important;transition:none!important;' +
    'caret-color:transparent!important;scroll-behavior:auto!important}';
  if (!window.__qaSemAnimacao) {
    try { const f = new CSSStyleSheet(); f.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, f]; window.__qaSemAnimacao = 'adotada'; }
    catch (e) { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
      window.__qaSemAnimacao = 'style'; }
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  window.scrollTo(0, 0);
  if (document.fonts) await document.fonts.ready;
  const imagens = [...document.images].filter(i => !i.complete).length;
  return { congelado: window.__qaSemAnimacao, fontes: document.fonts ? document.fonts.status : '?',
    imagens_pendentes: imagens, largura: innerWidth, altura: innerHeight, dpr: devicePixelRatio };
})()
```

Se o projeto já tem **Playwright Test**, prefira `expect(page).toHaveScreenshot({ animations: 'disabled',
caret: 'hide', mask: [locator] })` num teste de regressão: a comparação vira parte da suíte e roda
sozinha nas próximas rodadas.

### 7.3 Nome do arquivo

```text
<rodada>/evidencias/visual/NN-<tela-slug>__<estado>__<L>x<A>[__<papel>][__<idioma>][__escuro].png
.qa/baseline/<navegador>-dpr<N>/<tela-slug>__<estado>__<L>x<A>[...].png
```

O `NN-` segue a numeração da rodada; o `visual_diff.py --ignorar-prefixo` casa com o nome da
baseline, que não tem número. Um arquivo por **tela × estado × viewport** do inventário (vazio, com
dado, erro de validação exibido, modal aberto, menu aberto…), não um por tela.

### 7.4 A baseline

- Mora em `.qa/baseline/` (fora da rodada, para durar entre rodadas; já fica no
  `.git/info/exclude` junto com `.qa/`).
- **Nasce de tela aprovada.** Só entra print de tela cujos casos da rodada passaram. Print de tela com
  defeito aberto congela o bug como referência.
- **Copie, nunca mova,** de `<rodada>/evidencias/visual/` (tirando o `NN-`). A rodada continua com a
  própria evidência.
- `MANIFESTO.json` por arquivo: `commit` testado (`git log -1 --format=%h`), `data` (de `date`, nunca
  estimada), ambiente, ferramenta e versão, viewport, DPR, idioma, tema, papel, registro usado,
  rodada de origem e quem aprovou. Promoção posterior acrescenta `motivo` ("mudança intencional:
  <commit ou pedido>, <data>").
- **Máscaras** em `.qa/baseline/mascaras.json`, sempre com `motivo`. Meça no navegador:

```js
JSON.stringify({ largura_css: innerWidth, por_arquivo: { '*clientes__lista*': [...document.querySelectorAll(
  '[data-testid=data-cadastro], .relogio')].map(e => { const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, motivo: 'data/hora gerada na carga' }; }) } })
```

Mascare só o que é dinâmico de verdade: relógio, "há N minutos", id gerado, avatar aleatório, gráfico
ao vivo, anúncio. **Nunca** mascare total, status, contagem ou texto de regra: é ali que mora a
regressão que importa.

### 7.5 Comparar

1. **Controle de estabilidade, uma vez por tela nova:** capture a mesma tela duas vezes na mesma
   rodada e compare. Precisa dar `igual`. Se não der, falta espera ou máscara — sem isso, toda
   diferença entre rodadas é suspeita.
2. Rode:

```bash
python "$QA/scripts/visual_diff.py" .qa/baseline/chromium-dpr1 "$R/evidencias/visual" \
  -o "$R/evidencias/visual-diff" --mascaras .qa/baseline/mascaras.json --ignorar-prefixo --lado-a-lado \
  --relatorio-md "$R/relatorio/visual-diff.md" --relatorio-json "$R/relatorio/visual-diff.json"
```

- Saída 0: nada reprovou. Saída 1: alguma imagem acima do limiar ou com tamanho diferente. Saída 2:
  uso ou imagem que não abriu. Saída 3: falta Pillow.
- `--limiar 0` (padrão) reprova qualquer pixel acima da tolerância por canal (16). É o certo para a
  mesma máquina e o mesmo navegador. Entre máquinas diferentes, **mascare o ruído antes** de subir o
  limiar, e registre o limiar no PERFIL.
- Cada imagem diferente ganha `-diff.png` (vermelho = mudou, azul = mascarado, amarelo = contorno da
  base quando o tamanho mudou), `-regioes.json` (marcas no formato do `circular.py`, escala 1) e, com
  `--lado-a-lado`, `-comparacao.png` (base | atual | diferença) — esse é o par do PDF.

### 7.6 Triar cada diferença

| Status no relatório | O que fazer |
|---|---|
| `igual` | caso `passou`, evidência: o print atual + o relatório |
| `abaixo-do-limiar` | olhe mesmo assim se a região for de dado: um dígito trocado é pequeno |
| `acima-do-limiar` | abra o `-comparacao.png` e classifique: **regressão**, **intencional** ou **ruído** |
| `tamanho-diferente` | descubra por que antes de olhar o resto: conteúdo novo, quebra de linha, rolagem, viewport |
| `so-na-base` | a tela sumiu da rodada: removida, rota quebrada ou nome mudou? É cobertura perdida até provar o contrário |
| `so-na-atual` | tela nova: revise a mão; se estiver certa, promova para a baseline |

- **Regressão:** `add-defeito` com `--antes` apontando o `-comparacao.png` e o print atual circulado
  (`circular.py <print-atual> --marcas <nome>-regioes.json`), POR QUE com `arquivo:linha` do CSS ou
  componente. Depois da correção, novo print e nova comparação: `igual` à baseline é o DEPOIS.
- **Intencional:** registre quem pediu e o commit; só então promova o print novo para a baseline,
  com `motivo` no manifesto. Caso `passou` com essa justificativa no `--obtido`.
- **Ruído:** acerte a condição de captura ou acrescente máscara com motivo. Se já tinha virado
  defeito, ele vira `retratado`, dizendo o que enganou.

### 7.7 Armadilhas

- **Deslocamento vertical** (uma linha a mais no topo) faz tudo abaixo parecer diferente. Compare por
  região (recorte da área) ou print só do viewport, e trate a causa do deslocamento como o achado.
- **Print de página inteira** varia com a altura do conteúdo; prefira viewport fixo + rolagem
  controlada, ou print do elemento.
- **Aba em segundo plano** congela o print; **janela minimizada** gera imagem minúscula. Abra o
  arquivo antes de confiar (execução §2.1).
- **Fonte ainda carregando**, imagem preguiçosa e skeleton geram diferença "fantasma": espere o estado
  estável (7.2).
- **Cópia oculta no DOM** (componente montado duas vezes) não aparece no print, mas muda a altura se
  vazar: confira com `elementFromPoint` (LI-07).
- **Hover e foco** mudam cor e sombra: mouse fora, foco tirado.
- **Navegador ou sistema atualizado** muda serrilhado e fonte: refaça a baseline inteira, numa rodada
  só para isso, com registro.

### 7.8 Linhas de catálogo

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

---

## 8. Acessibilidade automática (axe-core) — `MO-8`

**Para quê:** varrer cada tela e cada estado atrás das falhas que uma máquina enxerga (rótulo
faltando, contraste, ARIA inválida, nome acessível vazio, id duplicado) em segundos, e liberar o
tempo manual para o que ela não enxerga.

### 8.1 Quando ligar

Projeto com UI web (inclusive webview e embed) e axe disponível por um destes caminhos, nesta ordem
de preferência:

| Caminho | Quando | Como |
|---|---|---|
| `@axe-core/playwright` (ou `cypress-axe`, `jest-axe`) já no projeto | o projeto tem suíte | `new AxeBuilder({ page }).withTags([...]).analyze()` num teste: vira regressão automática |
| `node_modules/axe-core` no projeto | quase todo front com testes | cole o **conteúdo** de `node_modules/axe-core/axe.min.js` na ferramenta de JS e depois o `axe-inject.js` |
| CDN | só com a página num host local (`localhost`, `127.0.0.1`, `*.localhost`, `*.test`), **sem sessão real** e a CSP permitindo | cole só o `axe-inject.js`; ele injeta de jsdelivr ou unpkg, versão fixa e com o hash SRI (`integrity`) conferido. URL sem hash é recusada sem injetar nada; outra URL só com `window.__qaAxe = { urls: [...], integridade: { "<url>": "sha384-…" } }` |

**Nunca injete por CDN em produção nem em aba com sessão real; use `node_modules/axe-core` (arquivo
local) ou o Playwright com perfil de QA.** Script de terceiro injetado na aba logada roda com a
sessão de quem está logado: lê o token do storage e age como a pessoa. O hash SRI garante que o
arquivo é exatamente aquele axe; o script ainda recusa injetar de outra origem quando a página não
está num host local, mas "host local" não prova que não há sessão real — isso é com você.

O código avaliado pela ferramenta de JS (extensão ou `page.evaluate`) **não** é barrado pela CSP; uma
tag `<script>` externa é. Por isso o arquivo local funciona onde o CDN falha.

### 8.2 Como rodar

1. Leve a tela ao estado estável, na aba **visível** (LI-09) e com dado real.
2. Cole `scripts/axe-inject.js` inteiro. Na extensão, a ferramenta espera a Promise e mostra o
   resumo. No Playwright: `async () => { <conteúdo>; return await window.__qa.a11yPromessa }`.
3. Para cada estado que muda o DOM, rode de novo com contexto e rótulo:

```js
window.__qaAxe = { estado: 'modal-novo-cliente', contexto: '[role=dialog]' }   // antes de colar de novo
// ou, já instalado:
await __qa.a11yRodar({ estado: 'erros-de-validacao', contexto: 'form' })
__qa.a11yResumo()          // texto curto para a nota
__qa.a11yExportar()        // JSON: salve em evidencias/NN-a11y-<tela>-<estado>.json
```

Estados que pedem rodada própria: carregado com dado, vazio, carregando, erro de API, formulário com
erros exibidos, modal ou drawer aberto, menu ou combobox aberto, toast visível, tela de celular.

4. Tags padrão: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`. `boasPraticas: true`
   acrescenta `best-practice` (útil, mas não é norma: severidade menor).
5. **Se a CSP bloquear**, ou se o script recusar por falta de hash (`sem-integridade`), por hash que
   não confere (`rede-ou-integridade`) ou por host que não é local (`host-nao-local`), ele devolve a
   instrução: arquivo local ou Playwright. Nunca afrouxe a CSP, nunca tire o hash e nunca rode em
   outra rota "sem CSP" como prova desta: o caso fica `nao-validado` com o motivo.

### 8.3 Ler o resultado e levar ao ledger

- **Um caso por regra violada por tela** (não por nó): `[MO-8-01] /clientes · color-contrast (12 nós)`,
  `--evidencia` com o JSON e o print do estado, `--obtido` com os três primeiros seletores.
- **`incompletos`** são itens que o axe não decidiu (contraste sobre imagem ou gradiente, por
  exemplo): cada regra vira caso de **revisão manual**, nunca `passou` por omissão.
- **Severidade** (impacto no usuário, confirmado pela fase 6):

| Impacto do axe | Severidade inicial | Sobe para `critico` quando |
|---|---|---|
| `critical` | `alto` | impede concluir um fluxo P0 por teclado ou leitor de tela |
| `serious` | `medio` | atinge o controle principal da tela |
| `moderate` | `baixo` | — |
| `minor` | `baixo` | — |

- **Contraste:** antes de propor a correção, meça a cor real do elemento visível
  (`getComputedStyle`), calcule a razão e proponha um token **do design system** que passe.
- **`duplicate-id` e `duplicate-id-aria`** podem ser o componente montado duas vezes (cópia oculta):
  é achado de comportamento, não só de acessibilidade (LI-07).
- Depois de corrigir, rode o axe **no mesmo estado**: o par de JSON antes/depois é a prova, junto do
  teste de teclado.

### 8.4 O que o automático não pega — continua manual

O axe cobre só parte dos critérios WCAG. Faça sempre, por tela, as linhas `DM-A11-*` do catálogo:

- ordem do Tab igual à visual, sem armadilha de foco (DM-A11-01);
- foco visível e **devolvido** ao gatilho ao fechar modal (DM-A11-02);
- Enter, Espaço e Esc (DM-A11-03);
- controle clicável que não é `<button>`/`<a>` (DM-A11-04) — o axe **não** acusa `<span onclick>`:
  isso foi medido;
- erro anunciado e ligado ao campo, mensagem que o leitor de tela lê (DM-A11-06);
- texto alternativo **com sentido** (o axe só vê se existe), zoom de 200% (DM-A11-11), movimento
  reduzido (DM-A11-12), alvo de toque no celular (DM-A11-13).

### 8.5 Armadilhas

- Rodar no meio da carga mede um estado intermediário (LI-06). Espere a rede e o elemento final.
- Seletor que o axe devolve aponta o **primeiro** nó que casa; confira se é o visível.
- `iframe` de outra origem e shadow DOM fechado não são analisados: registre como não coberto ou
  rode dentro do frame.
- Versões diferentes do axe dão números diferentes: compare rodadas só com a mesma versão e as
  mesmas tags (o resultado traz `versao_axe` e `tags`).
- O `html` de cada nó vai truncado e com `value` de campo de senha ou oculto mascarado; mesmo assim,
  não cole o JSON em lugar público sem olhar: pode ter nome ou e-mail de cliente.

### 8.6 Linhas de catálogo

- **MO-8-01** Rode o axe em toda tela, no estado carregado com dado real → cada regra violada vira caso, com o JSON e o print.
- **MO-8-02** Rode de novo em cada estado que muda o DOM (modal, menu, erros exibidos, vazio, erro de API, toast) com `contexto` → violações que só existem no estado aparecem.
- **MO-8-03** Formulário com todos os erros exibidos → `aria-invalid`, mensagem ligada ao campo, nenhum rótulo faltando.
- **MO-8-04** Leia os `incompletos` → cada regra vira caso de revisão manual com o resultado medido.
- **MO-8-05** `duplicate-id` → confira se é cópia oculta do componente (achado de comportamento).
- **MO-8-06** Contraste acusado → razão medida na cor real e proposta com token do design system.
- **MO-8-07** Registre `versao_axe`, `tags` e `contexto` → comparação entre rodadas só com os mesmos três.
- **MO-8-08** `iframe` de outra origem e shadow DOM fechado → analisados à parte ou registrados como não cobertos.
- **MO-8-09** Depois do automático, as linhas manuais `DM-A11-01` a `-04`, `-06`, `-11` a `-13` → casos próprios, nunca deduzidos do resultado do axe.
- **MO-8-10** Tela usada no celular → axe na largura do celular (viewport exato), com `wcag22aa` (alvo de toque).
- **MO-8-11** CSP bloqueou o CDN → arquivo local ou Playwright; nunca afrouxar a CSP nem provar com outra rota.
- **MO-8-12** Correção de acessibilidade → axe no mesmo estado (JSON antes/depois) e teclado de novo.
- **MO-8-13** 🔒 Antes de injetar o axe, confira onde a aba está → em produção ou em aba com sessão real, só arquivo local (`node_modules/axe-core`) ou Playwright com perfil de QA; CDN só em host local, sem sessão real e com hash SRI (`origem_axe` do resultado registrada na evidência).

---

## 9. Entradas aleatórias e hostis (fuzz) — `MO-9`

**Para quê:** achar o valor que a validação esqueceu — o emoji que estoura a coluna, o `NaN` que vira
"200020,00%", a busca por `%` que devolve a tabela inteira, o `<b>` que aparece em negrito na lista.
É a massa da seção 3 do catálogo, sistematizada e com o "o que observar" de cada valor.

### 9.1 Limites (antes de qualquer valor)

- **Só em dev/teste**, nunca em produção, e **só no registro que o próprio teste criou** (prefixo `QA
  <data> <caso>`). Nada de editar dado de outra pessoa para ver se quebra.
- **Um valor por vez, no ritmo de uma pessoa.** Fuzz aqui não é rajada: rajada é carga (módulo 10) e
  exige outra autorização.
- **Os marcadores são inofensivos de propósito:** XSS só empurra um texto para `window.__qaXss` (ou
  abre um `alert` com `--marcador alert`), template só calcula `7*7777`, comando só faz `echo`. Nunca
  troque por payload que apague, altere ou leia dado.
- **E-mail:** os de formato válido usam domínio reservado (`example.com`, `.invalid`), que não
  entrega a ninguém. Para provar envio real, `--dominio` com a caixa de teste autorizada no PERFIL.
- **Campo que dispara efeito externo** (envio de e-mail, SMS, cobrança, integração) só com
  autorização registrada; sem ela, teste a validação até antes do envio e marque o resto
  `nao-validado`.
- Valores com `CUIDADO` (NUL, aninhamento profundo, gigantes, SSRF) podem derrubar componente fraco:
  um envio só, em dev, e `--sem-cuidado` quando o ambiente for compartilhado com outras pessoas.

### 9.2 Gerar a lista

```bash
python "$QA/scripts/fuzz_valores.py" --tipo texto --limite-campo 120 --saida "$R/notas/fuzz-nome.json"
python "$QA/scripts/fuzz_valores.py" --tipo numero --num-min 51 --num-max 100000     # limites da regra real
python "$QA/scripts/fuzz_valores.py" --tipo email --dominio caixa-de-teste.exemplo.com.br
python "$QA/scripts/fuzz_valores.py" --tipo json --max 5000 --formato jsonl             # corpos de API
python "$QA/scripts/fuzz_valores.py" --tipo texto --categoria xss --categoria template --prefixo qa-c0042
python "$QA/scripts/fuzz_valores.py" --help                                              # tipos e categorias
```

Tipos: `texto`, `numero`, `data`, `email`, `documento` (CPF/CNPJ, inclusive CNPJ alfanumérico, gerados
pelo algoritmo), `json`, `url`, `prompt` (injeção de prompt para aplicação com modelo de linguagem:
direta, troca de papel, pedido do prompt de sistema, instrução escondida em documento, exfiltração
por imagem, coação de ferramenta; catálogo `PJ-LLM`), `todos`. `--limite-campo` e `--num-min/--num-max` vêm da **regra
real** (código do servidor, schema), não do `maxlength` da tela. `--prefixo qa-c0042` liga o marcador
ao caso. A semente é fixa: a mesma linha de comando gera os mesmos valores (o replay repete).

### 9.3 Aplicar pela tela

- **Digite como humano** os valores curtos (LI-10: valor posto por script só vale se aparecer no corpo
  enviado). Valores longos: cole, ou use o setter nativo + evento, e **confira o payload**:

```js
((sel, valor) => {
  const el = document.querySelector(sel);
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, valor);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { tamanho: el.value.length, maxlength: el.maxLength };
})('#nome', 'VALOR')
```

  ⚠️ O setter **ignora o `maxlength`** do campo (o navegador só limita o que a pessoa digita ou cola).
  Valor acima do `maxlength` posto por script testa o **servidor**, não a tela: registre assim.
- Depois de cada valor: salve (`__qa.limpar()` antes, `esperarRede` depois), leia o status, o corpo
  enviado e o recebido, recarregue e compare **tela, payload e banco**.
- **XSS e HTML:** grave o valor e abra **toda** saída onde ele aparece — lista, detalhe, tooltip,
  título da aba, breadcrumb, modal de confirmação, notificação, e-mail, PDF, exportação. Em cada uma:

```js
JSON.stringify(window.__qaXss || [])        // precisa ser []: qualquer item é script executado
```

  e o texto aparece **literal** (com `<` e `>`). Tag interpretada sem script (negrito) também é achado.
- **Template:** procure `54439` em toda saída, inclusive e-mail e PDF gerados no servidor.
- **Busca, filtro e ordenação:** curingas (`%`, `_`) e aspas → compare o contador antes e depois
  (LI-21); busca por `%` que devolve tudo é defeito.
- **Exportação:** fórmula (`=1+1`) sai como texto no CSV/Excel, prefixada.

### 9.4 Aplicar pela API

Corpos `--tipo json` e campos individuais pela chamada direta (execução §1.2), **com a sessão do
usuário, no registro do próprio teste**, só fora de produção e com escrita direta autorizada:

- malformado → 400/422 com mensagem; nunca 500, nunca pilha, nunca gravação parcial;
- **mass assignment** (`isAdmin`, `tenantId`, `status`, `preco` misturados no corpo real) → releia o
  registro: nada disso gravou;
- tipo trocado e `null` em obrigatório → 400 citando o campo;
- poluição de protótipo (servidor Node) → resposta normal e nada mudou no comportamento seguinte.

Salve requisição e resposta de cada envio em `rede/NN-fuzz-<campo>.json` (um arquivo por campo, com a
lista dos ids `FZ-…` usados). Nunca grave cabeçalho de autenticação.

### 9.5 O que observar e como registrar

| Sinal | É achado quando |
|---|---|
| status 500, pilha, SQL, caminho do servidor na resposta | sempre (DM-SEC-07) |
| mensagem crua ou genérica que não diz o campo | o usuário não sabe o que corrigir |
| valor gravado diferente do digitado (cortado, aparado sem regra, `?` no lugar do emoji, outro dia) | sempre: compare tela, payload e banco |
| layout quebrado: estouro, rolagem horizontal da página, texto cobrindo vizinho | a tela ficou ilegível ou um controle sumiu |
| marcador de XSS em `window.__qaXss`, `alert` com o marcador, `54439` na saída | sempre, severidade `critico` em dado de outra pessoa |
| tela travada, laço de requisições, carregamento que não termina | sempre (LI-34) |
| front aceita e back recusa (ou o contrário) | divergência entre camadas: o achado é a divergência |

- **Um caso por campo e categoria** (`[MO-9-02] Nome · unicode: 18 valores`), com a lista em
  `notas/fuzz-<campo>.json` e a rede em `rede/`. Valor que passou não precisa de print próprio; o
  registro de rede é a prova. **Toda anomalia** ganha print `-ANTES` circulado, caso `falhou` e
  defeito com o id `FZ-…` e o valor exato (em `visivel`, com os invisíveis escapados).
- Todo registro criado ou alterado vai para `sujeira`, com o estado final.

### 9.6 Linhas de catálogo

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

---

## 10. Desempenho — `MO-10`

**Para quê:** transformar "está lento" em número com ambiente, achar a causa (chamada que não pagina,
N+1, consulta sem índice, bundle gordo, tarefa longa) e provar a correção com a mesma medição.

### 10.1 Sempre ligado: o passivo

Não precisa de ferramenta nova nem de autorização: o espião de rede já está instalado (fase 5).

- **Tempos:** `__qa.resumo()` traz o `ms` de cada chamada. Acima de 3 s, anote; acima de 10 s, é
  achado (DM-DES-01). Tempo até a **primeira linha** e até **completar**, separados.
- **Contagem e N+1 no cliente** — chamadas iguais variando só o id, na mesma carga de tela:

```js
Object.entries((__qa.rede || []).reduce((m, r) => {
  const k = r.metodo + ' ' + String(r.url).split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:id');
  (m[k] = m[k] || []).push(r.ms); return m;
}, {})).filter(([, v]) => v.length > 2).map(([k, v]) => `${k} x${v.length} (max ${Math.max(...v)} ms)`)
```

- **Tamanho e duração por recurso** (o `transferSize` vem 0 em recurso de outra origem sem
  `Timing-Allow-Origin`: não é "0 KB"):

```js
performance.getEntriesByType('resource').filter(r => /\/api\//.test(r.name))
  .map(r => ({ url: r.name.split('?')[0].slice(-70), ms: Math.round(r.duration),
    kb: Math.round(r.transferSize / 1024) })).sort((a, b) => b.ms - a.ms).slice(0, 15)
```

- **Vitais na tela real**, na sessão do usuário (instale ao abrir a tela; interaja; leia):

```js
(() => {
  const q = (window.__qa = window.__qa || {});
  if (q.vitais) return 'vitais ja instalado: ' + q.vitaisResumo();
  const v = (q.vitais = { lcp: null, cls: 0, inp: null, longas: [], tbt: 0 });
  const obs = (tipo, f, extra) => { try { new PerformanceObserver(l => l.getEntries().forEach(f))
    .observe(Object.assign({ type: tipo, buffered: true }, extra || {})); } catch (e) {} };
  obs('largest-contentful-paint', e => { v.lcp = Math.round(e.startTime); });
  obs('layout-shift', e => { if (!e.hadRecentInput) v.cls += e.value; });
  obs('event', e => { if (e.interactionId) v.inp = Math.max(v.inp || 0, Math.round(e.duration)); }, { durationThreshold: 16 });
  obs('longtask', e => { v.longas.push(Math.round(e.duration)); v.tbt += Math.max(0, e.duration - 50); });
  q.vitaisResumo = () => `LCP ${v.lcp ?? '-'} ms · CLS ${v.cls.toFixed(3)} · interacao mais lenta ${v.inp ?? '-'} ms` +
    ` · tarefas longas ${v.longas.length} (bloqueio ~${Math.round(v.tbt)} ms)`;
  return 'vitais instalado: interaja e chame __qa.vitaisResumo()';
})()
```

  Referência (Core Web Vitals, "bom"): LCP ≤ 2,5 s, CLS ≤ 0,1, INP ≤ 200 ms. A "interação mais lenta"
  do snippet é aproximação do INP; para o número oficial, Lighthouse ou o painel Performance.
  Tarefa longa (> 50 ms) durante a digitação é a causa da "digitação lenta" (DM-DES-04).
- **Travamento e memória:** navegue ida e volta 10× entre duas telas; `performance.memory.usedJSHeapSize`
  (só Chromium) que só cresce é vazamento provável. Registre o número e o navegador.
- **Sempre com o ambiente junto** (DM-DES-10): front local contra banco remoto infla tudo; modo de
  desenvolvimento dobra efeitos (StrictMode e equivalentes). Número de dev só vira defeito depois de
  confirmado no build.

### 10.2 Lighthouse (quando a ferramenta existe ou o usuário pede)

- **Build de produção, nunca o servidor de desenvolvimento** — o dev é sem minificação e com
  ferramentas extras; o número não diz nada.
- Página pública:

```bash
npx lighthouse http://localhost:3000/rota --preset=desktop --only-categories=performance,accessibility,best-practices \
  --output=json --output=html --output-path="$R/evidencias/NN-lighthouse-rota" --chrome-flags="--headless=new"
```

  (com duas saídas, ele grava `NN-lighthouse-rota.report.json` e `.report.html`). Rode **3 vezes** e
  use a mediana; uma rodada só é ruído.
- **Página autenticada:** o Lighthouse da linha de comando abre um navegador deslogado. Ou o usuário
  roda o painel Lighthouse do DevTools **na sessão dele** e salva o JSON, ou use o perfil do
  Playwright já logado aberto com porta de depuração (`--port=<porta>`) e **`--disable-storage-reset`**
  — sem essa opção o Lighthouse limpa o armazenamento da origem e derruba a sessão.
- Leia: LCP, TBT, CLS, "Reduce unused JavaScript", "Avoid enormous network payloads", "Serve images in
  modern formats". Cada oportunidade com ganho estimado alto vira caso.

### 10.3 Tamanho do bundle

| Stack | Como medir |
|---|---|
| Next.js | `next build` imprime "First Load JS" por rota; `@next/bundle-analyzer` se já configurado (`ANALYZE=true`) |
| Vite | `vite build` lista os chunks com tamanho e gzip; `rollup-plugin-visualizer` se configurado |
| webpack | `webpack --profile --json > stats.json` e `webpack-bundle-analyzer stats.json` |
| qualquer um com source map | `source-map-explorer 'dist/**/*.js'` |

- ⚠️ **`next build` reescreve a pasta `.next/` que o `next dev` está usando** — o servidor de
  desenvolvimento quebra no meio do teste. Avise, pare o dev server ou faça o build numa cópia. A
  mesma lógica vale para qualquer build que escreva na pasta que o dev usa.
- Orçamento: o do PERFIL. Sem orçamento combinado, anote rota acima de ~250 kB de JS gzip na primeira
  carga e diga que o número é sugestão, não regra.
- Procure: biblioteca duplicada (duas de ícones, duas de datas), import inteiro de lib grande,
  dicionário de **todos** os idiomas no bundle de uma rota, imagem embutida em base64, código só de
  desenvolvimento no build.

### 10.4 Servidor: consulta lenta e N+1

Ligue a causa ao número. Só leitura; mudar configuração de log em ambiente compartilhado é pedido
explícito, e volta ao estado anterior no fim (registre em `sujeira`).

| Stack | Onde ver as consultas |
|---|---|
| .NET / EF Core | categoria `Microsoft.EntityFrameworkCore.Database.Command` em Information (comando e ms); nunca ligue `EnableSensitiveDataLogging` em log compartilhado |
| Django | logger `django.db.backends` em DEBUG; `django-debug-toolbar` |
| Rails | `log/development.log` (SQL com ms); gem `bullet` acusa N+1 |
| Laravel | Debugbar ou Telescope; `DB::listen` |
| Node | Prisma `log: ['query']`, TypeORM `logging`, Sequelize `logging`, Knex `debug` |
| Java / Spring | `spring.jpa.show-sql`, `hibernate.generate_statistics` |
| Banco, só leitura | PostgreSQL `pg_stat_statements`; SQL Server Query Store / `sys.dm_exec_query_stats`; MySQL `performance_schema.events_statements_summary_by_digest` |

- **N+1 no servidor:** uma requisição de listagem com N consultas iguais variando só o id. Conte as
  consultas por requisição: o número precisa ser constante, não proporcional às linhas.
- **Plano da consulta lenta:**
  - PostgreSQL `EXPLAIN` e MySQL `EXPLAIN` **não executam**; `EXPLAIN ANALYZE` **executa**: só em
    `SELECT`, só fora de produção.
  - **Nunca** `EXPLAIN ANALYZE` em `INSERT`/`UPDATE`/`DELETE`: a escrita acontece.
  - SQL Server: `SET SHOWPLAN_XML ON` não executa; `SET STATISTICS IO, TIME ON` executa.
  - Procure varredura completa em tabela grande, índice faltando no filtro ou na junção, ordenação
    sem índice, `LIKE '%termo%'` em tabela grande.
- **Lista sem paginação no servidor** devolvendo milhares de registros (DM-DES-03) é causa comum de
  tela lenta: meça registros e KB da resposta.

### 10.5 Carga leve — só com autorização, nunca em produção

- Ferramentas: `k6`, `autocannon`, `hey`. **Só** com autorização registrada para aquela rodada,
  **só** em dev/teste, **nunca** contra serviço de terceiro (pagamento, e-mail, consulta de
  documento) — leia o que o endpoint chama antes.
- Teto pequeno e explícito: ex. 5 usuários virtuais por 30 s, parando no primeiro erro. Avise o time
  se o ambiente for compartilhado.
- Prefira endpoint de leitura. Endpoint de escrita sob carga cria N registros: todos vão para
  `sujeira`.
- Registre p50, p95, taxa de erro, o ambiente e a hora. Compare antes/depois só com os mesmos
  parâmetros.

### 10.6 Registrar e provar a correção

- Caso por tela ou endpoint: `[MO-10-01] /clientes · GET /api/cliente 12,4 s (local → banco remoto)`,
  com `--evidencia` do JSON de tempos e `--obtido` com o número **e o ambiente**.
- Severidade: lentidão que impede concluir (tempo limite, aba travada) é `alto`; acima de 10 s em
  fluxo P0, `medio`; o resto, `baixo` — salvo regra diferente no PERFIL.
- **Antes/depois com a mesma medição:** mesmo ambiente, mesma tela, mesmo dado, 3 repetições,
  mediana. E compare o **payload** campo a campo depois de otimizar consulta (LI-38): versão
  "enxuta" que deixa de carregar um campo usado lá embaixo zera um card sem erro nenhum.

### 10.7 Linhas de catálogo

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

## 11. Resumo dos códigos e dos comandos

| Módulo | Códigos | Script | Saída do script |
|---|---|---|---|
| 7 visual | `MO-7-01` a `MO-7-12` | `scripts/visual_diff.py BASE ATUAL [-o DIR] [--mascaras ARQ] [--ignorar-prefixo] [--lado-a-lado]` | 0 ok · 1 reprovou · 2 uso ou imagem inválida · 3 sem Pillow |
| 8 a11y | `MO-8-01` a `MO-8-12` | `scripts/axe-inject.js` (colar na ferramenta de JS) | texto do resumo; `__qa.a11y`, `__qa.a11yExportar()` |
| 9 fuzz | `MO-9-01` a `MO-9-14` | `scripts/fuzz_valores.py --tipo T [--limite-campo N] [--num-min A --num-max B] [--saida ARQ]` | 0 ok · 2 uso inválido |
| 10 desempenho | `MO-10-01` a `MO-10-13` | snippets da seção 10.1; `npx lighthouse`; relatório de build | — |

Lição nova de um módulo vai para a seção dele, com o próximo código livre, no formato do catálogo
§10 ("faça X → verifique Y", nunca renumerar, obsoleta marcada). Armadilha de método genérica vai
para `LI-*` no catálogo §9.
