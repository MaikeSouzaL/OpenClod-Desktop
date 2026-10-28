# Provedores, reserva automática e relé de visão

Relatório de 2026-10-27. Pedido do usuário (com a captura de Configurações → Provedores com o OpenRouter):

1. "adicionei mais um provedor e salvei ele, já vai estar disponível para selecionarmos?"
2. "sempre que uma llm acabar os tokens ele deve pular automaticamente para outra llm que está funcionando"
3. "se ele mudar o llm deve mudar ali no input tb" (o seletor de modelo do compositor)
4. "sempre que o harness precisar de usar llm que precisa de ver imagens ele deve usar uma llm que lê imagens para descrever as imagens"

Tudo foi verificado com o app de verdade (Electron, perfil descartável com cópia do cofre) e com modelo real. Nada foi gravado
no perfil nem no app abertos do usuário; nenhum commit foi feito.

> Depois deste relatório entrou o provedor **Google Colab (GPU)** (um LLM com visão numa GPU do Colab, ligado por um código de
> conexão): ele usa esta mesma reserva e o mesmo relé de visão, e uma sondagem própria para pular um Colab caído sem gastar um
> pedido. Veja [`COLAB.md`](COLAB.md).

## Resumo

| Pergunta | Resposta |
|---|---|
| O provedor novo aparece para selecionar? | **Sim, sem reiniciar, depois de "Salvar alterações"** (ver §1). O que você viu na captura **não está gravado** no perfil real (§1.2). |
| Quando um LLM acaba o saldo, passa para outro? | **Não passava.** A reserva só trocava de modelo **dentro do mesmo provedor** (DeepSeek → outro DeepSeek, que falha igual). Agora passa para o próximo **provedor** que funciona (§2). |
| O seletor do compositor muda junto? | **Não mudava** (a troca não era gravada na sessão). Agora muda, e a conversa mostra uma linha avisando (§2.3). |
| Imagem para LLM que não vê? | Agora um modelo que vê descreve a imagem e o LLM segue com o texto (§3). |

Estado real das suas contas em 2026-10-27 (medido nesta sessão): **DeepSeek sem saldo** (`HTTP 402 insufficient_balance_error`),
**Ollama Cloud no limite mensal** (modelos `:cloud` respondem HTTP 429 "monthly usage limit"), **OpenRouter sem chave no cofre**.
O único LLM real que respondeu foi o `qwen3.5:4b` local do Ollama (lê imagens e usa ferramentas): é ele que as provas usam
como "o LLM que funciona". Se você salvar a chave do OpenRouter, ele passa a ser candidato como qualquer outro.

## 1. O provedor novo aparece para seleção?

### 1.1 O que cada botão grava (Configurações → Provedores)

| Ação | O que acontece | Onde fica |
|---|---|---|
| **Salvar chave** | Grava a chave no cofre do Windows (DPAPI) **na hora** e troca a referência do provedor para `secret:<id>`. | `config/secrets.bin` + `settings.json` (só a referência) |
| **Detectar modelos** | Pergunta ao servidor a lista de modelos (e quais leem imagens) e **só preenche o formulário**: "Salve para aplicar". | memória da janela |
| **Testar** | Envia um "ping" de poucos tokens ao provedor. | nada é gravado (marca o provedor como "sem saldo" no registro de saúde, se for o caso) |
| **Salvar alterações** | Grava a lista inteira de provedores (modelos, janela, endereço, ordem da reserva…). | `config/settings.json` |

Depois de **Salvar alterações** o provedor e os modelos aparecem **no seletor do compositor e na tela de Nova conversa sem reiniciar**
(os dois leem as configurações salvas). Antes disso só a chave está gravada.

### 1.2 O que existe no seu perfil real

Em `%APPDATA%\Openclod Desktop\config` (só leitura, sem imprimir segredos):

- `settings.json` (08:14): OpenRouter ainda como o preset: `apiKeyRef: env:OPENROUTER_API_KEY`, 0 modelos, janela 128000.
- `secrets.bin` (08:00): sem entrada `openrouter` (confirmado abrindo uma **cópia** do cofre num perfil descartável: `configured: false`).
- Nenhuma variável de ambiente `OPENROUTER_API_KEY`.

A captura (credencial ok, 463 modelos, janela 163840) mostra um estado que **não chegou a esses arquivos**. Duas observações: o
`/models` do OpenRouter é público (os 463 aparecem mesmo sem chave, então "Detectar modelos" não prova que a chave existe) e
"credencial ok" exige uma chave no cofre (ou na variável de ambiente) do app que mostrou a tela. **Hipótese** (não confirmada): a
janela em que você mexeu era uma instância de teste de outra sessão (perfil temporário, apagado ao terminar; às 10:48 a única janela
"Openclod Desktop" aberta era uma dessas, com `--user-data-dir` em `%TEMP%`, e o seu app não estava aberto). Para conferir no seu
app: salve o OpenRouter e abra `settings.json`: deve ter `"apiKeyRef": "secret:openrouter"` e a lista de modelos.

### 1.3 O que corrigi nesse caminho

- **"Detectar modelos" e "Testar" usavam o provedor SALVO, não o formulário.** Mudar o endereço no cartão e detectar consultava o
  endereço antigo (no teste isso trouxe os 463 modelos do OpenRouter de verdade em vez dos 40 do servidor digitado). Agora usam o
  que está no formulário (`ProviderDraft`, `src/shared/api.ts`; `Orchestrator.discoverModels/testProvider`).
- O rascunho do diálogo era descartado quando **outra** configuração mudava com ele aberto (um conector iniciando, o último modelo
  escolhido): o que "Detectar modelos" achou sumia. Agora o rascunho só é refeito quando algo que o diálogo edita muda (`draftKey`).
- **O seletor de modelo listava provedores sem chave** (escolher um deles só dava erro ao enviar). Agora eles aparecem numa linha
  "Anthropic · sem chave — configurar" que abre as configurações; o provedor da sessão continua listado.
- **Salvar as configurações desfazia o modelo escolhido no compositor** (a sessão voltava ao modelo escrito no cartão do provedor).
  Agora só segue o cartão quando você acabou de editá-lo.
- Presets adicionados pela tela agora trazem a lista de modelos do preset e quais leem imagens (o OpenRouter preset marcava
  `supportsVision` para `deepseek/deepseek-chat`, que só lê texto).

### 1.4 Prova

`node scripts/ui-provider-add.cjs` reproduz o seu caminho com o cartão do OpenRouter apontado para um servidor local que responde
como o OpenRouter (40 modelos, 10 leem imagens) e uma chave de teste inventada: Salvar chave → Detectar modelos → Salvar alterações →
seletor do compositor → Nova conversa → fechar e abrir o app. **Resultado: ver §6 (saída em `Prints/reserva-2026-10-27/`).**

## 2. Troca automática quando um LLM acaba

### 2.1 O que existia (código e E2E real, build congelado antes das edições)

`runner.ts` já tinha `fallback`, `isFallbackKind` e o bloco "Quota/rate limit/auth: switch to the next model", mas:

| Ponto | Antes |
|---|---|
| (a) Cadeia | `Orchestrator.buildFallback` montava só **outros modelos do mesmo provedor** e só com `useAllModels` (padrão: desligado). O OpenRouter nunca entrava. Com saldo zerado a conta toda falha, então a cadeia era inútil. A tela dizia "O agente nunca muda para outro provedor". |
| Ordem visível/escolhida | Não existia. |
| (b) Só os que funcionam | Só checava credencial; nada de saúde, nada de "responde". |
| (c) Turnos seguintes | A troca ficava só na memória do runner: a sessão, o seletor e o disco continuavam no esgotado; qualquer "Salvar configurações" reconstruía o runner **no esgotado** de novo. |
| (d) Aviso | Só um toast/log; nada na conversa. |
| (e) Erro no meio da resposta / janela de contexto | Mensagem parcial → turno terminava em erro. `context_overflow` → compacta uma vez e erro. |
| Limite 429 com `Retry-After` | `postStream` esperava até 120 s × 5 tentativas antes de falhar. |
| Mensagens de "limite mensal"/"saldo" fora do padrão | Ollama Cloud (429 "monthly usage limit") era tratado como rate limit comum. |

Provas do "antes" (mesmo roteiro `scripts/ui-fallback.cjs`, contra o build congelado antes das edições):
`Prints/reserva-2026-10-27/antes-saida.txt`, `antes-outros-saida.txt`, `antes-outros-reserva.json` e as capturas `antes-*-conversa.png`:
402 → "HTTP 402 Insufficient Balance" e fim do turno; o provedor esgotado foi chamado de novo a **cada** turno (1 → 2 → 3 chamadas);
429 com `Retry-After: 3600` → **152 s depois ainda esperando** (2 chamadas, sem troca); 401, resposta cortada e janela de contexto →
fim do turno com erro; o compositor continuava mostrando o modelo esgotado em todos.

### 2.2 O que mudou

Núcleo (puro, sem Electron):

- `src/core/providers/health.ts`: registro de saúde **compartilhado por todas as sessões** (`ProviderHealth`). Saldo/chave/sem conexão
  marcam a **conta**; limite/sobrecarga/timeout marcam só o **modelo**. Dura 10 min (saldo, chave, modelo inexistente), 2 min (sobrecarga), 1 min (limite de uso)
  ou 90 s (rede, servidor, timeout); some sozinho e **é apagado quando você salva uma chave, salva a lista de provedores ou testa o
  provedor com sucesso**. Só reordena e pula: se tudo
  estiver marcado a cadeia ainda tenta, em ordem. Um tropeço que uma nova tentativa curou **não** é registrado.
- `src/core/providers/chain.ts` + `order.ts`: `buildFallbackChain` monta a reserva: (1) outros modelos curados do provedor em uso (só para
  falhas por modelo), (2) **todos os outros provedores com credencial**, na ordem que o usuário escolheu (`fallbackOrder`), sem os que
  ele tirou (`fallbackExclude`), sem provedores sem ferramentas, com os marcados como fora no fim. Servidores locais ganham uma
  **sondagem TCP** (um Ollama/LM Studio desligado é pulado sem gastar uma requisição). Os modelos `:cloud` do Ollama têm **conta
  própria**: depois do limite mensal da nuvem, os modelos **locais** do mesmo servidor (os 2 primeiros da lista, sem `:cloud` e sem `/`
  no nome, porque `openrouter/…:free` é uma entrada do Ollama que aponta para outro serviço) são os primeiros da reserva.
- `src/core/agent/runner.ts`: `takeFallback`/`switchModel`/`hasReserve`. A falha de **conta** (402/401/sem conexão) descarta os modelos da
  mesma conta; a falha de **modelo** (429, sobrecarga) aceita o irmão. Com reserva pronta não espera limite nem sobrecarga e tenta no
  máximo uma vez falhas transitórias (`fastFail` → `postStream` desiste de `Retry-After` > 4 s). **Resposta cortada no meio**: o trecho que
  já estava na tela é mantido na conversa e o modelo novo recebe a instrução de continuar de onde parou. **Janela de contexto**: compacta
  uma vez; se não resolver, passa para um modelo de janela **maior**, nunca menor. Quando o modelo que assume tem janela menor, vale o
  resumo que já existia (troca de modelo com conversa longa).
- `src/core/providers/http.ts`: classificação de "sem crédito" cobre o texto dos provedores reais (DeepSeek `insufficient_balance_error`,
  Ollama Cloud "monthly usage limit … usage credits", Anthropic "usage limit", Moonshot "recharge"), mesmo com status 429/403/400.

App:

- `src/main/reserve.ts` (`ProviderReserve`): cadeia por sessão, **onde a sessão começa** (se o provedor dela está marcado como fora, ou
  não tem chave, e outro funciona, ela começa nele e a conversa diz), candidatos de visão e o status mostrado nas configurações.
- `Orchestrator`: grava `providerId`/`model` da sessão a cada `model_switch` (o próximo runner, "Salvar configurações" e reabrir o app já
  partem do modelo que funciona); novas conversas pedidas num provedor esgotado já nascem no que funciona; "Testar" marca/limpa a saúde;
  os agentes especialistas (`agent`) também usam a reserva.
- Interface: o evento `model_switch` atualiza a sessão no renderer, então **o seletor de modelo e o rodapé do compositor passam a mostrar
  o modelo novo**; uma mensagem de sistema (`role: system`, `notice: model_switch`, nunca enviada a modelo algum) vira uma linha na conversa:
  `DeepSeek/deepseek-flash falhou (quota: sem saldo ou cota); continuando com … A conversa, o plano e a memória do projeto foram preservados.`
  Em **Configurações → Provedores**: a chave "Trocar sozinho para outro LLM quando um acabar (reserva)" (agora **ligada por padrão**; arquivos
  antigos com o `false` que o código gravava são migrados uma vez, v7→v8), a lista **Ordem da reserva** (subir/descer, tirar da reserva,
  estado de cada um: pronto, local, sem chave, sem saldo…), o botão **Testar todos agora** e o estado "sem saldo" nos cartões.

### 2.3 Respostas às perguntas (a)–(e) e ao seletor

- (a) **A cadeia inclui o provedor novo e todos os outros com credencial**, na ordem de **Configurações → Provedores → Ordem da reserva**
  (você vê e escolhe; o que você não ordena entra no fim, na ordem da lista).
- (b) **Só entram os que têm credencial e respondem**: sem chave fica de fora; Ollama/LM Studio desligados são pulados pela sondagem;
  quem acabou de falhar vai para o fim e volta sozinho; "Testar todos agora" mostra quem responde.
- (c) **Os turnos seguintes ficam no que funciona**: a sessão é gravada no novo modelo, o seletor mostra, o esgotado não é tentado de novo
  (nem depois de salvar as configurações, nem depois de reabrir o app); uma conversa nova pedida no esgotado já começa no que funciona.
- (d) **O usuário é avisado na conversa** (linha na conversa + toast), a mensagem e o histórico seguem (o modelo novo recebe tudo; com
  janela menor há resumo). 
- (e) **Erro no meio da resposta e janela de contexto são tratados** (ver §2.2).
- **Seletor do compositor**: muda junto (pedido seu). Prova na captura `depois-402-conversa.png`.

### 2.3.1 Escolher quais modelos de cada provedor entram no rodízio (pedido novo)

Cada linha da **Ordem da reserva** tem um botão **Modelos ⌄** que abre, dentro do próprio item, a lista dos modelos daquele provedor
(o modelo principal e os que "Detectar modelos" achou), com **uma caixa por modelo**, **"Selecionar todos"** (com estado parcial), o contador
"2 de 3 marcados" e, quando a lista passa de 8, uma **busca** ("Selecionar os N filtrados" vale só para o que a busca mostra; a tela desenha
até 200 por vez). A linha resume o que está marcado ("qwen3.5:4b" ou "2 modelos").

- **Regra**: sem nenhuma marcação, o provedor entra só com o modelo principal (o comportamento de antes); com marcações, entram **exatamente os
  marcados**, na ordem da lista do provedor com o principal primeiro; todas as caixas limpas deixam o provedor **fora** da reserva; um nome marcado que o provedor aposentou da lista
  (depois de um novo "Detectar modelos") deixa de valer, porque a tela não teria caixa para desmarcá-lo.
  Fica salvo em `settings.fallbackModels` (por id de provedor) e vai na exportação de configuração.
- **Na cadeia** (`buildFallbackChain` + `reserveModels` em `src/core/providers/order.ts`, a mesma leitura que a tela usa): cada modelo marcado
  vira um candidato, provedor por provedor na ordem escolhida. Os marcados do **provedor em uso** são os primeiros alternativos (servem para
  falha **de modelo**: limite, sobrecarga; uma falha de **conta** — sem saldo, chave recusada — pula todos os modelos da mesma conta sem gastar
  chamada). Teto: 40 candidatos na cadeia e 16 trocas por turno (antes 12 e 8), porque agora o usuário pode marcar vários.
- **Prova** (`scripts/ui-fallback.cjs --only modelos`, app real, LLM real): abre o item, vê 1 de 3 marcados, "Selecionar todos", desmarca o
  terceiro, salva (`fallbackModels = {"fake-b": ["fake-b-1","fake-b-2"]}`); o provedor da sessão responde 402, o 1º marcado responde 429, o 2º
  marcado responde 429 e o **LLM real responde**; chamadas: esgotado 1, 1º marcado 1, 2º marcado 1, **não marcado 0**; a conversa avisa as 3
  trocas. **12 de 12**. Testes unitários (`provider-chain`, `reserve-settings`): 5 novos; com a cadeia ignorando a configuração (o código de
  antes), **4 falham** (`antes-testes-unitarios-modelos.txt`). Captura: `modelos-modelos-da-reserva.png`.

### 2.4 Provas com modelo real

Provedor A = servidor local de mentira (`scripts/lib/fake-provider.cjs`) que responde 402/429/401/resposta cortada/janela/conexão
derrubada; o LLM que responde é **real**: Ollama `qwen3.5:4b` local (por um repasse que só liga `reasoning_effort: none`, porque a conta
do DeepSeek está sem saldo e o Ollama Cloud no limite). Roteiro: `node scripts/ui-fallback.cjs [--root <snapshot>]`.

Resultados em `Prints/reserva-2026-10-27/` (ver §6 para os números finais).

## 3. Relé de visão

Quando o modelo da conversa **não lê imagens**, nada de imagem chega a ele: um modelo que lê descreve a imagem (texto lido, layout,
estado dos controles) e o texto entra no lugar da figura.

- `src/core/vision/relay.ts`: `describeImage` (tenta os candidatos em ordem; cada imagem é descrita **uma vez**: a descrição fica em
  `ImagePart.description` e, para screenshots de ferramenta, em `imageDescriptions` — que sobrevive ao salvar a sessão, quando os bytes
  são descartados), `inlineImageDescriptions` (a conversa como um modelo sem visão deve recebê-la), `pendingImages`.
- Runner: antes de cada requisição a um modelo sem visão, descreve o que ainda não tem descrição (até 6 por requisição, 3 em paralelo; se
  nenhum modelo com visão responder, descansa 2 min e avisa na tela, em vez de falhar; o modelo recebe a nota "nenhum modelo com visão pôde
  descrevê-la"). Vale para anexos do usuário e para imagens de
  ferramentas (screenshots do Computer Use e do navegador), e também quando a **reserva** cai num modelo sem visão no meio da conversa.
- Quem descreve: o modelo escolhido em **Configurações → Provedores → "Modelo que descreve imagens…"** ou, no automático, o primeiro
  provedor da reserva com credencial e um modelo que lê imagens (a lista vem de "Detectar modelos": `ProviderConfig.visionModels`;
  sem lista vale a marca "suporta imagens" do provedor).
- **Privacidade**: a imagem é enviada ao provedor que a descreve (o escolhido ou o primeiro da reserva que lê imagens), que pode não ser o
  da conversa. Quem não quer isso escolhe o modelo de visão em Configurações (por exemplo um Ollama local) ou tira provedores da reserva.
  A troca fica registrada como aviso informativo (log de Atividades), não como linha na conversa.
- `modelSeesImages`: o que decide se o modelo vê é **por modelo** quando o servidor informou (o preset do OpenRouter tem o `deepseek/deepseek-chat`
  só de texto e outros três com visão).

## 4. Arquivos

Novos: `src/core/providers/{health,chain,order}.ts`, `src/core/vision/relay.ts`, `src/main/reserve.ts`,
`scripts/ui-fallback.cjs`, `scripts/ui-provider-add.cjs`, `scripts/ui-vision-relay.cjs`, `scripts/lib/fake-provider.cjs`,
`tests/{provider-chain,runner-fallback,reserve-settings,orchestrator-reserve}.test.ts`, este relatório, `Prints/reserva-2026-10-27/`.

Do pedido dos modelos marcados por provedor: `src/core/providers/{order,chain}.ts` (`reserveModels`, `fallbackModels`), `src/main/index.ts`
(sanitização), `src/core/config/transfer.ts`, `SettingsDialog.tsx` + `styles.css` (o item que abre), `scripts/ui-fallback.cjs` (`--only modelos`),
`scripts/lib/fake-provider.cjs` (falha por modelo), `tests/{provider-chain,reserve-settings}.test.ts`.

Alterados (os arquivos já tinham mudanças não commitadas de outras frentes; as minhas são pontuais):
`src/core/agent/runner.ts`, `src/core/agents/runtime.ts`, `src/core/providers/{http,openai,anthropic,presets}.ts`,
`src/main/{orchestrator,index,settings}.ts`, `src/shared/{types,api}.ts`, `src/preload/index.ts`,
`src/renderer/src/{App.tsx,styles.css}`, `src/renderer/src/components/{SettingsDialog,Composer,Transcript}.tsx`,
`tsconfig.web.json`, `tests/{runner,runner-continuity}.test.ts`, `tests/support/scripted-provider.ts`.

## 5. Pendências e decisões

- **OpenRouter real (pedido: "continue usando os modelos da openrouter")**: não consegui chamá-lo, por três motivos medidos hoje:
  (1) a chave do OpenRouter **não está no cofre** do seu app (`secrets.bin` de 08:00; nem no perfil antigo `%APPDATA%\Electron`);
  (2) os modelos `openrouter/…:free` que o seu Ollama lista (e que você já usou) respondem **HTTP 429 "Rate limit exceeded:
  free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"**: o teto diário do plano grátis acabou (pelo que sei o contador
  zera à meia-noite UTC, 21:00 no seu horário; confirme no painel do OpenRouter) e o harness agora trata esse aviso como "sem crédito" (troca na hora, em vez de esperar um
  minuto); (3) o `/models` público do OpenRouter responde sem chave (463 modelos, 308 leem imagens), mas completar chat exige a chave.
  **A chave é por sua conta (pedido seu): não procurei nem usei chave de OpenRouter em lugar nenhum.** Para o OpenRouter entrar na reserva: reconstruir e reabrir o app, **Configurações → Provedores → OpenRouter → colar a chave → Salvar
  chave → Detectar modelos → Salvar alterações**. Depois: `node scripts/ui-fallback.cjs --only openrouter` (a cena usa o **seu** OpenRouter,
  modelo barato `deepseek/deepseek-chat` ou `--openrouter-model <id>`; sem chave ela só avisa e pula; o caminho com chave **não foi
  executado**, o de "pular" sim). A escolha automática do modelo que descreve imagens evita os `:free` (teto diário pequeno).
  Para ver o seu DeepSeek (402) passar para o próximo da ordem: `node scripts/ui-fallback.cjs --only real-402`.
- A saúde dos provedores vive só em memória (some ao fechar o app; o custo é uma requisição que falha em milissegundos na primeira conversa).
- A ordem padrão é a da lista de provedores (Anthropic, OpenAI, DeepSeek, Kimi, Qwen, OpenRouter, Ollama…). Se você quer o OpenRouter
  antes do Ollama, suba-o em **Ordem da reserva**.
- O Ollama (local) com o modelo padrão `gemma4:31b-cloud` está no limite mensal da nuvem; para ele funcionar como reserva sem a nuvem,
  escolha um modelo local (`qwen3.5:4b`) no cartão do provedor (ou deixe: a reserva já tenta os 2 primeiros modelos locais depois do cloud).
- Subagentes: usam a mesma reserva e o relé; o aviso de troca deles aparece como notícia com o nome do agente, não como linha na conversa.

## 6. Resultados finais (2026-10-27, build novo congelado em pasta própria; `out/` do app do usuário intocado)

| Verificação | Antes | Depois |
|---|---|---|
| Testes unitários novos (`runner-fallback`, `provider-chain`, `reserve-settings`, `orchestrator-reserve`) | com a lógica antiga do runner devolvida a uma cópia do repositório, **12 de 47 falham** (`antes-testes-unitarios.txt`) | passam |
| Suíte completa (`npx vitest run`) e `npm run typecheck` | — | Primeira rodada (antes dos modelos marcados): **133 arquivos, 1878 testes passam, 1 pulado, 0 falham**. Última rodada, com a tela de modelos marcados: **142 arquivos, 2053 passam, 1 pulado, 1 falhou** (`tests/mascot-render.test.ts`, comparação de pixels em navegador real, de outra frente; sob carga falhou e **sozinho passa**, 7 ok); typecheck dos dois projetos limpo |
| Reserva, modelo real (`scripts/ui-fallback.cjs`) | 402: 3 de 16 ok (sem troca, esgotado chamado a cada turno); 401, resposta cortada e janela: 1 de 16; 429 com `Retry-After: 3600`: **152 s depois ainda esperando** | **55 de 55**: **os modelos marcados por provedor (12 verificações, §2.3.1)**, 402 no meio da conversa (contexto preservado, aviso, seletor, esgotado chamado 1 vez, nova conversa, salvar configurações, **fechar e abrir o app**), 429 (7 s, 1 chamada), 401, resposta cortada (mantém "A capital da França é", o modelo novo continua), janela de contexto, conexão derrubada, **o DeepSeek real sem saldo → LLM local real**, ordem da reserva na tela |
| Provedor novo no app (`scripts/ui-provider-add.cjs`) | o rascunho/Detectar usava o provedor salvo (463 do OpenRouter real em vez dos 40 digitados) | **15 de 15** (salvar chave, detectar, salvar, seletor sem reiniciar, Nova conversa, reabrir o app) |
| Visão, modelo real (`scripts/ui-vision-relay.cjs`) | 4 de 10: o app mandou os bytes da imagem a um modelo marcado como só texto, sem relé | **10 de 10**: o modelo de texto nunca recebeu a imagem, o modelo com visão a recebeu 1 vez, a descrição ("BANANA-77", quadrado vermelho) ficou guardada e respondeu a pergunta seguinte; sem modelo com visão o turno termina sem erro |

Capturas (`Prints/reserva-2026-10-27/`): `depois-402-conversa.png` (linha de troca na conversa + seletor/rodapé mostrando o modelo novo),
`depois-real-402-conversa.png` (seu DeepSeek sem saldo → Ollama local), `depois-ordem-da-reserva.png` (Configurações → Ordem da reserva),
`depois-provedor-seletor-de-modelo.png` (provedor novo com 40 modelos; os sem chave como "configurar"), `depois-provedor-detectar-modelos.png`,
`depois-visao-conversa.png` / `depois-visao-imagem-enviada.png`, e os `antes-*.png`, `antes-*-saida.txt` do app como estava.
Saídas completas: `depois-reserva-saida.txt`/`.json`, `depois-provedor-novo-saida.txt`, `depois-visao-saida.txt`.

Como rodar de novo (sem tocar no seu app): `npx electron-vite build --outDir "%TEMP%\openclod-build-x"`, `node scripts/snapshot-app.cjs x --from "%TEMP%\openclod-build-x"`,
`node scripts/ui-fallback.cjs --root <pasta do snapshot>` (idem `ui-provider-add.cjs` e `ui-vision-relay.cjs`; `--only 402,429,real-402,ordem…`).

Para o **seu** app usar tudo isto: reconstruir e reabrir (`npm run build` e abrir de novo, ou `npm run dist`). Eu não fiz nenhum dos dois.
