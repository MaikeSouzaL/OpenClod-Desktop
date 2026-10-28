# Diretório de conectores do Openclod

Gerado por `node scripts/mcp-directory-report.mjs` a partir de `resources/mcp-directory.json` (não edite à mão).
Fonte dos conectores remotos: diretório oficial de conectores do Claude, colhido com a ferramenta `search_mcp_registry`
(868 entradas, deduplicadas por `directoryUuid`); fonte dos locais: o catálogo próprio do Openclod
(`src/core/mcp/catalog.ts`, 32 entradas, 7 delas com o mesmo endpoint de uma entrada do diretório e portanto unificadas).

- **Total:** 900 conectores (878 remotos, 22 locais).
- **Remotos sem endpoint público no diretório:** 83 (não dá para sondar nem conectar sem a URL do usuário).
- **Sondagem:** 2026-10-27 (ver [SONDAGEM-2026-10-27.md](SONDAGEM-2026-10-27.md)). Nível de teste: N0 inalcançável · N1 alcançável · N2 chega ao login (401 + metadata OAuth) · N3 login possível (registro dinâmico + PKCE) · N4 conecta sem login · N5 conectado com a conta do usuário (não medido: exige login manual).
- **Ferramentas:** número informado pelo diretório (prévia + "+N more") ou contado em `tools/list` quando o servidor é aberto; "—" quando desconhecido; "N+" quando só há a prévia.

## Cobertura da coleta

A ferramenta `search_mcp_registry` não lista o diretório inteiro: devolve no máximo 10 resultados por consulta, com busca difusa (nome, descrição, prefixos). Por isso a coleta foi por varredura:

- **1ª onda:** 8 coletores temáticos (dev/nuvem, produtividade/comunicação, vendas/marketing/suporte, finanças/RH/jurídico/Brasil, ciência/saúde/viagens, mídia/IA/dados, segurança/TI/telecom, varredura geral e por prefixos): 641 consultas, 2.292 linhas, 817 conectores válidos únicos.
- **2ª onda:** 7 coletores por prefixos de 2–3 letras (todas as letras iniciais), com checagem de novidade contra o que já estava gravado: 444 consultas, +58 conectores. Cada coletor parou depois de 15–20 consultas seguidas sem nenhuma entrada nova.
- **Estimativa de tamanho** (captura–recaptura entre os coletores da 1ª onda, antes da 2ª): 845–891 conectores; o resultado final (875 do diretório do Claude, contando os 7 unificados ao catálogo próprio) é consistente com isso.
- **Limitação:** cerca de 1.085 consultas não provam que o diretório está 100% enumerado; entradas que nenhuma consulta alcançou (nomes muito incomuns) podem faltar. Para atualizar: `node scripts/mcp-directory-build.mjs --merge-shards <pasta com novos .jsonl>`.
- **Conferência de UUIDs:** os `directoryUuid` foram copiados da saída da ferramenta por agentes coletores; entradas repetidas entre coletores foram comparadas (2 UUIDs com erro de cópia foram detectados e corrigidos: OpenSEO e Cloudinary). Um erro de cópia não detectado afetaria só o campo `directoryUuid` (metadado), nunca a URL do endpoint, que foi validada pela própria sondagem.

## Produtividade (60)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Adobe Workfront | `https://mcp.workfront.adobe.com/mcp/v1/workfront` | OAuth (login + registro dinâmico) | N3 | 68 |
| Asana | `https://mcp.asana.com/v2/mcp` | OAuth (client id pré-registrado) | N2 | 15 |
| Asana (oficial) ·catálogo | `https://mcp.asana.com/sse` | OAuth (login + registro dinâmico) | N3 | — |
| Astravue App | `https://api.astravue.com/mcp` | OAuth (login + registro dinâmico) | N3 | 83 |
| Atlassian (API token) ·catálogo | `https://mcp.atlassian.com/v2/mcp` | Chave de API / token | N3 | — |
| Atlassian (Jira + Confluence, oficial) ·catálogo | `https://mcp.atlassian.com/v2/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Calendly | `https://mcp.calendly.com/` | OAuth (login + registro dinâmico) | N3 | 36 |
| Celigo | — | Não determinada | sem endpoint | 61 |
| Chaser | `https://api.trychaser.com/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| ClickUp | `https://mcp.clickup.com/mcp` | OAuth (login + registro dinâmico) | N3 | 35 |
| Cognito Forms | `https://mcp.cognitoforms.com/mcp` | OAuth (client id pré-registrado) | N2 | 10 |
| Craft | `https://mcp.craft.do/my/mcp` | OAuth (login + registro dinâmico) | N3 | 32 |
| Craft.io | — | Não determinada | sem endpoint | 31 |
| Desktop Commander ·catálogo | `npx -y @wonderwhy-er/desktop-commander@latest` | Nenhuma | local | — |
| Duvo | `https://api.duvo.ai/v2/mcp` | OAuth (login + registro dinâmico) | N4 | 205 |
| Evernote | `https://mcp.evernote.com/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Fibery | `https://mcp.fibery.io/mcp` | OAuth (login + registro dinâmico) | N3 | 94 |
| Filesystem ·catálogo | `npx -y @modelcontextprotocol/server-filesystem ${ALLOWED_PATH}` | Variáveis de ambiente (local) | local | — |
| Find Your Great | `https://findyourgreat.com/mcp/v1` | OAuth (login + registro dinâmico) | N3 | 44 |
| Google Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | OAuth (client id pré-registrado) | N4 | 9 |
| Hubstaff | `https://mcp.hubstaff.com/` | OAuth (client id pré-registrado) | N2 | 5 |
| IFTTT | `https://ifttt.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Jira + Confluence (local, mcp-atlassian) ·catálogo | `uvx mcp-atlassian` | Variáveis de ambiente (local) | local | — |
| Jotform | `https://mcp.jotform.com/mcp-app` | OAuth (login + registro dinâmico) | N3 | 11 |
| Linear (oficial) ·catálogo | `https://mcp.linear.app/mcp` | OAuth (login + registro dinâmico) | N3 | 22 |
| Make | `https://mcp.make.com/` | OAuth (login + registro dinâmico) | N3 | 67 |
| MeisterTask | `https://mcp.meistertask.com/mcp` | OAuth (client id pré-registrado) | N2 | 68 |
| Mem | `https://mcp.mem.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Memory (grafo de conhecimento) ·catálogo | `npx -y @modelcontextprotocol/server-memory` | Nenhuma | local | — |
| Microsoft 365 | `https://microsoft365.mcp.claude.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| MindMeister | `https://mcp.mindmeister.com/mcp` | OAuth (client id pré-registrado) | N2 | 32 |
| Miro | `https://mcp.miro.com/` | OAuth (login + registro dinâmico) | N3 | 31 |
| monday.com | `https://mcp.monday.com/mcp` | OAuth (login + registro dinâmico) | N3 | 33 |
| n8n | — | Não determinada | sem endpoint | 27 |
| Ninout | `https://mcp.svy.ooo/mcp` | OAuth (login + registro dinâmico) | N3 | 82 |
| Notion (oficial) ·catálogo | `https://mcp.notion.com/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Padlet | `https://mcp.padlet.com/` | OAuth (login + registro dinâmico) | N3 | 76 |
| Plaud | `https://mcp.plaud.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Process Street | `https://mcp.process.st/` | OAuth (login + registro dinâmico) | N3 | 32 |
| Productive | `https://mcp.productive.io/mcp` | OAuth (login + registro dinâmico) | N3 | 17 |
| Readwise | `https://mcp2.readwise.io/mcp` | OAuth (login + registro dinâmico) | N3 | 22 |
| Reclaim.ai | `https://mcp.reclaim.ai/` | OAuth (login + registro dinâmico) | N3 | 28 |
| Roam Research | `https://mcp.roamresearch.com/mcp/claude` | OAuth (login + registro dinâmico) | N3 | 20 |
| Robin (Workplace) | `https://mcp.robinpowered.com/mcp` | OAuth (login + registro dinâmico) | N3 | 46 |
| Sequential Thinking ·catálogo | `npx -y @modelcontextprotocol/server-sequential-thinking` | Nenhuma | local | — |
| Smartsheet | — | Não determinada | sem endpoint | 42 |
| Tally | `https://api.tally.so/mcp` | OAuth (login + registro dinâmico) | N3 | 28 |
| Tana | `https://home.tana.inc/mcp` | OAuth (login + registro dinâmico) | N3 | 35 |
| TickTick | `https://mcp.ticktick.com/` | OAuth (login + registro dinâmico) | N3 | 92 |
| Time ·catálogo | `uvx mcp-server-time` | Nenhuma | local | — |
| Todoist | `https://ai.todoist.net/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Trello | `https://mcp.trello.com/v1` | OAuth (login + registro dinâmico) | N3 | 15 |
| TwinMind | `https://api.twinmind.com/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Wispr Flow | `https://api.wisprflow.ai/connect/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Within | `https://api.within.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 17 |
| Workato | — | Não determinada | sem endpoint | — |
| Wrike | `https://mcp.wrike.com/v2` | OAuth (client id pré-registrado) | N2 | 29 |
| xTiles | `https://mcp.xtiles.app/mcp` | OAuth (login + registro dinâmico) | N3 | 28 |
| Zapier | `https://mcp.zapier.com/api/v1/connect` | OAuth (login + registro dinâmico) | N3 | — |
| Zoho Projects | — | Não determinada | sem endpoint | 30 |

## Desenvolvimento (49)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| AnythingMCP | `https://cloud.anythingmcp.com/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Base44 | `https://app.base44.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Bitrise MCP | `https://mcp.bitrise.io/` | OAuth (client id pré-registrado) | N2 | 83 |
| Chrome DevTools ·catálogo | `npx -y chrome-devtools-mcp@latest` | Nenhuma | local | — |
| CircleCI | `https://mcp.circleci.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| CodeWords | `https://runtime.codewords.ai/run/devx_mcp/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| CometChat | `https://mcp.cometchat.com/mcp` | Nenhuma | N4 | 4 |
| Context7 (documentação atualizada) ·catálogo | `https://mcp.context7.com/mcp` | Chave de API / token | N4 | 2 |
| dot. | `https://mcp.leaveadot.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Expo | `https://mcp.expo.dev/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| Floot | `https://mcp.floot.com/mcp` | OAuth (login + registro dinâmico) | N4 | 45 |
| Git ·catálogo | `uvx mcp-server-git --repository ${REPO_PATH}` | Variáveis de ambiente (local) | local | — |
| GitHub (oficial) ·catálogo | `https://api.githubcopilot.com/mcp/` | Chave de API / token | N2 | — |
| GraphOS MCP Tools | `https://mcp.apollographql.com/` | OAuth (login + registro dinâmico) | N4 | 48 |
| Infobip Documentation | `https://mcp.infobip.com/search` | Nenhuma | N4 | 1 |
| Intuit Developer | `https://ai-inc-developer.intuit.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |
| Jam | `https://mcp.jam.dev/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Jentic | `https://api.jentic.com/mcp` | OAuth (login + registro dinâmico) | N4 | 4 |
| Jotform App Builder | `https://mcp.jotform.com/mcp-jotform-apps-v1` | OAuth (login + registro dinâmico) | N3 | 6 |
| Laravel Boost ·catálogo | `php artisan boost:mcp` | Nenhuma | local | — |
| Lovable | `https://mcp.lovable.dev/` | OAuth (login + registro dinâmico) | N3 | 35 |
| Macaly Cloud | `https://www.macaly.com/api/cloud/claude/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Mastercard Developers | `https://developer.mcp.mastercard.com/` | Nenhuma | N4 | 9 |
| mcp.browserstack.com | `https://mcp.browserstack.com/mcp` | OAuth (login + registro dinâmico) | N3 | 37 |
| Meko | `https://mcp.mekodata.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 23 |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | Nenhuma | N4 | 3 |
| pg-aiguide | `https://mcp.tigerdata.com/docs` | Nenhuma | N4 | 2 |
| Playwright (navegador) ·catálogo | `npx -y @playwright/mcp@latest` | Nenhuma | local | — |
| Port IO | — | Não determinada | sem endpoint | 12 |
| Postman | `https://mcp.postman.com/minimal` | OAuth (login + registro dinâmico) | N3 | 42 |
| Promptless | `https://api.gopromptless.ai/mcp/with-direct-edits` | OAuth (login + registro dinâmico) | N3 | 19 |
| Replit | `https://replit-mcp.com/anthropic/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Retool | — | Não determinada | sem endpoint | 23 |
| Roboflow | `https://mcp.roboflow.com/mcp` | OAuth (login + registro dinâmico) | N3 | 67 |
| Runway (runway.team) | `https://mcp.runway.team/` | OAuth (login + registro dinâmico) | N3 | 56 |
| Serena (análise semântica) ·catálogo | `uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context ide-assi` | Nenhuma | local | — |
| Softr | `https://mcp.softr.io/mcp` | OAuth (client id pré-registrado) | N2 | 95 |
| Sourcegraph | — | Não determinada | sem endpoint | 13 |
| Stack Overflow | `https://mcp.stackoverflow.com/` | Não determinada | N1 | 3 |
| Subtext | `https://api.fullstory.com/mcp/subtext` | OAuth (login + registro dinâmico) | N3 | 15 |
| Swagger | `https://swagger.mcp.smartbear.com/mcp` | OAuth (login + registro dinâmico) | N3 | 22 |
| Tseha.io | `https://tseha.io/mcp` | OAuth (login + registro dinâmico) | N4 | 9 |
| Unblocked | `https://getunblocked.com/api/mcpsse` | OAuth (login + registro dinâmico) | N3 | 2 |
| v0 | `https://v0.app/api/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Vuetify MCP | `https://mcp.vuetifyjs.com/mcp` | Nenhuma | N4 | 28 |
| WebMCP Evaluator | `https://mcp.webmcp-eval.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Website Generator by B12 | `https://mcp.b12.io/mcp` | Nenhuma | N4 | 1 |
| WeWeb | `https://ai-api.weweb.io/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 125 |
| YouTrack | — | Não determinada | sem endpoint | 23 |

## Comunicação (33)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| AgentMail | `https://mcp.agentmail.to/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Bird | `https://mcp.bird.com/` | OAuth (login + registro dinâmico) | N3 | 337 |
| bolna | `https://mcp.bolna.ai/api/connector/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Circleback | `https://circleback.ai/api/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Fastmail | `https://api.fastmail.com/mcp` | OAuth (login + registro dinâmico) | N3 | 29 |
| Fathom – Your Meeting Intelligence Layer | `https://api.fathom.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Fellow.ai | `https://fellow.app/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Fireflies | `https://api.fireflies.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Fyxer | `https://app.fyxer.com/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | OAuth (client id pré-registrado) | N4 | 23 |
| Grain | `https://api.grain.com/_/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Granola | `https://mcp.granola.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Infobip Message | `https://mcp.infobip.com/message` | OAuth (login + registro dinâmico) | N3 | 2 |
| Inkbox | `https://inkbox.ai/mcp/anthropic` | OAuth (login + registro dinâmico) | N3 | 59 |
| LetsBot | `https://letsbot.net/mcp` | OAuth (login + registro dinâmico) | N3 | 58 |
| Livestorm | `https://mcp.livestorm.co/mcp` | OAuth (login + registro dinâmico) | N3 | 41 |
| Otter.ai | `https://mcp.otter.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Quo | `https://mcp.quo.com/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Resend | `https://mcp.resend.com/` | OAuth (login + registro dinâmico) | N3 | 85 |
| RingCentral Chat | `https://mcp.labs.ringcentral.com/ringex/v1.1.0/team-chat` | OAuth (login + registro dinâmico) | N3 | 9 |
| Sent | `https://mcp.sent.dm/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| Slack (oficial) ·catálogo | `https://mcp.slack.com/mcp` | OAuth (client id pré-registrado) | N2 | 11 |
| Speko | `https://mcp.speko.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 123 |
| Superhuman Mail | `https://mcp.mail.superhuman.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Synthflow | — | Não determinada | sem endpoint | 62 |
| Tactiq | `https://mcp.tactiq.io/` | OAuth (login + registro dinâmico) | N3 | 9 |
| tl;dv - AI Note Taker & Meeting Recorder: Transcripts, Summaries & Meeting Minutes | `https://mcp.tldv.io/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Twilio | `https://mcp.twilio.com/docs` | Nenhuma | N4 | 2 |
| Vibe AI | `https://mcp.vibe.us/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Vylo | `https://mcp.vylo.one/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Webex for Claude | `https://mcp.webexapis.com/mcp/webex-suite` | OAuth (client id pré-registrado) | N2 | 21 |
| Webex Meetings | `https://mcp.webexapis.com/mcp/webex-meeting` | OAuth (client id pré-registrado) | N2 | 8 |
| Zoom for Claude | `https://mcp.zoom.us/mcp/zoom/streamable` | OAuth (client id pré-registrado) | N2 | 9 |

## Design (20)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Adobe | `https://adobe-creativity.adobe.io/mcp` | OAuth (login + registro dinâmico) | N3 | 109 |
| Brandfetch | `https://mcp.brandfetch.io/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Canva | `https://mcp.canva.com/mcp` | OAuth (login + registro dinâmico) | N3 | 17 |
| Eraser | `https://app.eraser.io/api/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Excalidraw | `https://mcp.excalidraw.com/mcp` | Nenhuma | N4 | 5 |
| Figma | `https://mcp.figma.com/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Figma (app local) ·catálogo | `http://127.0.0.1:3845/mcp` | Nenhuma | local | — |
| Frontify | `https://mcp.frontify-integrations.com/mcp` | OAuth (login + registro dinâmico) | N3 | 53 |
| Lucid | `https://mcp.lucid.app/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Magic Patterns | `https://mcp.magicpatterns.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Mermaid Chart | `https://chatgpt.mermaid.ai/anthropic/mcp` | Nenhuma | N4 | 1 |
| Mobbin | `https://api.mobbin.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Moda - Slides and Designs | `https://agents.moda.app/mcp` | OAuth (login + registro dinâmico) | N3 | 38 |
| Three.js 3D Viewer | `https://example-server.modelcontextprotocol.io/threejs/mcp` | OAuth (login + registro dinâmico) | N4 | 2 |
| tldraw | `https://tldraw-mcp-app.tldraw.workers.dev/mcp` | Nenhuma | N4 | 6 |
| Trimble SketchUp | `https://api.sketchup.com/mcp/v1/sketchup/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Vani by Zoho | — | Não determinada | sem endpoint | 109 |
| Webflow | `https://mcp.webflow.com/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| Whimsical | `https://mcp.whimsical.com/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Wix | `https://mcp.wix.com/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |

## Dados e analytics (55)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Adobe Customer Journey Analytics | `https://cja-mcp.adobe.io/mcp` | OAuth (login + registro dinâmico) | N3 | 26 |
| Airtable | `https://mcp.airtable.com/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |
| Amplitude | — | Não determinada | sem endpoint | 14 |
| Aura | `https://mcp.auraintelligence.com/mcp` | Não determinada | N0 | 6 |
| Blaze SQL | `https://claude.blazesql.com/` | OAuth (login + registro dinâmico) | N3 | 12 |
| CData Connect AI | `https://mcp.cloud.cdata.com/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |
| ClickHouse | `https://mcp.clickhouse.cloud/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Collibra | — | Não determinada | sem endpoint | 29 |
| Contentsquare | `https://api.contentsquare.com/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| CorralData | `https://mcp.corraldata.com/mcp` | OAuth (login + registro dinâmico) | N3 | 40 |
| Coupler.io | `https://mcp.coupler.io/mcp/` | OAuth (login + registro dinâmico) | N3 | 4 |
| Dagster+ MCP | — | Não determinada | sem endpoint | 36 |
| Databricks Genie | — | Não determinada | sem endpoint | 5 |
| DataHub | `https://mcp.datahub.com/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| dbt | — | Não determinada | sem endpoint | 60 |
| Dremio Cloud | — | Não determinada | sem endpoint | 7 |
| Elastic Cloud Serverless | — | Não determinada | sem endpoint | 21 |
| Felt Maps | `https://felt.com/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| Flourish | `https://app.flourish.studio/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Fullstory | `https://api.fullstory.com/mcp/fullstory` | OAuth (login + registro dinâmico) | N3 | 29 |
| Google Cloud BigQuery | `https://bigquery.googleapis.com/mcp` | OAuth (client id pré-registrado) | N4 | 5 |
| Informatica Catalog Discovery | — | Não determinada | sem endpoint | 2 |
| Informatica Data Exploration | — | Não determinada | sem endpoint | 4 |
| Jedify | `https://be.jedify.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Metabase | — | Não determinada | sem endpoint | 11 |
| Microsoft Dataverse | — | Não determinada | sem endpoint | 11 |
| Mixpanel | `https://mcp.mixpanel.com/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| MongoDB Atlas | `https://mcp.mongodb.com/` | OAuth (client id pré-registrado) | N2 | 41 |
| Monte Carlo | `https://mcp.getmontecarlo.com/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| MoSPI | `https://mcp.mospi.gov.in/` | Nenhuma | N4 | 4 |
| MotherDuck | `https://api.motherduck.com/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Neon | `https://mcp.neon.tech/mcp` | OAuth (login + registro dinâmico) | N3 | 35 |
| Omni Analytics | `https://callbacks.omniapp.co/callback/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Orion by Gravity | `https://g.runorion.com/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Pendo | — | Não determinada | sem endpoint | 11 |
| Pigment | — | Não determinada | sem endpoint | 3 |
| PlanetScale | `https://mcp.pscale.dev/mcp/planetscale` | OAuth (login + registro dinâmico) | N3 | 15 |
| Plotly Cloud | `https://cloud.plotly.com/_mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Polar Analytics | `https://api.polaranalytics.com/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| PostgreSQL ·catálogo | `npx -y @modelcontextprotocol/server-postgres ${DATABASE_URL}` | Variáveis de ambiente (local) | local | — |
| PostHog | `https://mcp.posthog.com/mcp` | OAuth (login + registro dinâmico) | N3 | 57 |
| Prefect | `https://prefect.fastmcp.app/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Qlik | — | Não determinada | sem endpoint | 93 |
| Rippit | `https://mcp.rippit.com/mcp` | OAuth (login + registro dinâmico) | N3 | 23 |
| Savri | `https://savri.io/api/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Sigma | — | Não determinada | sem endpoint | 5 |
| Snowflake | — | Não determinada | sem endpoint | 2 |
| SQLite ·catálogo | `uvx --with mcp~=1.6 mcp-server-sqlite --db-path ${DB_PATH}` | Variáveis de ambiente (local) | local | — |
| Starburst | — | Não determinada | sem endpoint | 1 |
| Supabase | `https://mcp.supabase.com/mcp` | OAuth (login + registro dinâmico) | N3 | 32 |
| Supabase (local) ·catálogo | `npx -y @supabase/mcp-server-supabase@latest --access-token ${SUPABASE_ACCESS_TOKEN}` | Variáveis de ambiente (local) | local | — |
| ThoughtSpot Spotter | `https://agent.thoughtspot.app/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| WisdomAI | `https://mcp.wisdom.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 31 |
| Yardi Matrix | `https://matrixmcp.virtuoso.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 33 |
| Zite | `https://mcp.zite.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |

## Finanças (144)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Addepar MCP | `https://mcp.addepar.com/` | OAuth (login + registro dinâmico) | N3 | 15 |
| Aiera | `https://mcp-pub.aiera.com/` | OAuth (login + registro dinâmico) | N3 | 18 |
| Airwallex Developer | `https://mcp-demo.airwallex.com/developer` | OAuth (login + registro dinâmico) | N3 | 12 |
| Aiwyn Tax (formerly Column Tax) | `https://mcp.columnapi.com/mcp` | Não determinada | N0 | 9 |
| Aleph | `https://mcp.getaleph.com/mcp` | OAuth (login + registro dinâmico) | N3 | 155 |
| Alpha Vantage MCP Server | `https://mcp.alphavantage.co/mcp` | OAuth (login + registro dinâmico) | N3 | 126 |
| AngelList | `https://mcp.angellist.com/mcp` | OAuth (login + registro dinâmico) | N3 | 28 |
| Atlar | `https://mcp.atlar.com/mcp` | OAuth (client id pré-registrado) | N2 | 35 |
| Belvo MCP | `https://panorama-mcp.belvo.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Bigdata.com | `https://mcp.bigdata.com/` | OAuth (client id pré-registrado) | N2 | 25 |
| BiggerPockets | `https://www.biggerpockets.com/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| BILL | `https://gateway.prod.bill.com/ai-mcp-server/v1` | OAuth (client id pré-registrado) | N2 | 10 |
| BillingMart | `https://api.billingmart.com/mcp` | OAuth (login + registro dinâmico) | N3 | 168 |
| Black Diamond | `https://bd3.bdreporting.com/mcp` | OAuth (client id pré-registrado) | N2 | 6 |
| BlackRock Advisor Center | `https://ac360-mcp.blackrock.com/mcp` | Não determinada | N1 | 29 |
| Bling MCP | `https://mcp.bling.com.br/mcp` | OAuth (login + registro dinâmico) | N3 | 49 |
| Blockscout | `https://mcp.blockscout.com/mcp` | Nenhuma | N4 | 16 |
| Breezing | `https://mcp.breezing.io/mcp` | OAuth (login + registro dinâmico) | N3 | 60 |
| Brex | `https://api.brex.com/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| CAISey | `https://mcp.caisgroup.com/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Canary Data | `https://api.canary-data.com/mcp` | OAuth (client id pré-registrado) | N2 | 1 |
| Carta | `https://mcp.app.carta.com/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Cashfree | `https://mcp.cashfree.com/mcp` | OAuth (login + registro dinâmico) | N3 | 38 |
| Chargebee | — | Não determinada | sem endpoint | 45 |
| Chariot | `https://api.givechariot.com/mcp` | OAuth (client id pré-registrado) | N2 | 65 |
| ChartMogul | `https://mcp.chartmogul.com/` | OAuth (login + registro dinâmico) | N3 | 76 |
| Checkout.com | `https://mcp.checkout.com/` | OAuth (login + registro dinâmico) | N3 | 12 |
| Chronograph | `https://ai.chronograph.pe/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Clarity AI | `https://clarity-sfdr20-mcp.pro.clarity.ai/mcp` | Nenhuma | N4 | 6 |
| Clear Street | `https://api.clearstreet.com/v1/mcp` | OAuth (client id pré-registrado) | N2 | 23 |
| CoinDesk | `https://mcp.coindesk.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| CoinGecko | `https://mcp.coingecko.com/mcp` | Nenhuma | N4 | 13 |
| CoinMarketCap | `https://mcp.coinmarketcap.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Coinversa Pulse | `https://mcp.coinversa.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 101 |
| Conquest MCP Server | — | Não determinada | sem endpoint | 21 |
| Cotality | `https://mcp.cotality.com/mcp` | OAuth (client id pré-registrado) | N2 | 21 |
| Crypto.com | `https://mcp.crypto.com/market-data/mcp` | Nenhuma | N4 | 9 |
| Cube Software | `https://mcp.cubesoftware.com/` | OAuth (login + registro dinâmico) | N3 | 30 |
| D&B Finance Analytics | `https://mcp.financeanalytics.dnb.com/mcp` | OAuth (client id pré-registrado) | N2 | 5 |
| D&B Risk Analytics | `https://agents.riskanalytics.dnb.com/mcp` | OAuth (client id pré-registrado) | N2 | 33 |
| Daffy MCP | `https://public.daffy.org/mcp` | OAuth (client id pré-registrado) | N2 | 8 |
| Daloopa | `https://mcp.daloopa.com/server/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Datarails FinanceOS | `https://mcp.datarails.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Dext | `https://app.dext.com/mcp` | OAuth (login + registro dinâmico) | N3 | 26 |
| Digits | `https://api.digits.com/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| DualEntry | `https://api.dualentry.com/mcp` | OAuth (login + registro dinâmico) | N3 | 30 |
| Embat | `https://tellme.embat.io/mcp` | OAuth (login + registro dinâmico) | N3 | 1 |
| Energy Aspects | `https://mcp.energyaspects.com/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Entendre | `https://mcp.entendre.finance/api/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Era Context | `https://context.era.app/` | OAuth (login + registro dinâmico) | N3 | 27 |
| Etherscan | `https://mcp-keyless.etherscan.io/mcp` | Nenhuma | N4 | 17 |
| etoro | `https://mcp-readonly.public-api.etoro.com/` | OAuth (login + registro dinâmico) | N3 | 3 |
| Expensify | `https://www.expensify.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| FactSet AI-Ready Data | `https://mcp.factset.com/content/v1` | OAuth (login + registro dinâmico) | N3 | 23 |
| Financial Datasets | `https://mcp.financialdatasets.ai/` | OAuth (login + registro dinâmico) | N3 | 28 |
| Fiscal.ai | `https://api.fiscal.ai/mcp/sse` | OAuth (login + registro dinâmico) | N3 | 2 |
| Fitch Solutions | `https://api.fitch.group/nexus/mcp` | OAuth (client id pré-registrado) | N2 | 18 |
| Flourish Financial | `https://www.flourish.com/api/mcp/v2.0` | OAuth (client id pré-registrado) | N2 | 9 |
| FMP | `https://financialmodelingprep.com/mcp` | OAuth (client id pré-registrado) | N2 | 27 |
| Franklin Templeton Funds and Insights | `https://api.frk.com/mcp/v1/ft-funds-insights/mcp` | Não determinada | N1 | 2 |
| freee | `https://mcp.freee.co.jp/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| FreshBooks | `https://mcp.freshbooks.com/v1` | OAuth (login + registro dinâmico) | N3 | 20 |
| Gemini | `https://api.gemini.com/mcp` | OAuth (client id pré-registrado) | N4 | 19 |
| GoCardless | `https://mcp.gocardless.com/` | OAuth (login + registro dinâmico) | N3 | 2 |
| Grasp | `https://app.grasp-ai.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Grasshopper Bank | `https://grasshopper-mcp.prd.narmitech.com/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Hanover Park | `https://app.hanoverpark.com/api/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |
| Hebbia | — | Não determinada | sem endpoint | 6 |
| ICE Data Services | `https://fids-mcp.ice.com/mcp` | Não determinada | N1 | 6 |
| Interactive Brokers (IBKR) | `https://api.ibkr.com/v1/api/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Intuit Credit Karma | `https://anthropic.mcp.creditkarma.com/mcp` | Não determinada | N1 | 1 |
| Intuit QuickBooks | `https://ai-inc.quickbooks.intuit.com/v1/mcp` | Não determinada | N1 | 74 |
| Intuit TurboTax | `https://ai-inc.turbotax.intuit.com/358A1C1B-F73B-46A7-B130-4B14916E6843/v1/mcp` | Não determinada | N1 | 3 |
| Invesco for Advisors | `https://financial-professional-mcp.invesco.com/mcp` | Não determinada | N0 | 3 |
| J.P. Morgan Asset Management (55ip) | `https://mcp.55-ip.com/proposal-generation-mcp/mcp` | Não determinada | N0 | 4 |
| Jump | `https://my.jumpapp.com/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Keel | `https://mcp.usekeel.io/mcp` | OAuth (client id pré-registrado) | N2 | 29 |
| Kepler | `https://mcp.kepler.ai/api/mcp/v1` | OAuth (client id pré-registrado) | N2 | 9 |
| Kick | `https://use.kick.co/mcp` | OAuth (login + registro dinâmico) | N3 | 39 |
| Kpler | `https://claude.mcp.kpler.com/v1/mcp/` | OAuth (login + registro dinâmico) | N3 | 55 |
| Light | `https://api.light.inc/mcp` | OAuth (login + registro dinâmico) | N3 | 42 |
| LSEG | `https://api.analytics.lseg.com/lfa/mcp/server-cl` | OAuth (login + registro dinâmico) | N3 | 20 |
| LSEG AI | `https://mcp.lseg.com/` | OAuth (login + registro dinâmico) | N3 | 13 |
| Lukka Prediction Markets Data MCP | `https://predmar.mcp.lukka.tech/` | OAuth (login + registro dinâmico) | N3 | 12 |
| Lumonic | `https://mcp.lumonic.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| LunarCrush | `https://lunarcrush.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Mercury | `https://mcp.mercury.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Meridian AI | `https://mcp.meridian-ai.com/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Meridian Connector for QuickBooks | `https://qbo-connector.meridian.pilot.com/mcp` | OAuth (login + registro dinâmico) | N3 | 63 |
| Meridian Connector for Xero | `https://xero-connector.meridian.pilot.com/mcp` | OAuth (login + registro dinâmico) | N3 | 64 |
| Metal | `https://mcp.metal.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Mollie | `https://mcp.mollie.com/mcp` | OAuth (login + registro dinâmico) | N3 | 68 |
| Moody's Credit MCP | `https://mcp.moodys.com/genai-ready-data/Credit/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Morningstar | `https://mcp.morningstar.com/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Morningstar Credit Analytics | `https://mcp.analytics.credit.morningstar.com/mcp` | OAuth (client id pré-registrado) | N2 | 22 |
| MSCI Connector | `https://mcp.msci.com/mcp/v1.0/mcp` | OAuth (login + registro dinâmico) | N3 | 36 |
| MT Newswires | `https://mcp.mtnewswires.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| MYOB | `https://mcp.myob.com/mcp` | OAuth (client id pré-registrado) | N2 | 7 |
| NetSuite | — | Não determinada | sem endpoint | 17 |
| Nevis | `https://app.neviswealth.com/mcp` | OAuth (client id pré-registrado) | N2 | 21 |
| NumbersGame MCP | `https://mcp.numbersgame.xyz/mcp` | OAuth (login + registro dinâmico) | N3 | 158 |
| Omega Point | `https://mcp.ompnt.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Orion | `https://gateway.oriondenali.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Oxford Economics | `https://services.oxfordeconomics.com/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Payhawk | `https://mcp.payhawk.com/mcp` | OAuth (login + registro dinâmico) | N3 | 85 |
| PayPal | `https://mcp.paypal.com/mcp` | OAuth (login + registro dinâmico) | N3 | 28 |
| Paytm Payment Gateway | `https://mcp.paytmpayments.com/mcp` | OAuth (login + registro dinâmico) | N2 | 12 |
| PicPay | `https://mcp.svc.picpay.com/v2/mcp` | Não determinada | N1 | 13 |
| Pine Labs Payments Assistant | `https://mcp.pinelabs.com/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Pinegap | `https://mcp.pinegap.ai/` | OAuth (login + registro dinâmico) | N3 | 28 |
| PitchBook Premium | `https://premium.mcp.pitchbook.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Plaid Developer Tools | `https://api.dashboard.plaid.com/mcp/sse` | OAuth (login + registro dinâmico) | N3 | 4 |
| PocketSmith Complete Access | `https://mcp.pocketsmith.com/mcp` | OAuth (login + registro dinâmico) | N3 | 66 |
| Privacy.com | `https://mcp.privacy.com/` | OAuth (login + registro dinâmico) | N3 | 10 |
| Qonto | `https://mcp.qonto.com/mcp` | OAuth (login + registro dinâmico) | N3 | 52 |
| Quartr | `https://mcp.quartr.com/mcp` | OAuth (login + registro dinâmico) | N3 | 38 |
| QuickStart | `https://my.quickstartapi.netsuite.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Ramp | `https://ramp-mcp-remote.ramp.com/mcp` | OAuth (login + registro dinâmico) | N3 | 17 |
| Ramp Data | `https://mcp.ramp.com/ramp-data/anthropic/mcp` | OAuth (login + registro dinâmico) | N4 | 9 |
| Ratehub Mortgage | `https://api.ratehub.ca/claude-app/mortgages/mcp` | Nenhuma | N4 | 4 |
| Razorpay | `https://mcp.razorpay.com/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| Revolut X | `https://mcp.revolut.com/revolut-x` | OAuth (client id pré-registrado) | N2 | 13 |
| Rillet | `https://api.rillet.com/mcp` | OAuth (login + registro dinâmico) | N3 | 81 |
| S&P - Deterministic Retrieval | `https://kfinance.kensho.com/integrations/mcp` | OAuth (login + registro dinâmico) | N3 | 22 |
| S&P Global - Adaptive Retrieval | `https://grounding.kensho.com/integrations/v2/mcp` | OAuth (login + registro dinâmico) | N3 | — |
| Sequence | `https://eu.sequencehq.com/mcp` | OAuth (login + registro dinâmico) | N3 | 18 |
| Square | `https://mcp.squareup.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Stripe | `https://mcp.stripe.com/` | OAuth (login + registro dinâmico) | N3 | 11 |
| Stripe (local) ·catálogo | `npx -y @stripe/mcp --api-key=${STRIPE_SECRET_KEY}` | Variáveis de ambiente (local) | local | — |
| stub | `https://api.stub.africa/mcp` | OAuth (login + registro dinâmico) | N3 | 121 |
| SuperBooks | `https://app.superbooks.io/mcp` | OAuth (login + registro dinâmico) | N3 | 37 |
| Tabs | `https://integrators.prod.api.tabsplatform.com/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| TaxAct | `https://mcp.taxact.com/mcp` | Nenhuma | N4 | 8 |
| TEXT TO QUANT | `https://www.texttoquant.com/api/mcp` | OAuth (login + registro dinâmico) | N3 | 77 |
| Tiller | `https://ai-tools.tillermoney.com/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Twelve Data | `https://mcp.twelvedata.com/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Vanguard Advisor Tools | `https://mcp.vanguard.com/advisors` | Não determinada | N1 | 1 |
| Verisk Underwriting Intelligence | `https://gatewaymcp.verisk.com/underwriting/intelligencemcp/v1` | OAuth (client id pré-registrado) | N2 | 5 |
| viaNexus vAST | `https://vast.blueskyapi.com/vianexus/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Wealth.com | `https://mcp.wealth.com/mcp` | OAuth (client id pré-registrado) | N2 | 9 |
| Webull | `https://api.webull.com/mcp` | OAuth (login + registro dinâmico) | N3 | 71 |
| Xero | `https://mcp.xero.com/mcp` | OAuth (client id pré-registrado) | N2 | 20 |
| Zacks Data | `https://mcp.zacksdata.com/` | OAuth (login + registro dinâmico) | N3 | 4 |
| Zoho Books | — | Não determinada | sem endpoint | 49 |

## Vendas e CRM (76)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Actively | `https://api.actively.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Affinity | `https://mcp.affinity.co/mcp` | OAuth (client id pré-registrado) | N2 | 31 |
| AfterShip Channels for TikTok Shop | `https://mcp.aftership.com/channels` | OAuth (login + registro dinâmico) | N3 | 28 |
| AfterShip Post-Purchase | `https://mcp.aftership.com/post-purchase` | OAuth (login + registro dinâmico) | N3 | 22 |
| Amazon Selling Partner | `https://sellingpartner-ai.amazon.com/mcp` | OAuth (client id pré-registrado) | N2 | 8 |
| Apollo.io | `https://mcp.apollo.io/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Attention | `https://api.attention.tech/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Attio | `https://mcp.attio.com/mcp` | OAuth (login + registro dinâmico) | N3 | 23 |
| AutoRFP.ai | — | Não determinada | sem endpoint | 7 |
| Badger Maps (Standard) | `https://mcp.badgermapping.com/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Bigin by Zoho CRM | — | Não determinada | sem endpoint | 4 |
| Blackthorn Forge MCP for Native Salesforce Event Management | `https://forge.blackthorn.io/api/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Bonsai | `https://mcp.hellobonsai.com/mcp` | OAuth (login + registro dinâmico) | N3 | 39 |
| Carrefour | `https://claude.mcp.carrefour.fr/v1.2/mcp` | Não determinada | N1 | 8 |
| Clarify | `https://api.clarify.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 26 |
| Clay | `https://api.clay.com/v3/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Close | `https://mcp.close.com/mcp` | OAuth (login + registro dinâmico) | N3 | 55 |
| Cloze MCP | `https://api.cloze.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| Common Room | `https://mcp.commonroom.io/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Crossbeam | `https://mcp.crossbeam.com/` | OAuth (login + registro dinâmico) | N3 | 14 |
| Crustdata | `https://mcp.crustdata.com/mcp` | OAuth (login + registro dinâmico) | N3 | 23 |
| D&B Hoovers | `https://mcp.hoovers.dnb.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Day AI | `https://day.ai/api/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| EULER | `https://mcp.eulerapp.com/mcp` | OAuth (login + registro dinâmico) | N3 | 50 |
| Fourthwall | `https://mcp.fourthwall.com/app` | OAuth (login + registro dinâmico) | N4 | 143 |
| G2 | `https://mcp.g2.com/mcp` | OAuth (client id pré-registrado) | N2 | 9 |
| Glovo | `https://api.glovoapp.com/discovery-mcp/mcp` | Não determinada | N1 | 2 |
| Harmonic | `https://mcp.api.harmonic.ai/` | OAuth (login + registro dinâmico) | N3 | 23 |
| Helium 10 | `https://mcp.helium10.com/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| Highspot | `https://mcp.highspot.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| HubSpot | `https://mcp.hubspot.com/anthropic` | OAuth (client id pré-registrado) | N2 | 36 |
| Instacart | `https://fig-mcp.instacart.com/mcp` | OAuth (client id pré-registrado) | N2 | 2 |
| Intapp Celeste | — | Não determinada | sem endpoint | 17 |
| item | `https://mcp.item.app/mcp` | OAuth (login + registro dinâmico) | N3 | 22 |
| Jobber | `https://mcp.getjobber.com/mcp` | OAuth (client id pré-registrado) | N2 | 20 |
| Kajabi | `https://mcp.kajabi.com/mcp` | OAuth (login + registro dinâmico) | N3 | 126 |
| Klue | `https://mcp.app.klue.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Leadfeeder | `https://mcp.leadfeeder.com/mcp` | OAuth (login + registro dinâmico) | N3 | 58 |
| Lightfield | `https://mcp.lightfield.app/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Lusha | `https://mcp.lusha.com/mcp/claude` | OAuth (login + registro dinâmico) | N3 | 24 |
| Merchkit | `https://www.merchkit.com/api/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Mojo — Pocket Capture | `https://mcp.mojosystems.io/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| MyChatBot | `https://connector.mychatbot.app/mcp` | OAuth (login + registro dinâmico) | N3 | 38 |
| Nooks | `https://mcp.nooks.in/mcp` | OAuth (client id pré-registrado) | N2 | — |
| Nutshell CRM | `https://app.nutshell.com/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Outreach | `https://api.outreach.io/mcp/` | OAuth (login + registro dinâmico) | N3 | 15 |
| Paybooc | `https://open.paybooc.co.kr/pybc/api/mcp/shopping/claude` | Nenhuma | N4 | 1 |
| Phoenix by HG Insights | `https://phoenix.hginsights.com/api/ai/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Pipedrive | `https://mcp.pipedrive.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 79 |
| Print.com | `https://mcp.print.com/` | OAuth (client id pré-registrado) | N2 | 8 |
| Revealed | `https://mcp.revealed.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| RocketReach | `https://mcp.rocketreach.co/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Salesflare | `https://mcp.salesflare.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Salesforce | — | Não determinada | sem endpoint | 4 |
| Salesloft | `https://mcp.salesloft.com/sse` | OAuth (login + registro dinâmico) | N3 | 14 |
| Seamless | `https://mcp.seamless.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 54 |
| Seismic | `https://mcp.seismic.com/claude` | OAuth (client id pré-registrado) | N2 | 3 |
| Sendcloud | `https://mcp.sendcloud.com/mcp` | OAuth (client id pré-registrado) | N2 | 114 |
| ShipBob | `https://api.shipbob.com/developer-api/mcp` | OAuth (login + registro dinâmico) | N3 | 72 |
| Shippo | `https://mcp.shippo.com/` | OAuth (login + registro dinâmico) | N3 | 4 |
| Shipt | `https://member-api.shipt.com/marketplace-mcp/v2.0/mcp` | Não determinada | N1 | 2 |
| Shop | `https://mcp.shop.com/` | OAuth (client id pré-registrado) | N4 | 17 |
| Shopify | `https://setup.shopify.com/mcp` | OAuth (client id pré-registrado) | N4 | 37 |
| Spara | `https://app.spara.co/mcp/customer/stream` | OAuth (login + registro dinâmico) | N3 | 21 |
| Sprouts Data Intelligence | `https://sprouts-mcp-server.kartikay-dhar.workers.dev/` | OAuth (login + registro dinâmico) | N4 | 22 |
| Sumble | `https://mcp.sumble.com/` | OAuth (login + registro dinâmico) | N3 | 23 |
| Supersei CRM | `https://api.supersei.com/mcp` | OAuth (login + registro dinâmico) | N3 | 198 |
| Sybill | `https://mcp.sybill.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Trussi AI | `https://my.trussi.ai/api/mcp/mcp` | OAuth (login + registro dinâmico) | N3 | 32 |
| Unify | `https://mcp.unifygtm.com/mcp` | OAuth (client id pré-registrado) | N2 | 50 |
| Valuecase App | `https://mcp.valuecase.com/mcp` | OAuth (login + registro dinâmico) | N3 | 35 |
| Vibe Prospecting | `https://vibeprospecting.explorium.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |
| Wealthbox | `https://mcp.crmworkspace.com/mcp` | OAuth (client id pré-registrado) | N2 | 67 |
| Zocks | `https://mcp.zocks.io/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Zoho CRM | — | Não determinada | sem endpoint | 41 |
| ZoomInfo | `https://mcp.zoominfo.com/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |

## Marketing (60)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Abency | `https://app.abency.com/mcp` | OAuth (login + registro dinâmico) | N3 | 47 |
| ActiveCampaign | — | Não determinada | sem endpoint | 32 |
| Adobe CX Enterprise Coworker | `https://mcp.coworker.experience.adobe.io/` | OAuth (login + registro dinâmico) | N3 | 9 |
| Adobe Experience Manager | `https://mcp.adobeaemcloud.com/adobe/mcp/aem` | OAuth (login + registro dinâmico) | N3 | 5 |
| Adobe Journey Optimizer | `https://ajo-mcp.adobe.io/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Adspirer Ads & Performance Marketing Agent | `https://mcp.adspirer.com/mcp` | OAuth (login + registro dinâmico) | N3 | 18 |
| Adspirer Search Ads | `https://mcp.adspirer.com/search-ads` | OAuth (login + registro dinâmico) | N3 | 15 |
| Adspirer Social Ads | `https://mcp.adspirer.com/social-ads` | OAuth (login + registro dinâmico) | N3 | 10 |
| AdWhispr Ads | `https://adwhispr.com/api/claude/mcp` | OAuth (login + registro dinâmico) | N3 | 33 |
| Agility CMS | `https://mcp.agilitycms.com/api/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Ahrefs | `https://api.ahrefs.com/mcp/mcp` | OAuth (login + registro dinâmico) | N3 | 61 |
| AirOps | `https://app.airops.com/mcp` | OAuth (login + registro dinâmico) | N3 | 12 |
| AthenaHQ | `https://api.athenahq.ai/api/mcp` | OAuth (login + registro dinâmico) | N4 | 85 |
| beehiiv | `https://mcp.beehiiv.com/mcp` | OAuth (login + registro dinâmico) | N3 | 198 |
| Bitly | `https://api-ssl.bitly.com/v4/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Botify MCP | `https://mcp.botify.com/` | OAuth (login + registro dinâmico) | N3 | 44 |
| Brand24 | `https://mcp.brand24.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Braze | — | Não determinada | sem endpoint | 42 |
| Brevo | `https://mcp.brevo.com/v1/anthropic/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Conductor | `https://mcp-universal.conductor.com/mcp/v3` | OAuth (client id pré-registrado) | N2 | 4 |
| Constant Contact | `https://mcp.apps.constantcontact.com/public_api/mcp` | OAuth (login + registro dinâmico) | N4 | 18 |
| Customer.io | — | Não determinada | sem endpoint | 8 |
| D&B Digital Audiences | `https://mcp.atportal.dnb.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Eulerian Marketing Platform | — | Não determinada | sem endpoint | 134 |
| FINNY | `https://mcp.finny.com/mcp` | Não determinada | N0 | 9 |
| Funnel | — | Não determinada | sem endpoint | 8 |
| GrowSurf | `https://mcp.growsurf.com/` | OAuth (login + registro dinâmico) | N3 | 63 |
| Helena by Enrich Labs | `https://agent.enrichlabs.ai/api/mcp` | OAuth (login + registro dinâmico) | N3 | 1 |
| Insider One | `https://mcp.insiderone.com/mcp` | OAuth (client id pré-registrado) | N2 | 3 |
| Intuit Mailchimp | `https://ai-inc.mailchimp.com/claude/mcp/v2` | Não determinada | N1 | 12 |
| Jasper | `https://mcp.jasper.ai/` | OAuth (login + registro dinâmico) | N3 | 7 |
| Kit | `https://app.kit.com/mcp` | OAuth (login + registro dinâmico) | N3 | 83 |
| Klaviyo | `https://mcp.klaviyo.com/mcp` | OAuth (login + registro dinâmico) | N3 | 27 |
| Local Falcon | `https://mcp.localfalcon.com/` | OAuth (login + registro dinâmico) | N3 | 37 |
| MailerLite | `https://mcp.mailerlite.com/mcp` | OAuth (login + registro dinâmico) | N3 | 45 |
| Meltwater | `https://api.meltwater.com/v2/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Metricool Social Media Management | `https://ai.metricool.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Motion Creative Analytics | `https://projects.motionapp.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Notra | `https://mcp.usenotra.com/mcp` | OAuth (login + registro dinâmico) | N3 | 97 |
| Omnisend MCP | `https://mcp.omnisend.com/v2/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| OneSignal | `https://api.onesignal.com/mcp/oauth` | OAuth (login + registro dinâmico) | N3 | 29 |
| OpenRush | `https://api.openrush.com/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| OpenSEO | `https://app.openseo.so/mcp` | OAuth (login + registro dinâmico) | N3 | 46 |
| Orshot | `https://mcp.orshot.com/mcp` | OAuth (login + registro dinâmico) | N3 | 97 |
| Peec AI | `https://api.peec.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Perspective AI | `https://getperspective.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 35 |
| Productised | `https://mcp.productised.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 73 |
| Profound | `https://mcp.tryprofound.com/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Pushwoosh ManyMoney | — | Não determinada | sem endpoint | 375 |
| Semrush | `https://mcp.semrush.com/claude/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Similarweb | `https://mcp.similarweb.com/` | OAuth (login + registro dinâmico) | N3 | 22 |
| Supermetrics Marketing Analytics | `https://mcp.supermetrics.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Taplio | `https://mcp.taplio.com/` | OAuth (login + registro dinâmico) | N3 | 19 |
| TikTok for Business | `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer-anthropic` | OAuth (login + registro dinâmico) | N3 | 39 |
| Typefully - Social Media Scheduler | `https://mcp.typefully.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Ubersuggest | `https://ubersuggest-mcp.neilpatelapi.com/mcp` | OAuth (login + registro dinâmico) | N3 | 42 |
| vidIQ | `https://mcp.vidiq.com/mcp` | OAuth (login + registro dinâmico) | N3 | 43 |
| Voluum | `https://mcp.voluum.com/mcp` | OAuth (login + registro dinâmico) | N3 | 196 |
| Windsor.ai | `https://mcp.windsor.ai/` | OAuth (login + registro dinâmico) | N3 | 5 |
| Wingify | — | Não determinada | sem endpoint | 29 |

## Suporte ao cliente (17)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Chatbase | `https://mcp.chatbase.co/api/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| DevRev | `https://api.devrev.ai/mcp/v1` | OAuth (login + registro dinâmico) | N3 | 14 |
| Enterpret | `https://wisdom-api.enterpret.com/server/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Freshservice | — | Não determinada | sem endpoint | 35 |
| Gainsight (CS) | — | Não determinada | sem endpoint | 14 |
| Gainsight (Customer Communities) | `https://mcp.insided.com/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Gainsight (Staircase AI) | `https://mcp.staircase.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| InfiniteWatch MCP | `https://mcp.infinitewatch.ai/mcp` | OAuth (login + registro dinâmico) | N4 | 8 |
| Intercom | `https://mcp.intercom.com/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Lorikeet | `https://mcp.lorikeetcx.ai/` | OAuth (login + registro dinâmico) | N3 | 106 |
| Pylon | `https://mcp.usepylon.com/` | OAuth (login + registro dinâmico) | N3 | 10 |
| Richpanel AI | `https://mcp.richpanel.com/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Risotto | `https://dashboard.tryrisotto.com/settings/integrations/mcp` | Não determinada | N1 | 22 |
| ServiceNow | — | Não determinada | sem endpoint | — |
| Unthread | `https://app.unthread.io/api/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Unwrap | `https://nlp.api.production.unwrap.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 17 |
| Zoho Desk | — | Não determinada | sem endpoint | 41 |

## Documentos (52)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Autodesk Product Help | `https://developer.api.autodesk.com/knowledge/public/v1/mcp` | OAuth (client id pré-registrado) | N4 | 2 |
| Autosheet | `https://mcp.autosheet.com/mcp` | OAuth (login + registro dinâmico) | N4 | 5 |
| Box | `https://mcp.box.com/` | OAuth (client id pré-registrado) | N2 | 20 |
| Brightdeck | `https://api.brightdeck.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Contentful MCP | `https://mcp.contentful.com/mcp` | OAuth (login + registro dinâmico) | N3 | 70 |
| Datasite | `https://mcp.global.datasite.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| DeepL | `https://mcp.deepl.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Docfarm | `https://mcp.doc.farm/` | OAuth (login + registro dinâmico) | N4 | 22 |
| docsend.com | `https://docsend.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| DocuSeal | `https://docuseal.com/mcp` | OAuth (client id pré-registrado) | N2 | 4 |
| Docusign | `https://mcp.docusign.com/mcp` | OAuth (client id pré-registrado) | N2 | 20 |
| Dropbox | `https://mcp.dropbox.com/claude_app_mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Egnyte | `https://mcp-server.egnyte.com/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| Excel ·catálogo | `npx -y @negokaz/excel-mcp-server` | Variáveis de ambiente (local) | local | — |
| Extend | `https://mcp.extend.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 86 |
| Files.com | `https://app.files.com/api/ai/mcp/v1` | OAuth (client id pré-registrado) | N2 | 61 |
| Gamma | `https://mcp.gamma.app/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| Goodnotes | `https://claude-mcp-api.ml.goodnotes.com/mcp` | Nenhuma | N4 | 3 |
| Google Docs | `https://docsmcp.googleapis.com/mcp/v1` | OAuth (client id pré-registrado) | N4 | 2 |
| Google Drive | `https://drivemcp.googleapis.com/mcp/v1` | OAuth (client id pré-registrado) | N4 | 8 |
| Google Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` | OAuth (client id pré-registrado) | N4 | 6 |
| Google Slides | `https://slidesmcp.googleapis.com/mcp/v1` | OAuth (client id pré-registrado) | N4 | 4 |
| grtwo-docs | `https://www.grtwo.app/api/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Guru | `https://mcp.api.getguru.com/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Ideals | `https://gateway.idealsvdr.com/mcp` | OAuth (client id pré-registrado) | N2 | 50 |
| Idiolect | `https://idiolect.app/api/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| iManage Work | `https://cloudimanage.com/mcp/work` | OAuth (login + registro dinâmico) | N3 | 14 |
| Jotform Sign | `https://mcp.jotform.com/mcp-sign-v1` | OAuth (login + registro dinâmico) | N3 | 11 |
| LlamaParse | `https://mcp.llamaindex.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 22 |
| Lumin | `https://mcp.luminpdf.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| MarkItDown (documentos) ·catálogo | `uvx markitdown-mcp` | Nenhuma | local | — |
| Menti | `https://ai.mentimeter.com/api/mcp` | OAuth (client id pré-registrado) | N2 | 8 |
| Mintlify | `https://mcp.mintlify.com/` | OAuth (login + registro dinâmico) | N3 | 15 |
| NetDocuments | — | Não determinada | sem endpoint | 2 |
| PandaDoc | `https://mcp.pandadoc.com/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Papermark | `https://mcp.papermark.com/mcp` | OAuth (login + registro dinâmico) | N3 | 46 |
| PaperOffice | `https://mcp.paperoffice.ai/claude` | OAuth (login + registro dinâmico) | N3 | 339 |
| PDF Viewer | `https://example-server.modelcontextprotocol.io/pdf/mcp` | OAuth (login + registro dinâmico) | N4 | 4 |
| PDF.net | `https://mcp.pdf.net/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| Pitch | `https://mcp.pitch.com/mcp` | OAuth (client id pré-registrado) | N2 | 22 |
| Rockhopper | `https://mcp.rockhopper.co/mcp` | OAuth (login + registro dinâmico) | N3 | 25 |
| Sanity | `https://mcp.sanity.io/` | OAuth (login + registro dinâmico) | N3 | 31 |
| Send | `https://www.send.co/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Signeasy | `https://mcp.signeasy.com/mcp/sse` | OAuth (login + registro dinâmico) | N3 | 27 |
| SignNow | `https://mcp-server.signnow.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| SlidesGPT | `https://claude.slidesgpt.com/mcp` | Nenhuma | N4 | 2 |
| Smartling | `https://mcp.smartling.com/mcp` | OAuth (login + registro dinâmico) | N3 | 53 |
| Superhuman Docs | `https://docs.superhuman.com/apis/mcp` | OAuth (login + registro dinâmico) | N3 | 32 |
| Unstructured Transform | `https://mcp.transform.unstructured.io/` | OAuth (login + registro dinâmico) | N3 | 6 |
| WeTransfer | `https://mcp-server.wetransfer.com/mcp` | OAuth (login + registro dinâmico) | N3 | 1 |
| WordPress.com | `https://public-api.wordpress.com/wpcom/v2/mcp/v1` | OAuth (login + registro dinâmico) | N3 | 16 |
| Zoho Show | — | Não determinada | sem endpoint | 68 |

## Nuvem e infraestrutura (34)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Alpic | `https://mcp.alpic.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| AWS Marketplace | `https://marketplace-mcp.us-east-1.api.aws/mcp` | Nenhuma | N4 | 6 |
| AWS MCP | — | Não determinada | sem endpoint | 9 |
| Bronto | — | Não determinada | sem endpoint | 16 |
| Catalyst by Zoho | — | Não determinada | sem endpoint | 4 |
| CloudBees Unify MCP Server | `https://mcp.cloudbees.io/v1/mcp` | OAuth (login + registro dinâmico) | N3 | 110 |
| Cloudflare Developer Platform | `https://bindings.mcp.cloudflare.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Control Plane | `https://mcp.cpln.io/mcp` | OAuth (login + registro dinâmico) | N3 | 71 |
| Coralogix | — | Não determinada | sem endpoint | 16 |
| Datadog | — | Não determinada | sem endpoint | 182 |
| Firebase ·catálogo | `npx -y firebase-tools@latest mcp` | Nenhuma | local | — |
| GoDaddy | `https://api.godaddy.com/v1/domains/mcp` | Nenhuma | N4 | 2 |
| Google Compute Engine | `https://compute.googleapis.com/mcp` | OAuth (client id pré-registrado) | N4 | 29 |
| Grafana Cloud | `https://mcp.grafana.com/mcp` | OAuth (login + registro dinâmico) | N3 | 61 |
| Harness | `https://mcp.harness.io/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Honeybadger | — | Não determinada | sem endpoint | 39 |
| Honeycomb | `https://mcp.honeycomb.io/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| incident.io | `https://mcp.incident.io/mcp` | OAuth (login + registro dinâmico) | N3 | 35 |
| Manufact | `https://mcp.manufact.com/mcp` | OAuth (login + registro dinâmico) | N3 | 18 |
| mcp.betterstack.com | `https://mcp.betterstack.com/` | OAuth (login + registro dinâmico) | N3 | 116 |
| mittwald | `https://mcp.mittwald.de/mcp` | OAuth (login + registro dinâmico) | N3 | 116 |
| MuleSoft | `https://omni.mulesoft.com/mcp` | OAuth (client id pré-registrado) | N2 | 66 |
| MuuMuu Domain byGMO Pepabo | `https://mcp.muumuu-domain.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Netlify | `https://netlify-mcp.netlify.app/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| PagerDuty | `https://mcp.pagerduty.com/mcp` | OAuth (client id pré-registrado) | N2 | 64 |
| QuickNode | `https://mcp.quicknode.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Railway | `https://mcp.railway.com/` | OAuth (login + registro dinâmico) | N3 | 16 |
| Render | `https://mcp.render.com/mcp` | OAuth (client id pré-registrado) | N2 | 25 |
| Rootly | `https://mcp.rootly.com/mcp` | OAuth (login + registro dinâmico) | N3 | 255 |
| Sentry (oficial) ·catálogo | `https://mcp.sentry.dev/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| Sprites | `https://sprites.dev/mcp` | OAuth (login + registro dinâmico) | N3 | 18 |
| Steadybit | — | Não determinada | sem endpoint | 31 |
| Terraform ·catálogo | `docker run -i --rm hashicorp/terraform-mcp-server` | Nenhuma | local | — |
| Vercel (oficial) ·catálogo | `https://mcp.vercel.com` | OAuth (login + registro dinâmico) | N3 | 7 |

## Segurança e compliance (22)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| atlasFindings | `https://api.esentire.com/mcp/rpc` | OAuth (login + registro dinâmico) | N3 | 19 |
| Clerk | `https://mcp.clerk.com/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| DataGrail | — | Não determinada | sem endpoint | 51 |
| Drata | `https://mcp.drata.com/mcp` | OAuth (login + registro dinâmico) | N3 | 36 |
| Have I Been Pwned | `https://haveibeenpwned.com/mcp` | OAuth (login + registro dinâmico) | N4 | 17 |
| iubenda: Privacy policy & cookie banner | `https://mcp-server.iubenda.com/mcp` | OAuth (login + registro dinâmico) | N3 | 28 |
| JupiterOne | — | Não determinada | sem endpoint | 24 |
| Ketryx | `https://app.ketryx.com/api/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Malwarebytes | `https://scamguard.malwarebytes.com/claude/mcp` | Nenhuma | N4 | 6 |
| McAfee | `https://claudecompanion.gateway.api.mcafee.com/mcp` | Não determinada | N1 | 3 |
| Norton | `https://ai-connect.norton.com/claude/mcp` | Não determinada | N1 | 7 |
| Origin | `https://mcp.prod.originhq.com/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Phished | `https://mcp.phished.io/mcp` | OAuth (login + registro dinâmico) | N3 | 96 |
| Pi Security | `https://mcp.pi.security/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Reco | — | Não determinada | sem endpoint | 40 |
| spArxx.io \| Zero-Knowledge Blockchain Timestamping | `https://gateway.sparxx.io/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Sprinto MCP | — | Não determinada | sem endpoint | 395 |
| Stytch | `https://mcp.stytch.dev/mcp` | OAuth (login + registro dinâmico) | N3 | 21 |
| Sumsub | `https://api.sumsub.com/mcp/` | OAuth (login + registro dinâmico) | N3 | 18 |
| Trustfull | `https://mcp.trustfull.com/connector` | OAuth (client id pré-registrado) | N2 | 5 |
| Vanta | `https://mcp.vanta.com/mcp` | OAuth (login + registro dinâmico) | N3 | 176 |
| WorkOS | `https://mcp.workos.com/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |

## Pesquisa (35)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| alphaXiv | `https://api.alphaxiv.org/mcp/v1` | OAuth (login + registro dinâmico) | N3 | 6 |
| Anthropic Economic Index | `https://econ-index.mcp.claude.com/mcp` | Nenhuma | N4 | 9 |
| august | `https://mcp.getaugust.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 32 |
| Brave Search ·catálogo | `npx -y @brave/brave-search-mcp-server --transport stdio --brave-api-key ${BRAVE_API_KEY}` | Variáveis de ambiente (local) | local | — |
| Candid | `https://mcp.candid.org/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| CB Insights | `https://mcp.cbinsights.com/` | OAuth (login + registro dinâmico) | N3 | 15 |
| Clutch.co | `https://bot.clutch.co/mcp` | OAuth (login + registro dinâmico) | N4 | 5 |
| Crunchbase | `https://mcp.crunchbase.com/` | OAuth (client id pré-registrado) | N2 | 16 |
| Dovetail | `https://dovetail.com/api/mcp` | OAuth (client id pré-registrado) | N2 | 9 |
| Exa | `https://mcp.exa.ai/mcp` | OAuth (login + registro dinâmico) | N4 | 2 |
| Fetch ·catálogo | `uvx mcp-server-fetch` | Nenhuma | local | — |
| Firecrawl | `https://mcp.firecrawl.dev/v2/mcp-search` | OAuth (login + registro dinâmico) | N3 | 9 |
| Glean | — | Não determinada | sem endpoint | 8 |
| GLG | `https://mcp.glgresearch.com/myglg/mcp` | OAuth (login + registro dinâmico) | N3 | 13 |
| Guidepoint | `https://clapi.guidepoint.io/mcp-server/v1/mcp` | OAuth (client id pré-registrado) | N2 | 1 |
| Hugging Face | `https://huggingface.co/mcp` | OAuth (login + registro dinâmico) | N4 | 4 |
| IBISWorld | `https://mcp.ibisworld.com/` | OAuth (login + registro dinâmico) | N3 | 8 |
| Listen Labs | `https://listenlabs.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Mantic | `https://api.mantic.com/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Mem0 | `https://mcp.mem0.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |
| Morning Consult | `https://api.morningconsult.com/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Nimble | `https://mcp.nimbleway.com/mcp` | OAuth (login + registro dinâmico) | N3 | 18 |
| NSDAP Archiv - DER SPIEGEL | `https://nsdap-mcp.prod.ki.spiegel.de/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Parallel Search | `https://search.parallel.ai/mcp` | Nenhuma | N4 | 2 |
| Rally MCP | `https://mcp.rallyuxr.com/mcp` | OAuth (login + registro dinâmico) | N3 | 67 |
| Remesh | `https://live.remesh.chat/mcp` | OAuth (login + registro dinâmico) | N3 | 52 |
| Scite | `https://api.scite.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 1 |
| SurveyMonkey | `https://mcp.surveymonkey.com/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| Tavily | `https://mcp.tavily.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Theysaid | `https://ai.theysaid.io/api/mcp` | OAuth (login + registro dinâmico) | N3 | 33 |
| Third Bridge | `https://ai.thirdbridge.com/mcp/sse` | OAuth (login + registro dinâmico) | N3 | 1 |
| TinyFish | `https://agent.tinyfish.ai/mcp/claude` | OAuth (login + registro dinâmico) | N3 | 23 |
| USAFacts Government Data Connector | `https://data.mcp.usafacts.org/mcp` | Nenhuma | N4 | 4 |
| Vertiso Memory | `https://memory.vertiso.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Wolfram | `https://agenttools.wolfram.com/mcp` | Nenhuma | N4 | 3 |

## Viagens e locais (46)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Airfield Directory | `https://airfield.directory/mcp` | Nenhuma | N4 | 8 |
| ALL Accor | `https://mcp.dams.aws.accor.com/green/v1/mcp/apps` | Nenhuma | N4 | 1 |
| AllTrails | `https://www.alltrails.com/mcp` | Nenhuma | N4 | 5 |
| AUTONOMAD | `https://mcp.autonomad.ai/mcp` | OAuth (login + registro dinâmico) | N4 | 14 |
| Booking.com | `https://demandapi-mcp.booking.com/v1/mcp/8132308` | Não determinada | N1 | 1 |
| Brek - Hotel Wholesale Booking | `https://mcp.brek.com/mcp` | Nenhuma | N4 | 3 |
| Checkatrade | `https://api.checkatrade.com/consumer-claude-mcp/v1/mcp` | Não determinada | N1 | 2 |
| Civitatis | `https://civitatis-claude-app.civitatis.com/mcp` | Nenhuma | N4 | 7 |
| Cottages | `https://mcp.cottages.com/mcp` | Não determinada | N1 | 2 |
| DirectBooker | `https://www.directbooker.ai/claude` | Não determinada | N1 | 7 |
| Domino's India | `https://genai-prod-ext.dominos.co.in/order-mcp/mcp` | Nenhuma | N4 | 18 |
| eDreams | `https://www.edreams.com/ai-travel-assistant/claude/v1/mcp` | Não determinada | N1 | 2 |
| Expedia | `https://www.expedia.com/mcp` | Não determinada | N1 | 3 |
| GetYourGuide | `https://widget.getyourguide.com/apis/mcp-apps` | Não determinada | N1 | 1 |
| GIS Cloud | `https://mcp.giscloud.com/mcp` | OAuth (login + registro dinâmico) | N3 | 55 |
| GoVola | `https://mcp.govola.com/mcp-anthropic` | Não determinada | N1 | 1 |
| Kiwi.com | `https://mcp.kiwi.com/` | Nenhuma | N4 | 2 |
| komoot | `https://claude.main.komoot.net/mcp` | OAuth (login + registro dinâmico) | N4 | 13 |
| lastminute.com | `https://mcp.lastminute.com/mcp` | Não determinada | N1 | 1 |
| LetsFG \| Book the best flights or hotels | `https://letsfg.co/mcp` | OAuth (login + registro dinâmico) | N3 | 26 |
| MAIA | `https://api.maia-analytics.com/mcp` | OAuth (login + registro dinâmico) | N3 | 20 |
| MyGeotab MCP | `https://mcp.geotab.com/mygeotab` | OAuth (login + registro dinâmico) | N3 | 30 |
| Navan | `https://mcp.navan.com/mcp` | OAuth (login + registro dinâmico) | N3 | 40 |
| Novasol | `https://mcp.novasol.com/mcp` | Não determinada | N1 | 1 |
| Order by Cash App | `https://connect.squareup.com/v2/mcp/cash-app` | Nenhuma | N4 | 5 |
| Otto Travel | `https://api.ottotheagent.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| PGA – Play Golf | `https://mcp.pga.com/mcp` | OAuth (client id pré-registrado) | N4 | 4 |
| Resy | `https://apigw.americanexpress.com/dining/v1/mcp` | OAuth (client id pré-registrado) | N2 | — |
| Rome2Rio | `https://chatgpt-app.rome2rio.com/mcp` | Não determinada | N1 | 2 |
| SlickTrip | `https://mcp.slicktrip.com/mcp` | OAuth (login + registro dinâmico) | N4 | 38 |
| Super.com | `https://www.super.com/travel/mcp` | Nenhuma | N4 | 4 |
| Taskrabbit Booking Assistance | `https://mcp.taskrabbit.com/mcp` | Nenhuma | N4 | 3 |
| Tineo | `https://api.tineo.ai/mcp/claude` | OAuth (login + registro dinâmico) | N4 | 68 |
| TomTom Maps | `https://mcp.tomtom.com/maps` | OAuth (client id pré-registrado) | N2 | 15 |
| TravExp | `https://travexpserver-1-5480123242.us-central1.run.app/mcp-standard` | Nenhuma | N4 | 2 |
| Tripadvisor | `https://production.ai-mcp-extensibility-prd.tamg.cloud/ogMvjY4De1G7CiHanMOAgddl/mcp` | Nenhuma | N1 | 3 |
| Trivago | `https://mcp.trivago.com/mcp` | Nenhuma | N4 | 3 |
| Turkish Airlines | `https://mcp-app.turkishtechlab.com/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| Turo | `https://mcp.turo.com/v1/mcp` | Não determinada | N1 | 1 |
| Uber | `https://mcp.uber.com/claude/rides-3p/mcp` | OAuth (client id pré-registrado) | N2 | 2 |
| Uber Eats | `https://mcp.ubereats.com/eats-claude/mcp` | OAuth (client id pré-registrado) | N2 | 2 |
| Veltra Activities | `https://ai.veltra.com/veltra/mcp` | OAuth (login + registro dinâmico) | N4 | 1 |
| Viator | `https://exp-app-mcp.prod.ep.viator.com/mcp` | Nenhuma | N4 | 2 |
| Wyndham Hotels and Resorts | `https://mcp.wyndhamhotels.com/claude/mcp` | Não determinada | N1 | 2 |
| Yelp | `https://mcp-anthropic.yelp.com/claude/mcp` | Não determinada | N1 | 1 |
| Zomato | `https://mcp-server.zomato.com/mcp` | OAuth (login + registro dinâmico) | N3 | 11 |

## Saúde e ciência (57)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Addgene | `https://mcp-server.addgene.org/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| AdisInsight | `https://adisinsight-mcp.springer.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Alma | `https://mcp.alma.food/` | OAuth (login + registro dinâmico) | N3 | 5 |
| Amass Connector | `https://mcp.amass.tech/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Articulate | — | Não determinada | sem endpoint | 2 |
| athenahealth (beta) | `https://api.platform.athenahealth.com/mcp/patients` | Não determinada | N1 | 13 |
| Benchling | — | Não determinada | sem endpoint | 3 |
| BioRender | `https://mcp.services.biorender.com/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| bioRxiv | `https://hcls.mcp.claude.com/biorxiv/mcp` | Nenhuma | N4 | 7 |
| Boltz API | `https://mcp.boltz.bio/mcp` | OAuth (client id pré-registrado) | N2 | 10 |
| Brisk Teaching | `https://mcp.briskteaching.com/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| ChEMBL | `https://hcls.mcp.claude.com/chembl/mcp` | Nenhuma | N4 | 6 |
| Claude Academy | `https://academy.claude.com/mcp` | Nenhuma | N4 | 3 |
| Clinical Trials | `https://hcls.mcp.claude.com/clinical_trials/mcp` | Nenhuma | N4 | 6 |
| CMS Coverage | `https://hcls.mcp.claude.com/cms_coverage/mcp` | Nenhuma | N4 | 7 |
| Consensus | `https://mcp.consensus.app/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Cortellis CMC Intelligence | `https://api.clarivate.com/lifesciences/mcp-cmc/mcp` | OAuth (login + registro dinâmico) | N3 | 1 |
| Coteach | `https://coteach.ai/api/mcp` | OAuth (login + registro dinâmico) | N3 | 1 |
| Coursera | `https://api.coursera.com/mcp` | OAuth (client id pré-registrado) | N4 | 6 |
| DataCamp | `https://mcp.datacamp.com/v1/mcp` | OAuth (login + registro dinâmico) | N4 | 87 |
| Demographic and Health Surveys | `https://api.dhsprogram.com/mcp` | OAuth (login + registro dinâmico) | N3 | 14 |
| Diffit | `https://api.diffit.me/mcp` | OAuth (client id pré-registrado) | N2 | 2 |
| EDEN by Basecamp Research | `https://mcp-public.basecamp-research.com/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Eedi | `https://teacher-tools.eedi.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Elfcare | `https://patient.elf.care/api/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| Elicit | `https://elicit.com/api/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Health Data Avatar (HDA) | `https://hda-mcp.healthdataavatar.com/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Helix GenoSphere | `https://mcp.hrn-production.helix.com/mcp` | Não determinada | N1 | 5 |
| ICD-10 Codes | `https://hcls.mcp.claude.com/icd10_codes/mcp` | Nenhuma | N4 | 6 |
| IHME GBD | `https://gbdmcp.healthdata.org/mcp` | OAuth (login + registro dinâmico) | N3 | 45 |
| Inductive Bio | `https://api.inductive.bio/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Insight Timer | `https://claude-connector-api.insighttimer-api.net/mcp` | Nenhuma | N4 | 2 |
| Kahoot! | `https://mcp.kahoot.it/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Kuliko AI | `https://mcp.kuliko.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 36 |
| LatchBio | `https://mcp.latch.bio/mcp` | OAuth (login + registro dinâmico) | N3 | 9 |
| Learning Commons | `https://kg.mcp.learningcommons.org/mcp` | Chave de API / token | N1 | 3 |
| MagicSchool AI | `https://app.magicschool.ai/api/mcp` | OAuth (client id pré-registrado) | N2 | 1 |
| Maven Bio | `https://mcp.mavenbio.com/` | OAuth (login + registro dinâmico) | N3 | 16 |
| Medidata | `https://mcp.imedidata.com/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| NPI Registry | `https://hcls.mcp.claude.com/npi_registry/mcp` | Nenhuma | N4 | 3 |
| O’Reilly | `https://api.oreilly.com/api/content-discovery/v1/mcp/` | OAuth (login + registro dinâmico) | N3 | 1 |
| Oak National Academy | `https://mcp.thenational.academy/mcp` | OAuth (login + registro dinâmico) | N3 | 40 |
| Open Targets | `https://mcp.platform.opentargets.org/mcp` | Nenhuma | N4 | 5 |
| Owkin | `https://mcp.k.owkin.com/mcp` | OAuth (client id pré-registrado) | N2 | 9 |
| PopHIVE | `https://mcp.pophive.org/mcp` | Nenhuma | N4 | 7 |
| PubMed | `https://pubmed.mcp.claude.com/mcp` | Nenhuma | N4 | 7 |
| Revvity Signals AI | — | Não determinada | sem endpoint | 1 |
| SandboxAQ | — | Não determinada | sem endpoint | 7 |
| SciSpace | `https://scispace.com/mcp-kls34hjb` | Não determinada | N1 | 2 |
| SNOMED CT Terminology | `https://snowstorm-mcp.snomedtools.org/mcp` | Nenhuma | N4 | 15 |
| Strava | `https://mcp.strava.com/mcp` | OAuth (login + registro dinâmico) | N2 | 8 |
| Synapse.org | `https://mcp.synapse.org/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Synthesize Bio | `https://app.synthesize.bio/api/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Turquoise | `https://mcp.turquoise.health/mcp` | Não determinada | N1 | 6 |
| Udemy Business | `https://api.udemy.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Vital Care Finder | `https://mcp.vital.io/` | Não determinada | N1 | 2 |
| Wiley Scholar Gateway | `https://connector.scholargateway.ai/v2/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |

## Mídia (27)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| AI Producer by OpusClip | `https://producer.opus.pro/api/mcp` | OAuth (login + registro dinâmico) | N3 | 37 |
| Audible | `https://mcp.audible.com/mcp` | Não determinada | N1 | 1 |
| Bitmovin | `https://mcp.bitmovin.com/` | OAuth (login + registro dinâmico) | N3 | 57 |
| Brightcove | `https://mcp.brightcove.com/mcp` | OAuth (login + registro dinâmico) | N3 | 462 |
| Claude Motion to Mirage | `https://mcp.mirage.app/claude-motion` | OAuth (login + registro dinâmico) | N3 | 1 |
| Cloudinary | `https://asset-management.mcp.cloudinary.com/sse` | OAuth (login + registro dinâmico) | N3 | 22 |
| ComfyUi | `https://cloud.comfy.org` | Não determinada | N1 | — |
| Descript | `https://api.descript.com/v2/mcp/claude` | OAuth (login + registro dinâmico) | N3 | 5 |
| ElevenLabs | `https://api.elevenlabs.io` | Não determinada | N1 | 158 |
| Fever Event Discovery | `https://data-search.apigw.feverup.com/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| HyperFrames by HeyGen | `https://mcp.heygen.com/mcp/hyperframes` | OAuth (login + registro dinâmico) | N3 | 2 |
| Melon | `https://mcp.melon.com/mcp/` | Nenhuma | N4 | 18 |
| OpusClip | `https://api.opus.pro/api/mcp` | OAuth (login + registro dinâmico) | N3 | 28 |
| Play Sheet Music | `https://example-server.modelcontextprotocol.io/sheet-music/mcp` | OAuth (login + registro dinâmico) | N4 | 1 |
| Restream | `https://mcp.restream.io/mcp` | OAuth (login + registro dinâmico) | N3 | 30 |
| Riverside | `https://mcp.riverside.com/mcp` | OAuth (login + registro dinâmico) | N3 | 59 |
| Shutterstock | `https://www.shutterstock.com/cciq/mcp` | Nenhuma | N4 | 1 |
| Sonos | `https://mcp.ws.sonos.com/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| Splice | `https://mcp.splice.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Spotify | `https://mcp-gateway-external-pilot.spotify.net/mcp` | OAuth (client id pré-registrado) | N2 | 6 |
| StubHub | `https://open-ai-app.stubhub.net/mcp` | Não determinada | N1 | 3 |
| Tella | `https://api.tella.com/mcp` | OAuth (login + registro dinâmico) | N3 | 98 |
| The Economist - Graphs | `https://mcp-app.economist.com/mcp/claude` | Não determinada | N1 | 1 |
| Ticketmaster | `https://partner-mcp.ticketmaster.com/mcp` | Não determinada | N1 | 2 |
| Unsplash | `https://mcp.unsplash.com/mcp` | OAuth (client id pré-registrado) | N2 | 23 |
| Viberate music data | `https://mcp.viberate.com/v1/sse` | OAuth (login + registro dinâmico) | N3 | 23 |
| 中央社新聞 CNA TAIWAN NEWS | `https://ask.cna.com.tw/mcp/connect` | OAuth (login + registro dinâmico) | N3 | 18 |

## RH (29)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| Ashby | `https://mcp.ashbyhq.com/mcp/v1` | OAuth (login + registro dinâmico) | N3 | 16 |
| BambooHR | — | Não determinada | sem endpoint | 56 |
| Breezy HR MCP | `https://mcp.breezy.hr/mcp` | OAuth (login + registro dinâmico) | N3 | 55 |
| BrightHire | `https://app.brighthire.ai/mcp/v1` | OAuth (login + registro dinâmico) | N3 | 11 |
| Cloverleaf | `https://app.cloverleaf.me/api/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| Deel | `https://api.letsdeel.com/mcp` | OAuth (login + registro dinâmico) | N4 | 8 |
| Dice | `https://mcp.dice.com/mcp` | Nenhuma | N4 | 3 |
| Gem | `https://mcp.gem.com/mcp` | OAuth (login + registro dinâmico) | N3 | 32 |
| Greenhouse | `https://mcp.greenhouse.io/mcp` | OAuth (login + registro dinâmico) | N3 | 159 |
| Gusto | `https://mcp.api.gusto.com/anthropic` | OAuth (login + registro dinâmico) | N3 | 62 |
| Indeed | `https://mcp.indeed.com/claude/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| isolved People Cloud | `https://api.myisolved.com/restmcp-prod/mcp` | OAuth (client id pré-registrado) | N2 | 4 |
| Lattice | `https://api.latticehq.com/mcp` | OAuth (client id pré-registrado) | N2 | 20 |
| LinkedIn Hiring Pro | `https://mcp.linkedin.com/mcp-hiring-pro` | OAuth (client id pré-registrado) | N2 | — |
| Manatal | `https://mcp.manatal.com/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| Metaview | `https://mcp.metaview.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Planday | `https://public-mcp-server.prod-westeurope.planday.cloud/mcp` | OAuth (client id pré-registrado) | N2 | 12 |
| Remote | `https://mcp.remote.com/mcp` | OAuth (login + registro dinâmico) | N3 | 51 |
| Sana from Workday | — | Não determinada | sem endpoint | 4 |
| Shapes | `https://mcp.shapes.co/mcp` | OAuth (login + registro dinâmico) | N3 | 34 |
| Snagajob | `https://platform.jobget.com/jobs-mcp/mcp` | Nenhuma | N4 | 2 |
| Teamtailor | `https://mcp.teamtailor.com/mcp` | OAuth (login + registro dinâmico) | N3 | 48 |
| Trainual | `https://mcp.trainual.com/` | OAuth (login + registro dinâmico) | N3 | 15 |
| UKG Bryte | — | Não determinada | sem endpoint | 3 |
| Upwork | `https://mcp.upwork.com/mcp` | OAuth (login + registro dinâmico) | N3 | 46 |
| Visier | — | Não determinada | sem endpoint | 8 |
| Windmill HR | `https://mcp.gowindmill.com/mcp` | OAuth (login + registro dinâmico) | N3 | 64 |
| Workable | `https://mcp.workable.com/mcp` | OAuth (login + registro dinâmico) | N3 | 45 |
| ZipRecruiter | `https://api.ziprecruiter.com/mcp` | Não determinada | N1 | 1 |

## Jurídico (50)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| 8am MyCase | `https://mcp.mycase.com/mcp` | OAuth (client id pré-registrado) | N2 | 75 |
| Aptus.AI - NextOS | `https://legalmcp.next.aptus.ai/mcp` | OAuth (client id pré-registrado) | N2 | 3 |
| Aurora | `https://mcp.ai.consilio.com/` | OAuth (login + registro dinâmico) | N3 | 4 |
| Bloomberg Law | `https://gw.mcp.bindg.ai/blaw/mcp` | OAuth (login + registro dinâmico) | N3 | 17 |
| BoardWise | `https://uakozrqrztgrgwoywxkx.supabase.co/functions/v1/mcp-server` | Nenhuma | N4 | 14 |
| Brightflag | — | Não determinada | sem endpoint | 18 |
| Clarivate IPOne CompuMark Trademarks | `https://ipone.clarivate.com/trademarks/mcp` | OAuth (client id pré-registrado) | N2 | 9 |
| Clerq MCP | `https://mcp.us.clerq-ip.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| CoCounsel Legal | `https://cocoagent-service.cocounsel.thomsonreuters.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Contract-Factory — Sociétés & SIREN | `https://www.contract-factory.com/mcp.php` | Nenhuma | N4 | 5 |
| CourtListener | `https://mcp.courtlistener.com/` | OAuth (login + registro dinâmico) | N3 | 14 |
| Courtroom5 | `https://mcp.courtroom5.com/v1` | Nenhuma | N4 | 3 |
| Definely | `https://mcp.app.definely.com/` | OAuth (login + registro dinâmico) | N3 | 20 |
| Descrybe Legal Engine | `https://mcp.descrybe.com/mcp` | OAuth (login + registro dinâmico) | N4 | 13 |
| Everlaw | `https://api.everlaw.com/v1/mcp` | OAuth (client id pré-registrado) | N2 | 3 |
| Filevine | `https://api.filevineapp.com/mcp/api-v2` | OAuth (client id pré-registrado) | N2 | 112 |
| General Legal | `https://mcp.general.legal/mcp` | OAuth (login + registro dinâmico) | N3 | 8 |
| GovTribe | `https://govtribe.com/mcp` | OAuth (login + registro dinâmico) | N3 | 24 |
| Haloo Trademark Clearance | `https://connect.haloo.ai/trademark-search/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| Harvey | — | Não determinada | sem endpoint | 5 |
| InfoTrack | `https://mcp.infotrack.ai/servers/infotrack-all/mcp` | Não determinada | N0 | 115 |
| Ironclad Contracts | — | Não determinada | sem endpoint | 6 |
| Ivo | — | Não determinada | sem endpoint | 4 |
| Juro contracts | `https://integrations.app.juro.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| Jus AI by Jus Mundi (Light Mode) | `https://mcp.jusmundi.com/` | OAuth (login + registro dinâmico) | N3 | 1 |
| Lawstronaut | `https://mcp.lawstronaut.com/` | OAuth (login + registro dinâmico) | N4 | 16 |
| Lawve AI | `https://mcp.lawve.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 2 |
| LawVu | `https://mcp.lawvu.com/mcp` | OAuth (login + registro dinâmico) | N3 | 51 |
| Legal Brain Agent | `https://api.legalbrain.com/v1/mcp` | OAuth (client id pré-registrado) | N2 | 1 |
| Legal Data Hunter | `https://legaldatahunter.com/mcp` | OAuth (login + registro dinâmico) | N3 | 7 |
| LegalZoom | `https://www.legalzoom.com/mcp/claude/v1` | OAuth (login + registro dinâmico) | N3 | 8 |
| Lightbringer | `https://mcp.lightbringer.com/mcp` | OAuth (login + registro dinâmico) | N4 | 37 |
| LinkSquares | `https://ai-chat-service.linksquares.com/v1/mcp/external` | OAuth (login + registro dinâmico) | N3 | 14 |
| Lloyd by The L Suite | — | Não determinada | sem endpoint | 2 |
| Mary | — | Não determinada | sem endpoint | 17 |
| Maryland Community Compass | `https://compass.maryland.gov/mcp` | Não determinada | N1 | 20 |
| Midpage Legal Research | `https://app.midpage.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 3 |
| neimo. | `https://mcp.neimo.ai/api/mcp` | OAuth (login + registro dinâmico) | N3 | 15 |
| Patlytics | `https://mcp.patlytics.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Paxton Legal Research | `https://paxton-mcp-connector-xmfvvq3waa-uc.a.run.app/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| PointOne | `https://mcp.pointone.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Relativity | — | Não determinada | sem endpoint | 34 |
| Rocket Lawyer | `https://api.rocketlawyer.com/mcp-du/mcp` | OAuth (login + registro dinâmico) | N3 | 10 |
| Smarter Drafter | — | Não determinada | sem endpoint | 6 |
| Solve Intelligence | `https://api.solveintelligence.com/mcp/` | OAuth (client id pré-registrado) | N2 | 9 |
| SpotDraft | — | Não determinada | sem endpoint | 33 |
| Tango | `https://govcon.dev/mcp` | OAuth (login + registro dinâmico) | N3 | 4 |
| TopCounsel by The L Suite | `https://api.techgc.co/api/mcp/topcounsel` | OAuth (login + registro dinâmico) | N3 | 1 |
| Trellis | `https://mcp.trellis.law/anthropic` | Não determinada | N1 | 24 |
| Vasara | `https://mcp.vasara.ai/` | OAuth (login + registro dinâmico) | N3 | 21 |

## Outros (34)

| Nome | Endpoint | Autenticação | Nível | Ferramentas |
|---|---|---|---|---|
| AccuWeather® | `https://mcp.accuweather.com/v0/mcp/claude` | Não determinada | N1 | 9 |
| ADITUS Evo | `https://mcp.aditus.com/mcp` | OAuth (login + registro dinâmico) | N3 | 255 |
| agri-mcp.tcit.cl | `https://agri-mcp.tcit.cl/mcp` | OAuth (login + registro dinâmico) | N3 | 67 |
| AppFolio Realm-X | `https://mcp.appfolio.com/` | OAuth (login + registro dinâmico) | N3 | 1 |
| Benevity | `https://mcp.benevity.org/general/v1/nonprofit` | Não determinada | N1 | 2 |
| CargoAi | `https://api.cargoai.co/mcp` | OAuth (login + registro dinâmico) | N3 | 6 |
| CarGurus | `https://mcp-apps.api.cargurus.com/chat-mcp/v1/stream` | Não determinada | N1 | 2 |
| Community Funding NZ | `https://funding.alltoohuman.nz/mcp` | Nenhuma | N4 | 8 |
| Countersignatory | `https://countersignatory.com/mcp` | Nenhuma | N4 | 5 |
| Flexport | `https://mcp.flexport.com/mcp` | OAuth (login + registro dinâmico) | N3 | 16 |
| Givebutter | `https://mcp.givebutter.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| Granted | `https://grantedai.com/api/mcp/mcp` | Nenhuma | N4 | 5 |
| idealista | `https://mcp-app.idealista.com/claude/v1/mcp` | Não determinada | N1 | 4 |
| Instrumentl | `https://mcp.instrumentl.com/` | Não determinada | N1 | 6 |
| Isometric | `https://api.isometric.com/mcp` | OAuth (client id pré-registrado) | N2 | 13 |
| Kindora Funder Discovery | `https://mcp.kindora.co/mcp` | Nenhuma | N4 | 17 |
| LILT | `https://mcp.lilt.com/mcp` | OAuth (login + registro dinâmico) | N3 | 5 |
| LZ Virtual Mail | `https://api.earthclassmail.com/v2/mcp/claude` | OAuth (login + registro dinâmico) | N3 | 28 |
| Military and Veteran Family Assistant | `https://milfam.mcp.claude.com/mcp` | Nenhuma | N4 | 3 |
| Motherboard | — | Não determinada | sem endpoint | 12 |
| Natoma | — | Não determinada | sem endpoint | 20 |
| Optilogic | `https://mcp.optilogic.app/mcp` | OAuth (login + registro dinâmico) | N3 | 37 |
| Planning Center | `https://mcp.planningcenteronline.com/mcp` | OAuth (login + registro dinâmico) | N3 | 37 |
| PlayMCP | `https://playmcp.kakao.com/mcp` | OAuth (login + registro dinâmico) | N3 | — |
| RSVPify | `https://mcp.rsvpify.com/` | OAuth (login + registro dinâmico) | N3 | 159 |
| Terminal49 | `https://mcp.terminal49.com/` | OAuth (login + registro dinâmico) | N3 | 13 |
| Thumbtack | `https://mcp.thumbtack.com/mcp` | OAuth (client id pré-registrado) | N2 | 4 |
| Ticket Tailor | `https://mcp.tickettailor.ai/mcp` | OAuth (login + registro dinâmico) | N3 | 65 |
| Tixel | `https://mcp-v1.tixel.com/mcp` | Nenhuma | N4 | 7 |
| Tomorrow.io Weather MCP App | `https://api.tomorrow.io/v4/weather-intelligence/mcp` | Nenhuma | N4 | 9 |
| Vaisala Xweather | `https://mcp.api.xweather.com/mcp` | OAuth (login + registro dinâmico) | N3 | 19 |
| Verisk XactRestore | `https://xactrestore-xactremodelserver-usw2-prod.propsol.io/mcp` | OAuth (login + registro dinâmico) | N3 | 18 |
| Yardi Virtuoso | `https://mcp.virtuoso.ai/mcp` | Não determinada | N1 | 5 |
| Zillow | `https://mcp.zillow.com/api/v2` | Nenhuma | N4 | 9 |

