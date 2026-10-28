# Cowork do Claude × Cowork do Openclod

Estudo de 2026-10-27. Pergunta do usuário: qual é a principal função do Cowork do Claude e se o nosso também funciona.

- **Fontes oficiais** lidas no dia (URLs na seção 2). Estão parafraseadas, com a seção de cada página que sustenta a conclusão.
- **Testes** no app Electron real, pela tela real (Início → Chat/Cowork → pasta → tarefa), com modelo real (DeepSeek `deepseek-flash`; só a chave vem do perfil do usuário, o resto é um perfil descartável). Roteiro: [`scripts/ui-cowork.cjs`](../scripts/ui-cowork.cjs). Provas: `Prints/cowork-2026-10-27/`.
- O app Claude Desktop **não foi controlado** (não pedi acesso à tela); a referência visual são as capturas já existentes em `PrintClaude/` (`102`, `111`, `112`, `113`, `114`).

## 1. Resumo

**Função principal do Cowork (Claude):** entregar trabalho de conhecimento de ponta a ponta. O usuário descreve um **resultado** (não um passo) e dá acesso a uma pasta e a ferramentas; o Claude faz um plano, executa em várias etapas (com subagentes em paralelo), mostra o andamento, pede permissão nas ações sensíveis (apagar sempre exige) e devolve **arquivos prontos** (documento, planilha com fórmulas, apresentação) para o usuário revisar, inclusive enquanto ele faz outra coisa ou sai.

**Veredito para o Openclod:** o núcleo funciona, com modelo real e na interface real. Delegar uma tarefa de várias etapas numa pasta, plano e andamento visíveis, aprovação antes de mudar muitos arquivos, entrega real de `.docx`, `.xlsx` (fórmulas calculando certo) e `.pptx`, redirecionar no meio, fila, duas tarefas ao mesmo tempo, retomar numa sessão nova depois de fechar o app, conector real, skill, navegador e tarefa agendada passaram. O que **não** existe ou é mais fraco que o do Claude: isolamento (VM/nuvem), trabalho que continua com o computador desligado, celular/Dispatch, permissão por aplicativo no Computer Use, instruções globais, prévia dos arquivos entregues e ferramenta própria para criar documentos do Office (o modelo escreve scripts Python).

**Corrigi, com teste:** (1) apagar arquivos pelo shell (`del`, `Remove-Item`, `rm`, Python…) não pedia aprovação no modo automático; (2) o plano ficava marcado "em andamento" depois que o limite de iterações encerrava o turno; (3) o prompt do Cowork deixava lixo na pasta do usuário, mandava "olhar a tela" e instalava pacotes sem perguntar (ver seção 7).

**Depois, a seu pedido (R1 e R2):** (4) a tarefa agendada passou a ter um tipo, **Cowork** ou Code, escolhido no formulário de Agendados (nova tarefa em branco começa em Cowork; tarefas antigas continuam Code); (5) lembrete de plano: depois de 12 iterações sem `update_plan` com passos em aberto, o agente recebe um aviso oculto (no máximo 4 por turno, só na sessão do usuário); (6) ao bater no limite de iterações, o app mostra o cartão "Continuar de onde parou", como já fazia nos limites de tokens e de custo. O limite continua 60 (Configurações › Limites); preferi o botão a subir o número em silêncio (seção 7).

**Não deu para fechar:** a conta do DeepSeek acabou (**HTTP 402, "Insufficient Balance"**) no fim da rodada. Por isso a repetição, com o modelo real, das correções (organizar → apagar) e o teste do Modo equipe (subagentes em paralelo) ficaram incompletos. A proteção contra exclusão foi provada no laço real do agente com o shell real (modelo roteirizado de teste unitário).

## 2. O que o Cowork é, segundo a Anthropic

| # | Conclusão | Fonte (página › seção) |
|---|---|---|
| F1 | É a arquitetura agêntica do Claude Code sem terminal, para trabalho que não é código. O usuário descreve o resultado, se afasta e volta para o trabalho pronto (documentos formatados, arquivos organizados, pesquisa sintetizada). | [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190) › *What is Claude Cowork?* · [página do produto](https://claude.com/product/cowork) › cabeçalho |
| F2 | Origem (12/jan/2026, prévia de pesquisa no macOS): você dá acesso a **uma pasta**; o Claude lê, edita e cria arquivos nela. Faz um plano, completa e mantém você informado. Dá para **enfileirar tarefas** e ele as trabalha em paralelo, mais parecido com deixar recados para um colega do que com um vai e vem de conversa. | [Lançamento](https://claude.com/blog/cowork-research-preview) (hoje redireciona para a página do produto; cópia: [web.archive.org](https://web.archive.org/web/20260113103028/https://website.claude.com/blog/cowork-research-preview)) |
| F3 | Como roda: analisa o pedido e cria um plano, divide em subtarefas, executa código e comandos num ambiente isolado, coordena trabalhos em paralelo e entrega saídas que você pré-visualiza e baixa. Você vê o que ele planeja e faz e pode redirecionar. | Get started › *How Claude Cowork runs your tasks* e *What to expect during a task* |
| F4 | Entregas profissionais: planilhas Excel com fórmulas de verdade, apresentações PowerPoint e documentos formatados; tarefas longas sem estouro de tempo ou de contexto. | Get started › *Key capabilities* |
| F5 | Controle: o usuário escolhe pastas e conectores (o Claude não toca no que não foi concedido) e ele **pede permissão antes de apagar arquivos de forma permanente, em qualquer modo**. | Get started › *What to expect during a task* · [Use Claude Cowork safely](https://support.claude.com/en/articles/13364135) › *Our safety measures* e *Protect yourself…* |
| F6 | Três modos de aprovação: **Manual** (pergunta cada ação), **Auto** (segue sozinho, mas uma revisão de segurança avalia cada ação e bloqueia a suspeita) e **Skip** (sem nenhuma checagem). | Get started › *Choose how Claude checks with you* |
| F7 | Instruções globais (todas as sessões) e **instruções da pasta**; plugins agrupam skills, conectores e subagentes; projetos têm instruções, arquivos, memória e tarefas agendadas próprios. | Get started › *Add global and folder instructions*, *Claude Cowork plugins* · [Projetos](https://support.claude.com/en/articles/14116274) · [Plugins](https://support.claude.com/en/articles/13837440) |
| F8 | Tarefas agendadas (`/schedule` ou página "Agendados"): rodam em cadência, cada execução é uma sessão Cowork; hoje rodam na nuvem, sem o computador ligado. | [Schedule recurring tasks](https://support.claude.com/en/articles/13854387) |
| F9 | Navegador embutido (não usa o Chrome do usuário) e Computer Use (beta). No Computer Use o Claude **pede permissão para cada aplicativo** antes de acessá-lo, tira capturas de tela e evita ações de risco. | Get started › *Key capabilities* · [Computer use](https://support.claude.com/en/articles/14128542) › *Permissions and access* |
| F10 | Onde roda: desde 6/out/2026, no Pro e no Max, em **sandbox temporário na nuvem**; o computador só é alcançado pelo app Desktop, para as pastas conectadas. Sessões locais antigas usavam um agente nativo mais uma **VM** (Hyper-V/Apple Virtualization) para o código. | [Surfaces](https://support.claude.com/en/articles/15520349) › *What changed… October 6* · [Arquitetura](https://support.claude.com/en/articles/14479288) › *Cloud/Local session architecture* |
| F11 | Dispatch: mensagens do celular viram tarefas no computador (que precisa estar ligado); está em beta limitado. | [Dispatch](https://support.claude.com/en/articles/13947068) |
| F12 | Direção do produto: chat e Cowork estão sendo fundidos numa coisa só (a página do produto anuncia que o Cowork agora faz parte do Claude); qualquer conversa pode virar tarefa. | [Cowork and chat are one Claude](https://support.claude.com/en/articles/16761823) · página do produto |

## 3. Capacidades verificáveis

C01 pasta de trabalho escolhida · C02 delegar um resultado de várias etapas · C03 plano e andamento visíveis · C04 entregar arquivos reais (docx, xlsx com fórmulas, pptx) · C05 organizar/renomear em lote com plano e aprovação antes · C06 proteção contra exclusão · C07 modos de aprovação · C08 redirecionar no meio e fila · C09 várias tarefas ao mesmo tempo · C10 subagentes em paralelo · C11 retomar de onde parou · C12 conectores · C13 skills e plugins · C14 instruções da pasta e globais · C15 navegador e Computer Use · C16 tarefas agendadas · C17 projetos · C18 prévia dos arquivos criados · C19 isolamento (VM/nuvem) · C20 continuar sem o computador / celular / Dispatch.

## 4. Resultado: capacidade × Claude × Openclod

Legenda: ✅ funciona · 🟡 funciona com limite · ❌ não funcionou no teste · ⚪ não existe · ❔ não verificado.

| Cap. | Claude Cowork | Openclod | Prova (cenário · arquivo em `Prints/cowork-2026-10-27/`) |
|---|---|---|---|
| C01 Pasta | Escolhe a pasta; só acessa o concedido (F2, F5) | 🟡 Seletor "Pasta de trabalho"/"Projeto ou pasta" na tela Cowork. **A pasta não é fronteira**: o Cowork do Openclod tem acesso total ao computador por padrão (política `fullAccess`; o prompt diz "o projeto não é uma prisão"). | `home` 5/5 · `00-cowork-inicio.png` |
| C02 Delegar resultado | Sim (F1) | ✅ Sessão `surface: cowork`, modo `autonomous`. | `organize`, `deliver`, `longtask`, `resume` |
| C03 Plano e andamento | Progresso por etapa, raciocínio visível (F3) | 🟡 Plano fixo acima do composer, cartões de ferramenta, "Plano 1/5". **O modelo atualiza pouco o plano**: na 1ª entrega chamou `update_plan` uma única vez em ~60 iterações e na 2ª o plano também terminou em "0/6", com o trabalho pronto. Corrigido depois: o plano não fica "em andamento" no limite de iterações, o agente é lembrado de atualizá-lo (R2, seção 7) e o limite oferece "Continuar de onde parou". Falta medir com modelo real se o lembrete muda o comportamento. | `c-team-01-plano.png`, `b-03-final.png`, `evidence-deliver.json` |
| C04 Arquivos reais | docx, xlsx com fórmulas, pptx (F4) | 🟡 Entrega real nas duas amostras: `.docx` (4 tabelas, resumo executivo), `.xlsx` (67 fórmulas na aba Resumo, recalculadas no LibreOffice: receita 639.377 e as 3 regiões batem com o valor esperado) e `.pptx` (5 slides com gráfico). **Não há ferramenta nem skill de documentos**: o modelo escreve Python e depende de `python-docx`, `openpyxl` e `python-pptx` no PC do usuário (na 1ª amostra instalou o `python-pptx` sozinho, sem perguntar). O Python embutido do app não tem essas bibliotecas. | `deliver` · `b-entregas/` (arquivos, PDFs e imagens das páginas) |
| C05 Organizar em lote com aprovação | Plano visível antes de agir (F2, F5) | ✅ O modelo leu os 13 arquivos, mostrou o mapa de nomes (13/13 citados), perguntou antes de mover (`ask_user`) e **não moveu nada** até a aprovação; depois moveu para 6 subpastas, nomes `AAAA-MM-DD-nome`, datas lidas do conteúdo nos 7 arquivos que têm data, 0 arquivos perdidos (conferido por hash). No modo manual, a tela mostra o cartão de aprovação de cada comando. | `organize` 12/12 (manual) e 11/12 (automático, ver C06) · `a-02-plano-proposto.png`, `a-03-depois.png`, `aprovar-manualmente/a-02-aprovacao.png` |
| C06 Proteção contra exclusão | Pede permissão em qualquer modo (F5) | ✅ após a correção; ❌ antes. `delete_path` já pedia, mas no modo **automático** um comando de shell que apaga (`del`, `Remove-Item`, Lixeira por API) rodava sem perguntar (visto no teste real: apagou a cópia sem pedir). Agora o shell que apaga é "destrutivo" e pede. No modo "Ultrarrestrito" não pede (escolha explícita do usuário, equivale ao Skip). | `organize` automático (antes): `evidence-organize.json` · testes `tests/deletion-protection.test.ts` (43) |
| C07 Modos de aprovação | Manual, Auto (com revisão de segurança), Skip (F6) | 🟡 Três modos: "Aprovar manualmente", "Aprovar automaticamente", "Ultrarrestrito". O automático **não revisa cada ação**: só pergunta nas destrutivas. Os rótulos mudam entre composer, Configurações e Cowork (BUG-12 da auditoria). A política é global, não por sessão. | `home` (trocar o modo grava a política) |
| C08 Redirecionar e fila | Redireciona no meio; enfileira (F2, F3) | ✅ Escrever durante o trabalho entra na fila ("Na fila (1)") e é entregue depois; "Enviar agora" redireciona: o agente parou de criar letras e criou `parei.txt`. | `steer` 5/5 · `i-01-redirecionando.png`; `longtask` · `c-team-03-fila.png` |
| C09 Várias tarefas / segundo plano | Várias tarefas ao mesmo tempo; na nuvem continua sem você (F2, F10) | 🟡 Uma segunda sessão Cowork na mesma pasta respondeu enquanto a primeira ainda trabalhava. **Só roda com o app aberto** (processo local). | `longtask` 13/13 |
| C10 Subagentes em paralelo | Sim (F3) | 🟡 A ferramenta `agent` existe: na tarefa longa o modelo chamou 2 revisores independentes. Dividir "um agente por concorrente" no Modo equipe: **não verificado** (cota acabou durante a execução). O Cowork não divide sozinho como o do Claude (no Openclod é opt-in: Modo equipe ou esforço Máximo). | `longtask` · `evidence-longtask.json`; `evidence-longtask-team-cota-esgotada.json` |
| C11 Retomar | Sessões seguem a conta; retoma em outro dispositivo (F10) | ✅ Interrompi no meio (1º de 3 documentos pronto), **fechei o app e abri de novo**: a sessão e o plano estavam lá. Numa **sessão nova**, "Continue de onde parou." terminou os documentos 2 e 3, não refez o 1 (hash igual) e não pediu o contexto de novo. | `resume` 9/9 · `d-01…03` |
| C12 Conectores | Sim (F7) | ✅ Conector real do diretório (Microsoft Learn): o Cowork usou a ferramenta como ferramenta de primeira classe e entregou `resumo-blob.md` com a URL real. | `connector` 7/7 · `e-01-conector.png` |
| C13 Skills e plugins | Skills, plugins (F7) | ✅ Skills: uma skill do usuário foi achada pela descrição, carregada com `use_skill` e seguida (4 seções na ordem, símbolo, selo final). 🟡 Plugins: existem no app, **não retestei** nesta rodada (há `scripts/ui-plugins.cjs`). | `skill` 6/6 · `g-01-skill.png` |
| C14 Instruções | Globais e da pasta (F7) | 🟡 **Da pasta**: ✅ `CLAUDE.md` da pasta foi seguido nos 3 arquivos entregues (texto obrigatório). **Globais**: ⚪ não existe (o app lê `CLAUDE.md`/`AGENTS.md` da pasta e de pastas acima até a raiz do repositório, nunca da pasta pessoal). Efeito colateral: o app **cria um `CLAUDE.md` na pasta escolhida** se ela não tiver. | `deliver` |
| C15 Navegador e Computer Use | Navegador embutido; Computer Use com permissão por app (F9) | 🟡 Navegador: ✅ abriu `example.com` e gravou o título e a primeira frase reais. Computer Use: existe e foi usado por conta própria pelo modelo, **sem permissão por aplicativo** (na 1ª entrega ele tirou uma captura da **tela inteira** do computador para "conferir" os arquivos). | `browser` 5/5 · `h-01-navegador.png` |
| C16 Tarefas agendadas | Roda na nuvem, cada execução é sessão Cowork (F8) | 🟡 Uma tarefa "uma vez" rodou **sozinha no horário** e "Executar agora" também; as duas gravaram o arquivo certo. Limites: só com o app aberto. No teste a execução abriu como sessão **Code**, não Cowork (7/8); **corrigido depois (R1)**: a tarefa tem um tipo Cowork/Code e o formulário de Agendados o mostra (`schedule-ui` 10/10, sem modelo). A repetição com modelo real (`schedule` com `surface: 'cowork'`) espera o saldo do DeepSeek. | `schedule` · `f-01-agendados.png`, `f-02-…`; `schedule-ui` · `k-01-nova-tarefa-cowork.png`, `k-02-lista-com-tipo.png` |
| C17 Projetos | Instruções, memória e arquivos por projeto (F7) | 🟡 Há Projetos, memória por projeto e instruções da pasta; a retomada (C11) usa a memória do projeto. Não testei criação de projeto com instruções/anexos (o "Novo projeto" só abre o seletor de pasta, ver auditoria M18). | `resume` |
| C18 Prévia dos arquivos criados | Pré-visualiza e baixa (F3) | ❌ `.md` abre no painel; `.docx`, `.xlsx`, `.pptx` e `.pdf` mostram "arquivo binário: use a ferramenta de leitura do agente". Não há "abrir com o app padrão" no painel. | `j-*.png` |
| C19 Isolamento | VM (local) ou sandbox na nuvem (F10) | ⚪ Não existe. O agente roda no processo do app, com os privilégios do usuário. Mitigações que existem: modos de aprovação, bloqueio de comandos perigosos, bloqueio de caminhos de credencial, perfis de ambiente (WSL/SSH). | código |
| C20 Sem o computador / celular / Dispatch | Nuvem continua sem você; Dispatch (F10, F11) | ⚪ Não existe. A página Dispatch avisa que o controle por celular não está disponível. | `src/renderer/src/components/MorePages.tsx` (Dispatch) |

## 5. Como testei

- **Build separado**, sem tocar no `out/` do app aberto do usuário: `npx electron-vite build --outDir <pasta>` e `node scripts/snapshot-app.cjs cowork --from <pasta>`; os scripts aceitam `--root <snapshot>`.
- **Perfil descartável** por execução (`makeWorkspace({ real: true })`): só o cofre de chaves e uma cópia das configurações vêm do perfil real (sem MCP, hooks nem autorreparo). A política do usuário é "Ultrarrestrito"; nos testes usei "automático" (padrão da tela Cowork) e, onde indicado, "manual". A partir da 2ª rodada deixei o **controle do computador desligado** no perfil de teste (ver 8).
- **Caminho do usuário**: Início → botão "Cowork" do composer → seletor de pasta → texto no composer → Enter; aprovações e perguntas são respondidas como um usuário (o roteiro lê o estado real da sessão).
- **As checagens leem o resultado**, não o que o modelo diz: a pasta (hash de cada arquivo), os `.docx/.xlsx/.pptx` abertos como zip (texto, tabelas, fórmulas), o LibreOffice (converte para PDF; o roteiro renderiza páginas em PNG; as fórmulas do `.xlsx` são recalculadas e comparadas ao valor calculado pelo próprio roteiro), a sessão (ferramentas chamadas, plano, aprovações).
- **Modelos**: sempre o real (`deepseek-flash`, o padrão). Nenhum dublê na aplicação.

Reproduzir:

```powershell
npx electron-vite build --outDir "$env:TEMP\cowork-build"
node scripts/snapshot-app.cjs cowork --from "$env:TEMP\cowork-build"      # imprime a pasta do snapshot
node scripts/ui-cowork.cjs --scenario <cenário> --root <snapshot> --port 9470 [--permission auto|ask] [--team] [--out <pasta>]
# cenários: home organize deliver longtask resume skill connector schedule schedule-ui iteration-cap browser steer preview
```

**Rodar com modelos do OpenRouter** (pedido do usuário, depois que o saldo do DeepSeek acabou). Pré-requisito: a chave do OpenRouter salva por você no app (Configurações › Provedores › OpenRouter › Salvar chave e depois Salvar alterações). O roteiro só pega uma **cópia** do cofre; ninguém digita nem grava chave. Em 2026-10-27 a chave **não estava** no perfil (a variável `OPENROUTER_API_KEY` não existe em nenhum escopo e o app marca `openrouter: configured: false`), então nenhum modelo do OpenRouter respondeu ainda.

```powershell
node scripts/ui-cowork.cjs --scenario schedule --provider openrouter --model deepseek/deepseek-v4-flash --root <snapshot> --port 9470 --out Prints/cowork-2026-10-27/openrouter
# a mesma linha para: organize, longtask --team, deliver, iteration-cap
# conferência cruzada com outra família: --model qwen/qwen3-coder
```

Com `--provider` e `--model` o perfil de teste começa nesse provedor e modelo, a reserva entre provedores fica desligada e uma checagem (`so-o-modelo-pedido-respondeu`) falha se qualquer resposta vier de outro modelo, para a execução não migrar em silêncio para um modelo mais fraco. Modelos escolhidos (catálogo público do OpenRouter, USD por 1 M de tokens, entrada/saída; ferramentas: sim): `deepseek/deepseek-v4-flash` 0,045/0,45, contexto 1 M, mesma família das execuções com DeepSeek; `qwen/qwen3-coder` 0,30/1,00, contexto 262 k, outra família. Uma execução pesada (`deliver`, ~2,5 M tokens de entrada) fica em torno de US$ 0,13 no primeiro e de US$ 0,8 no segundo, sem desconto de cache.

## 6. Provas por cenário

| Cenário | Resultado | Tempo | O que mostra |
|---|---|---|---|
| `home` | 5/5 | 2 s | Tela Cowork, pasta escolhida, 3 modos de aprovação, 4 sugestões; trocar o modo grava a política. |
| `organize` automático (antes das correções) | 11/12 | 149 s | Plano e pergunta antes de mover; nada movido sem aprovação; 13 arquivos organizados sem perda. **Falhou**: apagou a cópia duplicada (para a Lixeira, por API do Windows) **sem pedir permissão**. |
| `organize --permission ask` | 12/12 | 143 s | Mesmo fluxo; cartões de aprovação na tela; `delete_path` pediu aprovação. |
| `deliver` (amostra 1) | 24/27 | 416 s | Os 3 arquivos corretos. As 3 falhas eram do meu roteiro (leitura da contagem de páginas). O modelo bateu no **limite de 60 iterações** com um ajuste de paginação pendente, deixou ~40 arquivos auxiliares na pasta, instalou o `python-pptx` e tirou uma captura da tela inteira. Custo ~US$ 0,12 (2,5 M tokens de entrada, 93% em cache). |
| `deliver` (amostra 2, controle do computador desligado) | 26/27 | 301 s | Os 3 arquivos corretos e abrem no LibreOffice (3, 2 e 5 páginas); auxiliares só em `_build`. A única falha é o HTTP 402 no último passo, depois de tudo entregue. |
| `longtask` | 13/13 | 416 s | Plano de 5 passos todos concluídos, 2 subagentes revisores, `comparativo.md` com os 6 concorrentes e a recomendação, mensagem da fila entregue, segunda sessão respondeu com a primeira ocupada. ~US$ 0,07. |
| `longtask --team` | inconclusivo | 281 s | O plano previa "6 agentes em paralelo", mas a cota (402) acabou e a transcrição não pôde ser lida. A captura final mostra a tela de **Conectores** com o painel do GitHub aberto; não sei explicar. |
| `resume` | 9/9 | 383 s | Ver C11. |
| `skill` | 6/6 | 61 s | Ver C13. |
| `connector` | 7/7 | 26 s | Ver C12. |
| `schedule` | 7/8 | 71 s | Ver C16. |
| `schedule-ui` (sem modelo, depois do R1) | 10/10 | 6 s | O formulário oferece Cowork/Code, começa em Cowork, salva, mostra o tipo na lista, o modelo "Organizar os arquivos novos da pasta" abre como Cowork e "Rodar os testes" como Code, editar troca o tipo, tarefa antiga sem tipo continua sem tipo. |
| `browser` | 5/5 | 20 s | Ver C15. |
| `steer` | 5/5 | 39 s | Ver C08. |
| `preview` (sem modelo) | ver C18 | — | Abrindo **três binários em sequência**, a janela do app fechou nas duas tentativas do roteiro; **isolado, cada arquivo abre** (com a mensagem de binário) e uma sessão com log do Electron não reproduziu. Provavelmente contenção de recursos (várias instâncias + o modelo de voz carregando na GPU), mas não investiguei. |

Verificações do projeto, rodadas no fim com todas as alterações (inclusive R1 e R2, e os testes de outras frentes que estavam na árvore): `npx vitest run` com 130 arquivos e 1846 testes passando, 1 ignorado; `npm run typecheck` sem erros.

## 7. O que corrigi (pequeno, com teste)

1. **Proteção contra exclusão no shell** (C06). [`src/core/security/deletion.ts`](../src/core/security/deletion.ts) reconhece `del`, `erase`, `rd`, `rmdir`, `rm`, `Remove-Item`, `git clean`, `shutil.rmtree`, `os.remove`, `fs.rmSync`, `[IO.File]::Delete`, Lixeira (`SendToRecycleBin`, `InvokeVerb('delete')`), `send2trash`, `robocopy /MIR`. [`src/core/tools/shell.ts`](../src/core/tools/shell.ts) usa `resolveCall` em `run_command` e `start_process` para tratar esses comandos como `destructive`; o modo automático pergunta, como já fazia com `delete_path`. Comandos comuns (`move`, `copy`, `ren`, `npm test`, `dir`, `type form.txt`) continuam sem pergunta. Heurística no texto do comando: um script que apaga escondido num arquivo não é visto. Testes: [`tests/deletion-protection.test.ts`](../tests/deletion-protection.test.ts) (43, incluindo o laço real do agente com o shell real: recusar mantém o arquivo, aprovar apaga).
2. **Plano parado depois do limite de iterações** (C03). `runner.ts` marcava o passo ativo como bloqueado só quando o aviso do plano se esgotava; ao terminar por limite de iterações o passo seguia "em andamento". Agora os dois caminhos usam `blockActivePlanItems()`. Teste: [`tests/plan-iteration-limit.test.ts`](../tests/plan-iteration-limit.test.ts) (falha sem a correção: `['active','pending']`).
3. **Regras do Cowork no prompt** (`context.ts`, seção "Superfície Cowork"), saídas das execuções reais: manter a pasta do usuário só com as entregas (auxiliares em `%TEMP%` ou apagados); conferir o que gerou convertendo/lendo o arquivo, sem capturar a tela inteira; pedir aprovação antes de instalar pacotes no computador; atualizar o plano a cada passo concluído. Teste: [`tests/cowork-prompt.test.ts`](../tests/cowork-prompt.test.ts). É orientação ao modelo, não garantia: **não repeti o E2E depois disso** (cota).

Arquivos novos de apoio: `scripts/ui-cowork.cjs`, `scripts/lib/cowork-fixtures.cjs`, `scripts/lib/office-check.cjs`.

**Implementado depois, a seu pedido (R1 e R2):**

4. **Tarefa agendada como sessão Cowork (R1, C16).** A tarefa ganhou o campo `surface` (`cowork` ou `code`; ausente = `code`, como as tarefas de antes). Núcleo: [`src/core/scheduler/types.ts`](../src/core/scheduler/types.ts), [`scheduler.ts`](../src/core/scheduler/scheduler.ts) (validação, edição, `null` limpa, persistência) e [`session.ts`](../src/core/scheduler/session.ts) (`scheduledSession`: Cowork abre em modo `autonomous`, salvo modo explícito). Ligação: `src/shared/api.ts`, `src/main/index.ts` (`toTaskInput` e `runScheduledTask` abrem a sessão no tipo da tarefa). Tela: `ScheduledPage.tsx` ganhou o seletor "Tipo de sessão" (tarefa em branco começa em Cowork, modelos de código em Code), o tipo aparece na lista, e há dois modelos novos de Cowork (organizar os arquivos novos da pasta; resumo semanal da pasta). Testes: [`tests/scheduler-surface.test.ts`](../tests/scheduler-surface.test.ts) (9) e o E2E `schedule-ui` (10/10, sem modelo). Pendente: repetir `schedule` com modelo real (a sessão agendada deve abrir como Cowork).
5. **Lembrete de plano (R2, C03).** [`runner.ts`](../src/core/agent/runner.ts) (`remindAboutPlan`): a cada 12 iterações sem `update_plan`, com passos `pending`/`active`, uma mensagem oculta `<plan-reminder>` lista os passos abertos e pede para marcar o que terminou (no máximo 4 por turno; só na sessão do usuário, não em subagentes; não na última iteração). Testes: [`tests/plan-reminder.test.ts`](../tests/plan-reminder.test.ts) (9; sem o recurso, os 3 testes do lembrete e do cartão falham).
6. **"Continuar de onde parou" no limite de iterações (R2).** Ao terminar por limite de iterações, o runner emite o mesmo evento `budget` dos limites de tokens e de custo, com `kind: 'iterations'` (só na sessão do usuário). O cartão (`BudgetDock.tsx`, texto em `src/renderer/src/lib/budget.ts`) diz "Limite de iterações do turno atingido, 60 de 60 iterações" e o botão envia "continuar de onde parou"; o log de Atividades e a Revisão de melhorias passam a rotular o tipo (`src/shared/budget.ts`). Testes: [`tests/budget-view.test.ts`](../tests/budget-view.test.ts) e o evento em `tests/plan-reminder.test.ts`. **Não subi o limite (60):** é o valor de Configurações › Limites e subir em silêncio aumenta custo e tempo sem o usuário ver; o botão deixa a continuação por conta dele. O cartão não foi exercitado com modelo real (cota), só pelos testes e pelo build.

## 8. Efeitos colaterais dos testes nesta máquina (para você saber)

- A 1ª amostra de `deliver` executou **`pip install python-pptx`** no Python do usuário (`...\Python310\Lib\site-packages`, com `XlsxWriter`, `lxml`, `Pillow`). Foi o modelo, no modo automático, sem pergunta; a regra nova do prompt tenta evitar isso.
- Na mesma amostra o modelo tirou uma **captura da tela inteira** (por `computer_screenshot`), que foi para o provedor com o que estivesse aberto. Apaguei do `Prints/` as duas capturas do teste que a mostravam e desliguei o controle do computador nas execuções seguintes.
- Os testes abriram arquivos no app padrão e geraram PDFs pelo LibreOffice em pastas temporárias. Nada foi alterado no app aberto do usuário.
- Ao iniciar, o app remove o atalho antigo `Electron.lnk` do Menu Iniciar (aparece no log como `[shortcut] atalho legado removido…`). É comportamento do app, mas aconteceu durante os testes.
- A conta do DeepSeek ficou sem saldo durante a rodada (402). Não dá para saber se foram os testes (as execuções registraram ~US$ 0,05 a 0,12 cada) ou outro uso.

## 9. O que não dá para igualar

- **Isolamento em VM ou nuvem** (F10): o Openclod roda no PC do usuário, no mesmo processo e com os mesmos privilégios. Dá para reduzir risco (pasta como fronteira, perfis WSL/SSH, aprovação por padrão), não para equivaler.
- **Continuar com o computador desligado, tarefas agendadas na nuvem, celular e Dispatch** (F8, F10, F11): exigem um serviço na nuvem.
- **Revisão de segurança por ação no "Auto"** e os classificadores de injeção de comando do servidor (F6): o app tem heurística (`scanForInjection`) e bloqueio de comandos, mas não um revisor de cada ação.
- **Skills de documentos e ambiente pronto da Anthropic** (F4): dá para aproximar (R3), não para copiar.
- Controles de organização (Team/Enterprise, OpenTelemetry, API de conformidade).

## 10. Recomendações (peço decisão antes de implementar)

| # | Recomendação | Tamanho | Por quê |
|---|---|---|---|
| R1 | ✅ **Feito (seção 7, item 4).** Tarefa agendada como sessão Cowork: campo `surface`, modo `autonomous` e o prompt da superfície. | pequeno/médio | Abria como Code, sem as regras do Cowork (C16). |
| R2 | ✅ **Feito (seção 7, itens 5 e 6).** Lembrete de plano e cartão "Continuar de onde parou" no limite de iterações (o limite de 60 ficou como está). | pequeno | Nas duas entregas o plano ficou parado; uma bateu em 60 iterações. |
| R3 | **Documentos de verdade**: embutir `python-docx`, `openpyxl` e `python-pptx` no Python do app (ou ferramenta `document_create`/skills de docx, xlsx, pptx) e checar antes de começar. | médio/grande | Hoje depende do PC do usuário e instala por conta própria (C04). **Feito em 27/out/2026** (sem commit): bibliotecas no Python embutido, `run_command` acha esse Python, skills `docx`/`xlsx`/`pptx` com receitas testadas e checagem antes de começar; a ferramenta `document_create` foi avaliada e não criada. Detalhes, provas e limites em [`COWORK-DOCUMENTOS.md`](COWORK-DOCUMENTOS.md). |
| R4 | **Permissão por aplicativo no Computer Use**: perguntar antes da primeira captura da tela inteira de cada sessão e listar os apps liberados. | médio | O Claude pede por app (F9); aqui o modelo capturou a tela toda sozinho (C15). |
| R5 | **Prévia dos arquivos entregues** no painel Arquivos (docx/xlsx/pptx/pdf via LibreOffice ou `document_extract`) e "Abrir com o app padrão". | médio | C18. |
| R6 | **Instruções globais** (configuração aplicada a toda sessão). | pequeno/médio | C14. |
| R7 | **Pasta como fronteira por padrão no Cowork** (com opção "acesso total") e não criar `CLAUDE.md` na pasta sem avisar. | pequeno/médio | Alinha com F5 e evita arquivo inesperado na pasta do usuário. |
| R8 | Controles sem ação na tela Cowork (ícone de informação, "Cowork em prévia", "Limpar ativo"): itens M12 a M14 de `docs/audit/telas-vs-claude-desktop.md`. | pequeno | Já estavam na auditoria. |
| R9 | **Recarregar o saldo do DeepSeek** (HTTP 402) e repetir `organize` (automático) e `longtask --team` no build novo. | — | Fechar o que ficou sem prova. |

## 11. Limites deste estudo

Um modelo (`deepseek-flash`) e uma amostra por cenário (duas em `deliver`); o comportamento do modelo varia entre execuções. As checagens são minhas. O Modo equipe e a repetição pós-correção ficaram sem prova por causa da cota. Não controlei o app Claude Desktop; as páginas oficiais mudam depressa (o Cowork está sendo fundido ao chat).
