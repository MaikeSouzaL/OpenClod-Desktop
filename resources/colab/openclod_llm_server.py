#!/usr/bin/env python3
"""Servidor de LLM do Openclod para o Google Colab (e para qualquer máquina Linux com GPU NVIDIA).

Este arquivo é o único código do notebook: o .ipynb gerado pelo Openclod Desktop só o grava no Colab e chama as funções
`step_*` abaixo, uma por célula. Usa apenas a biblioteca padrão do Python.

O que o notebook inteiro faz, sem nenhum passo manual:
  1. lê a GPU (nvidia-smi), MOSTRA todos os modelos abertos que cabem nela (de todo tipo, inclusive sem censura) e PARA numa caixa de
     seleção com o botão "Usar este modelo" (você também pode escolher pelo número, pelo tipo ou digitando a etiqueta); se você não
     escolher em 2 minutos, roda sozinho o melhor com VISÃO + FERRAMENTAS + contexto grande, e só então baixa alguma coisa;
  2. instala o Ollama (binário oficial, versão e SHA-256 fixos), baixa o modelo e confere que ele cabe 100% na GPU;
  3. sobe um servidor compatível com a API da OpenAI (/v1/models e /v1/chat/completions com stream, imagens e tools) que
     exige uma chave aleatória gerada na hora;
  4. abre um túnel "quick tunnel" da Cloudflare (cloudflared oficial, versão e SHA-256 fixos);
  5. testa tudo pelo endereço público (texto, streaming, imagem, ferramenta) e só então imprime o CÓDIGO DE CONEXÃO;
  6. fica vivo com um painel de status.

Segurança: a chave nunca vai para log; o código de conexão é a única coisa que a contém; o processo do Ollama e o do
túnel não recebem a chave; só as rotas /v1/models, /v1/chat/completions, /healthz e /openclod/status são expostas.

Uso fora do Colab (testes e depuração):
  python openclod_llm_server.py serve --engine-url http://127.0.0.1:11434 --model qwen3.5:4b --key SEGREDO
  python openclod_llm_server.py selftest --url http://127.0.0.1:8000/v1 --key SEGREDO --model qwen3.5:4b
  python openclod_llm_server.py plan --vram 15360
  python openclod_llm_server.py catalog --vram 15360
  python openclod_llm_server.py version
"""
from __future__ import annotations

import argparse
import base64
import collections
import hashlib
import hmac
import http.client
import http.server
import json
import os
import queue
import re
import secrets
import shutil
import socketserver
import struct
import subprocess
import sys
import tarfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib

# --------------------------------------------------------------------------------------------------------------------
# Versões e fontes (tudo que o notebook baixa é fixado por versão e conferido por SHA-256)
# --------------------------------------------------------------------------------------------------------------------

NOTEBOOK_VERSION = "1.2.0"
CODE_PREFIX = "OCLC1"
CODE_FORMAT = 1
USER_AGENT = "openclod-colab/" + NOTEBOOK_VERSION

# Ollama: release oficial do GitHub (https://github.com/ollama/ollama/releases). O .tar.zst traz os runtimes CUDA.
OLLAMA_VERSION = "0.40.11"
OLLAMA_URL = "https://github.com/ollama/ollama/releases/download/v%s/ollama-linux-amd64.tar.zst" % OLLAMA_VERSION
OLLAMA_SHA256 = "7bedab90dd122661be78798e9f0edf37fccf0cccf2699d2c58ea1a3afdc04b6d"

# cloudflared: release oficial do GitHub (https://github.com/cloudflare/cloudflared/releases).
CLOUDFLARED_VERSION = "2026.10.5"
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/download/%s/cloudflared-linux-amd64" % CLOUDFLARED_VERSION
CLOUDFLARED_SHA256 = "e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298"

# No Colab os arquivos ficam em /content/openclod; em outra máquina (uso fora do Colab), em ~/openclod-colab. OPENCLOD_COLAB_DIR manda.
WORK_DIR = os.environ.get("OPENCLOD_COLAB_DIR") or (
    "/content/openclod" if os.path.isdir("/content") else os.path.join(os.path.expanduser("~"), "openclod-colab"))
ENGINE_PORT = 11434
SERVER_PORT = 8000

# Rotas que o túnel publica. Qualquer outra coisa do motor (ex.: /api/pull, /api/delete) fica inacessível de fora.
PUBLIC_ROUTES = ("/v1/models", "/v1/chat/completions", "/healthz", "/openclod/status")

MAX_BODY_BYTES = 128 * 1024 * 1024
# Sem resposta do motor nesse tempo, o servidor abre o SSE e manda comentários: o túnel da Cloudflare corta uma
# conexão que fica ~100 s sem NENHUM cabeçalho de resposta (medido: com os cabeçalhos já enviados ela aguenta bem mais).
EARLY_FLUSH_SECONDS = 2.5
PING_SECONDS = 8.0
UPSTREAM_TIMEOUT = 1800.0


class StepFailed(SystemExit):
    """Uma etapa do notebook falhou; a mensagem já foi impressa, em português, com o que fazer."""


class StepStopped(StepFailed):
    """O usuário pediu para parar de propósito (ex.: só ver a lista de modelos): não é um erro, mas "Executar tudo" também para."""


# --------------------------------------------------------------------------------------------------------------------
# Modelos por VRAM (fonte única da tabela: é o que o notebook executa)
# --------------------------------------------------------------------------------------------------------------------

class Candidate(object):
    """Um modelo + contexto para tentar. `tag` é uma etiqueta do Ollama (https://ollama.com/library).

    `explicit`: foi o usuário quem pediu este modelo (etiqueta digitada ou número da lista): o notebook nunca o troca em silêncio
    por outro. `no_tools_ok`: o catálogo já diz que ele não declara ferramentas e mesmo assim foi pedido (por número, tipo ou
    etiqueta): se não houver ferramentas, o notebook avisa e segue em vez de passar para o próximo."""

    def __init__(self, tag, ctx, kv="f16", parallel=1, thinking="off", weights_gb=0.0, explicit=False, no_tools_ok=False):
        self.tag = tag
        self.ctx = ctx
        self.kv = kv
        self.parallel = parallel
        self.thinking = thinking
        self.weights_gb = weights_gb
        self.explicit = explicit
        self.no_tools_ok = no_tools_ok

    def to_dict(self):
        return {"tag": self.tag, "ctx": self.ctx, "kv": self.kv, "parallel": self.parallel, "thinking": self.thinking,
                "weights_gb": self.weights_gb, "explicit": self.explicit, "no_tools_ok": self.no_tools_ok}


class Tier(object):
    def __init__(self, key, min_mib, label, candidates, why, sources):
        self.key = key
        self.min_mib = min_mib
        self.label = label
        self.candidates = candidates
        self.why = why
        self.sources = sources


_Q38 = ["https://ollama.com/library/qwen3.8", "https://huggingface.co/Qwen/Qwen3.8-27B"]
_Q35 = ["https://ollama.com/library/qwen3.5", "https://huggingface.co/Qwen/Qwen3.5-9B"]

# Do maior para o menor. O primeiro candidato do degrau é o preferido; os seguintes entram quando o anterior não cabe
# 100% na GPU (o notebook confere com `ollama ps`). Os pesos em GB são os tamanhos publicados nas páginas do Ollama.
# Contexto: o prompt-base do Openclod tem ~9 mil tokens, então o mínimo é 32 mil e o alvo é 64 mil ou mais.
# KV cache (estimado com as configurações públicas do Qwen3.5/3.8: só 1 em cada 4 camadas guarda KV): 3.8-27B = 64 KiB
# por token em f16; 3.5-9B = 32 KiB por token. Licença dos dois: Apache-2.0, sem acesso restrito.
TIERS = [
    Tier(
        "96", 90000, "GPU de ~96 GB (ex.: RTX PRO 6000 / G4)",
        [Candidate("qwen3.8:27b-q8_0", 131072, "f16", 2, "auto", 30),
         Candidate("qwen3.8:27b-q4_K_M", 131072, "f16", 2, "auto", 18)],
        "Qwen3.8-27B em Q8_0 (30 GB) com 128k de contexto: visão, ferramentas e a melhor qualidade que cabe com folga.",
        _Q38,
    ),
    Tier(
        "80", 70000, "GPU de 80 GB (A100 80 GB, H100)",
        [Candidate("qwen3.8:27b-q8_0", 131072, "f16", 2, "auto", 30),
         Candidate("qwen3.8:27b-q4_K_M", 131072, "f16", 1, "auto", 18)],
        "Qwen3.8-27B em Q8_0 (30 GB) com 128k de contexto e 2 pedidos em paralelo.",
        _Q38,
    ),
    Tier(
        "40", 38000, "GPU de 40 GB (A100 40 GB)",
        [Candidate("qwen3.8:27b-q8_0", 65536, "f16", 1, "auto", 30),
         Candidate("qwen3.8:27b-q4_K_M", 131072, "f16", 1, "auto", 18)],
        "Qwen3.8-27B em Q8_0 (30 GB) com 64k de contexto.",
        _Q38,
    ),
    Tier(
        "24", 22000, "GPU de 24 GB (L4)",
        [Candidate("qwen3.8:27b-q4_K_M", 65536, "q8_0", 1, "off", 18),
         Candidate("qwen3.8:27b-q4_K_M", 32768, "f16", 1, "off", 18),
         Candidate("qwen3.5:9b-q8_0", 131072, "f16", 1, "off", 10)],
        "Qwen3.8-27B em Q4_K_M (18 GB) com 64k de contexto (cache KV em 8 bits); se não couber, 32k; por fim o Qwen3.5-9B.",
        _Q38,
    ),
    Tier(
        "16", 14000, "GPU de 16 GB (T4)",
        [Candidate("qwen3.5:9b-q8_0", 65536, "f16", 1, "off", 10),
         Candidate("qwen3.5:9b-q4_K_M", 131072, "f16", 1, "off", 6.6),
         Candidate("qwen3.5:9b-q4_K_M", 65536, "f16", 1, "off", 6.6),
         Candidate("qwen3.5:4b-q8_0", 65536, "f16", 1, "off", 5.2)],
        "Qwen3.5-9B em Q8_0 (10 GB) com 64k de contexto: visão e ferramentas; a T4 não tem bf16, mas o GGUF roda em fp16.",
        _Q35,
    ),
    Tier(
        "12", 10000, "GPU de 12 GB",
        [Candidate("qwen3.5:9b-q4_K_M", 65536, "f16", 1, "off", 6.6),
         Candidate("qwen3.5:4b-q8_0", 65536, "f16", 1, "off", 5.2)],
        "Qwen3.5-9B em Q4_K_M (6,6 GB) com 64k de contexto.",
        _Q35,
    ),
    Tier(
        "8", 7000, "GPU de 8 GB",
        [Candidate("qwen3.5:4b-q8_0", 32768, "f16", 1, "off", 5.2),
         Candidate("qwen3.5:4b-q4_K_M", 32768, "f16", 1, "off", 3.3)],
        "Qwen3.5-4B (5,2 GB) com 32k de contexto.",
        _Q35,
    ),
    Tier(
        "min", 0, "GPU pequena (menos de 8 GB)",
        [Candidate("qwen3.5:4b-q4_K_M", 32768, "f16", 1, "off", 3.3),
         Candidate("qwen3.5:2b-q8_0", 32768, "f16", 1, "off", 2.7)],
        "Qwen3.5-4B em Q4_K_M (3,3 GB): é o limite do que o Openclod consegue usar como agente.",
        _Q35,
    ),
]


def tier_for(vram_mib):
    """Degrau da tabela para uma GPU com `vram_mib` MiB (o maior cujo mínimo cabe)."""
    for tier in TIERS:
        if vram_mib >= tier.min_mib:
            return tier
    return TIERS[-1]


def _plain(text):
    return "".join(ch for ch in unicodedata.normalize("NFD", str(text or "")) if unicodedata.category(ch) != "Mn").strip().lower()


def plan_for(vram_mib, forced_model="", forced_ctx=0, thinking="padrão", numero=0, tipo="", free_mib=None):
    """Plano de execução: a lista de candidatos, na ordem em que serão tentados.

    Quem manda, nesta ordem: `forced_model` (etiqueta do Ollama, ou hf.co/usuario/repositorio:quantização, digitada pelo usuário:
    vira o único candidato), `numero` (n.º da lista de modelos que cabem nesta GPU, a que a etapa 2 imprime), `tipo` (o maior
    modelo desse tipo que cabe: sem censura, código, raciocínio, leve e rápido) e, sem nada disso, a tabela por VRAM (TIERS).
    `forced_ctx`: contexto desejado (0 = o que couber). `thinking`: padrão | ligado | desligado. Levanta ValueError, em português,
    quando o número ou o tipo pedido não existe ou não cabe.
    """
    tier = tier_for(int(vram_mib))
    forced = (forced_model or "").strip()
    wanted_ctx = int(forced_ctx or 0)
    kind = _kind_of(tipo)
    usable = usable_gib(vram_mib, free_mib)
    default_thinking = "off" if int(vram_mib) < 38000 else "auto"
    out = []
    why = tier.why
    sources = list(tier.sources)
    if forced:
        base = tier.candidates[0]
        known = catalog_variant(forced)
        fit_ctx = best_context(known, usable) if known else 0
        out.append(Candidate(forced, wanted_ctx or fit_ctx or base.ctx, base.kv, base.parallel, base.thinking,
                             known["gb"] if known else 0.0, True))
        why = "Modelo escolhido por você no formulário."
    elif int(numero or 0) > 0:
        listing = build_listing(usable)
        row = listing["by_number"].get(int(numero))
        if row is None:
            raise ValueError("O número %d não está na lista desta GPU (vai de 1 a %d). Rode a etapa 2 de novo para ver a lista e "
                             "escolha um número dela." % (int(numero), len(listing["rows"])))
        out = _row_candidates(row, wanted_ctx, default_thinking, True)
        why = "Modelo n.º %d da lista, escolhido por você: %s (%s)." % (row["numero"], row["variant"]["nome"], row["variant"]["quant"])
        sources = [ollama_page(row["variant"]["tag"])]
    elif kind:
        listing = build_listing(usable)
        picks = pick_by_kind(listing["rows"], kind)
        if not picks:
            raise ValueError("Nenhum modelo do tipo '%s' cabe nesta GPU (%s GB livres). Veja a lista da etapa 2 ou use uma GPU maior."
                             % (tipo, gb_text(int(usable * 1024))))
        for row in picks[:3]:
            out.extend(_row_candidates(row, wanted_ctx, default_thinking, False)[:2])
        why = "Tipo '%s': o maior modelo desse tipo que cabe nesta GPU (as próximas opções entram se ele não couber 100%% na GPU)." % tipo
        sources = [ollama_page(picks[0]["variant"]["tag"])]
    else:
        for item in tier.candidates:
            out.append(Candidate(item.tag, wanted_ctx or item.ctx, item.kv, item.parallel, item.thinking, item.weights_gb))
    mode = {"ligado": "auto", "desligado": "off"}.get(_plain(thinking))
    if mode:
        for item in out:
            item.thinking = mode
    return {"tier": tier.key, "label": tier.label, "why": why, "sources": sources, "candidates": [item.to_dict() for item in out]}


def table_rows():
    """A tabela para mostrar no notebook e na documentação."""
    rows = []
    for tier in TIERS:
        rows.append({"min_mib": tier.min_mib, "label": tier.label,
                     "models": [("%s @ %dk" % (c.tag, c.ctx // 1024)) for c in tier.candidates],
                     "why": tier.why, "sources": tier.sources})
    return rows


# --------------------------------------------------------------------------------------------------------------------
# Catálogo: os modelos abertos que cabem na GPU detectada. Os números (tamanhos, cache KV, contexto, capacidades) são MEDIDOS por
# scripts/colab-catalog.mjs no registro do Ollama e nas páginas do ollama.com; nada aqui é digitado à mão.
# --------------------------------------------------------------------------------------------------------------------

# Uma linha por etiqueta do Ollama: etiqueta, nome, quantização, GB do arquivo (pesos + projetor de visão), KiB de cache KV por
# token (f16), MiB de cache que não cresce com o contexto (camadas de janela deslizante), contexto máximo do modelo, capacidades
# (v visão, t ferramentas, k pensamento, a áudio, m MoE), marcas (u sem censura, c código, r raciocínio) e licença.
CATALOG_FIELDS = ("tag", "nome", "quant", "gb", "kv_kib", "kv_fixo_mib", "ctx_max", "caps", "marcas", "licenca")

# <catalogo-gerado>
# Gerado por scripts/colab-catalog.mjs em 2026-10-28 a partir do registro do Ollama (tamanhos e cabeçalhos GGUF) e das páginas do ollama.com
# (capacidades). Não edite à mão: rode o script de novo. Campos: ver CATALOG_FIELDS.
CATALOG = [
    ("qwen3.8:27b", "Qwen3.8 27B", "Q4_K_M", 17.74, 64, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.8:27b-q8_0", "Qwen3.8 27B", "Q8_0", 29.98, 64, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.6:27b", "Qwen3.6 27B", "Q4_K_M", 17.77, 64, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.6:35b", "Qwen3.6 35B", "Q4_K_M", 22.62, 20, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3.6:27b-q8_0", "Qwen3.6 27B", "Q8_0", 29.98, 64, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.6:35b-a3b-q8_0", "Qwen3.6 35B", "Q8_0", 38.7, 20, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3.5:0.8b", "Qwen3.5 0.8B", "Q8_0", 1.02, 12, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:2b", "Qwen3.5 2B", "Q8_0", 2.68, 12, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:4b", "Qwen3.5 4B", "Q4_K_M", 3.33, 32, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:9b", "Qwen3.5 9B", "Q4_K_M", 6.55, 32, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:27b", "Qwen3.5 27B", "Q4_K_M", 17.48, 64, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:35b", "Qwen3.5 35B", "Q4_K_M", 22.07, 20, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3.5:122b", "Qwen3.5 122B", "Q4_K_M", 81.37, 24, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3.5:4b-q8_0", "Qwen3.5 4B", "Q8_0", 5.16, 32, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:9b-q8_0", "Qwen3.5 9B", "Q8_0", 10.45, 32, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:27b-q8_0", "Qwen3.5 27B", "Q8_0", 29.98, 64, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3.5:35b-a3b-q8_0", "Qwen3.5 35B", "Q8_0", 38.7, 20, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3:0.6b", "Qwen3 0.6B", "Q4_K_M", 0.52, 112, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:1.7b", "Qwen3 1.7B", "Q4_K_M", 1.36, 112, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:4b", "Qwen3 4B", "Q4_K_M", 2.5, 144, 0, 262144, "tk", "", "Apache-2.0"),
    ("qwen3:8b", "Qwen3 8B", "Q4_K_M", 5.23, 144, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:14b", "Qwen3 14B", "Q4_K_M", 9.28, 160, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:30b", "Qwen3 30B", "Q4_K_M", 18.56, 96, 0, 262144, "tkm", "", "Apache-2.0"),
    ("qwen3:32b", "Qwen3 32B", "Q4_K_M", 20.2, 256, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:0.6b-q8_0", "Qwen3 0.6B", "Q8_0", 0.83, 112, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:1.7b-q8_0", "Qwen3 1.7B", "Q8_0", 2.22, 112, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:4b-q8_0", "Qwen3 4B", "Q8_0", 4.37, 144, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:8b-q8_0", "Qwen3 8B", "Q8_0", 8.85, 144, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:14b-q8_0", "Qwen3 14B", "Q8_0", 15.9, 160, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3:30b-a3b-q8_0", "Qwen3 30B", "Q8_0", 32.53, 96, 0, 40960, "tkm", "", "Apache-2.0"),
    ("qwen3:32b-q8_0", "Qwen3 32B", "Q8_0", 35.13, 256, 0, 40960, "tk", "", "Apache-2.0"),
    ("qwen3-vl:2b", "Qwen3-VL 2B", "Q4_K_M", 1.89, 112, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:4b", "Qwen3-VL 4B", "Q4_K_M", 3.34, 144, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:8b", "Qwen3-VL 8B", "Q4_K_M", 6.19, 144, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:30b", "Qwen3-VL 30B", "Q4_K_M", 19.6, 96, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3-vl:32b", "Qwen3-VL 32B", "Q4_K_M", 20.91, 256, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:2b-instruct-q8_0", "Qwen3-VL 2B", "Q8_0", 2.66, 112, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:4b-instruct-q8_0", "Qwen3-VL 4B", "Q8_0", 5.12, 144, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:8b-instruct-q8_0", "Qwen3-VL 8B", "Q8_0", 9.87, 144, 0, 262144, "vtk", "", "Apache-2.0"),
    ("qwen3-vl:30b-a3b-instruct-q8_0", "Qwen3-VL 30B", "Q8_0", 33.57, 96, 0, 262144, "vtkm", "", "Apache-2.0"),
    ("qwen3-vl:32b-instruct-q8_0", "Qwen3-VL 32B", "Q8_0", 35.98, 256, 0, 262144, "vtk", "", "Apache-2.0"),
    ("gemma4:e2b", "Gemma 4 E2B", "Q4_K_M", 4.49, 14, 28, 131072, "vtk", "", "Apache-2.0"),
    ("gemma4:e4b", "Gemma 4 E4B", "Q4_K_M", 6.48, 28, 70, 131072, "vtk", "", "Apache-2.0"),
    ("gemma4:12b", "Gemma 4 12B", "Q4_K_M", 7.56, 16, 640, 262144, "vtk", "", "Apache-2.0"),
    ("gemma4:26b", "Gemma 4 26B", "Q4_K_M", 18.26, 20, 400, 262144, "vtkm", "", "Apache-2.0"),
    ("gemma4:31b", "Gemma 4 31B", "Q4_K_M", 19.87, 80, 1600, 262144, "vtk", "", "Apache-2.0"),
    ("gemma4:e2b-it-q8_0", "Gemma 4 E2B", "Q8_0", 5.96, 14, 28, 131072, "vtk", "", "Apache-2.0"),
    ("gemma4:e4b-it-q8_0", "Gemma 4 E4B", "Q8_0", 9.02, 28, 70, 131072, "vtk", "", "Apache-2.0"),
    ("gemma4:12b-it-q8_0", "Gemma 4 12B", "Q8_0", 12.85, 16, 640, 262144, "vtk", "", "Apache-2.0"),
    ("gemma4:26b-a4b-it-q8_0", "Gemma 4 26B", "Q8_0", 28.05, 20, 400, 262144, "vtkm", "", "Apache-2.0"),
    ("gemma4:31b-it-q8_0", "Gemma 4 31B", "Q8_0", 33.84, 80, 1600, 262144, "vtk", "", "Apache-2.0"),
    ("gemma3:270m", "Gemma 3 270M", "Q8_0", 0.29, 3, 8, 32768, "", "", "Termos do Gemma"),
    ("gemma3:1b", "Gemma 3 1B", "Q4_K_M", 0.81, 4, 11, 32768, "", "", "Termos do Gemma"),
    ("gemma3:4b", "Gemma 3 4B", "Q4_K_M", 3.35, 20, 116, 131072, "v", "", "Termos do Gemma"),
    ("gemma3:12b", "Gemma 3 12B", "Q4_K_M", 8.16, 64, 320, 131072, "v", "", "Termos do Gemma"),
    ("gemma3:27b", "Gemma 3 27B", "Q4_K_M", 17.42, 80, 416, 131072, "v", "", "Termos do Gemma"),
    ("gemma3:1b-it-q8_0", "Gemma 3 1B", "Q8_0", 1.07, 4, 11, 32768, "", "", "Termos do Gemma"),
    ("gemma3:4b-it-q8_0", "Gemma 3 4B", "Q8_0", 4.99, 20, 116, 131072, "v", "", "Termos do Gemma"),
    ("gemma3:12b-it-q8_0", "Gemma 3 12B", "Q8_0", 13.37, 64, 320, 131072, "v", "", "Termos do Gemma"),
    ("gemma3:27b-it-q8_0", "Gemma 3 27B", "Q8_0", 29.58, 80, 416, 131072, "v", "", "Termos do Gemma"),
    ("gpt-oss:20b", "gpt-oss 20B", "MXFP4", 13.79, 24, 3, 131072, "tkm", "", "Apache-2.0"),
    ("gpt-oss:120b", "gpt-oss 120B", "MXFP4", 65.37, 36, 5, 131072, "tkm", "", "Apache-2.0"),
    ("nemotron-3-nano:4b", "Nemotron 3 Nano 4B", "Q4_K_M", 2.84, 16, 0, 262144, "tk", "", "ver a página do modelo"),
    ("nemotron-3-nano:30b", "Nemotron 3 Nano 30B", "Q4_K_M", 24.27, 6, 0, 1048576, "tkm", "", "ver a página do modelo"),
    ("nemotron-3-nano:4b-q8_0", "Nemotron 3 Nano 4B", "Q8_0", 4.23, 16, 0, 262144, "tk", "", "ver a página do modelo"),
    ("nemotron-3-nano:30b-a3b-q8_0", "Nemotron 3 Nano 30B", "Q8_0", 33.59, 6, 0, 1048576, "tkm", "", "ver a página do modelo"),
    ("ministral-3:3b", "Ministral 3 3B", "Q4_K_M", 2.95, 104, 0, 262144, "vt", "", "Apache-2.0"),
    ("ministral-3:8b", "Ministral 3 8B", "Q4_K_M", 6.02, 136, 0, 262144, "vt", "", "Apache-2.0"),
    ("ministral-3:14b", "Ministral 3 14B", "Q4_K_M", 9.08, 160, 0, 262144, "vt", "", "Apache-2.0"),
    ("ministral-3:3b-instruct-2512-q8_0", "Ministral 3 3B", "Q8_0", 4.47, 104, 0, 262144, "vt", "", "Apache-2.0"),
    ("ministral-3:8b-instruct-2512-q8_0", "Ministral 3 8B", "Q8_0", 9.86, 136, 0, 262144, "vt", "", "Apache-2.0"),
    ("ministral-3:14b-instruct-2512-q8_0", "Ministral 3 14B", "Q8_0", 15.21, 160, 0, 262144, "vt", "", "Apache-2.0"),
    ("mistral-small3.2:24b", "Mistral Small 3.2 24B", "Q4_K_M", 15.18, 160, 0, 131072, "vt", "", "Apache-2.0"),
    ("mistral-small3.2:24b-instruct-2506-q8_0", "Mistral Small 3.2 24B", "Q8_0", 25.91, 160, 0, 131072, "vt", "", "Apache-2.0"),
    ("mistral-nemo:12b", "Mistral Nemo 12B", "Q4_0", 7.07, 160, 0, 1024000, "t", "", "Apache-2.0"),
    ("mistral-nemo:12b-instruct-2407-q8_0", "Mistral Nemo 12B", "Q8_0", 13.02, 160, 0, 1024000, "t", "", "Apache-2.0"),
    ("llama3.3:70b", "Llama 3.3 70B", "Q4_K_M", 42.52, 320, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.3:70b-instruct-q8_0", "Llama 3.3 70B", "Q8_0", 74.98, 320, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.1:8b", "Llama 3.1 8B", "Q4_K_M", 4.92, 128, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.1:70b", "Llama 3.1 70B", "Q4_K_M", 42.52, 320, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.1:8b-instruct-q8_0", "Llama 3.1 8B", "Q8_0", 8.54, 128, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.1:70b-instruct-q8_0", "Llama 3.1 70B", "Q8_0", 74.98, 320, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.2:1b", "Llama 3.2 1B", "Q8_0", 1.32, 32, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.2:3b", "Llama 3.2 3B", "Q4_K_M", 2.02, 112, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.2:3b-instruct-q8_0", "Llama 3.2 3B", "Q8_0", 3.42, 112, 0, 131072, "t", "", "Licença Llama"),
    ("llama3.2-vision:11b", "Llama 3.2 Vision 11B", "Q4_K_M", 7.82, 160, 0, 131072, "v", "", "ver a página do modelo"),
    ("llama3.2-vision:90b", "Llama 3.2 Vision 90B", "Q4_K_M", 54.62, 400, 0, 131072, "v", "", "ver a página do modelo"),
    ("llama3.2-vision:11b-instruct-q8_0", "Llama 3.2 Vision 11B", "Q8_0", 12.27, 160, 0, 131072, "v", "", "ver a página do modelo"),
    ("phi4-mini:3.8b", "Phi-4 mini 3.8B", "Q4_K_M", 2.49, 128, 0, 131072, "t", "", "MIT"),
    ("phi4-mini:3.8b-q8_0", "Phi-4 mini 3.8B", "Q8_0", 4.08, 128, 0, 131072, "t", "", "MIT"),
    ("phi4:14b", "Phi-4 14B", "Q4_K_M", 9.05, 200, 0, 16384, "", "", "MIT"),
    ("phi4:14b-q8_0", "Phi-4 14B", "Q8_0", 15.58, 200, 0, 16384, "", "", "MIT"),
    ("granite4:350m", "Granite 4 350M", "BF16", 0.71, 28, 0, 32768, "t", "", "Apache-2.0"),
    ("granite4:1b", "Granite 4 1B", "BF16", 3.27, 80, 0, 131072, "t", "", "Apache-2.0"),
    ("granite4:3b", "Granite 4 3B", "Q4_K_M", 2.1, 80, 0, 131072, "t", "", "Apache-2.0"),
    ("granite4:350m-h-q8_0", "Granite 4 350M", "Q8_0", 0.37, 4, 0, 1048576, "t", "", "Apache-2.0"),
    ("granite4:1b-h-q8_0", "Granite 4 1B", "Q8_0", 1.56, 8, 0, 1048576, "t", "", "Apache-2.0"),
    ("smollm2:135m", "SmolLM2 135M", "F16", 0.27, 22.5, 0, 8192, "t", "", "Apache-2.0"),
    ("smollm2:360m", "SmolLM2 360M", "F16", 0.73, 40, 0, 8192, "t", "", "Apache-2.0"),
    ("smollm2:1.7b", "SmolLM2 1.7B", "Q8_0", 1.82, 192, 0, 8192, "t", "", "Apache-2.0"),
    ("smollm2:135m-instruct-q8_0", "SmolLM2 135M", "Q8_0", 0.14, 22.5, 0, 8192, "t", "", "Apache-2.0"),
    ("smollm2:360m-instruct-q8_0", "SmolLM2 360M", "Q8_0", 0.39, 40, 0, 8192, "t", "", "Apache-2.0"),
    ("cogito:3b", "Cogito 3B", "Q4_K_M", 2.24, 112, 0, 131072, "t", "", "Licença Llama"),
    ("cogito:8b", "Cogito 8B", "Q4_K_M", 4.92, 128, 0, 131072, "t", "", "Licença Llama"),
    ("cogito:14b", "Cogito 14B", "Q4_K_M", 8.99, 192, 0, 131072, "t", "", "Apache-2.0"),
    ("cogito:32b", "Cogito 32B", "Q4_K_M", 19.85, 256, 0, 131072, "t", "", "Apache-2.0"),
    ("cogito:70b", "Cogito 70B", "Q4_K_M", 42.52, 320, 0, 131072, "t", "", "Apache-2.0"),
    ("cogito:3b-v1-preview-llama-q8_0", "Cogito 3B", "Q8_0", 3.84, 112, 0, 131072, "t", "", "Licença Llama"),
    ("cogito:8b-v1-preview-llama-q8_0", "Cogito 8B", "Q8_0", 8.54, 128, 0, 131072, "t", "", "Licença Llama"),
    ("cogito:14b-v1-preview-qwen-q8_0", "Cogito 14B", "Q8_0", 15.7, 192, 0, 131072, "t", "", "Apache-2.0"),
    ("cogito:32b-v1-preview-qwen-q8_0", "Cogito 32B", "Q8_0", 34.82, 256, 0, 131072, "t", "", "Apache-2.0"),
    ("cogito:70b-v1-preview-llama-q8_0", "Cogito 70B", "Q8_0", 74.98, 320, 0, 131072, "t", "", "Apache-2.0"),
    ("hermes3:3b", "Hermes 3 3B", "Q4_K_M", 2.02, 112, 0, 131072, "t", "", "Licença Llama"),
    ("hermes3:8b", "Hermes 3 8B", "Q4_0", 4.66, 128, 0, 131072, "t", "", "Licença Llama"),
    ("hermes3:70b", "Hermes 3 70B", "Q4_0", 39.97, 320, 0, 131072, "t", "", "Licença Llama"),
    ("hermes3:3b-llama3.2-q8_0", "Hermes 3 3B", "Q8_0", 3.42, 112, 0, 131072, "t", "", "Licença Llama"),
    ("hermes3:8b-llama3.1-q8_0", "Hermes 3 8B", "Q8_0", 8.54, 128, 0, 131072, "t", "", "Licença Llama"),
    ("hermes3:70b-llama3.1-q8_0", "Hermes 3 70B", "Q8_0", 74.98, 320, 0, 131072, "t", "", "Licença Llama"),
    ("olmo2:7b", "OLMo 2 7B", "Q4_K_M", 4.47, 512, 0, 4096, "", "", "Apache-2.0"),
    ("olmo2:13b", "OLMo 2 13B", "Q4_K_M", 8.35, 800, 0, 4096, "", "", "Apache-2.0"),
    ("olmo2:7b-1124-instruct-q8_0", "OLMo 2 7B", "Q8_0", 7.76, 512, 0, 4096, "", "", "Apache-2.0"),
    ("olmo2:13b-1124-instruct-q8_0", "OLMo 2 13B", "Q8_0", 14.58, 800, 0, 4096, "", "", "Apache-2.0"),
    ("minicpm-v:8b", "MiniCPM-V 8B", "Q4_0", 5.47, 56, 0, 32768, "v", "", "ver a página do modelo"),
    ("minicpm-v:8b-2.6-q8_0", "MiniCPM-V 8B", "Q8_0", 9.14, 56, 0, 32768, "v", "", "ver a página do modelo"),
    ("llama4:16x17b", "Llama 4 16x17B", "Q4_K_M", 67.44, 192, 0, 10485760, "vtm", "", "Licença Llama"),
    ("qwen3-next:80b", "Qwen3-Next 80B", "Q4_K_M", 50.35, 96, 0, 262144, "tkm", "", "Apache-2.0"),
    ("qwen3-next:80b-a3b-instruct-q8_0", "Qwen3-Next 80B", "Q8_0", 84.81, 96, 0, 262144, "tkm", "", "Apache-2.0"),
    ("nemotron-3-super:120b", "Nemotron 3 Super 120B", "Q4_K_M", 86.83, 8, 0, 262144, "tkm", "", "ver a página do modelo"),
    ("gemma3n:e2b", "Gemma 3n E2B", "Q4_K_M", 7.84, 12, 24, 32768, "v", "", "Termos do Gemma"),
    ("gemma3n:e4b", "Gemma 3n E4B", "Q4_K_M", 9.77, 14, 28, 32768, "v", "", "Termos do Gemma"),
    ("gemma3n:e2b-it-q8_0", "Gemma 3n E2B", "Q8_0", 6.94, 12, 24, 32768, "v", "", "Termos do Gemma"),
    ("gemma3n:e4b-it-q8_0", "Gemma 3n E4B", "Q8_0", 9.51, 14, 28, 32768, "v", "", "Termos do Gemma"),
    ("command-r:35b", "Command R 35B", "Q4_0", 18.72, 160, 0, 131072, "t", "", "Creative Commons"),
    ("command-r:35b-v0.1-q8_0", "Command R 35B", "Q8_0", 37.18, 1280, 0, 131072, "t", "", "Creative Commons"),
    ("command-r7b:7b", "Command R7B 7B", "Q4_K_M", 5.06, 128, 0, 8192, "t", "", "Creative Commons"),
    ("command-r7b:7b-12-2024-q8_0", "Command R7B 7B", "Q8_0", 8.54, 128, 0, 8192, "t", "", "Creative Commons"),
    ("aya-expanse:8b", "Aya Expanse 8B", "Q4_K_M", 5.06, 128, 0, 8192, "t", "", "Creative Commons"),
    ("aya-expanse:32b", "Aya Expanse 32B", "Q4_K_M", 19.8, 160, 0, 8192, "t", "", "Creative Commons"),
    ("aya-expanse:8b-q8_0", "Aya Expanse 8B", "Q8_0", 8.54, 128, 0, 8192, "t", "", "Creative Commons"),
    ("aya-expanse:32b-q8_0", "Aya Expanse 32B", "Q8_0", 34.33, 160, 0, 8192, "t", "", "Creative Commons"),
    ("exaone3.5:2.4b", "EXAONE 3.5 2.4B", "Q4_K_M", 1.64, 75, 0, 32768, "", "", "ver a página do modelo"),
    ("exaone3.5:7.8b", "EXAONE 3.5 7.8B", "Q4_K_M", 4.77, 128, 0, 32768, "", "", "ver a página do modelo"),
    ("exaone3.5:32b", "EXAONE 3.5 32B", "Q4_K_M", 19.34, 256, 0, 32768, "", "", "ver a página do modelo"),
    ("exaone3.5:2.4b-instruct-q8_0", "EXAONE 3.5 2.4B", "Q8_0", 2.84, 75, 0, 32768, "", "", "ver a página do modelo"),
    ("exaone3.5:7.8b-instruct-q8_0", "EXAONE 3.5 7.8B", "Q8_0", 8.31, 128, 0, 32768, "", "", "ver a página do modelo"),
    ("exaone3.5:32b-instruct-q8_0", "EXAONE 3.5 32B", "Q8_0", 34.01, 256, 0, 32768, "", "", "ver a página do modelo"),
    ("falcon3:1b", "Falcon 3 1B", "Q8_0", 1.78, 72, 0, 8192, "", "", "Apache-2.0"),
    ("falcon3:3b", "Falcon 3 3B", "Q4_K_M", 2.01, 88, 0, 32768, "", "", "Apache-2.0"),
    ("falcon3:7b", "Falcon 3 7B", "Q4_K_M", 4.57, 112, 0, 32768, "", "", "Apache-2.0"),
    ("falcon3:10b", "Falcon 3 10B", "Q4_K_M", 6.29, 160, 0, 32768, "", "", "Apache-2.0"),
    ("falcon3:3b-instruct-q8_0", "Falcon 3 3B", "Q8_0", 3.43, 88, 0, 32768, "", "", "Apache-2.0"),
    ("falcon3:7b-instruct-q8_0", "Falcon 3 7B", "Q8_0", 7.93, 112, 0, 32768, "", "", "Apache-2.0"),
    ("falcon3:10b-instruct-q8_0", "Falcon 3 10B", "Q8_0", 10.96, 160, 0, 32768, "", "", "Apache-2.0"),
    ("lfm2:24b", "LFM2 24B", "Q4_K_M", 14.42, 20, 0, 32768, "tm", "", "ver a página do modelo"),
    ("lfm2:24b-q8_0", "LFM2 24B", "Q8_0", 25.35, 20, 0, 32768, "tm", "", "ver a página do modelo"),
    ("lfm2.5:8b", "LFM2.5 8B", "Q4_K_M", 5.16, 12, 0, 128000, "tkm", "", "ver a página do modelo"),
    ("lfm2.5:24b", "LFM2.5 24B", "Q4_K_M", 14.53, 20, 0, 131072, "tkm", "", "ver a página do modelo"),
    ("lfm2.5:8b-a1b-q8_0", "LFM2.5 8B", "Q8_0", 9.01, 12, 0, 128000, "tkm", "", "ver a página do modelo"),
    ("lfm2.5:24b-a2b-q8_0", "LFM2.5 24B", "Q8_0", 25.49, 20, 0, 131072, "tkm", "", "ver a página do modelo"),
    ("qwen3-coder:30b", "Qwen3-Coder 30B", "Q4_K_M", 18.56, 96, 0, 262144, "tm", "c", "Apache-2.0"),
    ("qwen3-coder:30b-a3b-q8_0", "Qwen3-Coder 30B", "Q8_0", 32.48, 96, 0, 262144, "tm", "c", "Apache-2.0"),
    ("qwen3-coder-next:latest", "Qwen3-Coder-Next 79.7B", "Q4_K_M", 51.74, 24, 0, 262144, "tm", "c", "Apache-2.0"),
    ("qwen3-coder-next:q8_0", "Qwen3-Coder-Next 79.7B", "Q8_0", 84.81, 24, 0, 262144, "tm", "c", "Apache-2.0"),
    ("qwen2.5-coder:0.5b", "Qwen2.5-Coder 0.5B", "Q4_K_M", 0.4, 12, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:1.5b", "Qwen2.5-Coder 1.5B", "Q4_K_M", 0.99, 28, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:3b", "Qwen2.5-Coder 3B", "Q4_K_M", 1.93, 36, 0, 32768, "t", "c", "Licença Qwen"),
    ("qwen2.5-coder:7b", "Qwen2.5-Coder 7B", "Q4_K_M", 4.68, 56, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:14b", "Qwen2.5-Coder 14B", "Q4_K_M", 8.99, 192, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:32b", "Qwen2.5-Coder 32B", "Q4_K_M", 19.85, 256, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:0.5b-instruct-q8_0", "Qwen2.5-Coder 0.5B", "Q8_0", 0.53, 12, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:1.5b-instruct-q8_0", "Qwen2.5-Coder 1.5B", "Q8_0", 1.65, 28, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:3b-instruct-q8_0", "Qwen2.5-Coder 3B", "Q8_0", 3.29, 36, 0, 32768, "t", "c", "Licença Qwen"),
    ("qwen2.5-coder:7b-instruct-q8_0", "Qwen2.5-Coder 7B", "Q8_0", 8.1, 56, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:14b-instruct-q8_0", "Qwen2.5-Coder 14B", "Q8_0", 15.7, 192, 0, 32768, "t", "c", "Apache-2.0"),
    ("qwen2.5-coder:32b-instruct-q8_0", "Qwen2.5-Coder 32B", "Q8_0", 34.82, 256, 0, 32768, "t", "c", "Apache-2.0"),
    ("devstral-small-2:24b", "Devstral Small 2 24B", "Q4_K_M", 15.18, 160, 0, 393216, "vt", "c", ""),
    ("devstral-small-2:24b-instruct-2512-q8_0", "Devstral Small 2 24B", "Q8_0", 25.91, 160, 0, 393216, "vt", "c", ""),
    ("devstral:24b", "Devstral 24B", "Q4_K_M", 14.33, 160, 0, 131072, "t", "c", "Apache-2.0"),
    ("devstral:24b-small-2505-q8_0", "Devstral 24B", "Q8_0", 25.05, 160, 0, 131072, "t", "c", "Apache-2.0"),
    ("codestral:22b", "Codestral 22B", "Q4_0", 12.57, 224, 0, 32768, "", "c", "ver a página do modelo"),
    ("codestral:22b-v0.1-q8_0", "Codestral 22B", "Q8_0", 23.64, 224, 0, 32768, "", "c", "ver a página do modelo"),
    ("deepseek-r1:1.5b", "DeepSeek-R1 (destilados) 1.5B", "Q4_K_M", 1.12, 28, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:7b", "DeepSeek-R1 (destilados) 7B", "Q4_K_M", 4.68, 56, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:8b", "DeepSeek-R1 (destilados) 8B", "Q4_K_M", 5.23, 144, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:14b", "DeepSeek-R1 (destilados) 14B", "Q4_K_M", 8.99, 192, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:32b", "DeepSeek-R1 (destilados) 32B", "Q4_K_M", 19.85, 256, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:70b", "DeepSeek-R1 (destilados) 70B", "Q4_K_M", 42.52, 320, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:1.5b-qwen-distill-q8_0", "DeepSeek-R1 (destilados) 1.5B", "Q8_0", 1.89, 28, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:7b-qwen-distill-q8_0", "DeepSeek-R1 (destilados) 7B", "Q8_0", 8.1, 56, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:8b-0528-qwen3-q8_0", "DeepSeek-R1 (destilados) 8B", "Q8_0", 8.85, 144, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:14b-qwen-distill-q8_0", "DeepSeek-R1 (destilados) 14B", "Q8_0", 15.7, 192, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:32b-qwen-distill-q8_0", "DeepSeek-R1 (destilados) 32B", "Q8_0", 34.82, 256, 0, 131072, "tk", "r", "MIT"),
    ("deepseek-r1:70b-llama-distill-q8_0", "DeepSeek-R1 (destilados) 70B", "Q8_0", 74.98, 320, 0, 131072, "tk", "r", "MIT"),
    ("qwq:32b", "QwQ 32B", "Q4_K_M", 19.85, 256, 0, 40960, "t", "r", "Apache-2.0"),
    ("qwq:32b-q8_0", "QwQ 32B", "Q8_0", 34.82, 256, 0, 40960, "t", "r", "Apache-2.0"),
    ("magistral:24b", "Magistral 24B", "Q4_K_M", 14.33, 160, 0, 40000, "tk", "r", "Apache-2.0"),
    ("magistral:24b-small-2506-q8_0", "Magistral 24B", "Q8_0", 25.05, 160, 0, 40000, "tk", "r", "Apache-2.0"),
    ("phi4-reasoning:14b", "Phi-4 reasoning 14B", "Q4_K_M", 11.12, 200, 0, 32768, "", "r", "MIT"),
    ("phi4-reasoning:14b-q8_0", "Phi-4 reasoning 14B", "Q8_0", 17.06, 200, 0, 32768, "", "r", "MIT"),
    ("lfm2.5-thinking:1.2b", "LFM2.5 Thinking 1.2B", "Q4_K_M", 0.73, 12, 0, 128000, "tk", "r", "ver a página do modelo"),
    ("lfm2.5-thinking:1.2b-q8_0", "LFM2.5 Thinking 1.2B", "Q8_0", 1.25, 12, 0, 128000, "tk", "r", "ver a página do modelo"),
    ("exaone-deep:2.4b", "EXAONE Deep 2.4B", "Q4_K_M", 1.64, 75, 0, 32768, "", "r", "ver a página do modelo"),
    ("exaone-deep:7.8b", "EXAONE Deep 7.8B", "Q4_K_M", 4.77, 128, 0, 32768, "", "r", "ver a página do modelo"),
    ("exaone-deep:32b", "EXAONE Deep 32B", "Q4_K_M", 19.34, 256, 0, 32768, "", "r", "ver a página do modelo"),
    ("exaone-deep:2.4b-q8_0", "EXAONE Deep 2.4B", "Q8_0", 2.84, 75, 0, 32768, "", "r", "ver a página do modelo"),
    ("exaone-deep:7.8b-q8_0", "EXAONE Deep 7.8B", "Q8_0", 8.31, 128, 0, 32768, "", "r", "ver a página do modelo"),
    ("exaone-deep:32b-q8_0", "EXAONE Deep 32B", "Q8_0", 34.01, 256, 0, 32768, "", "r", "ver a página do modelo"),
    ("openthinker:7b", "OpenThinker 7B", "Q4_K_M", 4.68, 56, 0, 32768, "", "r", "Apache-2.0"),
    ("openthinker:32b", "OpenThinker 32B", "Q4_K_M", 19.85, 256, 0, 32768, "", "r", "Apache-2.0"),
    ("openthinker:7b-q8_0", "OpenThinker 7B", "Q8_0", 8.1, 56, 0, 32768, "", "r", "Apache-2.0"),
    ("openthinker:32b-q8_0", "OpenThinker 32B", "Q8_0", 34.82, 256, 0, 32768, "", "r", "Apache-2.0"),
    ("dolphin3:8b", "Dolphin 3 8B", "Q4_K_M", 4.92, 128, 0, 131072, "", "u", "Licença Llama"),
    ("dolphin3:8b-llama3.1-q8_0", "Dolphin 3 8B", "Q8_0", 8.54, 128, 0, 131072, "", "u", "Licença Llama"),
    ("dolphin-llama3:8b", "Dolphin Llama 3 8B", "Q4_0", 4.66, 128, 0, 8192, "", "u", "Licença Llama"),
    ("dolphin-llama3:70b", "Dolphin Llama 3 70B", "Q4_0", 39.97, 320, 0, 8192, "", "u", "Licença Llama"),
    ("dolphin-llama3:8b-v2.9-q8_0", "Dolphin Llama 3 8B", "Q8_0", 8.54, 128, 0, 8192, "", "u", "Licença Llama"),
    ("dolphin-llama3:70b-v2.9-q8_0", "Dolphin Llama 3 70B", "Q8_0", 74.98, 320, 0, 8192, "", "u", "Licença Llama"),
    ("dolphin-mistral:7b", "Dolphin Mistral 7B", "Q4_0", 4.11, 128, 0, 32768, "", "u", "Apache-2.0"),
    ("dolphin-mistral:7b-v2-q8_0", "Dolphin Mistral 7B", "Q8_0", 7.7, 128, 0, 32768, "", "u", "Apache-2.0"),
    ("dolphin-mixtral:8x7b", "Dolphin Mixtral 8x7B", "Q4_0", 26.44, 128, 0, 32768, "m", "u", "Apache-2.0"),
    ("dolphin-mixtral:8x22b", "Dolphin Mixtral 8x22B", "Q4_0", 79.51, 224, 0, 65536, "m", "u", "Apache-2.0"),
    ("dolphin-mixtral:8x7b-v2.5-q8_0", "Dolphin Mixtral 8x7B", "Q8_0", 49.63, 128, 0, 32768, "m", "u", "Apache-2.0"),
    ("dolphincoder:7b", "DolphinCoder 7B", "Q4_0", 4.23, 64, 0, 16384, "", "uc", "OpenRAIL"),
    ("dolphincoder:15b", "DolphinCoder 15B", "Q4_0", 9.07, 80, 0, 16384, "", "uc", "OpenRAIL"),
    ("dolphincoder:7b-starcoder2-q8_0", "DolphinCoder 7B", "Q8_0", 7.87, 64, 0, 16384, "", "uc", "OpenRAIL"),
    ("dolphincoder:15b-starcoder2-q8_0", "DolphinCoder 15B", "Q8_0", 16.97, 80, 0, 16384, "", "uc", "OpenRAIL"),
    ("llama2-uncensored:7b", "Llama 2 Uncensored 7B", "Q4_0", 3.83, 512, 0, 2048, "", "u", "Licença Llama"),
    ("llama2-uncensored:70b", "Llama 2 Uncensored 70B", "Q4_0", 38.87, 320, 0, 2048, "", "u", "Licença Llama"),
    ("llama2-uncensored:7b-chat-q8_0", "Llama 2 Uncensored 7B", "Q8_0", 7.16, 512, 0, 2048, "", "u", "Licença Llama"),
    ("llama2-uncensored:70b-chat-q8_0", "Llama 2 Uncensored 70B", "Q8_0", 73.29, 320, 0, 2048, "", "u", "Licença Llama"),
    ("wizard-vicuna-uncensored:7b", "Wizard Vicuna Uncensored 7B", "Q4_0", 3.83, 512, 0, 2048, "", "u", ""),
    ("wizard-vicuna-uncensored:13b", "Wizard Vicuna Uncensored 13B", "Q4_0", 7.37, 800, 0, 2048, "", "u", ""),
    ("wizard-vicuna-uncensored:30b", "Wizard Vicuna Uncensored 30B", "Q4_0", 18.36, 1560, 0, 2048, "", "u", ""),
    ("wizard-vicuna-uncensored:7b-q8_0", "Wizard Vicuna Uncensored 7B", "Q8_0", 7.16, 512, 0, 2048, "", "u", ""),
    ("wizard-vicuna-uncensored:13b-q8_0", "Wizard Vicuna Uncensored 13B", "Q8_0", 13.83, 800, 0, 2048, "", "u", ""),
    ("wizard-vicuna-uncensored:30b-q8_0", "Wizard Vicuna Uncensored 30B", "Q8_0", 34.57, 1560, 0, 2048, "", "u", ""),
    ("wizardlm-uncensored:13b", "WizardLM Uncensored 13B", "Q4_0", 7.37, 800, 0, 4096, "", "u", ""),
    ("wizardlm-uncensored:13b-llama2-q8_0", "WizardLM Uncensored 13B", "Q8_0", 13.83, 800, 0, 4096, "", "u", ""),
    ("huihui_ai/Qwen3.8-abliterated:27b", "Qwen3.8 abliterated 27B", "Q4_K_M", 17.74, 64, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/Qwen3.8-abliterated:27b-q8_0", "Qwen3.8 abliterated 27B", "Q8_0", 29.98, 64, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/Qwen3.6-abliterated:27b", "Qwen3.6 abliterated 27B", "Q4_K_M", 17.42, 64, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/Qwen3.6-abliterated:35b", "Qwen3.6 abliterated 35B", "Q4_K_M", 23.94, 20, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/Qwen3.6-abliterated:27b-q8_0", "Qwen3.6 abliterated 27B", "Q8_0", 29.97, 64, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/Qwen3.6-abliterated:35b-a3b-q8_0", "Qwen3.6 abliterated 35B", "Q8_0", 38.7, 20, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:0.8B", "Qwen3.5 abliterated 0.8B", "Q8_0", 1.04, 12, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:2B", "Qwen3.5 abliterated 2B", "Q4_K_M", 1.95, 12, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:4B", "Qwen3.5 abliterated 4B", "Q4_K_M", 3.32, 32, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:9b", "Qwen3.5 abliterated 9B", "Q4_K_M", 6.59, 32, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:27b", "Qwen3.5 abliterated 27B", "Q4_K_M", 17.42, 64, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:35b", "Qwen3.5 abliterated 35B", "Q4_K_M", 23.87, 20, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:122B", "Qwen3.5 abliterated 122B", "Q4_K_M", 81.37, 24, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:2B-q8_0", "Qwen3.5 abliterated 2B", "Q8_0", 2.74, 12, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:4B-q8_0", "Qwen3.5 abliterated 4B", "Q8_0", 5.15, 32, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:9b-q8_0", "Qwen3.5 abliterated 9B", "Q8_0", 10.7, 32, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:27b-q8_0", "Qwen3.5 abliterated 27B", "Q8_0", 29.97, 64, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3.5-abliterated:35b-a3b-q8_0", "Qwen3.5 abliterated 35B", "Q8_0", 38.7, 20, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:0.6b", "Qwen3 abliterated 0.6B", "Q4_K_M", 0.4, 112, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:1.7b", "Qwen3 abliterated 1.7B", "Q4_K_M", 1.11, 112, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:4b", "Qwen3 abliterated 4B", "Q4_K_M", 2.5, 144, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:8b", "Qwen3 abliterated 8B", "Q4_K_M", 5.03, 144, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:14b", "Qwen3 abliterated 14B", "Q4_K_M", 9, 160, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:16b", "Qwen3 abliterated 16B", "Q4_K_M", 9.75, 96, 0, 40960, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:30b", "Qwen3 abliterated 30B", "Q4_K_M", 18.56, 96, 0, 40960, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:32b", "Qwen3 abliterated 32B", "Q4_K_M", 19.76, 256, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:0.6b-q8_0", "Qwen3 abliterated 0.6B", "Q8_0", 0.64, 112, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:1.7b-q8_0", "Qwen3 abliterated 1.7B", "Q8_0", 1.83, 112, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:4b-q8_0", "Qwen3 abliterated 4B", "Q8_0", 4.28, 144, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:8b-q8_0", "Qwen3 abliterated 8B", "Q8_0", 8.71, 144, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:14b-q8_0", "Qwen3 abliterated 14B", "Q8_0", 15.7, 160, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:16b-a3b-q8_0", "Qwen3 abliterated 16B", "Q8_0", 17.06, 96, 0, 40960, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:30b-a3b-q8_0", "Qwen3 abliterated 30B", "Q8_0", 32.48, 96, 0, 40960, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-abliterated:32b-q8_0", "Qwen3 abliterated 32B", "Q8_0", 34.82, 256, 0, 40960, "tk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:2b", "Qwen3-VL abliterated 2B", "Q4_K_M", 1.89, 112, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:4b", "Qwen3-VL abliterated 4B", "Q4_K_M", 3.3, 144, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:8b", "Qwen3-VL abliterated 8B", "Q4_K_M", 6.14, 144, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:30b", "Qwen3-VL abliterated 30B", "Q4_K_M", 19.6, 96, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:32b", "Qwen3-VL abliterated 32B", "Q4_K_M", 20.91, 256, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:2b-q8_0", "Qwen3-VL abliterated 2B", "Q8_0", 2.63, 112, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:4b-instruct-q8_0", "Qwen3-VL abliterated 4B", "Q8_0", 5.09, 144, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:8b-instruct-q8_0", "Qwen3-VL abliterated 8B", "Q8_0", 9.83, 144, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:30b-a3b-instruct-q8_0", "Qwen3-VL abliterated 30B", "Q8_0", 33.53, 96, 0, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-vl-abliterated:32b-instruct-q8_0", "Qwen3-VL abliterated 32B", "Q8_0", 35.98, 256, 0, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:e2b", "Gemma 4 abliterated E2B", "Q4_K_M", 7.16, 14, 28, 131072, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:e4b", "Gemma 4 abliterated E4B", "Q4_K_M", 9.61, 28, 70, 131072, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:12b", "Gemma 4 abliterated 12B", "Q4_K_M", 7.56, 16, 640, 131072, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:26b", "Gemma 4 abliterated 26B", "Q4_K_M", 17.99, 20, 400, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:31b", "Gemma 4 abliterated 31B", "Q4_K_M", 19.87, 80, 1600, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:48b", "Gemma 4 abliterated 48B", "Q4_K_M", 33.16, 20, 400, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:e2b-q8_0", "Gemma 4 abliterated E2B", "Q8_0", 8.14, 14, 28, 131072, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:e4b-q8_0", "Gemma 4 abliterated E4B", "Q8_0", 11.64, 28, 70, 131072, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:26b-q8_0", "Gemma 4 abliterated 26B", "Q8_0", 28.05, 20, 400, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:31B-q8_0", "Gemma 4 abliterated 31B", "Q8_0", 33.83, 80, 1600, 262144, "vtk", "u", "Apache-2.0"),
    ("huihui_ai/gemma-4-abliterated:48b-q8_0", "Gemma 4 abliterated 48B", "Q8_0", 52.36, 20, 400, 262144, "vtkm", "u", "Apache-2.0"),
    ("huihui_ai/gemma3-abliterated:270m", "Gemma 3 abliterated 270M", "F16", 0.54, 3, 8, 32768, "", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:1b", "Gemma 3 abliterated 1B", "Q4_K_M", 0.81, 4, 11, 32768, "", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:4b", "Gemma 3 abliterated 4B", "F16", 8.62, 20, 116, 131072, "v", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:12b", "Gemma 3 abliterated 12B", "F16", 24.39, 64, 320, 131072, "v", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:27b", "Gemma 3 abliterated 27B", "F16", 54.88, 80, 416, 131072, "", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:1b-q8_0", "Gemma 3 abliterated 1B", "Q8_0", 1.07, 4, 11, 32768, "", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:4b-q8_0", "Gemma 3 abliterated 4B", "Q8_0", 4.98, 20, 116, 131072, "", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:12b-q8_0", "Gemma 3 abliterated 12B", "Q8_0", 13.36, 64, 320, 131072, "", "u", "Termos do Gemma"),
    ("huihui_ai/gemma3-abliterated:27b-q8_0", "Gemma 3 abliterated 27B", "Q8_0", 29.56, 80, 416, 131072, "", "u", "Termos do Gemma"),
    ("huihui_ai/gpt-oss-abliterated:20b", "gpt-oss abliterated 20B", "F16", 13.79, 24, 3, 131072, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/gpt-oss-abliterated:120b", "gpt-oss abliterated 120B", "Q4_K_M", 87.85, 36, 5, 131072, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/gpt-oss-abliterated:20b-q8_0", "gpt-oss abliterated 20B", "Q8_0", 22.26, 24, 3, 131072, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:0.5b", "Qwen2.5-Coder abliterated 0.5B", "Q4_K_M", 0.4, 12, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:1.5b", "Qwen2.5-Coder abliterated 1.5B", "Q4_K_M", 1.12, 28, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:3b", "Qwen2.5-Coder abliterated 3B", "Q4_K_M", 1.93, 36, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:7b", "Qwen2.5-Coder abliterated 7B", "Q4_K_M", 4.68, 56, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:14b", "Qwen2.5-Coder abliterated 14B", "Q4_K_M", 8.99, 192, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:32b", "Qwen2.5-Coder abliterated 32B", "Q4_K_M", 19.85, 256, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:0.5b-instruct-q8_0", "Qwen2.5-Coder abliterated 0.5B", "Q8_0", 0.53, 12, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:1.5b-instruct-q8_0", "Qwen2.5-Coder abliterated 1.5B", "Q8_0", 1.89, 28, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:3b-instruct-q8_0", "Qwen2.5-Coder abliterated 3B", "Q8_0", 3.29, 36, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:7b-instruct-q8_0", "Qwen2.5-Coder abliterated 7B", "Q8_0", 8.1, 56, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:14b-instruct-q8_0", "Qwen2.5-Coder abliterated 14B", "Q8_0", 15.7, 192, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/qwen2.5-coder-abliterate:32b-instruct-q8_0", "Qwen2.5-Coder abliterated 32B", "Q8_0", 34.82, 256, 0, 32768, "t", "uc", "Apache-2.0"),
    ("huihui_ai/devstral-abliterated:24b", "Devstral abliterated 24B", "Q4_K_M", 14.33, 160, 0, 131072, "t", "uc", "Apache-2.0"),
    ("huihui_ai/devstral-abliterated:24b-small-2505-q8_0", "Devstral abliterated 24B", "Q8_0", 25.05, 160, 0, 131072, "t", "uc", "Apache-2.0"),
    ("huihui_ai/mistral-small-abliterated:24b", "Mistral Small abliterated 24B", "Q4_K_M", 14.33, 160, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/mistral-small-abliterated:24b-instruct-2501-q8_0", "Mistral Small abliterated 24B", "Q8_0", 25.05, 160, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/llama3.3-abliterated:70b", "Llama 3.3 abliterated 70B", "Q4_K_M", 42.52, 320, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/llama3.3-abliterated:70b-instruct-q8_0", "Llama 3.3 abliterated 70B", "Q8_0", 74.98, 320, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/deepseek-r1-abliterated:1.5b", "DeepSeek-R1 abliterated 1.5B", "Q4_K_M", 1.12, 28, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:7b", "DeepSeek-R1 abliterated 7B", "Q4_K_M", 4.68, 56, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:8b", "DeepSeek-R1 abliterated 8B", "Q4_K_M", 5.03, 144, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:14b", "DeepSeek-R1 abliterated 14B", "Q4_K_M", 8.99, 192, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:32b", "DeepSeek-R1 abliterated 32B", "Q4_K_M", 19.85, 256, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:70b", "DeepSeek-R1 abliterated 70B", "Q4_K_M", 42.52, 320, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:1.5b-qwen-distill-q8_0", "DeepSeek-R1 abliterated 1.5B", "Q8_0", 1.89, 28, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:7b-qwen-distill-q8_0", "DeepSeek-R1 abliterated 7B", "Q8_0", 8.1, 56, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:8b-0528-qwen3-q8_0", "DeepSeek-R1 abliterated 8B", "Q8_0", 8.71, 144, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:14b-qwen-distill-q8_0", "DeepSeek-R1 abliterated 14B", "Q8_0", 15.7, 192, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:32b-qwen-distill-q8_0", "DeepSeek-R1 abliterated 32B", "Q8_0", 34.82, 256, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/deepseek-r1-abliterated:70b-llama-distill-q8_0", "DeepSeek-R1 abliterated 70B", "Q8_0", 74.98, 320, 0, 131072, "k", "ur", "MIT"),
    ("huihui_ai/dolphin3-abliterated:8b", "Dolphin 3 abliterated 8B", "Q4_K_M", 4.92, 128, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/dolphin3-abliterated:8b-llama3.1-q8_0", "Dolphin 3 abliterated 8B", "Q8_0", 8.54, 128, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/phi4-mini-abliterated:3.8b", "Phi-4 mini abliterated 3.8B", "Q4_K_M", 2.49, 128, 0, 131072, "t", "u", "MIT"),
    ("huihui_ai/phi4-mini-abliterated:3.8b-q8_0", "Phi-4 mini abliterated 3.8B", "Q8_0", 4.08, 128, 0, 131072, "t", "u", "MIT"),
    ("huihui_ai/qwen3-coder-abliterated:30b", "Qwen3-Coder abliterated 30B", "Q4_K_M", 18.56, 96, 0, 262144, "m", "uc", "Apache-2.0"),
    ("huihui_ai/qwen3-coder-abliterated:30b-a3b-instruct-q8_0", "Qwen3-Coder abliterated 30B", "Q8_0", 32.48, 96, 0, 262144, "m", "uc", "Apache-2.0"),
    ("huihui_ai/qwen3-coder-next-abliterated:latest", "Qwen3-Coder-Next abliterated 79.7B", "Q4_K_M", 51.74, 24, 0, 262144, "tm", "uc", "Apache-2.0"),
    ("huihui_ai/qwen3-coder-next-abliterated:q8_0", "Qwen3-Coder-Next abliterated 79.7B", "Q8_0", 84.81, 24, 0, 262144, "tm", "uc", "Apache-2.0"),
    ("huihui_ai/qwen3-next-abliterated:80b", "Qwen3-Next abliterated 80B", "Q4_K_M", 48.41, 96, 0, 262144, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen3-next-abliterated:80b-a3b-instruct-q8_0", "Qwen3-Next abliterated 80B", "Q8_0", 84.81, 96, 0, 262144, "tkm", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:0.5b", "Qwen2.5 abliterated 0.5B", "Q4_K_M", 0.4, 12, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:1.5b", "Qwen2.5 abliterated 1.5B", "Q4_K_M", 0.99, 28, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:3b", "Qwen2.5 abliterated 3B", "Q4_K_M", 1.93, 36, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:7b", "Qwen2.5 abliterated 7B", "Q4_K_M", 4.68, 56, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:14b", "Qwen2.5 abliterated 14B", "Q4_K_M", 8.99, 192, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:32b", "Qwen2.5 abliterated 32B", "Q4_K_M", 19.85, 256, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:72b", "Qwen2.5 abliterated 72B", "Q4_K_M", 47.42, 320, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:0.5b-instruct-q8_0", "Qwen2.5 abliterated 0.5B", "Q8_0", 0.53, 12, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:1.5b-instruct-q8_0", "Qwen2.5 abliterated 1.5B", "Q8_0", 1.65, 28, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:3b-instruct-q8_0", "Qwen2.5 abliterated 3B", "Q8_0", 3.29, 36, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:7b-instruct-q8_0", "Qwen2.5 abliterated 7B", "Q8_0", 8.1, 56, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:14b-instruct-q8_0", "Qwen2.5 abliterated 14B", "Q8_0", 15.7, 192, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:32b-instruct-q8_0", "Qwen2.5 abliterated 32B", "Q8_0", 34.82, 256, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-abliterate:72b-instruct-q8_0", "Qwen2.5 abliterated 72B", "Q8_0", 77.26, 320, 0, 32768, "t", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-vl-abliterated:3b", "Qwen2.5-VL abliterated 3B", "Q4_K_M", 3.2, 36, 0, 128000, "v", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-vl-abliterated:7b", "Qwen2.5-VL abliterated 7B", "Q4_K_M", 5.97, 56, 0, 128000, "v", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-vl-abliterated:32b", "Qwen2.5-VL abliterated 32B", "Q4_K_M", 21.16, 256, 0, 128000, "v", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-vl-abliterated:3b-instruct-q8_0", "Qwen2.5-VL abliterated 3B", "Q8_0", 4.58, 36, 0, 128000, "v", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-vl-abliterated:7b-instruct-q8_0", "Qwen2.5-VL abliterated 7B", "Q8_0", 9.4, 56, 0, 128000, "v", "u", "Apache-2.0"),
    ("huihui_ai/qwen2.5-vl-abliterated:32b-instruct-q8_0", "Qwen2.5-VL abliterated 32B", "Q8_0", 36.15, 256, 0, 128000, "v", "u", "Apache-2.0"),
    ("huihui_ai/qwq-abliterated:32b", "QwQ abliterated 32B", "Q4_K_M", 19.85, 256, 0, 131072, "t", "ur", "Apache-2.0"),
    ("huihui_ai/qwq-abliterated:32b-q8_0", "QwQ abliterated 32B", "Q8_0", 34.82, 256, 0, 131072, "t", "ur", "Apache-2.0"),
    ("huihui_ai/llama3.2-abliterate:1b", "Llama 3.2 abliterated 1B", "Q4_K_M", 0.96, 32, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/llama3.2-abliterate:3b", "Llama 3.2 abliterated 3B", "Q4_K_M", 2.24, 112, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/llama3.2-abliterate:1b-instruct-q8_0", "Llama 3.2 abliterated 1B", "Q8_0", 1.6, 32, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/llama3.2-abliterate:3b-instruct-q8_0", "Llama 3.2 abliterated 3B", "Q8_0", 3.84, 112, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/Hermes-3-Llama-3.2-abliterated:3b", "Hermes 3 (Llama 3.2) abliterated 3B", "Q4_K_M", 2.02, 112, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/Hermes-3-Llama-3.2-abliterated:3b-q8_0", "Hermes 3 (Llama 3.2) abliterated 3B", "Q8_0", 3.42, 112, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/deephermes3-abliterated:8b", "DeepHermes 3 abliterated 8B", "Q4_K_M", 4.92, 128, 0, 131072, "", "ur", ""),
    ("huihui_ai/deephermes3-abliterated:8b-preview-q8_0", "DeepHermes 3 abliterated 8B", "Q8_0", 8.54, 128, 0, 131072, "", "ur", ""),
    ("huihui_ai/phi4-abliterated:14b", "Phi-4 abliterated 14B", "Q4_K_M", 9.05, 200, 0, 16384, "", "u", "MIT"),
    ("huihui_ai/phi4-abliterated:14b-q8_0", "Phi-4 abliterated 14B", "Q8_0", 15.58, 200, 0, 16384, "", "u", "MIT"),
    ("huihui_ai/phi4-reasoning-abliterated:3.8b", "Phi-4 reasoning abliterated 3.8B", "Q4_K_M", 2.49, 128, 0, 131072, "", "ur", "MIT"),
    ("huihui_ai/phi4-reasoning-abliterated:3.8b-q8_0", "Phi-4 reasoning abliterated 3.8B", "Q8_0", 4.08, 128, 0, 131072, "", "ur", "MIT"),
    ("huihui_ai/magistral-abliterated:24b", "Magistral abliterated 24B", "Q4_K_M", 14.33, 160, 0, 40960, "k", "ur", "Apache-2.0"),
    ("huihui_ai/magistral-abliterated:24b-small-2506-q8_0", "Magistral abliterated 24B", "Q8_0", 25.05, 160, 0, 40960, "k", "ur", "Apache-2.0"),
    ("huihui_ai/exaone3.5-abliterated:2.4b", "EXAONE 3.5 abliterated 2.4B", "Q4_K_M", 1.64, 75, 0, 32768, "", "u", "ver a página do modelo"),
    ("huihui_ai/exaone3.5-abliterated:7.8b", "EXAONE 3.5 abliterated 7.8B", "Q4_K_M", 4.77, 128, 0, 32768, "", "u", "ver a página do modelo"),
    ("huihui_ai/exaone3.5-abliterated:32b", "EXAONE 3.5 abliterated 32B", "Q4_K_M", 19.34, 256, 0, 32768, "", "u", "ver a página do modelo"),
    ("huihui_ai/exaone3.5-abliterated:2.4b-q8_0", "EXAONE 3.5 abliterated 2.4B", "Q8_0", 2.84, 75, 0, 32768, "", "u", "ver a página do modelo"),
    ("huihui_ai/exaone3.5-abliterated:7.8b-q8_0", "EXAONE 3.5 abliterated 7.8B", "Q8_0", 8.31, 128, 0, 32768, "", "u", "ver a página do modelo"),
    ("huihui_ai/exaone3.5-abliterated:32b-q8_0", "EXAONE 3.5 abliterated 32B", "Q8_0", 34.01, 256, 0, 32768, "", "u", "ver a página do modelo"),
    ("huihui_ai/granite4.1-abliterated:3b", "Granite 4.1 abliterated 3B", "Q4_K_M", 2.1, 80, 0, 131072, "t", "u", "Apache-2.0"),
    ("huihui_ai/granite4.1-abliterated:8b", "Granite 4.1 abliterated 8B", "Q4_K_M", 5.35, 160, 0, 131072, "t", "u", "Apache-2.0"),
    ("huihui_ai/granite4.1-abliterated:30b", "Granite 4.1 abliterated 30B", "Q4_K_M", 17.49, 256, 0, 131072, "t", "u", "Apache-2.0"),
    ("huihui_ai/granite4.1-abliterated:3b-q8_0", "Granite 4.1 abliterated 3B", "Q8_0", 3.62, 80, 0, 131072, "t", "u", "Apache-2.0"),
    ("huihui_ai/granite4.1-abliterated:8b-q8_0", "Granite 4.1 abliterated 8B", "Q8_0", 9.35, 160, 0, 131072, "t", "u", "Apache-2.0"),
    ("huihui_ai/granite4.1-abliterated:30b-q8_0", "Granite 4.1 abliterated 30B", "Q8_0", 30.67, 256, 0, 131072, "t", "u", "Apache-2.0"),
    ("huihui_ai/granite3.2-vision-abliterated:2b", "Granite 3.2 Vision abliterated 2B", "F16", 2.44, 80, 0, 16384, "vt", "u", "Apache-2.0"),
    ("huihui_ai/granite3.2-vision-abliterated:2b-q8_0", "Granite 3.2 Vision abliterated 2B", "Q8_0", 3.58, 80, 0, 16384, "vt", "u", "Apache-2.0"),
    ("huihui_ai/aya-expanse-abliterated:8b", "Aya Expanse abliterated 8B", "Q4_K_M", 5.06, 128, 0, 8192, "t", "u", "Creative Commons"),
    ("huihui_ai/aya-expanse-abliterated:32b", "Aya Expanse abliterated 32B", "Q4_K_M", 19.8, 160, 0, 8192, "t", "u", "Creative Commons"),
    ("huihui_ai/aya-expanse-abliterated:8b-q8_0", "Aya Expanse abliterated 8B", "Q8_0", 8.54, 128, 0, 8192, "t", "u", "Creative Commons"),
    ("huihui_ai/aya-expanse-abliterated:32b-q8_0", "Aya Expanse abliterated 32B", "Q8_0", 34.33, 160, 0, 8192, "t", "u", "Creative Commons"),
    ("huihui_ai/nemotron-abliterated:70b", "Nemotron abliterated 70B", "Q4_K_M", 42.52, 320, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/nemotron-abliterated:70b-instruct-q8_0", "Nemotron abliterated 70B", "Q8_0", 74.98, 320, 0, 131072, "t", "u", "Licença Llama"),
    ("huihui_ai/acereason-nemotron-abliterated:7b", "AceReason-Nemotron abliterated 7B", "Q4_K_M", 4.68, 56, 0, 131072, "", "ur", "ver a página do modelo"),
    ("huihui_ai/acereason-nemotron-abliterated:14b", "AceReason-Nemotron abliterated 14B", "Q4_K_M", 8.99, 192, 0, 131072, "", "ur", "ver a página do modelo"),
    ("huihui_ai/acereason-nemotron-abliterated:7b-q8_0", "AceReason-Nemotron abliterated 7B", "Q8_0", 8.1, 56, 0, 131072, "", "ur", "ver a página do modelo"),
    ("huihui_ai/acereason-nemotron-abliterated:14b-q8_0", "AceReason-Nemotron abliterated 14B", "Q8_0", 15.7, 192, 0, 131072, "", "ur", "ver a página do modelo"),
    ("huihui_ai/openthinker-abliterated:7b", "OpenThinker abliterated 7B", "Q4_K_M", 4.68, 56, 0, 32768, "", "ur", "Apache-2.0"),
    ("huihui_ai/openthinker-abliterated:32b", "OpenThinker abliterated 32B", "Q4_K_M", 19.85, 256, 0, 32768, "", "ur", "Apache-2.0"),
    ("huihui_ai/openthinker-abliterated:7b-q8_0", "OpenThinker abliterated 7B", "Q8_0", 8.1, 56, 0, 32768, "", "ur", "Apache-2.0"),
    ("huihui_ai/openthinker-abliterated:32b-q8_0", "OpenThinker abliterated 32B", "Q8_0", 34.82, 256, 0, 32768, "", "ur", "Apache-2.0"),
    ("huihui_ai/dolphin3-r1-abliterated:24b", "Dolphin 3 R1 abliterated 24B", "Q4_K_M", 14.33, 160, 0, 32768, "", "ur", ""),
    ("huihui_ai/dolphin3-r1-abliterated:24b-mistral-q8_0", "Dolphin 3 R1 abliterated 24B", "Q8_0", 25.05, 160, 0, 32768, "", "ur", ""),
    ("huihui_ai/lfm2.5-abliterated:1.2b", "LFM2.5 abliterated 1.2B", "Q4_K_M", 0.73, 12, 0, 128000, "t", "u", "ver a página do modelo"),
    ("huihui_ai/lfm2.5-abliterated:1.2b-instruct-q8_0", "LFM2.5 abliterated 1.2B", "Q8_0", 1.25, 12, 0, 128000, "t", "u", "ver a página do modelo"),
    ("huihui_ai/seed-coder-abliterate:latest", "Seed-Coder abliterated 8.3B", "Q4_K_M", 5.07, 128, 0, 32768, "", "uc", ""),
    ("huihui_ai/jan-nano-abliterated:4b", "Jan-nano abliterated 4B", "Q4_K_M", 2.5, 144, 0, 131072, "tk", "u", "Apache-2.0"),
    ("huihui_ai/jan-nano-abliterated:4b-40k-q8_0", "Jan-nano abliterated 4B", "Q8_0", 4.28, 144, 0, 40960, "tk", "u", "Apache-2.0"),
    ("orcarouter/Qwen3.8-27B-Uncensored:latest", "Qwen3.8 Uncensored (orcarouter) 27.3B", "Q4_K_M", 17.74, 64, 0, 262144, "vtk", "u", "ver a página do modelo"),
    ("orcarouter/Qwen3.8-27B-Uncensored:q8_0", "Qwen3.8 Uncensored (orcarouter) 27.3B", "Q8_0", 29.98, 64, 0, 262144, "vtk", "u", "ver a página do modelo"),
]
# </catalogo-gerado>

GIB = float(2 ** 30)
KV_Q8_FACTOR = 17.0 / 32.0        # cache KV em 8 bits: ~17/32 do tamanho em f16
FIT_OVERHEAD_GIB = 2.0            # buffers do motor, ativações e o que o nvidia-smi não mostra (a mesma folga da tabela por VRAM)
CTX_LADDER = (131072, 65536, 32768, 16384, 8192)
AGENT_MIN_CTX = 32768             # o prompt-base do Openclod tem ~9 mil tokens: com menos contexto o modelo só serve para conversar
LIGHT_MAX_GB = 6.0                # "leve e rápido": modelos de até este tamanho de arquivo
REGISTRY_URL = "https://registry.ollama.ai/v2"

LIST_GROUPS = (
    ("agente-visao", "Agentes com visão e ferramentas (o que o Openclod usa melhor)"),
    ("agente", "Agentes só texto (com ferramentas)"),
    ("codigo", "Código"),
    ("raciocinio", "Raciocínio"),
    ("visao", "Visão, sem ferramentas"),
    ("conversa", "Só conversa (sem ferramentas nem visão)"),
    ("sem-censura", "Sem censura (uncensored / abliterated)"),
)

# O que cada opção do formulário `tipo_de_modelo` quer dizer (a chave já sem acento e em minúsculas).
KINDS = {"": "", "automatico": "", "sem censura": "sem-censura", "codigo": "codigo", "raciocinio": "raciocinio",
         "leve e rapido": "leve", "leve": "leve"}


def _kind_of(tipo):
    key = _plain(tipo)
    if key not in KINDS:
        raise ValueError("Tipo de modelo desconhecido: '%s'. Use automático, sem censura, código, raciocínio ou leve e rápido." % tipo)
    return KINDS[key]


def _variant(row):
    data = dict(zip(CATALOG_FIELDS, row))
    caps, marks = data["caps"], data["marcas"]
    data.update(vision="v" in caps, tools="t" in caps, thinking="k" in caps, audio="a" in caps, moe="m" in caps,
                uncensored="u" in marks, code="c" in marks, reasoning="r" in marks)
    return data


def catalog_variants():
    """Todas as etiquetas do catálogo, como dicionários (com as capacidades já separadas em verdadeiro/falso)."""
    return [_variant(row) for row in CATALOG]


def catalog_variant(tag):
    """A linha do catálogo de uma etiqueta (ou None). "qwen3.5:9b-q4_K_M" e "qwen3.5:9b" são o mesmo arquivo quando o padrão do
    tamanho já é Q4_K_M (idem q8_0): o catálogo guarda uma etiqueta só por arquivo."""
    variants = catalog_variants()
    for variant in variants:
        if variant["tag"] == tag:
            return variant
    for suffix, quant in (("-q4_K_M", "Q4_K_M"), ("-q8_0", "Q8_0")):
        if tag.endswith(suffix):
            for variant in variants:
                if variant["tag"] == tag[:-len(suffix)] and variant["quant"] == quant:
                    return variant
    return None


def catalog_models():
    """Agrupa as etiquetas por modelo (o mesmo nome em quantizações diferentes), da mais pesada para a mais leve."""
    models = collections.OrderedDict()
    for variant in catalog_variants():
        models.setdefault(variant["nome"], []).append(variant)
    out = []
    for name, variants in models.items():
        variants.sort(key=lambda item: -item["gb"])
        out.append({"nome": name, "variants": variants})
    return out


def ollama_page(tag):
    name = tag.partition(":")[0]
    return "https://ollama.com/" + (name if "/" in name else "library/" + name)


def usable_gib(total_mib, free_mib=None):
    """A VRAM que o motor pode usar: a livre que o nvidia-smi mostra; sem ela, a total menos ~450 MiB que o driver já reserva."""
    mib = int(free_mib) if free_mib else max(0, int(total_mib) - 450)
    return mib / 1024.0


def need_gib(variant, ctx, kv="f16", parallel=1):
    """VRAM (GiB) para carregar a etiqueta com `ctx` tokens de contexto: pesos + cache KV + folga."""
    per_token = variant["kv_kib"] * 1024.0 * (KV_Q8_FACTOR if kv == "q8_0" else 1.0)
    cache = (per_token * ctx + variant["kv_fixo_mib"] * 1048576.0) * parallel
    return variant["gb"] * 1e9 / GIB + cache / GIB + FIT_OVERHEAD_GIB


def _contexts(variant):
    """Os contextos que valem a pena tentar, do maior para o menor, sem passar do máximo do modelo."""
    top = int(variant["ctx_max"] or 0)
    return [ctx for ctx in CTX_LADDER if ctx <= top] or [max(top, 1024)]


def best_context(variant, usable):
    """O maior contexto com que a etiqueta cabe em `usable` GiB; 0 se nem o menor cabe."""
    for ctx in _contexts(variant):
        if need_gib(variant, ctx) <= usable:
            return ctx
    return 0


def fit_model(model, usable):
    """A etiqueta mais pesada (a de maior qualidade) do modelo que cabe com contexto de agente (32k); sem nenhuma assim, a que der
    mais contexto. Devolve (etiqueta, contexto) ou None se o modelo não cabe."""
    fallback = None
    for variant in model["variants"]:
        ctx = best_context(variant, usable)
        if not ctx:
            continue
        if ctx >= min(AGENT_MIN_CTX, int(variant["ctx_max"] or AGENT_MIN_CTX)):
            return variant, ctx
        if fallback is None or ctx > fallback[1]:
            fallback = (variant, ctx)
    return fallback


def _group_of(variant):
    if variant["uncensored"]:
        return "sem-censura"
    if variant["code"]:
        return "codigo"
    if variant["reasoning"]:
        return "raciocinio"
    if variant["vision"] and variant["tools"]:
        return "agente-visao"
    if variant["tools"]:
        return "agente"
    if variant["vision"]:
        return "visao"
    return "conversa"


def build_listing(usable):
    """Os modelos do catálogo que cabem em `usable` GiB, agrupados por tipo e numerados (a numeração só depende da GPU: é a mesma
    em qualquer execução nela), mais os que quase cabem."""
    fitting, near = [], []
    for model in catalog_models():
        picked = fit_model(model, usable)
        if picked:
            fitting.append({"model": model, "variant": picked[0], "ctx": picked[1], "group": _group_of(picked[0])})
        else:
            lightest = model["variants"][-1]
            ctx = _contexts(lightest)[-1]
            near.append({"model": model, "variant": lightest, "ctx": ctx, "need_gib": need_gib(lightest, ctx)})
    order = [key for key, _title in LIST_GROUPS]
    # Dentro de cada tipo, primeiro os que servem de agente (contexto de 32k ou mais); o maior modelo vem antes.
    fitting.sort(key=lambda row: (order.index(row["group"]), row["ctx"] < AGENT_MIN_CTX, -row["variant"]["gb"], row["variant"]["nome"]))
    by_number = {}
    for number, row in enumerate(fitting, 1):
        row["numero"] = number
        by_number[number] = row
    near.sort(key=lambda row: row["need_gib"])
    return {"rows": fitting, "by_number": by_number, "near": near, "usable": usable, "total": len(fitting) + len(near)}


def params_b(variant):
    """Parâmetros do modelo em bilhões, lidos do nome ("9B", "E4B" = 4, "270M", "8x7B"); nos MoE só uns 35% trabalham por token.
    É só uma régua para ordenar (o arquivo em GB engana: modelos "E" do Gemma têm arquivo grande e poucos parâmetros ativos)."""
    name = variant["nome"].split()[-1].upper()
    match = re.match(r"^(?:E(\d+(?:\.\d+)?)|(?:(\d+)X)?(\d+(?:\.\d+)?))([BM])$", name)
    if not match:
        return 0.0
    count = float(match.group(1) or match.group(3))
    if match.group(2):
        count *= int(match.group(2))
    if match.group(4) == "M":
        count /= 1000.0
    return count * (0.35 if variant["moe"] else 1.0)


def pick_by_kind(rows, kind):
    """As linhas do tipo pedido, da melhor para a pior: com ferramentas primeiro, depois contexto de agente, depois o modelo com mais
    parâmetros (e, empatando, o de arquivo maior)."""
    if kind == "leve":
        pool = [row for row in rows if row["variant"]["gb"] <= LIGHT_MAX_GB and not row["variant"]["uncensored"]]
    else:
        pool = [row for row in rows if row["group"] == kind]
    return sorted(pool, key=lambda row: (row["variant"]["tools"], row["ctx"] >= AGENT_MIN_CTX, params_b(row["variant"]), row["variant"]["gb"]),
                  reverse=True)


def _row_candidates(row, wanted_ctx, default_thinking, explicit):
    """Os candidatos de uma linha da lista: o contexto que cabe e, se não carregar 100% na GPU, os dois menores."""
    variant = row["variant"]
    ctx = wanted_ctx or row["ctx"]
    steps = [ctx] + ([] if wanted_ctx else [c for c in _contexts(variant) if c < ctx][:2])
    return [Candidate(variant["tag"], c, "f16", 1, default_thinking, variant["gb"], explicit, not variant["tools"]) for c in steps]


def _dec(value):
    return ("%.1f" % value).replace(".", ",")


def _ctx_text(ctx):
    return "%dk" % (ctx // 1024) if ctx >= 1024 else str(ctx)


def _caps_text(variant):
    parts = []
    if variant["vision"]:
        parts.append("visão")
    if variant["tools"]:
        parts.append("ferramentas")
    if variant["thinking"]:
        parts.append("pensamento")
    if variant["audio"]:
        parts.append("áudio")
    if variant["moe"]:
        parts.append("MoE")
    if not variant["vision"] and not variant["tools"]:
        parts.insert(0, "só texto")
    return ", ".join(parts)


def listing_lines(listing, chosen_tag="", unavailable=(), mark="<== rodando esta"):
    """O texto da lista que a etapa 2 imprime: um modelo por linha, numerado, agrupado por tipo; no fim, o que quase cabe.
    `mark` é o que vai na linha de `chosen_tag` ("rodando esta"; "automático" quando a caixa de escolha ainda vai perguntar)."""
    lines = []
    for key, title in LIST_GROUPS:
        group = [row for row in listing["rows"] if row["group"] == key]
        if not group:
            continue
        lines.append("")
        lines.append("%s: %d %s" % (title, len(group), "modelo" if len(group) == 1 else "modelos"))
        if key == "sem-censura":
            lines.append("      Menos recusas do que os modelos originais; a qualidade e o uso de ferramentas variam, e o uso é por sua conta.")
        for row in group:
            variant = row["variant"]
            marks = []
            if row["ctx"] < AGENT_MIN_CTX:
                marks.append("contexto curto: só conversa")
            if variant["tag"] in unavailable:
                marks.append("[não está mais no registro do Ollama]")
            if variant["tag"] == chosen_tag:
                marks.append(mark)
            license_text = variant["licenca"] if variant["licenca"] and variant["licenca"] != "ver a página do modelo" else "licença: ver a página"
            lines.append("  %3d. %-36s %-7s %6s GB  ctx %-5s %s | %s%s" % (
                row["numero"], variant["nome"], variant["quant"], _dec(variant["gb"]), _ctx_text(row["ctx"]), _caps_text(variant),
                license_text, ("  " + "  ".join(marks)) if marks else ""))
    near = listing["near"][:6]
    if near:
        lines.append("")
        lines.append("Não cabem nesta GPU (%s GB livres); os mais próximos:" % _dec(listing["usable"]))
        for row in near:
            variant = row["variant"]
            lines.append("       %-36s %-7s %6s GB  precisaria de ~%s GB com ctx %s" % (
                variant["nome"], variant["quant"], _dec(variant["gb"]), _dec(row["need_gib"]), _ctx_text(row["ctx"])))
    return lines


def registry_lookup(tag, timeout=8.0, opener=None):
    """Pergunta ao registro do Ollama se a etiqueta existe e quanto pesa: ("ok", GB) | ("ausente", 0.0) | ("?", 0.0). Nunca levanta."""
    name, _sep, version = tag.partition(":")
    repo = name if "/" in name else "library/" + name
    request = urllib.request.Request("%s/%s/manifests/%s" % (REGISTRY_URL, repo, version or "latest"),
                                     headers={"Accept": "application/vnd.docker.distribution.manifest.v2+json", "User-Agent": USER_AGENT})
    try:
        with (opener or urllib.request.urlopen)(request, timeout=timeout) as response:
            manifest = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return ("ausente", 0.0) if err.code == 404 else ("?", 0.0)
    except Exception:
        return ("?", 0.0)
    total = 0
    for layer in manifest.get("layers", []):
        if layer.get("mediaType") in ("application/vnd.ollama.image.model", "application/vnd.ollama.image.projector"):
            total += int(layer.get("size", 0))
    return ("ok", total / 1e9) if total else ("?", 0.0)


def verify_registry(rows, lookup=None, workers=12, budget=25.0):
    """Confere no registro do Ollama as etiquetas da lista (em paralelo, no máximo `budget` segundos). Devolve {etiqueta: (estado, GB)}.
    Falha de rede não derruba nada: a etiqueta fica "?" (não verificada)."""
    import concurrent.futures  # noqa: PLC0415
    lookup = lookup or registry_lookup
    tags = sorted({row["variant"]["tag"] for row in rows})
    results = {}
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    futures = dict((pool.submit(lookup, tag), tag) for tag in tags)
    try:
        for future in concurrent.futures.as_completed(futures, timeout=budget):
            try:
                results[futures[future]] = future.result()
            except Exception:
                results[futures[future]] = ("?", 0.0)
    except Exception:
        pass  # estourou o tempo: o que ficou sem resposta é "?"
    finally:
        pool.shutdown(wait=False)
    for tag in tags:
        results.setdefault(tag, ("?", 0.0))
    return results


# --------------------------------------------------------------------------------------------------------------------
# A pausa para escolher o modelo (etapa 2, só no Colab). Depois de imprimir a lista, a célula mostra uma caixa de seleção com os
# modelos que cabem e o botão "Usar este modelo" e ESPERA; sem escolha no prazo, segue com o automático. Só depois (etapa 3 em diante)
# se baixa alguma coisa. A caixa é um JavaScript na saída da célula: `display(Javascript(...))` define a função e `eval_js` a chama e
# espera pela Promise (o mesmo par do snippet de câmera do Colab). Nada de input()/getpass: "Executar tudo" nunca fica preso.
# --------------------------------------------------------------------------------------------------------------------

CHOICE_SECONDS = 120            # quanto a etapa 2 espera pela escolha antes de seguir com o automático
CHOICE_MAX_SECONDS = 600        # teto do campo segundos_para_escolher do formulário
CHOICE_GRACE_SECONDS = 30       # folga do lado do Python, além do prazo da caixa (a aba em segundo plano roda os timers mais devagar)

# Avisos que a caixa mostra sob o modelo selecionado (cada opção aponta para os que valem para ela).
CHOICE_WARNINGS = {
    "ferramentas": "Este modelo não declara chamada de ferramentas: o Openclod só consegue conversar com ele, não usá-lo como agente "
                   "(ler e editar arquivos, rodar comandos).",
    "curto": "Com o contexto que cabe nesta GPU (menos de 32k) ele só serve para conversar, não como agente.",
    "sem-censura": "Modelo da comunidade sem as recusas do original: a qualidade, o uso de ferramentas e a origem dos pesos não foram "
                   "auditados pelo Openclod, e o uso é por sua conta.",
}

# A caixa. `display(Javascript(CHOICE_JS))` só DEFINE window.openclodEscolher (nada aparece nem fica salvo na saída do notebook além
# desta definição); `eval_js("window.openclodEscolher({...})")` monta a caixa, espera e devolve o texto JSON {"quem", "numero"}.
# Todo texto entra na tela por textContent (nada de innerHTML). Sem barras invertidas nem três aspas simples seguidas: este arquivo
# vai dentro de uma string "crua" de aspas triplas simples do notebook (um teste confere).
CHOICE_JS = """
window.openclodEscolher = async function (dados) {
  const doc = document;
  const el = (tag, css, texto) => {
    const no = doc.createElement(tag);
    if (css) no.style.cssText = css;
    if (texto !== undefined) no.textContent = texto;
    return no;
  };
  const ajustarAltura = () => {
    try { google.colab.output.setIframeHeight(doc.documentElement.scrollHeight, true); } catch (erro) { /* fora do Colab */ }
  };
  const relogio = (total) => Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');

  const raiz = el('div', 'font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#202124;background:#f8f9fa;' +
    'border:1px solid #dadce0;border-radius:10px;padding:14px 16px;margin:8px 0;max-width:820px;box-sizing:border-box');
  raiz.setAttribute('data-openclod', 'escolha-do-modelo');
  raiz.appendChild(el('div', 'font-weight:600;font-size:15px', 'Escolha o modelo antes de baixar'));
  raiz.appendChild(el('div', 'color:#5f6368;margin:2px 0 8px',
    'Selecione um modelo e clique em «Usar este modelo». O automático já está marcado: se você não escolher, é ele que roda.'));

  const caixa = el('select', 'width:100%;box-sizing:border-box;font:13px/1.5 system-ui,sans-serif;padding:4px;' +
    'border:1px solid #bdc1c6;border-radius:6px;background:#fff;color:#202124');
  caixa.setAttribute('aria-label', 'Modelo');
  const itens = new Map();
  const automatico = doc.createElement('option');
  automatico.value = '0';
  automatico.textContent = dados.automatico.texto;
  caixa.appendChild(automatico);
  itens.set('0', dados.automatico);
  let linhas = 1;
  for (const grupo of dados.grupos) {
    const bloco = doc.createElement('optgroup');
    bloco.label = grupo.titulo + ' (' + grupo.itens.length + ')';
    for (const item of grupo.itens) {
      const opcao = doc.createElement('option');
      opcao.value = String(item.n);
      opcao.textContent = item.texto;
      bloco.appendChild(opcao);
      itens.set(opcao.value, item);
      linhas += 1;
    }
    caixa.appendChild(bloco);
    linhas += 1;
  }
  caixa.size = Math.max(2, Math.min(12, linhas));
  caixa.value = '0';
  raiz.appendChild(caixa);

  const detalhe = el('div', 'margin-top:8px;color:#3c4043;min-height:1.5em');
  detalhe.setAttribute('data-parte', 'detalhe');
  const avisos = el('div', 'margin-top:4px;color:#b3261e');
  avisos.setAttribute('data-parte', 'avisos');
  raiz.appendChild(detalhe);
  raiz.appendChild(avisos);
  const mostrar = () => {
    const item = itens.get(caixa.value) || dados.automatico;
    detalhe.textContent = item.detalhe || '';
    while (avisos.firstChild) avisos.removeChild(avisos.firstChild);
    for (const chave of item.av || []) avisos.appendChild(el('div', 'margin-top:2px', dados.avisos[chave] || ''));
    ajustarAltura();
  };
  caixa.addEventListener('change', mostrar);

  const linha = el('div', 'display:flex;align-items:center;gap:14px;margin-top:10px;flex-wrap:wrap');
  const botao = el('button', 'font:600 14px system-ui,sans-serif;padding:8px 18px;border:0;border-radius:6px;background:#1a73e8;' +
    'color:#fff;cursor:pointer', 'Usar este modelo');
  botao.type = 'button';
  const contagem = el('span', 'color:#5f6368;font-variant-numeric:tabular-nums');
  contagem.setAttribute('data-parte', 'contagem');
  linha.appendChild(botao);
  linha.appendChild(contagem);
  raiz.appendChild(linha);
  const trilha = el('div', 'height:4px;background:#e0e3e7;border-radius:2px;margin-top:8px;overflow:hidden');
  trilha.setAttribute('data-parte', 'trilha');
  const barra = el('div', 'height:4px;width:100%;background:#1a73e8');
  barra.setAttribute('data-parte', 'barra');
  trilha.appendChild(barra);
  raiz.appendChild(trilha);
  const estado = el('div', 'margin-top:8px;font-weight:600');
  estado.setAttribute('data-parte', 'estado');
  estado.setAttribute('aria-live', 'polite');
  raiz.appendChild(estado);
  doc.body.appendChild(raiz);
  mostrar();

  return await new Promise((resolver) => {
    const limite = Date.now() + dados.segundos * 1000;
    let cronometro = null;
    let fim = false;
    const terminar = (quem, numero, texto) => {
      if (fim) return;
      fim = true;
      if (cronometro !== null) clearInterval(cronometro);
      caixa.disabled = true;
      botao.disabled = true;
      botao.style.background = '#9aa0a6';
      botao.style.cursor = 'default';
      contagem.textContent = '';
      trilha.style.display = 'none';
      estado.textContent = texto;
      ajustarAltura();
      resolver(JSON.stringify({ quem: quem, numero: numero }));
    };
    window.openclodEscolher.atual = { cancelar: (motivo) => terminar('cancelado', 0, motivo) };
    botao.addEventListener('click', () => {
      const item = itens.get(caixa.value);
      terminar('usuario', Number(caixa.value), 'Escolhido: ' + (item ? item.texto : caixa.value) + '. O notebook continua (acompanhe a saída desta célula).');
    });
    const atualizar = () => {
      const restante = Math.max(0, limite - Date.now());
      contagem.textContent = 'Sem escolha, segue com o automático em ' + relogio(Math.ceil(restante / 1000));
      barra.style.width = (100 * restante / (dados.segundos * 1000)) + '%';
      if (restante <= 0) terminar('tempo', 0, 'Tempo esgotado: o notebook seguiu com o automático.');
    };
    cronometro = setInterval(atualizar, 250);
    atualizar();
  });
};
window.openclodEscolher.cancelar = function (motivo) {
  if (window.openclodEscolher.atual) window.openclodEscolher.atual.cancelar(motivo || 'Cancelado.');
};
"""


def choice_seconds(value):
    """O prazo da escolha vindo do formulário, em segundos: vazio ou inválido = o padrão; 0 = não perguntar; no máximo 10 minutos."""
    try:
        seconds = CHOICE_SECONDS if value is None or value == "" else int(value)
    except (TypeError, ValueError):
        seconds = CHOICE_SECONDS
    return max(0, min(CHOICE_MAX_SECONDS, seconds))


def wait_text(seconds):
    seconds = int(seconds)
    if seconds >= 60 and seconds % 60 == 0:
        return "%d minuto%s" % (seconds // 60, "" if seconds == 60 else "s")
    return "%d segundos" % seconds


def colab_eval_js():
    """`google.colab.output.eval_js` (roda um JavaScript na saída da célula, espera pela Promise e devolve o resultado), ou None fora do
    Colab (CLI, testes, outra máquina): ali ninguém pode clicar, então não se pergunta."""
    try:
        from google.colab import output  # noqa: PLC0415
    except Exception:  # noqa: BLE001 - qualquer falha de importação quer dizer "não é o Colab"
        return None
    return getattr(output, "eval_js", None)


def colab_show_js(code):
    """Grava um JavaScript na saída da célula (o que `display(Javascript(...))` faz)."""
    from IPython.display import Javascript, display  # noqa: PLC0415
    display(Javascript(code))


def choice_item(row, automatic_tag=""):
    """Uma linha da lista como opção da caixa de escolha. O número é o da lista impressa (o mesmo de `numero_da_lista`)."""
    variant = row["variant"]
    notes, warnings = [], []
    if not variant["tools"]:
        notes.append("sem ferramentas: só conversa")
        warnings.append("ferramentas")
    elif row["ctx"] < AGENT_MIN_CTX:
        notes.append("contexto curto: só conversa")
        warnings.append("curto")
    if variant["uncensored"]:
        warnings.append("sem-censura")
    if automatic_tag and variant["tag"] == automatic_tag:
        notes.append("é o automático")
    text = " · ".join(["%d" % row["numero"], variant["nome"], variant["quant"], "%s GB" % _dec(variant["gb"]),
                       "ctx %s" % _ctx_text(row["ctx"]), _caps_text(variant)] + notes)
    license_text = variant["licenca"] if variant["licenca"] and variant["licenca"] != "ver a página do modelo" else "ver " + ollama_page(variant["tag"])
    return {"n": row["numero"], "texto": text, "detalhe": "%s · licença: %s" % (variant["tag"], license_text), "av": warnings}


def choice_automatic(plan):
    """A opção "Automático" (a que vale se ninguém escolher): o primeiro candidato do plano. Vem marcada na caixa."""
    first = plan["candidates"][0]
    known = catalog_variant(first["tag"])
    parts = [known["nome"], known["quant"], "ctx %s" % _ctx_text(first["ctx"]), _caps_text(known)] if known else [first["tag"], "ctx %s" % _ctx_text(first["ctx"])]
    return {"texto": "Automático (recomendado): " + " · ".join(parts), "detalhe": "%s · %s" % (first["tag"], plan["why"]), "av": []}


def choice_data(listing, plan, unavailable=(), seconds=CHOICE_SECONDS):
    """Tudo que a caixa mostra: o automático e os modelos da lista, por tipo, na mesma numeração e ordem da lista impressa. O que o
    registro do Ollama disse que não existe mais fica de fora (não adianta oferecer)."""
    first = plan["candidates"][0]
    known = catalog_variant(first["tag"])
    automatic_tag = known["tag"] if known else first["tag"]
    groups = []
    for key, title in LIST_GROUPS:
        items = [choice_item(row, automatic_tag) for row in listing["rows"] if row["group"] == key and row["variant"]["tag"] not in unavailable]
        if items:
            groups.append({"titulo": title, "itens": items})
    return {"segundos": int(seconds), "automatico": choice_automatic(plan), "grupos": groups, "avisos": CHOICE_WARNINGS}


def choice_call(data):
    """A expressão que o `eval_js` roda: monta a caixa com `data` e devolve a Promise da escolha."""
    return "window.openclodEscolher(%s)" % json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def parse_choice_reply(reply, valid):
    """A resposta da caixa ({"quem": "usuario", "numero": N} ou {"quem": "tempo"}, em texto JSON ou já decodificada) -> ("usuario", N) |
    ("tempo", 0). N = 0 é o automático; qualquer outro N tem de ser um número da lista (`valid`). Levanta ValueError no resto."""
    if isinstance(reply, (bytes, bytearray)):
        reply = reply.decode("utf-8", "replace")
    if isinstance(reply, str):
        try:
            reply = json.loads(reply)
        except ValueError:
            raise ValueError("a resposta da caixa não é JSON") from None
    if not isinstance(reply, dict):
        raise ValueError("a resposta da caixa veio num formato inesperado")
    who, number = reply.get("quem"), reply.get("numero")
    if who == "tempo":
        return ("tempo", 0)
    if who == "usuario" and isinstance(number, int) and not isinstance(number, bool) and (number == 0 or number in valid):
        return ("usuario", number)
    raise ValueError("a resposta da caixa não é uma escolha da lista")


def _cancel_choice(run):
    """A caixa que ficou na tela (a célula parou, ou a resposta não veio) é desativada: um clique tardio não vale mais nada."""
    try:
        run("window.openclodEscolher && window.openclodEscolher.cancelar('O notebook parou de esperar por esta escolha.')", ignore_result=True)
    except Exception:  # noqa: BLE001 - é só arrumação da tela
        pass


def ask_model_choice(data, eval_js=None, show_js=None):
    """Mostra a caixa de escolha na saída da célula e espera. Devolve (quem, número, detalhe):
      ("usuario", N, "")        clicou em «Usar este modelo» (N = n.º da lista; 0 = confirmou o automático)
      ("tempo", 0, "")          ninguém escolheu no prazo
      ("sem-resposta", 0, "")   o navegador não respondeu nem depois da folga (aba fechada, ou o ambiente não mostra a caixa)
      ("erro", 0, motivo)       não deu para mostrar a caixa, ou a resposta veio estranha
      ("indisponivel", 0, "")   fora do Colab: ninguém pode clicar
    O prazo do Python é o da caixa mais CHOICE_GRACE_SECONDS: se o navegador sumir, a célula não fica presa."""
    run = eval_js or colab_eval_js()
    if run is None:
        return ("indisponivel", 0, "")
    show = show_js or colab_show_js
    valid = set(item["n"] for group in data["grupos"] for item in group["itens"])
    answered = False
    try:
        try:
            show(CHOICE_JS)
            reply = run(choice_call(data), timeout_sec=int(data["segundos"]) + CHOICE_GRACE_SECONDS)
        except Exception as exc:  # noqa: BLE001 - o Colab levanta MessageError, TypeError (versão antiga)...: nada disso derruba o notebook
            return ("erro", 0, str(exc) or exc.__class__.__name__)
        if reply is None:
            return ("sem-resposta", 0, "")
        try:
            who, number = parse_choice_reply(reply, valid)
        except ValueError as exc:
            return ("erro", 0, str(exc))
        answered = True
        return (who, number, "")
    finally:
        if not answered:
            _cancel_choice(run)


# --------------------------------------------------------------------------------------------------------------------
# Código de conexão (o mesmo formato é lido por src/core/colab/connection-code.ts)
#   OCLC1.<payload>.<verificação>   payload = JSON compacto em base64url sem preenchimento
#   verificação = 8 primeiros hex do SHA-256 do texto do payload
# --------------------------------------------------------------------------------------------------------------------

def b64url_encode(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def code_check(payload_b64):
    """Verificação de integridade: pega colagem cortada ou com um caractere trocado (não é assinatura)."""
    return hashlib.sha256(payload_b64.encode("ascii")).hexdigest()[:8]


def make_connection_code(info):
    """info: dict com u (URL .../v1), k (chave), m (modelo) e opcionais nb, g, vm, vi, tl, c, e, t, sh."""
    for required in ("u", "k", "m"):
        if not info.get(required):
            raise ValueError("campo obrigatório ausente: " + required)
    body = {key: value for key, value in info.items() if value is not None and value != ""}
    body["v"] = CODE_FORMAT
    payload = b64url_encode(json.dumps(body, separators=(",", ":"), ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return "%s.%s.%s" % (CODE_PREFIX, payload, code_check(payload))


def parse_connection_code(text):
    """Lê um código colado (aceita espaços, quebras de linha e texto em volta). Levanta ValueError em português."""
    cleaned = re.sub(r"[\s​‌‍⁠﻿]+", "", text or "")
    match = re.search(re.escape(CODE_PREFIX) + r"\.([A-Za-z0-9_-]+)\.([0-9a-f]{8})", cleaned)
    if not match:
        if re.search(re.escape(CODE_PREFIX) + r"\.[A-Za-z0-9_-]{8,}", cleaned):
            raise ValueError("O código está incompleto: faltou o final. Copie a linha inteira, do %s. até o último caractere." % CODE_PREFIX)
        raise ValueError("Isto não parece um código de conexão do Openclod (ele começa com %s.)." % CODE_PREFIX)
    payload, check = match.group(1), match.group(2)
    if not hmac.compare_digest(code_check(payload), check):
        raise ValueError("O código está incompleto ou foi alterado (a verificação não confere). Copie de novo, inteiro.")
    try:
        info = json.loads(b64url_decode(payload).decode("utf-8"))
    except Exception:
        raise ValueError("O código não pôde ser lido (conteúdo corrompido).")
    if not isinstance(info, dict) or info.get("v") != CODE_FORMAT:
        raise ValueError("Versão do código de conexão não suportada: gere de novo com o notebook mais recente.")
    return info


# --------------------------------------------------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------------------------------------------------

def say(message=""):
    print(message, flush=True)


def module_hash():
    """Impressão digital do próprio código (12 hex do SHA-256, com quebras de linha normalizadas)."""
    try:
        with open(__file__, "rb") as handle:
            data = handle.read().replace(b"\r\n", b"\n")
        return hashlib.sha256(data).hexdigest()[:12]
    except Exception:
        return ""


def new_key():
    return "occ_" + secrets.token_urlsafe(24)


def gb_text(mib):
    text = ("%.1f" % (mib / 1024.0)).replace(".", ",")
    return text[:-2] if text.endswith(",0") else text


def human_bytes(count):
    value = float(count)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return ("%.0f %s" % (value, unit)) if unit == "B" else ("%.1f %s" % (value, unit))
        value /= 1024.0
    return "%d B" % count


def human_duration(seconds):
    seconds = int(max(0, seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return "%02d:%02d:%02d" % (hours, minutes, secs)


def tail_file(path, lines=14):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return "".join(handle.readlines()[-lines:]).rstrip()
    except Exception:
        return ""


def fail(message):
    """Imprime a mensagem (em português, com a saída) e interrompe a execução desta célula."""
    say("")
    say("[ERRO] " + message)
    raise StepFailed("Etapa interrompida: veja a mensagem acima.")


def http_json(method, url, key=None, body=None, timeout=60.0):
    """(status, texto) de uma chamada HTTP; nunca levanta por status diferente de 2xx."""
    data = None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", errors="replace")


# --------------------------------------------------------------------------------------------------------------------
# GPU
# --------------------------------------------------------------------------------------------------------------------

_GPU_LINE = re.compile(r"^(?P<name>.+?),\s*(?P<total>\d+),\s*(?P<free>\d+)(?:,\s*(?P<driver>[\d.]+))?(?:,\s*(?P<cc>[\d.]+))?\s*$")


def parse_nvidia_smi(output):
    """Primeira GPU de `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version,compute_cap --format=csv,noheader,nounits`."""
    for line in (output or "").splitlines():
        match = _GPU_LINE.match(line.strip())
        if match:
            return {"name": match.group("name").strip(), "total_mib": int(match.group("total")),
                    "free_mib": int(match.group("free")), "driver": match.group("driver") or "", "cc": match.group("cc") or ""}
    return None


def detect_gpu():
    for query in ("name,memory.total,memory.free,driver_version,compute_cap", "name,memory.total,memory.free,driver_version"):
        try:
            result = subprocess.run(["nvidia-smi", "--query-gpu=" + query, "--format=csv,noheader,nounits"],
                                    capture_output=True, text=True, timeout=30)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        if result.returncode == 0:
            gpu = parse_nvidia_smi(result.stdout)
            if gpu:
                return gpu
    return None


def gpu_label(gpu):
    return "%s (%s GB)" % (gpu["name"], gb_text(gpu["total_mib"]))


# --------------------------------------------------------------------------------------------------------------------
# Download com retomada e SHA-256
# --------------------------------------------------------------------------------------------------------------------

def sha256_of(path, chunk=4 * 1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def download(url, dest, sha256=None, label="arquivo", retries=4, show=True):
    """Baixa `url` para `dest` (retoma de onde parou) e confere o SHA-256. Levanta RuntimeError se não conseguir."""
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    if sha256 and os.path.exists(dest) and sha256_of(dest) == sha256:
        if show:
            say("   %s já baixado e verificado." % label)
        return dest
    last_error = None
    for attempt in range(1, retries + 1):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        headers = {"User-Agent": USER_AGENT}
        if have:
            headers["Range"] = "bytes=%d-" % have
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                resumed = response.status == 206
                total = response.headers.get("Content-Length")
                total = (int(total) + (have if resumed else 0)) if total else 0
                done = have if resumed else 0
                started = time.time()
                last_print = 0.0
                with open(dest, "ab" if resumed else "wb") as out:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        out.write(block)
                        done += len(block)
                        now = time.time()
                        if show and now - last_print > 2.0:
                            last_print = now
                            speed = (done - (have if resumed else 0)) / max(now - started, 0.1)
                            pct = (" (%d%%)" % (100 * done / total)) if total else ""
                            print("\r   baixando %s: %s%s a %s/s      " % (label, human_bytes(done), pct, human_bytes(speed)), end="", flush=True)
            if total and done < total:  # o servidor fechou antes do fim (o http.client devolve vazio em vez de erro)
                raise ConnectionError("download interrompido em %s de %s" % (human_bytes(done), human_bytes(total)))
            if show:
                print("\r   %s baixado: %s.                                " % (label, human_bytes(os.path.getsize(dest))), flush=True)
            if sha256:
                actual = sha256_of(dest)
                if actual != sha256:
                    os.remove(dest)
                    raise RuntimeError("o SHA-256 de %s não confere (esperado %s…, recebido %s…)" % (label, sha256[:12], actual[:12]))
            return dest
        except urllib.error.HTTPError as err:
            if err.code == 416 and os.path.exists(dest):  # já estava completo
                if not sha256 or sha256_of(dest) == sha256:
                    return dest
                os.remove(dest)
            last_error = err
        except RuntimeError:
            raise
        except Exception as err:  # a rede caiu no meio: tenta retomar
            last_error = err
        time.sleep(min(2 * attempt, 8))
    raise RuntimeError("não consegui baixar %s: %s" % (label, last_error))


# --------------------------------------------------------------------------------------------------------------------
# Ollama: progresso do pull, ajuste na GPU
# --------------------------------------------------------------------------------------------------------------------

class PullProgress(object):
    """Soma as camadas do `POST /api/pull` (NDJSON) em um único percentual."""

    def __init__(self):
        self.layers = {}
        self.status = ""
        self.started = time.time()

    def feed(self, event):
        self.status = event.get("status", self.status)
        digest = event.get("digest")
        if digest and event.get("total"):
            self.layers[digest] = (int(event.get("completed") or 0), int(event["total"]))
        return self.summary()

    def summary(self):
        done = sum(item[0] for item in self.layers.values())
        total = sum(item[1] for item in self.layers.values())
        elapsed = max(time.time() - self.started, 0.1)
        return {"done": done, "total": total, "percent": (100.0 * done / total) if total else 0.0,
                "speed": done / elapsed, "status": self.status}


def ps_fit(ps_json, tag):
    """Do `GET /api/ps`: o modelo está 100% na GPU? Devolve (cabe, percentual_na_gpu, contexto)."""
    for model in (ps_json or {}).get("models", []):
        if model.get("name") == tag or model.get("model") == tag:
            size = int(model.get("size") or 0)
            vram = int(model.get("size_vram") or 0)
            pct = int(round(100.0 * vram / size)) if size else 0
            return (size > 0 and vram >= size * 0.98), pct, model.get("context_length")
    return False, 0, None


def capabilities_of(show_json):
    caps = (show_json or {}).get("capabilities") or []
    return {"vision": "vision" in caps, "tools": "tools" in caps, "thinking": "thinking" in caps,
            "completion": ("completion" in caps) or not caps}


# --------------------------------------------------------------------------------------------------------------------
# Servidor compatível com a API da OpenAI (proxy autenticado na frente do motor)
# --------------------------------------------------------------------------------------------------------------------

class ServerState(object):
    """Configuração e contadores do servidor. Os contadores nunca guardam o conteúdo das conversas."""

    def __init__(self, key, model, engine_url, ctx, vision, tools, thinking_default="auto", thinking_capable=False,
                 gpu="", notebook=NOTEBOOK_VERSION, engine="ollama"):
        self.key = key
        self.model = model
        self.engine_url = engine_url.rstrip("/")
        self.ctx = ctx
        self.vision = vision
        self.tools = tools
        self.thinking_default = thinking_default
        self.thinking_capable = thinking_capable
        self.gpu = gpu
        self.notebook = notebook
        self.engine = engine
        self.started = time.time()
        self.lock = threading.Lock()
        self.requests = 0
        self.active = 0
        self.errors = 0
        self.auth_failures = collections.deque(maxlen=64)
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.images = 0  # só o número de imagens recebidas (nunca o conteúdo)
        self.last_request_at = 0.0
        self.last_error = ""
        self.events = collections.deque(maxlen=40)

    def note(self, line):
        with self.lock:
            self.events.append("%s %s" % (time.strftime("%H:%M:%S"), line))

    def snapshot(self):
        with self.lock:
            return {"uptime": time.time() - self.started, "requests": self.requests, "active": self.active,
                    "errors": self.errors, "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens,
                    "images": self.images,
                    "last_request_ago": (time.time() - self.last_request_at) if self.last_request_at else None,
                    "last_error": self.last_error, "model": self.model, "ctx": self.ctx, "vision": self.vision,
                    "tools": self.tools, "gpu": self.gpu, "notebook": self.notebook, "events": list(self.events)[-10:]}


def models_document(state, engine_ok=True):
    """O `GET /v1/models`: além do formato da OpenAI, traz o que o Openclod precisa saber (visão, ferramentas, janela)."""
    params = ["temperature", "top_p", "max_tokens", "stop", "seed", "stream"]
    if state.tools:
        params += ["tools", "tool_choice"]
    entry = {
        "id": state.model, "object": "model", "created": int(state.started), "owned_by": "openclod-colab",
        "context_length": state.ctx, "max_model_len": state.ctx,
        "architecture": {"input_modalities": ["text", "image"] if state.vision else ["text"], "output_modalities": ["text"]},
        "supported_parameters": params,
        "capabilities": {"vision": state.vision, "tools": state.tools, "thinking": state.thinking_capable},
        "openclod": {"gpu": state.gpu, "notebook": state.notebook, "engine": state.engine, "engine_ok": engine_ok},
    }
    return {"object": "list", "data": [entry]}


def _json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def error_body(message, kind="server_error", code=None):
    error = {"message": message, "type": kind}
    if code is not None:
        error["code"] = code
    return {"error": error}


class _Upstream(object):
    """Chamada ao motor em uma thread própria, para o servidor poder mandar comentários SSE enquanto o motor processa o prompt."""

    def __init__(self, base_url, path, body, accept):
        self.parts = urllib.parse.urlsplit(base_url)
        self.path = path
        self.body = body
        self.accept = accept
        self.items = queue.Queue()
        self.cancel = threading.Event()
        self.conn = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def _run(self):
        try:
            self.conn = http.client.HTTPConnection(self.parts.hostname, self.parts.port or 80, timeout=UPSTREAM_TIMEOUT)
            self.conn.request("POST", self.path, body=self.body, headers={
                "Content-Type": "application/json", "Content-Length": str(len(self.body)), "Accept": self.accept})
            response = self.conn.getresponse()
            self.items.put(("headers", response.status, response.getheaders()))
            while not self.cancel.is_set():
                block = response.read1(16384)
                if not block:
                    break
                self.items.put(("data", block))
            self.items.put(("end",))
        except Exception as exc:  # noqa: BLE001 - o motor caiu, recusou ou o cliente cancelou
            self.items.put(("error", exc))
        finally:
            try:
                if self.conn:
                    self.conn.close()
            except Exception:
                pass

    def abort(self):
        self.cancel.set()
        try:
            if self.conn:
                self.conn.close()
        except Exception:
            pass


class _Handler(http.server.BaseHTTPRequestHandler):
    server_version = "OpenclodColab/" + NOTEBOOK_VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # nada de log de acesso: corpos e cabeçalhos nunca aparecem
        pass

    @property
    def state(self):
        return self.server.state

    # ---- respostas ----
    def _send_json(self, status, obj, headers=None):
        data = _json_bytes(obj)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def _send_raw(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def _start_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True

    def _chunk(self, data):
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        self.wfile.flush()

    def _end_chunks(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    # ---- autenticação ----
    def _authorized(self):
        header = self.headers.get("Authorization", "")
        given = header[7:].strip() if header.lower().startswith("bearer ") else (self.headers.get("x-api-key") or "").strip()
        ok = bool(given) and hmac.compare_digest(given.encode("utf-8"), self.state.key.encode("utf-8"))
        if not ok:
            now = time.time()
            with self.state.lock:
                self.state.auth_failures.append(now)
                recent = sum(1 for stamp in self.state.auth_failures if now - stamp < 60)
            if recent > 20:  # alguém está tentando adivinhar a chave: devagar
                time.sleep(1.5)
            self._send_json(401, error_body("Chave de API ausente ou inválida.", "invalid_request_error", "invalid_api_key"),
                            {"WWW-Authenticate": "Bearer"})
        return ok

    # ---- rotas ----
    def do_HEAD(self):
        self._route()

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def _route(self):
        path = urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"
        try:
            if path in ("/", "/healthz"):
                self._send_json(200, {"status": "ok", "service": "openclod-colab", "notebook": NOTEBOOK_VERSION})
                return
            if path not in PUBLIC_ROUTES:
                self._send_json(404, error_body("Rota inexistente.", "invalid_request_error", "not_found"))
                return
            if not self._authorized():
                return
            if path == "/v1/models" and self.command in ("GET", "HEAD"):
                alive = self._engine_alive()
                if not alive:
                    self._send_json(503, error_body("O motor (Ollama) não está respondendo no Colab.", "server_error", 503))
                    return
                self._send_json(200, models_document(self.state, alive))
                return
            if path == "/openclod/status" and self.command in ("GET", "HEAD"):
                self._send_json(200, self.state.snapshot())
                return
            if path == "/v1/chat/completions" and self.command == "POST":
                self._chat()
                return
            self._send_json(405, error_body("Método não permitido.", "invalid_request_error", "method_not_allowed"))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001
            self.state.note("erro interno: %s" % type(exc).__name__)
            try:
                self._send_json(500, error_body("Erro interno do servidor do notebook.", "server_error", 500))
            except Exception:
                pass

    def _engine_alive(self):
        parts = urllib.parse.urlsplit(self.state.engine_url)
        try:
            conn = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=3)
            conn.request("GET", "/api/version")
            alive = conn.getresponse().status == 200
            conn.close()
            return alive
        except Exception:
            return False

    def _read_body(self):
        if (self.headers.get("Transfer-Encoding") or "").lower() == "chunked":
            parts, total = [], 0
            while True:
                size = int((self.rfile.readline(64).strip().split(b";")[0]) or b"0", 16)
                if size == 0:
                    while self.rfile.readline(1024).strip():
                        pass
                    break
                total += size
                if total > MAX_BODY_BYTES:
                    return None
                parts.append(self.rfile.read(size))
                self.rfile.readline(2)
            return b"".join(parts)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length) if length else b""

    # ---- chat ----
    def _chat(self):
        state = self.state
        raw = self._read_body()
        if raw is None:
            self._send_json(413, error_body("Pedido grande demais (limite de %d MB)." % (MAX_BODY_BYTES // 1048576), "invalid_request_error", 413))
            return
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("o corpo não é um objeto")
        except Exception:
            self._send_json(400, error_body("O corpo precisa ser um JSON válido.", "invalid_request_error", 400))
            return
        wants_stream = bool(body.get("stream"))
        # Só existe um modelo carregado: qualquer nome pedido vai para ele (subagentes com "modelo herdado", por exemplo).
        body["model"] = state.model
        if state.thinking_capable and state.thinking_default == "off" and "reasoning_effort" not in body and "think" not in body:
            body["reasoning_effort"] = "none"
        if wants_stream:
            options = body.get("stream_options") if isinstance(body.get("stream_options"), dict) else {}
            options.setdefault("include_usage", True)
            body["stream_options"] = options
        payload = _json_bytes(body)
        pictures = sum(
            1 for message in body.get("messages") or [] if isinstance(message, dict) and isinstance(message.get("content"), list)
            for part in message["content"] if isinstance(part, dict) and part.get("type") == "image_url")
        with state.lock:
            state.requests += 1
            state.images += pictures
            state.active += 1
            state.last_request_at = time.time()
        started = time.time()
        label = "?"
        try:
            label = self._forward(payload, wants_stream)
        finally:
            with state.lock:
                state.active -= 1
                if label not in ("200", "cancelado"):
                    state.errors += 1
            state.note("%s %s em %.1fs" % ("stream" if wants_stream else "chat", label, time.time() - started))

    def _forward(self, payload, wants_stream):
        state = self.state
        upstream = _Upstream(state.engine_url, "/v1/chat/completions", payload,
                             "text/event-stream" if wants_stream else "application/json").start()
        begun = False
        tail = b""
        pieces = []
        up_status = None
        finished = False
        try:
            while True:
                try:
                    item = upstream.items.get(timeout=PING_SECONDS if begun else EARLY_FLUSH_SECONDS)
                except queue.Empty:
                    if wants_stream and not begun:
                        self._start_sse()  # o motor ainda processa o prompt: abre o fluxo para o túnel não cortar a conexão
                        begun = True
                    if begun:
                        self._chunk(b": aguardando o modelo\n\n")
                    continue
                kind = item[0]
                if kind == "headers":
                    up_status = item[1]
                    if up_status == 200 and wants_stream and not begun:
                        self._start_sse()
                        begun = True
                elif kind == "data":
                    if up_status == 200 and wants_stream:
                        self._chunk(item[1])
                        tail = (tail + item[1])[-6144:]
                    else:
                        pieces.append(item[1])
                elif kind == "end":
                    finished = True
                    if up_status == 200 and wants_stream:
                        self._end_chunks()
                        self._count_tokens(tail)
                        return "200"
                    data = b"".join(pieces)
                    if begun:  # o fluxo já estava aberto e o motor respondeu erro: o erro vai como evento SSE
                        message = self._engine_message(data, up_status)
                        self._chunk(b"data: " + _json_bytes(error_body(message, "upstream_error", up_status)) + b"\n\ndata: [DONE]\n\n")
                        self._end_chunks()
                        self._record_error(message)
                        return str(up_status)
                    if up_status == 200:
                        self._count_tokens(data[-6144:])
                        self._send_raw(200, data, "application/json; charset=utf-8")
                        return "200"
                    self._record_error(self._engine_message(data, up_status))
                    self._send_raw(up_status or 502, data or _json_bytes(error_body("Erro do motor.", "upstream_error", up_status)),
                                   "application/json; charset=utf-8")
                    return str(up_status)
                elif kind == "error":
                    finished = True
                    message = "O motor (Ollama) não respondeu: %s" % type(item[1]).__name__
                    self._record_error(message)
                    if begun:
                        self._chunk(b"data: " + _json_bytes(error_body(message, "upstream_error", 502)) + b"\n\ndata: [DONE]\n\n")
                        self._end_chunks()
                    else:
                        self._send_json(502, error_body(message, "upstream_error", 502))
                    return "502"
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return "cancelado"  # o cliente fechou (o usuário parou a resposta): o motor para de gerar
        finally:
            if not finished:
                upstream.abort()

    def _engine_message(self, data, status):
        try:
            parsed = json.loads(data.decode("utf-8", errors="replace"))
            inner = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(inner, dict) and inner.get("message"):
                return str(inner["message"])[:500]
            if isinstance(inner, str):
                return inner[:500]
        except Exception:
            pass
        return "O motor respondeu HTTP %s." % status

    def _record_error(self, message):
        with self.state.lock:
            self.state.last_error = message[:300]

    def _count_tokens(self, tail):
        text = tail.decode("utf-8", errors="replace")
        prompt = re.findall(r'"prompt_tokens"\s*:\s*(\d+)', text)
        completion = re.findall(r'"completion_tokens"\s*:\s*(\d+)', text)
        with self.state.lock:
            if prompt:
                self.state.prompt_tokens += int(prompt[-1])
            if completion:
                self.state.completion_tokens += int(completion[-1])


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"  # no Windows, SO_REUSEADDR deixaria dois servidores dividirem a mesma porta
    request_queue_size = 64

    def handle_error(self, request, client_address):  # cliente que some no meio é normal: sem traceback na saída da célula
        exc = sys.exc_info()[1]
        if not isinstance(exc, OSError) and getattr(self, "state", None) is not None:
            self.state.note("erro: %s" % type(exc).__name__)


def make_server(state, host="127.0.0.1", port=SERVER_PORT):
    server = _Server((host, port), _Handler)
    server.state = state
    return server


# --------------------------------------------------------------------------------------------------------------------
# Autoteste pelo endereço público
# --------------------------------------------------------------------------------------------------------------------

def make_png(width, height, rgb):
    """PNG de cor única, só com a biblioteca padrão."""
    raw = (b"\x00" + bytes(rgb) * width) * height

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


_COLORS = {
    "vermelho": ((220, 30, 30), r"vermelh|red"),
    "verde": ((30, 170, 60), r"verde|green"),
    "azul": ((30, 60, 220), r"azul|blue"),
    "amarelo": ((240, 210, 30), r"amarel|yellow"),
}

_TOOL = {"type": "function", "function": {
    "name": "somar_numeros", "description": "Soma dois números e devolve o resultado.",
    "parameters": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]}}}


def _post_stream(url, key, body, timeout=240.0):
    """POST com stream: devolve (status, quadros_sse, tempo_do_primeiro_pedaço, tempo_total, erro)."""
    request = urllib.request.Request(url, data=_json_bytes(body), method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key, "User-Agent": USER_AGENT})
    started = time.time()
    first = None
    frames = []
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            buffer = b""
            while True:
                block = response.read1(8192) if hasattr(response, "read1") else response.read(8192)
                if not block:
                    break
                if first is None:
                    first = time.time() - started
                buffer += block
                while b"\n\n" in buffer:
                    raw, buffer = buffer.split(b"\n\n", 1)
                    for line in raw.decode("utf-8", errors="replace").splitlines():
                        if line.startswith("data:"):
                            frames.append(line[5:].strip())
    except urllib.error.HTTPError as err:
        return err.code, [], None, time.time() - started, err.read().decode("utf-8", errors="replace")[:300]
    except Exception as exc:  # noqa: BLE001
        return 0, frames, first, time.time() - started, "%s: %s" % (type(exc).__name__, exc)
    return status, frames, first, time.time() - started, ""


def _content_of(frames):
    text, calls, finish = [], {}, None
    for frame in frames:
        if frame == "[DONE]":
            continue
        try:
            data = json.loads(frame)
        except ValueError:
            continue
        if data.get("error"):
            return None, None, "erro no fluxo: %s" % str(data["error"].get("message", data["error"]))[:200]
        for choice in data.get("choices") or []:
            delta = choice.get("delta") or {}
            if isinstance(delta.get("content"), str):
                text.append(delta["content"])
            for call in delta.get("tool_calls") or []:
                slot = calls.setdefault(call.get("index", 0), {"name": "", "args": ""})
                function = call.get("function") or {}
                slot["name"] += function.get("name") or ""
                slot["args"] += function.get("arguments") or ""
            finish = choice.get("finish_reason") or finish
    return "".join(text), calls, finish


def selftest(base_url, key, model, vision=True, tools=True, log=say, think_off=False):
    """Provas pelo endereço informado. Devolve {ok, results:[{name, ok, detail, ms}]}; `ok` = todas passaram.

    `think_off`: o modelo pensa antes de responder; o autoteste prova o caminho (texto, stream, imagem, ferramenta), não o
    raciocínio, e um modelo que pensa pode gastar os tokens do teste só pensando. Então pede `reasoning_effort: none`.
    """
    base = base_url.rstrip("/")
    results = []
    extra = {"reasoning_effort": "none"} if think_off else {}

    def record(name, ok, detail, started):
        results.append({"name": name, "ok": bool(ok), "detail": detail, "ms": int((time.time() - started) * 1000)})
        log("   [%s] %s: %s" % ("ok" if ok else "FALHOU", name, detail))

    started = time.time()
    status, text = http_json("GET", base + "/models", key=key, timeout=60)
    listed = status == 200 and model in text
    record("Lista de modelos com a chave", listed, ("modelo %s listado" % model) if listed else "HTTP %s" % status, started)
    started = time.time()
    status_bad, _ = http_json("GET", base + "/models", key="chave-errada", timeout=60)
    record("Chave errada é recusada", status_bad == 401, "HTTP %s" % status_bad, started)

    started = time.time()
    status, text = http_json("POST", base + "/chat/completions", key=key, timeout=300, body={
        "model": model, "max_tokens": 400, "temperature": 0, **extra,
        "messages": [{"role": "user", "content": "Responda apenas com a palavra: pong"}]})
    content = ""
    try:
        content = json.loads(text)["choices"][0]["message"]["content"] or ""
    except Exception:
        pass
    record("Texto", status == 200 and bool(content.strip()),
           ("respondeu %r" % content.strip()[:40]) if status == 200 else "HTTP %s %s" % (status, text[:120]), started)

    started = time.time()
    code, frames, first, total, err = _post_stream(base + "/chat/completions", key, {
        "model": model, "stream": True, "max_tokens": 400, "temperature": 0, **extra,
        "messages": [{"role": "user", "content": "Conte de 1 a 12 separando por vírgulas."}]})
    text_out, _, _finish = _content_of(frames)
    data_frames = len([f for f in frames if f != "[DONE]"])
    ok = code == 200 and text_out is not None and data_frames >= 3 and "[DONE]" in frames
    detail = ("%d pedaços, o 1º em %.1f s, total %.1f s" % (data_frames, first or 0, total)) if ok else (err or "HTTP %s, %d quadros" % (code, len(frames)))
    record("Streaming (SSE)", ok, detail, started)

    if vision:
        for color in secrets.SystemRandom().sample(sorted(_COLORS), 2):
            started = time.time()
            rgb, pattern = _COLORS[color]
            png = base64.b64encode(make_png(112, 112, rgb)).decode("ascii")
            status, text = http_json("POST", base + "/chat/completions", key=key, timeout=300, body={
                "model": model, "max_tokens": 600, "temperature": 0, **extra,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": "Qual é a cor desta imagem? Responda com uma única palavra, em português."},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + png}}]}]})
            answer = ""
            try:
                answer = json.loads(text)["choices"][0]["message"]["content"] or ""
            except Exception:
                pass
            ok = status == 200 and re.search(pattern, answer, re.I) is not None
            record("Imagem (%s)" % color, ok,
                   ("respondeu %r" % answer.strip()[:40]) if status == 200 else "HTTP %s %s" % (status, text[:120]), started)

    if tools:
        started = time.time()
        code, frames, first, total, err = _post_stream(base + "/chat/completions", key, {
            "model": model, "stream": True, "max_tokens": 1000, "temperature": 0, "tools": [_TOOL], "tool_choice": "auto", **extra,
            "messages": [{"role": "user", "content": "Use a ferramenta somar_numeros para calcular 17 + 25. Chame a ferramenta; não responda com texto."}]})
        _text, calls, finish = _content_of(frames)
        good = False
        shown = err or "sem chamada de ferramenta (finish=%s)" % finish
        if calls:
            first_call = calls[sorted(calls)[0]]
            try:
                args = json.loads(first_call["args"] or "{}")
                good = first_call["name"] == "somar_numeros" and float(args.get("a")) == 17 and float(args.get("b")) == 25
                shown = "%s(%s)" % (first_call["name"], first_call["args"][:60])
            except Exception:
                shown = "argumentos inválidos: %r" % first_call["args"][:60]
        record("Chamada de ferramenta (stream)", code == 200 and good, shown, started)

    return {"ok": all(item["ok"] for item in results), "results": results}


# --------------------------------------------------------------------------------------------------------------------
# Painel de status
# --------------------------------------------------------------------------------------------------------------------

def render_panel(snapshot, public_url, gpu, extra=""):
    """Texto do painel (sem segredos)."""
    ago = snapshot.get("last_request_ago")
    lines = [
        "Servidor do Openclod no ar" + ("  " + extra if extra else ""),
        "",
        "GPU ........ %s" % gpu,
        "Modelo ..... %s" % snapshot.get("model"),
        "Contexto ... %s tokens" % format(int(snapshot.get("ctx") or 0), ",").replace(",", "."),
        "Visão ...... %s     Ferramentas ... %s" % ("sim" if snapshot.get("vision") else "não", "sim" if snapshot.get("tools") else "não"),
        "Endereço ... %s" % public_url,
        "",
        "No ar há ... %s" % human_duration(snapshot.get("uptime", 0)),
        "Pedidos .... %d (em andamento: %d, com erro: %d)" % (snapshot.get("requests", 0), snapshot.get("active", 0), snapshot.get("errors", 0)),
        "Tokens ..... %d lidos / %d gerados     Imagens recebidas: %d" % (snapshot.get("prompt_tokens", 0), snapshot.get("completion_tokens", 0), snapshot.get("images", 0)),
        "Último ..... %s" % ("há %d s" % ago if ago is not None else "nenhum pedido ainda"),
    ]
    if snapshot.get("last_error"):
        lines.append("Último erro  %s" % snapshot["last_error"])
    lines += ["", "Mantenha esta aba aberta. Se a sessão do Colab acabar, rode o notebook de novo e cole o novo código no Openclod."]
    return "\n".join(lines)


def connection_block(code):
    return ("CÓDIGO DE CONEXÃO: copie a linha inteira e cole no Openclod, em Configurações > Provedores > Google Colab.\n"
            "Ele contém a chave de acesso e vale só enquanto esta execução durar: trate como uma senha e não compartilhe.\n\n" + code)


# --------------------------------------------------------------------------------------------------------------------
# Etapas do notebook (cada célula chama uma)
# --------------------------------------------------------------------------------------------------------------------

class Session(object):
    """Estado compartilhado entre as células."""

    def __init__(self):
        self.gpu = None
        self.plan = None
        self.options = {}
        self.chosen = None
        self.caps = {}
        self.ollama_bin = ""
        self.ollama = None
        self.server = None
        self.cloudflared = None
        self.cloudflared_bin = ""
        self.public_url = ""
        self.key = new_key()
        self.hf_token = ""
        self.code = ""
        self.unavailable = set()  # etiquetas que o registro do Ollama disse que não existem (conferido na etapa 2)
        self.restarts = collections.deque(maxlen=8)


SESSION = Session()


def step_gpu():
    """Célula 1: confere a GPU e avisa, em português, se o ambiente não tem uma."""
    say("Openclod: servidor de LLM no Google Colab, notebook %s" % NOTEBOOK_VERSION)
    gpu = detect_gpu()
    if not gpu:
        fail("Este ambiente não tem GPU. No menu do Colab: Ambiente de execução > Alterar o tipo de ambiente de execução > "
             "Acelerador por hardware: GPU (a T4 serve; L4 e A100 deixam o modelo bem melhor). Depois use Ambiente de execução > Executar tudo.")
    SESSION.gpu = gpu
    say("GPU encontrada: %s | memória %s GB (livre %s GB) | driver %s%s" % (
        gpu["name"], gb_text(gpu["total_mib"]), gb_text(gpu["free_mib"]), gpu["driver"] or "?",
        (" | compute %s" % gpu["cc"]) if gpu["cc"] else ""))
    if gpu["total_mib"] < 7000:
        say("[!] GPU com menos de 8 GB: só cabe um modelo pequeno (4B). Para um agente de verdade, escolha uma GPU maior.")
    return gpu


def _ask_for_model(listing, plan, seconds, run, gpu, contexto_manual, pensamento, free_mib):
    """A pausa da etapa 2: mostra a caixa de escolha, espera e devolve o plano que vale (o do número escolhido, ou o automático)."""
    automatic = plan["candidates"][0]["tag"]
    say("Escolha o modelo na caixa abaixo e clique em «Usar este modelo». Sem escolha em %s, o notebook segue com o automático (%s)." % (
        wait_text(seconds), automatic))
    who, number, detail = ask_model_choice(choice_data(listing, plan, SESSION.unavailable, seconds), eval_js=run)
    say("")
    if who == "usuario" and number:
        try:
            chosen = plan_for(gpu["total_mib"], "", int(contexto_manual or 0), pensamento, number, "", free_mib)
        except ValueError as exc:
            fail(str(exc))
        variant = listing["by_number"][number]["variant"]
        SESSION.options["numero_da_lista"] = number
        say("Você escolheu o n.º %d: %s (%s)." % (number, variant["nome"], variant["quant"]))
        return chosen
    if who == "usuario":
        say("Você confirmou o modelo automático (%s)." % automatic)
    elif who == "tempo":
        say("Ninguém escolheu em %s: seguindo com o automático (%s)." % (wait_text(seconds), automatic))
    elif who == "sem-resposta":
        say("A caixa de escolha não respondeu (a aba do Colab foi fechada, ou este ambiente não a mostra): seguindo com o automático (%s)." % automatic)
    else:
        say("Não consegui mostrar a caixa de escolha%s: seguindo com o automático (%s)." % ((" (%s)" % detail) if detail else "", automatic))
    return plan


def step_plan(modelo_manual="", contexto_manual=0, pensamento="padrão", hf_token="", numero_da_lista=0, tipo_de_modelo="automático",
              somente_listar=False, segundos_para_escolher=CHOICE_SECONDS):
    """Célula 2: mostra os modelos abertos que cabem nesta GPU (de todo tipo, inclusive sem censura) e escolhe o que vai rodar:
    o melhor para agente (padrão), o número da lista, um tipo de modelo ou uma etiqueta digitada. No Colab, sem nenhuma escolha no
    formulário, PARA numa caixa de seleção (botão "Usar este modelo") por `segundos_para_escolher` segundos antes de baixar qualquer
    coisa; sem escolha, segue com o automático. Quem já escolheu no formulário, pediu só a lista, ou usa 0 segundos não é perguntado."""
    if not SESSION.gpu:
        step_gpu()
    gpu = SESSION.gpu
    seconds = choice_seconds(segundos_para_escolher)
    SESSION.options = {"modelo_manual": modelo_manual or "", "contexto_manual": int(contexto_manual or 0), "pensamento": pensamento,
                       "numero_da_lista": int(numero_da_lista or 0), "tipo_de_modelo": tipo_de_modelo, "somente_listar": bool(somente_listar),
                       "segundos_para_escolher": seconds}
    SESSION.hf_token = hf_token or ""
    free_mib = gpu.get("free_mib")
    listing = build_listing(usable_gib(gpu["total_mib"], free_mib))
    # OPENCLOD_COLAB_OFFLINE=1 desliga a conferência no registro (testes e máquinas sem acesso a registry.ollama.ai).
    offline = bool(os.environ.get("OPENCLOD_COLAB_OFFLINE"))
    registry = {} if offline else verify_registry(listing["rows"])
    SESSION.unavailable = set(tag for tag, (state, _gb) in registry.items() if state == "ausente")
    try:
        plan = plan_for(gpu["total_mib"], modelo_manual or "", int(contexto_manual or 0), pensamento, int(numero_da_lista or 0),
                        tipo_de_modelo, free_mib)
    except ValueError as exc:
        fail(str(exc))
    first = plan["candidates"][0]
    # Pergunta só quando nada foi escolhido no formulário, não é "só listar" e há quem possa clicar (o Colab; fora dele, `run` é None).
    nothing_chosen = not (modelo_manual or "").strip() and not int(numero_da_lista or 0) and not _kind_of(tipo_de_modelo)
    run = colab_eval_js() if seconds and nothing_chosen and not somente_listar else None
    checked = sum(1 for state, _gb in registry.values() if state != "?")
    say("")
    say("Modelos abertos que cabem nesta GPU (%s GB livres): %d de %d do catálogo, de todo tipo, inclusive sem censura." % (
        _dec(listing["usable"]), len(listing["rows"]), listing["total"]))
    # The tier table may name a model by its other spelling ("qwen3.5:4b-q4_K_M" = "qwen3.5:4b"): mark the row either way.
    running = catalog_variant(first["tag"])
    for line in listing_lines(listing, running["tag"] if running else first["tag"], SESSION.unavailable,
                              "<== automático" if run else "<== rodando esta"):
        say(line)
    say("")
    if checked:
        say("Conferi no registro do Ollama: %d etiquetas existem, %d não." % (
            sum(1 for state, _gb in registry.values() if state == "ok"), len(SESSION.unavailable)))
    elif offline:
        say("A conferência no registro do Ollama está desligada (OPENCLOD_COLAB_OFFLINE): a lista vale pelo catálogo.")
    else:
        say("Não consegui falar com o registro do Ollama agora: a lista vale pelo catálogo (o download confere de novo).")
    say("O tamanho em GB é o do arquivo; o contexto é o maior que cabe em 100% na GPU (estimativa conservadora: o notebook confere "
        "de verdade ao carregar).")
    say("")
    if run:
        plan = _ask_for_model(listing, plan, seconds, run, gpu, contexto_manual, pensamento, free_mib)
        say("")
    SESSION.plan = plan
    say("Rodando nesta execução (%s):" % plan["label"])
    say("  %s" % plan["why"])
    for index, item in enumerate(plan["candidates"]):
        say("  %s %s | contexto %d tokens | cache KV %s | pensamento %s" % (
            "->" if index == 0 else "  ", item["tag"], item["ctx"], item["kv"], "ligado" if item["thinking"] == "auto" else "desligado"))
    if len(plan["candidates"]) > 1:
        say("  (as opções seguintes só entram se a anterior não couber 100% na GPU)")
    say("  Fonte: " + "  ".join(plan["sources"]))
    say("")
    say("Para rodar outro: em Opções, preencha numero_da_lista com o número da lista acima, ou tipo_de_modelo, ou digite uma "
        "etiqueta do Ollama em modelo_manual, e rode tudo de novo.")
    if somente_listar:
        say("Você marcou somente_listar_modelos: parei aqui, antes de baixar qualquer coisa. Escolha em Opções, desmarque essa caixa e "
            "use Executar tudo.")
        raise StepStopped("Parei depois da lista, como você pediu.")
    return plan


def _engine_env(candidate):
    env = dict(os.environ)
    env.update({
        "OLLAMA_HOST": "127.0.0.1:%d" % ENGINE_PORT,
        "OLLAMA_CONTEXT_LENGTH": str(candidate["ctx"]),
        "OLLAMA_NUM_PARALLEL": str(candidate["parallel"]),
        "OLLAMA_FLASH_ATTENTION": "1",
        "OLLAMA_KV_CACHE_TYPE": candidate["kv"],
        "OLLAMA_KEEP_ALIVE": "-1",
        "OLLAMA_MAX_LOADED_MODELS": "1",
        "OLLAMA_NO_CLOUD": "1",
        "OLLAMA_NOPRUNE": "1",
        "OLLAMA_LOAD_TIMEOUT": "20m",
        "OLLAMA_MODELS": os.path.join(WORK_DIR, "models"),
        "CUDA_VISIBLE_DEVICES": env.get("CUDA_VISIBLE_DEVICES", "0"),
    })
    if SESSION.hf_token:  # só para baixar modelos com acesso restrito da conta do próprio usuário
        env["HF_TOKEN"] = SESSION.hf_token
        env["HUGGING_FACE_HUB_TOKEN"] = SESSION.hf_token
    return env


def _extract_zst(archive, dest):
    """Extrai um .tar.zst (usa o `zstd` do sistema; se não houver, tenta instalar; por fim usa o pacote Python `zstandard`)."""
    os.makedirs(dest, exist_ok=True)
    if not shutil.which("zstd"):
        subprocess.run(["apt-get", "install", "-y", "-qq", "zstd"], capture_output=True, text=True)
    if shutil.which("zstd"):
        pipeline = "zstd -dc '%s' | tar -xf - -C '%s' --no-same-owner" % (archive, dest)
        result = subprocess.run(["bash", "-c", "set -o pipefail; " + pipeline], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError("falha ao extrair o Ollama: %s" % (result.stderr or result.stdout)[-300:])
        return
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "zstandard"], check=True)
    import zstandard  # noqa: PLC0415
    root = os.path.realpath(dest)
    with open(archive, "rb") as handle:
        reader = zstandard.ZstdDecompressor().stream_reader(handle)
        with tarfile.open(fileobj=reader, mode="r|") as tar:
            for member in tar:
                target = os.path.realpath(os.path.join(dest, member.name))
                if target != root and not target.startswith(root + os.sep):
                    raise RuntimeError("arquivo suspeito no pacote: " + member.name)
                tar.extract(member, dest)


_ENGINE_VERSION = re.compile(r"version\s+(?:is\s+)?v?(\d+(?:\.\d+)+)", re.I)


def engine_version_text(output):
    """A versão que o `ollama --version` imprime. Sem servidor rodando ele também avisa ("Warning: could not connect to a running
    Ollama instance") e, no Linux, a própria versão vem como "Warning: client version is 0.40.11": vale a linha que traz a versão."""
    match = _ENGINE_VERSION.search(output or "")
    return match.group(1) if match else ""


def step_install_engine():
    """Célula 3: instala o Ollama (binário oficial, versão e SHA-256 fixos)."""
    os.makedirs(WORK_DIR, exist_ok=True)
    install_dir = os.path.join(WORK_DIR, "ollama")
    binary = os.path.join(install_dir, "bin", "ollama")
    if os.path.exists(binary):
        say("Ollama %s já instalado." % OLLAMA_VERSION)
    else:
        say("Instalando o Ollama %s (binário oficial, ~1,5 GB; leva de 1 a 3 minutos)..." % OLLAMA_VERSION)
        archive = os.path.join(WORK_DIR, "ollama-linux-amd64.tar.zst")
        try:
            download(OLLAMA_URL, archive, OLLAMA_SHA256, "Ollama")
            say("   Verificado (o SHA-256 confere). Extraindo...")
            _extract_zst(archive, install_dir)
        except RuntimeError as exc:
            fail("Não consegui instalar o Ollama: %s. Rode a célula de novo; se persistir, confira se o Colab alcança github.com." % exc)
        finally:
            try:
                os.remove(archive)
            except OSError:
                pass
        if not os.path.exists(binary):
            fail("O pacote do Ollama não trouxe o executável esperado em %s." % binary)
        os.chmod(binary, 0o755)
    SESSION.ollama_bin = binary
    version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=60)
    found = engine_version_text((version.stdout or "") + "\n" + (version.stderr or ""))
    say("Ollama pronto: versão %s." % (found or OLLAMA_VERSION))
    return binary


def stop_process(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _start_engine(candidate):
    stop_process(SESSION.ollama)
    os.makedirs(os.path.join(WORK_DIR, "models"), exist_ok=True)
    log_path = os.path.join(WORK_DIR, "ollama.log")
    log = open(log_path, "w")
    SESSION.ollama = subprocess.Popen([SESSION.ollama_bin, "serve"], env=_engine_env(candidate), stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 90
    while time.time() < deadline:
        if SESSION.ollama.poll() is not None:
            fail("O Ollama fechou ao iniciar. Últimas linhas do log:\n" + tail_file(log_path))
        try:
            if http_json("GET", "http://127.0.0.1:%d/api/version" % ENGINE_PORT, timeout=3)[0] == 200:
                return
        except Exception:
            pass
        time.sleep(1)
    fail("O Ollama não respondeu em 90 s. Últimas linhas do log:\n" + tail_file(log_path))


def _pull(tag):
    """Baixa o modelo pelo Ollama com uma barra de progresso única."""
    request = urllib.request.Request("http://127.0.0.1:%d/api/pull" % ENGINE_PORT, data=_json_bytes({"model": tag, "stream": True}),
                                     method="POST", headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
    progress = PullProgress()
    last = 0.0
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            for raw in response:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                event = json.loads(line)
                if event.get("error"):
                    raise RuntimeError(str(event["error"]))
                summary = progress.feed(event)
                now = time.time()
                if now - last > 2.0 and summary["total"]:
                    last = now
                    print("\r   baixando o modelo: %s de %s (%d%%) a %s/s      " % (
                        human_bytes(summary["done"]), human_bytes(summary["total"]), summary["percent"], human_bytes(summary["speed"])),
                        end="", flush=True)
        print("\r   modelo baixado.                                                  ", flush=True)
    except urllib.error.HTTPError as err:
        raise RuntimeError(err.read().decode("utf-8", errors="replace")[:300])


def _load_and_check(candidate):
    """Carrega o modelo na GPU com o contexto pedido e devolve (cabe_100%, pct_gpu, contexto, capacidades)."""
    tag = candidate["tag"]
    status, text = http_json("POST", "http://127.0.0.1:%d/api/show" % ENGINE_PORT, body={"model": tag}, timeout=60)
    caps = capabilities_of(json.loads(text) if status == 200 else {})
    status, text = http_json("POST", "http://127.0.0.1:%d/api/generate" % ENGINE_PORT, timeout=1200,
                             body={"model": tag, "prompt": "", "keep_alive": -1, "stream": False})
    if status != 200:
        raise RuntimeError("o Ollama não conseguiu carregar o modelo: " + text[:300])
    status, text = http_json("GET", "http://127.0.0.1:%d/api/ps" % ENGINE_PORT, timeout=30)
    fits, pct, ctx = ps_fit(json.loads(text) if status == 200 else {}, tag)
    return fits, pct, ctx, caps


def _vram_line():
    gpu = detect_gpu()
    return "VRAM em uso: %s de %s GB" % (gb_text(gpu["total_mib"] - gpu["free_mib"]), gb_text(gpu["total_mib"])) if gpu else ""


def step_model():
    """Célula 4: sobe o motor, baixa o modelo e confere que cabe 100% na GPU (tenta a próxima opção se não couber)."""
    if not SESSION.plan:
        step_plan(segundos_para_escolher=0)  # célula 4 rodada sozinha: nada de caixa de escolha, vale o automático
    if not SESSION.ollama_bin:
        step_install_engine()
    free_gb = shutil.disk_usage(WORK_DIR).free / 1e9
    for index, candidate in enumerate(SESSION.plan["candidates"]):
        tag = candidate["tag"]
        need = candidate["weights_gb"] * 1.1 + 2
        say("")
        say("Tentativa %d de %d: %s, contexto %d tokens" % (index + 1, len(SESSION.plan["candidates"]), tag, candidate["ctx"]))
        if tag in SESSION.unavailable:
            if candidate.get("explicit"):
                fail("A etiqueta '%s' não existe no registro do Ollama (conferi na etapa 2). Escolha outro número da lista ou digite "
                     "outra etiqueta em modelo_manual." % tag)
            say("   [!] o registro do Ollama não tem mais '%s'; pulando esta opção." % tag)
            continue
        if candidate["weights_gb"] and need > free_gb:
            say("   [!] pouco disco livre (%.0f GB livres, preciso de ~%.0f GB); pulando esta opção." % (free_gb, need))
            continue
        _start_engine(candidate)
        try:
            _pull(tag)
        except RuntimeError as exc:
            if SESSION.options.get("modelo_manual"):
                fail("Não consegui baixar o modelo '%s': %s. Confira o nome (ex.: qwen3.5:9b ou hf.co/usuario/repositorio:Q4_K_M); "
                     "modelos com acesso restrito exigem o segredo HF_TOKEN do Colab (ícone da chave, na barra lateral) com acesso à sua conta." % (tag, exc))
            say("   [!] não consegui baixar %s: %s" % (tag, exc))
            continue
        say("   carregando na GPU (pode levar um minuto)...")
        try:
            fits, pct, ctx, caps = _load_and_check(candidate)
        except RuntimeError as exc:
            say("   [!] %s" % exc)
            continue
        say("   %s | %d%% do modelo na GPU | contexto efetivo %s" % (_vram_line(), pct, ctx or candidate["ctx"]))
        if not fits:
            later = [item for item in SESSION.plan["candidates"][index + 1:] if item["tag"] == tag]
            if candidate.get("explicit") and not later:
                fail("O modelo '%s' não coube 100%% na GPU deste ambiente, nem com contexto menor. Escolha outro da lista da etapa 2 "
                     "(um menor) ou uma GPU maior." % tag)
            say("   [!] não coube 100% na GPU; tentando a próxima opção.")
            continue
        if not caps["tools"]:
            if candidate.get("explicit") or candidate.get("no_tools_ok"):
                say("   [!] o modelo '%s' não declara chamada de ferramentas: o Openclod não poderá usá-lo como agente (só para "
                    "conversar). Seguindo, porque foi você quem o escolheu." % tag)
            else:
                say("   [!] o modelo '%s' não declara chamada de ferramentas e o Openclod depende delas como agente; tentando a "
                    "próxima opção." % tag)
                continue
        if not caps["vision"]:
            say("   [!] o modelo '%s' não declara visão: o Openclod vai usar o relé de visão (outro modelo descreve as imagens)." % tag)
        SESSION.chosen = dict(candidate)
        SESSION.chosen["ctx"] = int(ctx or candidate["ctx"])
        SESSION.caps = caps
        say("")
        say("Modelo no ar: %s | visão: %s | ferramentas: %s | pensamento: %s" % (
            tag, "sim" if caps["vision"] else "não", "sim" if caps["tools"] else "não", "sim" if caps["thinking"] else "não"))
        return SESSION.chosen
    fail("Nenhuma das opções coube na GPU deste ambiente (ou não declarou ferramentas). Escolha uma GPU maior (Ambiente de execução > "
         "Alterar o tipo de ambiente), outro número da lista da etapa 2, ou preencha 'modelo_manual' com um modelo menor (ex.: qwen3.5:4b).")


def _spawn_server():
    chosen, caps = SESSION.chosen, SESSION.caps
    state = ServerState(SESSION.key, chosen["tag"], "http://127.0.0.1:%d" % ENGINE_PORT, chosen["ctx"], caps["vision"], caps["tools"],
                        chosen["thinking"], caps["thinking"], gpu_label(SESSION.gpu))
    SESSION.server = make_server(state, "127.0.0.1", SERVER_PORT)
    threading.Thread(target=SESSION.server.serve_forever, daemon=True).start()
    return state


def step_server():
    """Célula 5: sobe o servidor compatível com a OpenAI (exige a chave gerada aqui)."""
    if not SESSION.chosen:
        step_model()
    if SESSION.server is None:
        _spawn_server()
    status, _ = http_json("GET", "http://127.0.0.1:%d/healthz" % SERVER_PORT, timeout=10)
    if status != 200:
        fail("O servidor local não respondeu (HTTP %s)." % status)
    status, _ = http_json("GET", "http://127.0.0.1:%d/v1/models" % SERVER_PORT, timeout=10)
    if status != 401:
        fail("O servidor local deveria exigir a chave (recebi HTTP %s sem ela)." % status)
    say("Servidor local no ar na porta %d; exige chave de acesso (gerada agora, vale só nesta execução)." % SERVER_PORT)


_TUNNEL_URL = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com", re.I)


def parse_tunnel_url(log_text):
    match = _TUNNEL_URL.search(log_text or "")
    return match.group(0) if match else ""


def step_install_tunnel():
    os.makedirs(WORK_DIR, exist_ok=True)
    binary = os.path.join(WORK_DIR, "cloudflared")
    try:
        download(CLOUDFLARED_URL, binary, CLOUDFLARED_SHA256, "cloudflared")
    except RuntimeError as exc:
        fail("Não consegui baixar o cloudflared: %s. Rode a célula de novo." % exc)
    os.chmod(binary, 0o755)
    SESSION.cloudflared_bin = binary
    return binary


def _start_tunnel(protocol):
    stop_process(SESSION.cloudflared)
    log_path = os.path.join(WORK_DIR, "cloudflared.log")
    log = open(log_path, "w")
    SESSION.cloudflared = subprocess.Popen(
        [SESSION.cloudflared_bin, "tunnel", "--no-autoupdate", "--protocol", protocol, "--url", "http://127.0.0.1:%d" % SERVER_PORT],
        stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 60
    while time.time() < deadline:
        if SESSION.cloudflared.poll() is not None:
            return ""
        url = parse_tunnel_url(tail_file(log_path, 200))
        if url:
            return url
        time.sleep(1)
    return ""


def step_tunnel():
    """Célula 6: abre o quick tunnel da Cloudflare e espera o endereço público responder."""
    if SESSION.server is None:
        step_server()
    if not SESSION.cloudflared_bin:
        step_install_tunnel()
    url = ""
    for protocol in ("auto", "http2"):
        say("Abrindo o túnel (protocolo %s)..." % protocol)
        url = _start_tunnel(protocol)
        if url:
            break
        say("   [!] o túnel não subiu com o protocolo %s." % protocol)
    if not url:
        fail("Não consegui abrir o túnel da Cloudflare. Últimas linhas do log:\n" + tail_file(os.path.join(WORK_DIR, "cloudflared.log")) +
             "\nSe o seu ambiente bloqueia conexões de saída na porta 7844, este método não funciona nele.")
    say("   endereço: %s (aguardando a rede resolver o nome novo...)" % url)
    deadline = time.time() + 150
    while time.time() < deadline:
        try:
            if http_json("GET", url + "/healthz", timeout=10)[0] == 200:
                SESSION.public_url = url
                say("   túnel respondendo.")
                return url
        except Exception:
            pass
        time.sleep(3)
    fail("O túnel abriu, mas o endereço público não respondeu em 150 s. Rode esta célula de novo para abrir outro túnel.")


def build_code():
    chosen = SESSION.chosen
    return make_connection_code({
        "nb": NOTEBOOK_VERSION, "u": SESSION.public_url + "/v1", "k": SESSION.key, "m": chosen["tag"], "g": gpu_label(SESSION.gpu),
        "vm": SESSION.gpu["total_mib"], "vi": 1 if SESSION.caps["vision"] else 0, "tl": 1 if SESSION.caps["tools"] else 0,
        "c": chosen["ctx"], "e": "ollama " + OLLAMA_VERSION, "t": int(time.time()), "sh": module_hash()})


def step_selftest():
    """Célula 7 (parte 1): prova texto, streaming, imagem e ferramenta pelo endereço PÚBLICO e só então gera o código."""
    if not SESSION.public_url:
        step_tunnel()
    say("Autoteste pelo endereço público (%s):" % SESSION.public_url)
    outcome = selftest(SESSION.public_url + "/v1", SESSION.key, SESSION.chosen["tag"], SESSION.caps["vision"], SESSION.caps["tools"],
                       think_off=SESSION.caps["thinking"])
    if not outcome["ok"]:
        failed = [item for item in outcome["results"] if not item["ok"]]
        fail("O autoteste falhou em: %s. Nenhum código foi gerado. Rode a célula de novo; se persistir, veja o log do motor em %s."
             % ("; ".join(item["name"] for item in failed), os.path.join(WORK_DIR, "ollama.log")))
    SESSION.code = build_code()
    say("")
    say("Autoteste completo: tudo funcionou pelo endereço público.")
    return SESSION.code


def _display_code(code):
    say("")
    say(connection_block(code))
    try:
        from IPython.display import HTML, display  # noqa: PLC0415
        display(HTML(
            "<div style='margin:8px 0'><textarea id='occ-code' readonly rows='5' style='width:100%;font-family:monospace;font-size:12px'>"
            + code + "</textarea><br><button onclick=\"var t=document.getElementById('occ-code');t.select();"
            "document.execCommand('copy');this.innerText='Copiado!'\">Copiar código de conexão</button></div>"))
    except Exception:
        pass


def _can_restart():
    now = time.time()
    SESSION.restarts.append(now)
    return sum(1 for stamp in SESSION.restarts if now - stamp < 600) <= 3


def _supervise():
    """Confere os processos; reinicia o que caiu (no máximo 3 vezes em 10 minutos). Devolve '' | 'novo-endereço' | mensagem de erro."""
    if SESSION.ollama is not None and SESSION.ollama.poll() is not None:
        if not _can_restart():
            return "O Ollama caiu várias vezes seguidas. Últimas linhas do log:\n" + tail_file(os.path.join(WORK_DIR, "ollama.log"))
        say("[!] O Ollama caiu; reiniciando...")
        _start_engine(SESSION.chosen)
        _load_and_check(SESSION.chosen)
    if SESSION.cloudflared is not None and SESSION.cloudflared.poll() is not None:
        if not _can_restart():
            return "O túnel caiu várias vezes seguidas. Últimas linhas do log:\n" + tail_file(os.path.join(WORK_DIR, "cloudflared.log"))
        say("[!] O túnel caiu; reabrindo (o endereço muda)...")
        SESSION.public_url = ""
        step_tunnel()
        outcome = selftest(SESSION.public_url + "/v1", SESSION.key, SESSION.chosen["tag"], SESSION.caps["vision"], SESSION.caps["tools"],
                           log=lambda *_: None, think_off=SESSION.caps["thinking"])
        if not outcome["ok"]:
            return "O autoteste falhou depois de reabrir o túnel."
        SESSION.code = build_code()
        return "novo-endereço"
    return ""


def step_serve_forever(refresh=15):
    """Célula 7: autoteste, código de conexão e painel de status. Não termina: o servidor vive enquanto esta célula roda."""
    code = step_selftest()
    _display_code(code)
    handle = None
    try:
        from IPython.display import HTML, display  # noqa: PLC0415
        handle = display(HTML("<pre>preparando o painel...</pre>"), display_id=True)
    except Exception:
        handle = None
    last_text = ""
    while True:
        problem = _supervise()
        if problem == "novo-endereço":
            say("")
            say("[!] O endereço público mudou (o túnel foi reaberto). Use ESTE código no Openclod:")
            _display_code(SESSION.code)
        elif problem:
            say("[ERRO] " + problem)
            raise StepFailed("Servidor interrompido: veja a mensagem acima.")
        text = render_panel(SESSION.server.state.snapshot(), SESSION.public_url, gpu_label(SESSION.gpu))
        if handle is not None:
            from IPython.display import HTML  # noqa: PLC0415
            handle.update(HTML("<pre style='font-size:13px'>" + text.replace("&", "&amp;").replace("<", "&lt;") + "</pre>"))
        elif text != last_text:
            say(text)
            last_text = text
        time.sleep(refresh)


# --------------------------------------------------------------------------------------------------------------------
# Linha de comando (testes e depuração fora do Colab)
# --------------------------------------------------------------------------------------------------------------------

def _cli(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    parser = argparse.ArgumentParser(prog="openclod_llm_server")
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="sobe o proxy autenticado na frente de um motor Ollama já em execução")
    serve.add_argument("--engine-url", default="http://127.0.0.1:%d" % ENGINE_PORT)
    serve.add_argument("--model", required=True)
    serve.add_argument("--key", required=True)
    serve.add_argument("--ctx", type=int, default=32768)
    serve.add_argument("--port", type=int, default=0)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--no-vision", action="store_true")
    serve.add_argument("--no-tools", action="store_true")
    serve.add_argument("--thinking", choices=["auto", "off"], default="auto")
    serve.add_argument("--gpu", default="")
    test = sub.add_parser("selftest")
    test.add_argument("--url", required=True)
    test.add_argument("--key", required=True)
    test.add_argument("--model", required=True)
    test.add_argument("--no-vision", action="store_true")
    test.add_argument("--no-tools", action="store_true")
    test.add_argument("--think-off", action="store_true", help="o modelo pensa: o autoteste pede reasoning_effort=none")
    run = sub.add_parser(
        "run", help="o notebook inteiro fora do Colab (Linux com GPU NVIDIA)",
        description="O notebook inteiro fora do Colab: confere a GPU, escolhe o modelo, instala o motor, sobe o servidor, abre o túnel, "
                    "faz o autoteste e mostra o código de conexão. Use OPENCLOD_COLAB_DIR para escolher a pasta de trabalho.")
    run.add_argument("--model", default="", help="etiqueta do Ollama para forçar um modelo (padrão: o da tabela para a GPU)")
    run.add_argument("--ctx", type=int, default=0)
    run.add_argument("--thinking", default="padrão", help="padrão | ligado | desligado")
    run.add_argument("--numero", type=int, default=0, help="n.º da lista de modelos que cabem na GPU (veja `catalog`)")
    run.add_argument("--tipo", default="", help="automático | sem censura | código | raciocínio | leve e rápido")
    plan = sub.add_parser("plan")
    plan.add_argument("--vram", type=int, required=True)
    plan.add_argument("--model", default="")
    plan.add_argument("--ctx", type=int, default=0)
    plan.add_argument("--thinking", default="padrão")
    plan.add_argument("--numero", type=int, default=0)
    plan.add_argument("--tipo", default="")
    plan.add_argument("--free", type=int, default=0, help="MiB livres (padrão: a VRAM total menos ~450 MiB)")
    catalog = sub.add_parser("catalog", help="a lista dos modelos abertos que cabem numa GPU (não baixa nada)")
    catalog.add_argument("--vram", type=int, required=True)
    catalog.add_argument("--free", type=int, default=0, help="MiB livres (padrão: a VRAM total menos ~450 MiB)")
    catalog.add_argument("--json", action="store_true")
    code = sub.add_parser("code")
    code.add_argument("--url", required=True)
    code.add_argument("--key", required=True)
    code.add_argument("--model", required=True)
    code.add_argument("--gpu", default="")
    code.add_argument("--ctx", type=int, default=0)
    code.add_argument("--no-vision", action="store_true")
    code.add_argument("--no-tools", action="store_true")
    parse = sub.add_parser("parse")
    parse.add_argument("text")
    sub.add_parser("version")
    sub.add_parser("table")
    args = parser.parse_args(argv)

    if args.cmd == "serve":
        capable = False
        try:
            status, text = http_json("POST", args.engine_url.rstrip("/") + "/api/show", body={"model": args.model}, timeout=15)
            capable = status == 200 and capabilities_of(json.loads(text))["thinking"]
        except Exception:
            pass
        state = ServerState(args.key, args.model, args.engine_url, args.ctx, not args.no_vision, not args.no_tools, args.thinking, capable, args.gpu)
        server = make_server(state, args.host, args.port)
        print(json.dumps({"event": "listening", "host": args.host, "port": server.server_address[1], "hash": module_hash(),
                          "thinking_capable": capable}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0
    if args.cmd == "selftest":
        outcome = selftest(args.url, args.key, args.model, not args.no_vision, not args.no_tools, think_off=args.think_off)
        print(json.dumps(outcome, ensure_ascii=False), flush=True)
        return 0 if outcome["ok"] else 1
    if args.cmd == "run":
        try:
            step_plan(args.model, args.ctx, args.thinking, os.environ.get("HF_TOKEN", ""), args.numero, args.tipo or "automático",
                      segundos_para_escolher=0)
            step_serve_forever()
        except KeyboardInterrupt:
            say("Servidor encerrado.")
            return 0
        except StepFailed:
            return 1
        return 0
    if args.cmd == "plan":
        try:
            print(json.dumps(plan_for(args.vram, args.model, args.ctx, args.thinking, args.numero, args.tipo, args.free or None),
                             ensure_ascii=False))
        except ValueError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            return 2
        return 0
    if args.cmd == "catalog":
        listing = build_listing(usable_gib(args.vram, args.free or None))
        if args.json:
            print(json.dumps([{"numero": row["numero"], "tag": row["variant"]["tag"], "nome": row["variant"]["nome"], "grupo": row["group"],
                               "ctx": row["ctx"], "gb": row["variant"]["gb"]} for row in listing["rows"]], ensure_ascii=False))
        else:
            for line in listing_lines(listing):
                print(line)
        return 0
    if args.cmd == "code":
        print(make_connection_code({"nb": NOTEBOOK_VERSION, "u": args.url, "k": args.key, "m": args.model, "g": args.gpu,
                                    "vi": 0 if args.no_vision else 1, "tl": 0 if args.no_tools else 1, "c": args.ctx or None,
                                    "t": int(time.time()), "sh": module_hash()}))
        return 0
    if args.cmd == "parse":
        try:
            print(json.dumps(parse_connection_code(args.text), ensure_ascii=False))
            return 0
        except ValueError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            return 2
    if args.cmd == "version":
        print(json.dumps({"notebook": NOTEBOOK_VERSION, "hash": module_hash(), "code_prefix": CODE_PREFIX, "ollama": OLLAMA_VERSION,
                          "cloudflared": CLOUDFLARED_VERSION}))
        return 0
    if args.cmd == "table":
        print(json.dumps(table_rows(), ensure_ascii=False))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
