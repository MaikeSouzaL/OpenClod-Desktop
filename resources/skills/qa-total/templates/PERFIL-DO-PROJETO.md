# PERFIL do projeto — <nome do projeto>

<!--
Adaptador da skill qa-total para ESTE projeto. Copie para <raiz-do-projeto>/.qa/PERFIL.md e
preencha. Vale entre rodadas: cada rodada lê, revalida (ambiente por medição, baselines, usuários)
e acrescenta o que aprendeu.
Regras deste arquivo:
- Medido > lembrado: todo número com a data em que foi medido (saída de `date`, nunca estimada).
- NUNCA coloque senha, token, cookie, connection string ou chave aqui.
- O que este perfil proíbe vale mais que o padrão da skill. Ele só pode afrouxar o padrão com
  pedido explícito do usuário, anotado com a frase literal e a data, e o afrouxamento vale só para a
  rodada daquela data. Produção nunca é afrouxada aqui: é somente leitura, sem exceção.
- As seções 3 (Ambientes), 9 (Efeitos externos) e 10 (Autorizações) só mudam à mão, com pedido do
  usuário; o scripts/aprender.py recusa gravar nelas.
- Remova os comentários HTML que não ajudarem mais; mantenha os títulos das seções.
Guia completo: references/perfil-e-inventario.md. Exemplo preenchido: exemplos/PERFIL-exemplo-crm-web.md.
-->


- **Atualizado em:** <AAAA-MM-DD HH:MM> <!-- saída de `date` -->
- **Por:** <sessão/agente/pessoa>
- **Pasta de trabalho das rodadas:** <`.qa/` | outra pasta, ex.: vault de memória do usuário>
  <!-- se apontar outra pasta, as rodadas (ledger, notas, evidências, relatório) vão para lá -->

---

## 1. Projeto

| | |
|---|---|
| Nome | <nome do produto e do repositório> |
| Tipo (slug de --tipo-projeto; mais de um: repita a opção) | <front-web · full-stack · api · mobile · cli · biblioteca · jobs · llm · desktop · jogo · site-estatico · monorepo> |
| Repositórios | <caminho de cada repo: front, back, mobile…> |
| Stack | <framework, linguagem, UI, HTTP, banco> |
| Domínio | <o que o sistema faz, em uma frase de negócio> |
| Regras do projeto lidas | <CLAUDE.md §…, AGENTS.md, CONTRIBUTING, memória do usuário — com data> |

<!-- Conflito entre regras: a instrução explícita mais nova do usuário vale; registre as duas. -->
**Conflitos de regra conhecidos:** <regra antiga × regra nova, datas, qual vale>

### 1.1 Superfície por tipo (preencha só o que se aplica)

<!-- Apague os blocos que não valem para este projeto. Guia: references/perfil-e-inventario.md §4.14
     e references/execucao-e-evidencias.md §1.3. -->

- **Mobile:** build/variante de teste <debug/release, flavor> · emulador ou aparelho <modelo, SO> ·
  instalar/resetar <comando> · esquema de deep link <app://…> · captura de rede <interceptor de debug /
  proxy com CA só no emulador> · alvos estáveis <testID / accessibility id>
- **CLI:** binário <caminho ou nome no PATH> · instalação <comando> · shells testados <bash, PowerShell…> ·
  variáveis de ambiente que mudam o comportamento <lista, sem valor secreto>
- **Biblioteca:** registro <npm, PyPI, NuGet, crates.io…> · nome publicado <pacote> · última versão
  publicada <x.y.z, data> · runtimes suportados <versões> · como empacotar <npm pack / python -m build…>
- **Jobs, filas, ETL:** agendador <cron, Hangfire, Celery beat…> · broker <RabbitMQ, SQS, Kafka…> · fila de
  teste <nome> · DLQ <nome> · como disparar em dev sem efeito real <comando ou endpoint de trigger>
- **App com modelo de linguagem:** provedor e modelo <nome, versão> · temperatura/seed <valores> · teto de
  custo da rodada <valor> · conjunto de avaliação <caminho, critério, limiar>
- **Desktop:** empacotamento <Electron, Tauri…> · updater <canal de teste> · driver:
  <_electron | tauri-driver | computer-use> · pasta do perfil do usuário que o app grava <caminho>
- **Jogo / canvas:** seed fixa <valor ou como fixar> · estado de debug que serve de oráculo
  <ex.: `window.__estado`, console de debug> · dispositivos de entrada <teclado, mouse, toque, controle>
- **Site estático:** URL publicada <host> · gerador <Next export, Hugo, Astro…> · sitemap <caminho> ·
  robots <caminho>; como servir o build localmente <comando>

#### Pacotes (monorepo)

| Pacote | Caminho | Tipo | Comandos de gate | Baseline (data) |
|---|---|---|---|---|
| <web> | <apps/web> | <front-web> | <typecheck, lint, test, build> | <N erros, AAAA-MM-DD> |
| <shared> | <packages/shared> | <biblioteca (interna)> | <…> | <…> |

<!-- Pacote compartilhado alterado: regressão em todos os consumidores internos e build na ordem do
     grafo (catálogo §1.4, linha Monorepo). -->

## 2. Como subir

| Serviço | Comando | Porta | Quem sobe | Como saber que subiu | Observações |
|---|---|---|---|---|---|
| <front> | <npm run dev> | <3000> | <eu / usuário> | <URL ou linha de log> | <tempo de subida> |
| <API> | <…> | <…> | <usuário, na IDE> | <…> | <reiniciar = avisar o usuário e esperar> |

<!-- Serviço que o usuário mantém aberto é dele: nunca mate o processo; peça o reinício. -->

## 3. Ambientes

| Nome | Front | API | Banco | Tipo | Política | Como confirmar | Fuso do servidor · do usuário |
|---|---|---|---|---|---|---|---|
| <local> | <http://localhost:…> | <https://localhost:…> | <servidor/banco> | local | escrita via app | <§4> | <UTC · America/Sao_Paulo> |
| <teste> | <host> | <host> | <…> | teste compartilhado | escrita via app, registrar sujeira | <…> | <…> |
| <produção> | <host> | <host> | <…> | **produção** | **somente leitura (não editável)** | <…> | <…> |

<!-- A política da linha de produção não se edita: produção é somente leitura, sem exceção. Gravar lá
     só com pedido do usuário no chat para aquela ação, registrado na rodada
     (cobertura.py rodada --autorizacao), nunca neste arquivo. -->

- **Mapa de deploy:** <arquivo do workflow → branch → host → API> <!-- é ele que diz o que é produção -->
- **Sinais de produção:** <domínios, volume típico (ex.: "milhares de registros"), nomes reais>
- **Hosts de produção** (hosts_producao; comparados com o host medido na rede antes da primeira
  escrita; bateu = somente leitura): <app.exemplo.com, api.exemplo.com>
- **Armadilhas de ambiente:** <ex.: mesma porta para perfis de bancos diferentes; .env ignorado>

### 3.1 Ambiente de reteste

<!-- Onde a correção é retestada (fase 7). Medido como o ambiente alvo, nunca lido do .env: sem medida,
     não serve para reteste e a correção vira proposta. Produção nunca é ambiente de reteste. -->

- **Nome:** <local | teste>
- **URL:** <front e API>
- **Host medido:** <host da API lido na rede (ou a sessão vista no banco), com a data da medição>
- **Como medir:** <espião de rede na aba, log de inicialização da API, sessão no banco>
- **É produção?** <não — se sim, a correção fica só como proposta>
- **Escrita pela aplicação permitida no reteste?** <sim / não>

## 4. Confirmação de ambiente (antes de toda escrita e depois de todo reinício)

1. <Front → API: como ler o host real das requisições (ferramenta de rede, espião)>
2. <API → banco: consulta que mostra a sessão da máquina/da API>
3. <Perfil de execução da API e banco que o log de inicialização mostra>

<!-- Se perceber escrita em produção: PARE, liste o que gravou, avise o usuário. Não "limpe". -->

## 5. Banco — somente leitura

- **Engine / servidor / banco por ambiente:** <…>
- **Cliente e comando-modelo (sem segredo):** <ex.: `sqlcmd -S <servidor> -d <banco> -Q "SELECT …"` com a conexão lida na hora>
- **Onde está a conexão:** <arquivo:chave> <!-- nunca copiar o valor para nenhum arquivo -->
- **Como forçar leitura:** <READ ONLY na sessão / login db_datareader / só SELECT>
- **Tabelas úteis:** <auditoria, log de e-mail, notificações, sessões>
- **Entidade da tela → tabela:** <cliente → `clientes`, …>
- **Escrita:** <padrão: só via aplicação; UPDATE/DELETE direto só com pedido explícito>

## 6. Autenticação, papéis e eixos de autorização

- **Mecanismo:** <sessão / JWT / SSO / 2FA>
- **Como logar:** o usuário loga. Eu nunca digito senha nem faço login.
- **Credencial por papel sem login** (credencial_sem_login): <variável / arquivo / cliente de teste com auth falsa>
  <!-- para API, CLI e jobs; só o nome da variável ou do arquivo, nunca o valor; quem cria e preenche é
  o usuário (references/execucao-e-evidencias.md §1.2) -->
  - (a) variável de ambiente, ex. `QA_TOKEN_<PAPEL>`: só vale se estiver no perfil do shell ou no ambiente
    que iniciou o Claude Code (um `export` noutro terminal no meio da sessão não chega);
  - (b) arquivo de cabeçalho fora do repositório, ex. `$QA_CRED_DIR/<papel>.header` lido com
    `curl -H @arquivo`: o usuário cria sem reiniciar a sessão.
- **UI sem sessão do usuário:** <como a credencial de teste chega ao storage no Playwright headless com
  perfil temporário: chave do storage e de onde vem a credencial (a ou b acima); "não se aplica" se a UI
  usa a sessão do usuário> <!-- references/execucao-e-evidencias.md §2.2 -->
- **Mudança de permissão vale quando:** <ex.: só depois de sair e entrar (vem no token)>
- **Eixos de autorização:** <papel · permissão por ação/campo · flags globais · tenant · nível/plano · dono do registro · estado · feature flag>
- **Onde moram:** <enums, seeds, tabelas, policies, middleware>

| Papel | Usuário de teste (sem senha) | Tenant / organização | O que tem de especial | Quem loga |
|---|---|---|---|---|
| <admin> | <e-mail> | <…> | <…> | usuário |
| <papel restrito> | <e-mail> | <…> | <…> | usuário |

- **Armadilhas de sessão:** <ex.: duas sessões no mesmo navegador compartilham cookie>

## 7. Ferramentas de execução e captura

| Uso | Ferramenta | Dispositivo/terminal | Observação |
|---|---|---|---|
| Validar na tela, sessão do usuário | <ex.: extensão do navegador do usuário> | <navegador do usuário> | <ele vê o que acontece> |
| QA repetível, viewport exato | <ex.: Playwright com perfil fixo> | <janela própria> | <login feito uma vez pelo usuário> |
| **Proibida** | <ex.: navegador integrado> | <…> | <motivo> |
| Print salvo em arquivo | <comando/ferramenta> | <…> | <screenshot de MCP pode não gravar arquivo> |
| Espião de rede | <scripts/xhr-spy.js ou ferramenta de rede> | <aba da tela> | <reinstalar a cada navegação; cobre XHR, fetch, WebSocket e EventSource> |
| Alvos estáveis | <data-testid / testID / accessibility id> | <…> | <exemplos> |
| Mobile nativo | <adb, xcrun simctl, Maestro, Appium> | <emulador/aparelho> | <hierarquia de UI e rede: references/execucao-e-evidencias.md §1.3> |
| CLI, jobs, API pura | <terminal; curl/httpie> | <shell> | <credencial do papel por variável de ambiente ou arquivo de cabeçalho, §6> |
| UI web sem a sessão do usuário | <Playwright headless, perfil temporário> | <janela própria, sem login> | <credencial de teste injetada no storage, §6> |

- **ferramenta_navegador:** <a da linha "Validar na tela" ou "QA repetível"; vazio = nenhuma permitida>
- **ferramenta_ui** (fora do navegador): <computer-use / adb, simctl / Appium, Maestro / Playwright
  _electron / terminal / nenhuma> <!-- app nativo, desktop, jogo ou CLI interativa; sem ela, o lote de
  UI fica nao-validado com o que destrava -->

## 8. Dados de teste permitidos

- **E-mails de teste:** <padrão, ex.: usuario+<tag>@dominio>
- **Documentos (CNPJ/CPF/etc.):** <reais, achados em fonte pública e conferidos no banco | geradores válidos de teste>
- **Registros de referência:** <códigos/ids, SEMPRE com o ambiente junto>
- **Marca de sujeira:** <prefixo no nome/observação para achar depois, ex.: "QA AAAA-MM-DD">

## 9. Efeitos externos

| Efeito | Gatilho | Destinatário | Autorizado? | Como conferir |
|---|---|---|---|---|
| <e-mail X> | <ação> | <quem recebe> | <sim / não / perguntar> | <tabela de auditoria, caixa de teste> |
| <integração Y> | <ação> | <sistema terceiro> | <…> | <…> |

<!-- Sem autorização: o caso fica "bloqueado" e a prova vai até o ponto anterior ao envio.
     "Autorizado? sim" só com a frase literal do usuário e a data ao lado, e vale só para a rodada
     daquela data; a seção só muda à mão. Em produção, efeito externo nunca. -->

## 10. Autorizações padrão neste projeto

<!-- Só muda à mão, com pedido do usuário. Linha que libera algo além do padrão da skill leva a frase
     literal do usuário e a data na última coluna, e vale só para a rodada daquela data: na rodada
     seguinte, pergunte de novo. Sem frase e data, vale o padrão. Produção não entra aqui (§3). -->

| Ação | Permitido? | Observação | Pedido do usuário (frase literal, data) |
|---|---|---|---|
| Corrigir código do front | <sim, em pedido de QA / só relatar> | <"focar/analisar" nunca autoriza> | <padrão da skill> |
| Corrigir na hora (defeito claro) | corrigir_na_hora: <sim (padrão em pedido de QA) / nao> | <os seis testes de references/qualidade-e-refatoracao.md §1.2; "nao" = só relatar e propor> | <padrão da skill> |
| Refatorar e componentizar | refatorar: <pequena (padrão) / sim / nao> | <pequena = só no trecho que já se corrige, com caracterização IGUAL; grande vira proposta R-n> | <…> |
| Corrigir código do back | <só relatar (padrão) / sim> | <reinício avisado ao usuário> | <"…", AAAA-MM-DD> |
| Camadas/repositórios só relato (camadas_so_relato) | <lista> (padrão: todo repositório ou pasta fora do que o pedido nomeou) | <relata e propõe, não altera> | <…> |
| Reiniciar serviços | avisar o usuário e esperar | <juntar mudanças> | |
| Escrita via aplicação | <por ambiente, ver §3; produção nunca> | registrar sujeira | |
| `UPDATE`/`DELETE` direto | não, sem pedido explícito | | <"…", AAAA-MM-DD, só aquela ação> |
| Commit / push / merge / PR | <padrão: nunca> | <entregar branch sugerida + mensagem em bloco> | <"…", AAAA-MM-DD, só aquela ação> |
| Efeito externo | ver §9 | | |

## 11. Regras de código

- **Comentários:** <permitidos? estilo?>
- **Textos de UI:** <dicionário i18n? em quantos locales? arquivo de tipos?>
- **Componentes:** <reutilizar; componente compartilhado alterado → testar outros usos>
- **Gates obrigatórios:** <typecheck, lint, build, testes — ver §12>
- **Fim de linha:** <LF/CRLF; conferir `git diff --stat` == `git diff --ignore-cr-at-eol --stat`>
- **Entrega:** <branch sugerida, mensagem de commit em bloco copiável, changelog, PDF>
- **Outras:** <…>

## 12. Baselines

| Gate | Comando | Resultado | Data | Composição / ruído |
|---|---|---|---|---|
| Typecheck | <…> | <N erros> | <AAAA-MM-DD> | <ex.: inclui +9 de arquivos gerados> |
| Lint | <…> | <…> | <…> | <ex.: não executável — erro X> |
| Testes | <…> | <…> | <…> | <…> |
| Build | <…> | <…> | <…> | <…> |

<!-- Correção nunca sobe o número. Número que não muda com a entrada, ou que despenca, é
     medição quebrada até prova em contrário. -->

## 13. i18n e feature flags

- **Locales:** <lista; padrão>
- **Dicionários:** <caminho> · **Tipos das chaves:** <caminho>
- **Paridade:** <comando/script para conferir>
- **Armadilhas:** <ex.: apóstrofo quebra o arquivo de um idioma>

### 13.1 Feature flags

<!-- Sem como alternar a flag sem afetar outras pessoas, o caso do estado alternativo fica bloqueado com
     o que destrava (references/perfil-e-inventario.md §4.13). Cada flag vira item flag:<nome>. -->

- **Provedor:** <LaunchDarkly, Unleash, GrowthBook, ConfigCat, Flagsmith, tabela própria, variável de ambiente>
- **Onde ficam:** <arquivo, tabela ou painel>
- **Como alternar por ambiente sem afetar outras pessoas:** <usuário ou tenant de teste, override local, ambiente próprio>
- **Como enumerar:** `rg -n -i "launchdarkly|unleash|growthbook|configcat|flagsmith|useFlag|isEnabled\(|FEATURE_[A-Z_]+"`

## 14. Design system

- **Tokens:** <arquivo> · **Componentes:** <pasta> · **Vitrine:** <rota/Storybook — referência, não validação>
- **Temas:** <claro, escuro, alto contraste; como alternar (preferência do sistema, botão, classe)>
- **Regras:** <cor = status; números alinhados; botão destrutivo vermelho; posição do toast…>

## 15. Testes automatizados existentes

| Tipo | Ferramenta | Como rodar | Estado em <data> |
|---|---|---|---|
| <unit> | <…> | <…> | <…> |
| <e2e> | <…> | <…> | <…> |

## 16. Registro e entrega

- **Notas, evidências, ledger:** <pasta da rodada e convenção de nomes>
- **Memória/changelog do projeto:** <onde registrar cada correção>
- **Relatório final:** <PDF? formato? para quem?>
- **Comunicação com o time:** <canal, tom, o que vai em bloco copiável>
- **Mapa do projeto:** `.qa/MAPA.md` — persiste entre rodadas, sem segredo, revalidado a cada rodada
  (references/qualidade-e-refatoracao.md §2.6).
- **Testes de regressão gerados:** <`.qa/regressao/` | pasta de testes do projeto, só com autorização>
  · framework: <Playwright, pytest, ...> · trava de produção: QA_HOSTS_PROIBIDOS=<hosts de produção>
- **Branch de destino das PRs:** <ex.: origin/develop> · **prefixo da API** (prefixo_api) das
  chamadas relativas do front, usado no escopo do diff e no gate do modo PR: <ex.: api/v1, sem a barra
  inicial; vazio se não houver>

<!-- Estilo das mensagens para o time (lido pelo scripts/mensagens.py; a linha de comando manda
     sobre o PERFIL). Guia: references/comunicacao-e-painel.md §2 e §3. Valor entre <...> é
     ignorado até ser preenchido. -->
- estilo_mensagens: <whatsapp | formal>
- mensagens_canal_tecnico: <grupo ou conversa técnica, com print>
- mensagens_canal_negocio: <quem decide regra>
- mensagens_canal_proibido: <onde não mandar>
- mensagens_abertura: <linha 1> / <linha 2>
- mensagens_fecho: <linha 1>
- mensagens_trocas: <de>=<para>; <de>=<para>
- mensagens_minusculas: <sim | nao>
- mensagens_pontuacao_final: <nao | sim>
- mensagens_max_linha: <90>
- mensagens_linhas_por_mensagem: <3>
- mensagens_dizer_nao_commitado: <sim | nao>
- mensagens_codigo: <nao | sim>
- mensagens_numerar: <sim | nao>
- mensagens_saudacao_formal: <Olá,>

## 17. Armadilhas conhecidas — lista viva do projeto

> Nada aqui afrouxa as regras inegociáveis (SKILL.md §2); em conflito, vale a guarda.

<!-- Formato: **sintoma** — causa; como evitar. (AAAA-MM-DD)
     Lição que vale para qualquer projeto vai TAMBÉM para references/catalogo-de-testes.md da skill. -->

### Ferramenta
- **<sintoma>** — <causa>; <como evitar>. (<data>)

### Ambiente e dados
- **<sintoma>** — <causa>; <como evitar>. (<data>)

### Tempo e desempenho
- **<sintoma>** — <causa>; <como evitar>. (<data>)

### Código e gates
- **<sintoma>** — <causa>; <como evitar>. (<data>)

## 18. Checklists por módulo (opcional)

### <Módulo>
- <o que não pode faltar neste módulo>

## 19. Rodadas anteriores

| Data | Alvo | Pasta | Gate | Resumo |
|---|---|---|---|---|
| <AAAA-MM-DD> | <tela/fluxo> | <.qa/AAAA-MM-DD-alvo/> | <passou / pendente> | <N casos, N defeitos, N retratados> |

## 20. Módulos avançados e opcionais

<!-- Avançados (references/modulos-avancados.md) entram SEMPRE que o projeto permitir; aqui fica
     o que cada um precisa. Opcionais (references/modulos-opcionais.md) só quando ligados aqui.
     Módulo que não se aplica ou desligado vira caso nao-aplicavel em dimensao:MA-<n>/MO-<n>. -->

### Avançados — o que cada um precisa neste projeto

| Módulo | Neste projeto |
|---|---|
| MA-1 log do servidor | <por serviço: onde fica, comando de leitura (sempre leitura), fuso, se tem buffer> |
| MA-2 front × back | <onde ficam os DTOs/enums do back e os models do front; OpenAPI, se houver> |
| MA-3 integridade do banco | <acesso de leitura? como travar a sessão em leitura; invariantes já conhecidas> |
| MA-4 modo PR/diff | <branch de destino; prefixo da API; pastas a excluir do raio> |
| MA-5 regressão automática | <framework; pasta; comando para rodar; sessão por storageState gerada pelo usuário> |
| MA-6 segurança funda | <comandos de auditoria por ecossistema; hosts de produção (nunca escrita); varrer histórico só com autorização> |

### Módulos opcionais

| Módulo | Estado | Ferramenta | Por quê | Desde |
|---|---|---|---|---|
| 7 visual | <ligado / desligado> | <Playwright (viewport exato) + visual_diff.py> | <baseline em .qa/baseline/> | <AAAA-MM-DD> |
| 8 a11y | <ligado / desligado> | <axe-core do node_modules (arquivo local) / Playwright com perfil de QA; CDN nunca em produção nem em aba com sessão real> | <...> | <AAAA-MM-DD> |
| 9 fuzz | <ligado só em dev / desligado> | <fuzz_valores.py> | <escrita de dado de teste autorizada> | <AAAA-MM-DD> |
| 10 desempenho | <passivo ligado; Lighthouse ligado/desligado> | <xhr-spy + vitais; Lighthouse> | <...> | <AAAA-MM-DD> |

- **Orçamento de desempenho:** <tempo-limite por chamada; KB de JS por rota>
- **Nível WCAG alvo:** <AA>
- **Viewports da baseline visual:** <1440x900, 390x844>
- **visual_diff:** limiar <0> %, tolerância <16>
- **Domínio de e-mail de teste para o fuzz:** <example.com ou a caixa autorizada>
