# AI-Memory no Openclod Desktop

A memória de longo prazo do Openclod é **por projeto** e compartilhada por
todos os modelos, agentes e subagentes. Ela sobrevive a troca de LLM, a
reinício do app e a compactação de contexto. Só é apagada quando o projeto é
excluído.

## Duas camadas

| Camada | O que é | Onde fica |
| --- | --- | --- |
| Wiki nativa | Markdown editável, índice lexical próprio, handoffs | `%APPDATA%\Openclod Desktop\data\memory\projects\<projectId>` |
| AI-Memory | Wiki Markdown + índice SQLite/FTS5, entidades, links e busca | `%APPDATA%\Openclod Desktop\data\ai-memory` |

A wiki nativa é a fonte de verdade e o fallback quando o binário não está
disponível. O AI-Memory é um **sidecar** (processo separado, HTTP em loopback)
que indexa a mesma memória e oferece busca ranqueada. Não portamos o código
Rust do projeto original; executamos o binário oficial MIT
(`akitaonrails/ai-memory`) e falamos com a API administrativa dele.

## Escopo

- Workspace: `openclod`
- Projeto: `projectId` do Openclod (`prj_...`)

Uma página escrita no projeto A nunca é retornada para o projeto B.

## Captura automática

Ao fim de **cada turno**, o Openclod grava:

1. Uma página na wiki nativa, com pedido, resultado, ferramentas e arquivos.
2. Um bloco de turno na página da sessão no AI-Memory em
   `s/<hash-da-sessão>.md`, com o transcrito, chamadas de ferramenta e saídas reais.

Isso acontece mesmo que o modelo nunca chame `memory_page`. Páginas curadas
criadas com `memory_page` são espelhadas em `pages/<slug>.md` para entrar no
índice de entidades e links.

Versões antigas gravavam um arquivo por turno em `s/<hash>/<turno>.md`; elas
são consolidadas em uma página por sessão no início do app, para o grafo não
ficar com um nó por turno.

## Contexto do turno (a busca automática)

A memória **não** é mais despejada no prompt do sistema (isso derrubava o cache
do provedor a cada turno: ver [`docs/MEMORIA-E-TOKENS.md`](MEMORIA-E-TOKENS.md)).
Antes de cada pedido o runner monta **uma** mensagem oculta
`<contexto-do-turno>` logo depois da mensagem do usuário, com só o que importa
para aquele pedido:

- **Memória que casa com o pedido** (`src/core/memory/pack.ts`): páginas
  ranqueadas pelo que elas *são* (decisão/solução/convenção valem mais que log
  de turno; os hubs automáticos "Índice: palavra" nunca entram), pela cobertura
  do pedido e pela recência, mais os vizinhos duráveis dos melhores resultados
  (links e backlinks, as "sinapses"). Páginas já enviadas antes não se repetem
  até mudarem. Um pedido sem assunto ("ola", "tente novamente") não recupera nada.
- **Trabalho em aberto** de outras sessões: a cápsula de continuidade (abaixo) e
  os handoffs abertos.
- **Mapa da memória** (poucas linhas) só no primeiro turno; **plano**, **fatos**
  e **servidores MCP** só quando mudaram; **sugestões** de skills, agentes e
  ferramentas sob demanda que casam com o pedido.

Ferramentas do agente (o modelo as usa quando o contexto do turno não basta):

- `memory_brief` — briefing nativo (páginas fixadas, recentes e handoffs). Sob demanda: o mapa já vem no contexto do turno.
- `memory_page` — buscar (mesmo ranking), ler (mostra links e backlinks para
  seguir; também abre páginas que só existem no índice), escrever (liga a página
  às duráveis relacionadas), listar, apagar, invalidar.
- `memory_handoff` — passagem de bastão com dono único. Sob demanda: chamar pelo nome já a carrega (a cápsula de continuidade
  cobre a continuação entre modelos sem ela; sem ela um modelo pode gravar uma página no lugar do handoff).
- `memory_recall` — busca ranqueada com as ligações de cada página; cai para o
  índice AI-Memory quando a wiki não tem nada.

## Cápsula de continuidade

Depois de **cada turno** o app grava (ou reescreve) **uma página por sessão**,
`estado-<sessão>` (`src/core/memory/state-page.ts`): situação (em aberto,
interrompido ou concluído), objetivo, último pedido, resultado, plano com
status, **próximo passo** e arquivos. Sem que o modelo precise lembrar. Uma
sessão nova no mesmo projeto recebe a cápsula do trabalho em aberto no contexto
do turno, e é isso que faz "continue de onde paramos" funcionar com **outro**
modelo. Quando um modelo assume uma conversa longa (troca de modelo ou fallback
por cota), o runner resume o histórico antes da primeira chamada, para ele
partir do resumo e da memória em vez de reler tudo.

## Higiene

Os "Índice: <palavra>" gerados de palavras que só aparecem em logs de turno
(abre, falta, afzer…) eram 24 das 73 páginas do maior projeto real. Agora só
nasce hub para assunto que alguma página durável carrega, e os antigos vão para
`wiki/.archive` (nada é apagado).

## Interface

**Memória** aparece na barra lateral do Code quando existe pelo menos um
projeto. A tela mostra:

- páginas nativas e páginas indexadas que não são transcritos de sessão;
- contagem de páginas, fixadas, handoffs e páginas no índice;
- status do sidecar e porta;
- busca no índice AI-Memory;
- exportar/importar Markdown e abrir a pasta;
- **marcar vários cards e apagar em massa** (abaixo).

Transcritos de sessão ficam fora da grade para não afogar a lista; continuam
pesquisáveis pelo agente e por **Buscar no índice**.

### Marcar páginas e apagar em massa

Cada card tem uma caixa no canto. A barra acima da grade tem **Selecionar todas** (a
caixa mostra um traço quando só algumas estão marcadas) e, com seleção, **Limpar
seleção** e **Apagar N**.

- **Shift+clique** na caixa marca a faixa entre a última marcada e a clicada; **Esc**
  limpa a seleção. Clicar no conteúdo do card continua abrindo a página.
- A seleção é **só o que está na tela**: ao buscar, o que saiu da lista é desmarcado (e
  não volta quando a busca é limpa), então nada escondido é apagado sem querer.
- **Apagar pede dois cliques**: o primeiro troca o botão por "Confirmar: apagar N
  páginas" (com "(2 fixadas)" quando há fixadas) e, se você não confirmar em 6 s, volta
  sozinho. Não há desfazer.
- A exclusão usa a mesma operação do botão **Apagar** da página aberta, uma página por
  vez (o arquivo da wiki, a linha do índice e a cópia no AI-Memory). Se alguma falhar, a
  tela diz quantas foram apagadas e o título das que não foram.

Verificação em app real (perfil descartável): `node scripts/ui-memory-select.cjs`.

## Arquivos na memória (imagens, PDFs, documentos, áudio, vídeo, qualquer arquivo)

A memória guarda **arquivos**, não só texto. Cada arquivo vira uma página da wiki, entra no índice AI-Memory e fica
ligado às páginas a que pertence. Assim, outra sessão ou outro modelo acha uma imagem **pelo que há nela**.

**O que entra em cada página.** Cada arquivo é copiado para `<memória>/files/<slug>/` com `meta.json`, `text.txt` e
uma miniatura `thumb.jpg` (de imagens e da 1ª página de PDFs). A página `arquivo-<nome>-<hash>` traz:

- **Descrição:** a de uma imagem é escrita por um modelo que enxerga, pelo relé de visão: o modelo de visão escolhido
  ou o primeiro provedor que lê imagens, inclusive o llama.cpp local. A de um arquivo do usuário ou do agente vem
  como foi dada.
- **Texto:**
  - imagem: OCR do Windows;
  - PDF: o texto, ou OCR se for digitalizado;
  - Word, Excel, PowerPoint, Markdown, HTML, CSV, JSON, texto e código: o conteúdo.

  Texto longo continua em `…-parte-N`, ligado à página principal.
- **Ficha:** tipo, origem, cópia, tamanho, SHA-256 e data.
- **Ligações:** `[[links]]` para as páginas indicadas, mais `## Relacionados` automático pelo assunto.

O mesmo conteúdo é sempre a mesma página: repetir só atualiza tags, ligações e descrição. Arquivos acima de 300 MB
ficam na origem, só referenciados. Áudio e vídeo continuam no pipeline de mídia (transcrição e frames,
`docs/MIDIA.md`) e são contados junto.

**Como os arquivos entram:**

| Como | O que acontece |
|---|---|
| Memória → **Guardar arquivos** / **Guardar pasta** | Seleção do Windows (a pasta vai com as subpastas, até 5000 arquivos). Grava em segundo plano, com uma barra de progresso. |
| O agente: `memory_file action=add paths=[…] recursive kinds tags links` | O mesmo, dentro do workspace. Exemplo: "pegue todas as imagens e PDFs do vault e guarde na memória". `describe` grava a descrição escrita pelo modelo depois de olhar (`view`). `list` e `remove` também. |
| Uma imagem **colada na conversa** | Vai para a memória depois do turno, com a descrição que o relé já fez, ligada à página do turno e à da sessão. |
| Um caminho de arquivo **escrito pelo usuário** na mensagem | O mesmo: PDF, imagem, Office, texto; até 100 MB. Áudio e vídeo vão para o pipeline de mídia. |

**Tela.** Abaixo dos números aparece uma barra com os arquivos por tipo (imagens, PDFs, documentos, planilhas,
apresentações, textos, código, áudios, vídeos, outros):

- um tipo mostra só os cards daquele tipo, com a miniatura;
- **Páginas** esconde as páginas de arquivos;
- a página de um arquivo mostra a imagem grande e **Abrir o arquivo** (a cópia guardada).

O número **no índice AI-Memory** é o real (`/admin/projects`). Enquanto a cópia avança, aparece "de N" e
"copiando (x de y)".

**Índice.** A sincronização da wiki com o AI-Memory tinha três defeitos:

- marcava o projeto como sincronizado mesmo quando parava no limite de 60 s, e só voltava no próximo início do app
  (~15 páginas por vez);
- fazia uma busca no sidecar por página, segundos cada uma;
- num projeto que o índice ainda não conhecia, a primeira consulta voltava 404 e a passada falhava: o projeto ficava
  de fora.

Agora o 404 conta como índice vazio (a primeira gravação cria o projeto). Uma passada que falha tenta de novo em 30 s,
e uma que para continua sozinha 3 s depois. "Relacionados" vem da própria wiki (instantâneo), com 3
gravações em paralelo. Uma passada completa volta a conferir em 2 min. A escrita de uma página também não relê mais a
wiki inteira: só as páginas do mesmo tipo semântico, para ver conflitos, e o índice é atualizado no lugar.

Verificação em app real: `node scripts/ui-memory-files.cjs --root <snapshot>`. O modelo que descreve é o llama.cpp
local (qwen3.5:4b do Ollama). Testes: `tests/memory-files.test.ts`.

## Grafo de memória (estilo Obsidian)

Cada projeto tem a aba **Grafo** na tela Memória. O menu do projeto (botão de
compartilhar na barra lateral, botão direito ou menu em Projetos) abre o grafo
direto.

- **Nós**: cada página/sessão/fato do projeto. O tamanho cresce com o grau.
- **Arestas**:
  - `link` — wikilink resolvido pelo índice do AI-Memory (`[[pages/foo.md]]`);
  - `tag` — páginas que compartilham tags;
  - `termo` — páginas que compartilham termos significativos.
- Clique em um nó abre o conteúdo completo ao lado.
- Arraste nós, use a roda para zoom e **Recentralizar** para reorganizar.
- Ao final de cada turno, o Openclod procura páginas relacionadas e grava uma
  seção `## Relacionados` com wikilinks. Isso alimenta o grafo e o
  graph-neighbour RRF do próprio AI-Memory, melhorando o recall.

A tela lê primeiro `/api/v1/.../graph` do AI-Memory (links explícitos) e
complementa com as conexões semânticas. Se o sidecar estiver indisponível, cai
para a wiki nativa.

## Exclusão

- **Remover da lista**: o projeto sai da lista; sessões, wiki e índice ficam.
- **Excluir projeto e memória**: apaga sessões, wiki nativa, regras
  “permitir sempre” e o projeto no AI-Memory (`/admin/purge-project`). A pasta
  do projeto no disco não é tocada.

## Resiliência

- Binário ausente: a wiki nativa continua funcionando.
- Caminhos longos do Windows: páginas antigas em `sessions/...` são migradas
  para `s/<hash>.md` (uma por sessão) no início, antes de qualquer purge.
- Servidor já em execução: o app reutiliza a porta/token salvos em
  `server.json` e roda a migração de caminhos.
- Falha do sidecar nunca derruba um turno: a captura nativa é gravada antes.
