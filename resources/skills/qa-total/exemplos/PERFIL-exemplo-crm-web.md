# PERFIL do projeto — Urmobo Partner Elevate (CRM do parceiro)

> **Exemplo real** de PERFIL preenchido: o projeto onde o método da skill nasceu (prompt mestre de
> QA aprovado em 29/09/2026: *"é exatamente isso que eu quero"*). Serve para mostrar o nível de
> detalhe esperado. Fontes: `E:\urmob\urmobo_crm_front\PROMPT-MESTRE-QA.md` (seções 1, 3 e 4),
> `CLAUDE.md` do repositório e as regras de feedback do usuário.
>
> ⚠️ Contém hosts, códigos de registro e o padrão de e-mail de teste do projeto. Antes de
> compartilhar a skill fora desta máquina, remova este arquivo ou anonimize-o.

- **Atualizado em:** 2026-09-30 22:40
- **Por:** skill qa-total (consolidado do prompt mestre e do changelog do CLAUDE.md)
- **Pasta de trabalho das rodadas:** vault de memória do usuário,
  `C:\Users\Administrator\Desktop\whatsapp-claude\output\memoria\` (ver §16). Este PERFIL fica em
  `E:\urmob\urmobo_crm_front\.qa\PERFIL.md`.

---

## 1. Projeto

| | |
|---|---|
| Nome | Urmobo Partner Elevate — portal do parceiro (white-label Affinitas PRM). Repo front `urmobo_crm_front` (pacote `affini` 0.9.18) |
| Tipo (slug de `--tipo-projeto`) | `full-stack`, em dois repositórios |
| Repositórios | front `E:\urmob\urmobo_crm_front` · back `E:\urmob\Urmobo_crm_api` (projeto de entrada `src/MR.Urmobo.Application`) |
| Stack | Next.js App Router, React 18, TypeScript, Tailwind + shadcn/Radix/Flowbite, axios · ASP.NET + EF Core · SQL Server |
| Domínio | gestão de parceiros (níveis/tiers), clientes, oportunidades (BANT, apresentação, POC), contratos, pedidos, aditivos, descontos, faturamento |
| Regras lidas | `CLAUDE.md` §6.1 (tier), §9 (design system), §10 (convenções), §10.1 (produção só leitura), §10.2 (navegador), §10.4 (tom das mensagens), §10.5 (memória); `PROMPT-MESTRE-QA.md` (29–30/09/2026); memória do Claude Code em `~/.claude/projects/E--urmob-urmobo-crm-front/memory/` |

**Conflitos de regra conhecidos:**

- **Backend:** "não mexer no backend, só relatar" (09/09/2026) × prompt mestre §1.7 "pode alterar o
  `Urmobo_crm_api` quando a correção exigir" (29/09/2026). **Vale o mais novo**, com reinício da API
  avisado. Em dúvida, confirme na rodada.
- **"Focar", "analisar", "olhar" não autorizam alterar código** (08/09/2026) — vale sempre, mesmo
  com o prompt mestre. Pedido de QA pelo prompt mestre autoriza corrigir defeito claro.

## 2. Como subir

| Serviço | Comando | Porta | Quem sobe | Como saber que subiu | Observações |
|---|---|---|---|---|---|
| Front | `npm run dev` (ou `.claude/launch.json` → `crm-front`) | 3000 | eu, pelo terminal | `http://localhost:3000` responde | Node 20.x. Nunca abrir no navegador integrado (§7) |
| API | Visual Studio, perfil **`[DEV] MR.Urmobo.Application`** | 7112 (https) | **o usuário** | primeira requisição do front sem erro de rede | reiniciar = **avisar "preciso que reinicie a API" e esperar**; juntar mudanças de back para pedir o mínimo de reinícios |
| Build do back (para conferir) | `dotnet build src/MR.Urmobo.Application/MR.Urmobo.Application.csproj -o <pasta temporária>` | — | eu | 0 erros | `-o` porque o Visual Studio trava o `bin` |

## 3. Ambientes

| Nome | Front | API | Banco | Tipo | Política | Como confirmar |
|---|---|---|---|---|---|---|
| **Local** | `http://localhost:3000` | `https://localhost:7112/api/v1` | `UrmoboCRMDev` (servidor `urmoboteste`) | local → banco dev | escrita via aplicação; registrar sujeira | §4 |
| **Teste (brave-bay)** | `brave-bay-0d8c0a310.7.azurestaticapps.net` | `affinitasprmapi-…centralus-01.azurewebsites.net` | dev/teste do Azure | teste compartilhado | escrita via aplicação; outras pessoas usam | job "Brave Bay" do workflow |
| **API Azure compartilhada** | — (localhost religado para ela) | `urmobonewcrmapi.azurewebsites.net` | compartilhado | dev compartilhado | escrita com cuidado; outras pessoas usam | host na aba de rede |
| **Produção** | `witty-stone-0484b7a10.4.azurestaticapps.net`, `partner.urmobo.com.br`, `crm.urmobo.com.br`, `crm.urmobo.com`, `partner.urmobo.com`; embed em `affinitasprm.com.br` | `urmobocrmapp.azurewebsites.net` | produção | **produção** | **SOMENTE LEITURA**, só pela extensão do Chrome | workflow de deploy |

- **Mapa de deploy:** `.github/workflows/azure-static-web-apps-witty-stone-0484b7a10.yml` —
  branch `master` → `witty-stone` → API `urmobocrmapp` (**produção**); job "Brave Bay" →
  `brave-bay` → API `affinitasprmapi` (teste).
- **Sinais de produção:** dashboard com ~3.800 oportunidades e ~460 parceiros ativos; nomes de
  empresas reais em todas as listagens.
- **Armadilhas de ambiente:**
  - os quatro perfis da API usam a **mesma porta 7112**: `[DEV]` → `Development` → `UrmoboCRMDev`;
    `[DEV LOCAL]` → `Default` → QA; `[PROD]` → `Production` → **produção**; `[AFFINITAS]`. A URL
    da API não prova o banco.
  - sem `ASPNETCORE_ENVIRONMENT` definido, a API local cai no **banco de produção** (29/09/2026);
  - `.env.local` está em UTF-16 e o carregador o ignora em silêncio; vale `.env.development`
    (`https://localhost:7112`). Uma variável no shell que subiu o `npm run dev` vence os arquivos.
    **Medir na rede, sempre.**

### 3.1 Ambiente de reteste

- **Nome:** Local (o mesmo do ANTES quando o defeito se reproduz nele; senão o Teste brave-bay)
- **URL:** front `http://localhost:3000` · API `https://localhost:7112/api/v1`
- **Host medido:** o host da API lido no espião de rede da aba, e o banco da sessão vista no
  `sys.dm_exec_sessions` (§4); data da medição na nota 01 da rodada
- **Como medir:** espião de rede na aba + log de inicialização da API (perfil `[DEV]`)
- **É produção?** não. Se a medida mostrar `urmobocrmapp` ou banco de produção, não serve para
  reteste e a correção fica como proposta
- **Escrita pela aplicação permitida no reteste?** sim, só pela aplicação, com registro em sujeira

## 4. Confirmação de ambiente (antes de toda escrita e depois de todo reinício)

1. **Front → API:** recarregar a tela e ler o host de `…/api/v1/…` pela ferramenta de rede da
   extensão (`read_network_requests`).
2. **API → banco:** no `UrmoboCRMDev`, `sys.dm_exec_sessions` mostrando a máquina local
   (`host_name`) conectada.
3. **Perfil da API** no Visual Studio = `[DEV] MR.Urmobo.Application`.

🔴 **Por que existe:** em 29/09/2026 as fases 1 a 3 do onboarding de um parceiro foram feitas em
**produção** — `witty-stone` foi tratado como "teste". Ficaram gravados lá um parceiro, um nível
confirmado, perfis clonados, um usuário e um "Liberar Ambiente UEM" (integração externa). O sinal
(milhares de oportunidades na tela) estava visível desde o começo.

## 5. Banco — somente leitura

- **Engine:** SQL Server. **Dev:** `UrmoboCRMDev` no servidor `urmoboteste`.
- **Cliente:** `sqlcmd`. **Conexão:** `DevConnection` do `appsettings.Development.json` da API —
  lida na hora, **nunca copiada** para arquivo nenhum. Senha só no processo do comando (variável
  `SQLCMDPASSWORD`), nunca em script salvo.
- **Comando-modelo:** `sqlcmd -S <servidor> -d UrmoboCRMDev -U <usuário> -Q "SET NOCOUNT ON; SELECT …"`
- **Forçar leitura:** só `SELECT`. Nenhum `UPDATE`/`DELETE`/`MERGE` sem pedido explícito.
- **Tabelas úteis:**

  | Tabela | Para quê |
  |---|---|
  | `atividade` | auditoria; e-mail com subject `Email Sent` / `Email Send Failed` |
  | `notificacoes` | notificações geradas (conferir destinatários e duplicação) |
  | `oportunidades`, `oportunidades_itens`, `oportunidades_contatos` | oportunidade, produtos, contatos |
  | `sys_field_values` | respostas de campos dinâmicos (questionários, BANT) — conferir órfãos depois de excluir |
  | `respostas_pergunta` | questionário de perda (conta os respondentes) |
  | `contrato_itens`, `pedidos`, `pedidos_itens`, `aditivos_contrato` | contrato, pedidos, aditivos |
  | `parceiros`, `token_email_usuario` | parceiro; tokens de e-mail de primeiro acesso |
  | `sys.dm_exec_sessions` | quem está conectado (prova do ambiente) |

## 6. Autenticação, papéis e eixos de autorização

- **Mecanismo:** JWT (access + refresh); refresh automático no `apiManager.ts`. O token da aba vive
  no `sessionStorage` (ou `localStorage` com "lembrar-me"); o cookie `auth.token` é **por origem**,
  compartilhado entre abas, e é ele que o middleware do Next lê.
- **Como logar:** o usuário loga. Eu nunca digito senha nem faço login.
- **Credencial por papel sem login** (credencial_sem_login): não se aplica; o teste é pela tela, na
  sessão que o usuário deixou logada. Se um dia houver teste só de API, a credencial chega por (a)
  variável de ambiente no perfil do shell ou no ambiente que iniciou o Claude Code, ou (b) arquivo de
  cabeçalho fora do repositório lido com `curl -H @arquivo`; nunca o valor no PERFIL.
- **UI sem sessão do usuário:** não se aplica; a UI é testada na sessão do usuário (extensão do Chrome)
  ou no perfil de QA do Playwright em que ele mesmo logou.
- **Mudança de permissão vale quando:** só depois de **sair e entrar** (as permissões vêm no token).
  F5 não basta.
- **Eixos de autorização** (cada um é uma coluna da matriz):
  - ACL do perfil — `PermissionEnum` `Blocked=-1, NA=0, Read=1, Write=2, FullControl=3`; features
    por ação e **por campo** (`*_FIELD_*`). Features ESTÁTICAS gravam `Read(1)` para dizer "pode
    editar";
  - flags globais: `GLOBAL_READ` (lê tudo; desde 05/08 não concede permissão de campo) e
    `GLOBAL_WRITE_BLOCK` (derruba qualquer `hasPermission`, inclusive de visibilidade);
  - **nível de parceria (tier)**: `urmobo | distribuidor | tier1 | tier2` — **só no front**, o
    backend não valida;
  - usuário Urmobo (`isMember`/`isAdmin` e não `usuarioParceiro`) — quem aprova desconto e rescisão;
  - tenant = parceiro (o parceiro só vê os próprios dados);
  - dono do registro (follow-up: só o criador ou admin conclui);
  - estado da oportunidade/contrato.

| Papel | Usuário de teste (sem senha) | Tenant (ambiente) | O que tem de especial | Quem loga |
|---|---|---|---|---|
| Tier 1 (parceiro) | `maikesouzaleite+tier1dev@gmail.com` | **PAR0000000579** OLOS (dev) | perfil ADM N; parceiro de referência criado do zero em 29/09 | usuário |
| Urmobo admin (aprovador) | conta "Administrador" do Thiago | Urmobo | aprova desconto, cancelamento e rescisão; menu completo | usuário |
| Tier 1 antigo | "Cairu Admin teste tier 1" | CAIRU TRANSPORTES (dev) | Gerente Comercial (Nível 1), `GLOBAL_READ = 3`; usado nos manuais de 11/09 | usuário |
| Tier 2 / distribuidor | pedir ao usuário | — | existem specs e2e (`criar-oportunidades-tier2`, `parceiros_distribuidor`) | usuário |

- **Armadilhas de sessão:** duas sessões no mesmo Chrome (tier 1 + aprovador) — **não apague o
  cookie de uma aba para "deslogar" a outra**: a primeira cai no `/login` no próximo reload. Abra a
  aba nova, peça ao usuário para logar nela e não recarregue a antiga enquanto isso.

## 7. Ferramentas de execução e captura

- **ferramenta_navegador:** extensão do Chrome (linha "Validar na tela"); **ferramenta_ui:** nenhuma
  (projeto web).

| Uso | Ferramenta | Observação |
|---|---|---|
| Validar na tela (local, teste e produção) | **extensão do Chrome** `mcp__claude-in-chrome__*`, na sessão que o usuário deixou logada | obrigatória; o usuário vê o que acontece |
| QA repetível, viewport exato | Playwright MCP `playwright-qa` (`.mcp.json`) | perfil fixo; a pasta real é a literal `${CLAUDE_PROJECT_DIR}/playwright/.perfil-qa` (o cliente não expande a variável; excluída no `.git/info/exclude`); login feito **uma vez** pelo usuário; **janela headed não se fecha** ao terminar |
| **Proibida** | navegador integrado (`mcp__Claude_Browser__*`, `preview_start`) | nem para localhost: lá não há sessão, e o usuário não vê |
| Print salvo em arquivo | `computer` screenshot com `save_to_disk`, ou `qa-catalogo/_ferramentas/capturar-print.ps1 -TitleMatch "Portal do Parceiro - Google Chrome"` (vault) | o screenshot da extensão não grava arquivo; print de 160×28 = janela minimizada |
| Circular o problema | `scripts/circular.py` da skill | medir com `getBoundingClientRect()`; `largura_css = innerWidth`; vermelho = problema, verde = corrigido |
| Espião de rede | `scripts/xhr-spy.js` da skill ou `read_network_requests` | o app usa axios/XHR (interceptar `fetch` não pega nada); reinstalar a cada navegação |
| Alvos estáveis | `data-testid` | ex.: `opportunity-save-button`, `opportunity-promote-presentation-button`, `opportunities-table-row-actions-<opoId>`, `select-<sfiId>-button`, `select-<sfiId>-option-<rótulo>` |

## 8. Dados de teste permitidos

- **E-mails de teste:** `maikesouzaleite+<tag>@gmail.com` (caixa do próprio usuário) — **liberado
  disparar** em dev (16/09/2026). Caixas descartáveis `@uorak.com` também usadas.
- **CNPJ:** sempre **real**, achado em busca pública e **conferido no banco** (já existe? é de outro
  parceiro?). Nunca inventar.
- **CPF de teste:** `111.444.777-35` (dígito verificador válido).
- **Registros de referência — sempre com o ambiente junto** (os códigos colidem entre dev e
  produção): PAR0000000579 OLOS (dev; em produção o mesmo código é outra empresa) ·
  CLI0000003821 TELEFONICA (dev) · CON0000000864 e CON0000000865 (dev) · OPO0000003843–3846 (dev).
- **Marca de sujeira:** "Reteste"/"QA <data>" no título ou na observação; tag da rodada no e-mail.

## 9. Efeitos externos

| Efeito | Gatilho | Destinatário | Autorizado? | Como conferir |
|---|---|---|---|---|
| E-mail "Nova Oportunidade Criada" | criar oportunidade | **pessoas reais do time Urmobo** | liberado em dev, mas **avisar o usuário a cada criação** | `atividade` |
| E-mail de BANT | criar oportunidade com contato que tem e-mail; **Reenviar BANT** (regenera o token e mata o link anterior) | contato do cliente | liberado em dev (caixas de teste) | `atividade`; link novo × antigo |
| Contrato + `CONTRATO_CRIADO` | ganhar oportunidade | ~16 destinatários (parceiro, distribuidor, Urmobo) | liberado em dev | `notificacoes`, `atividade` |
| Senha inicial / esqueci minha senha | ativação do parceiro, primeiro acesso | o usuário | liberado | `atividade` (`Email Sent`) |
| Liberar Ambiente UEM / Iniciar POC | botão na ativação do parceiro / aba POC | integração Affinitas/UEM (terceiro) | **perguntar** | — |
| Avisos de pedido | criar pedido | time | liberado em dev | `notificacoes` |

Ordem de investigação quando o e-mail "não chega": remetente/domínio → preferência → despacho e
template. O SMTP aceitar (`Email Sent`) não prova a entrega.

## 10. Autorizações padrão neste projeto

| Ação | Permitido? | Observação |
|---|---|---|
| Corrigir código do front | sim, em pedido de QA pelo prompt mestre | "focar/analisar/olhar" = só lista |
| Corrigir código do back | sim, quando a correção exigir (prompt mestre 29/09) | avisar o reinício; juntar mudanças |
| Corrigir na hora (defeito claro) | corrigir_na_hora: sim | é o método do prompt mestre (item 2.7): corrige e testa de novo na tela; decisão de produto nunca |
| Refatorar e componentizar | refatorar: pequena | grande vira proposta R-n; componente compartilhado só aditivo |
| Reiniciar a API | o usuário reinicia | "preciso que reinicie a API", e esperar |
| Escrita via aplicação | local e teste; produção nunca sem pedido | registrar sujeira |
| `UPDATE`/`DELETE` direto | não, sem pedido explícito | |
| Commit / push / merge / PR | **nunca** (26/08/2026) | entregar branch sugerida + mensagem de commit em bloco copiável + o que não foi validado |
| Separar por branch | quando pedido | `E:\urmob\entregas-por-branch\NN-<branch>\` com patch, `COMMIT-*.txt`, `PR.md`, `APLICAR.txt`, `provas/` e PDF; separar por trecho; provar com `git apply --check` num índice temporário |
| Produção | só leitura, pela extensão | autorização vale para aquela ação, não para a próxima |
| Camadas/repositórios só relato (camadas_so_relato) | repositórios e pastas fora do pedido | o back deste projeto é corrigível (linha acima); o resto só relata e propõe |

## 11. Regras de código

- **Sem comentários no código** (12/08/2026); o porquê vai para o commit, a PR e o changelog.
- **Texto de UI só via dicionário:** chave nos **6 locales** + `src/shared/i18n/languages/types.ts`;
  reaproveitar chave existente é melhor que criar.
- **Componentes:** reutilizar `src/components/ui/`; ao mexer em componente compartilhado, grep dos
  usos e testar pelo menos um outro uso real.
- **Fim de linha:** o repositório é LF; o Edit e scripts no Windows já converteram arquivos inteiros.
  Conferido: `git diff --stat` igual a `git diff --ignore-cr-at-eol --stat`.
- **Typecheck:** `npx tsc --noEmit` sem subir do baseline. O build **não** pega erro de tipo
  (`ignoreBuildErrors: true`).
- **Backend:** `dotnet build` com 0 erros.
- **Changelog:** cada correção vira entrada na seção "Histórico de Mudanças" do `CLAUDE.md`.
- **API:** novo endpoint via `apiManager` + `handleApiResponse`; erro em toast com
  `error.detailsMessage || error.message`.
- **Desconfiar de `x || padrão`:** `0` é valor válido de enum (Cliente = 0) e vira o padrão.

## 12. Baselines

| Gate | Comando | Resultado | Data | Composição / ruído |
|---|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | **308 erros** | 2026-09-30 | inclui ruído de `.next/dev` (+9 com o dev server rodando); cópias em `tmp/` já inflaram para 613 — apagar antes de medir |
| Lint | `npm run lint` | **não executável** | 2026-08-06 | ESLint 8.57.1 quebra com `Converting circular structure to JSON` |
| Build do back | `dotnet build … -o <temp>` | 0 erros, 22 avisos (projeto Service) | set/2026 | |
| E2E existentes | `npx playwright test` | não medido | — | ver §15 |

## 13. i18n e feature flags

- **Locales:** `pt-BR` (padrão), `en-US`, `es-ES`, `fr-FR`, `zh-CN`, `it-IT`.
- **Dicionários:** `src/shared/i18n/languages/default-<locale>.ts` · **tipos:** `types.ts`.
  Uso no cliente: `dict?.modulo?.chave` com fallback.
- **Paridade:** blocos inteiros já faltaram em alguns locales (`reactivation` em fr/it/zh,
  `login.resetPassword` em en/es/fr/zh). Conferir pelo tipo e na tela em pelo menos en-US.
- **Armadilhas:**
  - apóstrofo em en-US/fr-FR (`don't`, `n'avez`) quebrou o arquivo — use `’`;
  - inserir chave por `sed` ancorado na chave vizinha quebrou pt-BR e it-IT (o valor estava na
    linha seguinte por quebra do prettier);
  - `tsc` **despencando** (310 → 43, 115 → 6) é erro de sintaxe interrompendo a compilação, não
    melhoria.

### 13.1 Feature flags

- **Provedor, onde ficam e como alternar:** não levantado nesta versão do exemplo. Antes de testar
  flag, enumere com o comando do modelo (§13.1) no front e no back e preencha aqui; sem como alternar
  sem afetar outras pessoas, o caso do estado alternativo fica `bloqueado` ("falta como alternar: …").

## 14. Design system

- **Tokens:** `tailwind.config.ts` (`grayscale-50…900`, `primary #5C6B7F`, ação `blue-600/700`,
  sucesso `green-500 #0DBE9B`, erro `red-500 #EB1E1E`, alerta `yellow-500 #FCBD1A`, âmbar =
  aviso/bloqueio) e `src/styles/globals.css`. Fonte Lato, base 14 px, `rounded-lg`.
- **Regras:**
  - cor é canal de **status**, nunca de tipo de dado (valor, quantidade, período em texto neutro);
  - números em tabela: `text-right tabular-nums whitespace-nowrap` + `headerClass: 'justify-end'`;
  - confirmação destrutiva vermelha (`confirmVariant="destructiveprimary"`);
  - toast sempre no canto superior direito, inclusive com modal aberto;
  - um primário por rodapé; Cancelar não tem peso de ação.
- **Vitrine:** `/componentes` — referência visual, **nunca validação**.
- **Tailwind `important: true`:** estilo inline sem `!important` não pega (já deu falso negativo de
  responsivo).
- **"Cara de feito por IA" a apontar:** ícone colorido em todo título, subtítulo que repete o
  título, rótulo sobre rótulo, toast genérico, frase redundante em modal, vários primários lado a
  lado. Sugestões só dentro deste design system.

## 15. Testes automatizados existentes

| Tipo | Ferramenta | Como rodar | Estado |
|---|---|---|---|
| E2E | Playwright (`playwright.config.ts`, `.env.test`, `E2E_BASE_URL`) | `npx playwright test` | `tests-e2e/`: login, novo-parceiro, parceiros (tier1/distribuidor), criar-oportunidades tier1/tier2, executive, contrato-item-expirado. `auth.setup.ts` faz login automático — não é caminho para mim (senha) |
| Unit | — | — | não há |

## 16. Registro e entrega

- **Rodadas:** no vault. Fluxo do tier 1 em
  `fluxo-completo-parceiro-tier1-do-zero/localhost/NN-<fase>/` — nota `NN-<fase>.md` com frontmatter
  (`name`, `description`, `metadata.type: project`, `modified` vindo de `date`), prints em
  `imagens/NN-o-que-mostra[-ANTES|-CORRIGIDO|-RETESTE][-circulado].jpg` embutidos com
  `![[imagens/…]]`, e o `00-INDEX.md` da pasta atualizado. O `cobertura.json` da skill fica na pasta
  da rodada.
- **Catálogo para replay (browser-use):** `qa-catalogo/telas/<tela>/fluxos/<fluxo>/` com `TESTE.md`,
  `passos.yaml` e `prints/NN.png` + `NN.md` (invariante: nº de `.png` = nº de `.md`).
- **Memória:** diário do dia `diario/AAAA-MM-DD.md` (percurso inteiro, inclusive o que falhou e os
  arrependimentos) + nós destilados. **Em toda resposta, dizer em uma linha o que foi para a
  memória.**
- **Changelog do `CLAUDE.md`** a cada correção de código.
- **PDF para o time (Augusto):** cada item em 4 partes — **antes** (o erro + print circulado) · **por
  que mudou no código** (arquivo + causa) · **depois** (print) · **status**. Decisão do time sem
  código entra com a fala, a data e o grupo. Gerado por HTML → Chrome headless (`CLAUDE.md` §12, sem
  a extensão `nl2br`).
- **Comunicação com o time:**
  - mensagem para enviar vai em **um bloco copiável por mensagem**, no jeito que eles escrevem
    (`CLAUDE.md` §10.4), com a ressalva do que não foi testado no fim;
  - dúvida técnica/QA vai no grupo **Affinitas frontend**, com print (o "PRM - Dev" é executivo);
  - antes de mandar achado, pergunte o que a pessoa faria de errado se acreditasse nele;
  - quando a dúvida depende de "onde na tela", mande o print junto (45 min de texto × 1 min de
    imagem, 10/09);
  - todo código de registro vai com o ambiente.
- **Chaves do `mensagens.py`** (o estilo de `CLAUDE.md` §10.4, aprovado pelo usuário em 27/08/2026):
  - estilo_mensagens: whatsapp
  - mensagens_canal_tecnico: grupo Affinitas frontend, com print
  - mensagens_canal_negocio: quem decide a regra, no grupo frontend com print
  - mensagens_canal_proibido: PRM - Dev (grupo executivo)
  - mensagens_minusculas: sim
  - mensagens_pontuacao_final: nao
  - mensagens_linhas_por_mensagem: 3
  - mensagens_dizer_nao_commitado: sim
  - mensagens_codigo: nao
- **Mapa do projeto:** `.qa/MAPA.md` (fase 2 da skill); **destino das PRs:** `develop`.

## 17. Armadilhas conhecidas — lista viva do projeto

### Ferramenta

- **Campo mostra o valor e o estado do React fica vazio** — `form_input` da extensão escreve no DOM
  sem passar pelo `onChange`; use clique pelo `ref` + `type`. `datetime-local`: setter nativo +
  `dispatchEvent('input')`. Input de moeda: `triple_click` no `ref` + `type`. (29/09, 02/09)
- **Clique por coordenada erra o alvo** — escala ~1,36 entre o frame do clique (1568) e o
  `innerWidth` (2133); prefira `ref` do `find`; se usar coordenada, screenshot e clique no mesmo
  lote. (10/09)
- **Aba nova congelada** — `tabs_create_mcp` nasce em segundo plano (`visibilityState === 'hidden'`);
  abra link público (BANT, lead) na aba visível e volte depois. (29/09)
- **Elemento "duplicado" ou clique sem efeito** — a página monta uma cópia oculta (`display:none`) e a
  barra de etapas tem 12 botões no DOM para 3 visíveis; filtre `getBoundingClientRect().width > 0` +
  `elementFromPoint`. (09–10/09)
- **Segundo toast perdido** — o `ToastContext` guarda **um** toast e reaproveita o nó; observe com
  `{childList: true, subtree: true, characterData: true}` e tire o print em até ~2 s. (30/09)
- **Duplicata falsa de requisição** — espião instalado duas vezes; confirme no banco. O espião some a
  cada navegação. (29/09)
- **Select que não seleciona** — o listbox do headless UI não usa `<li>`; use
  `select-<sfiId>-button` e `select-<sfiId>-option-<rótulo>`. Chips checam `isTrusted`. Rádio do
  formulário público: `<input>` escondido atrás de `<button>` — clique no botão pelo `ref`. (10/09,
  02/09)
- **Clique engolido logo depois de escolher no select** — o dropdown fechado fica no DOM por 1,5–6 s
  com `z-index 9999`. (10/09)
- **Responsivo que "passa" sempre** — `resize_window` não muda o `innerWidth` nesta máquina e o
  `important: true` anula `style.width`; use `browser_resize` do Playwright e confira `innerWidth` e
  `matchMedia`. (09–10/09)
- **Validação "não apareceu"** — a mensagem inline não é toast nem modal; depois de todo clique de
  ação, procure `[class*=text-red]` visível e tire screenshot. (02/09)
- **Matriz de permissões travando** — em aba de segundo plano, ~30 s por tecla na busca; digite e
  espere. (29/09)

### Ambiente e dados

- **`witty-stone` é PRODUÇÃO.** (29/09)
- **Mesma porta 7112 para quatro bancos**; sem `ASPNETCORE_ENVIRONMENT`, produção. (29/09)
- **`.env.local` ignorado** (UTF-16); o runtime decide — meça na rede. (10/09)
- **"Erro inesperado" logo depois de reiniciar a API** — recarregue antes de concluir. (29/09)
- **Horário 3 h adiantado/atrasado na aba Atividades** — a entidade grava `DateTime.Now` e a Timeline
  assume UTC; efeito do ambiente local, não bug de produção. (29/09)
- **Códigos colidem entre ambientes** (OPO/CON/CLI/PAR) — diga sempre o ambiente junto. (10/09)
- **Permissão alterada "não funcionou"** — só vale depois de sair e entrar. (29/09)
- **Consulta de CNPJ lenta e com fantasia `********`** — 7–10 s (Sintegra → BrasilAPI). (29/09)
- **Bloqueio por tier é só no front** — teste na tela e registre que a requisição direta não é barrada.
- **Status HTTP mente** — `BadRequestResponse` devolve **401** (66 pontos da API; o front tratava como
  sessão expirada); `ItemNotFound()` devolve **200 com `data: []`**. (09/09)
- **A tela do formulário não é fonte de verdade para situação fechada** — ganha abre como "Dados do
  pedido"; confira na API ou na listagem. (02/09)
- **"Salvar" sem alterar nada grava** — apagou o endereço de um cliente em produção. (20/08)
- **Regra que "sumiu" pode ter sido removida de propósito** — "Promover para POC" sem data foi
  decisão confirmada; rode `git log -S` antes de chamar de regressão. (10/09)
- **Estados difíceis de alcançar** — o NOVO de oportunidade só nasce pela conversão de Lead; a
  PERDIDA "pura" exige dois respondentes distintos. (09/09)

### Tempo e desempenho

- **`POST` de oportunidade leva 50–131 s** (notificações em série dentro da requisição); ganhar
  ~148 s; criar pedido ~2min30s (insert em 9 s). Espere a resposta, confira no banco e **nunca
  clique de novo**.
- **`GET /contrato` sem paginação** — 48–73 s, às vezes pendura.
- **Concluir "não aconteceu" cedo demais** — já se esperou 60 s por um evento que saiu aos 123 s.
  Espere mais que o tempo do evento antes de concluir ausência. (10/09)

### Código e gates

- **Diff gigante sem mudança real** — Edit e scripts no Windows trocam LF ↔ CRLF; compare os dois
  `--stat`. (03/09, 10/09)
- **`git add -u` num índice novo acusa ~637 arquivos** — fim de linha; compare com `git hash-object`
  só os arquivos do diff. (30/09)
- **`tsc` contando cópias de `tmp/`** — apague a pasta antes de medir. (30/09)
- **Correção feita pela metade** — `renderFieldValue` era copiada em quatro telas; corrigir uma
  deixou as outras. Grep do nome e de um trecho antes de dizer que está corrigido. (14/09)
- **A mesma regra com o mesmo valor errado em dois lugares** (`MINIMO_LICENCAS_MENSAL` e
  `QTD_MINIMA_MENSAL`). (10/09)
- **"Corrigido" no changelog e ausente no código** — a PR #1168 foi revertida; confira na branch.
- **Prop de componente descartada em silêncio** — `getColumnsFromModel` reconstrói colunas por lista
  branca e jogava fora o `headerClass` em 60 telas. (05/08)

## 18. Checklists por módulo

### Parceiro (`/novo-parceiro` + ativação `/parceiros/{id}`)
- CNPJ: vazio, inválido, duplicado; consulta no blur; fantasia `********`; país.
- Responsável: obrigatórios, e-mail inválido, um responsável só, CPF, perfil, tipo de contato.
- Ativação: nível (confirmar; tooltip do botão bloqueado), Documentos → Contratação → Liberar
  Ambiente UEM → Resumo; cabeçalho e etapas sem F5; e-mail de primeiro acesso (auditoria).
- Permissões: perfis clonados (ADM N etc.), modal "Ver permissões".

### Login / senha
- Primeiro acesso (senha provisória → `/first-password` → 2FA opcional).
- "Esqueci minha senha": "Enviando…", confirmação neutra, reenviar em 60 s, erro real; e-mail
  inexistente devolve 200.

### Cliente (`/clientes`)
- Listagem: vazia, busca por razão/fantasia/CNPJ/contato, "Mostrar aprovados", menu ⋮
  (Editar/Deletar/Desabilitar), isolamento entre parceiros.
- Novo: CNPJ vazio/inválido/de outro parceiro (422)/real novo; dados da Receita; responsável;
  contatos; campos complementares; Salvar conferido no banco.
- Edição: cabeçalho e KPIs, etiquetas, menu Ações, abas Contratos/Oportunidades/Uso/Follow-up/
  Atividades; endereço preservado depois do Salvar.

### Follow-up (em qualquer entidade)
- Criar (título obrigatório, vencimento, prioridade, tipo), `entityType` correto, KPI do cabeçalho
  sem F5, cor do vencimento (vermelho só se atrasado), editar, concluir (só criador ou admin),
  excluir.

### Oportunidade (`/oportunidades`)
- Listagem: 9 cards, busca, filtro por status, avisos (desconto pendente só do próprio parceiro).
- Nova: parceiro, tipo, categoria, cliente, distribuidor, origem, probabilidade; produtos (mínimo
  **51** no mensal, venda > custo, custo travado para parceiro); contatos (o BANT vai para quem tem
  e-mail); devices; concorrentes; campo complementar obrigatório (aceite: "Não" passa?); notas;
  Salvar com payload e banco conferidos.
- BANT: banner "Aguardando BANT" com destinatário; Copiar link; Reenviar (o token muda); formulário
  público vazio, recusado ("Não quero preencher"), preenchido; token inválido.
- Etapas: Promover para Apresentação → Promover para POC → Iniciar POC (tier 2 não pode; vê
  "Solicitar POC") → Ganhar (gera contrato) / Skip POC e Ganhar / Perder (questionário) / Cancelar
  (motivo). Conferir contrato gerado e notificações.
- Desconto: solicitar (questionário); só Urmobo aprova; aba Descontos.

### Contrato (`/contratos`) e pedidos
- Detalhes; números (contratado / comprometido / em uso, **sem** itens cancelados); Novo Pedido;
  cancelamento; Aditar (cada operação disponível ao perfil); abas; Rescindir; Exportar Excel.

## 19. Rodadas anteriores

| Data | Alvo | Pasta | Gate | Resumo |
|---|---|---|---|---|
| 2026-09-10 | Oportunidade, as 9 etapas (dev) | changelog do `CLAUDE.md` | — (antes da skill) | 7 etapas provadas, 2 impossíveis pela tela; 2 retratações |
| 2026-09-29 | Fases 5–6 do tier 1: cliente e oportunidade (localhost) | vault `…/localhost/05-*`, `06-*` | — | 78 prints `-ANTES`/`-CORRIGIDO`; 4 oportunidades, uma por caminho |
| 2026-09-29 | Fase 7: contrato (tier 1 + aprovador em duas abas) | vault `…/localhost/07-contrato/` | — | 35 prints; CON0000000864 e CON0000000865 (dev) |
| 2026-09-30 | Retestes do contrato depois do pull do time | vault `…/07-contrato/retestes-30-09/` | — | R01–R23; 14 correções de tela |
| 2026-09-30 | Separação do trabalho em 13 blocos-branch | `E:\urmob\entregas-por-branch\` | — | 292 trechos de front e 12 de back, cada um em um bloco só |
