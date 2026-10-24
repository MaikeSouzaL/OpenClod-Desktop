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
2. Uma página no AI-Memory em `s/<hash-da-sessão>/<timestamp>.md`, com o
   transcrito do turno, chamadas de ferramenta e saídas reais.

Isso acontece mesmo que o modelo nunca chame `memory_page`. Páginas curadas
criadas com `memory_page` são espelhadas em `pages/<slug>.md` para entrar no
índice de entidades e links.

## Recall antes de cada turno

Antes de montar o system prompt, o runner consulta o AI-Memory com o texto do
pedido e com as páginas recentes. O resultado entra na seção
**“Memória indexada do projeto (AI-Memory)”**. Assim uma LLM nova já começa
sabendo decisões, convenções, erros e conversas anteriores.

Ferramentas do agente:

- `memory_brief` — briefing nativo (páginas fixadas, recentes e handoffs).
- `memory_page` — criar/ler/listar/apagar páginas curadas.
- `memory_handoff` — passagem de bastão com dono único.
- `memory_recall` — busca no índice AI-Memory, com fallback lexical nativo.

## Interface

**Memória** aparece na barra lateral do Code quando existe pelo menos um
projeto. A tela mostra:

- páginas nativas e páginas indexadas que não são transcritos de sessão;
- contagem de páginas, fixadas, handoffs e páginas no índice;
- status do sidecar e porta;
- busca no índice AI-Memory;
- exportar/importar Markdown e abrir a pasta.

Transcritos de sessão ficam fora da grade para não afogar a lista; continuam
pesquisáveis pelo agente e por **Buscar no índice**.

## Exclusão

- **Remover da lista**: o projeto sai da lista; sessões, wiki e índice ficam.
- **Excluir projeto e memória**: apaga sessões, wiki nativa, regras
  “permitir sempre” e o projeto no AI-Memory (`/admin/purge-project`). A pasta
  do projeto no disco não é tocada.

## Resiliência

- Binário ausente: a wiki nativa continua funcionando.
- Caminhos longos do Windows: páginas antigas em `sessions/...` são migradas
  para `s/<hash>/...` no início, antes de qualquer purge.
- Servidor já em execução: o app reutiliza a porta/token salvos em
  `server.json` e roda a migração de caminhos.
- Falha do sidecar nunca derruba um turno: a captura nativa é gravada antes.
