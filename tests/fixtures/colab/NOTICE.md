# Fixtures do Colab

- `cloudflare-530-tunel-encerrado.json` e `cloudflare-502-origem-parada.json`: respostas **reais** de um quick tunnel da Cloudflare
  (`cloudflared 2026.10.5`, capturadas em 2026-10-27) quando o processo do túnel foi encerrado (HTTP 530, "Error 1033") e quando o
  servidor atrás do túnel foi parado (HTTP 502, "Bad gateway"). O nome do túnel, o IP e o `cf-ray` foram anonimizados.
- `ollama-tags-trecho.html` e `ollama-biblioteca-trecho.html`: trechos **reais** (marcação HTML, quatro linhas e três cartões) de
  https://ollama.com/library/qwen3.5/tags e https://ollama.com/library?sort=popular, capturados em 2026-10-27. Usados só em
  `tests/colab-catalog-script.test.ts` para provar que `scripts/colab-catalog.mjs` lê a marcação do site (capacidades, tamanhos,
  etiquetas, digest, contexto, tipos de entrada). Se o site mudar a marcação, o gerador para de achar as etiquetas: baixe os
  trechos de novo e ajuste o leitor.
- `nbformat.v4.5.schema.json`: o esquema JSON oficial do formato de notebooks Jupyter 4.5, copiado de
  https://github.com/jupyter/nbformat (`nbformat/v4/nbformat.v4.5.schema.json`), licença **BSD 3-Clause**:
  Copyright (c) 2001-2015, IPython Development Team; Copyright (c) 2015-, Jupyter Development Team. Usado só em
  `tests/colab-notebook.test.ts` para validar o notebook que o botão gera.
