# awesome-mcp-servers (BrethofAI)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/BrethofAI/awesome-mcp-servers |
| Clone local | `repositorios/_research/mcp/BrethofAI--awesome-mcp-servers` |
| Commit | `4222d89c05f1099050c4dd3ac0cfca31808d6994` |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | mcp (catálogo comunitário curado) |
| Stack | YAML + Python 3.12 (`scripts/gen_awesome_readme.py`, `scripts/facts.py`), GitHub Actions; sem runtime de MCP |
| Tamanho | 117 arquivos; 103 entradas YAML (~1.719 linhas), 16 categorias, 2 scripts |

## 1. O que é (verificado no código)

É um **catálogo curado**, não um servidor nem um SDK. Cada entrada é um YAML em
`entries/` (`entries/filesystem.yaml:1-14`), e o `README.md` é gerado a partir
delas por `scripts/gen_awesome_readme.py:89-141`. A lista se apresenta como
“working MCP servers … each labelled with who publishes it, where it runs, and
what it can change” (`README.md:3`).

O critério é explícito: a entrada precisa ser **Real** (código ou endpoint
documentado), **Working** (conecta em um cliente MCP), **Honest** (o que diz
fazer se sustenta) e **In scope** (é um servidor MCP) (`README.md:16-21`). O
catálogo recusa apenas três coisas: nada real para apontar, alegação enganosa
ou scam, e off-topic/spam (`README.md:29-33`).

O ponto de atenção: a lista tem 103 entradas, mas a maioria é de servidores
**hosted de fornecedores**; só 7 são os servidores de referência do MCP
(`README.md:78-95`). Ela é útil como taxonomia e como fonte de nomes/URLs, não
como prova de qualidade técnica. O próprio catálogo marca servidores
abandonados ou com advisories, como o `chroma`
(`entries/chroma.yaml:6`), o que é um bom sinal de honestidade.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `python3 scripts/gen_awesome_readme.py` | `scripts/gen_awesome_readme.py:149-154` | regenera o README a partir de `entries/*.yaml` |
| `python3 scripts/facts.py --prev … --out … --changes …` | `scripts/facts.py:246-293` | coleta fatos ao vivo (GitHub + web) e diff semanal |
| workflow `weekly-facts` | `.github/workflows/facts.yml:13-14` | roda domingo 21:00 UTC e grava na branch `facts` |
| workflow `check-and-regenerate` | `.github/workflows/ci.yml:1-75` | valida YAML e regenera o README no merge |
| validação de entrada | `.github/workflows/ci.yml:36-64` | campos obrigatórios, slug, data, URL |
| `python3 scripts/gen_awesome_readme.py` (check) | `.github/workflows/ci.yml:66` | falha se o README não regenerar igual |

Não há CLI de instalação, nem runtime MCP, nem testes de protocolo. A
“superfície” é o par `entries/*.yaml` + README gerado; o site da Brethof
consome o README (`scripts/gen_awesome_readme.py:111-114`).

## 3. Arquitetura e fluxo

```
entries/<slug>.yaml
  → load_entries (glob + skip stub)
  → agrupa por category/category_order
  → renderiza badges + tagline + fact line
  → README.md (LIST:START … LIST:END)

scripts/facts.py
  → GitHub GraphQL (stars, release, pushed, archived, licence)
  → HTTP HEAD/GET (status, redirect, title)
  → facts.json + changes.json + summary.md
  → branch `facts` (nunca main)
```

- Fonte da verdade: `entries/` (`scripts/gen_awesome_readme.py:63-70`).
- Render: `scripts/gen_awesome_readme.py:89-141`.
- Fatos: `scripts/facts.py:94-153` (GitHub e web) e `:203-240` (diff).
- Publicação: `.github/workflows/facts.yml:8-10` deixa claro que só a branch
  `facts` é escrita; a revisão humana decide o merge.
- README: `README.md:57-74` (TOC com contagens) e `:78-391` (seções).

## 4. Catálogo: taxonomia e contagens

| Categoria | Entradas | Onde no README | Exemplos |
|---|---:|---|---|
| Reference servers (MCP steering group) | 7 | `README.md:78-95` | everything, fetch, filesystem, git, memory, sequentialthinking, time |
| Files, Filesystem & Local Data | 1 | `README.md:97-99` | obsidian |
| Web Search & Browsing | 10 | `README.md:103-129` | brave-search, context7, exa, firecrawl, tavily |
| Browser Automation | 4 | `README.md:133-142` | browser-use, chrome-devtools, playwright, mac-mcp |
| Source Control | 3 | `README.md:146-153` | gitea, github, gitlab |
| Issue Trackers & Project Management | 5 | `README.md:156-167` | asana, atlassian, linear, trello |
| Communication | 8 | `README.md:170-188` | discord, google-workspace, slack, telegram |
| Relational Databases | 4 | `README.md:192-203` | clickhouse, mysql, postgres-mcp, supabase |
| NoSQL & Document Databases | 2 | `README.md:207-212` | mongodb, neo4j |
| Vector & Memory Stores | 7 | `README.md:216-235` | chroma, pinecone, qdrant, weaviate |
| Productivity & Notes | 8 | `README.md:238-257` | airtable, notion, zapier |
| Design & Creative | 7 | `README.md:260-277` | figma, blender, video |
| Operations & Infrastructure | 11 | `README.md:281-311` | aws, azure, cloudflare, kubernetes, vercel |
| AI & ML Platforms | 4 | `README.md:314-324` | huggingface, aident-loadout, api-market |
| Specialised / Vertical | 18 | `README.md:328-374` | stripe, spotify, health, finance |
| Frameworks & SDKs | 4 | `README.md:377-391` | fastmcp, mcp-go, mcp-python, mcp-typescript |

As tags são a parte mais reutilizável: `official`/`community`/`brethof`,
`read-only`/`mutating`, `local`/`hosted`, `paid`, `crypto` e `new`
(`README.md:39-55`). A legenda define cada uma e deixa claro que “crypto” é
uma opção de pagamento, não uma categoria (`README.md:51-55`).

## 5. Servidores relevantes para o nosso harness

| Servidor | Categoria / tags | Por que interessa | Onde |
|---|---|---|---|
| `everything` | reference / official | exercita todos os recursos do protocolo; é o melhor alvo de conformidade | `entries/everything.yaml:1-12`; `README.md:82-83` |
| `fetch` | reference / official, read-only | URL → Markdown, com robots e limite de conteúdo | `entries/fetch.yaml:1-12`; `README.md:84-85` |
| `filesystem` | reference / official, mutating, local | allow-list de diretórios, leitura/escrita/search | `entries/filesystem.yaml:1-14`; `README.md:86-87` |
| `git` | reference / official, mutating, local | status/diff/commit/branch em repo confinado | `entries/git.yaml:1-14`; `README.md:88-89` |
| `memory` | reference / official, mutating, local | knowledge graph em JSONL, 9 tools + resource | `entries/memory.yaml:1-14`; `README.md:90-91` |
| `sequentialthinking` | reference / official, read-only, local | planejamento passo a passo com revisão/ramificação | `entries/sequentialthinking.yaml:1-14`; `README.md:92-93` |
| `time` | reference / official, read-only, local, new | `get_current_time`/`convert_time` com IANA | `entries/time.yaml:1-14`; `README.md:94-95` |
| `playwright` | browser automation, official, mutating | árvore de acessibilidade para loops de agente | `entries/playwright.yaml:1-12`; `README.md:142-143` |
| `chrome-devtools` | browser automation, official, mutating | controle/inspeção de Chrome, rede, console, traces | `entries/chrome-devtools.yaml:1-14`; `README.md:137-139` |
| `context7` | web docs, official, read-only, hosted | documentação atualizada de bibliotecas | `entries/context7.yaml:1-14`; `README.md:110-112` |
| `github` | source control, official, mutating, hosted | repos, issues, PRs, Actions; `--read-only` remove writes | `entries/github.yaml:1-14`; `README.md:150-152` |
| `gitlab` | source control, official, mutating, hosted | issues, MRs, CI; OAuth 2.0 + DCR | `entries/gitlab.yaml:1-14`; `README.md:153-155` |
| `gitea` | source control, official, mutating | instância self-hosted | `entries/gitea.yaml:1-12`; `README.md:148-149` |
| `brave-search` | web search, official, read-only | busca web/local/imagem/vídeo/news | `entries/brave-search.yaml:1-14`; `README.md:105-107` |
| `firecrawl` | web scraping, official, mutating, hosted | scrape/search/crawl para Markdown/JSON | `entries/firecrawl.yaml:1-14`; `README.md:121-123` |
| `qdrant` | vector memory, official, mutating | memória semântica com `qdrant-store`/`qdrant-find` | `entries/qdrant.yaml:1-14`; `README.md:232-234` |
| `fastmcp` / `mcp-go` / `mcp-python` / `mcp-typescript` | frameworks | alternativas de SDK para comparar API | `README.md:377-391` |

Observação de curadoria: a tagline do `git` diz “run common git commands”
(`entries/git.yaml:6`), mas o servidor atual só expõe 12 operações fixas
(`src/git/src/mcp_server_git/server.py:60-73`). É uma divergência de catálogo,
não de código; serve de alerta para não tratar tagline como contrato.

## 6. Modelo de curadoria

- **Entrada = YAML**, não PR direto no README (`README.md:410-415`;
  `scripts/gen_awesome_readme.py:1-12`).
- **Uma entrada por servidor**, slug = nome do arquivo; o CI rejeita slug
  divergente (`.github/workflows/ci.yml:54-55`).
- **Campos obrigatórios**: `name`, `slug`, `url`, `category`, `category_label`,
  `tagline`, `added` (`.github/workflows/ci.yml:40`).
- **URL obrigatoriamente http(s)** e `added` em ISO
  (`.github/workflows/ci.yml:57-64`).
- **Fatos semanais**: stars, release, último push, archived, licença, status
  HTTP, redirect e título (`scripts/facts.py:94-153`); o diff classifica
  entradas mortas (`404`, `410`, `ConnectionError`) e mudanças
  (`scripts/facts.py:203-240`).
- **Publicação é humana**: o workflow só escreve na branch `facts`
  (`.github/workflows/facts.yml:8-10`), e o merge para `main` é decisão de
  revisão.
- **Substituição**: quando há forks, vence o mais ativo; quando há builds
  oficiais, vence o oficial mais recente (`README.md:35-37`).

## 7. Configuração e extensibilidade

Não há configuração de runtime. A “config” é o schema da entrada YAML:

| Campo | Exemplo | Onde |
|---|---|---|
| `name` / `slug` | `filesystem` | `entries/filesystem.yaml:1-2` |
| `url` | repositório ou doc oficial | `entries/filesystem.yaml:3` |
| `category` / `category_label` | `official-anthropic-servers` | `entries/filesystem.yaml:4-5` |
| `tagline` | descrição factual | `entries/filesystem.yaml:6` |
| `tags` | `official`, `mutating`, `local` | `entries/filesystem.yaml:7-10` |
| `list` | `mcp-servers` | `entries/filesystem.yaml:11` |
| `added` / `verified` | datas ISO | `entries/filesystem.yaml:12-14` |
| `category_order` | ordem da seção | `entries/filesystem.yaml:13` |

Extensibilidade é por **novas entradas/categorias**, não por plugin. O
`README.categories.yaml` adiciona intro por slug de categoria
(`README.categories.yaml:1-7`), e o gerador ignora entradas `[stub]`
(`scripts/gen_awesome_readme.py:69-70`).

## 8. Permissões, segurança e erros

Este repositório **não executa** nenhum servidor, então não há sandbox,
permissão ou erro de runtime. O que existe é curadoria de segurança:

- A tag `mutating` sinaliza que o servidor pode escrever/enviar/modificar
  (`README.md:45-46`); `read-only` sinaliza o contrário (`:43-44`).
- A tag `hosted` separa execução no fornecedor (`:48-49`); `local` separa
  execução na máquina (`:47`).
- `paid` e `crypto` tornam custo explícito (`:50-55`).
- O `facts.py` detecta link morto e mudança de redirect
  (`scripts/facts.py:203-240`), mas **não** faz scan de segurança, não valida
  o protocolo MCP e não testa as tools. “Working” é uma verificação humana +
  link check, não um teste automatizado de handshake.
- Não foi encontrado checklist de permissões, sandbox ou revisão de código
  malicioso. O catálogo é informativo, não uma garantia.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Validação de YAML | `.github/workflows/ci.yml:36-64` | campos, slug, data, URL |
| Regeneração do README | `.github/workflows/ci.yml:66-75` | determinismo do gerador |
| Fatos semanais | `.github/workflows/facts.yml:13-60` | GitHub GraphQL + HTTP + diff |
| Curadoria manual | `README.md:16-37` | “real, working, honest, in scope” |
| Testes unitários dos scripts | não encontrado | não há `test_*.py` no clone |

Qualidade real: o CI é barato e pega erro de schema; o `facts.py` tem retry
IPv4 e timeout (`scripts/facts.py:132-153`), mas não há teste do próprio
script. Para nós, o valor está no **schema de catálogo** e no pipeline de
verificação, não na cobertura.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Taxonomia de tags (publisher, risco, runtime, custo, novidade) | `README.md:39-55` | linguagem simples e acionável para o usuário | MIT | `src/core/mcp/catalog.ts` | 18 |
| Pipeline de fatos e diff semanal | `scripts/facts.py:94-240`, `.github/workflows/facts.yml:13-14` | detecta link morto e release nova sem trabalho manual | MIT | `scripts/mcp-catalog-facts.mjs` | 16 |
| Schema de entrada YAML + validação | `entries/filesystem.yaml:1-14`, `.github/workflows/ci.yml:36-64` | fonte única, sem README editado à mão | MIT | `docs/mcp/catalog/*.yaml` | 15 |
| Gerador determinístico de README | `scripts/gen_awesome_readme.py:89-141` | evita drift entre catálogo e doc | MIT | `scripts/gen-mcp-catalog.mjs` | 12 |
| Separação `official/community/brethof` | `README.md:41-43` | deixa a origem explícita | MIT | `src/core/mcp/catalog.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| A lista como dependência de runtime | é um README, não uma API |
| Contagem de stars/releases como critério de qualidade | `facts.py` mede popularidade, não segurança |
| Entradas “hosted” sem código | 62 de 103 entradas têm a tag `hosted`; não servem para auditoria local |
| Emojis e legendas | ruído no nosso UI; usar tags textuais |
| `crypto`/x402 | não temos carteira nem política de pagamento por chamada |
| O gerador Python | nosso stack é TS; reimplementar em Node |
| A curadoria manual como gate | precisamos de teste de protocolo, não só link check |

## 12. Modelo de exemplo para o nosso harness

1. **Schema de catálogo** com os campos que já usamos em
   `src/core/mcp/catalog.ts` + os que faltam: `publisher`
   (`official|community|vendor`), `risk` (`read|write|destructive`),
   `runtime` (`local|hosted`), `auth` (`none|api-key|oauth`), `cost`
   (`free|paid|trial`), `sourceUrl`, `verifiedAt`, `protocolVersions`.
2. **Verificação em duas camadas**: (a) link/HTTP e release, como
   `facts.py:94-153`; (b) handshake MCP real + `tools/list`, que o catálogo
   atual não faz. A camada (b) é o nosso diferencial.
3. **Estado de confiança**: `verified` = passou no handshake e no
   `tools/list`; `stale` = passou há > 30 dias; `dead` = 404/410/timeout.
   Base: `scripts/facts.py:203-240`.
4. **Proveniência**: guardar `sourceUrl`, commit/tag e data da última
   verificação; nunca mostrar “oficial” sem URL do fornecedor.
5. **UI**: mostrar `risk` e `runtime` antes do botão “instalar”; para
   `hosted`, avisar que o dado sai da máquina. Base: tags `mutating`/`hosted`
   (`README.md:45-49`).
6. **Teste**: um fixture com 10 entradas (5 boas, 2 mortas, 2 sem tool list,
   1 com auth OAuth) e um teste que classifica cada uma; o catálogo só promove
   a “instalável” depois do handshake.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/mcp/BrethofAI--awesome-mcp-servers rev-parse HEAD
4222d89c05f1099050c4dd3ac0cfca31808d6994
$ ls entries | wc -l
103
$ grep -c '^- \*\*\[' README.md
103 (7 reference + 96 de ecossistema)
$ grep -n '^## ' README.md | wc -l
23 (16 seções de catálogo + Contents, Legend, Why, Discovery hubs, Related work, Contributing, License)
$ sed -n '39,55p' README.md
- official — published by the originating company...
- community — third-party server...
- read-only / mutating / local / hosted / paid / crypto / new
$ cat entries/filesystem.yaml
name: filesystem
slug: filesystem
url: https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
category: official-anthropic-servers
tags:
- official
- mutating
- local
$ sed -n '1,14p' .github/workflows/facts.yml
# Every week, read the live facts of every entry...
# It writes ONLY to the `facts` branch, never to main...
schedule:
  - cron: '0 21 * * 0'
$ sed -n '36,64p' .github/workflows/ci.yml
need = ("name", "slug", "url", "category", "category_label", "tagline", "added")
if d.get("slug") and d["slug"] != p.stem: ...
datetime.date.fromisoformat(...)
$ find . -name 'test_*.py' | wc -l
0
```
