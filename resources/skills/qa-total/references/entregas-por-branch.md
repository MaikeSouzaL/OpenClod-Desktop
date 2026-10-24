# Entregas por branch: separar o trabalho acumulado por assunto, com prova

Carregue quando o usuário pedir para **separar por assunto, por branch ou por PR** o que está aberto no
working tree, ou quando a rodada acumulou correções de assuntos diferentes e ele vai subir cada uma
separada. Script: `scripts/entregas.py` (rode `--help` e `<comando> --help`). Modelo de mapa:
`templates/blocos.exemplo.json`.

O resultado é uma pasta por branch, com o patch de cada repositório, o texto da PR, a mensagem de
commit, os comandos de aplicar e o PDF de provas. **Quem cria a branch, commita e sobe é o usuário.**

## Sumário

1. Quando usar e quando não
2. O que o script garante e o que ele nunca faz
3. Passo a passo
4. Passo 0 do usuário (vai no COMO-APLICAR.md)
5. O que NÃO fazer
6. Armadilhas
7. Códigos de saída e checklist
8. Projeto sem VCS

---

## 1. Quando usar e quando não

| Situação | Caminho |
|---|---|
| Vários assuntos misturados no working tree (dias de QA e correção), e o usuário quer uma PR por assunto | Este guia |
| Um assunto só | Branch sugerida e mensagem de commit em bloco copiável (`correcao-e-relatorio.md` §8.4). Não separe |
| Um assunto tem efeito colateral conhecido e precisa ficar de fora por enquanto | Este guia, com o bloco marcado `segurar` |
| O usuário não pediu separação | Não separe por conta própria. Proponha em uma frase, se fizer sentido |
| O projeto não usa git (zip, SVN, Perforce, pasta solta) | Não há branch: patch por assunto arquivo a arquivo (§8); o `entregas.py` não se aplica |

**Porquê:** um diff com 13 assuntos é irrevisável e faz o revisor reverter tudo junto (já aconteceu:
uma PR de 47 mil linhas, das quais 1,4 mil eram mudança real, foi revertida inteira).

---

## 2. O que o script garante e o que ele nunca faz

| Garante | Como |
|---|---|
| Separação por **trecho** (hunk), não por arquivo | Mapa arquivo → bloco, ou arquivo → {índice do trecho → bloco} |
| Nenhum trecho sem dono e nenhum com dois donos | `separar` recusa e não grava nada |
| Cada bloco aplica **sozinho** na base | `git apply --cached --check` num índice temporário (`GIT_INDEX_FILE`) |
| A **soma** de todos reproduz o working tree **byte a byte** | Aplica todos em ordem e compara cada arquivo com `git hash-object --no-filters` |
| Fim de linha preservado | O diff é lido e gravado em bytes; CRLF continua CRLF dentro do patch |
| Dependências reveladas | `typecheck` numa cópia limpa: base, cada bloco sozinho, com as deps e todos |
| Patch desatualizado é pego | `verificar` refaz a separação e compara com o que está em disco |

| Nunca faz | Por quê |
|---|---|
| `git checkout -b`, `commit`, `push`, `merge`, PR, `stash` | Quem versiona é o usuário. Os comandos saem como **texto** no `APLICAR.txt` |
| Mexer no índice real, no working tree ou no `.git` | Tudo roda com `GIT_INDEX_FILE` e `GIT_OBJECT_DIRECTORY` temporários (os objetos novos vão para uma pasta temporária, não para o `.git`) |
| Copiar arquivo inteiro de um bloco para outro | Arquivo de idioma, de tipos e de rotas costuma ter trechos de vários assuntos |
| Apagar coisa que não criou | Só remove os próprios `<repo>.patch` velhos; pasta de bloco que sumiu do mapa só gera aviso |
| Entregar segredo | `separar`, `verificar` e `comandos` varrem as linhas `+` de cada patch (§3.4) e recusam o bloco com segredo ou com arquivo de credencial; o texto do próprio mapa também é varrido (§3.2) |
| Executar o que gera | `APLICAR.txt` e `COMO-APLICAR.md` abrem com "PARA O USUÁRIO": nenhum agente roda esses comandos; o usuário roda |

---

## 3. Passo a passo

```bash
QA="$HOME/.claude/skills/qa-total"
M=".qa/entregas/mapa.json"     # o mapa fica fora do código: .qa/ ou a pasta da entrega
python "$QA/scripts/entregas.py" hunks --repo front=E:/proj/front --repo back=E:/proj/api --rascunho "$M"
python "$QA/scripts/entregas.py" validar   --mapa "$M"
python "$QA/scripts/entregas.py" backup    --mapa "$M"
python "$QA/scripts/entregas.py" separar   --mapa "$M" --simular
python "$QA/scripts/entregas.py" separar   --mapa "$M"
python "$QA/scripts/entregas.py" verificar --mapa "$M"
python "$QA/scripts/entregas.py" typecheck --mapa "$M"          # se o projeto tem typecheck
python "$QA/scripts/entregas.py" comandos  --mapa "$M"
python "$QA/scripts/entregas.py" tudo      --mapa "$M" --typecheck   # backup+separar+verificar(+typecheck)+comandos
python "$QA/scripts/provas.py"   gerar     <saida>/NN-<branch>/provas.json --pr --conferir   # depois de preencher os itens
python "$QA/scripts/provas.py"   indice    <saida>
```

No PowerShell, um comando por linha, sem `\`.

### 3.0 Antes de separar: o ponto de partida

1. **Estado inicial de cada repositório** (`git status --short`, branch, `git log -1 --oneline`), já
   registrado em `notas/00-git-status-inicial.txt` na fase 0. O que estava alterado antes da rodada é de
   **outra sessão**: no mapa vira `fora` (fica no stash e no backup), nunca é revertido nem misturado num
   bloco.
2. **Fim de linha:** `git diff --stat` igual a `git diff --ignore-cr-at-eol --stat` em cada repo. O
   `separar` recusa arquivo cujo diff é troca de fim de linha (ver §6). Restaure o fim de linha original
   antes.
3. **Baseline do typecheck** do HEAD (o `typecheck` mede de novo numa cópia limpa, mas o número da
   raiz serve de conferência).
4. **Base de cada repo:** a branch de onde as branches novas vão sair (`develop`, `main`), em
   `repos.<nome>.base`. Confira com `git branch -a` e `git log --oneline -20` o padrão de nome de branch
   e de mensagem de commit do repositório.

### 3.1 Ver os trechos: `hunks`

`hunks` lista, por repositório, cada arquivo alterado com o fim de linha, o tipo (novo, apagado,
binário) e cada trecho: índice, cabeçalho `@@`, `+N -N`, assinatura e as primeiras linhas alteradas.
Com `--mapa`, mostra o dono de cada trecho (`SEM DONO` e `DOIS DONOS` em destaque) e sai 1 se houver
pendência. Com `--json`, grava tudo em JSON. Com `--rascunho mapa.json`:

- mapa novo: cria o esqueleto com os repos, um bloco de exemplo e **cada trecho com `"?"`**;
- mapa existente: guarda uma cópia `.bak-<data>`, acrescenta só os arquivos novos e avisa os que
  **mudaram** (número de trechos ou assinatura) e os que saíram do diff. Nunca troca um dono que você já
  escreveu.

Arquivo novo **não rastreado** não aparece no `git diff`: o `hunks` avisa. Para entrar na entrega, ponha
`"incluir_novos": true` no repo.

### 3.2 Montar o mapa

Formato completo em `templates/blocos.exemplo.json`. Campos:

| Campo | Para quê |
|---|---|
| `saida` | Pasta da entrega, relativa ao mapa. Fora do código do projeto |
| `contexto` | Linhas de contexto do diff (padrão 3). **Os índices dos trechos dependem dele** |
| `ordem` | Ordem sugerida de aplicar e de somar (padrão: a ordem de `blocos`). Dependência vem antes |
| `repos.<nome>` | `caminho`, `base`, `remoto`, `incluir_novos`, `typecheck` (§3.6). O nome vira `<nome>.patch` |
| `blocos[].id` | `01`, `02`... é o prefixo da pasta e a ordem visual |
| `blocos[].branch` | Nome da branch, no padrão do repo. Validado com `git check-ref-format` |
| `blocos[].repos` | Repos do bloco, **na ordem em que o usuário vai aplicar** (backend antes do front que depende dele) |
| `blocos[].deps` | Blocos que precisam subir antes (props novas de componente compartilhado, contrato de API) |
| `blocos[].empilhar` | `true` quando o bloco só aplica **por cima** da dependência: a branch nasce da branch da dep |
| `blocos[].segurar` | `{"causa": "...", "saidas": ["...", "..."]}`: efeito colateral conhecido; não abrir PR ainda |
| `blocos[].commit` | Mensagem final (texto, ou `{repo: texto}`). Sem ela sai um rascunho para revisar |
| `resumo`, `itens`, `nao_validado`, `atencao`, `fora_do_bloco` | Viram o `PR.md` e as seções do PDF |
| `mapa.<repo>.<arquivo>` | `"01"` (arquivo inteiro), ou `{"*": "05", "0": "01", "3-5": "fora"}` por trecho |

**Segredo no texto do mapa.** O mapa é escrito à mão a partir da causa dos defeitos, e os textos dele
viram o `COMMIT-<repo>.txt` (que vai para o histórico e para o remoto com `git commit -F`), o `PR.md`, o
`APLICAR.txt`, o `COMO-APLICAR.md` e o `provas.json`. Por isso todo comando que lê o mapa passa título,
`resumo`, `itens`, `nao_validado`, `atencao`, `fora_do_bloco`, `commit` e `segurar` pela máscara estrita
(`scripts/_mascara.py`): achou token, JWT, chave de nuvem, `Bearer` ou senha, sai **1** com
`SEGREDO no mapa: bloco NN campo <campo> (<tipo>)`, sem o valor, e não grava nada. Descreva o tipo de
dado ("o token de teste aparecia no log"), nunca o valor. Como segunda barreira, o `comandos` passa pela
mesma máscara tudo o que grava: o que trocar vira `[REMOVIDO]` e a saída é 1.

**Como agrupar:**

- **Um bloco = o que o revisor lê junto e pode subir sozinho.** Assunto de negócio (tela, fluxo), não
  tipo de arquivo. Componente compartilhado mexido por vários assuntos vira bloco próprio e **cedo**; os
  blocos que usam a prop nova declaram `deps`.
- **Backend + front do mesmo assunto ficam no mesmo bloco**, com `repos: ["back", "front"]`: o
  `APLICAR.txt` segue essa ordem, e o PDF explica a ordem de deploy (o front novo trata a resposta nova
  do backend).
- **Arquivos de idioma, de tipos e de rotas** quase sempre misturam assuntos: separe por trecho. Cada
  chave nova vai com o bloco que a usa, inclusive a declaração no arquivo de tipos.
- **Bloco com efeito colateral conhecido** (a correção funciona, mas quebra outra tela até um ajuste)
  vai com `segurar`, a causa e as saídas. Ele continua com patch, PDF e comandos, mas tudo diz "não abrir
  PR ainda". Exemplo real: o filtro que fechou um vazamento entre tenants zerou a tela de aprovação.
- **`fora`**: trabalho de outra sessão, experimento descartado, arquivo que não é deste assunto. Gera
  `00-fora/<repo>.patch` para nada se perder, e entra na soma da verificação.

**Regras das chaves:**

- Caminho **exato** vence padrão. Padrão usa `*`, `?` e `[...]`, e `*` casa também `/`. Dois padrões que
  casam o mesmo trecho com donos diferentes são erro (`DOIS DONOS`).
- Caminho que existe no repo é sempre **literal**, mesmo com colchetes (`app/clientes/[id]/page.tsx`).
  Para um **padrão** que precisa casar colchete literal, escape: `app/clientes/[[]id]/*`.
- Dentro do arquivo: índice (`"3"`), intervalo (`"2-5"`) e `"*"` (os demais). Índice e intervalo que
  casam o mesmo trecho com donos diferentes: `DOIS DONOS`. Índice que não existe no arquivo: erro (mapa
  velho).
- `"?"` é trecho sem dono: o `separar` recusa até você decidir.
- `_n`, `_eol`, `_assinaturas`, `_resumo` e qualquer chave com `_` são metadados do rascunho. `_n` e
  `_assinaturas` **protegem você**: se o arquivo for editado depois do mapa, o `separar` recusa em vez de
  mandar o trecho novo para o bloco errado.

**Trecho que mistura dois assuntos:** gere de novo com `"contexto": 1` (trechos menores; refaça o mapa,
os índices mudam). Se ainda assim os dois assuntos dividem o mesmo trecho, junte-os num bloco só ou ponha
os dois blocos em sequência com `deps` + `empilhar`. **Nunca edite o patch à mão:** a soma deixa de
bater e a prova acaba.

Arquivo novo, apagado ou binário é sempre **um trecho só** (não se divide).

### 3.3 `backup`, antes de qualquer outra coisa

Grava em `<saida>/00-backup/`: `<repo>-tudo.patch` (o diff inteiro, binário incluso),
`<repo>-status.txt`, `<repo>-head.txt` (commit, branch, data e o comando para reaplicar tudo) e
`<repo>-novos/` (cópia dos arquivos não rastreados). Rodou de novo? O backup anterior vai para
`00-backup/anterior-<data>/`, nunca é sobrescrito. É a segunda cópia do Passo 0 do usuário (§4).

### 3.4 `separar`

Rode primeiro com `--simular` (só a tabela por bloco: repos, arquivos, trechos, `+`, `−`, `SEGURAR`).
Depois sem ele. Gera:

```
<saida>/
  NN-<branch com / trocado por __>/<repo>.patch    um por repo do bloco
  00-fora/<repo>.patch                              trechos marcados "fora"
  entrega.json                                      manifesto (§3.8)
```

Recusa e **não grava nada** com: trecho sem dono, dois donos, índice inexistente, arquivo que mudou
depois do rascunho, bloco que recebeu trecho de um repo que não declarou, ou diff inflado por fim de
linha (§6; `--aceitar-fim-de-linha` só se a troca é intencional e o usuário sabe).

**Segredo bloqueia a entrega.** `separar`, `verificar` e `comandos` (e o `tudo`) varrem as linhas `+`
de cada patch com as regras do `segredos.py` e recusam, pelo nome, arquivo de credencial (`.env*`,
`*.pem`, `*.pfx`, `*.p12`, `*.key`, `id_rsa*`; `appsettings*.json` com `Password=`), salvo o que está
em `fora` e o `.env.example`. A saída diz `SEGREDO no bloco NN [repo]: arquivo:linha regra (descricao)`,
nunca o valor; `separar` não grava nada, `comandos` não gera (e apaga) o `APLICAR.txt` do bloco e
`verificar` reprova. Tire o segredo do trecho (ou ponha o arquivo em `fora`) e rode de novo. `hunks`,
`--json` e o `_resumo` do rascunho saem mascarados; o `backup` avisa quando guarda segredo local
(fica só na máquina do usuário).

### 3.5 `verificar`: a prova da separação

Para cada repo:

1. **Desatualizado?** Refaz a separação e compara com os patches em disco. O working tree mudou depois do
   `separar`: rode `separar` de novo.
2. **Cada bloco sozinho** sobre o HEAD, sobre a `base` do repo (se for outro commit) e sobre cada
   `--contra <rev>` (ex.: `origin/develop` depois de um `git fetch` que **o usuário** fez): `git apply
   --cached --check` num índice temporário. Bloco `empilhar` é checado por cima das dependências. Se um
   bloco só aplica depois de outro, a linha diz isso.
3. **Soma de todos**, na ordem, mais os trechos `fora`: cada arquivo do diff comparado com o arquivo do
   working tree por `git hash-object --no-filters` (bytes). Arquivo que só bate depois do filtro de fim de
   linha do git (`core.autocrlf`, `.gitattributes`) é contado à parte, e a linha diz quantos. Arquivo
   alterado pela soma e fora do diff também é diferença.

Saída 0 = **separação provada**. O resultado vai para `entrega.json` → `verificacao`, que o PDF cita.

**Porquê `hash-object` arquivo a arquivo e não `git add -u`:** num índice novo, `git add -u` marca como
alterados centenas de arquivos antigos só por fim de linha (o índice real os dava como limpos pelo
`stat`), e a comparação acusa "diferente" sem ser.

**FALHA ao aplicar sozinho** sobre o HEAD: dois blocos tocam linhas vizinhas. Junte os trechos num bloco,
ou declare `deps` + `empilhar`. **FALHA só no `--contra`**: a base andou; a entrega ainda vale para o
HEAD, mas o usuário vai esbarrar no `git apply --check`. Avise e, se ele quiser, refaça a separação
sobre a base nova (é ele quem atualiza o repo).

### 3.6 `typecheck` por bloco: as dependências que o texto não mostra

Um patch pode aplicar sozinho e mesmo assim não compilar sozinho (usa a prop nova de outro bloco). O
`typecheck` revela isso:

1. extrai o HEAD com `git archive` numa **cópia limpa fora do repositório** (pasta temporária do
   sistema);
2. liga na cópia as pastas pesadas do repo real (`links`, padrão `node_modules`) por junction ou
   symlink, que são removidas **antes** de apagar a cópia (nunca se apaga o alvo);
3. roda o comando na base, em cada bloco sozinho, em cada bloco com o fecho das `deps` e em todos;
4. conta as linhas que casam `contar` e grava o log de cada execução em `<saida>/00-typecheck/<repo>/`.

Configure em `repos.<nome>.typecheck` ou na linha de comando:

| Stack | `comando` | `contar` |
|---|---|---|
| TypeScript | `npx tsc --noEmit --incremental false -p .` | `error TS` |
| Python (mypy / pyright) | `mypy .` / `pyright` | `: error:` / ` - error` |
| .NET | `dotnet build -nologo -clp:NoSummary` | `error [A-Z]+\d+` |
| Go | `go vet ./...` | `\.go:\d+` |
| Rust | `cargo check --message-format short` | `: error` |
| ESLint | `npx eslint . -f unix` | `\[Error/` |

`--incremental false` (ou o equivalente) evita arquivo de cache gravado na cópia. Stack que precisa de
restore/install: ligue a pasta de dependências em `links` ou rode com `--dentro-do-repo`.

**Como ler a tabela:**

| Linha | Significa |
|---|---|
| `igual a base` | Nenhum erro novo |
| `+N sozinho; com as dependencias ... igual` | Depende delas: a ordem de merge precisa respeitar as `deps` (escreva no PDF e no COMO-APLICAR) |
| `+N: ERRO NOVO` (sai 1) | Falta declarar uma dependência, ou o bloco está quebrado. Corrija o mapa ou o código antes de entregar |
| `-N: abaixo da base` | Alarme, não vitória: ou o bloco corrige erros antigos (diga quais), ou um erro de sintaxe interrompeu a análise e escondeu o resto |
| `MEDICAO QUEBRADA` (sai 3) | A base saiu com erro e zero linhas contadas: comando ou `contar` errado. Nenhum número vale |

`--dentro-do-repo tmp/x` põe a cópia numa subpasta **ignorada** do repo (o script confere com
`git check-ignore` e recusa se não for). Use só quando a resolução de módulos exige estar dentro do repo.
**Porquê o cuidado:** uma cópia esquecida dentro do repo fez o typecheck da raiz saltar de 308 para 613
erros (contava as cópias). O script apaga a cópia no fim e para com erro se ela ficar para trás.

### 3.7 `comandos`: o texto que o usuário vai rodar

Por bloco: `APLICAR.txt`, `COMMIT-<repo>.txt`, `PR.md` (este só se ainda não existir; `--sobrescrever`
troca) e `provas.json`. Na raiz: `COMO-APLICAR.md`. Rode **depois** do `verificar` (e do `typecheck`),
para o `provas.json` nascer com os números; o `tudo` já segue essa ordem.

`APLICAR.txt`, por repo do bloco e na ordem de `repos`:

```
cd <repo>
git status --short                     # precisa sair vazio (Passo 0)
git checkout <base>                    # ou a branch da dependência, se empilhar
git pull
git checkout -b <branch>
git apply --index --check <patch>      # se a base andou, para aqui sem mexer em nada
git apply --index <patch>              # aplica e já põe no índice só os arquivos do patch
git diff --cached --stat
git commit -F <COMMIT-repo.txt>
git push -u <remoto> <branch>
```

`--index` em vez de `git apply` + `git add -A`: o `add -A` leva junto qualquer arquivo solto da pasta.
Bloco `segurar` abre com "NÃO ABRA PR AINDA", a causa e as saídas. O script confere, só lendo, o
remoto (`git remote get-url <remoto>`) e o upstream da base (`git rev-parse --abbrev-ref <base>@{upstream}`):
sem remoto, `pull` e `push` saem como `# sem remoto <nome>: ...` (suba quando houver); base sem
upstream, o `pull` sai como `# base sem upstream: pull omitido`.

O id do bloco vira nome de pasta: só letras, números, `.`, `_` e `-` (até 31, começando por letra ou
número, sem `..`); outro id reprova o `validar` (saída 2), e nenhuma pasta de entrega sai de `saida`.

`COMMIT-<repo>.txt`: a mensagem do mapa ou, sem ela, um **rascunho** (o script avisa quais) no formato
`<prefixo da branch>: <título>` + resumo + itens + "Não validado". Sem trailer de coautoria, salvo o
PERFIL pedir. Siga o estilo do `git log` do repositório. Arquivo já existente e diferente do mapa é
mantido, com aviso (`--sobrescrever` troca): a fonte é o mapa, edite lá.

`PR.md` sem `nao_validado` no mapa sai com um aviso no lugar da seção, e o `comandos` lista esses blocos:
campo ausente não é "tudo validado". Lista vazia (`"nao_validado": []`) é que diz "todos os itens foram
testados, com prova".

`COMO-APLICAR.md`: base e HEAD de cada repo, o **Passo 0** (§4), o aviso de não copiar arquivo inteiro
com a lista dos arquivos que têm trechos de mais de um bloco, a ordem sugerida (com as dependências),
os blocos segurados, o que ficou `fora` e o que fazer com o stash depois.

`provas.json` (só se ainda não existir): a spec inicial do PDF do bloco para o `scripts/provas.py`, já
com capa (rótulo, branch, título, resumo, rodapé), `base` com o HEAD de cada repo, `depende`, `ordem`,
`patches` (o `provas.py` conta `+`/`−` lendo o patch), `alerta` do `segurar`, `atencao`, `fora`,
`comandos`, `commit` e `verificacao` com os **números reais** do `verificar` e do `typecheck`. Os
`itens` vêm vazios (os textos do mapa ficam em `_itens_do_mapa` como lembrete): quem preenche ANTES ·
POR QUE · DEPOIS · STATUS e as provas é você. `nao_validado` só é copiado se o mapa o declara; sem ele,
o `provas.py validar` avisa. Rodou `verificar` ou `typecheck` de novo? `comandos --atualizar-provas`
renova `base`, `patches`, `comandos` e as linhas automáticas de `verificacao`, e mantém itens, textos e
as linhas de verificação que você escreveu à mão.

### 3.8 PDF de provas por bloco e índice

`entrega.json` (manifesto) guarda tudo que o PDF cita: repos (HEAD, base, arquivos e trechos,
compartilhados, `fora`), e por bloco a branch, a pasta, os repos, as deps, `segurar`, os arquivos com
trechos e `+`/`−`, os textos do mapa, a verificação e o typecheck. O `provas.json` de cada bloco já sai
dele (§3.7).

Os itens de cada defeito do bloco vêm do ledger da rodada, sem gerar PDF nem tocar no
`relatorio/provas.pdf` dela:

```bash
python "$QA/scripts/provas.py" gerar <rodada> --defeito D-NNN --salvar-spec <saida>/NN-<branch>/itens-D-NNN.json --so-spec
```

Copie as chaves `itens` **e** `marcas` desse arquivo para o `provas.json` do bloco (juntando com as de
outros defeitos do mesmo bloco). A chave `marcas` traz as caixas da rodada por caminho absoluto de
cada imagem; sem ela o PDF do bloco sai sem as caixas, e a conferência reprova (saída 1) por isso.
Sem `--so-spec` o comando também gera o PDF filtrado, como `relatorio/provas-D-NNN.pdf`: o documento
completo da rodada nunca é sobrescrito por um filtrado. Depois de preencher os itens:

```bash
python "$QA/scripts/provas.py" validar <saida>/NN-<branch>/provas.json --checar-arquivos
python "$QA/scripts/provas.py" gerar   <saida>/NN-<branch>/provas.json --pr --conferir
python "$QA/scripts/provas.py" indice  <saida>                       # 00-INDICE.pdf
```

Não passe `--aplicar` nem `--commit-arquivos` ao `provas.py` aqui: `APLICAR.txt` e `COMMIT-*.txt` já
saíram do `entregas.py`, com os caminhos dos patches provados. O `--pr` troca o `PR.md` esqueleto pelo
completo, gerado da spec. Formato visual e regras do PDF: `references/provas-antes-depois.md`.

Cada PDF de bloco precisa ter, nesta ordem:

1. **Capa:** "Bloco NN · branch", o nome da branch em destaque, título, resumo; repositórios, número de
   arquivos e `+N −N`; "criar a partir de" (base e HEAD curto de cada repo); "depende de"; ordem de
   deploy.
2. **Alerta vermelho** se `segurar`, com a causa e as saídas.
3. **Tabela de arquivos** (repo, arquivo, `+`, `−`).
4. **Cada item** em quatro partes, **ANTES · POR QUE · DEPOIS · STATUS**, com o código do item
   (`11.3`), onde (`arquivo:linha`), e a prova: par **ANTES** (faixa e moldura vermelhas) / **DEPOIS**
   (faixa e moldura verdes), com caixas numeradas circulando o ponto exato; ou tabela/trecho de
   payload ou banco quando a prova não é visual.
5. **O que ainda não foi validado** (nunca some; vazio vira "Todos os itens foram testados, com a prova
   acima").
6. **Atenção do revisor** e **fora deste bloco**, quando houver.
7. **Como aplicar** (o `APLICAR.txt`) e a **mensagem de commit**.
8. **Verificação feita na separação**, com os números do `entrega.json`: aplicou sozinho, soma byte a
   byte (quantos arquivos), typecheck sozinho e com as deps contra a base.
9. **Rodapé em toda página** com a branch e o bloco; número da página à direita.

`00-INDICE.pdf`: tabela de blocos (id, branch, título, repos, arquivos, `+`, `−`, depende, situação
**pronto** / **segurar**), ordem de merge, alerta dos segurados, como a separação foi verificada (com
os números) e o Passo 0.

Antes de entregar, abra cada PDF: nenhum `{{` sobrando, imagens à vista, branch no rodapé, alerta do
bloco segurado presente. Print de prova nítido: zoom na região e, em modal, CSS `zoom` antes do print.

### 3.9 Entregar ao usuário

Na resposta: a pasta da entrega; a ordem sugerida; o que está segurado e por quê; dependências; o
Passo 0; o resultado do `verificar` e do `typecheck` em números; o que **não** foi validado; e a frase
"nada foi commitado nem enviado". Mensagem para repassar ao time segue o tom do PERFIL (um bloco por
mensagem; branch e caminho em bloco próprio; ressalva no fim).

---

## 4. Passo 0 do usuário (vai no COMO-APLICAR.md)

O working tree tem todos os assuntos abertos. Para criar cada branch limpa a partir da base, ele guarda
tudo primeiro:

```
cd <repo>
git stash push -u -m "entregas-<data>-antes-das-branches"
```

`-u` guarda também os arquivos novos. O `00-backup/` é a segunda cópia. Depois aplica bloco a bloco
pelo `APLICAR.txt`. Quando todas as branches estiverem no remoto e conferidas, o stash pode ser
descartado (`git stash drop`) ou mantido; blocos segurados e trechos `fora` continuam nele.

Avise também: trocar de branch muda os arquivos que o servidor de desenvolvimento e a IDE estão usando.

---

## 5. O que NÃO fazer

- **Criar branch, commitar, fazer stash, push ou PR**, mesmo com tudo provado. Pedir o texto do commit
  não é pedir o commit.
- **Copiar arquivo inteiro** do working tree para a branch de um bloco: leva trecho de outro assunto.
- **Editar um patch à mão** para "encaixar": a soma deixa de bater e a prova acaba. Corrija o mapa.
- **Verificar com `git add -u` num índice novo**: dá "diferente" por fim de linha (§3.5).
- **Deixar a cópia do typecheck dentro do repo**: infla o typecheck da raiz.
- **Separar por arquivo** quando o arquivo tem trechos de vários assuntos.
- **Misturar no bloco o que era de outra sessão**: vai como `fora`, com o motivo.
- **Esconder dependência**: se o typecheck diz que o bloco precisa de outro, isso vai no PDF, no
  `PR.md` e no `COMO-APLICAR.md`.
- **Chamar de pronto** com `verificar` ou `typecheck` saindo diferente de 0.

---

## 6. Armadilhas

- **O índice do trecho muda** quando o arquivo é editado ou quando `contexto` muda. As assinaturas do
  rascunho pegam a primeira; a segunda exige refazer o mapa.
- **Arquivo não rastreado não está no `git diff`.** Sem `incluir_novos`, ele não entra em bloco nenhum
  (e o `stash` sem `-u` o deixa para trás).
- **Fim de linha trocado infla o diff** (uma mudança de 30 linhas virou 57 mil): o `separar` recusa
  arquivo assim. Restaure gravando em binário.
- **`core.autocrlf=true`**: o patch sai normalizado (LF) e o working tree tem CRLF. A soma bate depois
  do filtro do git, e o `verificar` diz quantos arquivos bateram assim. Não é erro.
- **Arquivo novo, apagado ou binário** não se divide entre blocos.
- **Colchete no caminho** (rotas `[id]`): é literal quando o caminho existe; em padrão, escape com `[[]`.
- **A base andou** entre a separação e a aplicação: `--contra origin/<base>` depois que o usuário fizer
  `git fetch`. O script não faz fetch.
- **Rodar `separar` com o working tree diferente do que foi testado**: os patches passam a conter o que
  não foi provado. Separe no fim, depois do último reteste, e rode `verificar` logo em seguida.
- **Typecheck que "melhora"**: número abaixo da base pede explicação (§3.6).
- **Caminho longo no Windows** ("Filename too long" ao aplicar na cópia): fora de um repositório o
  `core.longpaths` do usuário não vale; o script passa `core.longpaths=true` ao git. Se o Python também
  falhar ao extrair, use uma pasta temporária curta (`TEMP=C:\tmp`) ou `--dentro-do-repo`.

---

## 7. Códigos de saída e checklist

`0` ok · `1` reprovou (sem dono, dois donos, não aplica, soma diferente, erro novo de tipo, patch
desatualizado, segredo no bloco ou no texto do mapa, timeout) · `2` uso ou mapa inválido · `3` ambiente (git
ausente, pasta que não é repo: veja §8, medição quebrada).

- [ ] `backup` feito antes de separar.
- [ ] `hunks --mapa` sem `SEM DONO` nem `DOIS DONOS`; o que é de outra sessão está como `fora`.
- [ ] `separar` saiu 0 (e o `--simular` foi conferido).
- [ ] `verificar` saiu 0: cada bloco sozinho na base, soma idêntica arquivo a arquivo.
- [ ] `typecheck` saiu 0, ou cada dependência revelada está declarada e explicada.
- [ ] `comandos` gerou `APLICAR.txt`, `COMMIT-*.txt`, `PR.md` e `COMO-APLICAR.md`; mensagens de commit
      revisadas (nenhum rascunho esquecido).
- [ ] `provas.json` de cada bloco com os itens preenchidos (ANTES · POR QUE · DEPOIS · STATUS, com prova)
      e `nao_validado` declarado; `provas.py validar` sem aviso.
- [ ] Um PDF por bloco (branch na capa e no rodapé) e o `00-INDICE.pdf`, gerados com `--conferir`,
      abertos e conferidos.
- [ ] Bloco segurado com causa e saídas em todos os lugares.
- [ ] Nenhum `SEGREDO no bloco` nem `SEGREDO no mapa` na saída; `APLICAR.txt` e `COMO-APLICAR.md` com o
      cabeçalho "PARA O USUÁRIO".
- [ ] Nada criado no repositório: nenhuma branch, commit, stash ou push.

---

## 8. Projeto sem VCS

Projeto entregue como zip, versionado em SVN ou Perforce, ou numa pasta solta: **não há branch** e o
`entregas.py` recusa a pasta ("não é um repositório git", saída 3). Nunca crie `.git` no projeto do
usuário para contornar.

A entrega é **um patch por assunto**, feito arquivo a arquivo contra a cópia do estado inicial que a
fase 1 guardou fora do projeto (`perfil-e-inventario.md` §1.10, junto do `notas/00-snapshot-inicial.txt`):

```bash
INI="<cópia do estado inicial, fora do projeto>"
PROJ="<projeto>"
git diff --no-index --binary -- "$INI/src/a.ts" "$PROJ/src/a.ts" >  "<saida>/01-<assunto>.patch"
git diff --no-index --binary -- "$INI/src/b.ts" "$PROJ/src/b.ts" >> "<saida>/01-<assunto>.patch"
```

- **Um arquivo por linha**, só os arquivos daquele assunto. Arquivo novo: `/dev/null` no lugar do
  `$INI/...`. O `git diff --no-index` não precisa de repositório; ele só lê os dois arquivos.
- **O cabeçalho sai com o caminho completo** das duas pastas: diga ao usuário com quantos níveis aplicar
  (`patch -p<N>`), ou gere com `diff -u --label a/<arquivo> --label b/<arquivo> "$INI/<arquivo>"
  "$PROJ/<arquivo>"`, que já sai relativo.
- **Arquivo com dois assuntos** não se divide à mão por trecho: vai inteiro para um dos patches, e o
  texto do commit diz o que de outro assunto foi junto.
- **Junto de cada patch**, no mesmo formato da §3.9: a lista de arquivos, a mensagem de commit em bloco
  copiável, o que não foi validado e o PDF de provas (`provas.py gerar` com a spec escrita à mão). Quem
  aplica e versiona é o usuário, no sistema dele.
- **Prova da separação**, já que o `verificar` não roda: aplique cada patch numa cópia limpa do estado
  inicial, fora do projeto, e compare o SHA-256 de cada arquivo com o do projeto (`sha256sum`), como no
  retrato do `perfil-e-inventario.md` §1.10.
