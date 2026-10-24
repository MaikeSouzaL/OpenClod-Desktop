# Qualidade de código, organização e refatoração

> Leia em quatro momentos: na **fase 2** (estudar o projeto, §2), no **primeiro defeito** (corrigir
> na hora, §1), na **fase 4** (aplicar o checklist `QC-*`, §8) e na **fase 10** (seção "Qualidade de
> código" do relatório, §7.5).
>
> Responde: quando corrigir sem perguntar, como estudar um projeto que você nunca viu, como
> reconhecer código confuso com número e não com opinião, quando e como componentizar, e como
> refatorar sem mudar o que o sistema faz.

Relações: o protocolo detalhado de correção está em `references/correcao-e-relatorio.md` §2–§5 (este
arquivo resume e acrescenta); o inventário, em `references/perfil-e-inventario.md` §4; as linhas
`DM-CMP`, `DM-CNS` e `ES-*` do catálogo cobrem o efeito **comportamental** de cópias e constantes
duplicadas — aqui entra o lado **estrutural** (registrar, medir, propor, unificar). O formato do par
ANTES/DEPOIS e a entrega separada por bloco têm referências próprias na skill:
`references/provas-antes-depois.md` (com `scripts/provas.py`) e `references/entregas-por-branch.md`
(com `scripts/entregas.py`).

## Sumário

0. [Cola rápida](#0-cola-rápida)
1. [Corrigir na hora: o padrão do método](#1-corrigir-na-hora-o-padrão-do-método)
2. [Estudar o projeto antes de julgar](#2-estudar-o-projeto-antes-de-julgar)
3. [Código confuso: sinal, medição, proposta](#3-código-confuso-sinal-medição-proposta)
4. [Organização do projeto](#4-organização-do-projeto)
5. [Componentização](#5-componentização)
6. [Regras de segurança da refatoração](#6-regras-de-segurança-da-refatoração)
7. [Saídas: ledger, notas e relatório](#7-saídas-ledger-notas-e-relatório)
8. [Checklist QC](#8-checklist-qc)
9. [Armadilhas](#9-armadilhas)

---

## 0. Cola rápida

1. Pedido de teste/QA feito por esta skill **autoriza corrigir defeito claro na hora** e retestar.
   Pedido só de análise ("olha", "foca", "investiga") não altera nada. Decisão de produto, nunca.
2. Prova ANTES gravada **antes** de tocar no código; DEPOIS no mesmo enquadramento; reteste na tela
   real com par de controle, teste inverso e regressão de outro uso.
3. Estude antes de julgar: mapa de módulos, ida e volta do dado, onde mora cada regra, endpoints ×
   chamadores. Grave em `.qa/MAPA.md`.
4. Código confuso só vira achado com **medição** (N cópias, N linhas, N usos, N renders por tecla) e
   com o risco escrito. "Feio" não é achado.
5. Componentize por **intenção** repetida (3+ usos), não por aparência.
6. Refatoração não muda comportamento: caracterize antes, compare depois, tem que dar **IGUAL**.
7. Refatoração e correção de bug nunca no mesmo bloco.
8. Pequena e segura, no trecho que você já está corrigindo: aplique e registre. Grande
   (componentizar, reorganizar pastas, unificar cópias em vários arquivos): proponha com plano e
   custo, e aplique só com o ok (ou com `refatorar: sim` no PERFIL).
9. Componente compartilhado: só mudança aditiva. Gates ≤ baseline.
   `git diff --stat` == `git diff --ignore-cr-at-eol --stat`.
10. Tudo vai para o ledger (defeito `tipo melhoria`) e para a seção "Qualidade de código" do
    relatório.

---

## 1. Corrigir na hora: o padrão do método

Porquê: defeito corrigido no momento em que foi achado é retestado com a tela, o dado e o contexto
ainda frescos. Acumular para o fim produz correção às cegas e reteste que ninguém faz.

### 1.1 Quem autoriza

| O pedido | O que fazer |
|---|---|
| "testa", "faz QA", "E2E", "testa tudo", "valida a tela/o fluxo/o sistema", "retesta", "testa a branch X", "dei pull, testa" — atendido por esta skill | corrija o **defeito claro** (§1.2) assim que ele for verificado (fase 6), reteste e registre. Sem perguntar |
| "olha", "foca", "analisa", "investiga", "mede", "revisa/revisar PR ou branch", "audita/auditoria", "valida <artefato>" (JSON, arquivo, ideia), "o que precisamos fazer?" | diagnóstico e lista com `arquivo:linha`, causa e a mudança proposta. **Nenhum** arquivo alterado |
| "corrige", "ajusta", "aplica" | altere, inclusive o que não é "claro", se o pedido nomear aquilo |
| qualquer pedido | **decisão de produto nunca se altera**: vira pergunta fechada com print (`correcao-e-relatorio.md` §1.1) |

**Desempate:** verbo de leitura + pedido de teste = só relato, até o usuário dizer "corrige".
O MA-4 define o ESCOPO (o diff e o raio de impacto), não a autorização. Testar uma branch ou PR ("testa a branch X", "dei pull, testa") é pedido de QA: corrige o defeito claro. Revisar ou auditar uma branch ou PR ("revisa a PR", "audita") só relata, até o usuário dizer "corrige".

Mesmo num pedido de QA, a correção fica travada (vale o mais restritivo) quando:

- o PERFIL diz `corrigir_na_hora: nao`, ou uma regra do projeto ou da memória do usuário diz o mesmo;
- a camada é "só relato" (ex.: backend de outro time): a correção para no relato e você contém o
  estrago do seu lado, sem correção de fachada (`correcao-e-relatorio.md` §1.3);
- o workflow multiagente roda com `pode_alterar_codigo: false`;
- o arquivo já estava alterado no `git status` inicial (é de outra sessão): proponha;
- o ambiente é produção: nada se corrige "no ar".

Registre a autorização na rodada, com a frase do usuário:
`cobertura.py rodada <rodada> --autorizacao "pedido de QA: corrigir defeito claro na hora (<frase>, <data>)"`.

### 1.2 Defeito claro: os seis testes

Corrija na hora só se **todos** passarem. Se um falhar, proponha (`nao-corrigido`, justificativa
"proposta: …", `correcao` com `arquivo:linha` e o trecho).

1. **Oráculo forte:** regra escrita do usuário ou do time, especificação, o backend (o que ele aceita e
   recusa), o contrato do próprio componente, o comportamento anterior documentado, uma norma (HTTP,
   WCAG, convenções de locale) ou a linha do catálogo que define o comportamento esperado (catálogo
   §1.6). "Acho que deveria" não é oráculo.
2. **Reproduzido por dois caminhos**, com a ferramenta descartada (`execucao-e-evidencias.md` §6).
3. **Não foi de propósito:** `git log -S"<símbolo>"` e o histórico de decisões não mostram alguém
   escolhendo esse comportamento.
4. **Não escolhe regra de negócio:** a correção não decide limite, cálculo, texto de regra, quem pode,
   nem o que um botão deveria fazer.
5. **Causa localizada e alcance mapeado:** você conhece todos os leitores, cópias, constantes e
   caminhos (`correcao-e-relatorio.md` §2.4–§2.5).
6. **Cabe na rodada:** não exige migração de dado, mudança de contrato usado por terceiros, nem
   refatoração grande (essa é proposta, §6.8).

| É claro | Não é claro (proponha ou pergunte) |
|---|---|
| o payload envia o valor anterior ao que a tela mostra | "o mínimo deveria ser outro número" |
| data em ISO cru onde o resto da tela formata no idioma | "esse botão não deveria aparecer para esse papel", sem regra escrita |
| toast de sucesso para uma resposta 4xx | mensagem que expressa uma política |
| clique duplo grava duas vezes | dois oráculos que divergem entre si (a divergência é o achado) |
| chave de tradução faltando em um idioma | a correção muda o padrão de um componente usado em muitas telas |
| `x \|\| padrão` engolindo um 0 válido | a "correção" desfaz uma decisão que o histórico mostra |
| 5xx para recurso inexistente (o certo é 404, pela norma HTTP) | qual código de status o produto quer para uma regra de negócio recusada |
| campo obrigatório sem rótulo visível (WCAG) | o texto exato de um rótulo novo, quando o produto tem glossário |
| ação destrutiva sem confirmação (`EL-MOD-05`, `EL-BTN-08`) | qual ação conta como destrutiva, quando o catálogo e o projeto não dizem |

### 1.3 O ciclo curto

Nesta ordem. O detalhe de cada passo está em `correcao-e-relatorio.md` §3.

1. **Prove o ANTES antes de editar:** print cru e circulado em vermelho, `rede/NN-*.json` e a consulta
   no banco. Depois da edição, o ANTES não se recria.
2. **Ledger:** caso `falhou` e `add-defeito --antes … --caso C-NNNN` (status `aberto`).
3. **Causa raiz e alcance** escritos na nota: usos, cópias, constantes duplicadas, caminhos paralelos
   para o mesmo efeito, leitores do mesmo estado.
4. **Baseline** dos gates e o fim de linha de cada arquivo que vai tocar, se ainda não mediu nesta
   rodada.
5. **Corrija** com a menor mudança que cobre todo o alcance, seguindo as regras de código do projeto.
   Componente compartilhado: só aditivo.
6. **Verificação mecânica:** `--stat` igual ao `--ignore-cr-at-eol --stat`; typecheck, lint e testes
   ≤ baseline (queda brusca é sintaxe quebrada); leia o diff linha a linha.
7. **Reinício** de serviço: compile antes, agrupe, avise o usuário e espere; siga testando o resto
   enquanto isso.
8. **Reteste na tela real:** mesmo roteiro e mesmo papel; **par de controle** (o que não deveria
   mudar); **teste inverso** (tira a condição, o efeito some; devolve, volta); bordas dos dois lados;
   print `-CORRIGIDO` no mesmo enquadramento, circulado em verde no mesmo lugar.
9. **Regressão:** um uso real de cada compartilhado tocado, cada cópia corrigida exercitada e os casos
   do ledger cujos itens dependem dos arquivos alterados (§1.4).
10. **Ledger:** o caso original continua `falhou`; o reteste é caso novo
    `--tecnica regressao --defeito D-NNN`; o defeito vai de `corrigido` (`--depois`) a `retestado-ok`
    (`--reteste`).
11. **Restaure** o estado que o teste mudou; o que não volta vai para `sujeira`.
12. **Registre** nas 4 partes (ANTES · POR QUE · DEPOIS · STATUS, `templates/defeito.md`), na nota da
    fase e no changelog do projeto, se ele tiver essa regra.

### 1.4 Retestar falhas e funções

Uma correção abre superfície. Depois de cada uma:

- `cobertura.py listar <rodada> --status falhou`: algum outro caso falhou pela mesma causa ou passa
  pelos mesmos arquivos? Execute de novo como caso novo `regressao`. Uma causa costuma ter vários
  sintomas.
- `listar --status bloqueado` e `listar --status nao-validado`: a correção destravou algum? Execute.
- **Função alterada se testa direto, além da tela:** chame-a com uma tabela de entradas reais
  (colhidas da rede ou do banco), incluindo os limites e os valores "falsos" que são válidos (`0`,
  `""`, lista vazia, data no primeiro dia do mês). Se o projeto tem suíte de testes e a função é pura,
  o teste de regressão vai no mesmo bloco da correção, no padrão do repositório, quando o PERFIL
  permite; senão, ele é proposto.
- Duas correções da mesma rodada no mesmo arquivo: retest das duas, depois da segunda.

### 1.5 Quando a correção não fecha

Não empilhe tentativa sobre tentativa: volte à causa. Desfazer é desfazer por completo (o arquivo
volta ao original, conferido no `git diff`), com o patch guardado em `<rodada>/descartado/` e o motivo
na nota. Se o achado cair depois de corrigido, desfaça a mudança junto com a retratação.

### 1.6 O que exige aviso na hora

Avise e espere a confirmação **daquela** ação: reinício de serviço; mudança no padrão de um componente
compartilhado; correção cuja prova dispara efeito externo. O resto você faz e registra, e diz na
resposta o que alterou.

---

## 2. Estudar o projeto antes de julgar

Porquê: código que parece confuso às vezes é decisão — uma trava removida de propósito, um nome
mantido porque outro sistema o lê como texto. Quem julga sem o mapa propõe a refatoração que quebra um
contrato invisível.

### 2.1 Ordem de leitura

1. Regras do projeto (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING`) e o `.qa/PERFIL.md`.
2. Manifesto e configuração: dependências, scripts, aliases de caminho, flags de build (ex.: build que
   ignora erro de tipo, modo estrito desligado).
3. Pontos de entrada: roteador, controllers, comandos, jobs, consumidores de fila.
4. **Uma fatia vertical inteira** do alvo, da tela ao banco e de volta (§2.3).
5. As pastas compartilhadas: componentes, utilitários, serviços, stores e contextos. É ali que uma
   mudança tem alcance.
6. O histórico: `git log --oneline -30`, os arquivos que mais mudam e os maiores.

Os arquivos que mais mudaram nos últimos seis meses (funciona no bash e no PowerShell):

```bash
python -c "import collections,subprocess as s;o=s.run(['git','log','--since=6 months ago','--format=','--name-only'],capture_output=True,text=True).stdout.splitlines();c=collections.Counter(f for f in o if f);print('\n'.join(f'{n:5} {f}' for f,n in c.most_common(20)))"
```

Os maiores arquivos de código versionados (ajuste a lista de extensões):

```bash
python -c "import os,subprocess as s;fs=s.run(['git','ls-files'],capture_output=True,text=True).stdout.splitlines();r=sorted(((sum(1 for _ in open(f,encoding='utf-8',errors='replace')),f) for f in fs if os.path.isfile(f) and f.endswith(('.ts','.tsx','.js','.vue','.py','.cs','.java','.kt','.go','.rb','.php'))),reverse=True)[:20];print('\n'.join(f'{n:6} {f}' for n,f in r))"
```

Arquivo grande **e** muito alterado é onde os defeitos se concentram: é o primeiro candidato a
proposta de organização, e a primeira tela a receber regressão.

### 2.2 Mapa de módulos

Para cada módulo do alvo, uma linha: responsabilidade em uma frase · entradas (rota, endpoint,
comando) · arquivos principais · dependências (serviços, componentes, stores) · quem é dono do estado
· regras · efeitos.

| Tipo de projeto | Onde o mapa começa |
|---|---|
| Front SPA/SSR | pasta de rotas ou arquivo de rotas, configuração do menu, layout raiz, providers |
| Backend/API | registro de rotas e controllers, injeção de dependência, middlewares, policies |
| Mobile | pilha de navegação, telas, serviços nativos |
| CLI | parser de comandos e subcomandos |
| Biblioteca | exports públicos (o `index`, o `__init__`, a superfície documentada) |
| Jobs e filas | registro do agendador, consumidores, retries |

### 2.3 Ida e volta do dado

Siga um dado real do clique ao banco e de volta, anotando em cada salto o **nome do campo, o tipo, a
unidade e quem transforma**:

evento → handler → estado (local/global) → validação → montagem do payload → cliente HTTP
(interceptors) → rota → middleware/autorização → controller → serviço → repositório/ORM → banco
(constraints, triggers) → resposta (formato, status) → tratamento de erro → estado → render.

O que procurar no caminho:

- campo que muda de nome entre camadas, ou o **mesmo nome com sentidos diferentes** em módulos
  diferentes;
- valor lido de **dois contêineres** de estado (a tela lê um, o payload lê outro);
- a mesma transformação feita no front e no back (vão divergir);
- erro convertido em sucesso (`catch` que segue para o toast de sucesso);
- status HTTP com semântica errada (erro de validação devolvido como "não autenticado" faz o
  interceptor tratar como sessão expirada);
- resposta com a entidade inteira onde o front espera um id.

### 2.4 Onde mora cada regra

Toda `regra:` do ledger ganha uma linha:

| Regra | Front (`arquivo:linha`, valor) | Back (`arquivo:linha`, valor) | Banco (constraint) | Mensagem | Divergência |
|---|---|---|---|---|---|

- **Só no front:** o servidor aceita o que a tela esconde — achado de **segurança** (teste pela API
  direta; ver `references/modulos-avancados.md` §6, `MA-6-07`).
- **Só no back:** o usuário só descobre depois de enviar — achado de UX (`melhoria`).
- **Valores diferentes:** defeito. Qual está certo é oráculo: regra escrita > backend > front. Se
  ninguém escreveu a regra, é `decisao-de-produto`.
- **Em várias telas do front com valores próprios:** constante duplicada (`QC-07`).

### 2.5 Endpoints: inventário e estudo

Fontes, da mais confiável para a menos: OpenAPI/Swagger ou schema GraphQL do próprio projeto (leia,
com GET) > declaração de rota no código > chamadas do front > o que a rede mostrou.

Declarações de rota por stack (`git grep` funciona no bash e no PowerShell; para incluir arquivos
ainda não versionados, ponha `--untracked` **antes** do padrão):

| Stack | Comando |
|---|---|
| Express, Fastify, Koa | `git grep -nE '\.(get\|post\|put\|patch\|delete\|all)\(\s*.?/' -- '*.js' '*.ts'` |
| NestJS | `git grep -nE '@(Controller\|Get\|Post\|Put\|Patch\|Delete)\(' -- '*.ts'` |
| Next.js (App Router) | arquivos `route.ts`/`route.js` em `app/`; `git grep -nE 'export (async )?function (GET\|POST\|PUT\|PATCH\|DELETE)\b' -- '*route.ts' '*route.js'` |
| ASP.NET | `git grep -nE '\[(Http(Get\|Post\|Put\|Patch\|Delete)\|Route)\b' -- '*.cs'` |
| Spring (Java/Kotlin) | `git grep -nE '@(Get\|Post\|Put\|Patch\|Delete\|Request)Mapping' -- '*.java' '*.kt'` |
| FastAPI, Flask | `git grep -nE '@(app\|router\|bp\|blueprint\|api)\.(get\|post\|put\|patch\|delete\|route)\(' -- '*.py'` |
| Django | `git grep -nE '\b(re_)?path\(' -- '*urls.py'` |
| Rails | `config/routes.rb` (`resources`, `get`, `post`); `bin/rails routes` é só leitura |
| Laravel | `git grep -nE 'Route::(get\|post\|put\|patch\|delete\|resource\|apiResource)\(' -- 'routes/*.php'` |
| Go (net/http, gin, echo, chi) | `git grep -nE '\.(GET\|POST\|PUT\|PATCH\|DELETE\|HandleFunc\|Handle)\(' -- '*.go'` |

Na tabela, `\|` é só o escape do Markdown: no terminal, digite `|`.

Quem chama, no front: `git grep -nE '\b(fetch|axios(\.(get|post|put|patch|delete))?|api\.(get|post|put|patch|delete))\(' -- '*.ts' '*.tsx' '*.js'`,
mais as constantes de base de cada módulo de serviço (ex.: `const API_SERVICE = '...'`).

Para cada endpoint do alvo, registre no mapa: método e rota normalizada (`{id}`) · autorização
(atributo, policy, middleware — ou "só autenticado") · entrada e validação · o que grava e onde ·
efeitos (e-mail, fila, integração) · resposta e códigos de erro · paginação e volume · quem chama
(`arquivo:linha`) · o item `api:` do ledger.

O cruzamento é onde estão os achados:

| Cruzamento | O que é |
|---|---|
| endpoint no código sem chamador | teste pela API direta: porta sem tela (P0 de segurança) ou código morto |
| chamada no front sem endpoint | defeito (404) ou rota montada em tempo de execução: confirme na rede |
| ação que o front esconde e endpoint só com "autenticado" | autorização só no front: achado de segurança |
| o mesmo efeito por dois endpoints (ou botão e combo) | guard num caminho, o outro aberto |
| endpoint que devolve a entidade do ORM inteira | campos a mais vazando; front extraindo o id errado |
| erro de validação com status de autenticação | interceptor derruba a sessão |

Estudo é leitura: código e GET. Endpoint que grava só se exercita pela aplicação ou conforme as regras
do PERFIL.

### 2.6 O `.qa/MAPA.md`

Persiste entre rodadas, como o PERFIL: mesma política (sem segredo, número com data de `date`,
revalidado no início de cada rodada). A nota de entendimento da rodada cita o mapa e o que mudou nele.

```markdown
# MAPA — <projeto>
- Atualizado em: <saída de date> · commit: <hash curto>

## Módulos
| Módulo | Responsabilidade | Entradas | Arquivos principais | Depende de | Dono do estado | Efeitos |
|---|---|---|---|---|---|---|

## Ida e volta do dado (um fluxo por linha)
| Fluxo | Saltos (campo → campo) | Transformações | Sinais (§2.3) |
|---|---|---|---|

## Regras
| Regra | Front | Back | Banco | Mensagem | Divergência |
|---|---|---|---|---|---|

## Endpoints
| Método e rota | Autorização | Grava | Efeitos | Chamado por | Item no ledger |
|---|---|---|---|---|---|
Contagem: <N no código> · <N chamados> · <N sem chamador> · <N chamados sem rota>

## Compartilhados (alcance)
| Componente/util | Usos (N) | Grupos de configuração | Uso real para regressão |
|---|---|---|---|

## Pontos quentes
| Arquivo | Linhas | Alterações em 6 meses | Observação |
|---|---|---|---|
```

### 2.7 Ferramentas

- Use o que o projeto **já tem**: scripts do manifesto, analisadores e linters configurados.
- Ferramenta externa não instalada (detector de duplicação, de código morto, de ciclo) baixa código:
  pergunte uma vez, na pergunta única da fase 1, ou use o recurso de biblioteca padrão abaixo.
- Nunca acrescente dependência ao projeto para analisá-lo.

Detector de trechos repetidos, só biblioteca padrão. Salve como `.qa/ferramentas/duplicados.py` e
rode `python .qa/ferramentas/duplicados.py <pasta> [linhas]` (padrão: 6 linhas):

```python
import collections, hashlib, os, re, sys
raiz = sys.argv[1] if len(sys.argv) > 1 else "."
N = int(sys.argv[2]) if len(sys.argv) > 2 else 6
EXT = (".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".cs", ".cshtml", ".razor", ".java",
       ".kt", ".go", ".rb", ".php", ".swift", ".dart", ".html")
IGNORAR = {"node_modules", ".git", ".qa", ".next", "dist", "build", "bin", "obj", "vendor",
           "coverage", "__pycache__", ".venv", "venv", "target"}
JANELAS = collections.defaultdict(list)
for pasta, subpastas, arquivos in os.walk(raiz):
    subpastas[:] = [d for d in subpastas if d not in IGNORAR]
    for nome in arquivos:
        if not nome.endswith(EXT):
            continue
        caminho = os.path.join(pasta, nome)
        with open(caminho, encoding="utf-8", errors="replace") as f:
            linhas = [(i + 1, re.sub(r"\s+", " ", t.strip())) for i, t in enumerate(f)]
        linhas = [(i, t) for i, t in linhas if len(t) > 3 and not t.startswith(
            ("import ", "from ", "using ", "//", "#", "/*", "*", "<!--"))]
        for k in range(len(linhas) - N + 1):
            chave = hashlib.sha1("\n".join(t for _, t in linhas[k:k + N]).encode()).hexdigest()
            JANELAS[chave].append((os.path.relpath(caminho, raiz).replace(os.sep, "/"), linhas[k][0]))
PARES = collections.Counter()
PRIMEIRO = {}
for ocorrencias in JANELAS.values():
    for a in range(len(ocorrencias)):
        for b in range(a + 1, len(ocorrencias)):
            par = tuple(sorted((ocorrencias[a], ocorrencias[b])))
            chave = (par[0][0], par[1][0])
            PARES[chave] += 1
            PRIMEIRO.setdefault(chave, par)
for (arq_a, arq_b), qtd in PARES.most_common(40):
    (_, la), (_, lb) = PRIMEIRO[(arq_a, arq_b)]
    print(f"{qtd:5} janelas de {N} linhas  {arq_a}:{la}  <->  {arq_b}:{lb}")
print(f"{len(PARES)} par(es) de arquivos com trecho repetido", file=sys.stderr)
```

A saída lista pares de arquivos (ou o mesmo arquivo duas vezes) com a quantidade de janelas iguais e a
primeira linha de cada lado. Abra os dois trechos antes de chamar de cópia: código gerado e boilerplate
do framework também se repetem. Salve a saída em `evidencias/NN-qc-duplicados.txt`.

---

## 3. Código confuso: sinal, medição, proposta

Só vira achado com a **medição** e o **risco** escritos. Cada linha abaixo tem o código `QC-*` do §8.

| Sinal | Como medir | Por que importa | Proposta típica |
|---|---|---|---|
| Função ou componente gigante (`QC-04`) | linhas; quantas responsabilidades (busca, validação, regra, render, efeito) | mudança numa responsabilidade quebra outra; teste impossível de isolar | separar por responsabilidade: hook/serviço de dados, função de regra, componente de apresentação |
| Condicional aninhada, ou a mesma condição repetida (`QC-05`) | níveis de aninhamento; grep da expressão | a condição de "mostrar", "validar" e "enviar" diverge, e a tela promete o que o envio não cumpre | uma função nomeada para a condição, usada nos três lugares |
| Nome que mente (`QC-06`) | ler o que a função ou campo faz × o nome; achar a regra que relaciona dois campos | quem padroniza pelo nome inverte o sentido | renomear só o que é interno; o que é lido por texto ganha rótulo ao lado (§6.7) |
| Número ou texto mágico de regra (`QC-07`) | grep do valor e dos nomes de constante | duas constantes da mesma regra mantêm o valor errado nos dois lugares | uma constante, num lugar só, de preferência vinda do servidor |
| Lógica de negócio copiada (`QC-08`) | detector de duplicados (§2.7) + grep de um trecho característico | a correção chega a uma cópia; as outras seguem erradas, sem aviso | util ou componente único; migração uso a uso (§5.5) |
| Estado em dois contêineres (`QC-09`) | de onde a tela lê × de onde o payload e a validação leem | a tela mostra um valor e o envio manda outro | uma fonte de verdade; o resto deriva dela |
| Efeitos encadeados (`QC-10`) | renders ou commits por tecla; aviso de atualização aninhada no console | estoura depois de dezenas de teclas, só em quem digita rápido | derivar em vez de sincronizar; mover a propagação para o evento |
| Comentário ou documento que contradiz o código (`QC-11`) | o que o comentário afirma × os leitores reais (grep do campo) | a "otimização" justificada pelo comentário apaga dado em silêncio | corrigir o comentário ou o código (se a regra do projeto proíbe comentário, o porquê vai para o commit) |
| Código morto (`QC-12`) | grep de usos; exports sem importador; rota copiada de outra tela; bloco comentado; flag sempre falsa | confunde quem lê; a tela copiada mostra dado de outra entidade | remover num passo próprio, com grep provando zero usos; exclua a superfície pública (package.json `exports`/`main`/`bin`/`types`, `__init__`/`__all__`, entry points do `pyproject`/`setup.cfg`, `index.d.ts`, handlers serverless e exports por convenção do framework): remover isso é breaking change → proposta major, nunca melhoria baixa |
| Heurística por texto exibido (`QC-13`) | grep de comparações com rótulo, mensagem ou nome | quebra com acento, idioma ou um cadastro novo | decidir pelo tipo ou código que a origem já tem |
| Infraestrutura duplicada (`QC-17`) | contar usos de cada cliente HTTP, formatador, biblioteca de ícone ou tabela | a instância legada não tem os interceptors ou as regras novas | eleger a oficial (pelas regras do projeto) e migrar os usos |

Antes de registrar, procure a decisão: `git log -S"<trecho>"`. O código confuso que o histórico
explica vira linha no mapa, não achado.

Código confuso que **causou** um defeito gera dois registros (§7.3): o defeito (corrigido agora, em
todas as cópias) e a melhoria estrutural (proposta).

---

## 4. Organização do projeto

- **Estrutura de pastas:** compare com a convenção do framework e com o padrão majoritário do próprio
  repositório (conte). Fora do padrão só é achado quando confunde: componente de uma tela só na pasta
  compartilhada, utilitário compartilhado dentro da pasta de uma tela, tela inteira copiada de outra.
- **Camadas:** escreva as camadas que o projeto declara (ex.: tela → serviço → cliente HTTP; controller
  → serviço → repositório). Violação: tela chamando HTTP cru quando há camada de serviço; regra de
  negócio decidida só na UI; controller com SQL; utilitário compartilhado importando uma tela.
- **Dependência circular:** use o analisador do ecossistema se já estiver instalado (grafo de imports
  em JS/TS, Python ou Java; o compilador barra ciclo de pacote em Go e de projeto em .NET, mas não de
  namespace). Sem ferramenta: grep de imports entre duas pastas, nos dois sentidos.
- **Arquivo no lugar errado:** pelo critério do próprio repositório, nunca pelo seu gosto.
- **Infraestrutura duplicada** (`QC-17`): qual é a oficial está nas regras do projeto ou no PERFIL;
  conte os usos de cada uma.
- **Arquivo gigante que concentra várias telas ou abas** (`QC-18`): proponha a divisão por aba ou por
  responsabilidade.

Mover arquivo ou pasta é **sempre proposta**, com plano: imports e aliases a atualizar, `git mv` para
o diff mostrar renomeação, e o conflito com toda branch aberta do time que mexe naqueles arquivos —
esse custo costuma ser maior que o benefício. Aplique só com o ok explícito para aquele plano.

---

## 5. Componentização

### 5.1 Onde se aplica

| Framework | Unidade de reuso |
|---|---|
| React, Preact, Solid | componente; hook para lógica com estado; função pura para formatação e regra |
| Vue | SFC; composable; diretiva |
| Angular | componente; pipe; diretiva; serviço |
| Svelte | componente; action; store |
| Blazor, Razor Pages, MVC | componente Razor; partial view; tag helper; view component |
| Flutter | widget; extension |
| SwiftUI | View; ViewModifier |
| Jetpack Compose | função `@Composable`; modifier |
| Templates de servidor (Jinja, Django, Blade, Thymeleaf, ERB, Handlebars, Twig) | macro, include, partial, fragment, componente |
| Sem camada de UI (CLI, biblioteca, backend) | função, módulo, serviço — com os mesmos critérios |

### 5.2 Candidatos, em ordem de retorno

1. **Função pura duplicada** (formatar valor, calcular, mapear código → rótulo): vira util. É a mais
   barata, testável por tabela de entradas, e elimina a "correção pela metade".
2. **Regra de negócio duplicada** (o mesmo limite ou condição em várias telas): constante ou função
   única — e a regra também no servidor.
3. **Bloco de UI com a mesma intenção** em 3+ telas: aviso, cabeçalho de seção, selo de status,
   tabela de itens, estado vazio.
4. **Padrão de formulário** feito à mão em cada tela: validação, botão "Salvando…" travado durante a
   requisição, destaque do campo que barrou, erro do servidor no campo.
5. **Tabela ou listagem** com as mesmas colunas, máscaras e ações.

### 5.3 Critérios para extrair (todos)

- **3+ usos reais** (regra de três). Com dois, anote e espere o terceiro — salvo se os dois já
  divergiram e causaram defeito.
- **Mesma intenção**, não só mesma aparência: fazem a mesma coisa pelo mesmo motivo. Iguais na forma e
  diferentes no propósito vão divergir.
- As diferenças entre os usos cabem em **poucas props** (3 ou 4), com nomes do domínio. Se for preciso
  um booleano que muda o comportamento, são componentes diferentes ou composição.
- **Estável:** ninguém está mudando esses usos agora em branch aberta (pergunte).
- **Testável:** cada uso tem caso no ledger que vai provar a migração.
- Cópias que divergem em **regra de negócio** não se juntam pela UI: primeiro a regra é decidida
  (`decisao-de-produto`), depois a regra é extraída.

### 5.4 A API do componente

- Nome do domínio, não da aparência (`AvisoDeBloqueio`, não `CaixaAmarela`).
- Props mínimas; o padrão reproduz o uso mais comum; sem a prop, nada muda.
- Composição (children, slots, render props) no lugar de flags booleanas.
- Controlado quando o pai precisa do valor; o mesmo estado nunca em dois lugares.
- Textos pelo dicionário do projeto, em todos os idiomas; aceita rótulo pronto do chamador.
- Repassa `data-testid` (ou o id de acessibilidade da plataforma), `aria-*` e a classe ou estilo do
  projeto.
- Acessível por construção: controle é elemento nativo de controle, com foco visível e teclado.
- Componente de apresentação não chama API, salvo quando esse é o padrão do projeto.
- Tipos explícitos, sem `any` novo; função pura trata `null`, `0` e `""`.

### 5.5 Migração incremental

1. **Caracterize todos os usos** (§6.1) — o ANTES.
2. Crie o componente ou util **sem mudar uso nenhum**: um passo só de adição.
3. Migre **um** uso; caracterize o DEPOIS; tem que dar IGUAL; reteste na tela real.
4. Repita uso a uso. Cada uso migrado é um passo reversível (pode ser um bloco de entrega por uso).
5. O código antigo sai só quando o último uso migrar, num passo próprio, com grep provando zero usos.
6. Um uso deu DIFERENTE: pare. Ou ele tinha comportamento próprio (vira prop, ou fica fora da
   migração), ou o componente está errado. Nunca "ajuste" o comportamento no caminho.

---

## 6. Regras de segurança da refatoração

### 6.1 Sem mudar comportamento: caracterização antes e depois

| Camada | ANTES (capture) | DEPOIS (compare) |
|---|---|---|
| UI | print no mesmo viewport e estado; `innerText` da região; payloads das mesmas ações (`__qa.exportar`); contagem de erros no console | prints iguais (comparação visual com `scripts/visual_diff.py`, `references/modulos-opcionais.md` §7, quando houver); textos iguais; JSON dos payloads igual, ignorando campos voláteis |
| API | respostas de GET para um conjunto fixo de ids, só leitura | JSON igual, ignorando datas e ids gerados |
| Função | tabela de entradas reais → saídas, em JSON | a mesma tabela, a mesma saída |
| CLI | stdout, stderr e código de saída de cada comando | iguais |

- **Projeto com infraestrutura de snapshot ou approval:** use a dele (snapshot do Jest/Vitest,
  `toHaveScreenshot` do Playwright, syrupy ou approvaltests no Python, Verify no .NET, ApprovalTests no
  Java, arquivos golden no Go, insta no Rust, golden tests no Flutter, snapshot-testing no Swift).
- **Sem infraestrutura:** caracterização avulsa em `<rodada>/caracterizacao/ANTES/` e `DEPOIS/`, fora
  do código do projeto, comparada com:

```python
import json, sys
ignorar = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else set()
def limpar(x):
    if isinstance(x, dict):
        return {k: limpar(v) for k, v in x.items() if k not in ignorar}
    if isinstance(x, list):
        return [limpar(v) for v in x]
    return x
antes, depois = (limpar(json.load(open(p, encoding="utf-8"))) for p in sys.argv[1:3])
if antes == depois:
    print("IGUAL")
    sys.exit(0)
print("DIFERENTE")
for chave in sorted(set(antes) | set(depois)) if isinstance(antes, dict) and isinstance(depois, dict) else []:
    if antes.get(chave) != depois.get(chave):
        print(f"  {chave}: {json.dumps(antes.get(chave), ensure_ascii=False)[:80]} -> {json.dumps(depois.get(chave), ensure_ascii=False)[:80]}")
sys.exit(1)
```

Salve como `.qa/ferramentas/comparar.py` e rode
`python .qa/ferramentas/comparar.py ANTES/x.json DEPOIS/x.json dataCriacao,id` (saída 0 = IGUAL,
1 = DIFERENTE). Guarde a saída em `evidencias/NN-caracterizacao-<assunto>.txt`.

- **Capture o ANTES antes da primeira edição.** Caracterização tirada depois de começar não prova nada.
- **Prove que a comparação enxerga:** mude um valor de propósito uma vez e confira que sai
  DIFERENTE. Comparação que nunca falha é medição quebrada.

### 6.2 Separada da correção de bug

- Bloco de entrega e commit próprios, no estilo do repositório (ex.: prefixo `refactor:`).
- Ordem: corrija o defeito primeiro (menor mudança, reteste) e só depois refatore, caracterizando a
  partir do comportamento já corrigido. Nunca os dois no mesmo passo.
- Achou bug no meio da refatoração: pare, registre, corrija num bloco próprio.
- DEPOIS ≠ ANTES e o novo parece "melhor": não é refatoração, é mudança de comportamento. Trate como
  correção (se há oráculo) ou como `decisao-de-produto`.
- Por que separar: bloco misto é revertido inteiro. Se a refatoração for recusada, leva a correção
  junto.

### 6.3 Pequena e reversível

Uma intenção por passo; cada passo deixa o build verde; o patch de cada passo guardado; prefira muitos
passos pequenos. Nada de "já que estou aqui".

### 6.4 Convenções do projeto

As mesmas da correção: comentários só se o projeto permitir (o porquê vai na mensagem de commit e no
relatório); textos pelo dicionário em todos os idiomas e nos tipos; design system; idioma dos nomes no
código; a biblioteca de ícone do arquivo vizinho; o padrão de serviço e de erro. Não reformate o
arquivo inteiro (formatação em massa esconde a mudança no diff) e não toque em arquivo de outra sessão.

### 6.5 Componente compartilhado: só aditivo

Prop nova opcional com padrão que preserva o comportamento; util novo ao lado do antigo; nunca mudar
padrão ou assinatura no mesmo passo. Mudar o padrão é mudar o comportamento de todos os usos: vira
proposta, com regressão em um uso real de cada grupo de configuração.

### 6.6 Gates

Typecheck, lint, testes e build ≤ baseline e zero erro novo nos arquivos tocados; `--stat` igual ao
`--ignore-cr-at-eol --stat`; o diff só tem o que é seu; arquivo movido aparece como renomeação no diff,
não como apagado + criado.

### 6.7 O que não se renomeia sem grep nos dois lados

O que é lido como **texto** em outro lugar: nome de permissão, chave de tradução, rota e URL (links
em e-mails já enviados, favoritos), campo de API (front, back, integrações, exportações), coluna e
tabela do banco, nome de evento, flag, parâmetro de query, chave de storage do navegador,
`data-testid` usado por testes e roteiros de replay. Grep no front **e** no back antes. Se o nome
mente mas é contrato: acrescente um rótulo ou alias ao lado; não renomeie.

### 6.8 Aplicar ou propor

O PERFIL pode declarar, na seção de autorizações: `corrigir_na_hora: sim|nao` (padrão `sim` em pedido
de QA) e `refatorar: nao|pequena|sim` (padrão `pequena`).

| Mudança | `refatorar` | O que fazer |
|---|---|---|
| Pequena e segura no trecho que você já está corrigindo | `pequena` ou `sim` | aplique em passo separado da correção, caracterize, registre |
| Extrair util ou componente compartilhado; unificar cópias em vários arquivos | `sim` | aplique com o plano (§6.9) registrado e a migração incremental (§5.5) |
| o mesmo | `pequena` ou ausente | proponha com plano e custo; espere o ok |
| Reorganizar pastas, mover arquivos, quebrar arquivo gigante, trocar biblioteca | qualquer | proponha; aplique só com ok explícito para aquele plano |
| Qualquer refatoração | `nao` | só proponha |
| Qualquer refatoração, em pedido só de análise | qualquer | só proponha |

**Pequena e segura** é tudo isto junto: num arquivo que você já está alterando por uma correção; até
~30 linhas; nada exportado ou usado em outro arquivo muda; comportamento caracterizado e IGUAL; gates
em ordem. Exemplos: renomear variável local que mente, extrair constante local, remover o código que a
própria correção deixou morto, unificar uma duplicação dentro do mesmo arquivo. Falhou um critério:
proponha.

### 6.9 Plano de proposta

Toda proposta de refatoração vai ao ledger e ao relatório neste formato. Sem custo e sem prova, ela não
entra.

```text
Proposta R-<n> — <título curto>
Problema medido: <N cópias / N linhas / N usos, com arquivo:linha> (evidencias/NN-qc-....txt)
Risco hoje: <o defeito que já causou ou vai causar; C-NNNN / D-NNN>
Mudança: <util, componente ou estrutura, e a API proposta>
Passos: 1) criar sem usar; 2) migrar <uso 1>; ...; n) remover o antigo
Custo: <arquivos, linhas, telas a retestar, reinícios, branches abertas em conflito>
Prova: <caracterização de cada uso, reteste na tela real, gates>
Não muda: <comportamento, contratos, nomes lidos como texto>
Quem decide: <usuário / time> · Se não fizer: <o que continua acontecendo>
```

---

## 7. Saídas: ledger, notas e relatório

### 7.1 Itens e casos

| Id | Quando |
|---|---|
| `modulo:<pasta>` | cada módulo do alvo que entrou no mapa |
| `funcao:<arquivo>#<nome>` | função alterada, duplicada ou candidata a util |
| `componente:<Nome>` | compartilhado tocado ou candidato a componente |
| `regra:<entidade>.<regra>` | regra duplicada ou divergente entre camadas |
| `api:<MÉTODO> <rota>` | cada endpoint do estudo (§2.5) |

- Cada linha `QC-*` que se aplica ao alvo vira caso com `--titulo "[QC-NN] …"`, `--tecnica estatico`
  (ou `regressao` na caracterização depois de refatorar) e `--oraculo` (regra do projeto, convenção do
  repositório, comportamento anterior).
- Evidência: `evidencias/NN-qc-<assunto>.txt`, com o comando na primeira linha e a saída abaixo.
- Medição limpa ("0 cópias") é `passou` com essa evidência. Linha que não se aplica é `nao-aplicavel`
  agrupado, com o motivo.

```bash
python "$QA/scripts/cobertura.py" add-item "$R" --id "modulo:src/app/clientes" --titulo "Módulo de clientes" \
  --origem ".qa/MAPA.md"
python "$QA/scripts/cobertura.py" add-caso "$R" --item "modulo:src/app/clientes" --tecnica estatico \
  --titulo "[QC-08] Formatação de campo copiada entre telas" --esperado "uma implementação usada por todas" \
  --oraculo "regra do projeto: reutilizar util e componente"                     # imprime C-NNNN
python "$QA/scripts/cobertura.py" add-defeito "$R" --tipo melhoria --severidade alto \
  --titulo "Formatação copiada em 4 telas; a correção chegou a 1" \
  --onde "src/a.tsx:228; src/b.tsx:142; src/c.tsx:265; src/d.tsx:140" --causa "função copiada e colada" \
  --correcao "proposta R-1: extrair util; migrar uma tela por vez" --status nao-corrigido \
  --justificativa "proposta: 4 telas a migrar; depende do ok do usuário (refatorar: pequena)" \
  --antes evidencias/12-qc-duplicados.txt --caso C-NNNN                          # imprime D-NNN
python "$QA/scripts/cobertura.py" set "$R" C-NNNN --status falhou --defeito D-NNN \
  --evidencia evidencias/12-qc-duplicados.txt --obtido "4 cópias; 1 corrigida"
```

Melhoria **aplicada**: `set D-NNN --status corrigido --depois evidencias/NN-caracterizacao-IGUAL.txt`,
caso novo `--tecnica regressao --status passou --evidencia … --defeito D-NNN` e
`set D-NNN --status retestado-ok --reteste …`. Sempre passe `--antes` no `add-defeito`: sem ele o
`validar` avisa que falta a evidência do problema.

### 7.2 Defeito tipo `melhoria`

| Campo | Conteúdo |
|---|---|
| `titulo` | o sinal medido: "Formatação copiada em 4 telas; a correção chegou a 1" |
| `severidade` | **alto:** já causou ou causa agora um defeito (correção pela metade, tela × payload divergindo) · **medio:** risco concreto de manutenção (3+ cópias de regra, ciclo, estado duplicado sem defeito observado) · **baixo:** legibilidade (nome local, número mágico local, código morto inofensivo) |
| `onde` | todos os locais, `arquivo:linha` separados por `;` |
| `causa` | por que existe (cópia, regra sem dono, herança de outra tela) |
| `correcao` | "proposta R-n: …" ou o que foi feito |
| `status` | proposta: `nao-corrigido` com justificativa "proposta: depende de …"; aplicada: `corrigido` → `retestado-ok` |
| `antes` / `depois` | evidência da medição; caracterização IGUAL e o print do reteste |

### 7.3 Defeito com causa estrutural

Dois registros, ligados pela `causa`:

- `D-a`, **tipo `defeito`**: o sintoma, corrigido agora (§1), **em todas as cópias** — corrigir todas
  é alcance da correção, não refatoração.
- `D-b`, **tipo `melhoria`**: a estrutura que permitiu o defeito (as cópias), com a proposta de
  unificar.

Assim, a correção sobe sozinha e a refatoração é decidida à parte.

### 7.4 Notas

- **Mapa:** `.qa/MAPA.md`, com o resumo e o que mudou na nota de entendimento e inventário da rodada.
- **Achados `QC-*`:** `notas/NN-qualidade-de-codigo.md` (de `templates/nota-de-fase.md`), com os
  comandos, os números e as propostas `R-n`.
- **Refatoração aplicada:** na nota de correção, em subseção "Refatoração" própria, com a
  caracterização ANTES/DEPOIS.

### 7.5 Seção "Qualidade de código" do relatório

Nunca apagada; vazia, leva "Nenhum" e o porquê.

1. **Mapa resumido:** módulos estudados; endpoints (no código × chamados × sem chamador × chamados sem
   rota); regras e onde moram; divergências entre camadas.
2. **Achados `QC-*` por severidade:** sinal, medição, `arquivo:linha`, risco.
3. **Refatorações aplicadas:** o que mudou, a prova de igualdade (caracterização IGUAL, prints
   idênticos), os gates e o bloco de entrega próprio.
4. **Propostas `R-n`:** plano, custo, quem decide.
5. **Candidatos a componente:** usos × diferenças × API proposta.
6. **O que não foi analisado e por quê** (ex.: backend fora do escopo, repositório sem acesso).

### 7.6 ANTES/DEPOIS de refatoração

No PDF, o item de refatoração segue as mesmas 4 partes, com outra prova: no ANTES, o trecho de código e
a medição (N cópias) **e** a tela; no DEPOIS, o código novo e a **mesma** tela. O par de telas tem que
ser idêntico — é essa igualdade que prova a refatoração — e a legenda diz "comportamento igual". Item de
correção mantém o par vermelho/verde de sempre.

---

## 8. Checklist QC

Formato do catálogo: cada linha diz o que fazer e como verificar. As que têm "Porque" nasceram de
defeito real.

As linhas `QC-*` estão registradas no catálogo (`references/catalogo-de-testes.md` §8.1), que é a
fonte do próximo código livre: linha nova entra pelo `scripts/aprender.py` (`--secao QC`).

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
- **QC-12** Liste código morto: export sem importador, tela copiada de outra que mostra dado alheio, bloco comentado, flag sempre falsa. Verifique: zero usos por grep, inclusive por texto, reflexão e rota baseada em arquivo.
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

## 9. Armadilhas

- **Corrigir uma cópia e deixar as outras.** A mesma função de formatação vivia em quatro telas; a
  correção chegou a uma, e a data crua continuou nas outras três, sem erro nenhum. O alcance (grep por
  trecho característico) vem antes da edição.
- **Duas constantes para a mesma regra.** O valor errado sobreviveu nos dois lugares porque cada um
  parecia confirmar o outro.
- **Comentário que mente justifica otimização que apaga dado.** Confronte o comentário com os leitores
  reais antes de confiar nele — e antes de propor refatoração em cima dele.
- **Construtor que reescreve o objeto com uma lista fixa de campos** descarta a prop nova em silêncio:
  ao estender um componente, confira o objeto final (catálogo `DM-CMP-02`).
- **Bloco misto é revertido inteiro.** Refatoração, correção e mudança de fim de linha no mesmo bloco
  fizeram uma PR ser revertida e levar junto uma correção que ninguém contestava.
- **Renomear contrato.** Nome lido como texto por outro repositório, e-mail ou suíte de testes quebra
  sem erro de compilação.
- **Caracterizar depois de começar.** O ANTES tirado com metade da mudança aplicada só prova que a
  mudança é igual a ela mesma.
- **Validar componente na vitrine.** Vitrine prova que monta, não que a integração funciona
  (catálogo `LI-71`).
- **Mover arquivo em repositório com muitas branches abertas.** Cada branch do time vira conflito: o
  custo real está fora do seu diff.
- **Chamar de refatoração o que muda comportamento.** Trocar uma função inline por memorizada, que
  reduz dezenas de requisições a uma, é correção de defeito (o número de requisições é comportamento):
  registre como defeito, com o ANTES e o DEPOIS medidos.
- **Refazer uma decisão do time.** Antes de propor trocar uma função de permissão, um nome ou uma
  trava, procure no histórico se isso já foi trocado e revertido; proponha o caminho que respeita a
  decisão.
- **Ferramenta de análise contando pastas temporárias** dentro do repositório (catálogo `LI-70`): limpe
  e meça de novo antes de concluir.
