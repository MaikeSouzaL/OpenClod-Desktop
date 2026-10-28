# Áudio e vídeo no Openclod

Anexe (ou cole o caminho de) um **áudio** ou um **vídeo** na mensagem. O harness processa o arquivo sozinho, **antes** do
modelo responder, e guarda tudo na **memória do projeto**: a transcrição inteira, os frames que importam, as folhas de
contato e o texto que aparece na tela. Não há tela nem botão: o arquivo entra e o conhecimento fica, para este modelo e
para qualquer outro que continue o trabalho depois (outra sessão, outro provedor).

A lógica de vídeo vem do [claude-real-video](https://github.com/HUANGCHIHHUNGLeo/claude-real-video) (MIT, © 2026 LeoAido),
portada para dentro do harness e reescrita para o runtime embutido: PyAV (que traz as bibliotecas do FFmpeg), numpy e o
faster-whisper que já faz o ditado. **Sem ffmpeg instalado, sem Pillow, sem internet.** Nada sai do computador.

## Como usar

| Você faz | O que acontece |
|---|---|
| Anexa um `.mp3`, `.wav`, `.m4a`… na mensagem | Transcrição com tempos, na memória. |
| Anexa um `.mp4`, `.mov`, `.mkv`, `.webm`… | Transcrição + frames + folhas de contato + texto da tela (OCR), na memória. |
| Escreve o caminho absoluto no texto (sozinho, entre crases ou entre aspas), por exemplo ``C:\pasta\aula.mp4`` | O mesmo. Só vale o que o **usuário** escreveu, nunca um caminho que uma página ou uma ferramenta citou. |
| Pergunta depois, em **outra sessão**, sem anexar | O modelo acha a gravação na memória (`memory_recall`, `memory_page`) e responde sem reprocessar. |
| Mídia já processada de novo | Nada é refeito: a mesma chamada devolve o resultado guardado (mesmo arquivo, mesmas opções). |

Enquanto processa, a atividade aparece como **“processando 1 mídia · 12 s…”** (não como um “Pensando…” mudo) e o log
mostra cada etapa. Cancelar o turno cancela o processamento.

Ferramentas, para quando o modelo precisa de mais controle (não estão no conjunto básico: `tool_search`/`tool_load`):

- `media_ingest` — processa um arquivo citado (idioma, modelo, teto de frames, só os primeiros N segundos, OCR sim/não, refazer).
  Uma ferramenta tem 10 minutos; para mídia muito longa o caminho certo é **anexar** (o processamento automático não tem esse teto) ou usar `max_seconds`.
- `media_view` — mostra uma folha de contato ou um frame com o texto lido nele. Só devolve imagem a um modelo que enxerga; os outros recebem o texto.
- `media_transcribe` — a transcrição simples que já existia (só texto, sem memória).

## O que o harness faz por dentro

`resources/media/forja_media.py` (Python 3.10 embutido) → `src/core/media/*.ts` (orquestração) → memória do projeto.

1. **Leitura** (PyAV): duração, resolução, fps, trilhas. Um `.mp3` com capa embutida é áudio, não vídeo.
2. **Frames** (portado do claude-real-video): decodifica o vídeo uma vez; um frame vira *candidato* quando há **corte de cena**
   (métrica de cena do ffmpeg sobre uma miniatura RGB 64×36, que pega também troca de cor com a mesma luminância) ou quando
   passou **1 segundo** desde o último (piso de densidade). Os candidatos passam pela **deduplicação em janela deslizante com três
   detectores**: global (16×16 RGB), ação (um sujeito pequeno que se mexe forte: 3 células de 32×32) e “assentado local”
   (traço fino, troca de legenda, atualização de interface, com tolerância de ±1 pixel e período de espera). Teto de 150 frames,
   afinado de modo uniforme **depois** da deduplicação, para o que sobra continuar espalhado pelo vídeo.
3. **Folhas de contato**: 3×3 frames consecutivos por imagem, cada célula com o número (`#12`) e o tempo (`0:14`), numa fonte
   de bitmap própria (sem fontes nem Pillow). A célula cabe numa caixa (largura 480, altura até 640): 16:9 dá 480×270, vídeo de
   celular 360×640; a folha fica em torno de 1440 px de largura em qualquer orientação.
4. **Fala** (faster-whisper + Silero VAD, o mesmo motor do ditado), **em paralelo** com os frames. `auto` escolhe o modelo `small`
   com GPU e `base` sem; detecta o idioma; descarta segmentos que são alucinação de silêncio; trilha sem fala vira uma nota honesta
   (“nenhuma fala reconhecida”), nunca texto inventado.
5. **Texto da tela** (OCR do Windows, offline, **um** PowerShell para todos os frames).
6. **Memória**: uma **página-índice** e **partes** de poucos minutos (cortadas entre falas, nunca no meio de uma), ligadas por
   `[[links]]` nos dois sentidos. Cada parte é uma linha do tempo com a fala e, logo abaixo, os frames daquele instante
   (`▸ #12 0:14 frame_012.jpg · folha 2 célula 3 · na tela: Agenda · Q3`). O texto da tela só aparece quando **muda** em relação
   ao frame anterior. Os arquivos ficam em `<memória do projeto>/media/<nome>-<hash>/` (`frames/`, `sheets/`, `transcript.json`,
   `frames.json`, `ocr.json`, `manifest.json`).
7. **Resumo para o modelo**: antes da primeira chamada o harness acrescenta uma mensagem oculta `<midia-processada>` curta
   (os slugs das páginas, o que há de imagens, como abrir) e, se o modelo enxerga imagens, as primeiras folhas. Não despeja a
   transcrição: o modelo abre só a parte de que precisa.

Tudo que vem da mídia é **dado não confiável**: as páginas dizem isso no cabeçalho, e uma frase falada ou escrita na tela que
mande “ignorar as instruções” não é obedecida (regra 3 do prompt do sistema).

## Medido de verdade

Máquina do usuário (GPU NVIDIA, Whisper `small` em CUDA/float16), arquivos reais:

| Mídia | Resultado | Tempo |
|---|---|---|
| WAV pt-BR de 22 s (voz do Windows) | 3 trechos, idioma pt (98%), texto correto | 3,5 s |
| Vídeo vertical de 34 s, 1080×1920 VP9 (reel) | 1.031 frames lidos → 39 candidatos → **36 mantidos** em 4 folhas (o claude-real-video manteve 38 de 42 no mesmo vídeo); 8 trechos pt (98,8%) | 10,9 s |
| Vídeo de 5 min 33 s, 1920×1080 h264 | 9.975 frames → 335 candidatos → 150 (teto) em 17 folhas; 93 trechos pt | 87,7 s (frames 83,7 s; fala 32,2 s, em paralelo) |

Com modelo real e a interface de verdade (`scripts/ui-media.cjs`, DeepSeek `deepseek-flash`, app congelado em outra pasta):
**18 de 18 checagens**.

- **Áudio anexado:** processado **antes** do modelo (mensagem oculta com os slugs da memória); a resposta traz fatos que só estão
  no áudio (PostgreSQL, novembro, a Marina, R$ 50 mil) e o modelo **não** chamou nenhuma ferramenta de transcrição. A atividade
  “processando mídia” aparece e termina bem.
- **Sessão nova, sem anexo:** a pergunta sobre “a reunião gravada” foi respondida a partir da memória (`memory_recall` e
  `memory_page`), sem reprocessar. É o caso de usar outro modelo depois, sem repassar o contexto.
- **Vídeo real de 34 s** (celular, 1080×1920): 36 frames em 4 folhas, 3 páginas na memória com a fala e o texto lido nos 36 frames. O
  modelo (nessa configuração ele aceita imagens) pediu as folhas com `media_view` e descreveu o vídeo pela narração e pelo que
  aparece na tela. O resumo oculto custou ~280 tokens; as partes que ele abriu, ~1.300.
- Capturas em `Prints/midia-2026-10-27/` (a terceira mostra as folhas de contato dentro da conversa).

## Limites (o que NÃO faz)

- **Não baixa vídeo de URL** (o claude-real-video usa yt-dlp; aqui só arquivo local). Para um link, baixe o arquivo e anexe.
- **Não identifica quem fala** (diarização) e **não descreve as imagens por IA**: o que um modelo *sem visão* recebe das imagens é
  a seleção dos frames, o tempo, a folha/célula e o **texto lido por OCR**. Um modelo **com** visão recebe as folhas e é
  orientado a gravar um resumo visual na memória para os outros.
- **OCR só no Windows** (Windows.Media.Ocr, idiomas do perfil do usuário). Sem ele o vídeo ainda é processado, sem o texto da tela.
- Vídeo de **celular com matriz de rotação** usa a semântica documentada do FFmpeg (rotação anti-horária) e tem teste só da função
  de rotação; **não foi testado com um arquivo real rotacionado**.
- **Mídia muito longa** (mais de uma hora) leva minutos (decodificar 1080p30 roda a ~120 quadros/s): o processamento automático
  aguenta até 45 min por arquivo; use `max_seconds` (vale para os frames **e** para a fala) para uma amostra. O processo roda com
  prioridade abaixo do normal, para o app e o resto do computador não travarem.
- Vídeo com **trechos danificados** (download cortado, emenda ruim) é processado do mesmo jeito: o trecho ruim é pulado, a página
  avisa quantos e o resultado continua valendo; um arquivo **cortado a ponto de perder o índice** (mp4 sem o fim) é recusado com
  uma mensagem clara.
- Tamanho máximo de 8 GB por arquivo.

## Código e testes

- Motor: `resources/media/forja_media.py` (registrado em `resources/MANIFEST.json`; licença do claude-real-video em
  `resources/licenses/claude-real-video/MIT.txt` e em `THIRD_PARTY_NOTICES.md`).
- `src/core/media/{ingest,memory,paths,ocr}.ts`, `src/core/tools/media.ts` (`media_ingest`, `media_view`),
  `Orchestrator.mediaPrepare` + `SendOptions.prepare` no runner.
- Testes (49 novos): `tests/media-ingest.test.ts` (motor real: cortes de cena, JPEG, folhas, cache, teto, cancelamento, acentos,
  vídeo danificado e cortado, prioridade, voz pt-BR real, `max_seconds` na fala, memória, espelho em segundo plano, ferramentas),
  `tests/media-memory.test.ts` (partes, links, texto da tela, avisos, resumo), `tests/media-paths.test.ts`,
  `tests/media-ocr.test.ts` (OCR em lote com texto de verdade), `tests/runner-prepare.test.ts`.
- Ponta a ponta com modelo real: `node scripts/ui-media.cjs [--root <snapshot>] [--video arquivo.mp4]`.
