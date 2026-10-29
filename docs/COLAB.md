# Google Colab (GPU) como servidor de LLM do Openclod

Relatório de 2026-10-27. Pedido do usuário: "adicione no harness uma forma de ele usar o Google Colab como servidor de LLM: um botão
na área de provedores que abre o Google Colab com todos os códigos já prontos para rodar, onde ele usa o melhor LLM que roda na GPU
do Colab; lá já vai baixar, instalar, rodar e servir ao harness automaticamente. [...] um LLM numa GPU melhor, que tenha visão."

> **Leia antes de depender disto.** As regras do Colab restringem exatamente este tipo de uso (servidor acessado de fora por um
> túnel): o Google **pode encerrar a sessão sem aviso**, em qualquer plano. Detalhes, com os links oficiais, na seção
> [Limites e termos do Colab](#5-limites-e-termos-do-colab). O Colab real **só roda com a conta Google do usuário**: o que foi provado
> aqui e o que só o Colab prova está separado em [Provas](#9-provas).

## 1. Resumo

| Pergunta | Resposta |
|---|---|
| O que o botão faz? | **Configurações → Provedores → Google Colab (GPU) → "Abrir o Google Colab"** grava o notebook `openclod-servidor-llm.ipynb` (com o código do servidor **dentro**, legível) numa pasta sua (`Documentos\Openclod\Colab`), **mostra o arquivo no cartão como um item que você arrasta para dentro do Colab** (nome, tamanho, caminho; arrasto nativo do Windows), mostra a pasta no Explorer, copia o caminho e abre `colab.research.google.com` no navegador. **Nada é publicado em seu nome** (nem GitHub, nem Drive, nem gist). Você faz o upload do arquivo no Colab (arrastando ou por *Arquivo → Fazer upload de notebook*). |
| O que o notebook faz sozinho? | Confere a GPU, **mostra todos os modelos abertos que cabem nela** (de todo tipo, inclusive sem censura, numerados) e **para numa caixa de seleção** (botão *Usar este modelo*) por até 2 minutos; sem escolha, roda o melhor **com visão e chamada de ferramentas**. Só depois instala o motor (Ollama), baixa o modelo, sobe um servidor compatível com a API da OpenAI protegido por uma chave aleatória, abre um túnel público, **testa tudo pelo endereço público** (texto, streaming, imagem, ferramenta) e só então imprime o **código de conexão**. Fica vivo com um painel de status. |
| Posso escolher outro modelo? | **Sim, na própria etapa 2.** Ela lista os modelos que cabem na GPU que você recebeu (ex.: **97 numa T4**, 123 numa L4, 146 numa A100 de 40 GB) em grupos (agentes com visão, agentes só texto, código, raciocínio, visão, só conversa, **sem censura**) e **para numa caixa de seleção com o botão «Usar este modelo»**: o automático já vem marcado e, se você não escolher em 2 minutos (`segundos_para_escolher`; 0 = não perguntar), é ele que roda. Também dá para decidir antes, nas Opções: pelo número (`numero_da_lista`), pelo tipo (`tipo_de_modelo`) ou digitando a etiqueta (`modelo_manual`); com qualquer um deles a caixa não aparece. Seções [4.2](#42-modelo-por-vram-e-o-catálogo-de-modelos-que-cabem) e [4.5](#45-a-pausa-para-escolher-o-modelo-notebook-120). |
| E no app? | Você cola o código; o app mostra **servidor, modelo, GPU, visão e contexto** e pede para você confirmar; ao conectar, o Colab vira um **provedor comum** (`colab`): aparece no seletor de modelo sem reiniciar, tem estado (conectado / caiu), botão de testar e de desconectar, e **entra na reserva automática** (se o Colab cair, o harness segue sozinho no próximo provedor). |
| Qual motor? | **Ollama** (binário oficial, versão e SHA-256 fixos). Motivos e alternativas na seção [4.1](#41-motor-ollama). |
| Qual modelo? | Pela VRAM lida na hora: **Qwen3.5-9B** (T4), **Qwen3.8-27B** (L4, A100, H100, G4...). Tabela, fontes e contas de memória em [4.2](#42-modelo-por-vram). |
| O streaming passa pelo túnel? | **Passa**, mas só porque o `chat/completions` é um **POST**: a documentação da Cloudflare diz que os quick tunnels **não suportam SSE**, e eu medi que as respostas de **GET** chegam bufferizadas, enquanto as de **POST** chegam em fluxo. Medições na seção [4.3](#43-túnel-cloudflare-quick-tunnel). |
| Funciona no plano gratuito? | Tecnicamente sim; **pelas regras do Colab é uma zona de risco** (seção 5). Há alternativas (plano pago com saldo, GPU alugada que permita servir modelos: o mesmo módulo roda lá com `python openclod_llm_server.py run`). |

## 2. Como usar (primeira execução, 5 passos)

1. **Openclod:** Configurações → Provedores → **Abrir o Google Colab**. O Colab abre no navegador, o cartão mostra o arquivo `openclod-servidor-llm.ipynb` (**arraste-o para o Colab**; há também **Mostrar na pasta**) e o caminho do notebook já está na área de transferência.
2. **Colab:** *Arquivo → Fazer upload de notebook* (aba *Upload*: arraste o arquivo para a janela, ou *Procurar* e cole o caminho), depois *Ambiente de execução → Executar tudo* (Ctrl+F9). O notebook já pede uma GPU; se aparecer "este ambiente não tem GPU", escolha *Alterar o tipo de ambiente de execução → GPU*. Se o Colab mostrar um aviso de segurança sobre o notebook, confirme (o código está legível na 3ª célula).
3. **Espere:** a etapa 2 **para por até 2 minutos** numa caixa de seleção para você escolher o modelo (ou deixe passar: segue com o automático). Depois, na primeira vez, leva de 5 a 15 minutos (baixa ~1,5 GB do motor e o modelo, de 6 a 30 GB). O progresso aparece em cada célula.
4. **No fim** aparece o **CÓDIGO DE CONEXÃO** (uma linha que começa com `OCLC1.`) e o botão **Copiar**.
5. **Openclod:** cole o código na caixa do cartão (ela fica mascarada), confira o que aparece e clique em **Conectar**. **Deixe a aba do Colab aberta.**

Depois de uma sessão que terminou, o caminho é mais curto: rode o notebook de novo (o notebook já está lá), copie o **código novo** (o endereço do túnel e a chave mudam a cada execução) e use **Colar código novo** no cartão. O estado do cartão (conectado / caiu / chave recusada) se atualiza sozinho.

**Escolher o modelo.** A etapa 2 imprime a lista e **para numa caixa de seleção** na saída da célula, com o botão **Usar este modelo** e uma contagem de 2 minutos: o automático (o melhor agente com visão e ferramentas da sua GPU) já vem marcado; escolha outro e clique, ou deixe passar e ele roda. **Só depois** a etapa 3 em diante baixa alguma coisa, e a saída diz qual modelo foi escolhido e por quem ("Você escolheu o n.º 7…" ou "Ninguém escolheu em 2 minutos: seguindo com o automático"). Quem prefere decidir antes, ou não ser perguntado, usa as Opções: `numero_da_lista` (o número do modelo na lista), `tipo_de_modelo` (`sem censura`, `código`, `raciocínio`, `leve e rápido`) ou `modelo_manual`; com qualquer um preenchido a caixa não aparece. `segundos_para_escolher` muda o tempo (**0 = não perguntar**: vai direto no automático, para rodar sem ninguém olhando) e `somente_listar_modelos` só mostra a lista e para. A lista só depende da GPU: o número é o mesmo em toda execução nela. Se o tempo acabar e você queria outro, pare a execução, preencha `numero_da_lista` e rode de novo. Se a etiqueta que você escolheu não couber 100% na GPU, o notebook tenta um contexto menor **do mesmo modelo** e, se ainda assim não couber, para dizendo isso (nunca troca o modelo em silêncio).

Campos opcionais do notebook (formulário da 1ª célula; pode deixar como está): `modelo_manual` (etiqueta do Ollama, ex. `qwen3.5:9b`, ou `hf.co/usuario/repositorio:Q4_K_M`; vence os outros), `numero_da_lista`, `tipo_de_modelo`, `somente_listar_modelos`, `segundos_para_escolher` (padrão 120), `contexto_manual` (tokens) e `pensamento` (`padrão`, `ligado`, `desligado`). Modelos com acesso restrito (gated): guarde o token do Hugging Face em **Segredos** do Colab com o nome `HF_TOKEN`; ele só é passado ao motor para baixar o modelo (**a aceitação de um token para repositórios restritos pelo Ollama não foi testada aqui**). Por padrão só entram modelos públicos, sem acesso restrito.

## 3. O que acontece em cada célula

O notebook não tem lógica própria: uma célula grava `openclod_llm_server.py` (o arquivo de `resources/colab/`, legível por inteiro dentro do notebook) e cada etapa é uma chamada a ele. O que roda no Colab é exatamente o arquivo que os testes executam.

| Célula | Função | O que faz |
|---|---|---|
| Opções | formulário | `modelo_manual`, `numero_da_lista`, `tipo_de_modelo`, `somente_listar_modelos`, `segundos_para_escolher`, `contexto_manual`, `pensamento` |
| Servidor | grava o módulo | `/content/openclod_llm_server.py` |
| 1 | `step_gpu` | `nvidia-smi`; sem GPU: para com a mensagem do que clicar |
| 2 | `step_plan` | **imprime a lista numerada dos modelos abertos que cabem na GPU** (por tipo; confere as etiquetas no registro do Ollama) e escolhe o que vai rodar: a etiqueta digitada, o número, o tipo ou, sem nenhum deles, **a caixa de seleção** (seção [4.5](#45-a-pausa-para-escolher-o-modelo-notebook-120)): para por até `segundos_para_escolher` esperando o clique em *Usar este modelo*; sem clique, o automático |
| 3 | `step_install_engine` | Ollama `0.40.11`, `.tar.zst` oficial do GitHub, SHA-256 conferido antes de extrair |
| 4 | `step_model` | `ollama pull` com barra única de progresso; carrega na GPU com o contexto pedido e **confere em `ollama ps` que cabe 100% na GPU**, senão tenta a próxima opção da tabela |
| 5 | `step_server` | sobe o servidor com a chave nova (confere que sem chave responde 401) |
| 6 | `step_tunnel` | `cloudflared` `2026.10.5` (SHA-256 conferido), `--protocol auto` e depois `http2`; espera o nome novo responder |
| 7 | `step_serve_forever` | **autoteste pelo endereço público**, imprime o código, e fica num laço com o painel (reinicia o que cair, no máximo 3 vezes em 10 min; se o túnel for reaberto, o endereço muda e um código novo é impresso) |

Servidor (cada requisição):

- Só quatro rotas saem pelo túnel: `/v1/models`, `/v1/chat/completions`, `/healthz` (público, sem dados) e `/openclod/status` (com chave). Tudo do motor (`/api/pull`, `/api/delete`...) fica inacessível de fora.
- Chave `occ_` + 24 bytes aleatórios, comparada em tempo constante; depois de 20 tentativas erradas por minuto, cada resposta de erro demora 1,5 s.
- `GET /v1/models` devolve, além do formato da OpenAI, a **janela de contexto real**, `input_modalities` (visão) e `supported_parameters` (`tools`), que o harness lê ("Detectar modelos").
- Com o motor lento (prompt grande), o servidor **abre o SSE e manda comentários `: aguardando o modelo`** a cada 8 s, para o túnel não cortar a conexão; se o motor responder um erro depois disso, o erro vai como evento SSE (o harness já entende `data: {"error": ...}`). Se o usuário apertar "parar", o servidor fecha a conexão com o motor e ele para de gerar.
- Nada de conteúdo de conversa em log: os contadores guardam só números.

## 4. Escolhas técnicas (pesquisadas em 2026-10-27)

### 4.1 Motor: Ollama

Exigências: do T4 (sm75, sem bf16) ao H100, aceitar imagens, streaming e *tool calling* no formato OpenAI, instalar rápido e com poucas peças soltas.

| Motor | O que verifiquei | Decisão |
|---|---|---|
| **Ollama** | Binário Linux oficial pronto (`ollama-linux-amd64.tar.zst`, **1 508,7 MB**, SHA-256 `7bedab90…`, release `v0.40.11` de 2026-10-24, [releases](https://github.com/ollama/ollama/releases)) com os runtimes CUDA dentro; o [`install.sh`](https://ollama.com/install.sh) só baixa e extrai isso (exige `zstd`). Os modelos vêm do registro do Ollama, **sem acesso restrito**, com template de ferramentas e projetor de visão no mesmo arquivo. `ollama serve --help` (0.40.9, local) lista `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_NO_CLOUD`. Visão com `data:` base64, `tools` em stream e `reasoning_effort` no endpoint OpenAI foram **exercitados de verdade** contra o `qwen3.5:4b` local (seção 9). | **Escolhido.** |
| `llama-server` (llama.cpp) | A última release do GitHub (`v0.7.0`, 2026-10-15) **só traz o arquivo `nightly-tag.txt`**: não achei binário Linux+CUDA oficial pronto; compilar com CUDA no Colab é minutos de espera e mais um ponto de falha. **Não testei compilar.** | Descartado por tempo de instalação e risco. |
| vLLM, SGLang | **Não avaliei na prática.** São pacotes Python grandes que dependem das versões de CUDA/PyTorch que o Colab já traz instaladas (risco de conflito, não medido aqui), e a T4 não tem bf16. | Fora desta versão. |

### 4.2 Modelo por VRAM e o catálogo de modelos que cabem

Esta seção tem duas partes: a **escolha automática** (a tabela por VRAM, abaixo, que o notebook usa quando você não escolhe nada) e o **catálogo** (a lista de todos os modelos abertos que cabem na GPU, mais adiante nesta seção).

Famílias da escolha automática: **Qwen3.8-27B** e **Qwen3.5** (4B/9B). As duas têm visão, ferramentas e raciocínio, licença **Apache-2.0** e **sem acesso restrito** (`gated: false` na API do Hugging Face: [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)); no registro do Ollama: [qwen3.8](https://ollama.com/library/qwen3.8), [qwen3.5](https://ollama.com/library/qwen3.5). O cartão de modelo do Qwen3.8-27B traz, **auto-reportados pela Qwen** (não verificados por mim), Terminal Bench 2.1 de 73,0, SWE-bench Pro de 61,7 e OSWorld-Verified de 84,3, acima do Qwen3.6-27B da própria Qwen. Outros candidatos com visão e ferramentas no registro (Gemma 4, Qwen3-VL, Ministral 3, Mistral Small 3.2) ficam para o campo `modelo_manual`.

O prompt-base do harness tem cerca de 9 mil tokens: o piso é **32k** e o alvo, **64k ou mais**. O cache KV é pequeno porque o Qwen3.5/3.8 só guarda KV em 1 de cada 4 camadas: pelas configurações públicas (`config.json` no Hugging Face), o 27B tem 16 camadas de atenção completa × 2 × 4 cabeças KV × 256 = **64 KiB por token em f16** (o 9B: 8 camadas, **32 KiB por token**). Os pesos são os tamanhos publicados nas páginas do Ollama.

| VRAM mínima | GPU (exemplos) | Modelos, na ordem em que são tentados | Pensamento |
|---|---|---|---|
| 90 000 MiB | ~96 GB (RTX PRO 6000 / G4) | `qwen3.8:27b-q8_0` @128k → `qwen3.8:27b-q4_K_M` @128k | ligado (2 pedidos em paralelo) |
| 70 000 MiB | A100 80 GB, H100 | `qwen3.8:27b-q8_0` @128k → `qwen3.8:27b-q4_K_M` @128k | ligado |
| 38 000 MiB | A100 40 GB | `qwen3.8:27b-q8_0` @64k → `qwen3.8:27b-q4_K_M` @128k | ligado |
| 22 000 MiB | L4 24 GB | `qwen3.8:27b-q4_K_M` @64k (KV em 8 bits) → `qwen3.8:27b-q4_K_M` @32k → `qwen3.5:9b-q8_0` @128k | desligado |
| 14 000 MiB | **T4 16 GB** | `qwen3.5:9b-q8_0` @64k → `qwen3.5:9b-q4_K_M` @128k → `qwen3.5:9b-q4_K_M` @64k → `qwen3.5:4b-q8_0` @64k | desligado |
| 10 000 MiB | 12 GB | `qwen3.5:9b-q4_K_M` @64k → `qwen3.5:4b-q8_0` @64k | desligado |
| 7 000 MiB | 8 GB | `qwen3.5:4b-q8_0` @32k → `qwen3.5:4b-q4_K_M` @32k | desligado |
| abaixo | < 8 GB | `qwen3.5:4b-q4_K_M` @32k → `qwen3.5:2b-q8_0` @32k | desligado |

A tabela escolhe pela **VRAM lida** (`nvidia-smi`), não pelo nome da GPU (o Colab lista T4, L4, G4, H100 e A100, segundo o [Colab CLI oficial](https://github.com/googlecolab/google-colab-cli); a VRAM da G4 não foi confirmada por mim). Um teste faz a conta (pesos + KV + 2 GiB de folga) para a GPU real de cada degrau. **A conta é estimativa:** o notebook confere em `ollama ps` que o modelo está 100% na GPU e, se não estiver, passa ao candidato seguinte.

*Pensamento* desligado nas GPUs até 24 GB é uma escolha de velocidade (um modelo que pensa gasta centenas de tokens a 20 tok/s antes de agir): o servidor acrescenta `reasoning_effort: none` quando o cliente não manda nada. O campo `pensamento` do notebook troca isso.

#### O catálogo: todos os modelos abertos que cabem na GPU

O módulo traz um **catálogo de 180 modelos abertos (341 etiquetas, 72 famílias)** do registro do Ollama, e a etapa 2 imprime os que cabem na GPU detectada, numerados e agrupados:

| GPU (VRAM livre ≈ total − 450 MiB) | Cabem | Com contexto de agente (≥ 32k) | Dos quais sem censura |
|---|---|---|---|
| 6 GB | 46 | 21 | 14 |
| 8 GB | 66 | 39 | 23 |
| 12 GB | 95 | 74 | 34 |
| **T4 (15 GB)** | **108** | 83 | 39 |
| L4 (24 GB) | 155 | 120 | 56 |
| A100 40 GB | 162 | 143 | 62 |
| A100 / H100 80 GB | 178 | 157 | 67 |
| 96 GB | 180 | 160 | 68 |

(contagens do catálogo de 2026-10-28; `python openclod_llm_server.py catalog --vram 15360` imprime a lista de qualquer GPU sem baixar nada.)

Em 2026-10-28 o catálogo ganhou **11 famílias mainstream** (Llama 4, Qwen3-Next, Nemotron 3 Super, Gemma 3n, Command R, Command R7B, Aya Expanse, EXAONE 3.5, Falcon 3, LFM2 e LFM2.5), +35 etiquetas, cobrindo de ~1,6 GB a ~87 GB. **Nenhuma família sem censura foi acrescentada**: a coluna "sem censura" é idêntica à de antes (ex.: T4 segue com 39, 96 GB com 68); só os grupos mainstream cresceram.

**Grupos** (cada modelo aparece em um só): agentes com visão e ferramentas; agentes só texto; código; raciocínio; visão sem ferramentas; só conversa; **sem censura**. Os modelos **sem censura** (*uncensored* / *abliterated*) são os da biblioteca oficial do Ollama (`dolphin3`, `dolphin-llama3`, `dolphin-mistral`, `dolphin-mixtral`, `dolphincoder`, `llama2-uncensored`, `wizard-vicuna-uncensored`, `wizardlm-uncensored`) e, da comunidade, os "abliterated" da publicação [`huihui_ai`](https://ollama.com/huihui_ai) (a mais baixada do Ollama: Qwen3.8, 3.6, 3.5, 3, Qwen3-VL, Gemma 4 e 3, gpt-oss, Qwen2.5-Coder, Devstral, Mistral Small, Llama 3.3, DeepSeek-R1, Dolphin 3, Phi-4 mini) e o `orcarouter/Qwen3.8-27B-Uncensored`. **A lista de famílias é a única coisa curada** (em `FAMILIES`, em `scripts/colab-catalog.mjs`); qualquer outra etiqueta do Ollama, ou `hf.co/...`, vai em `modelo_manual`.

**De onde vêm os números (nenhum é digitado à mão):** `node scripts/colab-catalog.mjs --write` mede, para cada família:

| Dado | Fonte |
|---|---|
| ferramentas, visão, pensamento, áudio | as listagens do ollama.com (biblioteca e publicação da comunidade) |
| etiquetas, contexto, entrada (texto, imagem) | `ollama.com/<família>/tags` |
| tamanho exato do arquivo e do projetor de visão, quantização, versão mínima do Ollama, licença | o manifesto do registro (`registry.ollama.ai/v2/…/manifests/<etiqueta>`) |
| cache KV por token e contexto máximo | o cabeçalho GGUF do arquivo de pesos (requisição `Range` de 256 KiB): camadas, cabeças KV, tamanho da cabeça; híbridos (atenção completa a cada N camadas ou por camada), janela deslizante (o padrão do arquivo no Gemma 4; o padrão fixo do motor no Gemma 3 e no gpt-oss) |

Por etiqueta entram o tamanho padrão e **uma** versão `q8_0` (a de nome mais curto, que é a original: as outras são ajustes finos, versões "base" ou rascunhos de predição de vários tokens). Ficam de fora o que passa de 90 GB, o que exige um Ollama mais novo que o do notebook e os modelos com **atenção latente (MLA)**, como GLM-4.7-Flash e DeepSeek-V2/V3: a conta do cache deles é outra e eu não a modelei (use `modelo_manual`).

**A conta de encaixe:** pesos (arquivo + projetor) + cache KV (KiB por token × contexto, em f16) + a parte fixa das camadas de janela + **2 GiB** de folga, contra a VRAM **livre** que o `nvidia-smi` mostra. Para cada modelo escolhe-se a etiqueta mais pesada (a de maior qualidade) que cabe com **32k de contexto ou mais** (o prompt-base do Openclod tem ~9 mil tokens); o que só cabe com menos aparece como "contexto curto: só conversa". **É uma estimativa conservadora:** a prova continua sendo o `ollama ps` (100% na GPU) ao carregar. Os que quase cabem aparecem no fim, com quanto faltou.

**Conferência no registro a cada execução:** a etapa 2 pergunta ao registro do Ollama (em paralelo, no máximo 25 s) se cada etiqueta da lista ainda existe. A que sumiu aparece com "[não está mais no registro do Ollama]" e, se foi a que você escolheu, a etapa 4 para dizendo isso. Sem rede, a lista vale pelo catálogo.

**Sem censura, com honestidade:** são modelos abertos publicados; o notebook só os lista e roda se você pedir. Recusam menos do que o modelo original, mas a qualidade e o uso de ferramentas variam (muitos não declaram ferramentas e só servem para conversar: o notebook avisa e o app mostra "o Openclod não poderá usá-lo como agente" na confirmação do código), e o uso é por sua conta. **O modo automático nunca escolhe um deles.**

**Escolha por tipo (`tipo_de_modelo`):** o modelo com mais parâmetros do tipo (lidos do nome; nos MoE contam ~35%), com ferramentas primeiro e contexto de agente primeiro; "leve e rápido" = até 6 GB de arquivo, sem os sem censura. As duas melhores opções seguintes entram se a primeira não carregar 100% na GPU.

**Atualizar o catálogo:** `node scripts/colab-catalog.mjs --write` (precisa de internet; `--cache <pasta>` guarda o que baixa) e depois os testes. O bloco `# <catalogo-gerado>` do módulo é reescrito; um teste confere que ele só tem linhas nesse formato, e outro, que os modelos da escolha automática estão nele com o mesmo tamanho.

### 4.3 Túnel: Cloudflare quick tunnel

A [documentação dos Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) (atualizada em 2026-09-30) diz: sem garantia de disponibilidade; **200 requisições simultâneas** (acima disso, HTTP 429); **"não suportam Server-Sent Events (SSE)"**; o endereço muda a cada execução; "para testes e desenvolvimento". O que **medi** nesta máquina, com o `cloudflared 2026.10.5` oficial (SHA-256 conferido) e um cliente `fetch` do Node (o mesmo do harness):

| Teste | Resultado |
|---|---|
| `GET` com `text/event-stream`, `application/x-ndjson` ou `text/plain` em pedaços, com ou sem `Accept`/`Authorization` | **Bufferizado**: tudo chega de uma vez no fim (≈5 s para 12 eventos de 400 ms) |
| `POST` com os mesmos três tipos de conteúdo | **Em fluxo**: primeiro byte em ≈160 ms, 10 a 13 pedaços espalhados no tempo real |
| 5 `POST` seguidos e 6 `POST` simultâneos | todos em fluxo, o mesmo comportamento |
| `POST` de 6 MB (uma imagem em base64) | passou íntegro |
| `POST`/SSE com comentário `: ping` a cada 10 s por **120 s** | passou até o fim |
| `POST` que manda os cabeçalhos e depois fica **115 s sem nenhum byte** | passou (o byte final chegou aos 115 s) |
| O módulo do notebook por trás de um túnel real, com o autoteste do próprio notebook pelo endereço público `https://….trycloudflare.com` | texto, **28 pedaços de SSE (o primeiro em 0,6 s)**, 2 imagens, ferramenta em stream: tudo passou em 25 s (seção 9) |

Conclusões: (1) o `chat/completions` é POST, então **o streaming funciona**; um GET com SSE (`EventSource`) não funcionaria. (2) É comportamento **não documentado**: a doc diz o contrário. Por isso o servidor nunca depende de GET para streaming e o harness sempre usa POST. (3) Não testei uma resposta sem **nenhum** cabeçalho por mais de 100 s; o servidor evita essa situação enviando os cabeçalhos antes (2,5 s). (4) Não testei o `cloudflared` **Linux** nem o Colab (só o build Windows do mesmo `2026.10.5`).

Quando o túnel cai, o que o cliente recebe (capturado, e usado nos testes como fixture em `tests/fixtures/colab/`):

| Situação | Resposta real |
|---|---|
| processo do túnel encerrado (a sessão do Colab acabou) | **HTTP 530**, página HTML "Cloudflare Tunnel error, Error 1033" (estável por 20 s+, não se recupera) |
| túnel de pé, servidor parado | **HTTP 502**, HTML "Bad gateway" do `trycloudflare.com` |
| nome que nunca existiu | sem HTTP: `ENOTFOUND` |

### 4.4 Como o botão "abre o Colab com o código pronto"

O Colab abre notebooks por GitHub, Drive ou upload; **não aceita o conteúdo do notebook na URL**. Caminhos considerados:

| Caminho | Atrito | Decisão |
|---|---|---|
| Gerar o `.ipynb` numa pasta visível, abrir o Colab, mostrar o arquivo e copiar o caminho; o usuário faz *Arquivo → Fazer upload* | 2 passos no Colab | **Escolhido**: não publica nada, e o notebook leva os metadados que pedem GPU (`accelerator: GPU`, `gpuType: T4`). Se a GPU não vier, a 1ª célula diz o que clicar. |
| Abrir um notebook novo e colar uma célula única da área de transferência | colar + trocar a GPU à mão | Mais atrito (o notebook novo vem sem GPU) |
| GitHub (`colab.research.google.com/github/...`) ou Drive | 1 clique | **Só com a sua autorização**: exige publicar o notebook em um repositório ou na sua conta. Quando o Openclod tiver um repositório público, o botão pode apontar para lá. |

Não consegui confirmar na documentação do Google que o Colab respeita `accelerator: GPU` ao abrir um notebook enviado (é prática da comunidade, não especificação). Por isso o notebook **não depende disso**. (Provado depois, no Colab real: a T4 já veio selecionada. Seção 9.2.)

### 4.5 A pausa para escolher o modelo (notebook 1.2.0)

Pedido do usuário, depois de rodar o 1.1.0 num Colab real: "Faça no próprio Colab: a etapa 2 mostra a lista e para com uma caixa de seleção e um botão "Usar este modelo"; se eu não escolher em 2 minutos, segue com o automático. Só depois baixa." (No 1.1.0 a etapa 2 imprimia a lista e **já seguia** com o automático: para escolher, eram duas execuções com `somente_listar_modelos`.)

**O que acontece.** Depois de imprimir a lista e conferir o registro, `step_plan` mostra na saída da célula uma caixa com: o **automático** (primeiro e já selecionado), todos os modelos da lista agrupados por tipo e **com a mesma numeração** da lista impressa (o que o registro do Ollama disse que não existe mais fica de fora), e, em cada linha, tamanho, contexto, capacidades e "sem ferramentas: só conversa" / "contexto curto: só conversa". Sob o modelo selecionado aparecem a etiqueta, a licença e os avisos: sem ferramentas, contexto curto e, nos sem censura, "Modelo da comunidade sem as recusas do original: a qualidade, o uso de ferramentas e a origem dos pesos não foram auditados pelo Openclod, e o uso é por sua conta." Depois, o botão **Usar este modelo** e a contagem regressiva (2:00) com uma barra. A célula **espera**. Clique: segue com aquele modelo, exatamente como se você tivesse preenchido `numero_da_lista` (modelo escolhido por você: nunca é trocado em silêncio; sem ferramentas, avisa e segue). Sem clique em `segundos_para_escolher` (120), segue com o automático. Só depois disso a etapa 3 em diante baixa alguma coisa.

| Desfecho | O que o notebook faz e diz |
|---|---|
| Clique num modelo da lista | "Você escolheu o n.º N: nome (quantização)." e roda esse |
| Clique com o automático marcado | "Você confirmou o modelo automático (…)." |
| Ninguém clica no prazo | a caixa mostra "Tempo esgotado…" e a saída diz "Ninguém escolheu em 2 minutos: seguindo com o automático (…)." |
| O navegador não responde (aba fechada; ambiente que não mostra a caixa) | o Python desiste 30 s depois do prazo da caixa, desativa a caixa ("O notebook parou de esperar por esta escolha.") e segue com o automático, dizendo isso |
| Erro ao mostrar a caixa (o Colab devolve erro, `eval_js` antigo sem `timeout_sec`, sem IPython) | "Não consegui mostrar a caixa de escolha (motivo): seguindo com o automático" |
| Você para a célula enquanto ela espera | a caixa é desativada e a interrupção passa (a célula para) |
| `modelo_manual`, `numero_da_lista` ou `tipo_de_modelo` preenchido, `somente_listar_modelos`, `segundos_para_escolher = 0`, ou fora do Colab (CLI `run`, testes) | **não pergunta** (a célula 4 rodada sozinha também não) |

"Executar tudo" continua funcionando sem ninguém clicar: a espera tem prazo (120 s; no máximo 600 s no formulário), e o que a faz terminar nunca é um `input()` ou `getpass` (um teste do notebook proíbe os dois).

**Como é feito, e o que li no código público do Colab** (`googlecolab/colabtools`, ramo `main`):

- `google.colab.output.eval_js(script, ignore_result=False, timeout_sec=None)` manda um pedido `cell_javascript_eval` ao navegador e **bloqueia lendo a resposta pelo canal de entrada do kernel** (`_message.read_reply_from_input`, a cada 25 ms). Com `timeout_sec`, **vencido o prazo ela devolve `None`** (não levanta erro); um erro do navegador levanta `MessageError`. É isso que deixa uma célula esperar um clique sem prender a execução: o prazo do Python é o da caixa **mais 30 s** (`CHOICE_GRACE_SECONDS`), então uma aba fechada ou congelada não segura o notebook.
- O próprio Colab desenha elementos na saída com `display(Javascript(...))` (`output._util.serve_kernel_port_as_iframe`) e usa `eval_js` com funções imediatas (`output._js_builder`). A caixa usa esse par: `display(Javascript(CHOICE_JS))` só **define** `window.openclodEscolher` (nada é desenhado nem fica salvo na saída do notebook além dessa definição, então reabrir um notebook salvo não deixa uma caixa morta) e `eval_js("window.openclodEscolher({...})")` a chama; ela monta a caixa e devolve uma Promise que resolve no clique, no fim da contagem ou quando o Python manda cancelar. O resultado é o texto JSON `{"quem": "usuario"|"tempo", "numero": N}` (N = 0 é o automático) e é validado contra os números da lista.
- Todo texto entra na tela por `textContent` (nada de `innerHTML`), os dados vão como JSON, a caixa não usa rede nem armazenamento, e a contagem usa o relógio (`Date.now()`): uma aba em segundo plano roda os timers mais devagar, mas o prazo não estica.

**O que o Colab real provou (T4, 2026-10-27, no Chrome do usuário) e o que não.** O lado Python do Colab é público e foi lido; o do navegador não é, então isto só uma execução real mostra. **Provado:** a caixa **aparece** na saída da célula 2 (depois da lista e de "Conferi no registro do Ollama: 97 etiquetas existem, 0 não."), com o automático marcado, os grupos, a etiqueta e a licença do modelo selecionado e a contagem andando (marcou 1:40 com a célula em execução havia ~24 s); a célula **ficou esperando** (status "Em execução"); o usuário selecionou o n.º 59 (Gemma 4 abliterated E4B, sem censura) e clicou em *Usar este modelo*: a caixa mostrou "Escolhido: 59 · …" com o botão desativado, a célula terminou em 1 min e o notebook seguiu para a célula 3. Ou seja, o `eval_js` do Colab **espera a Promise** da caixa e a resposta **chega ao Python**. Também provado: `segundos_para_escolher` aparece como campo numérico no formulário do Colab e o `private_outputs` vale (o Colab avisou "este notebook está aberto com saídas particulares: elas não serão salvas"). **Não provado:** o desfecho do **tempo esgotado** (o usuário clicou antes dos 2 minutos), "Executar tudo" sem ninguém clicar, e as etapas 4 a 7 com um modelo escolhido na caixa (o usuário assumiu as células a partir da 3). Também não li o texto que o Python imprimiu depois do clique: a saída da célula estava recolhida.

## 5. Limites e termos do Colab

Lido em 2026-10-27: [FAQ do Colab, "Which activities are restricted in Colab?"](https://research.google.com/colaboratory/faq.html) e [Termos de uso v6](https://research.google.com/colaboratory/tos_v6.html). O FAQ diz que os termos incluem essas restrições.

- **Em todos os planos (pagos também):** é proibido oferecer "arquivos, mídia ou outros **serviços web não relacionados à computação interativa** com o Colab" e "**conectar-se a proxies remotos**" (além de torrents, mineração, ataques, quebra de senhas, várias contas para driblar limites, deepfakes e uso de contêineres para driblar as políticas antiabuso).
- **No plano gratuito, sem saldo de unidades de computação positivo** (e "podem ser encerradas a qualquer momento, sem aviso"): controle remoto (SSH, área de trabalho remota), **"usar o Colab principalmente por uma interface web em vez do notebook"**, treino de xadrez, workers de computação distribuída. O FAQ diz que um plano pago com saldo positivo remove *estas* restrições e que "nem todos os ambientes que se encaixam nas descrições são encerrados".
- **Termos:** é proibido "vender, alugar ou de outro modo dar acesso direto ou indireto ao Colab a terceiros". Por isso: **use só para você e não compartilhe o código de conexão.**
- **Recursos:** não são garantidos nem ilimitados; os limites de ociosidade, a vida máxima da VM e os tipos de GPU variam. No plano gratuito um notebook roda **no máximo 12 h**; no Pro+, até 24 h com unidades suficientes; a ociosidade só conta quando nenhum código está em execução (o painel do notebook é uma célula em execução).

**O que isso significa aqui (leitura minha, não parecer jurídico):** um servidor de LLM consumido de fora por um túnel se parece com "serviço web" e "proxy remoto" (todos os planos) e, no plano gratuito, com "interagir principalmente por uma interface web" (a interface passa a ser o Openclod, não o notebook). O Google não publica como detecta nada. **Não implementei nada para driblar limites ou detecção**: sem cliques automáticos, sem truques para manter a sessão, sem várias contas; o painel é só código em execução na célula.

**Alternativas, sem esconder o risco:**

1. **Plano pago do Colab com saldo positivo** (remove as restrições do plano gratuito; não as gerais).
2. **GPU alugada em um serviço que permita servir modelos** (confira os termos dele). O mesmo servidor roda em qualquer Linux com GPU NVIDIA: `OPENCLOD_COLAB_DIR=~/openclod python openclod_llm_server.py run` faz tudo o que o notebook faz e imprime o mesmo código. O Openclod não sabe (nem precisa saber) onde o servidor roda.
3. **Seu próprio computador com GPU** + Ollama (já suportado como provedor "Ollama (local)").
4. O **Colab CLI oficial** ([googlecolab/google-colab-cli](https://github.com/googlecolab/google-colab-cli)) provisiona runtimes e executa código pelo terminal; hoje só **Linux e macOS** (Windows não é suportado) e exige login Google. Não o usei.

## 6. Segurança

- **A chave** (`occ_…`, 192 bits) nasce no notebook, vale só naquela execução e **só existe no código de conexão** e como `Bearer` nas chamadas. Nunca vai para log nem para o painel; o Ollama e o `cloudflared` não a recebem.
- **O código de conexão é uma senha.** No app a caixa fica **mascarada** (botão "Mostrar"); o app o lê uma vez e guarda a chave no **cofre do Windows** (`secret:colab`, o mesmo cofre das chaves dos outros provedores). O `settings.json` guarda só a referência; o E2E varre o perfil inteiro (configurações, logs, dados; UTF-8 e UTF-16) atrás da chave e do código e **não encontra**. No Colab, as saídas do notebook podem ser salvas no seu Drive junto com o código: como a chave morre com a sessão, o estrago é limitado, mas não compartilhe o notebook executado.
- **Confirmação antes de conectar.** A verificação do código (8 hex do SHA-256) só pega colagem cortada ou com um caractere errado: **não é assinatura**. Um código aponta para onde quiser, então o app mostra **servidor, modelo, GPU, imagens, ferramentas, contexto e versão** e exige o clique em **Conectar**; avisa se o endereço não é `*.trycloudflare.com`, se o notebook não é idêntico ao que esta versão gera ("não confere") e se o código tem mais de 12 h. Aceita só `https://` (e `http://127.0.0.1`, para teste), sem usuário/senha, sem IP numérico.
- **Sem deep link `openclod://`.** Um link que conecta sozinho apontaria o harness para um servidor de terceiros, que receberia o código e os arquivos das conversas. O padrão é colar o código e confirmar.
- **Nada é publicado em seu nome.** O botão não toca GitHub, Drive nem gists.
- **Cadeia de suprimentos:** Ollama e `cloudflared` vêm de releases oficiais do GitHub, em versão fixa e com SHA-256 conferido **antes** de executar (um hash diferente apaga o arquivo e para). Não há `curl | sh`. Os pesos do modelo vêm do registro do Ollama, que confere os próprios blobs; o notebook não fixa o hash deles.
- **Privacidade:** o que o agente lê e escreve passa pela VM do Google e pelo túnel da Cloudflare (o TLS termina na borda dela). Não use para dados que não podem sair do seu controle. O harness pode enviar imagens a este provedor para o relé de visão (ele entra na lista dos que leem imagens): tire-o da reserva em *Ordem da reserva* se não quiser.

## 7. No harness

- `src/core/colab/connection-code.ts`: lê e escreve o código (`OCLC1.<payload>.<verificação>`, JSON compacto em base64url), tolera espaços, quebras de linha e texto em volta, recusa versões, endereços e campos inválidos. O Python (`make_connection_code`) e o TypeScript produzem **os mesmos bytes**.
- `src/main/colab.ts` (`ColabService`): `prepare` (o botão; devolve também nome e tamanho do arquivo para o item arrastável), `notebookFile`/`revealNotebook` (só o notebook que o botão gravou pode ser arrastado ou mostrado: a página nunca diz qual caminho), `inspect` (a confirmação, sem rede e sem gravar nada), `connect` (revalida, pergunta ao servidor, grava a chave no cofre e cria o provedor com a visão, as ferramentas e a janela que o **servidor** informou), `status` (a saúde) e `disconnect` (apaga provedor e chave, e tira o Colab da reserva e dos seletores).
- Arquivo arrastável (`ColabCard.tsx` + `src/main/index.ts`): o item do cartão é `draggable`; no `dragstart` a página cancela o arrasto do navegador e manda `colab:drag-start` (um `send`, sem resposta: o Electron só aceita iniciar o arrasto nativo enquanto o `dragstart` roda); o processo principal chama `event.sender.startDrag({ file, icon })` com o notebook gravado e o ícone do app. Soltar sobre a área "ou arrastar um arquivo até aqui" da janela *Fazer upload de notebook* do Colab entrega o arquivo.
- Saúde (`src/core/colab/link.ts`): um `GET /v1/models` com a chave separa **conectado**, **caiu** (túnel, nome expirado, recusa de conexão, tempo esgotado, página que não é do servidor), **chave recusada** (o notebook foi reiniciado) e **com problema** (o servidor está de pé mas o motor não). "Caiu" e "chave recusada" são marcadas no registro de saúde compartilhado, então **a reserva pula o Colab sem gastar um pedido**; a marca some sozinha quando ele volta.
- Falha no meio da conversa (`src/core/providers/tunnel.ts` + `http.ts`): as páginas HTML 530/1033 e 502 do túnel são classificadas como **`network`** (a conta toda, não só um modelo), a mensagem vira "O túnel do Google Colab não respondeu…" em vez de 6 KB de HTML, e **não se tenta de novo** (um túnel desses não volta sozinho).
- Reserva (`chain.ts`/`reserve.ts`): o candidato Colab ganha uma sondagem autenticada de 2,5 s (a porta do túnel responde TCP mesmo com o notebook morto). O Colab entra no fim da ordem; mude em *Ordem da reserva*. O relé de visão o usa como qualquer provedor com `visionModels`.
- IPC: `colab:prepare|inspect|connect|status|disconnect|reveal|drag-start`. O código colado nunca é registrado em log.
- Teste do app sem tocar no seu navegador: `OPENCLOD_E2E_OPEN_LOG=<arquivo>` troca "abrir o navegador / mostrar a pasta / copiar o caminho / arrastar o arquivo" por linhas JSON nesse arquivo (só o E2E define isso).

## 8. Arquivos

Novos: `resources/colab/openclod_llm_server.py` (o bloco `# <catalogo-gerado>` é escrito por `scripts/colab-catalog.mjs`), `src/core/colab/{connection-code,notebook,link,resource}.ts`, `src/core/providers/tunnel.ts`, `src/main/colab.ts`, `src/renderer/src/components/ColabCard.tsx`, `scripts/{ui-colab,ui-colab-real,colab-catalog}.{cjs,mjs}` (+ `scripts/colab-catalog.d.mts`), `tests/colab/test_openclod_llm_server.py`, `tests/colab-{connection-code,notebook,tunnel,service,reserve,server-python,catalog-script,choice}.test.ts` (o último roda a caixa de escolha num Chrome/Edge de verdade), `tests/support/{colab-python,fake-colab}.ts`, `tests/fixtures/colab/*` (inclui dois trechos reais de páginas do ollama.com), este relatório e `Prints/colab-2026-10-27/`.

Alterados (os arquivos já tinham mudanças não commitadas de outras frentes; as minhas são pontuais): `src/shared/{types,api}.ts`, `src/preload/index.ts`, `src/main/{index,orchestrator,reserve}.ts`, `src/core/providers/{http,chain}.ts`, `src/renderer/src/components/SettingsDialog.tsx`, `src/renderer/src/styles.css`, `CLAUDE.md`, `README.md`.

`resources/` entra inteiro no instalador (`extraResources` do `electron-builder.yml`), então `resources/colab/` vai junto sem configuração nova.

## 9. Provas

Tudo foi verificado com o app de verdade (Electron, perfil descartável, build congelado fora do `out/` do seu app) e com um **modelo real**. Nada foi gravado no seu perfil nem no seu app aberto; **nenhum commit foi feito**; o navegador, o Explorer e a área de transferência **não foram tocados** (o app registra o que abriria em um arquivo de teste). Além disso, **o notebook foi rodado uma vez num Colab de verdade** (GPU T4, no seu Chrome, com a sua autorização): ver as três últimas linhas da tabela abaixo e a seção 9.2.

### 9.1 O que foi provado aqui

| Verificação | Resultado (saída real) |
|---|---|
| `npm run typecheck` (dois projetos) | limpo |
| `npx vitest run` (suíte completa, com os testes novos) **139 arquivos, 1988 testes passam, 1 pulado, 0 falhas** (a suíte anterior a esta frente tinha 133 arquivos e 1878 testes passando, segundo `docs/PROVEDORES-E-RESERVA.md`; o aumento inclui o trabalho de outras frentes) |
| Testes novos do lado TypeScript | 6 arquivos: código de conexão (**25** testes, incluindo o contrato byte a byte com o Python), notebook (**21**, incluindo o **esquema oficial nbformat 4.5**, toda célula compilando com `ast` e as células rodando em ordem com uma GPU simulada), túnel caído e saúde (**19**, com as duas páginas reais da Cloudflare), serviço/cofre (**25**: a chave nunca aparece em `settings.json`, em log, na resposta nem em arquivo algum), reserva (**10**: Colab caindo no meio da conversa pela página 530 e pela 502, sondagem, chave recusada) e o envoltório do Python |
| Testes do módulo do servidor (Python, `unittest`) | **55 passam**: auth e rotas, SSE com cabeçalhos antecipados e pings, erro depois do fluxo aberto, o usuário apertando "parar", imagens contadas, autoteste (4 provas, incluindo modelo cego e modelo que não chama ferramenta), tabela por VRAM com a conta de memória de cada degrau, download com retomada e SHA-256 (achou e corrigiu um bug real: conexão cortada no meio era tratada como arquivo completo), código de conexão |
| **Os testes novos no código antigo** | numa cópia descartável com o comportamento anterior (sem a classificação de túnel caído, sem a sondagem do Colab), **9 testes falham**: `Prints/colab-2026-10-27/antes-testes-unitarios.txt` |
| Notebook gerado × esquema oficial | 0 erros no esquema nbformat 4.5 do [jupyter/nbformat](https://github.com/jupyter/nbformat) (11 células, 105 KB) |
| **Autoteste do notebook, modelo real** (Ollama local `qwen3.5:4b`, que lê imagens e usa ferramentas, atrás do servidor do notebook) | 7 de 7: lista com a chave, chave errada recusada (401), texto (`pong`), **streaming de 28 pedaços**, imagens (**vermelho** e **verde**) e **chamada de ferramenta em stream** `somar_numeros({"a":17,"b":25})`: `selftest-modelo-real-local.txt` |
| **O mesmo servidor atrás de um túnel Cloudflare de verdade**, com o autoteste do próprio notebook pelo endereço público `https://….trycloudflare.com` | 7 de 7 em **25 s**: o `parse_tunnel_url` do módulo achou o endereço no log real do `cloudflared`; SSE com o 1º pedaço em **0,6 s** e 28 pedaços; imagens **azul** e **verde**; ferramenta em stream: `selftest-tunel-publico.txt` |
| Medições do SSE no quick tunnel e respostas reais quando ele cai | `tunel-medicoes-streaming.txt` e `tunel-caido-respostas-reais.txt` (seção 4.3) |
| **E2E no app real, com um túnel Cloudflare de verdade** (`node scripts/ui-colab.cjs --tunnel <cloudflared.exe> --label tunel`) | **47 de 47** (`tunel-ui-colab.json`, capturas `tunel-*.png`); o código de conexão tinha 341 caracteres |
| **E2E no app real, dublê local** (`node scripts/ui-colab.cjs`) **48 de 48** (`depois-ui-colab.json`, capturas `depois-*.png`): mesmo roteiro, com o servidor do notebook em `http://127.0.0.1` (a confirmação marca "este computador (teste)") e a queda simulada com a página 530 **real capturada** (fixture); 1 tentativa do modelo; sessão real de 75 s e troca para a reserva em 30 s |
| **O notebook num Colab de VERDADE** (GPU **Tesla T4** de 15 GB, no seu Chrome, "Executar tudo" **uma vez**) | Do clique ao código de conexão: **≈ 9 a 10 min**. GPU conferida; modelo escolhido pela tabela (**Qwen3.5-9B em Q8_0, 64k de contexto**); Ollama 0.40.11 instalado em **39 s** com o SHA-256 conferido; modelo de 9,7 GB baixado a ~150 MB/s e carregado: **100% na GPU, 11,7 de 15 GB**; `cloudflared` Linux baixado (38,4 MB) e túnel aberto em **35 s**; autoteste **pelo endereço público do túnel: 7 de 7** (SSE com o 1º pedaço em **0,4 s** e 28 pedaços em 1,9 s; imagens vermelho e verde; ferramenta em stream `somar_numeros({"a":17,"b":25})`): `real-colab-saida.txt` e capturas `real-colab-01` a `04` |
| **O app (perfil descartável) conectado a esse Colab real** (`node scripts/ui-colab-real.cjs --code-file …`) | Colou o código **real**; a confirmação mostrou "túnel do Colab", `qwen3.5:9b-q8_0`, Tesla T4 (15 GB), lê imagens, ferramentas, 65.536 tokens e "notebook v1.0.0 · ollama 0.40.11 · **original**"; conectou (resposta em 271 ms); provedor com a visão, as ferramentas e o contexto que o **servidor** informou; chave só no cofre (em **nenhum** arquivo do perfil); apareceu no seletor sem reiniciar; **sessão real**: o modelo da GPU do Colab **viu** o quadrado verde e **chamou `write_file`** (1 tentativa); o servidor contou **2 pedidos, 2 imagens, 25.042 tokens lidos e 124 gerados, 0 erros**, igual ao painel do Colab. **22 de 22** verificações dessa parte ao vivo: `real-ui-colab-real-saida.txt`, `real-03` a `real-07` |
| **O túnel do Colab depois de "Desconectar e excluir o ambiente de execução"** | A VM ainda respondeu **cerca de 1 min** depois do clique (200), depois **502** e **530** (página "Cloudflare Tunnel error", 7.736 bytes), que o classificador do app reconhece como túnel caído: `real-colab-tunel-depois-de-excluir-o-runtime.txt`. **Não observado de ponta a ponta:** a reserva assumindo no meio de uma conversa com o Colab real sendo recolhido. A tentativa caiu nessa corrida (o Colab ainda respondia, as 2 verificações da queda **falharam** e o roteiro parou); o roteiro agora espera o túnel parar de responder, mas essa correção **não foi rodada** contra um Colab vivo (a execução real foi uma só). A queda em si segue provada pelos testes e pelo E2E com a borda real da Cloudflare (linha do `--tunnel` acima) |

O que o E2E faz, em app real: clica no botão (gravou o notebook em pasta visível, pede GPU, e cada célula de código compila); confere os 5 passos; rejeita código cortado, alterado ou que não é código; cola um código **feito pelo módulo do notebook** (quebrado em linhas, como uma cópia embrulhada) e mostra a confirmação (servidor com a etiqueta "túnel do Colab", modelo, GPU, imagens, ferramentas, contexto, notebook "original", aviso de que a conversa passa pelo servidor), com a caixa **mascarada** e a chave em lugar nenhum da tela; conectar não deixa a chave nem o código em **nenhum arquivo** do perfil (UTF-8 e UTF-16); o provedor aparece no seletor de modelo **sem reiniciar**; uma **sessão real** manda uma imagem, o modelo a lê e **chama `write_file`** pelo servidor (o servidor contou **3 pedidos, 3 imagens, 37 224 tokens lidos, 273 gerados, 0 erros**); o túnel é **derrubado** (a borda real da Cloudflare passa a responder a página 530) e **a reserva assume no meio do turno**, com a linha na conversa "Google Colab (GPU)/qwen3.5:4b falhou (network: sem conexão); continuando com Ollama (local)/qwen3.5:4b…", o histórico preservado e o modelo da reserva respondendo sobre o arquivo criado antes; o cartão mostra "caiu" com a mensagem em português; uma conversa **nova** pedida no Colab caído já nasce na reserva; **reconecta** com um túnel novo (outro endereço, outra chave) em um passo; **fecha e abre o app** e o Colab segue conectado; **desconecta** (pede segunda confirmação, apaga provedor e chave).

Tentativas do modelo no passo da sessão real: o modelo é um 4B local, e em rodadas anteriores (antes do roteiro final) ele uma vez **disse** que criou o arquivo sem chamar a ferramenta e outra vez escreveu a cor errada para um quadrado verde; por isso o roteiro agora insiste até 3 vezes, **registra quantas** (`attempts`) e confere no servidor que a imagem chegou (`images`). Na rodada final foi **1 tentativa**.

Capturas em `Prints/colab-2026-10-27/` (`tunel-*.png` com o túnel real; `depois-*.png` com o dublê local): `01-cartao-antes`, `02-passos-apos-o-clique`, `03-codigo-colado-e-confirmacao`, `04-conectado`, `05-cartao-do-provedor`, `06-seletor-de-modelo`, `07-sessao-com-imagem-e-ferramenta`, `08-cartao-caiu`, `09-reserva-assumiu-na-conversa`, `10-reconectado`, `11-desconectado`.

Como rodar de novo (sem tocar no seu app): `npx electron-vite build --outDir "%TEMP%\openclod-build-colab"`, `node scripts/snapshot-app.cjs colab --from "%TEMP%\openclod-build-colab"`, `node scripts/ui-colab.cjs --root <pasta do snapshot>` (idem com `--tunnel <cloudflared.exe> --label tunel`; precisa do Ollama local com `qwen3.5:4b`). Testes: `npx vitest run tests/colab-*.test.ts` e `python -I tests/colab/test_openclod_llm_server.py`.

Contra um **Colab de verdade** (o código de conexão vem do seu notebook; o roteiro o lê de um arquivo, **nunca o imprime**, cobre o endereço do túnel nas capturas e não escreve o código no relatório): copie a linha do código para um arquivo e rode `node scripts/ui-colab-real.cjs --root <pasta do snapshot> --code-file <arquivo>`. Com `--drop-signal <arquivo>` ele para depois da sessão ao vivo, escreve `<arquivo>.ready` e espera você parar o runtime do Colab (*Ambiente de execução → Desconectar e excluir o ambiente de execução*) e criar `<arquivo>`; aí espera o túnel parar de responder e confere que a reserva (o Ollama local) assume. Apague o arquivo do código depois: o código vale só enquanto o runtime existir.

**Arquivo arrastável e catálogo de modelos (notebook 1.1.0), provados sem o Colab:**

| Verificação | Resultado (saída real) |
|---|---|
| **O arquivo arrastável, no app real** (`node scripts/ui-colab.cjs`, rodada completa com o modelo local: **51 de 51**, sessão real com imagem e ferramenta em 1 tentativa, queda e reserva incluídas) | O cartão mostra o notebook como item (`openclod-servidor-llm.ipynb`, 173 KB, versão, caminho, "Arraste para o Colab", `draggable`), o primeiro passo manda arrastar, o `dragstart` pede ao processo principal o arrasto nativo **só do notebook gravado** e "Mostrar na pasta" mostra o arquivo de novo: `arrastar-ui-colab.json`, captura `arrastar-02-passos-apos-o-clique.png`. **Não exercitado:** o arrasto nativo do Windows soltando o arquivo numa janela do navegador (o E2E dispara o `dragstart` e confere o pedido ao processo principal; soltar de verdade exige o mouse entre duas janelas). 5 testes do serviço (`notebookFile`, `revealNotebook`, só o notebook gravado) |
| **O gerador do catálogo** (`node scripts/colab-catalog.mjs`) | Mediu **306 etiquetas de 161 modelos em 61 famílias** no registro do Ollama (manifesto + cabeçalho GGUF por `Range`) e nas páginas do ollama.com; pulou o que passa de 90 GB e os de atenção latente (`catalogo-gerador-resumo.txt`). 24 testes sem rede (`tests/colab-catalog-script.test.ts`): cabeçalho GGUF escrito à mão, o cache KV por arquitetura (denso, híbrido, janela deslizante do Gemma 3 e do gpt-oss, padrão explícito do Gemma 4, MoE), trechos reais das páginas do site |
| **Os testes do módulo** (`python -I tests/colab/test_openclod_llm_server.py`) | **81 passam** (eram 56) no Python 3.10, **3.12 e 3.14**: linhas do catálogo bem formadas e únicas, modelos sem censura marcados e só eles, os modelos da escolha automática no catálogo com o mesmo tamanho (±12%), a conta de encaixe, **cada modelo listado cabe no maior contexto possível** e a numeração é contínua em 8 classes de GPU (6 GB a 96 GB), GPU maior nunca lista menos, escolha por número (não troca o modelo), por tipo e por etiqueta, conferência no registro (404 × falha de rede × lentidão), e a política do `step_model` com o motor trocado (modelo escolhido sem ferramentas segue com aviso; o automático pula; o escolhido que não cabe para; contexto menor do mesmo modelo; etiqueta que sumiu do registro) |
| **O notebook rodando as células 1 a 2 com uma GPU simulada** (`tests/colab-notebook.test.ts`, 29 testes) | A etapa 2 imprime a lista por tipo, numerada, com o sem censura, os "quase cabem" e a marca do modelo que vai rodar; GPU maior lista mais; `numero_da_lista`, `tipo_de_modelo` e `somente_listar_modelos` funcionam; número que não existe para com a mensagem certa; o formulário e o esquema nbformat 4.5 seguem válidos |
| **As etapas 1 e 2 de verdade nesta máquina** (nvidia-smi real: RTX 2060; **registro real**) | 2,2 s: a lista saiu (26 de 161 cabem em 4,2 GB livres) e o registro respondeu para as **26 etiquetas, todas existentes**: `catalogo-etapa2-gpu-real-desta-maquina.txt`. A lista de uma T4: `catalogo-lista-t4.txt` (97 modelos); contagens por GPU: `catalogo-contagens.txt` |

**A pausa para escolher o modelo (notebook 1.2.0, seção 4.5), provada sem o Colab:**

| Verificação | Resultado (saída real) |
|---|---|
| **A caixa num Chrome de verdade** (`tests/colab-choice.test.ts`, 10 testes; com `OPENCLOD_COLAB_CHOICE_SHOTS=<pasta>` ele salva as capturas `escolha-1` a `escolha-5`) | O mesmo JavaScript que o módulo manda ao Colab: a definição é carregada como o `display(Javascript)` faz e a chamada roda como o `eval_js` faz (o teste espera a Promise); só o `google.colab.output.setIframeHeight` é falso. Numa T4 mostra o automático selecionado e os **97 modelos em 7 grupos** (98 opções), o botão e a contagem "2:00". Os avisos de **sem censura** e de **sem ferramentas** aparecem ao selecionar. O clique devolve o número escolhido. Com o **relógio acelerado do navegador**: 30 s depois a contagem marca cerca de 1:30 e a barra cerca de 75%; passados os 120 s a caixa responde `tempo` sozinha. Um clique depois do prazo não muda nada; `cancelar` (o Python desistiu de esperar) desativa a caixa; texto com `<img onerror>` nos nomes, avisos e detalhes vira só texto; a definição sozinha não desenha nada (reabrir um notebook salvo não deixa caixa morta). A chamada tem ~19 KB e a definição 5,5 KB |
| **Os testes do módulo** (`python -I tests/colab/test_openclod_llm_server.py`) | **104 passam** (eram 81) no Python **3.10, 3.12 e 3.14**. Os 23 novos usam um `eval_js` falso: a caixa lista o que a lista impressa lista, com os mesmos números, grupos e avisos; a resposta (texto JSON ou objeto) é lida e qualquer outra coisa é recusada; cada desfecho (escolheu, confirmou o automático, tempo, sem resposta, erro do Colab, `eval_js` antigo sem `timeout_sec`, sem IPython, interrupção da célula) e o que faz com o plano; o prazo do Python é o da caixa + 30 s; a caixa sem resposta é desativada; **não pergunta** com `modelo_manual`, `numero_da_lista`, `tipo_de_modelo`, `somente_listar_modelos`, `segundos_para_escolher = 0`, fora do Colab, na célula 4 rodada sozinha e na CLI |
| **O notebook rodando as células 1 a 2** (`tests/colab-notebook.test.ts`, 34 testes) com uma GPU simulada e um `google.colab` falso | No "Colab", a etapa 2 imprime a lista, **para na caixa** (o `eval_js` recebeu `timeout_sec=150`) e roda o modelo que o "usuário" escolheu ("Você escolheu o n.º N: Qwen3.5 4B (Q8_0)" → `-> qwen3.5:4b-q8_0`) ou o automático quando "ninguém escolhe"; com um campo do formulário preenchido a caixa não aparece; o formulário traz `segundos_para_escolher = 120`; a introdução explica a pausa; nenhuma célula usa `input()` nem `getpass` |
| **Os 8 arquivos de teste do Colab** e `npm run typecheck` | **153 testes passam** (eram 138 em 7 arquivos); typecheck limpo nos dois projetos |
| **E2E no app real** (`node scripts/ui-colab.cjs`, notebook 1.2.0) | **Incompleto.** Na 1ª rodada o app de teste foi fechado por fora no meio da reserva (nenhum processo Electron vivo depois; já tinha acontecido quando outra frente encerrou todos os `electron.exe`). Na 2ª, **41 verificações passaram**: cartão, arquivo arrastável, passos, confirmação com "notebook original v1.2.0", conexão, chave só no cofre, sessão real com imagem e `write_file` pelo servidor do dublê e a reserva assumindo com o histórico preservado. Ela parou no clique em **Testar agora** das Configurações: o botão nunca ficou estável e foi desmontado e remontado (`locator.click: Timeout 30000ms`). Esse passo não depende do que mudei aqui (o texto de um passo do cartão e a versão), e `SettingsDialog.tsx` e `styles.css` foram alterados às 16:24 por outra frente (não por esta), depois da última rodada completa (51/51, às 16:14), mas **não investiguei** a causa. As capturas `depois-01` a `07` e `09` foram regeradas com o 1.2.0; `08`, `10`, `11` e `depois-ui-colab.json` são da rodada anterior |

Capturas da caixa em `Prints/colab-2026-10-27/`: `escolha-1-caixa-aberta`, `escolha-2-aviso-sem-censura`, `escolha-3-escolhido`, `escolha-4-contagem`, `escolha-5-tempo-esgotado`.

### 9.2 O que só o Colab real prova (e o que ele provou em 2026-10-27)

Em 2026-10-27, com a sua autorização, o notebook foi rodado **uma vez** num Colab de verdade. A primeira tentativa, no painel do navegador do app, parou: ele estava sem login (`real-colab-painel-sem-login.jpg`; não digitei senha nem iniciei o login). Você pediu então o Chrome externo, onde já estava logado: enviei o notebook pelo campo de upload do Colab (ele ficou salvo no seu Google Drive), aceitei só o que era seu (nada de OAuth, Drive montado ou termos) e rodei **Executar tudo** na T4. Das cinco coisas que só o Colab real podia provar:

1. **A instalação no Ubuntu do Colab**: **provada**. Ollama 0.40.11 (`.tar.zst`, `zstd` do sistema) em 39 s com o SHA-256 conferido; `cloudflared` Linux baixado e túnel aberto em 35 s (protocolo `auto`: a saída para a Cloudflare funcionou).
2. **Se o modelo cabe 100% na GPU**: **provada só na T4**: Qwen3.5-9B em Q8_0, 64k de contexto, cache KV em f16 usa 11,7 de 15 GB, "100% do modelo na GPU", já na 1ª tentativa da tabela. **L4, A100 e o degrau de 24 GB com `OLLAMA_KV_CACHE_TYPE=q8_0` não foram testados** (a conta de KV continua estimativa para eles).
3. **Vazão e latência**: **parcial**. Pelo túnel, SSE com o 1º pedaço em 0,4 s e 28 pedaços em 1,9 s num prompt curto. O agente manda uns 12 mil tokens por pedido (25.042 tokens em 2 pedidos); o tempo de prefill disso na T4 **não foi medido isoladamente** (o roteiro desta rodada não gravou o tempo da sessão).
4. **Que o Colab honre `accelerator: GPU`**: **provada**. Ao abrir o arquivo enviado, o Colab já veio com a **T4** selecionada ("Conectar T4"), e "Executar tudo" conectou nela. Nenhum aviso de segurança apareceu (é um arquivo seu, no seu Drive).
5. **A reação do Google**: **nenhum aviso apareceu** em ~16 min. Isso **não diz nada** sobre uso prolongado ou repetido (seção 5).

**Custo observado.** A conta não tem assinatura, mas tem unidades de computação pagas. Com saldo positivo o Colab cobra a sessão: ele mostrou "taxa de uso aproximadamente 1,07 por hora" com a T4, e esta execução inteira gastou **cerca de 0,26 unidade** (~16 min). No modo gratuito (saldo zero) as restrições da seção 5 são as mais estritas.

**O que a execução real achou:**
- `ollama --version` no Linux imprime "Warning: could not connect to a running Ollama instance" e a versão vem como "Warning: client version is 0.40.11"; a linha "Ollama pronto" mostrou só o primeiro aviso. **Corrigido** (`engine_version_text`, com um teste que usa o texto do Colab).
- O Colab imprime o valor da última linha de cada célula: sobravam o dicionário da GPU, o do plano, o caminho do `ollama` e o endereço do túnel. **Corrigido** (as células terminam com `;`).
- Depois de "Desconectar e excluir o ambiente de execução" a VM continua respondendo cerca de **1 min**; depois o túnel devolve 502 e 530 (`real-colab-tunel-depois-de-excluir-o-runtime.txt`). Quem pergunta logo após parar o runtime ainda é atendido.
- Excluir o runtime **não limpa o notebook**: as saídas (com o código de conexão) ficariam salvas no Drive. As saídas foram limpas e o notebook salvo (conferido recarregando o arquivo: nenhuma célula tem saída). O histórico de revisões do Drive pode guardar uma versão antiga com o código, que **já não vale** (o runtime foi excluído).

**O notebook 1.2.0 no Colab real (2026-10-27, T4, no Chrome do usuário, com a autorização dele).** Subi o notebook por *Arquivo → Fazer upload do notebook* (um `.ipynb` gerado pela mesma função do botão do app, com `private_outputs: true` só nessa cópia: o gerador do produto não muda) e rodei as células Opções, Servidor, 1 e 2: o formulário mostrou o campo `segundos_para_escolher` (120); a célula 1 viu a **Tesla T4 (15 GB, 14,6 GB livres)**; a célula 2 imprimiu a lista de **97 modelos** (os mesmos 97 que a conta de uma T4 dá), conferiu o registro do Ollama (**97 etiquetas existem, 0 não**) e mostrou a caixa (o que aconteceu nela está na seção 4.5). A conta tinha **36,03 unidades de computação**, a taxa era de **≈1,07 por hora** e havia 1 sessão ativa. A partir da célula 3 o usuário assumiu o notebook e fez o resto à mão. Nenhum código de conexão passou por mim nem pela área de transferência.

**Segunda rodada do 1.2.0 (2026-10-27, T4, no Chrome do usuário, com a autorização dele, que liberou gastar unidades).** O pedido era trocar o Gemma 4 abliterated (que não chamava ferramentas no harness) pelo Qwen3.5 9B. Excluí o ambiente de execução antigo (*Ambiente de execução → Desconectar e excluir ambiente de execução*; com o cabeçalho do Colab recolhido, a seta ▾ no canto direito da barra o reabre) e rodei **Executar tudo** num ambiente novo, com as opções no padrão:

- **A caixa funcionou de ponta a ponta.** A etapa 2 imprimiu a lista e parou na caixa, com a contagem de 2 minutos (o "automático" já marcado era o Qwen3.5 9B Q8_0). Marquei a linha 1 e cliquei em **Usar este modelo**: a resposta chegou ao Python ("Modelo n.º 1 da lista, escolhido por você"), a caixa travou com "Escolhido: ... O notebook continua" e o notebook seguiu sozinho.
- **Tempos e memória.** Ollama pronto em ~35 s; modelo de 9,7 GB baixado a ~155 MB/s; **11,7 de 15 GB de VRAM, 100% na GPU, contexto 65.536** (a mesma medida da primeira execução); túnel respondendo; autoteste pelo endereço público com as cinco provas (texto, streaming, duas imagens e chamada de ferramenta em stream). Do **Executar tudo** ao código foram cerca de 9 min.
- **O código** apareceu na saída da célula 7 e o botão *Copiar código de conexão* funcionou (o texto mudou para "Copiado!" e a área de transferência ficou com o código inteiro, 369 caracteres). A saída dessa célula leva HTML (`display(HTML)`), então o Colab a desenha **num iframe**: um script na página do Colab não enxerga nem o código nem o painel (só as saídas de texto das células anteriores).
- **O app real do usuário** (perfil real, aberto por mim com `npm run dev -- --remoteDebuggingPort`) foi reconectado por um script (Playwright `connectOverCDP`) que leu o código de um arquivo temporário (apagado depois, com a área de transferência limpa): confirmação "notebook original v1.2.0", caixa mascarada, "Testar agora" = conectado em 0,3 s, chave só no cofre (`secret:colab`), `useAllModels` ligado (o Colab entra na reserva sozinho). Fechei o app em seguida (o que ficou salvo é a conexão).
- **A sessão real** (`node scripts/ui-colab-real.cjs`, perfil descartável) passou **25/25**: o modelo **viu a imagem e chamou `write_file`** (1 tentativa; 2 pedidos, 24.977 tokens de prompt, 94 gerados, 0 erros no servidor), o que o Gemma abliterated não conseguia. Capturas em `Prints/colab-2026-10-27/qwen35-9b-*` e `app-real-reconectado-qwen35-9b.png` (o endereço do túnel está mascarado).
- **Custo:** o saldo passou de 36,03 para 33,96 unidades desde a rodada anterior (inclui ~1h30 do Gemma, rodado pelo usuário); esta execução custou ≈ 0,3 unidade (≈ 20 min a ~1,07 por hora).
- **Ainda não provado no Colab real:** o caminho do **tempo esgotado** (a caixa sem clique, seguindo com o automático) e as outras GPUs (L4, A100).

**Roteiro de primeira execução (5 passos):** os da seção 2. Para me mandar a evidência, copie a saída das células 1 a 7 (o código de conexão **não**: ele contém a chave).

## 10. Solução de problemas

| Sintoma | O que fazer |
|---|---|
| "Este ambiente não tem GPU" | Colab: *Ambiente de execução → Alterar o tipo de ambiente de execução → GPU* e *Executar tudo* de novo. |
| A célula 3 ou 4 demora | Primeira vez: 5 a 15 min (≈1,5 GB do motor + o modelo). Há barra de progresso. Se parar, rode a célula de novo (o download retoma). |
| "Nenhuma das opções coube na GPU" | Use uma GPU maior, escolha outro número da lista da etapa 2 (um menor) ou preencha `modelo_manual` com um modelo menor (ex. `qwen3.5:4b`). |
| "O número N não está na lista desta GPU" | A lista depende da GPU que você recebeu (T4, L4, A100...). Marque `somente_listar_modelos`, rode tudo, veja os números e preencha de novo. |
| A etapa 2 esperou 2 minutos e rodou o automático, mas eu queria outro | O tempo da caixa acabou. Pare a execução, escolha o número na lista que ficou impressa (`numero_da_lista`) ou aumente `segundos_para_escolher` (até 600) e rode de novo. |
| A caixa de escolha não aparece e a saída diz "A caixa de escolha não respondeu" ou "Não consegui mostrar a caixa de escolha (…)" | O navegador não a mostrou (aba fechada ou em segundo plano, ou um ambiente que não é o Colab no navegador): o notebook seguiu com o automático. Para escolher assim mesmo, preencha `numero_da_lista` nas Opções. |
| Quero rodar sem ninguém olhando e sem esperar | `segundos_para_escolher = 0` nas Opções (vai direto no automático), ou preencha `numero_da_lista`, `tipo_de_modelo` ou `modelo_manual`. |
| "Nenhum modelo do tipo '…' cabe nesta GPU" | Use outro `tipo_de_modelo`, uma GPU maior ou digite uma etiqueta em `modelo_manual`. |
| "O modelo '…' não coube 100% na GPU deste ambiente, nem com contexto menor" | O que você escolheu é grande demais para esta GPU (a lista é uma estimativa conservadora, mas o `ollama ps` manda). Escolha um da lista com menos GB ou preencha `contexto_manual` com um valor menor. O notebook nunca troca o modelo escolhido em silêncio. |
| "A etiqueta '…' não existe no registro do Ollama" | O modelo saiu do registro desde que o catálogo foi gerado. Escolha outro número ou digite outra etiqueta. Para atualizar o catálogo: `node scripts/colab-catalog.mjs --write`. |
| O modelo escolhido "não declara chamada de ferramentas" | Ele roda só para conversar; o app avisa na confirmação do código que não poderá usá-lo como agente. Para agente, escolha um com "ferramentas" na lista. |
| O modelo diz "vou executar a ferramenta…" e escreve algo como `<execute_tool>computer_screenshot{monitor:2}</execute_tool>`, mas nada acontece | O modelo **escreveu a chamada como texto** em vez de fazer uma chamada de ferramenta de verdade, e o harness só executa as de verdade (o formato `<execute_tool>` é invenção do modelo). Acontece com modelos pequenos ou **sem censura** (visto em 2026-10-27 com o Gemma 4 abliterated E4B, mesmo com o Ollama declarando "ferramentas: sim" e o autoteste do notebook passando: o autoteste usa uma ferramenta só, o harness manda umas 30 e 10 mil tokens de instruções). Use o automático (Qwen3.5 9B, nº 1 da lista), que passou o mesmo teste do harness; deixe o sem censura para conversa. |
| "O túnel não subiu" / log do `cloudflared` | Rode a célula 6 de novo (o endereço muda). Se o ambiente bloqueia saída na porta 7844, este método não funciona nele. |
| "O autoteste falhou em: …" | Nenhum código é gerado. Rode a célula 7 de novo; veja o log do motor em `/content/openclod/ollama.log`. |
| O app diz "Isto não parece um código…" | Copie a linha inteira do final do notebook (use o botão Copiar). |
| "O código está incompleto: faltou o final" | A colagem foi cortada: copie de novo, do `OCLC1.` ao último caractere. |
| "O servidor não aceita a chave" (estado *chave recusada*) | O notebook foi reiniciado e gerou outra: cole o código novo. |
| "O túnel do Google Colab não respondeu" (estado *caiu*) | A sessão do Colab terminou (ociosidade, 12 h, cota, ou o Google a encerrou). Rode o notebook de novo e cole o código novo. O harness já terá passado para o próximo provedor da reserva. |
| O Colab "sumiu" da reserva | *Ordem da reserva* tem uma caixa para ele; um servidor marcado como caído volta sozinho quando responde de novo. |
| Quero tirar tudo | **Desconectar** no cartão apaga o provedor e a chave do cofre. O arquivo `.ipynb` em `Documentos\Openclod\Colab` é seu. |

## 11. Pendências e decisões

- **O notebook foi rodado num Colab de verdade em 2026-10-27 (T4)**: seção 9.2. **Falta:** L4 e A100 (e o degrau de 24 GB com cache KV em q8_0); a vazão em prompts longos; a **reserva assumindo no meio de uma conversa com o Colab real sendo recolhido** (a tentativa caiu na corrida de a VM ainda responder ~1 min depois de "Desconectar e excluir"; o roteiro `scripts/ui-colab-real.cjs` agora espera o túnel parar de responder, mas isso não foi rodado contra um Colab vivo); e o uso prolongado, que é onde o Google pode reagir.
- **O notebook 1.1.0 (catálogo, escolha por número e tipo, conferência no registro) foi rodado num Colab real em 2026-10-27, mas não por mim:** a sessão que me iniciou o executou numa T4 e me relatou que **97 de 161 modelos couberam, 39 deles sem censura, o autoteste deu 7/7 e o app conectou**. Eu não vi a saída, então registro isso como relato dela, não como prova minha. **Ainda sem prova num Colab real:** um modelo de fora da escolha automática (ex.: um sem censura) carregando 100% na GPU, o notebook parando em `somente_listar_modelos` e o formulário com `numero_da_lista` e `tipo_de_modelo` preenchidos (o relato não diz que foram usados).
- **O notebook 1.2.0 (a caixa de escolha da etapa 2, seção 4.5) foi rodado num Colab real em 2026-10-27, mas só até a célula 3** (seção 9.2): a caixa apareceu, a contagem andou e o clique do usuário no n.º 59 chegou ao Python. **Ainda sem prova num Colab real:** o desfecho do tempo esgotado (o usuário clicou antes), "Executar tudo" sem ninguém clicar e as etapas 4 a 7 com um modelo escolhido na caixa (o usuário assumiu as células a partir da 3 e fez o resto à mão; o resultado dele não está neste relatório). O custo é a taxa de ≈1,07 unidade por hora numa T4 (a conta tinha 36,03 unidades).
- **O catálogo é uma estimativa de memória, não uma garantia:** a conta (pesos + cache KV + 2 GiB) é conservadora e o `ollama ps` decide ao carregar. Os modelos com atenção latente (MLA: GLM-4.7-Flash, DeepSeek-V2/V3), os acima de 90 GB e os que exigem um Ollama mais novo que o do notebook **não estão no catálogo** (use `modelo_manual`). A lista de famílias é curada; o que existe no Ollama e não está nela só entra por `modelo_manual`. Os modelos sem censura da comunidade (`huihui_ai`, `orcarouter`) não foram avaliados por mim quanto a qualidade nem a procedência além de serem os mais baixados do Ollama.
- **Vazão e latência em GPU real** não foram medidas (só um 4B numa RTX 2060 de 6 GB, parte na CPU).
- **Publicar o notebook** (GitHub/Drive) para abrir com 1 clique só com a autorização do usuário.
- **Tokens do Hugging Face para repositórios restritos** pelo Ollama: plumbing pronto, não testado.
- **Ollama com `OLLAMA_NUM_PARALLEL` 1** nas GPUs menores: subagentes em paralelo ficam em fila (com o servidor mandando pings, o túnel aguenta a espera).
- **A conexão exige confirmação manual**; um deep link só seria aceitável se ele sempre pedisse essa confirmação (não implementado).
- **Conectar ou desconectar recarrega o rascunho** do diálogo de Configurações (o app avisa o diálogo de que as configurações mudaram): edições de **outros** campos que ainda não foram salvas são descartadas. Salve antes de conectar.
- A **exportação de configuração** do app leva o provedor Colab sem a chave (a referência `secret:colab` não vale em outro computador e o endereço do túnel expira): em outro computador ele aparece "sem chave". Não mexi em `src/core/config/transfer.ts`.
- O **painel do notebook** mostra números, nunca conteúdo; o servidor conta as imagens recebidas (só o número) para o autoteste e o E2E poderem provar que a imagem chegou.
- Se o Colab passar a bloquear ou a mudar a interface de upload, os passos do cartão e do notebook precisam ser revistos.
