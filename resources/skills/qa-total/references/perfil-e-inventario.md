# Perfil e inventário — como começar em qualquer projeto

> Primeira fase da skill: descobrir o projeto, proteger o ambiente, escrever o PERFIL, enumerar a
> superfície inteira e transformá-la no ledger (`cobertura.json`).
>
> **O que não entra no inventário não é testado — e o gate só protege o que está no ledger.** Por
> isso esta fase vem antes de qualquer clique. Um inventário raso produz um relatório que "parece
> completo" com metade dos botões nunca clicados, o que é pior do que não testar.

## Sumário

0. [A sequência e o que sai dela](#0-a-sequência-e-o-que-sai-dela)
1. [Descoberta do projeto](#1-descoberta-do-projeto)
2. [Segurança do ambiente antes de qualquer escrita](#2-segurança-do-ambiente-antes-de-qualquer-escrita)
3. [O PERFIL do projeto](#3-o-perfil-do-projeto)
4. [Inventário da superfície](#4-inventário-da-superfície)
5. [Do inventário ao ledger](#5-do-inventário-ao-ledger)
6. [Crítico de completude (loop-until-dry)](#6-crítico-de-completude-loop-until-dry)
7. [Escopo](#7-escopo)
8. [Checklist de saída desta fase](#8-checklist-de-saída-desta-fase)

---

## 0. A sequência e o que sai dela

| # | Passo | Sai daqui |
|---|---|---|
| 1 | Ler as regras do projeto e do usuário | restrições anotadas, com fonte e data |
| 2 | Descobrir stack, como subir, ambientes, banco, auth, i18n, design system, testes | rascunho do PERFIL |
| 3 | Registrar git status inicial, commit base e baselines | `rodada.git`, `rodada.baselines` |
| 4 | Confirmar o ambiente **por medição** | `rodada.ambiente`, `rodada.ambiente_confirmado` |
| 5 | Perguntar só o que não dá para descobrir | `rodada.autorizacoes` |
| 6 | Inventariar em todos os modos aplicáveis | `itens`, `rodada.contagens` |
| 7 | Converter cada item em casos | `casos` (todos `pendente`) |
| 8 | Crítico de completude até secar | `rodada.criticas` |

`rodada.git`, `rodada.baselines`, `rodada.criticas`, `rodada.contagens`, `rodada.ambiente_confirmado`,
`rodada.tipos_projeto` e `rodada.modo` se gravam pelo `cobertura.py`, nunca à mão:
`cobertura.py rodada <rodada> --git "<repo>|<branch>|<commit>"` (um por repositório),
`--baseline "<gate>|<comando>|<resultado>|<composicao>"` (um por gate),
`--critica "passada=N;novos_itens=N;novos_casos=N;origem=<texto>"` (uma por passada do crítico; o gate
final exige pelo menos duas, e as duas últimas sem novidade), `--contagem
"<modo>|<fonte>|<N no código>|<N no ledger>[|<justificativa>]"` (uma por tipo de projeto, §4.1),
`--ambiente-confirmado "<o que mediu>|agora"` (§2.2), `--tipo-projeto <slug>[,<slug>]` (§1.2) e
`--modo completo|reteste|revisao`. `--git`, `--baseline`, `--critica` e `--contagem` são repetíveis. O
reteste é sempre rodada nova, criada com `cobertura.py init <rodada> --modo reteste --reteste-de
<rodada-original>` (`references/correcao-e-relatorio.md` §4); trocar para ou de reteste num ledger com casos
sai 2.

**Saída obrigatória:** `.qa/PERFIL.md` criado ou atualizado, a pasta da rodada
`.qa/<AAAA-MM-DD>-<alvo-slug>/` com `cobertura.json`, `notas/01-perfil-e-ambiente.md` e
`notas/02-inventario.md`. Só então siga para `references/execucao-e-evidencias.md`.

**Se `.qa/PERFIL.md` já existe:** leia-o primeiro e revalide o que muda entre rodadas — ambiente
(medir de novo), baselines, git status, usuários logados. O PERFIL diz como o projeto funciona; ele
não prova para onde a API aponta hoje.

**Registre a cada passo, nunca só no fim.** A nota da fase é escrita enquanto a fase acontece; se a
sessão cair no meio, o que foi descoberto já está em disco.

---

## 1. Descoberta do projeto

**Regra: não pergunte o que dá para ler.** Pergunte só o que não está em arquivo nenhum (§2.5).

### 1.1 Regras do projeto primeiro

Leia antes de tudo, porque podem ser **mais restritivas** que os padrões da skill (e o mais
restritivo vence):

- `CLAUDE.md` (raiz e subpastas), `AGENTS.md`, `CONTRIBUTING.md`, `README*`
- `.cursor/rules`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `docs/`
- memória/feedback do usuário que a sessão carrega (regras como "nunca commitar", "produção só
  leitura", "navegador obrigatório", "não mexer no backend")

Anote cada regra com a fonte e a data. **Conflito:** instrução explícita mais nova do usuário
prevalece sobre a mais antiga; registre os dois lados no PERFIL, com as datas, para a próxima rodada
não reabrir a dúvida.

Documento grande (changelog com centenas de entradas): não leia inteiro, use grep por `QA`,
`teste`, `armadilha`, `retrat`, `gotcha`, `não é bug`, `produção`, `ambiente`, `baseline`,
`falso`. **O histórico de erros do projeto é a melhor fonte de armadilhas** — cada retratação
registrada é uma armadilha que você não vai precisar descobrir de novo.

### 1.2 Stack e framework

| Arquivo | O que revela |
|---|---|
| `package.json` + lockfile | framework (next, react, vue, angular, svelte, express, nest…), scripts, versão do Node, gerenciador (npm/pnpm/yarn/bun) |
| `tsconfig.json` / `jsconfig.json` | aliases de import, `strict` (afeta o que o typecheck pega) |
| `next.config.*`, `vite.config.*`, `angular.json`, `nuxt.config.*` | roteamento, CSP, se o build ignora erro de tipo |
| `*.sln`, `*.csproj`, `Properties/launchSettings.json`, `appsettings*.json` | .NET; **perfis de execução e variável de ambiente de cada um** |
| `pyproject.toml`, `requirements*.txt`, `manage.py`, `setup.cfg` | Python (Django, FastAPI, Flask) |
| `go.mod` · `Cargo.toml` · `Gemfile` + `config/routes.rb` · `composer.json` + `artisan` · `pom.xml`/`build.gradle*` | Go · Rust · Rails · Laravel · Java/Kotlin |
| `pubspec.yaml` · `android/`, `ios/` · `app.json`/`app.config.*` | Flutter · nativo · Expo/React Native |
| `Dockerfile`, `docker-compose*.yml`, `Procfile`, `Makefile`, `justfile`, `Taskfile.yml` | serviços, portas, dependências, ordem de subida |
| `.github/workflows/`, `azure-pipelines.yml`, `.gitlab-ci.yml`, `vercel.json`, `netlify.toml`, `fly.toml` | **ambientes publicados: branch → host → API** |

Classifique o projeto: **web front · full-stack · API/backend · mobile · CLI · biblioteca ·
jobs/filas/ETL · app com modelo de linguagem (LLM, RAG, agente) · desktop (Electron/Tauri) ·
jogo/canvas · site estático · monorepo**. Um projeto pode ter mais de um (full-stack com LLM, por
exemplo): aplique todos e declare todos no ledger (`cobertura.py rodada <rodada> --tipo-projeto
full-stack,llm`; a opção é repetível e aceita vírgula). O gate cobra a união das seções do catálogo;
`llm` exige também o tipo de base (front-web, full-stack ou api) e `monorepo` exige o tipo de cada
pacote. Em monorepo, cada pacote relevante vira uma linha da tabela "Pacotes" do PERFIL (§1.1 do
template), com tipo, comandos de gate e baseline próprios. O tipo decide quais modos de inventário se
aplicam (§4.14).

| Sinal no repositório | Tipo |
|---|---|
| SDK de provedor de modelo (`openai`, `anthropic`, `@ai-sdk/*`, `langchain`, `llamaindex`), prompt em arquivo, índice vetorial | app com modelo de linguagem |
| `electron`, `@tauri-apps/*`, `main.js` + `preload.js`, `src-tauri/` | desktop |
| `<canvas>` como tela principal, `three`, `pixi.js`, `phaser`, `babylonjs`, Unity/Godot exportado para web | jogo/canvas |
| só HTML/CSS e gerador estático (`astro`, `hugo`, `jekyll`, `eleventy`, `next export`), sem backend próprio | site estático |
| agendador, consumidores de fila, pipeline de dados (`celery`, `sidekiq`, `hangfire`, `airflow`, `dbt`) | jobs/filas/ETL |
| `workspaces` no `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json` | monorepo |

### 1.3 Como subir

- Fontes: scripts `dev`/`start`/`serve`, `.vscode/launch.json`, `.claude/launch.json`,
  `launchSettings.json`, `docker-compose`, seção "Getting started" do README.
- Anote: comando, porta, dependências (banco, fila, outra API), ordem, tempo de subida e **como
  saber que subiu** (URL de health, linha de log).
- **Já está rodando?** Não suba outra instância na mesma porta. Descubra quem atende:
  `netstat -ano | findstr :3000` (Windows) ou `lsof -i :3000` (macOS/Linux).
- Serviço que o usuário mantém aberto (API na IDE, por exemplo) é dele: se precisar reiniciar,
  **avise na hora e espere**. Junte as mudanças para pedir o mínimo de reinícios.

### 1.4 Ambientes e URLs

- `.env*`: leia os **nomes** das variáveis e as URLs; **nunca copie valor secreto** para nenhum
  arquivo. Conheça a precedência do framework (no Next: `.env.local` > `.env.development` > `.env`).
- ⚠️ **O arquivo diz a intenção; a rede diz a verdade.** Já aconteceu de:
  - `.env.local` gravado em UTF-16 ser ignorado em silêncio pelo carregador;
  - variável exportada no shell que subiu o processo vencer todos os arquivos;
  - quatro perfis de execução da API usarem a **mesma porta** apontando para **bancos diferentes**
    (dev, QA, produção). A URL da API não prova o banco.
- `appsettings.{Ambiente}.json`, `config/*.yml`, `settings/*.py` por ambiente.
- **Workflows de deploy são o mapa:** branch → host publicado → API → banco. É ele que diz qual
  host é produção — não o nome do host, não a lembrança. Lição real: um host de nome aleatório foi
  tratado como "teste" e era produção; três fases de cadastro foram gravadas lá.
- Monte a tabela de ambientes do PERFIL (§3 do template).

### 1.5 Banco — somente leitura

- Engine, servidor e banco **por ambiente**; onde mora a conexão (arquivo e chave); cliente de
  linha de comando disponível (`sqlcmd`, `psql`, `mysql`, `sqlite3`, `mongosh`, `redis-cli`).
- Use a conexão **sem copiá-la** para arquivo nenhum (leia para uma variável do próprio comando) ou
  peça ao usuário um login somente leitura.
- Garanta a leitura no próprio cliente quando der:

  | Engine | Como forçar leitura |
  |---|---|
  | PostgreSQL | `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` |
  | MySQL/MariaDB | `SET SESSION TRANSACTION READ ONLY;` |
  | SQLite | abrir com `file:<caminho>?mode=ro` |
  | SQL Server | só `SELECT`; nada de `UPDATE`/`DELETE`/`MERGE`/`EXEC` de procedure que grava; prefira login `db_datareader` |
  | MongoDB | só `find`/`aggregate` sem `$out`/`$merge` |

- Anote as tabelas úteis: auditoria/atividade, log de e-mail e notificação, fila, sessões.
- Anote **como ver quem está conectado** (prova de para onde a API aponta):
  SQL Server `sys.dm_exec_sessions` (`host_name`, `program_name`); PostgreSQL `pg_stat_activity`
  (`client_addr`, `application_name`); MySQL `information_schema.processlist`.
- Mapeie entidade da tela → tabela. O nome da tabela raramente é o nome da tela.

### 1.6 Autenticação, papéis e tenants

- **Mecanismo:** sessão/cookie, JWT, OAuth/SSO, 2FA, magic link. Se as permissões viajam no token,
  mudar uma permissão **só vale depois de sair e entrar de novo** — F5 não basta.
- **Onde moram papéis e permissões:** enums, seeds, tabelas (`role`, `permission`, `feature`,
  `profile`), policies, decorators, middleware de rota.
- **Liste todos os eixos de autorização**, não só "papel". Um eixo esquecido é uma linha inteira da
  matriz sem teste:
  - papel/perfil;
  - permissão fina por ação e **por campo**;
  - flags globais que curto-circuitam (ex.: "lê tudo", "bloqueia escrita");
  - tenant/organização/parceiro (isolamento de dados);
  - nível, plano ou assinatura;
  - dono do registro (ex.: só quem criou conclui);
  - estado do registro;
  - feature flag e ambiente.
- **Usuários de teste:** procure em seeds, fixtures, docs e no PERFIL anterior; pergunte quais
  existem e quais estão logados. **Nunca senha, nunca login:** quem loga é o usuário.
- Armadilhas típicas a anotar: duas sessões no mesmo navegador compartilham cookie (o token pode ser
  por aba e o cookie por origem); deslogar uma aba derruba a outra.

### 1.7 i18n

- Config de locales, locale padrão, onde ficam os dicionários, onde fica o tipo das chaves.
- Paridade de chaves entre locales — verificação estática. Para dicionários JSON:

  ```python
  import json, pathlib, sys

  def chaves(d, p=''):
      for k, v in d.items():
          yield from chaves(v, f'{p}{k}.') if isinstance(v, dict) else [f'{p}{k}']

  arquivos = sorted(pathlib.Path(sys.argv[1]).glob('*.json'))
  por_locale = {a.name: set(chaves(json.loads(a.read_text(encoding='utf-8')))) for a in arquivos}
  todas = set().union(*por_locale.values())
  for nome, ks in por_locale.items():
      faltam = sorted(todas - ks)
      print(f'{nome}: {len(ks)} chaves, faltam {len(faltam)}')
      for k in faltam[:30]:
          print('   ', k)
  ```

  Dicionário em TS/JS: o tipo das chaves + o typecheck costumam pegar a falta; se não houver tipo,
  importe os dicionários num script Node e compare do mesmo jeito.
- Texto cravado: grep de string literal em JSX/templates nas telas do escopo. Cada achado é um caso
  de i18n.

### 1.8 Design system

- Tokens (`tailwind.config.*`, `theme.*`, variáveis CSS), biblioteca de componentes, regras
  documentadas (ex.: "cor é canal de status", "número alinhado à direita").
- Página-vitrine (Storybook, `/componentes`): **referência visual, nunca validação.** A vitrine
  prova que o componente monta; só a tela real prova a integração.
- Sugestão de design só dentro do design system do projeto. Nunca proponha paleta nova.

### 1.9 Testes existentes

- Unit (jest, vitest, pytest, xunit, `go test`), e2e (Playwright, Cypress, Selenium), contrato.
- Como rodar, quais quebram hoje (vai para o baseline), se há `data-testid`/`testID`/
  `accessibilityIdentifier` — são os alvos estáveis da execução.
- Testes existentes são **fonte de inventário** (o que alguém já achou importante) e **fonte de
  oráculo** (comportamento esperado), não substituto do teste na tela.

### 1.10 Estado do código e git status inicial

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
git status --porcelain
git config core.autocrlf; cat .gitattributes 2>/dev/null
```

- Registre com `cobertura.py rodada <rodada> --git "<repo>|<branch>|<commit>"` (um por repositório;
  vai para `rodada.git`). **Arquivo já modificado no início é de outra sessão ou pessoa:** nunca
  entra na sua entrega e nunca é revertido por você.
- O relatório diz **contra qual código** foi escrito (branch + commit). "Está no changelog que foi
  corrigido" não é "está neste código": confira com `git log` e grep na branch testada.
- Anote se o repositório é LF ou CRLF. No Windows, editar arquivo (por script **ou** pela
  ferramenta de edição) pode trocar o fim de linha e inflar o diff; o conferido é
  `git diff --stat` igual a `git diff --ignore-cr-at-eol --stat`.

**Projeto sem git** (zip, Perforce, SVN, pasta solta): se `git rev-parse` falhar, faça as três
coisas abaixo **antes da primeira edição**, e anote "sem VCS" no PERFIL e na entrega. **Nunca crie
pasta `.git`** no projeto do usuário.

1. **Cópia do estado inicial, fora do projeto**, sem as pastas pesadas: `<rodada>/original/` quando a
   pasta da rodada fica fora do projeto, ou `$TMP/qa-original-<rodada>/`. Sem espaço para a cópia
   inteira, no mínimo copie cada arquivo para `<rodada>/originais/<caminho>` **antes** da primeira
   edição dele — é desse original que sai o patch.
2. **Retrato com SHA-256** em `notas/00-snapshot-inicial.txt`, com um trecho Python que roda igual em
   Windows, macOS e Linux (sem `find`/`sha256sum`, que não existem no PowerShell):

```bash
python -c "import hashlib,os,sys;X={'node_modules','.qa','dist','build','bin','obj','.venv','__pycache__','.git'};L=[]
for r,d,f in os.walk('.'):
    d[:]=sorted(x for x in d if x not in X)
    for n in sorted(f):
        p=os.path.join(r,n);L.append(hashlib.sha256(open(p,'rb').read()).hexdigest()+'  '+p.replace(os.sep,'/'))
open(sys.argv[1],'w',encoding='utf-8',newline='\n').write('\n'.join(L)+'\n')" .qa/<rodada>/notas/00-snapshot-inicial.txt
```

3. **No fim**, compare o retrato com o estado atual (o que mudou e não é seu é de outra sessão) e gere
   o patch contra a cópia: `git diff --no-index <original> <projeto> > relatorio/entrega.patch` (não
   precisa de repositório) ou `diff -ruN <original> <projeto>`. Sem VCS, `entregas.py` não se aplica:
   a entrega é **um patch por assunto**, cada um gerado da cópia original com só os arquivos daquele
   assunto.

### 1.11 Baselines antes de mexer

| Gate | Exemplos de comando | O que anotar |
|---|---|---|
| Typecheck | `npx tsc --noEmit`, `mypy`, `pyright`, `dotnet build` | número exato de erros, data |
| Lint | `npm run lint`, `ruff`, `eslint` | idem |
| Testes | `npm test`, `pytest`, `dotnet test`, `go test ./...` | passou/falhou/pulado |
| Build | `npm run build`, `cargo check` | sucesso, avisos — só se não houver dev server usando a mesma pasta de saída, ou com o ok do usuário; não rodado = "não executável: <motivo>" |

- Anote **o que o número contém**: erros de arquivos gerados, cópias temporárias dentro do repo,
  pastas de build. Já aconteceu de cópias de verificação em `tmp/` dobrarem a contagem do
  typecheck (613 em vez de 308).
- Uma correção nunca pode subir o número.
- **Número que não muda quando a entrada muda é sinal de medição quebrada** — confirme que o gate
  de fato roda. E número que **despenca** de repente também é sinal: costuma ser erro de sintaxe
  interrompendo a compilação, não melhoria.
- Gate que não roda (ferramenta quebrada) é registrado como "não executável", com o erro. Nunca
  finja verde.
- Registre cada gate no ledger com `cobertura.py rodada <rodada> --baseline
  "<gate>|<comando>|<resultado>|<composicao>"` (vai para `rodada.baselines`) e no PERFIL §12.

---

## 2. Segurança do ambiente antes de qualquer escrita

### 2.1 Classifique cada ambiente

| Tipo | Sinais | Política padrão |
|---|---|---|
| **Local** | `localhost`, banco local ou de dev | escrita via aplicação; registrar sujeira |
| **Dev/teste/homologação compartilhado** | host de teste no workflow de deploy, dados de teste | escrita via aplicação; registrar sujeira; lembrar que outras pessoas usam |
| **Produção** | domínio público do produto, deploy a partir de `main`/`master`, chaves "live", **volume grande** (milhares de registros, nomes de clientes reais) | **somente leitura** |

⚠️ **Volume é sinal de parar.** Se a listagem mostra milhares de registros e nomes de empresas
reais num ambiente que você julgava de teste, pare e confirme antes de qualquer clique que grave.

### 2.2 Confirme por medição, nunca por leitura de config

Antes da **primeira escrita de cada sessão** e depois de **qualquer reinício**:

1. **Front → API:** recarregue a tela e leia o host das requisições (ferramenta de rede ou espião
   de XHR/fetch). Esse é o host real.
2. **API → banco:** no banco, procure a sessão da sua máquina ou da API (§1.5); ou confira o
   perfil de execução da API e o banco que o log de inicialização mostra.
3. **Compare com o mapa do deploy** (§1.4).
4. **Registre** em `rodada.ambiente` (texto: front → API → banco) e em
   `rodada.ambiente_confirmado` (`por`: o que você mediu; `em`: o horário) com
   `cobertura.py rodada <rodada> --ambiente "<front → API → banco>" --ambiente-confirmado "<o que mediu>|agora"`.
   O gate final exige o `ambiente_confirmado` quando a rodada escreveu algo (há registro em `sujeira`).
5. **Ambiente de reteste:** meça do mesmo jeito o ambiente onde a correção será retestada e anote no
   PERFIL §3.1 (nome, URL, host medido, se é produção, se a escrita pela aplicação é permitida). Sem
   medida, ou se for produção, ele não serve para reteste.

Meça de novo se: um servidor reiniciou, você trocou de aba ou de usuário, ou a quantidade de
registros na tela mudou de escala.

### 2.3 Política de escrita (padrão da skill)

| Ação | Local / dev | Teste compartilhado | Produção |
|---|---|---|---|
| Ler tela, payload, banco | sim | sim | sim |
| Criar/editar **pela aplicação** | sim, registrando sujeira | sim, registrando sujeira | só com pedido explícito daquela ação |
| "Salvar" sem alterar nada | conta como escrita | conta como escrita | conta como escrita |
| `UPDATE`/`DELETE` direto no banco | só com pedido explícito | só com pedido explícito | nunca |
| Efeito externo (e-mail real, pagamento, integração, notificação a pessoas reais) | só com autorização registrada | só com autorização registrada | nunca |
| Alterar código | em pedido de QA, corrigir o defeito claro (`references/qualidade-e-refatoracao.md` §1.2); o resto só com autorização | idem | nunca |
| `commit`/`push`/`merge`/PR | nunca sem pedido explícito | — | — |

**Por que "Salvar sem alterar" é escrita:** ele grava uma atualização, registra atividade e pode
apagar dado que a tela não carregou (já apagou o endereço de um cliente em produção durante um
diagnóstico).

**Autorização vale para aquela ação, naquela rodada.** Não se estende ao próximo caso.

### 2.4 Protocolo PARE

Se perceber que escreveu — ou está prestes a escrever — em produção ou no ambiente errado:

1. **Pare.** Nenhuma ação de escrita a mais, nem para "limpar".
2. **Liste o que foi gravado:** o quê, identificador, quando, efeito externo possível
   (integração disparada, e-mail enviado).
3. **Avise o usuário na hora**, com a lista.
4. **Registre** cada item em `sujeira`, com `ambiente: "produção"`, o `estado_final` e
   `como_desfazer: "decisão do usuário"`.

Limpar produção é outra escrita em produção: só com pedido explícito.

### 2.5 O que perguntar — e só isso

Uma mensagem, uma vez, só com o que não dá para descobrir:

```
Antes de gravar qualquer coisa, preciso de 5 confirmações:
1. Usuários: quais papéis estão logados, e onde (navegador, janela, aba)? Para testar <papel X>
   preciso que você logue com ele (eu não digito senha). Sem navegador (API/CLI/job), uma de duas:
   (a) variável de ambiente (ex.: QA_TOKEN_<PAPEL>) — só vale se estiver no perfil do shell ou no
   ambiente que iniciou o Claude Code; um export feito noutro terminal no meio da sessão não chega,
   porque cada comando abre um shell novo; (b) um arquivo de cabeçalho fora do repositório, que você
   cria a qualquer momento sem reiniciar a sessão (ex.: $QA_CRED_DIR/<papel>.header, com a linha
   "Authorization: Bearer …"), usado com `curl -H @arquivo` (curl 7.55 ou mais novo). Eu nunca
   imprimo nem gravo o valor.
2. Efeitos externos: posso disparar e-mail/integração em <ambiente>? Para quais destinatários?
3. Código: o padrão é eu corrigir na hora o defeito claro e retestar. Alguma camada fica só como
   relato (ex.: backend de outro time, outro repositório)?
4. Registro: uso <raiz>/.qa/ ou outra pasta?
5. Branch e PR: há branch ou PR desta rodada? Qual o destino (ex.: develop)?
Enquanto isso, sigo com o inventário, as leituras e os baselines.
```

- **Credenciais nunca.** Para outro papel, o usuário loga; em API, CLI e job, a credencial de teste
  vem (a) de variável de ambiente — que só existe se estiver no perfil do shell ou no ambiente que
  iniciou o Claude Code (export noutro terminal, no meio da sessão, não chega) — ou (b) de um arquivo
  de cabeçalho fora do repositório (ex.: `$QA_CRED_DIR/<papel>.header` com `Authorization: Bearer …`),
  que o usuário cria a qualquer momento e você usa com `curl -H @arquivo` (curl ≥ 7.55) (PERFIL §6).
  Você só usa o nome da variável ou o caminho do arquivo: nunca imprime nem grava o valor.
- **Pedido de QA autoriza corrigir o defeito claro** (os seis testes de
  `references/qualidade-e-refatoracao.md` §1.2). "Analisa", "olha", "foca", "investiga", "mede",
  "testa sem corrigir", "revisa e testa", "audita" e "valida <artefato>" não autorizam: relate e
  proponha (arquivo, linha, correção sugerida); terminam em lista, não em arquivo modificado.
  O MA-4 define o ESCOPO (o diff e o raio de impacto), não a autorização. Testar uma branch ou PR ("testa a branch X", "dei pull, testa") é pedido de QA: corrige o defeito claro. Auditar executando uma branch ou PR ("audita", "testa sem corrigir") só relata, até o usuário dizer "corrige"; "revisa a PR" só de leitura, sem executar, é do code-review: avise.
- **Não bloqueie enquanto espera:** comece pelo que é só leitura.
- **Sem resposta à pergunta 3, vale o padrão de QA** (corrigir o defeito claro, relatar o resto). O
  mais restritivo se aplica a efeitos externos e a escrita, não à correção: sem resposta às
  perguntas 1, 2 e 5, nada de efeito externo, escrita fora do que o teste cria nem branch, e registre
  que assumiu.

---

## 3. O PERFIL do projeto

### 3.1 Por que existe e por que persiste

- A skill é genérica; o PERFIL é o **adaptador**: diz como este projeto sobe, onde está cada
  ambiente, quem pode o quê, e o que é proibido aqui.
- **Persiste entre rodadas** (`.qa/PERFIL.md`, ou onde ele próprio apontar). A segunda rodada começa
  em minutos, e cada armadilha descoberta continua valendo. Sem ele, a mesma armadilha custa uma
  hora em cada rodada.
- Modelo: `templates/PERFIL-DO-PROJETO.md`. Exemplo real preenchido:
  `exemplos/PERFIL-exemplo-crm-web.md`.

### 3.2 O que vai nele

Projeto e regras lidas · como subir · ambientes (com política e como confirmar) · banco somente
leitura · autenticação, eixos de autorização e usuários de teste · ferramentas de navegador
permitidas e proibidas · como salvar print · dados de teste reais permitidos · efeitos externos e o
que está autorizado · autorizações padrão (código, reinício, commit) · regras de código e gates ·
baselines medidos · i18n · design system · testes existentes · onde registrar e como entregar ·
**armadilhas conhecidas (lista viva)** · checklists por módulo · rodadas anteriores.

### 3.3 O que nunca vai

- Senha, token, cookie, connection string, chave de API — nem "só para lembrar".
- Dado pessoal além do necessário: use papel e e-mail de teste, não dados de clientes reais.
- Print com dado sensível sem tarja.

### 3.4 Manutenção

- **Medido, com data:** "typecheck 308 erros (2026-09-30)", nunca "uns 300".
- **Armadilha nova** entra na lista viva com data, sintoma, causa e como evitar. Se a lição vale
  para qualquer projeto, ela vai também para `references/catalogo-de-testes.md` da skill.
- **Revalide no início de cada rodada:** ambiente (medindo), baselines, usuários logados.
- **`.qa/` fora do versionamento, sem tocar no `.gitignore`:**

  ```bash
  grep -qxF '.qa/' .git/info/exclude || echo '.qa/' >> .git/info/exclude
  ```

  `.git/info/exclude` é local e não versionado. Editar o `.gitignore` do projeto só com pedido.

---

## 4. Inventário da superfície

O coração do "nada fica para trás". O inventário é **multi-modal** porque **cada modo é cego ao
que o outro acha**.

> Nas tabelas desta seção, `\|` dentro de código é só o escape do Markdown. No terminal, use `|`.

### 4.1 Os modos e o ponto cego de cada um

| Modo | Fonte | Acha | É cego a |
|---|---|---|---|
| **Rota/tela** | router, arquivos de página | telas, rotas sem menu, deep links, aliases | elementos condicionais, estados |
| **Elemento — estático** | grep no código da tela | botões condicionais, `disabled` com motivo, `data-testid`, handlers | o que só existe em runtime; cópias ocultas |
| **Elemento — runtime** | DOM / árvore de acessibilidade | o que de fato aparece neste papel e estado | o que só aparece em outro papel ou estado; `div` com `onClick` sem papel |
| **API** | OpenAPI, controllers, rede observada | endpoints, auth, payload, status real | regra de UI |
| **Regra de negócio** | schemas, guards, mensagens, `disabled=` | limites, combinações, mensagens a disparar | caminho de navegação |
| **Papel/permissão** | ACL, policies, seeds, catálogo no banco | matriz papel × ação | o que a tela faz |
| **Estado** | enums, máquinas de estado, workflow | transições, terminais | como chegar a cada estado pela UI |
| **Efeito externo** | envio de e-mail, filas, webhooks, integrações | o que sai do sistema | — |
| **Dado** | models, migrações, constraints | CRUD, FK, unicidade, órfãos | — |
| **i18n / viewport** | locales, breakpoints | variações de apresentação | — |
| **Fluxo** | combinação dos anteriores | bifurcações ponta a ponta | detalhe de campo |

Rode **todos os modos aplicáveis** ao tipo de projeto (§4.14). Item achado por um só modo é
normal. **Divergência de contagem entre modos é um achado a explicar** (§6). O inventário só sai
quando as contagens batem e duas checagens saem 0: `cobertura.py reconciliar <rodada> --elementos <json>`
(elementos em runtime × ledger, §4.3) e `escopo_diff.py --tudo --so-inventario --ledger <rodada>
--falhar-se-descoberto` (superfície do código × ledger; com `--so-inventario` só "sem item no ledger"
conta, porque os casos nascem na fase 4). O `--falhar-se-descoberto` completo, que também cobra caso
concluído, vale nas fases 8 e 9. `cobertura.py reconciliar` só com UI (web, mobile, desktop); sem UI,
anote na nota 02-inventario "reconciliar: não se aplica, sem elementos em runtime" (o comando sem
`--elementos`, numa rodada sem tipo de UI, diz o mesmo e sai 0).

O `--tudo` enxerga, além de telas e endpoints web: subcomandos de CLI (argparse, click, typer,
commander, yargs, cobra, `bin` do `package.json`) como `comando:`; exports públicos (`exports`/`main`
do `package.json`, `__all__`, `pub fn`) como `funcao:`; Celery (task e `beat_schedule`), Hangfire,
`@Cron`, node-cron, BullMQ e Sidekiq como `job:`; `ipcMain.handle`, `exposeInMainWorld` e
`#[tauri::command]` como `ipc:`; `<X.Screen name>`, Expo Router e `GoRoute` como `tela:`; página
`.html` servida (documento inteiro, fora de `templates/`, parciais, e-mail e `*.component.html`) como
`tela:/<caminho do .html>`; rotas do Python `http.server` (`do_GET`/`do_POST` com `self.path ==
'/...'`), chamadas do JS inline dos `.html` e chamadas por wrapper de um nível (`api("PUT", "/x/" +
id)`) como `api:`. Tipo de projeto não web declarado no ledger para o qual o detector não achou nada (e
`llm`, `jogo`, que não têm detector) faz o `--falhar-se-descoberto` sair 1 com "detector nao cobre
<tipo>"; `front-web`, `full-stack` ou `api` com 0 tela e 0 endpoint detectados, com "detector nao achou
rota nem endpoint em <tipo>". Nos dois casos, enumere à mão e **registre a contagem** —
`cobertura.py rodada <rodada> --contagem "<modo>|<fonte>|<N no código>|<N no ledger>[|<justificativa>]"`
(ex.: `"comando|subparsers do argparse × --help|12|12"`). O gate final exige uma contagem por tipo
declarado e reprova N no ledger menor que N no código sem justificativa. **Regravar o mesmo modo e
fonte substitui; a anterior fica em `contagens_historico`** e o gate só lê a última de cada modo e
fonte: contou antes de o inventário fechar, complete o ledger e grave de novo com o N atual (ou com a
justificativa). O `fechar` roda o mesmo `escopo_diff --tudo --ledger --falhar-se-descoberto`, sem
`--so-inventario`, fora do modo PR e do reteste.

### 4.2 Modo ROTA/TELA

| Framework | Como listar |
|---|---|
| Next.js App Router | `rg --files -g 'page.{tsx,jsx,ts,js,mdx}' app src/app` — URL = caminho sem `(grupo)` e sem `@slot`; `[id]` é dinâmico; `(.)` é rota interceptada (modal); `route.ts` é endpoint; `layout`/`loading`/`error`/`not-found` são estados; `middleware.ts`/`proxy.ts` é o portão de auth |
| Next.js Pages Router | `rg --files pages -g '!_*'`; `pages/api/**` são endpoints |
| Next.js Server Actions | `rg -n "use server" app src` — toda função exportada de arquivo com a diretiva (ou a função que a declara) é um endpoint POST, chamável sem a tela |
| Nuxt (server) | `rg --files server/api server/routes` — cada arquivo é um endpoint |
| SvelteKit (actions) | `rg -n "export const actions" -g '+page.server.*' src/routes` — cada action é um POST |
| Remix (loader/action) | `rg -n "export (async )?function (loader\|action)" app` |
| tRPC | `rg -n "\.(query\|mutation)\(" -g '*router*'` — cada procedure é chamável direto pelo cliente |
| React Router / Remix | `rg -n "createBrowserRouter\|<Route\b\|path:\s*['\"]" src`; rotas por arquivo em `app/routes/` |
| Vue / Nuxt | `rg -n "routes\s*[:=]" src/router`; Nuxt: arquivos em `pages/` |
| Angular | `rg -n "path:\s*'" -g '*routing*.ts' -g '*.routes.ts' src` |
| SvelteKit | `rg --files src/routes -g '+page.svelte' -g '+server.*'` |
| Django | `python manage.py show_urls` (django-extensions) ou `rg -n "path\(\|re_path\(" -g 'urls.py'` |
| Rails | `bin/rails routes` |
| Laravel | `php artisan route:list --json` |
| Express / Koa / Fastify | `rg -n "\.(get\|post\|put\|patch\|delete\|all\|route)\(\s*['\"/]" src` |
| NestJS | `rg -n "@(Controller\|Get\|Post\|Put\|Patch\|Delete)\(" src` |
| ASP.NET | `rg -n "\[(Route\|Http(Get\|Post\|Put\|Patch\|Delete))" -g '*.cs'` e `rg -n "Map(Get\|Post\|Put\|Patch\|Delete)\(" -g '*.cs'` |
| Spring | `rg -n "@(Request\|Get\|Post\|Put\|Patch\|Delete)Mapping" -g '*.java' -g '*.kt'`; `/actuator/mappings` se ligado |
| FastAPI / Flask | `rg -n "@(app\|router\|bp)\.(get\|post\|put\|patch\|delete\|route)\(" -g '*.py'`; FastAPI expõe `/openapi.json` |
| Go (net/http, gin, chi, echo) | `rg -n "\.(GET\|POST\|PUT\|PATCH\|DELETE\|Get\|Post\|HandleFunc\|Handle)\(" -g '*.go'` |
| React Native / Expo | `rg -n "<(Stack\|Tab\|Drawer)\.Screen" src`; Expo Router: arquivos em `app/` |
| Flutter | `rg -n "GoRoute\(\|routes:\s*\{\|MaterialPageRoute" lib` |
| Android / iOS nativo | `AndroidManifest.xml` (activities), `res/navigation/*.xml`; `rg -n "NavigationLink\|navigationDestination\|\.sheet\(" -g '*.swift'`, storyboards |

**Endpoint sem arquivo de rota** (Server Action, server route do Nuxt, action do SvelteKit,
loader/action do Remix, procedure do tRPC) vira item `api:` como qualquer outro, com os casos de
sessão, papel e IDOR (`MA-6-07`, `MA-6-08`) chamados direto, sem a tela: ele fica fora do ledger,
do MA-6 e do crítico se só o router de páginas for lido.

Para cada rota anote: URL normalizada, parâmetros, **query params que mudam a tela**
(`?tab=`, `?mode=edit`, aliases que redirecionam), pública ou autenticada, quem acessa, guard,
arquivo. Inclua: rotas **sem link no menu** (acesso direto por URL), rotas públicas com token
(formulário enviado por e-mail), embed/iframe, 404, páginas de erro e redirects.

### 4.3 Modo ELEMENTO

**Estático** — no código de cada tela do escopo:

```bash
rg -n "data-testid=|testID=|accessibilityIdentifier" <pasta-da-tela>
rg -n "<button|onClick=|onPress=|role=\"button\"|@click=|\(click\)=" <pasta-da-tela>
rg -n "disabled=\{|:disabled=|\[disabled\]=" <pasta-da-tela>
rg -n "toast\(|notify\(|enqueueSnackbar\(|alert\(" <pasta-da-tela>
rg -n "title=\{|tooltip|Tooltip" <pasta-da-tela>
rg -n "Modal|Dialog|Drawer|Sheet|Popover|DropdownMenu" <pasta-da-tela>
rg -n "href=[\"'](https?:|mailto:|tel:)" <pasta-da-tela>
```

O último lista os **links externos** (sites de terceiros, `mailto:`, `tel:`, `wa.me`): cada um vira
item `elemento:` com o caso do catálogo `EL-LNK-07` (destino responde, domínio do ambiente certo, nada
de link de dev em produção).

**Runtime** — cole na ferramenta de JS do navegador **em cada estado da tela** (vazio, preenchido,
com erro, cada etapa, cada papel):

```js
(() => {
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=option],' +
    '[role=slider],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const visivel = el => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  const limpo = s => (s || '').replace(/\s+/g, ' ').trim();
  const semCampos = n => {
    const c = n.cloneNode(true);
    c.querySelectorAll('input,select,textarea,option,[contenteditable]').forEach(x => x.remove());
    return limpo(c.textContent);
  };
  const BOTAO = ['button', 'submit', 'reset', 'image'];
  const ehCampo = el => ['TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable ||
    (el.tagName === 'INPUT' && !BOTAO.includes((el.type || '').toLowerCase())) ||
    ['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox'].includes(el.getAttribute('role') || '') ||
    el.getAttribute('aria-haspopup') === 'listbox';
  const rotuloDoCampo = el => {
    const porId = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(id => id && id !== el.id)
      .map(id => document.getElementById(id)).filter(Boolean).map(semCampos).join(' ');
    const labels = el.labels ? [...el.labels].map(semCampos).join(' ') : '';
    const pai = el.closest('label');
    return el.getAttribute('aria-label') || porId || labels || (pai ? semCampos(pai) : '') ||
      el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('name') || el.id;
  };
  const texto = el => limpo(ehCampo(el) ? rotuloDoCampo(el)
    : el.tagName === 'INPUT' ? (el.getAttribute('aria-label') || el.value || el.alt || el.title || el.name || el.id)
    : (el.getAttribute('aria-label') || el.innerText || el.title || el.getAttribute('name') || el.id)).slice(0, 80);
  const vistos = new Set(), itens = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!visivel(el)) continue;
    const r = el.getBoundingClientRect();
    const naTela = r.bottom > 0 && r.top < innerHeight;
    const topo = naTela ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const item = {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      tipo: el.getAttribute('type') || '',
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').split(/[?#]/)[0].slice(0, 120) : '',
      nome: texto(el),
      testid: el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid') || '',
      desabilitado: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      motivo: el.title || el.parentElement?.title || el.getAttribute('aria-describedby') || '',
      obrigatorio: !!(el.required || el.getAttribute('aria-required') === 'true'),
      coberto: !!(topo && topo !== el && !el.contains(topo) && !topo.contains(el)),
      foraDaTela: !naTela
    };
    const chave = [item.tag, item.role, item.nome, item.testid].join('|');
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    itens.push(item);
  }
  return { url: location.pathname + location.search, innerWidth, total: itens.length, itens };
})()
```

**O JSON do snippet nunca guarda valor de campo.** Em `input`, `textarea`, `select`, caixa editável e
combo (`role` textbox, searchbox, spinbutton, combobox, listbox), o rótulo vem, nesta ordem, de
`aria-label`, `aria-labelledby`, `<label for=id>` (ou o `label` em volta, sem os campos de dentro),
`placeholder`, `name` e `id` — nunca de `el.value` nem do texto das opções, que num formulário de
edição é nome, CPF ou e-mail de cliente. O `value` só entra em `input` de botão (`submit`, `button`,
`reset`), onde ele é o texto do próprio botão. Se um JSON trouxer `valor`/`value`, o `reconciliar`
ignora, e descarta o rótulo igual a ele.

O `href` sai sem query nem âncora (onde costuma morar token); o `reconciliar --criar` usa `tag`,
`role`, `tipo`, `href` e o rótulo para gravar `tipo_elemento` (upload, data, select, select-busca,
link-externo, exportar) no item, e o gate final cobra o caso da subseção do catálogo (`EL-UPL`,
`EL-DAT`, `EL-SEL`, `EL-SBU`, `EL-LNK`, `EL-EXP`).

Limites do snippet (por isso o modo estático existe): não entra em iframe nem shadow DOM, e não vê
`div` com handler de clique registrado pelo framework (que, aliás, é achado de acessibilidade:
controle clicável deveria ser `<button>`). `coberto: true` significa que outro elemento está por
cima do centro — toast, balão de chat ou rodapé fixo engolindo o clique.

**Reconcilie com o ledger.** Salve o JSON que o snippet devolve (`{url, total, itens}`, uma lista se
forem várias telas ou estados) em `<rodada>/rede/elementos-<tela>.json` e rode
`cobertura.py reconciliar <rodada> --elementos <rodada>/rede/elementos-<tela>.json`: ele casa cada
elemento visto por `data-testid`, slug do rótulo ou id sugerido e **sai 1** listando o que está fora do
ledger. `--criar` acrescenta os faltantes como `elemento:<rota>#<slug>` sem caso, para o plano cobrir.
O `reconciliar --criar` deduplica o mesmo controle entre estados e papéis (o mesmo slug visto em outro
bloco não vira item de novo) e junta a ação repetida por linha num item só: 3 ou mais `data-testid` ou
slugs `<prefixo>-<número, uuid ou hex>` no mesmo bloco viram `elemento:<rota>#<prefixo>-[id]`, com a nota
"ação da linha (N linhas vistas)"; o sufixo `-2`, `-3` fica para outro controle com o mesmo slug no
mesmo bloco. Ele também cria `tela:<rota>` quando a rota do bloco não casa nenhuma tela do ledger
(`/clientes/123` casa `tela:/clientes/[id]`, `:id` ou `{id}`; aí o elemento usa a rota da tela) e
liga `pai` = a tela em todo `elemento:` sem pai cuja rota casa uma tela; rodar de novo liga o que ficou
sem pai. A origem guarda a rota e só os nomes dos parâmetros da query (`?tab&id`), nunca os valores.
Saída 0 em todas as telas e estados do escopo é parte do critério de saída do inventário.

**Para cada elemento anote:** slug (do `data-testid` ou do rótulo), tipo (botão, campo, select,
checkbox, rádio, toggle, link, aba, menu, item de menu, modal, drawer, toast, tooltip, card/KPI,
tabela, coluna, filtro, busca, paginação, upload, exportar), rótulo, obrigatório, desabilitado +
**motivo** + tooltip, quando aparece (papel, estado), o que dispara (handler → endpoint), arquivo e
linha.

Regras do modo:

- **Desabilitado é item.** O motivo faz parte do teste: botão cinza e mudo é achado.
- **Ação repetida por linha** ("Editar" em cada linha) é um item "ação da linha", testado em pelo
  menos uma linha de cada estado relevante (aberta, fechada, cancelada…).
- **Cópias ocultas e blocos responsivos:** a página pode montar a mesma tela duas vezes (uma com
  `display:none`) ou o mesmo controle em 2–4 variantes por breakpoint (já foram 12 botões no DOM
  para 3 etapas visíveis). Filtre pelo visível (largura > 0 e `elementFromPoint` no centro) e
  registre as variantes como itens de viewport — não como elementos repetidos.
- **Inventário por estado:** elementos condicionais só aparecem rodando o snippet no estado certo.
  Um botão que só existe depois de "Iniciar" não aparece na primeira varredura.
- **Interações escondidas:** hover, menu ⋮, clique direito, atalhos de teclado, arrastar e soltar,
  duplo clique, scroll infinito, Enter e Esc.

#### Mobile nativo

O snippet acima é só DOM. No app nativo (ou React Native/Flutter fora do navegador), o inventário em
runtime vem da **hierarquia de UI**, rodada em cada estado e papel, como o snippet:

| Precisa de | Como |
|---|---|
| Hierarquia de UI | `adb shell uiautomator dump /sdcard/ui.xml` + `adb pull /sdcard/ui.xml`; `maestro hierarchy`; page source do Appium; no Flutter, `integration_test` achando por `Key` |
| Rede | interceptor de log no build de debug, ou proxy com CA instalada **só no emulador de teste** |
| Deep link | `adb shell am start -W -a android.intent.action.VIEW -d <url>`; `xcrun simctl openurl booted <url>` |
| Permissões do SO | `adb shell pm grant\|revoke <pacote> <permissao>`; `xcrun simctl privacy booted grant\|revoke <servico> <bundle>` |
| Rotação, segundo plano, morte do processo | rotação pelo emulador; `adb shell input keyevent KEYCODE_HOME`; `adb shell am kill <pacote>` |
| Leitor de tela | TalkBack/VoiceOver no lugar do axe |

Cada elemento vira item pelo `testID`/accessibility id (ou pelo `resource-id`/`content-desc` do dump).
Registre se a rodada usou build **debug ou release**: o comportamento muda (log, minificação,
interceptor). Marcas no print do emulador usam os `bounds` do dump, em px (`circular.py --escala 1`).
Detalhe de execução e evidência em `references/execucao-e-evidencias.md` §1.3.

#### Canvas, WebGL e jogos

O que é desenhado dentro de um `<canvas>` não está no DOM: o snippet e o `elementFromPoint` não veem
botão, peça nem cena. Inventarie **por estado ou cena** (`cena:<nome>`: menu, fase, pausa, fim de
jogo, carregando), lendo o código das cenas e, quando o projeto expõe, um estado de debug (ex.:
`window.__estado`) como oráculo. A prova é print + `visual_diff.py` com tolerância e o estado lido;
marcas em px. Linhas do catálogo: `PJ-GAM` (§7.15).

### 4.4 Modo API

Fontes, nesta ordem de preferência: OpenAPI/Swagger (`/swagger/v1/swagger.json`, `/openapi.json`,
`/v3/api-docs`, `/api-docs`), schema/introspecção GraphQL (`type Query`, `type Mutation`),
controllers no código e **a rede observada** enquanto se usa a tela.

Para cada endpoint: método, rota, autenticação (anônimo? policy? papel?), parâmetros, payload,
**respostas reais** (status e corpo), paginação, tempo típico, quem chama (tela/elemento).

- ⚠️ **O status HTTP pode mentir.** Já foram vistos: erro de validação devolvido como **401** (e
  tratado pelo front como sessão expirada, apagando o login), e "não encontrado" devolvido como
  **200 com lista vazia** (lista vazia é verdadeira em JS, e a tela abriu um formulário em branco).
  Registre o status real, não o esperado.
- **Endpoint que nenhuma tela chama entra no inventário.** Ele é atacável direto e costuma ter
  menos proteção que o caminho da UI (exclusão unitária sem guarda ao lado da exclusão em lote
  protegida, por exemplo).
- **Reconcilie as três fontes:** swagger × controllers × rede. Endpoint no código e fora da rede é
  "sem UI" ou "fluxo não percorrido" — os dois viram item.

### 4.5 Modo REGRA DE NEGÓCIO

| Biblioteca / camada | Onde procurar |
|---|---|
| zod | `rg -n "z\.object\|\.min\(\|\.max\(\|\.regex\(\|\.refine\(\|\.superRefine\(" src` |
| yup / react-hook-form | `rg -n "yup\.\|\.required\(\|rules=\{\{\|register\(" src` |
| class-validator (Nest) | `rg -n "@(Is[A-Z]\w*\|Min\|Max\|Length\|Matches)\(" src` |
| FluentValidation / DataAnnotations | `rg -n "RuleFor\(\|\[Required\|\[StringLength\|\[Range\|\[RegularExpression" -g '*.cs'` |
| Pydantic / Django | `rg -n "Field\(\|@field_validator\|@validator\|validators=\|def clean_" -g '*.py'` |
| Rails / Laravel | `rg -n "validates\|validate :" app/models`; `rg -n "'required\|rules\(\)" app` |
| Guardas de backend | `rg -n "throw new \w*(Rule\|Business\|Validation\|Domain)\w*Exception\|BadRequest\(\|Forbid\(\|UnprocessableEntity\|HttpException\(\s*4"` |
| Mensagens | dicionários de i18n com `erro`, `error`, `obrigat`, `invalid`, `não é possível`; `toast(` e `setError(` nos handlers |
| Limites | `rg -n "(MIN\|MAX\|LIMIT\|LIMITE\|MINIMO\|MAXIMO)_?\w*\s*[=:]"` |

- **Cada `disabled={…}`, cada `if (…) return` com aviso no handler, cada `throw` de regra no
  backend e cada mensagem de erro do dicionário é uma regra a disparar.** Mensagem que existe no
  código e nunca foi vista na tela é caso pendente.
- **Limite → valor-limite:** constante `N` gera casos com `N-1`, `N`, `N+1`. Confira se a mensagem
  mostra o mesmo número que bloqueia (já houve "mínimo 50" exibido com a regra barrando 50).
- **A mesma regra em dois lugares** (front e back, ou duas telas): um item por cópia + um caso de
  consistência. Já aconteceu de a mesma constante estar errada nos dois lugares, e de uma correção
  feita em uma cópia deixar as outras três quebradas. **Função copiada e colada não é componente
  compartilhado:** liste todas as cópias com grep do nome e de um trecho característico.
- **Regra só no front** (o back não valida) é registrada como tal: o caso de chamar a API direto
  prova o furo.
- **Antes de concluir "a regra sumiu", rode `git log -S"<trecho>"`.** Ela pode ter sido removida de
  propósito, por decisão registrada.

Cada item de regra leva: enunciado em linguagem de negócio, onde está (front/back, arquivo:linha),
condição, mensagem e como disparar.

### 4.6 Modo PAPEL/PERMISSÃO

```bash
rg -n "hasPermission|usePermissions|can\(|ability\.|<Can |PermissionGate|@PreAuthorize|\[Authorize|AllowAnonymous|policy|@permission_required|permission_classes|authorize\(|Gate::|before_action|requireRole|roles?\s*:"
```

- **Monte a matriz:** linhas = ações (ver a tela, ver um campo, editar um campo, cada botão);
  colunas = papéis × eixos relevantes (§1.6); célula = permitido / proibido / condicional + **onde é
  decidido** (front, back, ambos).
- **Cada célula "proibido" gera dois casos:** a UI esconde ou desabilita **com motivo**; e a API
  chamada direto barra (401/403/422). Front que esconde e back que aceita é furo de segurança.
- **Dois eixos no mesmo botão:** quando papel e nível (ou plano) se combinam, a tela de permissões
  promete algo que o código não entrega. O tooltip precisa dizer qual eixo bloqueou.
- **Cruze os nomes:** permissões referenciadas no código × catálogo no banco. Permissão checada que
  não existe no catálogo nunca é concedida (ou só passa por flag global); permissão no catálogo que
  nenhum código checa não governa nada. Já foram achadas 5 checadas e inexistentes num só projeto.
- **Flags globais que curto-circuitam:** teste a combinação flag × permissão fina (a flag de
  "leitura global" já liberou edição de campo que a permissão fina negava).
- **Isolamento de tenant:** em cada listagem, combo, aviso e endpoint "todos"/"pendentes"/"por id",
  procure dado de outro tenant. Troque o id na URL e na requisição (IDOR).
- **Papel que não está logado:** o caso fica `bloqueado` com a justificativa "falta usuário
  `<papel>`; pedido ao usuário" — nunca omitido, nunca "não testado" sem dizer o quê falta.

### 4.7 Modo ESTADO

```bash
rg -n "enum \w*(Status|Situacao|Stage|Etapa|State|Fase)" ; rg -n "createMachine|aasm do|@transition|transitions="
```

Para cada entidade com ciclo de vida, liste:

- **estados**, **transições** (de → para, gatilho, quem pode, efeitos), **terminais**;
- **como alcançar cada estado:** pela UI desta tela, por **outro módulo** (já houve estado que só
  nascia pela conversão de outra entidade), **só com dois usuários diferentes** (já houve estado
  que exigia o segundo respondente), ou só por dado legado. Estado que a tela não alcança continua
  item: o caso diz como chegar, ou fica `bloqueado`/`nao-aplicavel` com o motivo;
- **ações disponíveis em cada estado**, inclusive **depois de fechar** (ganho, perdido, cancelado) e
  **antes de salvar** (rota `/novo`, registro ainda sem id);
- **transições inválidas** (tentar pela API o que a UI não oferece);
- se a tela mostra o estado certo. **A tela pode não ser fonte de verdade** para estado fechado:
  confira na API ou na listagem.

**Estados de tela** — genéricos, valem para toda tela: vazio · carregando · erro de API · sucesso ·
sem permissão · sessão expirada · lento (>3 s) · offline · durante o salvamento · depois de F5 ·
depois de voltar · com edição não salva ao trocar de aba.

### 4.8 Modo EFEITO EXTERNO

```bash
rg -n -i "smtp|sendmail|send_?email|mailer|nodemailer|sendgrid|brevo|mailgun|\bses\b|twilio|whatsapp|webhook|publish\(|enqueue|kafka|rabbit|sqs|pubsub|stripe|payment|pagamento|push|firebase|notifica"
```

Para cada efeito: gatilho, destinatários, síncrono ou assíncrono (dentro da requisição deixa o
`POST` lento), onde auditar (tabela, log, painel do provedor), seguro em teste?, autorizado?

Casos de cada efeito: dispara quando deve · **não dispara quando não deve** · destinatário certo
(sem pessoa real indevida) · conteúdo (assunto, corpo, links válidos para o ambiente) ·
**duplicação** (dois eventos para o mesmo fato já mandaram 32 avisos para 16 pessoas) · falha do
provedor (o que o usuário vê?) · preferência/opt-out (ordem de investigação quando não chega:
remetente/domínio → preferência → despacho/template).

Sem autorização para disparar: o caso fica `bloqueado` e a prova vai até o ponto anterior ao envio
(registro criado, auditoria gravada).

### 4.9 Modo DADO

- Entidades: models, migrações, `schema.prisma`, `schema.rb`, `DbSet<…>`, `@Entity`.
- Para cada entidade tocada pelo escopo: **CRUD × papel**; constraints (único, FK,
  cascade/restrict, soft delete); **o que NÃO deveria mudar** ao salvar (campo que a tela não
  carregou pode ser apagado); **órfãos depois de excluir** (linhas filhas que a exclusão esquece);
  exclusão barrada por FK com mensagem genérica de ORM; volume real (paginação, tempo da listagem).
- Anote no PERFIL os dados de teste reais permitidos e a **marca para achar a sujeira** depois
  (prefixo no nome, e-mail de teste com tag).

### 4.10 Modo I18N

- Estático: paridade de chaves em todos os locales (§1.7).
- Runtime: **todos os locales suportados em cada tela do escopo**, um caso por
  `i18n:<locale>:<rota>` — chave crua, texto cravado no idioma padrão, formato de data/moeda/número,
  texto que não cabe. Não é amostragem: o defeito de tradução costuma estar num locale só.
  `nao-aplicavel` só para locale que a tela não oferece (sem seletor nem rota para ele), com o motivo.

### 4.11 Modo VIEWPORT

- Breakpoints do projeto (config do CSS/framework). Viewports: 360–390 (celular), 768 (tablet),
  1024, 1280/1440 (desktop) e **cada breakpoint ±1 px**.
- Use ferramenta que **fixa o viewport de verdade** e confirme `innerWidth` e
  `matchMedia('(min-width: Npx)').matches`. Redimensionar a janela pode não mudar o viewport, e
  forçar largura por estilo pode ser anulado por `!important` (já deu falso negativo: sete
  medições idênticas que pareciam robustez e eram o estilo nunca aplicado).
- Mobile nativo: tamanhos, orientação, fonte do sistema ampliada, modo escuro.
- **Tema** (claro, escuro, alto contraste), quando o projeto suporta — `darkMode` no Tailwind,
  `prefers-color-scheme` no CSS, seletor de tema na tela, `data-theme`: é dimensão como o viewport.
  Cada tela do escopo ganha um item `tema:<tema>:<rota>` por tema, com o mínimo da §5.3 (contraste e
  nada invisível). Para alternar sem mexer na conta do usuário: `emulateMedia({ colorScheme })` no
  Playwright, ou o seletor da própria tela.

### 4.12 Modo FLUXO e bifurcações

- Liste as **bifurcações** de cada tela: escolhas (A × B), resultados terminais
  (ganhar × perder × cancelar × pular etapa), condicionais (campo que aparece com "Sim"), momentos
  (ação antes de salvar × depois de fechar), quem age (papel A solicita × papel B aprova), aceite
  Sim × Não, link usado × reenviado × antigo.
- **Cada caminho até o fim é um fluxo** (`fluxo:<tela>/<caminho>`) **com registro de dado novo** —
  não reaproveite um registro que já passou por outro caminho.
- Combinação explode? Parâmetros independentes → pairwise. Mas **todo resultado terminal e toda
  transição de estado é percorrido pelo menos uma vez.**

### 4.13 Superfície invisível — checklist

- [ ] rotas sem menu; acesso direto por URL; aliases e query params; deep links
- [ ] formulários públicos com token (link de e-mail); token expirado, consumido, regenerado
- [ ] endpoints sem tela; jobs/cron; webhooks de entrada; filas
- [ ] import/upload, export (CSV, Excel, PDF), impressão
- [ ] templates de e-mail e notificação
- [ ] embed/iframe/white-label; tema ou cores configuráveis pelo cliente
- [ ] atalhos de teclado; arrastar e soltar
- [ ] código morto (variante de componente que nada liga, rota sem importador) — listar como fora do
      escopo, com o motivo
- [ ] feature flag de produto — item `flag:<nome>` com casos **ligada e desligada** (cada estado da
      tela nas duas variantes, sem resto da outra; catálogo `DM-AMB-07`); `bloqueado` ("falta como
      alternar: …") só se não houver como alternar a flag no ambiente. Registre o provedor e como
      alternar no PERFIL §13.1 (Feature flags)
- [ ] telas de erro, 404, sessão expirada, manutenção
- [ ] dado legado (criado antes de uma regra nova) passando pela regra nova

### 4.14 Por tipo de projeto

| Tipo | Modos principais | Fontes e particularidades |
|---|---|---|
| **Web front** | rota, elemento, regra (front), papel (UI), estado de tela, i18n, viewport, a11y | API pela rede observada; backend como caixa-preta. **Usa BaaS** (Firebase/Firestore, Supabase, Appwrite)? Então a autorização inteira mora nas regras de segurança: `firestore.rules`, `storage.rules`, políticas RLS do Supabase viram itens `regra:`/`papel:`; para cada coleção ou tabela, teste pelo SDK ou REST com a chave pública + a própria sessão — ler, listar e (em teste, com autorização) gravar linha de outro usuário → negado; listar sem filtro → só as próprias; bucket de storage idem (catálogo `DM-TEN-09`) |
| **Full-stack** | todos | front e back no mesmo inventário; regra e papel cruzados entre as camadas |
| **API/backend** | api, regra, papel (policies), estado, dado, efeito | a "tela" é um cliente HTTP; cada endpoint com casos de auth, IDOR, payload inválido, paginação |
| **Mobile** | tela (navigator), elemento (`testID`/accessibility id), estado, viewport | offline, permissões do SO (câmera, notificação), deep links, push, segundo plano |
| **CLI** | `comando:<cli> <sub>` por subcomando e `comando:<cli> <sub> --<flag>` por flag (são ações: o gate cobra as cinco dimensões em cada um) | `--help` × comportamento, códigos de saída, stdin vazio, stdout × stderr, arquivos tocados, variáveis de ambiente. Cada caso roda com o cwd numa pasta temporária e com `HOME`, `XDG_CONFIG_HOME` e `APPDATA` apontando para pastas temporárias, para a precedência de configuração (`PJ-CLI-07`) não escrever no repositório nem no HOME do usuário; caso que precisa da configuração real do usuário só lê |
| **Biblioteca** | `funcao:<modulo>.<nome>` pública | a "tela real" é o **pacote empacotado** com destino fora do projeto (`npm pack --pack-destination <tmp>`, `cargo package --target-dir <tmp>`, `dotnet pack -o <tmp>`; `python -m build --outdir <tmp>` sempre numa cópia do projeto, porque cria `dist/` e `build/` e pode sobrescrever um `dist/` versionado) instalado num projeto consumidor no scratch, nunca o `src` importado direto. Depois de empacotar, confira o nome do wheel ou do tgz: `UNKNOWN` ou 0.0.0 = falhou. Sem pacote (offline, build isolado que baixa do PyPI): caminho B — rode do src com `PYTHONPATH=src` (ou o equivalente da linguagem), grave `--obs "artefato: src; pacote bloqueado em C-NNNN"` nos casos `funcao:` e `comando:`, deixe o caso `[PJ-LIB-07]` `bloqueado` com "destrava: …" e ponha o reteste no pacote na ressalva do não validado (o gate exige `[PJ-LIB-07]` passou ou bloqueado assim, e avisa de reteste feito fora do pacote). `prepack`/`prepare` executam código do projeto: o que sobrar no projeto vai para `sujeira`. Partição e limite dos parâmetros, exceções, tipos, exemplos do README como casos; superfície pública comparada com a última versão publicada (catálogo `PJ-LIB-07`, `PJ-LIB-08`) |
| **Jobs, filas, ETL** | `job:<nome>`, `fila:<topico>`, `consumidor:<nome>`, regra, efeito, dado | enumere pelo registro do agendador (cron, Hangfire, Celery beat, Quartz), pelos consumidores e pelos bindings de fila; dispare em dev pelo comando ou endpoint de trigger, ou por mensagem numa **fila de teste**; prova na tabela de execuções, na profundidade da fila e da DLQ antes e depois e no log pelo correlation id (catálogo §7.5) |
| **App com modelo de linguagem** | `prompt:<nome>`, `ferramenta:<nome>`, `fonte:<base indexada>`, papel, efeito | prompts e templates no código, ferramentas que o agente pode chamar (e o que cada uma grava), bases indexadas no RAG e quem pode ler cada uma; injeção direta e indireta, vazamento do prompt de sistema, dado de outro tenant recuperado, custo e não determinismo (catálogo §7.13 `PJ-LLM`) |
| **Desktop** (Electron/Tauri) | `janela:<nome>`, `ipc:<canal>`, `menu:<item>`, elemento, estado | janelas, canais de IPC expostos no preload (`contextBridge.exposeInMainWorld`, comandos do Tauri), menus, bandeja, atalhos globais, protocolo customizado, updater; arquivos que o app grava no perfil do usuário (catálogo §7.14 `PJ-DSK`) |
| **Jogo / canvas** | `cena:<nome>`, entrada por dispositivo, estado | inventário por cena (o DOM não vê o canvas, §4.3), estado de debug como oráculo, seed fixa, FPS e memória (catálogo §7.15 `PJ-GAM`) |
| **Site estático** | rota, elemento (links), efeito (formulário) | todas as páginas publicadas (sitemap × arquivos gerados), links internos e externos, metadados por página, formulário e consentimento de analytics (catálogo §7.16 `PJ-SIT`) |
| **Monorepo** | os do tipo de cada pacote | aplique a linha do tipo de cada pacote; todo pacote compartilhado alterado ganha regressão em **todos** os consumidores internos e build na ordem do grafo do workspace (tabela "Pacotes" do PERFIL; catálogo §1.4, linha Monorepo) |

### 4.15 Funções puras e hooks compartilhados

Em web e full-stack, a função pura compartilhada (formatador, cálculo, busca, parse de data, máscara,
hook de regra) é testada **direto**, não só pela tela que a usa: defeito como a busca que casa
qualquer dígito ou a data que muda com o fuso escapa ao teste da tela, porque cada tela exercita só
algumas entradas.

```bash
rg -n "from ['\"](@/|\.\./|\./)?(utils|helpers|shared|lib|hooks)/" <pastas-das-telas-do-escopo>
```

Cada função ou hook importado pelo alvo vira item `funcao:<modulo>.<nome>` (o mesmo id da
biblioteca), com os mínimos do catálogo §1.3 (linha `funcao:`): partição, limite, valores falsos que
são válidos (`0`, `""`, `[]`, dia 1), entrada real colhida da rede e chamada direta numa tabela de
entradas (script ou REPL do projeto).

---

## 5. Do inventário ao ledger

Crie o ledger com `scripts/cobertura.py init <pasta-da-rodada> --alvo "…"` e alimente-o com os
subcomandos `add-item`, `add-caso`, `add-defeito`, `add-sujeira` e `set` (rode `--help`): eles travam
o arquivo, geram os ids e recusam caso sem o campo que o gate exige. `validar` confere o esquema a
qualquer momento. `escopo` vai por `add-item --escopo`, `papel` por `add-caso/set --papel` e
`resultado_obtido` por `set --obtido` (com trava e checagem de segredo); `descoberto_por` vem do merge
do parcial. Não edite o `cobertura.json` à mão. A `dimensao` do caso vai por
`add-caso`/`set --dimensao <valor>`. `rodada.git`, `rodada.baselines`, `rodada.criticas`,
`rodada.contagens`, `rodada.tipos_projeto` e `rodada.modo` vão só pelo `cobertura.py rodada <rodada>
--git "<repo>|<branch>|<commit>"`, `--baseline "<gate>|<comando>|<resultado>|<composicao>"`,
`--critica "passada=N;novos_itens=N;novos_casos=N;origem=<texto>"`, `--contagem
"<modo>|<fonte>|<N no código>|<N no ledger>"`, `--tipo-projeto <slug>[,<slug>]` e `--modo
completo|reteste|revisao` (§0). O formato completo, com todos os status, está em
`templates/cobertura.exemplo.json`; todo título de caso começa pelo código do catálogo
(`[EL-TXT-07] ...`): é por ele que `cobertura.py secoes` conta a seção.

Seção ou módulo inteiro que não se aplica vira caso `nao-aplicavel` num item `dimensao:<prefixo>`,
cada um com o **seu** porquê: três ou mais com a mesma justificativa são erro (`na-em-lote`). Em
projeto `front-web`, `full-stack`, `api`, `mobile`, `desktop` ou `llm`, as seções P0 `DM-TEN`, `DM-AUT`,
`DM-SEC`, `DM-SES` e o módulo `MA-6` (com ou sem `-NN`) só aceitam `nao-aplicavel` com `arquivo:linha`
na justificativa ou evidência em disco (`na-p0-sem-prova`); `dimensao:QC` só com "sem código-fonte
acessível: …" (catálogo §1.1, passo 5).

### 5.1 IDs

Gramática: `<tipo>:<caminho>`.

| Tipo | Caminho | Exemplo |
|---|---|---|
| `tela` | rota normalizada (sem grupo de rota; parâmetro como `[id]`) | `tela:/clientes/[id]` |
| `elemento` | `<rota>#<slug>` (slug do `data-testid` ou do rótulo, kebab-case, sem acento) | `elemento:/clientes/novo#botao-salvar` |
| `api` | `MÉTODO /rota/{param}` | `api:POST /api/v1/cliente` |
| `regra` | `<entidade>.<regra>` | `regra:cliente.cnpj-obrigatorio` |
| `papel` | slug do papel (ou papel×eixo) | `papel:somente-leitura` |
| `estado` | `<entidade>.<estado>` | `estado:oportunidade.ganha` |
| `fluxo` | `<tela>/<caminho>` | `fluxo:oportunidade/skip-poc-e-ganhar` |
| `efeito` | `<canal>.<evento>` | `efeito:email.oportunidade-criada` |
| `dado` | `<entidade>` ou `<entidade>.<constraint>` | `dado:cliente.cnpj-unico` |
| `i18n` | `<locale>:<rota>` | `i18n:en-US:/clientes/novo` |
| `viewport` | `<largura>:<rota>` | `viewport:390:/clientes/novo` |
| `componente` | nome do componente compartilhado | `componente:DatePicker` |
| `comando` / `funcao` / `job` | CLI, biblioteca ou função pura compartilhada do web (§4.15), rotina agendada | `comando:app export --csv`, `funcao:utils/data.formatarData` |
| `flag` | nome da feature flag de produto | `flag:novo-checkout` |
| `tema` | `<tema>:<rota>` | `tema:escuro:/clientes/novo` |
| `fila` / `consumidor` | fila ou tópico de teste; consumidor | `fila:pedidos.criados`, `consumidor:faturamento` |
| `prompt` / `ferramenta` / `fonte` | app com modelo de linguagem: prompt ou template; ferramenta do agente; base indexada | `prompt:resumo-do-ticket`, `ferramenta:enviar-email`, `fonte:base-de-ajuda` |
| `janela` / `ipc` / `menu` | desktop | `janela:principal`, `ipc:salvar-arquivo`, `menu:arquivo/exportar` |
| `cena` | estado ou cena de jogo/canvas | `cena:fase-1` |
| `modulo` | pasta ou módulo estudado (`references/qualidade-e-refatoracao.md` §2) | `modulo:src/app/clientes` |
| `arquivo` | arquivo do diff ou do raio de impacto (modo PR, `escopo_diff.py`) | `arquivo:src/components/Botao.tsx` |
| `seguranca` | assunto da varredura de segurança (MA-6) | `seguranca:dependencias/npm`, `seguranca:segredos`, `seguranca:cabecalhos/<host>` |
| `estatico` | gate de baseline (typecheck, lint, testes, build), com o comando no título; com correção, o gate final exige um caso ligado ao defeito corrigido (`--defeito D-NNN`) com status `passou` e evidência de **texto** com o número antes e depois (`antes: 308 erros … depois: 308 erros`; imagem não conta), ou `bloqueado` ("gate não executável: …") | `estatico:typecheck`, `estatico:lint` |
| `dimensao` | seção do catálogo ou módulo inteiro que não se aplica, para registrar a decisão (`cobertura.py secoes` lista o que falta) | `dimensao:DM-I18`, `dimensao:MA-3`, `dimensao:MO-7` |

Itens vindos de ferramenta levam `descoberto_por`: `diff`, `raio-de-impacto`, `diff-chamada-front`
(do `escopo_diff.py`), `estudo` (da fase 2) ou `critico`.

- **Estável e legível.** Nunca posição ("botao-3") nem texto que muda (contador, data).
- **Nunca renumere nem reaproveite id.** Item que deixa de existir não some do ledger: o caso dele
  vira `nao-aplicavel` com o motivo.
- Casos: `C-0001`, sequencial na rodada. Defeitos: `D-001`.

### 5.2 Formato do item

```json
{
  "id": "elemento:/clientes/novo#botao-salvar",
  "tipo": "elemento",
  "titulo": "Botão Salvar do formulário de cliente",
  "pai": "tela:/clientes/novo",
  "origem": "src/app/clientes/novo/page.tsx:212 · data-testid=cliente-save-button",
  "descoberto_por": ["elemento-estatico", "elemento-runtime"],
  "escopo": "dentro",
  "notas": "desabilitado durante o POST, com rótulo 'Salvando…'"
}
```

Cada caso traz, além dos campos que o gate exige (`item_id`, `tecnica`, `resultado_esperado`,
`status`, `evidencias`, `defeito_id`, `justificativa`): `titulo`, `passos` (a entrada exata),
`oraculo`, `dimensao`, `papel` e `resultado_obtido`.

`descoberto_por` diz quais modos acharam o item. Item que só o crítico ou a exploração acharam
aponta o modo que falhou — é o insumo da próxima rodada.

### 5.3 Item → casos (mínimo obrigatório)

**Toda ação tem os cinco resultados:** `acerto`, `erro`, `limite` (n-1, n, n+1), `bloqueio` e
`risco` (o antigo "o-que-pode-dar-errado"). Cada caso grava a sua no campo `dimensao`, com
`cobertura.py add-caso … --dimensao <valor>` ou `cobertura.py set … --dimensao <valor>`. O gate final
exige as cinco em todo item de ação do escopo: `elemento:`, `api:`, `comando:`, `funcao:`, `job:`,
`consumidor:`, `ipc:`, `menu:` e `ferramenta:`. Quando uma não se aplica, **crie o caso mesmo
assim**, como `nao-aplicavel` e com justificativa (ele conta para o gate): tornar a ausência explícita
é o ponto.

O gate final também cobra, nos itens com escopo `dentro` (catálogo §1.3): em `tela`, um `elemento:`
filho (campo `pai`) ou o caso `nao-aplicavel` "tela sem controles: <porquê>", um caso `[EL-EST-NN]`
e um `[DM-NAV-NN]`, e um item `i18n:`/`tema:`/`viewport:` com caso para cada valor de
`rodada --locales`, `--temas` e `--viewports`; em `papel`, um caso de `bloqueio` com técnica `rbac`
ou `seguranca`; em `estado`, a transição inválida (`transicao-estado` + `bloqueio`); em `efeito`, o
caso de `bloqueio` ("não dispara quando não deve"); em `flag`, dois casos concluídos ou um `bloqueado`
"falta como alternar: …"; em `elemento` com `tipo_elemento`, o caso da subseção do catálogo. Cada falta
sai com o comando que a resolve.

| Tipo do item | Casos mínimos (técnica) |
|---|---|
| `tela` | carrega com dado real (exploratorio) · vazio/carregando/erro (transicao-estado) · sem permissão e URL direta (rbac) · F5, voltar, deep link (erro-adivinhado) · teclado e foco (a11y) · viewport (responsivo) · cada locale suportado (i18n) · cada tema, se houver (a11y) · tempo de carga (desempenho) |
| `elemento` — botão/ação | executa e **prova o efeito** (crud/api) · dispara a validação (tabela-decisao) · desabilitado/oculto **com motivo** (rbac, transicao-estado) · duplo clique, clique durante o carregamento, Enter/Esc (erro-adivinhado) |
| `elemento` — campo | partição válida/inválida (particao) · `N-1`/`N`/`N+1` (valor-limite) · vazio, só espaços, espaços nas pontas, colado, acentos, máscara, blur (erro-adivinhado) · obrigatório sinalizado e destacado ao barrar · foco não se perde ao digitar cruzando uma regra |
| `elemento` — select/busca/lista | opção única vem pré-selecionada? · escolher **com busca ativa**, limpar a busca: o marcado continua o mesmo e é ele que entra? · busca sem resultado cita o termo · ordem e repetidos |
| `api` | contrato feliz: status + corpo + banco (api, banco) · sem autenticação (seguranca) · papel errado (rbac) · id de outro tenant (seguranca) · payload inválido ou ausente (particao) · repetição/idempotência (erro-adivinhado) · volume e paginação (desempenho) |
| `regra` | cada linha da tabela de decisão (tabela-decisao) · limites (valor-limite) · front × back, chamando a API direto (api) |
| `papel` | cada célula da matriz: permitido (rbac) e proibido **na UI e na API** (rbac, seguranca) |
| `estado` | cada transição válida e cada inválida (transicao-estado) · ações disponíveis no estado · a tela mostra o estado certo (banco) |
| `fluxo` | o caminho inteiro até o resultado terminal, conferido no banco e a jusante (exploratorio, banco) |
| `efeito` | dispara · não dispara quando não deve · destinatário · conteúdo · duplicação · falha do provedor (api, banco) |
| `dado` | CRUD × papel (crud) · unicidade e FK (erro-adivinhado) · órfãos · o que não deveria mudar (banco) |
| `i18n` | chave crua, texto cravado, formatos (i18n) |
| `viewport` | sem rolagem horizontal, nada cortado, ações alcançáveis (responsivo) |
| `componente` | regressão em pelo menos um outro uso real, quando alterado (regressao) |
| `comando` (CLI) | `--help` · cada flag (particao, valor-limite) · código de saída no erro · stdin vazio · arquivo inexistente ou sem permissão |
| `funcao` (biblioteca ou função pura do web, §4.15) | partição e limite dos parâmetros · valores falsos válidos (`0`, `""`, `[]`, dia 1) · entrada real colhida da rede · exceções documentadas · tipo errado (particao, valor-limite) |
| `flag` | cada estado da tela com a flag ligada e desligada, sem resto da outra variante (transicao-estado) |
| `tema` | contraste medido e nada invisível (texto, ícone, borda, foco) em cada tema (a11y, responsivo) |
| `job` / `fila` / `consumidor` | catálogo §7.5: dispara no horário e por trigger, idempotência, mensagem venenosa e DLQ, ordem, schema antigo × novo |
| `prompt` / `ferramenta` / `fonte` | catálogo §7.13: injeção direta e indireta, vazamento, fonte citada existe, N execuções com taxa de acerto, custo e tokens |
| `janela` / `ipc` / `menu` | catálogo §7.14 |
| `cena` | catálogo §7.15 |

Além disso, leia `references/catalogo-de-testes.md` por tipo de elemento: ele tem a lista viva de
testes que não podem faltar.

### 5.4 Oráculo — de onde vem o "esperado"

Todo caso tem `resultado_esperado` **e** `oraculo`. Fontes, da mais forte para a mais fraca:

1. regra explícita do usuário ou do time (com data e quem decidiu);
2. especificação ou documentação do produto;
3. código do backend (o que o servidor aceita e recusa);
4. código do front;
5. comportamento anterior (`git log -S`, versão publicada);
6. convenção do design system;
7. expectativa razoável de usuário — marcada como tal.

**O código diz o que foi decidido por último, não o que é certo.** Antes de chamar uma mudança de
regressão, procure no `git log` se ela foi intencional. **Sem oráculo, não invente:** o caso
registra o comportamento observado e vira pergunta de produto (defeito do tipo
`decisao-de-produto`).

### 5.5 Escala

Centenas de casos são normais. **Não amostre:** organize por item, execute em lotes e, quando o
volume justificar, divida entre agentes (`references/multiagente.md`).

---

## 6. Crítico de completude (loop-until-dry)

Depois do inventário — e de novo antes do gate — rode o crítico. Ele procura o que **ficou de
fora**, não o que está certo.

**1. Reconcilie as contagens entre modos.** Toda diferença vira item novo ou explicação escrita:

| Comparação | Diferença significa |
|---|---|
| telas no router × links do menu × telas visitadas | rota sem menu, ou tela não visitada |
| endpoints no swagger × controllers × observados na rede | endpoint sem UI, ou fluxo não percorrido |
| botões no código × no DOM (por estado) | estado não visitado, ou cópia oculta |
| permissões no código × catálogo no banco | permissão inexistente, ou que não governa nada |
| mensagens de erro no dicionário × disparadas | regra nunca exercitada |
| estados no enum × estados alcançados | estado sem caminho conhecido |

**2. Responda às perguntas:**

- Algum modo aplicável não rodou? Por quê?
- Alguma rota sem item `tela:`? Alguma tela sem os estados vazio/carregando/erro?
- Algum elemento sem caso? Algum desabilitado sem caso do motivo?
- Alguma ação sem os cinco resultados (`acerto`, `erro`, `limite`, `bloqueio`, `risco`)?
- Algum papel fora da matriz? Alguma célula "proibido" sem caso de API direta?
- Algum estado sem "como alcançar"? Alguma transição inválida sem caso?
- Alguma mensagem de erro do código que ninguém disparou?
- Alguma bifurcação sem fluxo próprio, com registro novo?
- Algum endpoint sem UI fora do inventário?
- Algum efeito externo sem o caso "não dispara quando não deve"?
- Algum componente compartilhado alcançado ou alterado sem caso de regressão em outro uso?
- A superfície invisível (§4.13) foi percorrida?
- i18n e viewport foram considerados?
- Algum item `escopo: "fora"` sem justificativa?

**3. Registre cada passada** com
`cobertura.py rodada <rodada> --critica "passada=2;novos_itens=3;novos_casos=11;origem=reconciliação swagger × rede"`
(vai para `rodada.criticas`; nunca à mão).

**4. Repita até duas passadas seguidas sem item novo e sem caso novo.** Uma passada vazia pode ser
cansaço; duas seguidas é o critério.

**5. Olhos frescos na passada final**, quando possível: outro agente instruído a **achar o que
falta** (não a confirmar o que existe).

**O inventário continua vivo durante a execução.** O que aparecer na tela e não estiver no ledger
entra na hora (`descoberto_por: ["exploracao"]`), com seus casos. O crítico roda de novo antes do
gate.

---

## 7. Escopo

| Pedido | O inventário cobre | Fica fora (mas listado) |
|---|---|---|
| **"tela X"** | a tela **inteira**: todos os elementos, estados, papéis que a acessam, APIs que ela chama, regras, efeitos a jusante, bifurcações; + regressão dos componentes compartilhados alterados | outras telas que usam os mesmos componentes (listadas; pelo menos uma exercitada quando o componente for alterado) |
| **"fluxo Y"** | todas as telas do fluxo, inteiras no que o fluxo toca; todas as bifurcações; efeitos conferidos no destino (contrato gerado, e-mail, notificação) | funções das telas que o fluxo não toca |
| **"módulo Z"** | todas as rotas e telas do módulo, APIs, estados das entidades, papéis, efeitos | outros módulos, exceto onde o módulo Z gera dado neles |
| **"projeto inteiro"** | todos os modos sobre tudo; organize por módulo e divida entre agentes | — |
| **"esta correção / PR"** | o diff + tudo que usa o que mudou (grep dos símbolos alterados) + o reteste do defeito | — |

**Escopo pequeno reduz a largura, nunca a profundidade.** Mesmo em "só a tela X", tudo daquela
tela é coberto — porque "testei a tela" com metade dos botões nunca clicados soa completo e engana
quem decide em cima do relatório.

**O que fica fora entra no ledger** como item com `"escopo": "fora"` e um caso `nao-aplicavel` com
justificativa ("fora do escopo da rodada: …"). A fronteira fica visível no relatório, e a próxima
rodada sabe por onde começar.

---

## 8. Checklist de saída desta fase

- [ ] Regras do projeto e do usuário lidas e anotadas, com fonte e data
- [ ] `.qa/PERFIL.md` criado ou atualizado (sem nenhum segredo)
- [ ] `.qa/` no `.git/info/exclude`
- [ ] Ambiente confirmado **por medição** (front → API, API → banco) e registrado
- [ ] Autorizações registradas — ou o mais restritivo assumido e anotado
- [ ] Branch, commit base e git status inicial registrados
- [ ] Baselines medidos, com a composição do número
- [ ] Inventário em todos os modos aplicáveis, com a contagem por modo gravada
      (`cobertura.py rodada --contagem`, uma por tipo de projeto declarado; regravar o mesmo modo e
      fonte substitui a anterior, que vai para `contagens_historico`); `cobertura.py reconciliar`
      só com UI (web, mobile, desktop; sem UI, nota 02-inventario com "reconciliar: não se aplica, sem
      elementos em runtime") e `escopo_diff.py --tudo --so-inventario --ledger … --falhar-se-descoberto`
      saindo 0 (o `--falhar-se-descoberto` completo, sem `--so-inventario`, vale nas fases 8 e 9, e o
      `fechar` o roda sozinho fora do modo PR e do reteste)
- [ ] Todo item no ledger com pelo menos um caso; toda ação com os cinco resultados (`acerto`,
      `erro`, `limite`, `bloqueio`, `risco`), cada um com a `dimensao` gravada
- [ ] Todo caso com `resultado_esperado` e `oraculo`
- [ ] Crítico de completude: duas passadas seguidas sem novidade
- [ ] `notas/01-perfil-e-ambiente.md` e `notas/02-inventario.md` escritas
- [ ] Resposta ao usuário diz o que foi registrado

Próximo passo: `references/execucao-e-evidencias.md`.
