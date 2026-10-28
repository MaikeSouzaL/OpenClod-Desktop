# Conectores MCP no Openclod

O Openclod usa conectores (servidores MCP) do mesmo jeito que o Claude: um **diretório** de aplicativos, cada um com status, ferramentas
e permissão por ferramenta, e o agente usa as ferramentas como ferramentas de primeira classe (`mcp__servidor__ferramenta`).

## Como usar

**Personalização → Conectores.** Busque ou filtre por categoria e abra um conector:

| Tipo (selo no cartão) | O que fazer | Quantos no diretório |
|---|---|---|
| **Sem login** | Conectar (um clique). | 70 abertos de verdade |
| **Login com sua conta** (OAuth) | Conectar com sua conta: abre o navegador, você entra, pronto. O token fica no cofre do sistema. | ~560 |
| **Requer app OAuth seu** | O serviço não aceita o cadastro automático do Openclod (Slack, GitHub, Google, HubSpot…). Crie um aplicativo OAuth no painel de desenvolvedor do serviço, cadastre **exatamente** a URL de retorno mostrada (`http://127.0.0.1:38565/callback`) e informe o Client ID (e o Secret, se houver). | 102 |
| **Chave de API** | Cole a chave (campo mascarado); ela vai para o cofre, nunca para o `settings.json`. | poucos |
| **Local** | Servidores que rodam no seu computador (`npx`/`uvx`/`node`). | 22 |
| *sem endereço público* | O diretório não publica a URL: informe a do servidor ao conectar. | 83 |

Alguns serviços `oauth` recusam o cadastro automático (~47): o detalhe oferece **"Usar meu próprio aplicativo OAuth"** (abre sozinho quando o erro
indica isso).

**Conector personalizado** (botão no alto da tela) tem dois tipos:

- **Endereço na internet:** um servidor MCP remoto por URL (https; http só para localhost), com cabeçalhos secretos.
- **Programa neste computador:** o comando que inicia o servidor (`npx`, `uvx`, `node`, `python` ou o caminho de um `.exe`), os argumentos (**um por
  linha, sem aspas**: não há shell, cada linha é um argumento), variáveis de ambiente (as que parecem credencial, como `API_KEY`, `TOKEN`, `SECRET` ou
  `PASSWORD`, aparecem mascaradas e vão para o cofre) e, se precisar, a pasta de trabalho e o tempo de partida. Um programa local roda no seu
  computador com as suas permissões: adicione só o que você conhece.

**Editar:** no detalhe de um conector que você adicionou aparece o botão *Editar*, com o mesmo formulário já preenchido. As credenciais voltam
mascaradas (`••••••ab`) e, se você não mexer nelas, continuam as que estão no cofre; as permissões por ferramenta e os filtros ficam como estavam. O
nome não muda (para usar outro, desconecte e adicione de novo). Os conectores do diretório se reconectam pela tela deles.

No detalhe de um conector conectado: lista de ferramentas com **Sempre permitir · Perguntar · Bloquear** (por ferramenta ou para todas), selos
"somente leitura" / "pode alterar dados", Reconectar, Recarregar e Desconectar (remove tokens e segredos).

## O que mudou no harness

- **Ferramentas de primeira classe.** Cada ferramenta de um servidor conectado vira `mcp__servidor__ferramenta` (com muitas ferramentas, ficam
  adiadas e o agente as acha com `tool_search`). `mcp_servers`/`mcp_catalog`/`mcp_call`/`mcp_search` continuam como diagnóstico e reserva, mas
  saíram da lista de ferramentas de toda chamada (o modelo as acha com `tool_search`; chamar `mcp_servers`, `mcp_catalog` ou `mcp_call` pelo nome já as carrega).
- **Política por ferramenta** (`toolPolicy`, `approvalTools`, `includeTools/excludeTools`). Bloquear esconde a ferramenta do modelo e também fecha o caminho
  indireto `mcp_call`. **`ask` agora vale em todos os modos**, inclusive no modo irrestrito (antes as regras `approvalTools` nunca eram aplicadas).
- **Segredos no cofre.** O `settings.json` guarda só `${secret:servidor.NOME}`; as telas mostram as credenciais mascaradas. Na primeira abertura
  com este código, os segredos antigos migram para o cofre (com cópia `settings.json.bak-AAAA-MM-DD`, que Configurações → MCP oferece apagar:
  **o botão apaga todas as cópias `settings.json.bak-*`**, inclusive as que você mesmo fez).
- **OAuth tolerante:** descoberta com issuer com caminho nas duas formas, `resource_metadata` do 401, registro dinâmico com repetição em `localhost`,
  client id próprio (`oauthClient`), porta de retorno fixa (38565), refresh silencioso, revogação, `connectedAs`.
- **Robustez:** um servidor que trava não bloqueia os outros nem os reinícios; reconexão com backoff; sessão MCP (`Mcp-Session-Id`) e versões de
  protocolo 2024-11-05 a 2025-11-25; SSE legado; progresso e cancelamento; saída grande truncada com aviso; `list_changed` recarrega só o servidor
  que mudou; ferramenta `mcp_reload`; elicitação (formulário) via `ask_user`.
- **Partida lenta:** o prazo de partida (`startTimeoutMs`) agora é de **30 s** por padrão (o Claude Code também espera 30 s; eram 20 s) e vale para o
  handshake; depois dele cada listagem (ferramentas, recursos, prompts) tem pelo menos 10 s. Antes, um servidor que gastava quase todo o prazo no
  `initialize` (um `uvx` a frio, a máquina cheia logo que o app abre) ficava com milissegundos para listar as ferramentas e aparecia como falho embora
  estivesse de pé (caso real do `rea`: `tools/list (274ms)`). Um servidor que esgota o prazo na partida ganha **uma** segunda tentativa automática,
  em segundo plano, 3 s depois: a primeira já aqueceu o que `uvx`/`npx` baixam (o `jira` levou 18 s a frio e 8 s a quente). Não há nova tentativa para
  falha de login, queda do processo ou comando ausente, e se você reconectar, recarregar ou desativar o servidor nesse meio tempo, nada acontece.
  O `main.log` registra `MCP <nome>: pronto em N s (M ferramentas)` para cada servidor, o que mostra quem é lento de verdade.
  Para um servidor que nunca cabe no prazo (um `uvx` que monta o ambiente a cada partida), aumente o tempo de partida dele: no detalhe do conector,
  *Editar → Avançado → Tempo de partida* (vale para os que você adicionou; os do diretório usam o padrão).
- **Dicas de erro em pt-BR**, por exemplo o caso real da Atlassian: *"You don't have permission to connect via API token"* = a organização não liberou
  token de API no Rovo MCP → use o login OAuth (como o Claude Code) ou o conector local `jira`.
- `mcp_install` aceita `reuse_credentials_from` (copia credenciais de outro servidor sem passar pelo modelo).

## Uma tela só: Conectores

Antes, os mesmos servidores apareciam em dois lugares: cartões em Personalização → Conectores e um editor de JSON em Configurações → MCP. Agora é
**só Conectores**. Configurações → MCP mostra um aviso, o botão *Abrir Conectores* e a oferta de apagar cópias antigas do `settings.json`. O que o
JSON permitia ficou na tela de Conectores:

| Antes (JSON) | Agora |
|---|---|
| adicionar um servidor local por comando | *Conector personalizado → Programa neste computador* |
| mudar comando, argumentos, variáveis, pasta, tempo de partida | *Editar* no detalhe do conector |
| permissões por ferramenta | já estavam na tela (Sempre permitir · Perguntar · Bloquear) |

O que o formulário não cobre (`includeTools`/`excludeTools`, `timeoutMs`, `alwaysLoad`, `maxOutputTokens`, `type`) só muda no `settings.json`
à mão; uma edição pelo formulário **mantém** esses campos como estavam. O agente também instala servidores com `mcp_install`.

## Logos dos serviços

Cada cartão (e o detalhe) mostra o **logo do serviço**; quando não há logo, as iniciais coloridas de antes. As imagens são coletadas **em
desenvolvimento** por `node scripts/connector-icons.mjs` (`npm run connector-icons`) e **empacotadas no app** em
`src/renderer/public/connector-icons/`: o Openclod não busca logo na internet (a tela funciona offline e nenhum terceiro sabe o que você está
olhando). Cobertura, fontes, o que ficou sem logo e por quê: `docs/mcp/ICONES-CONECTORES.md`; origem de cada imagem:
`docs/mcp/icones-conectores.json`. Conectores que você adiciona por conta própria recebem o logo quando o nome ou o endereço citam uma marca
conhecida (`whatsapp`, `appwrite-docs`, `mcp.mercadopago.com`...); os demais ficam com as iniciais. Para trocar ou tirar um logo, edite
`scripts/data/connector-icons-overrides.json` e rode a coleta de novo.

## Testes (o que foi de fato verificado em 27/10/2026)

- **Sondagem sem credenciais dos 795 endpoints** (`docs/mcp/SONDAGEM-2026-10-27.md`) e **bateria pelo código real do Openclod nos 900**
  (`docs/mcp/TESTE-CONECTORES-2026-10-27.md`, `npm run test:connectors`): 113 conectaram sem login e listaram ferramentas; 492 têm o login de 1 clique
  pronto (o ensaio montou a URL de autorização com PKCE); 102 só logam com client id próprio; 90 bloqueados pelo serviço (WAF/403/registro recusado);
  83 sem endereço público; 6 fora do ar; 22 locais (14 subiram e listaram ferramentas).
- **Ponta a ponta com modelo real** (`scripts/ui-mcp-agent.cjs`, 12 checagens): conecta o Microsoft Learn pelo diretório, o DeepSeek chama
  `mcp__microsoft-learn__microsoft_docs_search` e responde pelo resultado; ao bloquear a ferramenta, nem a chamada direta nem `mcp_call` funcionam.
- **Tela** (`scripts/ui-connectors.cjs`, 83 checagens): grade de 900, busca, detalhe, conector personalizado, políticas persistidas, nenhum segredo em
  texto puro na tela nem no `settings.json`; logos carregam de verdade (`naturalWidth > 0` numa amostra de cartões e no detalhe), vêm do pacote do app
  (nenhum pedido de imagem à internet), cartão sem logo mostra as iniciais e imagem que falha volta para as iniciais.
  `scripts/ui-connector-icons.cjs` reproduz a seção "Conectados" com os nomes dos conectores do usuário (marcas com logo, as demais com iniciais).

## O que NÃO foi (nem pode ser) testado aqui

- **N5 — conectado com a sua conta.** Entrar em cada serviço exige o seu login; nunca foi tentado. Nenhum OAuth real foi concluído.
- Cada ensaio de OAuth fez **um registro dinâmico descartável** (cliente "Openclod Desktop teste") em ~500 servidores de terceiros; é o que o app faz
  na primeira conexão, mas ficaram registros sem uso nesses serviços. Não repita a rodada completa sem necessidade.
- Os 45 `oauth` que o serviço bloqueia e os `403` de WAF podem ser intermitentes. Strava e Oxford Economics recusam o registro em todas as variantes
  testadas, sem causa conhecida.
- Não implementado: sampling, roots, tasks e o modo URL da elicitação; a interface de prompts como `/mcp__srv__prompt` e a menção `@servidor:uri`
  (só a camada de dados); Client ID Metadata Documents (`docs/mcp/CLIENT-ID-METADATA-DOCUMENTS.md`).
- Este PC: os servidores `uvx` falham com "pywin32, os error 32" no cache padrão do uv (também fora do Openclod). `uv cache clean` ou `UV_CACHE_DIR`
  em outra pasta resolve.

Veja também: `docs/mcp/ESTUDO-CLAUDE-MCP.md` (o que o Claude/Claude Code fazem com MCP e o que o Openclod cobre), `docs/mcp/DIRETORIO-CONECTORES.md`, `docs/MCP_OAUTH.md`.
