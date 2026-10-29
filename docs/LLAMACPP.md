# llama.cpp embutido (motor local)

O Openclod traz o servidor do próprio [llama.cpp](https://github.com/ggml-org/llama.cpp) dentro do app. Ele roda os
modelos GGUF neste computador, com a GPU, sem Ollama instalado e sem nuvem. Enquanto está ligado, vira o provedor
**llama.cpp (local)** no seletor de modelo.

O Ollama continua disponível como provedor opcional (Configurações → Provedores → Ollama), mas o motor local padrão é o
llama.cpp. Na escolha automática do melhor provedor, o `llamacpp` vem antes do Ollama e do LM Studio.

## Onde fica

Configurações → **Provedores**, cartão **llama.cpp (local)**, acima do Google Colab:

| Parte | O que faz |
|---|---|
| Perfil | Cada perfil guarda um modelo, o contexto e as opções do servidor. **Novo** copia o perfil atual. "Iniciar com o Openclod" e as pastas valem para todos. |
| Modelo escolhido | Nome, quantização, tamanho, contexto de treino, ferramentas/raciocínio (lidos do template de chat) e visão. |
| Modelos neste computador | Os GGUF que já estão na máquina. Veja abaixo onde o Openclod procura. **Usar** escolhe o modelo. |
| Baixar modelos do Hugging Face | Os GGUF mais baixados, cada um com a quantização que cabe na sua GPU. |
| Opções do servidor | Todas as opções que o `llama-server` lista na própria ajuda (`--help`), em grupos e com nomes em português. |
| Versões do llama.cpp | A versão Vulkan embutida e as oficiais do GitHub (CUDA para NVIDIA, só CPU). |
| Contexto / Iniciar / Parar | Contexto do próximo início (32k é o mínimo para trabalhar como agente) e o servidor. |
| Quando está Pronto | Endereço, contexto aberto, camadas na GPU (`33/33`), placa e VRAM prevista, velocidade e visão. |
| Log do servidor | O que o `llama-server` imprime, ao vivo. |

## Segurança

- O servidor escuta **só em 127.0.0.1**, numa porta livre escolhida pelo sistema.
- É protegido por uma **chave aleatória**, guardada no cofre do Windows (DPAPI). A chave vai para o servidor pela
  variável de ambiente `LLAMA_API_KEY`. Ela nunca entra na linha de comando, que qualquer programa da máquina consegue ler.
- Variáveis `LLAMA_ARG_*` herdadas do sistema são removidas. Cada uma é uma opção escondida: `LLAMA_ARG_HOST=0.0.0.0`
  abriria o servidor para a rede.
- A tela de opções **não oferece**, em nenhuma grafia, as opções que o Openclod controla ou que tirariam o servidor
  deste computador:
  - o que o Openclod controla: modelo, projetor, apelido, endereço, porta, chave, contexto e slots;
  - acesso de fora e execução: `--connect` (túnel), `--tools`/`--agent`/MCP (ferramentas de arquivo e shell);
  - arquivos locais: `--path`/`--media-path`;
  - downloads por fora do Openclod: `--hf-*`, URLs e os atalhos que baixam pesos;
  - o que quebraria o endereço do provedor: SSL, `--api-prefix` e o modo roteador.

  Valem as mesmas regras para os "Argumentos extras" (`src/core/llamacpp/options.ts`, `BLOCKED`).
- Um `llama-server` que ficou rodando de uma sessão do app que travou é encerrado no próximo início. O app guarda um
  arquivo de pid e confere se aquele processo ainda é o `llama-server.exe` antes de matar.

## Modelos neste computador

A busca só lê nomes e tamanhos dos arquivos. O cabeçalho GGUF é lido quando você escolhe um modelo. Ordem da busca:

1. **Ollama**: os manifestos em `%OLLAMA_MODELS%` ou `~/.ollama/models` dão o nome (`qwen3.5:4b`), o blob do modelo e o
   projetor de visão. O Ollama não precisa estar rodando. Os modelos "cloud" (sem arquivo) ficam de fora.
2. **Baixados** pelo Openclod: `%APPDATA%\Openclod Desktop\llamacpp\models\<autor>--<repo>\`.
3. **LM Studio** (`~/.lmstudio/models`, `~/.cache/lm-studio/models`).
4. **Cache do Hugging Face** (`HF_HUB_CACHE`, `HF_HOME/hub` ou `~/.cache/huggingface/hub`).
5. Cache do **llama.cpp** (`LLAMA_CACHE`, `%LOCALAPPDATA%\llama.cpp`).
6. `~/models`, **Downloads** e as pastas que você adicionar (**+ Pasta**).

Um modelo dividido aparece pela parte `-00001-of-…`. O `mmproj` da mesma pasta vira o projetor de visão do modelo.

## Baixar (Hugging Face)

- A lista são os ~1000 repositórios GGUF mais baixados, guardada por 12 h em `llamacpp/catalogo.json`. O botão **No
  Hugging Face** faz uma busca livre.
- Ficam só modelos de chat (com template) cujas arquiteturas o `llama.dll` da versão em uso conhece. Cópias do mesmo
  modelo por vários autores viram uma linha; a de quem publica com mais cuidado (ggml-org, unsloth, bartowski…) lidera.
- **Quanto cabe**:
  - **VRAM**: a da maior GPU (lida pelo `llama-server --list-devices`, qualquer fabricante) menos 700 MB para o Windows.
  - **RAM**: 80% dela menos 3 GB, para o modelo dividir com a GPU.
  - **O modelo precisa de**: arquivo + cache KV no contexto escolhido + projetor + uma folga. Arquiteturas híbridas ou de
    janela (qwen35, gemma, lfm2…) usam um cache KV bem menor.
- **Quantização sugerida**: a de melhor qualidade que cabe inteira na GPU. Nunca abaixo de Q3_K_M, e Q8_0 só em modelos
  com menos de 3B. Se nenhuma cabe, a Q4_K_M dividindo GPU e RAM.
- **Ver arquivos** lê os arquivos reais do repositório, com o tamanho exato e o SHA-256.
- **Baixar e usar** baixa o arquivo e o projetor de visão do repositório (F16, nunca F32). O download pode ser retomado
  (HTTP Range), confere o SHA-256 publicado e apaga o arquivo se ele não bater. No fim, o modelo vira o do perfil.
  Repositórios que exigem aceitar a licença no Hugging Face só abrem a página.

## Opções do servidor

Os campos vêm da ajuda da versão que está rodando, então uma versão nova traz opções novas sem mudar o app. O tipo de
cada campo sai do formato da ajuda:

- sem valor: liga/desliga;
- `--x, --no-x`: padrão/ligado/desligado;
- `{a,b}`, `[on|off]` ou "allowed values": escolha;
- `N`: número;
- `FNAME`/`PATH`: arquivo ou pasta.

Os nomes e as explicações em português estão em `src/core/llamacpp/options-curated.ts`. Campo vazio = o padrão do
llama.cpp. Ao salvar, cada valor é conferido contra a ajuda (um valor errado é recusado com o motivo). A caixa "Linha de
comando" mostra o próximo início. O Openclod passa `--log-verbosity 4`, porque no nível padrão o b11972 não diz quantas
camadas foram para a GPU.

## Versões

- **Vulkan · b11972 (embutida)**: qualquer GPU (NVIDIA, AMD, Intel) e a CPU.
- **CUDA 13.4 / 12.4**: a mais rápida em NVIDIA. A sugerida é a mais nova que o driver aceita, lida do `nvidia-smi`
  (`CUDA Version` ou, em drivers novos, `CUDA UMD Version`). Uma CUDA mais nova que o driver falha com "PTX was compiled
  with an unsupported toolchain".
- **Só CPU**.

**Baixar a mais nova** procura o release `bNNNNN` mais recente que tenha aquele pacote. O "latest" do GitHub pode ser
uma tag `vX.Y.Z`. O app confere o SHA-256 que o GitHub publica, extrai em streaming só o servidor e as DLLs, grava
`openclod-build.json` e passa a usar a versão. Elas ficam em `%APPDATA%\Openclod Desktop\llamacpp\builds\<tag>-<tipo>\`.

## Conversa no llama.cpp com o servidor parado

Ao abrir ou continuar uma conversa no **llama.cpp (local)**, se o servidor está parado e há um modelo escolhido, o
Openclod inicia o servidor e espera o modelo carregar antes do primeiro pedido (`LlamaCppService.ensureReady`). A porta
muda a cada início. O provedor é regravado e as sessões ociosas são refeitas com o endereço novo. Se o servidor não
sobe, o pedido falha como em qualquer servidor local, e a reserva passa a conversa para o próximo provedor.

## Arquivos

| O quê | Onde |
|---|---|
| Perfis, pastas, versão escolhida | `%APPDATA%\Openclod Desktop\config\llamacpp.json`. O arquivo antigo, de um perfil só, vira o perfil "Padrão". |
| pid do servidor | `…\llamacpp\server.pid` |
| Lista do Hugging Face | `…\llamacpp\catalogo.json` |
| Modelos baixados | `…\llamacpp\models\` (com `openclod-origem.json`: repositório e SHA-256) |
| Versões baixadas | `…\llamacpp\builds\` |
| Versão embutida | `resources/llamacpp/b11972-vulkan/`, fora do git. Recriar com `node scripts/embed-llamacpp.mjs`; conferir com `--check`. |

## Verificação

```powershell
npx vitest run tests/llamacpp-core.test.ts tests/llamacpp-local-models.test.ts tests/llamacpp-hub.test.ts tests/llamacpp-options.test.ts tests/llamacpp-service.test.ts
npx tsx scripts/llamacpp-real.ts            # servidor embutido + modelo real + chat pelo endpoint OpenAI (sem a janela)
npx tsx scripts/llamacpp-hub-real.ts        # lista do Hugging Face, placa, arquivos; --download baixa um modelo pequeno, cancela e retoma
npx tsx scripts/llamacpp-builds-real.ts     # placa/driver, release mais novo, instala a versão "só CPU" e roda --version
node scripts/ui-llamacpp.cjs --root <snapshot>   # tudo isso na janela real, com perfil descartável
```

## Código

| Arquivo | Papel |
|---|---|
| `src/core/llamacpp/builds.ts` | Tipos de versão, pacotes do release, `nvidia-smi`, sugestão de CUDA |
| `src/core/llamacpp/args.ts` | Linha de comando e ambiente do servidor (host fixo, chave no ambiente, `LLAMA_ARG_*` fora) |
| `src/core/llamacpp/options.ts`, `options-curated.ts` | Leitura da ajuda, grupos, validação, opções bloqueadas |
| `src/core/llamacpp/gguf.ts` | Leitor de cabeçalho GGUF (arquitetura, quantização, template, cache KV) |
| `src/core/llamacpp/local-models.ts` | Busca dos modelos no computador |
| `src/core/llamacpp/hub.ts` | Lista do Hugging Face, quanto cabe, quantização sugerida |
| `src/core/llamacpp/log.ts` | Velocidade, camadas na GPU, placa e erros comuns em português, lidos do log |
| `src/main/llamacpp/server.ts` | Processo do `llama-server`: início, saúde, log, parada, servidor órfão |
| `src/main/llamacpp/service.ts` | Perfis, provedor `llamacpp`, opções, início automático |
| `src/main/llamacpp/hub.ts`, `builds.ts`, `download.ts` | Downloads conferidos (modelos e versões) |
| `src/renderer/src/components/LlamaCpp*.tsx`, `llamacpp-card.css` | O cartão e as seções |

A camada de llama.cpp do projeto Vision (código nosso, em Python) foi a referência das ideias: busca de modelos, lista
que cabe na GPU, opções pela ajuda e versões. Aqui ela foi reescrita em TypeScript. As rotas "abrir com Claude/Codex"
daquele projeto não foram trazidas.
