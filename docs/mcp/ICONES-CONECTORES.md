# Logos dos conectores

> Relatório GERADO por `node scripts/connector-icons.mjs` (não edite à mão: a próxima coleta o reescreve).

A tela Personalização → Conectores mostra o logo original de cada serviço no lugar da letra. As imagens são **coletadas
em desenvolvimento e empacotadas no app** (`src/renderer/public/connector-icons/`): o Openclod **não faz nenhum pedido de rede para
carregar logos**, então a tela funciona offline e nenhum serviço de terceiros fica sabendo quais conectores você está olhando.

## Cobertura

| | Quantidade |
|---|---:|
| Conectores no diretório | 900 |
| Com `iconDomain` (domínio do fornecedor) | 875 |
| **Dessas, com logo real** | **863** (98.6%) — meta: 95% |
| Com logo (todas as entradas) | 882 (98.0%) |
| Sem logo (mostram as iniciais coloridas) | 18 |
| Arquivos de imagem | 898 (2.87 MB no total, 3 KB em média) |

## De onde veio cada logo

| Fonte | Logos |
|---|---:|
| Site do fornecedor (apple-touch-icon, link rel=icon, manifesto) | 526 |
| Ícone do próprio diretório do Claude (iconUrl) | 216 |
| simple-icons (glifo oficial na cor da marca) | 77 |
| Serviço de favicons (Google/DuckDuckGo), só na coleta | 58 |
| Escolha manual (scripts/data/connector-icons-overrides.json) | 5 |

A origem de **cada** imagem (arquivo, fonte, endereço, domínio, tamanho original e nota) está em `docs/mcp/icones-conectores.json`.

## Qualidade das imagens

Tamanho do arquivo de origem (a imagem final tem sempre 128 × 128 px):

| Origem | Logos |
|---|---:|
| Vetor (SVG) na origem: desenhado em alta resolução | 311 |
| 128 px ou mais | 468 |
| 64 a 127 px | 32 |
| 32 a 63 px (ampliado, fica mais suave) | 71 |

## Conectores sem logo (18)

Esses mostram as iniciais num quadrado colorido (sempre a mesma cor para o mesmo nome). Motivo de cada um:

| Id | Nome | Domínio | Por que ficou sem logo |
|---|---|---|---|
| `anthropic-economic-index` | Anthropic Economic Index | claude.com | sem marca: marca da Anthropic: o projeto não redistribui logos da Anthropic/Claude (THIRD_PARTY_NOTICES.md, seção 5) |
| `blackrock-advisor-center` | BlackRock Advisor Center | blackrock.com | link-icon@www.blackrock.com: imagem pequena demais (16x16) / link-icon@blackrock.com: imagem pequena demais (16x16) / google-s2@blackrock.com: imagem pequena demais (16x16) / duckduckgo@blackrock.com: imagem pequena demais (16x16) |
| `blaze-sql` | Blaze SQL | blazesql.com | erro: tempo esgotado (120s) |
| `claude-academy` | Claude Academy | claude.com | sem marca: marca da Anthropic: o projeto não redistribui logos da Anthropic/Claude (THIRD_PARTY_NOTICES.md, seção 5) |
| `demographic-and-health-surveys` | Demographic and Health Surveys | dhsprogram.com | apple-touch-icon@dhsprogram.com: HTTP 404 / apple-touch-icon@dhsprogram.com: HTTP 404 / link-icon@dhsprogram.com: HTTP 404 / link-icon@dhsprogram.com: HTTP 404 / apple-touch-icon@www.dhsprogram.com: HTTP 404 |
| `excel` | Excel | — | sem marca: servidor da comunidade (não é da Microsoft): usar a marca do Excel sugeriria endosso |
| `factset-ai-ready-data` | FactSet AI-Ready Data | factset.com | link-icon@www.factset.com: imagem pequena demais (16x16) / link-icon@factset.com: imagem pequena demais (16x16) / google-s2@factset.com: imagem pequena demais (16x16) / duckduckgo@factset.com: imagem pequena demais (16x16) |
| `fetch` | Fetch | — | sem marca: servidor de referência do MCP, sem marca própria |
| `filesystem` | Filesystem | — | sem marca: servidor de referência do MCP, sem marca própria |
| `markitdown` | MarkItDown (documentos) | github.com | sem domínio confiável e sem ícone no diretório |
| `memory` | Memory (grafo de conhecimento) | — | sem marca: servidor de referência do MCP, sem marca própria |
| `military-and-veteran-family-assistant` | Military and Veteran Family Assistant | claude.com | sem domínio confiável e sem ícone no diretório |
| `natoma` | Natoma | natoma.ai | site https://www.natoma.ai/: HTTP 402 / apple-touch-icon@www.natoma.ai: HTTP 402 / apple-touch-icon@www.natoma.ai: HTTP 402 / link-icon@www.natoma.ai: HTTP 402 / link-icon@www.natoma.ai: HTTP 402 |
| `open-targets` | Open Targets | opentargets.org | link-icon@www.opentargets.org: imagem pequena demais (16x16) / link-icon@opentargets.org: imagem pequena demais (16x16) / google-s2@opentargets.org: imagem pequena demais (16x16) / duckduckgo@opentargets.org: imagem pequena demais (16x16) |
| `pine-labs-payments-assistant` | Pine Labs Payments Assistant | pinelabs.com | site https://pinelabs.com/: HTTP 403 / apple-touch-icon@pinelabs.com: HTTP 403 / apple-touch-icon@pinelabs.com: HTTP 403 / link-icon@pinelabs.com: HTTP 403 / link-icon@pinelabs.com: HTTP 403 |
| `sequential-thinking` | Sequential Thinking | — | sem marca: servidor de referência do MCP, sem marca própria |
| `serena` | Serena (análise semântica) | github.com | sem domínio confiável e sem ícone no diretório |
| `time` | Time | — | sem marca: servidor de referência do MCP, sem marca própria |

## Como funciona

- **Coleta** (`scripts/connector-icons.mjs`): para cada conector junta candidatas de várias fontes e fica com a de maior nota. A nota favorece vetor (SVG) e imagem grande, e desconta imagem pequena (< 48 px) ou muito larga (um "wordmark"). Imagens menores que 32 px, páginas de erro e o ícone genérico de hospedagem (a mesma imagem em 3 ou mais domínios) são descartadas.
- **Normalização**: todo logo vira um ladrilho quadrado de 128 × 128 px. Logo com fundo transparente é centralizado com margem sobre um fundo claro — ou escuro, quando o logo é branco e sumiria. Ícone de app (quadrado cheio) ocupa o ladrilho inteiro. Os cantos arredondados são feitos pelo CSS.
- **simple-icons**: o glifo da marca fica num ladrilho na cor oficial da marca, em branco (ou quase-preto sobre cores muito claras, como o amarelo). O SVG é escrito pelo coletor só com o caminho e a cor, ambos validados.
- **Segurança**: o que vem de sites é dado não confiável. O coletor só aceita http(s) público (recusa endereço interno, inclusive em redirecionamentos), limita o tamanho das respostas, confere o tipo pelos primeiros bytes, limpa o SVG (sem `<script>`, `on*=`, `<foreignObject>`, `href` externo, `@import`, entidades) antes de rasterizar e só empacota WebP novo ou SVG escrito por ele. No app, o logo é sempre uma `<img>`, nunca SVG inline.
- **Domínio confiável**: o `iconDomain` do diretório às vezes é o de uma CDN ou de uma plataforma (`sanity.io`, `github.com`, `claude.com`). O coletor só procura o site de um domínio quando ele bate com o endereço do servidor MCP, com o site que o diretório indica ou com o nome da marca; nos demais casos usa só o ícone que o próprio diretório indica (ou deixa as iniciais) em vez de mostrar o logo da plataforma.
- **Anthropic/Claude**: a política do projeto (`THIRD_PARTY_NOTICES.md`, seção 5) é não redistribuir logos da Anthropic/Claude; esses conectores ficam com as iniciais.
- **Onde ficam e por quê**: em `src/renderer/public/` (o Vite copia a pasta como está para `out/renderer/connector-icons/`). Assim as ~900 imagens não entram no JavaScript (o índice que o app lê, `connector-icon-index.ts`, tem ~70 KB), o caminho relativo funciona no `npm run dev` (servidor), no `npm run build` e dentro do `app.asar` do instalador, e a CSP (`img-src 'self'`) já permite.
- **No app**: `ConnectorIcon` mostra a imagem pelo caminho relativo `connector-icons/<arquivo>`, em tamanho fixo (40 px no cartão, 46 px no detalhe), com `loading="lazy"` e `decoding="async"` para não pesar na grade de 900 cartões. Se não houver imagem ou ela falhar (`onError`), volta para as iniciais.
- **Conectores personalizados** (os que você adiciona): recebem o logo quando o nome ou o endereço apontam para uma marca conhecida (ex.: `whatsapp`, `appwrite-docs`, `mcp.mercadopago.com`). Os demais ficam com as iniciais.

## Como atualizar

```powershell
node scripts/connector-icons.mjs            # usa o cache; só pede o que falta
node scripts/connector-icons.mjs --refresh  # pede tudo de novo
node scripts/connector-icons.mjs --only github,notion
```

Para corrigir um logo errado ou ausente, edite `scripts/data/connector-icons-overrides.json` (`simpleIcon`, `iconUrl`, `domain` ou `skip` por id) e rode de novo.

## Marcas e licenças

Os logos são marcas registradas dos respectivos donos e aparecem **somente para identificar o serviço** a que o conector se refere; não indicam parceria nem endosso. O pacote [simple-icons](https://simpleicons.org) (16.36.0, CC0-1.0) é usado só em desenvolvimento; veja `THIRD_PARTY_NOTICES.md`.

