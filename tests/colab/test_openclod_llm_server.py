"""Testes do servidor do notebook do Colab (resources/colab/openclod_llm_server.py).

Rodam com a biblioteca padrão: `python -I tests/colab/test_openclod_llm_server.py`. O vitest chama este arquivo
(tests/colab-server-python.test.ts). O motor (Ollama) é substituído por um servidor falso programável; a prova com um
modelo real fica no E2E (scripts/ui-colab.cjs) e no autoteste local descrito em docs/COLAB.md.
"""
import base64
import http.client
import http.server
import json
import os
import pathlib
import re
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import zlib
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # no resources/colab/__pycache__ beside the module that ships with the app
sys.path.insert(0, os.path.join(HERE, "..", "..", "resources", "colab"))
import openclod_llm_server as oc  # noqa: E402


# ---------------------------------------------------------------------------------------------------------------------
# Motor falso
# ---------------------------------------------------------------------------------------------------------------------

def png_first_pixel(data_url):
    raw = base64.b64decode(data_url.split(",", 1)[1])
    pos = 8
    idat = b""
    while pos < len(raw):
        length = struct.unpack(">I", raw[pos:pos + 4])[0]
        kind = raw[pos + 4:pos + 8]
        if kind == b"IDAT":
            idat += raw[pos + 8:pos + 8 + length]
        pos += 12 + length
    pixels = zlib.decompress(idat)
    return tuple(pixels[1:4])


COLOR_NAMES = {(220, 30, 30): "Vermelho", (30, 170, 60): "verde", (30, 60, 220): "azul", (240, 210, 30): "amarelo"}


ENGINE_PATHS = ("/v1/chat/completions", "/v1/messages", "/v1/responses")


class FakeEngine(object):
    """Faz o papel do Ollama: /api/version, /api/show e as três rotas de geração, com comportamentos programáveis."""

    def __init__(self):
        self.header_delay = 0.0          # espera antes de responder (cabeçalhos)
        self.chunk_delay = 0.0           # espera entre os pedaços do stream
        self.fail_status = 0             # responde esse erro em vez da geração
        self.fail_message = "falhou"
        self.mode = "normal"             # normal | notool (não chama ferramenta) | blind (não reconhece imagem)
        self.seen = []                   # corpos recebidos (JSON)
        self.paths = []                  # o caminho de cada corpo de `seen`
        self.closed_early = threading.Event()
        self.thinking = True
        engine = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _json(self, status, obj):
                data = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/api/version":
                    self._json(200, {"version": "0.0-fake"})
                else:
                    self._json(404, {"error": "no"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode() or "{}")
                if self.path == "/api/show":
                    caps = ["completion", "vision", "tools"] + (["thinking"] if engine.thinking else [])
                    self._json(200, {"capabilities": caps})
                    return
                if self.path not in ENGINE_PATHS:
                    self._json(404, {"error": "no"})
                    return
                engine.seen.append(body)
                engine.paths.append(self.path)
                time.sleep(engine.header_delay)
                if engine.fail_status:
                    if self.path == "/v1/messages":   # o Ollama erra no formato da Anthropic nesta rota
                        self._json(engine.fail_status, {"type": "error", "error": {"type": "invalid_request_error", "message": engine.fail_message}})
                    else:
                        self._json(engine.fail_status, {"error": {"message": engine.fail_message, "type": "invalid_request_error"}})
                    return
                self._answer(self.path, body)

            def _sse(self, frames):
                """frames: lista de (nome_do_evento_ou_None, dado). Chat usa só `data:`; Anthropic e Responses usam `event:` + `data:`."""
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for name, frame in frames:
                        text = frame if isinstance(frame, str) else json.dumps(frame)
                        data = (("event: %s\n" % name if name else "") + "data: %s\n\n" % text).encode()
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                        self.wfile.flush()
                        time.sleep(engine.chunk_delay)
                    self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    engine.closed_early.set()

            def _answer(self, path, body):
                last, image = self._last_user(path, body)
                stream = bool(body.get("stream"))
                text = "pong"
                tool_call = None
                if image:
                    text = "não sei" if engine.mode == "blind" else COLOR_NAMES.get(png_first_pixel(image), "cinza")
                elif "ferramenta" in last and body.get("tools") and engine.mode != "notool":
                    tool_call = ("somar_numeros", '{"a":17,"b":25}')
                elif "Conte de 1 a 12" in last:
                    text = "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12"
                words = text.split(" ")
                pieces = [word + (" " if index < len(words) - 1 else "") for index, word in enumerate(words)]
                if path == "/v1/chat/completions":
                    self._chat(body, stream, text, pieces, tool_call)
                elif path == "/v1/messages":
                    self._messages(body, stream, text, pieces, tool_call)
                else:
                    self._responses(body, stream, text, pieces)

            def _last_user(self, path, body):
                """(texto da última mensagem do usuário, imagem em data: URL ou None) nas três formas de entrada."""
                if path == "/v1/responses":
                    value = body.get("input")
                    if isinstance(value, list) and value and isinstance(value[-1], dict):
                        value = value[-1].get("content")
                else:
                    messages = body.get("messages") or []
                    value = messages[-1].get("content") if messages else ""
                if isinstance(value, list):
                    image = next((p["image_url"]["url"] for p in value if isinstance(p, dict) and p.get("type") == "image_url"), None)
                    return " ".join(str(p.get("text", "")) for p in value if isinstance(p, dict)), image
                return str(value or ""), None

            def _chat(self, body, stream, text, pieces, tool_call):
                if not stream:
                    self._json(200, {"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 7, "completion_tokens": 3}})
                    return
                frames = []
                if tool_call:
                    frames.append((None, {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": tool_call[0], "arguments": ""}}]}}]}))
                    for piece in (tool_call[1][:6], tool_call[1][6:]):
                        frames.append((None, {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": piece}}]}}]}))
                    frames.append((None, {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}))
                else:
                    frames += [(None, {"choices": [{"delta": {"content": piece}}]}) for piece in pieces]
                    frames.append((None, {"choices": [{"delta": {}, "finish_reason": "stop"}]}))
                frames.append((None, {"choices": [], "usage": {"prompt_tokens": 21, "completion_tokens": 9}}))
                frames.append((None, "[DONE]"))
                self._sse(frames)

            def _messages(self, body, stream, text, pieces, tool_call):
                message = {"id": "msg_1", "type": "message", "role": "assistant", "model": body.get("model"), "content": []}
                if not stream:
                    if tool_call:
                        message["content"] = [{"type": "tool_use", "id": "toolu_1", "name": tool_call[0], "input": json.loads(tool_call[1])}]
                    else:
                        message["content"] = [{"type": "text", "text": text}]
                    message.update({"stop_reason": "tool_use" if tool_call else "end_turn", "usage": {"input_tokens": 7, "output_tokens": 3}})
                    self._json(200, message)
                    return
                frames = [("message_start", {"type": "message_start", "message": dict(message, usage={"input_tokens": 5, "output_tokens": 0})})]
                if tool_call:
                    frames.append(("content_block_start", {"type": "content_block_start", "index": 0,
                                                           "content_block": {"type": "tool_use", "id": "toolu_1", "name": tool_call[0], "input": {}}}))
                    for piece in (tool_call[1][:6], tool_call[1][6:]):
                        frames.append(("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                               "delta": {"type": "input_json_delta", "partial_json": piece}}))
                else:
                    frames.append(("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
                    for piece in pieces:
                        frames.append(("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": piece}}))
                frames.append(("content_block_stop", {"type": "content_block_stop", "index": 0}))
                frames.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool_call else "end_turn"},
                                                 "usage": {"input_tokens": 21, "output_tokens": 9}}))
                frames.append(("message_stop", {"type": "message_stop"}))
                self._sse(frames)

            def _responses(self, body, stream, text, pieces):
                response = {"id": "resp_1", "object": "response", "status": "completed", "model": body.get("model"),
                            "output": [{"id": "msg_1", "type": "message", "role": "assistant",
                                        "content": [{"type": "output_text", "text": text, "annotations": []}]}],
                            "usage": {"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}}
                if not stream:
                    self._json(200, response)
                    return
                frames = [("response.created", {"type": "response.created", "sequence_number": 0, "response": dict(response, status="in_progress", output=[], usage=None)})]
                for index, piece in enumerate(pieces):
                    frames.append(("response.output_text.delta", {"type": "response.output_text.delta", "sequence_number": index + 1, "output_index": 0,
                                                                  "content_index": 0, "delta": piece}))
                response["usage"] = {"input_tokens": 21, "output_tokens": 9, "total_tokens": 30}
                frames.append(("response.completed", {"type": "response.completed", "sequence_number": len(pieces) + 1, "response": response}))
                self._sse(frames)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.handle_error = lambda *args: None  # o proxy fecha a conexão de propósito (cancelamento)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def close(self):
        self.server.shutdown()
        self.server.server_close()


KEY = "occ_TESTE_chave_secreta_123"


def start_proxy(engine, **kwargs):
    options = dict(key=KEY, model="modelo-teste:9b", engine_url=engine.url, ctx=65536, vision=True, tools=True,
                   thinking_default="off", thinking_capable=True, gpu="Tesla T4 (15 GB)")
    options.update(kwargs)
    state = oc.ServerState(**options)
    server = oc.make_server(state, "127.0.0.1", 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return state, server


def request(port, method, path, body=None, headers=None, raw=None, timeout=20):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    all_headers = dict(headers or {})
    if data is not None:
        all_headers.setdefault("Content-Type", "application/json")
    conn.request(method, path, body=data, headers=all_headers)
    response = conn.getresponse()
    return conn, response


def auth(extra=None):
    headers = {"Authorization": "Bearer " + KEY}
    headers.update(extra or {})
    return headers


class ProxyTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.state, self.server = start_proxy(self.engine)
        self.port = self.server.server_address[1]
        self._saved = (oc.EARLY_FLUSH_SECONDS, oc.PING_SECONDS, oc.MAX_BODY_BYTES)

    def tearDown(self):
        oc.EARLY_FLUSH_SECONDS, oc.PING_SECONDS, oc.MAX_BODY_BYTES = self._saved
        self.server.shutdown()
        self.server.server_close()
        self.engine.close()


# ---------------------------------------------------------------------------------------------------------------------
# Código de conexão
# ---------------------------------------------------------------------------------------------------------------------

class ConnectionCodeTests(unittest.TestCase):
    INFO = {"nb": "1.0.0", "u": "https://um-dois-tres.trycloudflare.com/v1", "k": "occ_abc123", "m": "qwen3.5:9b-q8_0",
            "g": "Tesla T4 (15 GB)", "vm": 15360, "vi": 1, "tl": 1, "c": 65536, "e": "ollama 0.40.11", "t": 1793000000, "sh": "abcdef012345"}

    def test_round_trip(self):
        code = oc.make_connection_code(self.INFO)
        self.assertTrue(code.startswith("OCLC1."))
        parsed = oc.parse_connection_code(code)
        for key, value in self.INFO.items():
            self.assertEqual(parsed[key], value)
        self.assertEqual(parsed["v"], 1)

    def test_is_short_enough_to_copy(self):
        self.assertLess(len(oc.make_connection_code(self.INFO)), 420)

    def test_tolerates_spaces_line_breaks_and_text_around(self):
        code = oc.make_connection_code(self.INFO)
        wrapped = "\n".join(code[i:i + 50] for i in range(0, len(code), 50))
        for pasted in ("  " + code + "  ", wrapped, "Código de conexão: " + code + " (copie tudo)", "﻿" + code + "​"):
            self.assertEqual(oc.parse_connection_code(pasted)["m"], "qwen3.5:9b-q8_0")

    def test_detects_tampering_and_truncation(self):
        code = oc.make_connection_code(self.INFO)
        head, payload, check = code.split(".")
        swapped = payload[:10] + ("A" if payload[10] != "A" else "B") + payload[11:]
        for broken in ("%s.%s.%s" % (head, swapped, check), code[:-3], "%s.%s.%s" % (head, payload, "0" * 8)):
            with self.assertRaises(ValueError):
                oc.parse_connection_code(broken)

    def test_rejects_other_text_and_other_versions(self):
        for text in ("", "olá mundo", "OCLC1.", "OCLC2.abc.12345678"):
            with self.assertRaises(ValueError):
                oc.parse_connection_code(text)
        payload = oc.b64url_encode(json.dumps({"v": 2, "u": "x", "k": "y", "m": "z"}).encode())
        with self.assertRaises(ValueError) as caught:
            oc.parse_connection_code("OCLC1.%s.%s" % (payload, oc.code_check(payload)))
        self.assertIn("Versão", str(caught.exception))

    def test_requires_url_key_and_model(self):
        for missing in ("u", "k", "m"):
            info = dict(self.INFO)
            del info[missing]
            with self.assertRaises(ValueError):
                oc.make_connection_code(info)

    def test_unicode_in_gpu_name(self):
        info = dict(self.INFO, g="NVIDIA RTX PRO 6000 Blackwell · 95,6 GB")
        self.assertEqual(oc.parse_connection_code(oc.make_connection_code(info))["g"], info["g"])


# ---------------------------------------------------------------------------------------------------------------------
# GPU e tabela de modelos
# ---------------------------------------------------------------------------------------------------------------------

class GpuAndPlanTests(unittest.TestCase):
    def test_parse_nvidia_smi(self):
        gpu = oc.parse_nvidia_smi("Tesla T4, 15360, 15101, 535.104.05, 7.5\n")
        self.assertEqual((gpu["name"], gpu["total_mib"], gpu["free_mib"], gpu["driver"], gpu["cc"]), ("Tesla T4", 15360, 15101, "535.104.05", "7.5"))
        self.assertEqual(oc.parse_nvidia_smi("NVIDIA L4, 23034, 22800, 550.54.15")["total_mib"], 23034)
        self.assertEqual(oc.parse_nvidia_smi("NVIDIA A100-SXM4-40GB, 40960, 40500, 535.1, 8.0")["name"], "NVIDIA A100-SXM4-40GB")
        self.assertIsNone(oc.parse_nvidia_smi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."))
        self.assertIsNone(oc.parse_nvidia_smi(""))

    def test_each_real_gpu_gets_a_tier(self):
        expected = {15360: "16", 23034: "24", 40960: "40", 40536: "40", 81920: "80", 81559: "80", 97887: "96", 6144: "min", 8192: "8", 12288: "12"}
        for vram, tier in expected.items():
            self.assertEqual(oc.plan_for(vram)["tier"], tier, vram)

    def test_every_candidate_has_enough_context_and_a_known_family(self):
        for tier in oc.TIERS:
            for item in tier.candidates:
                self.assertGreaterEqual(item.ctx, 32768, tier.key)
                self.assertRegex(item.tag, r"^qwen3\.[58]:")
            self.assertTrue(tier.sources and all(url.startswith("https://") for url in tier.sources))

    def test_tiers_are_sorted_from_largest_to_smallest(self):
        minimums = [tier.min_mib for tier in oc.TIERS]
        self.assertEqual(minimums, sorted(minimums, reverse=True))

    def test_weights_plus_kv_fit_the_real_gpu_of_each_tier(self):
        # 3.8-27B guarda 64 KiB de KV por token em f16 (q8_0: ~34 KiB); 3.5-9B/4B guardam 32 KiB. Folga de 2 GiB para os buffers.
        per_token = {"qwen3.8": 64 * 1024, "qwen3.5:9b": 32 * 1024, "qwen3.5:4b": 32 * 1024, "qwen3.5:2b": 32 * 1024}
        real_gpu_mib = {"96": 97887, "80": 81559, "40": 40536, "24": 23034, "16": 15360, "12": 12288, "8": 8192}
        for tier in oc.TIERS:
            if tier.key not in real_gpu_mib:
                continue
            first = tier.candidates[0]
            kv = next(v for k, v in per_token.items() if first.tag.startswith(k)) * first.ctx * first.parallel
            if first.kv == "q8_0":
                kv = kv * 17 // 32
            need_gib = first.weights_gb * 1e9 / 2 ** 30 + kv / 2 ** 30 + 2.0
            gpu_gib = real_gpu_mib[tier.key] / 1024.0
            self.assertLessEqual(need_gib, gpu_gib, "%s: %.1f GiB numa GPU de %.1f GiB" % (tier.key, need_gib, gpu_gib))
            self.assertEqual(oc.tier_for(real_gpu_mib[tier.key]).key, tier.key)

    def test_manual_model_context_and_thinking(self):
        plan = oc.plan_for(15360, "qwen3.5:4b", 32768, "ligado")
        self.assertEqual([c["tag"] for c in plan["candidates"]], ["qwen3.5:4b"])
        self.assertEqual(plan["candidates"][0]["ctx"], 32768)
        self.assertEqual(plan["candidates"][0]["thinking"], "auto")
        self.assertIn("você", plan["why"])
        self.assertEqual(oc.plan_for(15360, thinking="desligado")["candidates"][0]["thinking"], "off")
        self.assertEqual(oc.plan_for(81920, thinking="padrão")["candidates"][0]["thinking"], "auto")
        self.assertEqual(oc.plan_for(81920, thinking="DESLIGADO")["candidates"][0]["thinking"], "off")

    def test_table_rows_cover_every_tier(self):
        self.assertEqual(len(oc.table_rows()), len(oc.TIERS))


# ---------------------------------------------------------------------------------------------------------------------
# Catálogo de modelos que cabem na GPU
# ---------------------------------------------------------------------------------------------------------------------

class FakeResponse(object):
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class CatalogTests(unittest.TestCase):
    GPUS = (6144, 8192, 12288, 15360, 23034, 40960, 81920, 97887)

    def test_every_row_is_well_formed_and_unique(self):
        seen = set()
        for row in oc.CATALOG:
            self.assertEqual(len(row), len(oc.CATALOG_FIELDS), row)
            data = dict(zip(oc.CATALOG_FIELDS, row))
            self.assertNotIn(data["tag"], seen)
            seen.add(data["tag"])
            self.assertRegex(data["tag"], r"^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$")
            self.assertTrue(data["nome"].strip() and data["quant"], row)
            self.assertTrue(0.05 < data["gb"] < 95, row)
            self.assertGreater(data["kv_kib"], 0, row)
            self.assertGreaterEqual(data["kv_fixo_mib"], 0, row)
            self.assertGreaterEqual(data["ctx_max"], 2048, row)
            self.assertTrue(set(data["caps"]) <= set("vtkam"), row)
            self.assertTrue(set(data["marcas"]) <= set("ucr"), row)
        self.assertGreaterEqual(len(oc.CATALOG), 200)

    def test_the_catalog_has_every_kind_and_uncensored_models_are_marked_as_such(self):
        variants = oc.catalog_variants()
        self.assertTrue(any(v["vision"] and v["tools"] for v in variants))
        self.assertTrue(any(v["tools"] and not v["vision"] for v in variants))
        self.assertTrue(any(v["code"] for v in variants))
        self.assertTrue(any(v["reasoning"] for v in variants))
        self.assertTrue(any(not v["tools"] and not v["vision"] for v in variants))
        self.assertTrue(any(v["uncensored"] for v in variants))
        for v in variants:
            says_so = re.search(r"abliterat|uncensor|dolphin|wizard", v["tag"].lower()) is not None
            if v["uncensored"]:
                self.assertTrue(says_so, v["tag"])
            if re.search(r"abliterat|uncensor", v["tag"].lower()):
                self.assertTrue(v["uncensored"], v["tag"])

    def test_the_tiers_use_models_that_are_in_the_catalog_with_the_same_size(self):
        # One source for the numbers: the tier table and the catalog must agree on every model the notebook runs by default.
        for tier in oc.TIERS:
            for item in tier.candidates:
                variant = oc.catalog_variant(item.tag)
                self.assertIsNotNone(variant, item.tag)
                self.assertTrue(variant["vision"] and variant["tools"], item.tag)
                self.assertAlmostEqual(variant["gb"] / item.weights_gb, 1.0, delta=0.12, msg=item.tag)

    def test_catalog_variant_resolves_the_two_spellings_of_the_same_file(self):
        self.assertEqual(oc.catalog_variant("qwen3.5:9b-q4_K_M")["tag"], "qwen3.5:9b")
        self.assertEqual(oc.catalog_variant("qwen3.5:9b-q8_0")["quant"], "Q8_0")
        self.assertIsNone(oc.catalog_variant("qwen3.5:9b-q8_0-inexistente"))
        self.assertIsNone(oc.catalog_variant("hf.co/usuario/repo:Q4_K_M"))

    def test_fit_math(self):
        nine = oc.catalog_variant("qwen3.5:9b-q8_0")
        self.assertEqual(oc.best_context(nine, oc.usable_gib(15360, 14913)), 65536)
        self.assertEqual(oc.best_context(nine, 8.0), 0)  # o arquivo sozinho já passa de 8 GiB
        # 65536 tokens de 32 KiB = 2 GiB de cache; mais os pesos (10,45 GB) e a folga de 2 GiB
        self.assertAlmostEqual(oc.need_gib(nine, 65536), 10.45e9 / 2 ** 30 + 2.0 + 2.0, places=2)
        self.assertLess(oc.need_gib(nine, 65536, "q8_0"), oc.need_gib(nine, 65536, "f16"))
        self.assertAlmostEqual(oc.need_gib(nine, 32768, parallel=2) - oc.need_gib(nine, 32768), 1.0, places=2)
        # camadas de janela deslizante guardam uma parte do cache que não cresce com o contexto
        gemma = oc.catalog_variant("gemma4:12b")
        self.assertGreater(gemma["kv_fixo_mib"], 0)
        self.assertGreater(oc.need_gib(gemma, 8192), gemma["gb"] * 1e9 / 2 ** 30 + 2.0)
        # modelo de contexto curto: o contexto máximo dele é o único degrau
        short = oc.catalog_variant("llama2-uncensored:7b")
        self.assertEqual(oc.best_context(short, 20.0), short["ctx_max"])

    def test_usable_memory(self):
        self.assertAlmostEqual(oc.usable_gib(15360, 14913), 14913 / 1024.0)
        self.assertAlmostEqual(oc.usable_gib(15360), (15360 - 450) / 1024.0)

    def test_every_listed_model_fits_at_the_biggest_context_and_the_numbering_is_contiguous(self):
        for vram in self.GPUS:
            usable = oc.usable_gib(vram)
            listing = oc.build_listing(usable)
            numbers = [row["numero"] for row in listing["rows"]]
            self.assertEqual(numbers, list(range(1, len(numbers) + 1)), vram)
            for row in listing["rows"]:
                variant, ctx = row["variant"], row["ctx"]
                self.assertLessEqual(oc.need_gib(variant, ctx), usable + 1e-9, (vram, variant["tag"]))
                bigger = [c for c in oc._contexts(variant) if c > ctx]
                self.assertTrue(all(oc.need_gib(variant, c) > usable for c in bigger), (vram, variant["tag"]))
            for row in listing["near"]:
                self.assertGreater(row["need_gib"], usable, (vram, row["variant"]["tag"]))
            self.assertEqual(listing["total"], len(listing["rows"]) + len(listing["near"]))

    def test_a_bigger_gpu_never_lists_fewer_models(self):
        counts = [len(oc.build_listing(oc.usable_gib(vram))["rows"]) for vram in self.GPUS]
        self.assertEqual(counts, sorted(counts))
        self.assertGreater(counts[-1], counts[0])
        self.assertGreater(counts[0], 5)  # even 6 GB gets a real list

    def test_the_list_is_grouped_by_kind_uncensored_ones_in_their_own_group(self):
        # first the original models, then the uncensored ones; inside each part one block per combination of capabilities
        # (vision, tools, thinking), from the most complete agent to "only chat"
        listing = oc.build_listing(oc.usable_gib(15360, 14913))
        order = [key for key, _title in oc.LIST_GROUPS]
        positions = [order.index(row["group"]) for row in listing["rows"]]
        self.assertEqual(positions, sorted(positions))
        groups = set(row["group"] for row in listing["rows"])
        self.assertTrue({"originais/vfp", "originais/vf", "originais/fp", "originais/f"} <= groups, groups)
        self.assertTrue(any(group.startswith("sem-censura/") for group in groups), groups)
        for row in listing["rows"]:
            variant = row["variant"]
            self.assertEqual(row["group"].startswith("sem-censura/"), variant["uncensored"], variant["tag"])
            self.assertEqual(row["group"].split("/")[1], oc._tier_of(variant), variant["tag"])
        self.assertEqual(oc._badges({"vision": True, "tools": False, "thinking": True}), "[V - P]")
        # inside a group the models that work as an agent (32k of context or more) come before the short-context ones
        for key in order:
            group = [row["ctx"] >= oc.AGENT_MIN_CTX for row in listing["rows"] if row["group"] == key]
            self.assertEqual(group, sorted(group, reverse=True), key)

    def test_the_automatic_choice_never_lacks_tools_or_agent_context(self):
        for vram in self.GPUS:
            plan = oc.plan_for(vram)
            for item in plan["candidates"]:
                variant = oc.catalog_variant(item["tag"])
                self.assertTrue(variant and variant["tools"], item["tag"])
                self.assertGreaterEqual(item["ctx"], oc.AGENT_MIN_CTX, item["tag"])
                self.assertFalse(item["explicit"])

    def test_choosing_by_number_keeps_the_same_model_and_never_swaps_it(self):
        plan = oc.plan_for(15360, numero=1, free_mib=14913)
        self.assertEqual(len(set(item["tag"] for item in plan["candidates"])), 1)
        self.assertTrue(all(item["explicit"] for item in plan["candidates"]))
        contexts = [item["ctx"] for item in plan["candidates"]]
        self.assertEqual(contexts, sorted(contexts, reverse=True))
        self.assertIn("n.º 1", plan["why"])
        self.assertTrue(plan["sources"][0].startswith("https://ollama.com/"))
        with self.assertRaises(ValueError) as caught:
            oc.plan_for(15360, numero=9999, free_mib=14913)
        self.assertIn("não está na lista", str(caught.exception))

    def test_a_manual_model_that_is_in_the_catalog_gets_its_context_and_size(self):
        item = oc.plan_for(15360, "qwen3.5:4b-q8_0", free_mib=14913)["candidates"][0]
        self.assertEqual((item["tag"], item["explicit"], item["ctx"]), ("qwen3.5:4b-q8_0", True, 131072))
        self.assertAlmostEqual(item["weights_gb"], 5.16, delta=0.1)
        unknown = oc.plan_for(15360, "hf.co/usuario/repo:Q4_K_M")["candidates"][0]
        self.assertEqual((unknown["explicit"], unknown["weights_gb"]), (True, 0.0))
        self.assertEqual(oc.plan_for(15360, "qwen3.5:4b-q8_0", 32768, free_mib=14913)["candidates"][0]["ctx"], 32768)

    def test_choosing_by_kind(self):
        kinds = (("sem censura", lambda v: v["uncensored"]), ("código", lambda v: v["code"] and not v["uncensored"]),
                 ("raciocínio", lambda v: v["reasoning"] and not v["uncensored"]), ("CODIGO", lambda v: v["code"] and not v["uncensored"]))
        for tipo, of_kind in kinds:
            plan = oc.plan_for(15360, tipo=tipo, free_mib=14913)
            first = oc.catalog_variant(plan["candidates"][0]["tag"])
            self.assertTrue(of_kind(first), tipo)
            self.assertTrue(first["tools"], tipo)  # with tools when the kind has any that fit
            self.assertFalse(plan["candidates"][0]["explicit"])  # the next options may take over if this one does not load 100% on the GPU
            self.assertGreater(len(set(item["tag"] for item in plan["candidates"])), 1)
        light = oc.catalog_variant(oc.plan_for(15360, tipo="leve e rápido", free_mib=14913)["candidates"][0]["tag"])
        self.assertLessEqual(light["gb"], oc.LIGHT_MAX_GB)
        self.assertFalse(light["uncensored"])
        self.assertEqual(oc.plan_for(15360, tipo="automático")["candidates"], oc.plan_for(15360)["candidates"])
        with self.assertRaises(ValueError) as unknown:
            oc.plan_for(15360, tipo="mágico")
        self.assertIn("Tipo de modelo desconhecido", str(unknown.exception))
        with self.assertRaises(ValueError) as nothing:
            oc.plan_for(1024, tipo="sem censura")
        self.assertIn("Nenhum modelo do tipo", str(nothing.exception))

    def test_a_kind_without_tools_still_works_and_the_candidate_says_so(self):
        rows = [row for row in oc.build_listing(oc.usable_gib(15360, 14913))["rows"] if not row["variant"]["tools"]]
        self.assertTrue(rows)
        candidates = oc._row_candidates(rows[0], 0, "off", False)
        self.assertTrue(all(item.no_tools_ok and not item.explicit for item in candidates))

    def test_params_b_reads_the_size_from_the_name(self):
        def size(name, moe=False):
            return oc.params_b({"nome": name, "moe": moe})
        self.assertEqual(size("Qwen3.5 9B"), 9.0)
        self.assertEqual(size("Gemma 4 E4B"), 4.0)
        self.assertAlmostEqual(size("Gemma 3 270M"), 0.27)
        self.assertAlmostEqual(size("Qwen3 abliterated 30B", moe=True), 10.5)
        self.assertEqual(size("Dolphin Mixtral 8x7B"), 56.0)
        self.assertEqual(size("Sem tamanho"), 0.0)

    def test_the_list_text_marks_the_running_model_the_short_context_and_the_missing_tags(self):
        listing = oc.build_listing(oc.usable_gib(15360, 14913))
        short = next(row for row in listing["rows"] if row["ctx"] < oc.AGENT_MIN_CTX)
        chosen = listing["rows"][0]["variant"]["tag"]
        text = "\n".join(oc.listing_lines(listing, chosen, {short["variant"]["tag"]}))
        self.assertIn("<== rodando esta", text)
        self.assertIn("contexto curto: só conversa", text)
        self.assertIn("[não está mais no registro do Ollama]", text)
        self.assertIn("Sem censura (uncensored / abliterated)", text)
        self.assertIn("Não cabem nesta GPU", text)
        self.assertIn("%3d. " % listing["rows"][-1]["numero"], text)

    def test_registry_lookup_reads_the_weights_and_tells_a_missing_tag_from_a_failure(self):
        seen = []

        def manifest(layers):
            def opener(request, timeout=None):
                seen.append((request.full_url, request.get_header("Accept"), timeout))
                return FakeResponse({"layers": layers})
            return opener

        layers = [{"mediaType": "application/vnd.ollama.image.model", "size": 5_600_000_000},
                  {"mediaType": "application/vnd.ollama.image.projector", "size": 900_000_000},
                  {"mediaType": "application/vnd.ollama.image.template", "size": 13}]
        self.assertEqual(oc.registry_lookup("qwen3.5:9b", opener=manifest(layers)), ("ok", 6.5))
        self.assertEqual(oc.registry_lookup("huihui_ai/qwen3.5-abliterated:9b", opener=manifest(layers))[0], "ok")
        self.assertEqual(seen[0][0], "https://registry.ollama.ai/v2/library/qwen3.5/manifests/9b")
        self.assertEqual(seen[1][0], "https://registry.ollama.ai/v2/huihui_ai/qwen3.5-abliterated/manifests/9b")
        self.assertIn("manifest.v2+json", seen[0][1])

        def missing(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)

        def broken(request, timeout=None):
            raise urllib.error.URLError("sem rede")

        def server_error(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 503, "Unavailable", {}, None)
        self.assertEqual(oc.registry_lookup("x:y", opener=missing), ("ausente", 0.0))
        self.assertEqual(oc.registry_lookup("x:y", opener=broken), ("?", 0.0))
        self.assertEqual(oc.registry_lookup("x:y", opener=server_error), ("?", 0.0))
        self.assertEqual(oc.registry_lookup("x:y", opener=manifest([{"mediaType": "application/vnd.ollama.image.template", "size": 1}])), ("?", 0.0))

    def test_verify_registry_survives_failures_and_slow_answers(self):
        rows = [{"variant": {"tag": tag}} for tag in ("a:1", "b:2", "c:3", "d:4")]

        def lookup(tag):
            if tag == "b:2":
                return ("ausente", 0.0)
            if tag == "c:3":
                raise RuntimeError("quebrou")
            if tag == "d:4":
                time.sleep(2.0)
            return ("ok", 1.5)
        started = time.time()
        results = oc.verify_registry(rows, lookup=lookup, workers=4, budget=0.5)
        self.assertLess(time.time() - started, 1.5)  # does not wait for the slow one
        self.assertEqual(results["a:1"], ("ok", 1.5))
        self.assertEqual(results["b:2"], ("ausente", 0.0))
        self.assertEqual(results["c:3"], ("?", 0.0))
        self.assertEqual(results["d:4"], ("?", 0.0))


class StepModelPolicyTests(unittest.TestCase):
    """step_model with the engine replaced: what it does with a model the user asked for and with one the notebook chose."""

    CAPS_TOOLS = {"vision": True, "tools": True, "thinking": False}
    CAPS_TEXT = {"vision": False, "tools": False, "thinking": False}

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="openclod-policy-")
        self.saved = (oc.SESSION, oc.WORK_DIR)
        oc.SESSION = oc.Session()
        oc.SESSION.ollama_bin = "ollama"
        oc.WORK_DIR = self.dir
        self.lines = []

    def tearDown(self):
        oc.SESSION, oc.WORK_DIR = self.saved
        shutil.rmtree(self.dir, ignore_errors=True)

    def candidate(self, tag, ctx=32768, explicit=False, no_tools_ok=False):
        return oc.Candidate(tag, ctx, "f16", 1, "off", 1.0, explicit, no_tools_ok).to_dict()

    def run_step(self, candidates, loads, unavailable=()):
        oc.SESSION.plan = {"candidates": candidates}
        oc.SESSION.unavailable = set(unavailable)
        with mock.patch.object(oc, "_start_engine"), mock.patch.object(oc, "_pull"), mock.patch.object(oc, "detect_gpu", return_value=None), \
                mock.patch.object(oc, "_load_and_check", side_effect=lambda cand: loads[(cand["tag"], cand["ctx"])]), \
                mock.patch.object(oc, "say", side_effect=self.lines.append):
            return oc.step_model()

    def text(self):
        return "\n".join(self.lines)

    def test_a_chosen_model_without_tools_runs_with_a_warning(self):
        chosen = self.run_step([self.candidate("dolphin3:8b", explicit=True)], {("dolphin3:8b", 32768): (True, 100, 32768, self.CAPS_TEXT)})
        self.assertEqual(chosen["tag"], "dolphin3:8b")
        self.assertIn("não poderão usá-lo como agente", self.text())
        self.assertIn("foi você quem o escolheu", self.text())

    def test_a_model_the_catalog_already_knows_has_no_tools_runs_with_a_warning_too(self):
        chosen = self.run_step([self.candidate("dolphin3:8b", no_tools_ok=True)], {("dolphin3:8b", 32768): (True, 100, 32768, self.CAPS_TEXT)})
        self.assertEqual(chosen["tag"], "dolphin3:8b")

    def test_an_automatic_candidate_without_tools_is_skipped_for_the_next_one(self):
        chosen = self.run_step([self.candidate("a:1"), self.candidate("b:2")],
                               {("a:1", 32768): (True, 100, 32768, self.CAPS_TEXT), ("b:2", 32768): (True, 100, 32768, self.CAPS_TOOLS)})
        self.assertEqual(chosen["tag"], "b:2")
        self.assertIn("tentando a próxima opção", self.text())

    def test_a_chosen_model_that_does_not_fit_is_never_swapped_for_another(self):
        with self.assertRaises(oc.StepFailed):
            self.run_step([self.candidate("big:1", explicit=True), self.candidate("other:2", explicit=True)],
                          {("big:1", 32768): (False, 60, 32768, self.CAPS_TOOLS), ("other:2", 32768): (True, 100, 32768, self.CAPS_TOOLS)})
        self.assertIn("não coube 100% na GPU deste ambiente", self.text())
        self.assertNotIn("Modelo no ar", self.text())

    def test_a_chosen_model_may_fall_back_to_a_smaller_context_of_the_same_model(self):
        chosen = self.run_step([self.candidate("big:1", 65536, explicit=True), self.candidate("big:1", 32768, explicit=True)],
                               {("big:1", 65536): (False, 70, 65536, self.CAPS_TOOLS), ("big:1", 32768): (True, 100, 32768, self.CAPS_TOOLS)})
        self.assertEqual((chosen["tag"], chosen["ctx"]), ("big:1", 32768))

    def test_an_automatic_candidate_that_does_not_fit_gives_way_to_the_next_option(self):
        chosen = self.run_step([self.candidate("big:1"), self.candidate("small:2")],
                               {("big:1", 32768): (False, 60, 32768, self.CAPS_TOOLS), ("small:2", 32768): (True, 100, 32768, self.CAPS_TOOLS)})
        self.assertEqual(chosen["tag"], "small:2")

    def test_a_tag_the_registry_does_not_have(self):
        with self.assertRaises(oc.StepFailed):
            self.run_step([self.candidate("gone:1", explicit=True)], {}, unavailable={"gone:1"})
        self.assertIn("não existe no registro do Ollama", self.text())
        self.lines[:] = []
        chosen = self.run_step([self.candidate("gone:1"), self.candidate("here:2")], {("here:2", 32768): (True, 100, 32768, self.CAPS_TOOLS)}, unavailable={"gone:1"})
        self.assertEqual(chosen["tag"], "here:2")
        self.assertIn("pulando esta opção", self.text())


class ChoiceBoxTests(unittest.TestCase):
    """A pausa da etapa 2: o que a caixa de escolha mostra, como a resposta é lida e o que cada desfecho faz com o plano.

    O Colab é trocado por um `eval_js` falso (a caixa de verdade é provada num navegador em tests/colab-choice.test.ts)."""

    GPU = {"name": "Tesla T4", "total_mib": 15360, "free_mib": 14913, "driver": "535.1", "cc": "7.5"}

    def setUp(self):
        self.saved = (oc.SESSION, os.environ.get("OPENCLOD_COLAB_OFFLINE"))
        oc.SESSION = oc.Session()
        oc.SESSION.gpu = dict(self.GPU)
        os.environ["OPENCLOD_COLAB_OFFLINE"] = "1"
        self.lines, self.calls, self.shown = [], [], []
        self.listing = oc.build_listing(oc.usable_gib(15360, 14913))
        self.automatic = oc.plan_for(15360, free_mib=14913)

    def tearDown(self):
        oc.SESSION = self.saved[0]
        if self.saved[1] is None:
            os.environ.pop("OPENCLOD_COLAB_OFFLINE", None)
        else:
            os.environ["OPENCLOD_COLAB_OFFLINE"] = self.saved[1]

    def fake_eval_js(self, *replies):
        """Um `eval_js` que devolve as respostas em ordem (a última se repete) e guarda o que recebeu."""
        queue = list(replies)

        def eval_js(script, ignore_result=False, timeout_sec=None):
            self.calls.append({"script": script, "ignore_result": ignore_result, "timeout_sec": timeout_sec})
            if ignore_result:
                return None
            item = queue.pop(0) if len(queue) > 1 else queue[0]
            if isinstance(item, BaseException):
                raise item
            return item
        return eval_js

    def step(self, eval_js, **kwargs):
        with mock.patch.object(oc, "colab_eval_js", return_value=eval_js), mock.patch.object(oc, "colab_show_js", side_effect=self.shown.append), \
                mock.patch.object(oc, "say", side_effect=self.lines.append):
            return oc.step_plan(**kwargs)

    def text(self):
        return "\n".join(self.lines)

    def number_of(self, nome, quant):
        return next(row["numero"] for row in self.listing["rows"] if row["variant"]["nome"] == nome and row["variant"]["quant"] == quant)

    def asked(self):
        return [call for call in self.calls if not call["ignore_result"]]

    @staticmethod
    def user(number):
        return json.dumps({"quem": "usuario", "numero": number})

    # --- o que a caixa mostra ---

    def test_the_box_lists_what_the_printed_list_lists_with_the_same_numbers_and_groups(self):
        data = oc.choice_data(self.listing, self.automatic)
        flat = [item for group in data["grupos"] for item in group["itens"]]
        self.assertEqual([item["n"] for item in flat], list(range(1, len(self.listing["rows"]) + 1)))
        titles = [title for key, title in oc.LIST_GROUPS if any(row["group"] == key for row in self.listing["rows"])]
        self.assertEqual([group["titulo"] for group in data["grupos"]], titles)
        for item, row in zip(flat, self.listing["rows"]):
            self.assertTrue(item["texto"].startswith("%d · %s · %s · " % (row["numero"], row["variant"]["nome"], row["variant"]["quant"])), item["texto"])
            self.assertIn(" GB · ctx ", item["texto"])
            self.assertIn(row["variant"]["tag"], item["detalhe"])
        self.assertIn("sem-censura", next(item["av"] for item in flat if "Dolphin 3 8B" in item["texto"]))
        self.assertTrue(set(key for item in flat for key in item["av"]) <= set(oc.CHOICE_WARNINGS))
        self.assertEqual(data["segundos"], 120)

    def test_the_automatic_option_comes_first_and_the_list_says_which_row_it_is(self):
        data = oc.choice_data(self.listing, self.automatic)
        self.assertTrue(data["automatico"]["texto"].startswith("Automático (recomendado): Qwen3.5 9B · Q8_0 · ctx 64k"), data["automatico"]["texto"])
        self.assertIn("qwen3.5:9b-q8_0", data["automatico"]["detalhe"])
        marked = [item for group in data["grupos"] for item in group["itens"] if item["texto"].endswith("é o automático")]
        self.assertEqual(len(marked), 1)
        self.assertIn("Qwen3.5 9B · Q8_0", marked[0]["texto"])
        # The tier table can spell the tag another way (12 GB runs qwen3.5:9b-q4_K_M, which the catalog keeps as qwen3.5:9b).
        listing12 = oc.build_listing(oc.usable_gib(12288, 11900))
        data12 = oc.choice_data(listing12, oc.plan_for(12288, free_mib=11900))
        self.assertEqual(sum(1 for group in data12["grupos"] for item in group["itens"] if item["texto"].endswith("é o automático")), 1)

    def test_a_model_without_tools_or_with_short_context_says_so_in_its_line_and_in_its_warning(self):
        data = oc.choice_data(self.listing, self.automatic)
        flat = [item for group in data["grupos"] for item in group["itens"]]
        without_tools = [item for item in flat if "ferramentas" in item["av"]]
        self.assertTrue(without_tools)
        for item in without_tools:
            self.assertIn("sem ferramentas: só conversa", item["texto"])
        self.assertIn("só conseguem conversar", oc.CHOICE_WARNINGS["ferramentas"])
        self.assertIn("por sua conta", oc.CHOICE_WARNINGS["sem-censura"])
        short = [row for row in self.listing["rows"] if row["variant"]["tools"] and row["ctx"] < oc.AGENT_MIN_CTX]
        for row in short:
            item = flat[row["numero"] - 1]
            self.assertIn("curto", item["av"])
            self.assertIn("contexto curto: só conversa", item["texto"])

    def test_models_the_registry_does_not_have_are_not_offered(self):
        gone = self.listing["rows"][3]["variant"]["tag"]
        data = oc.choice_data(self.listing, self.automatic, unavailable={gone})
        numbers = [item["n"] for group in data["grupos"] for item in group["itens"]]
        self.assertNotIn(self.listing["rows"][3]["numero"], numbers)
        self.assertEqual(len(numbers), len(self.listing["rows"]) - 1)

    def test_the_script_is_one_definition_and_one_call_that_carries_the_data_as_json(self):
        data = oc.choice_data(self.listing, self.automatic, seconds=90)
        call = oc.choice_call(data)
        self.assertTrue(call.startswith("window.openclodEscolher(") and call.endswith(")"))
        self.assertEqual(json.loads(call[len("window.openclodEscolher("):-1]), data)
        self.assertIn("window.openclodEscolher = async function", oc.CHOICE_JS)
        # Nothing the data brings can become markup or code; no backslashes or triple quotes (the module travels inside a raw string).
        self.assertNotIn("innerHTML", oc.CHOICE_JS)
        self.assertNotIn("outerHTML", oc.CHOICE_JS)
        self.assertNotIn("insertAdjacentHTML", oc.CHOICE_JS)
        self.assertNotIn("eval(", oc.CHOICE_JS)
        self.assertNotIn("\\", oc.CHOICE_JS)
        self.assertNotIn("'''", oc.CHOICE_JS)
        self.assertNotIn("fetch(", oc.CHOICE_JS)
        self.assertNotIn("XMLHttpRequest", oc.CHOICE_JS)

    # --- como a resposta é lida ---

    def test_the_reply_is_read_from_text_or_from_an_object_and_anything_else_is_refused(self):
        valid = {1, 2, 3}
        self.assertEqual(oc.parse_choice_reply('{"quem":"usuario","numero":3}', valid), ("usuario", 3))
        self.assertEqual(oc.parse_choice_reply({"quem": "usuario", "numero": 0}, valid), ("usuario", 0))
        self.assertEqual(oc.parse_choice_reply(b'{"quem":"tempo","numero":0}', valid), ("tempo", 0))
        for bad in ("não é json", "[1]", "5", None, 7, {"quem": "usuario", "numero": 9}, {"quem": "usuario", "numero": "2"},
                    {"quem": "usuario", "numero": True}, {"quem": "usuario", "numero": 1.5}, {"quem": "usuario"}, {"quem": "outro", "numero": 1},
                    {"quem": "cancelado", "numero": 0}, {"numero": 1}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                oc.parse_choice_reply(bad, valid)

    def test_choice_seconds_and_wait_text(self):
        self.assertEqual([oc.choice_seconds(value) for value in (None, "", "abc", 120, "90", 0, -5, 45, 9999, 600.0)], [120, 120, 120, 120, 90, 0, 0, 45, 600, 600])
        self.assertEqual([oc.wait_text(value) for value in (120, 60, 180, 90, 45)], ["2 minutos", "1 minuto", "3 minutos", "90 segundos", "45 segundos"])

    # --- o que cada desfecho devolve ---

    def test_each_outcome_of_the_box(self):
        data = oc.choice_data(self.listing, self.automatic, seconds=120)
        number = self.number_of("Qwen3.5 4B", "Q8_0")
        ask = lambda *replies, **kwargs: oc.ask_model_choice(data, eval_js=self.fake_eval_js(*replies), show_js=self.shown.append, **kwargs)  # noqa: E731
        self.assertEqual(ask(self.user(number)), ("usuario", number, ""))
        self.assertEqual(ask(self.user(0)), ("usuario", 0, ""))
        self.assertEqual(ask(json.dumps({"quem": "tempo", "numero": 0})), ("tempo", 0, ""))
        self.assertEqual(ask({"quem": "usuario", "numero": number}), ("usuario", number, ""))  # already decoded by the Colab
        self.assertEqual(ask(None), ("sem-resposta", 0, ""))
        self.assertEqual(ask(RuntimeError("o Colab disse não"))[0:2], ("erro", 0))
        self.assertIn("o Colab disse não", ask(RuntimeError("o Colab disse não"))[2])
        self.assertEqual(ask(self.user(9999))[0], "erro")
        self.assertEqual(ask("lixo")[0], "erro")
        self.assertEqual(ask(TypeError("eval_js() got an unexpected keyword argument 'timeout_sec'"))[0], "erro")

    def test_the_wait_has_a_limit_longer_than_the_boxs_own_and_the_definition_is_shown_first(self):
        data = oc.choice_data(self.listing, self.automatic, seconds=120)
        oc.ask_model_choice(data, eval_js=self.fake_eval_js(self.user(0)), show_js=self.shown.append)
        self.assertEqual(self.shown, [oc.CHOICE_JS])
        asked = self.asked()
        self.assertEqual(len(asked), 1)
        self.assertEqual(asked[0]["timeout_sec"], 120 + oc.CHOICE_GRACE_SECONDS)
        self.assertGreater(asked[0]["timeout_sec"], 120)
        self.assertEqual(asked[0]["script"], oc.choice_call(data))
        self.assertEqual([call for call in self.calls if call["ignore_result"]], [])  # answered: nothing to tidy up

    def test_a_box_nobody_answers_is_switched_off_so_a_late_click_means_nothing(self):
        data = oc.choice_data(self.listing, self.automatic)
        for reply in (None, RuntimeError("falhou"), "lixo"):
            self.calls[:] = []
            oc.ask_model_choice(data, eval_js=self.fake_eval_js(reply), show_js=self.shown.append)
            cancels = [call for call in self.calls if call["ignore_result"]]
            self.assertEqual(len(cancels), 1, reply)
            self.assertIn("openclodEscolher.cancelar(", cancels[0]["script"])

    def test_stopping_the_cell_while_waiting_switches_the_box_off_and_lets_the_interrupt_through(self):
        data = oc.choice_data(self.listing, self.automatic)
        with self.assertRaises(KeyboardInterrupt):
            oc.ask_model_choice(data, eval_js=self.fake_eval_js(KeyboardInterrupt()), show_js=self.shown.append)
        self.assertEqual(len([call for call in self.calls if call["ignore_result"]]), 1)

    def test_outside_colab_there_is_nobody_to_click(self):
        data = oc.choice_data(self.listing, self.automatic)
        with mock.patch.object(oc, "colab_eval_js", return_value=None):
            self.assertEqual(oc.ask_model_choice(data), ("indisponivel", 0, ""))
        self.assertIsNone(oc.colab_eval_js())  # this machine has no google.colab

    def test_a_missing_display_is_an_error_not_a_crash(self):
        data = oc.choice_data(self.listing, self.automatic)

        def broken(code):
            raise ImportError("No module named 'IPython'")
        who, number, detail = oc.ask_model_choice(data, eval_js=self.fake_eval_js(self.user(0)), show_js=broken)
        self.assertEqual((who, number), ("erro", 0))
        self.assertIn("IPython", detail)

    # --- a etapa 2 inteira ---

    def test_with_nothing_chosen_the_step_stops_to_ask_and_runs_the_number_the_user_picked(self):
        number = self.number_of("Qwen3.5 4B", "Q8_0")
        plan = self.step(self.fake_eval_js(self.user(number)))
        self.assertEqual(plan["candidates"][0]["tag"], "qwen3.5:4b-q8_0")
        self.assertTrue(all(item["explicit"] for item in plan["candidates"]))
        self.assertIs(oc.SESSION.plan, plan)
        self.assertEqual(oc.SESSION.options["numero_da_lista"], number)
        text = self.text()
        self.assertIn("Você escolheu o n.º %d: Qwen3.5 4B (Q8_0)." % number, text)
        self.assertIn("Modelo n.º %d da lista, escolhido por você" % number, text)
        self.assertLess(text.index("Você escolheu"), text.index("Rodando nesta execução"))
        self.assertLess(text.index("Modelos abertos que cabem nesta GPU"), text.index("Escolha o modelo na caixa abaixo"))
        self.assertIn("Sem escolha em 2 minutos, o notebook segue com o automático (qwen3.5:9b-q8_0).", text)
        self.assertIn("<== automático", text)
        self.assertNotIn("<== rodando esta", text)
        self.assertEqual(self.asked()[0]["timeout_sec"], 150)
        self.assertEqual(self.shown, [oc.CHOICE_JS])

    def test_when_nobody_chooses_the_step_goes_on_with_the_automatic_and_says_so(self):
        plan = self.step(self.fake_eval_js(json.dumps({"quem": "tempo", "numero": 0})))
        self.assertEqual(plan, self.automatic)
        self.assertFalse(any(item["explicit"] for item in plan["candidates"]))
        self.assertIn("Ninguém escolheu em 2 minutos: seguindo com o automático (qwen3.5:9b-q8_0).", self.text())
        self.assertIn("-> qwen3.5:9b-q8_0 | contexto 65536 tokens", self.text())
        self.assertEqual(oc.SESSION.options["numero_da_lista"], 0)

    def test_confirming_the_automatic_changes_nothing_but_the_message(self):
        plan = self.step(self.fake_eval_js(self.user(0)))
        self.assertEqual(plan, self.automatic)
        self.assertIn("Você confirmou o modelo automático (qwen3.5:9b-q8_0).", self.text())

    def test_no_answer_and_a_box_that_could_not_be_shown_fall_back_to_the_automatic_and_say_why(self):
        plan = self.step(self.fake_eval_js(None))
        self.assertEqual(plan, self.automatic)
        self.assertIn("A caixa de escolha não respondeu", self.text())
        self.assertIn("seguindo com o automático (qwen3.5:9b-q8_0)", self.text())
        self.lines[:] = []
        plan = self.step(self.fake_eval_js(RuntimeError("sem saída")))
        self.assertEqual(plan, self.automatic)
        self.assertIn("Não consegui mostrar a caixa de escolha (sem saída): seguindo com o automático", self.text())

    def test_the_form_value_for_the_time_changes_how_long_the_step_waits(self):
        self.step(self.fake_eval_js(self.user(0)), segundos_para_escolher=45)
        self.assertEqual(self.asked()[0]["timeout_sec"], 45 + oc.CHOICE_GRACE_SECONDS)
        self.assertIn("Sem escolha em 45 segundos", self.text())
        self.assertEqual(json.loads(self.asked()[0]["script"][len("window.openclodEscolher("):-1])["segundos"], 45)

    def test_nothing_is_asked_when_the_form_already_chose_or_only_the_list_was_asked_for(self):
        number = self.number_of("Qwen3.5 4B", "Q8_0")
        for kwargs in ({"modelo_manual": "qwen3.5:4b"}, {"modelo_manual": "  hf.co/usuario/repo:Q4_K_M "}, {"numero_da_lista": number},
                       {"tipo_de_modelo": "código"}, {"tipo_de_modelo": "sem censura"}, {"tipo_de_modelo": "leve e rápido"}, {"segundos_para_escolher": 0}):
            self.calls[:] = []
            self.lines[:] = []
            plan = self.step(self.fake_eval_js(self.user(0)), **kwargs)
            self.assertEqual(self.calls, [], kwargs)
            self.assertNotIn("Escolha o modelo na caixa abaixo", self.text(), kwargs)
            self.assertIs(oc.SESSION.plan, plan)
        self.calls[:] = []
        with self.assertRaises(oc.StepStopped):
            self.step(self.fake_eval_js(self.user(0)), somente_listar=True)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.shown, [])

    def test_a_list_only_run_and_a_form_choice_keep_the_old_marker(self):
        self.step(self.fake_eval_js(self.user(0)), segundos_para_escolher=0)
        self.assertIn("<== rodando esta", self.text())
        self.assertNotIn("<== automático", self.text())

    def test_outside_colab_the_step_behaves_exactly_as_before(self):
        with mock.patch.object(oc, "colab_eval_js", return_value=None), mock.patch.object(oc, "say", side_effect=self.lines.append):
            plan = oc.step_plan()
        self.assertEqual(plan, self.automatic)
        self.assertNotIn("Escolha o modelo na caixa abaixo", self.text())
        self.assertIn("<== rodando esta", self.text())
        self.assertEqual(self.shown, [])

    def test_the_box_only_offers_what_the_registry_still_has(self):
        gone = self.listing["rows"][3]["variant"]["tag"]
        del os.environ["OPENCLOD_COLAB_OFFLINE"]
        with mock.patch.object(oc, "verify_registry", return_value={gone: ("ausente", 0.0)}):
            self.step(self.fake_eval_js(self.user(0)))
        sent = json.loads(self.asked()[0]["script"][len("window.openclodEscolher("):-1])
        offered = [item["n"] for group in sent["grupos"] for item in group["itens"]]
        self.assertNotIn(self.listing["rows"][3]["numero"], offered)
        self.assertIn("[não está mais no registro do Ollama]", self.text())

    def test_step_model_run_alone_and_the_command_line_never_ask(self):
        with mock.patch.object(oc, "step_plan", side_effect=RuntimeError("parou")) as plan:
            oc.SESSION.plan = None
            with self.assertRaises(RuntimeError):
                oc.step_model()
        plan.assert_called_once_with(segundos_para_escolher=0)
        with mock.patch.object(oc, "step_plan") as plan, mock.patch.object(oc, "step_serve_forever"):
            oc._cli(["run", "--numero", "3"])
        self.assertEqual(plan.call_args.kwargs["segundos_para_escolher"], 0)


class SmallPieceTests(unittest.TestCase):
    def test_pull_progress_sums_layers(self):
        progress = oc.PullProgress()
        progress.feed({"status": "pulling manifest"})
        progress.feed({"status": "pulling aaa", "digest": "aaa", "total": 1000, "completed": 250})
        summary = progress.feed({"status": "pulling bbb", "digest": "bbb", "total": 3000, "completed": 750})
        self.assertEqual((summary["done"], summary["total"]), (1000, 4000))
        self.assertAlmostEqual(summary["percent"], 25.0)
        self.assertEqual(progress.feed({"status": "success"})["status"], "success")

    def test_ps_fit(self):
        full = {"models": [{"name": "m:1", "size": 1000, "size_vram": 1000, "context_length": 65536}]}
        self.assertEqual(oc.ps_fit(full, "m:1"), (True, 100, 65536))
        half = {"models": [{"name": "m:1", "size": 1000, "size_vram": 500}]}
        self.assertEqual(oc.ps_fit(half, "m:1")[:2], (False, 50))
        self.assertEqual(oc.ps_fit({"models": []}, "m:1")[:2], (False, 0))

    def test_capabilities(self):
        caps = oc.capabilities_of({"capabilities": ["completion", "vision", "tools", "thinking"]})
        self.assertTrue(all(caps[k] for k in ("vision", "tools", "thinking")))
        text_only = oc.capabilities_of({"capabilities": ["completion"]})
        self.assertFalse(text_only["vision"] or text_only["tools"])

    def test_tunnel_url_is_found_in_the_log(self):
        log = "2026-10-27 INF Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\n" \
              "2026-10-27 INF |  https://tinta-azul-cinco.trycloudflare.com  |\n2026-10-27 INF Registered tunnel connection"
        self.assertEqual(oc.parse_tunnel_url(log), "https://tinta-azul-cinco.trycloudflare.com")
        self.assertEqual(oc.parse_tunnel_url("api.trycloudflare.com is only a hostname without https"), "")

    def test_engine_version_is_read_from_the_line_that_has_it(self):
        # What `ollama --version` printed in the real Colab (no server running): the version itself comes after a "Warning:".
        colab = "Warning: could not connect to a running Ollama instance\nWarning: client version is 0.40.11\n"
        self.assertEqual(oc.engine_version_text(colab), "0.40.11")
        self.assertEqual(oc.engine_version_text("ollama version is 0.40.11"), "0.40.11")
        self.assertEqual(oc.engine_version_text("Warning: could not connect to a running Ollama instance"), "")
        self.assertEqual(oc.engine_version_text(None), "")

    def test_formatting(self):
        self.assertEqual(oc.gb_text(15360), "15")
        self.assertEqual(oc.gb_text(23034), "22,5")
        self.assertEqual(oc.human_duration(3725), "01:02:05")

    def test_png_is_valid_and_has_the_color(self):
        data = "data:image/png;base64," + base64.b64encode(oc.make_png(16, 16, (220, 30, 30))).decode()
        self.assertEqual(png_first_pixel(data), (220, 30, 30))

    def test_panel_never_shows_a_key(self):
        state = oc.ServerState(KEY, "m:1", "http://127.0.0.1:1", 32768, True, True)
        text = oc.render_panel(state.snapshot(), "https://x.trycloudflare.com", "Tesla T4 (15 GB)")
        self.assertNotIn(KEY, text)
        self.assertNotIn(KEY, json.dumps(state.snapshot()))
        self.assertIn("Mantenha esta aba aberta", text)


# ---------------------------------------------------------------------------------------------------------------------
# Download com retomada e SHA-256
# ---------------------------------------------------------------------------------------------------------------------

class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.payload = os.urandom(300_000)
        payload = self.payload
        self.drop_after = None
        test = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                start = 0
                rng = self.headers.get("Range")
                if rng:
                    start = int(rng.split("=")[1].split("-")[0])
                body = payload[start:]
                self.send_response(206 if rng else 200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if test.drop_after is not None and not rng:
                    self.wfile.write(body[:test.drop_after])
                    self.wfile.flush()
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/file.bin" % self.server.server_address[1]
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_downloads_and_verifies(self):
        dest = os.path.join(self.dir, "a.bin")
        sha = oc.hashlib.sha256(self.payload).hexdigest()
        oc.download(self.url, dest, sha, "teste", show=False)
        self.assertEqual(oc.sha256_of(dest), sha)
        oc.download(self.url, dest, sha, "teste", show=False)  # já verificado: não baixa de novo

    def test_wrong_hash_is_refused_and_removed(self):
        dest = os.path.join(self.dir, "b.bin")
        with self.assertRaises(RuntimeError) as caught:
            oc.download(self.url, dest, "0" * 64, "teste", retries=1, show=False)
        self.assertIn("SHA-256", str(caught.exception))
        self.assertFalse(os.path.exists(dest))

    def test_resumes_after_the_connection_drops(self):
        dest = os.path.join(self.dir, "c.bin")
        self.drop_after = 100_000
        sha = oc.hashlib.sha256(self.payload).hexdigest()
        oc.download(self.url, dest, sha, "teste", show=False)
        self.assertEqual(oc.sha256_of(dest), sha)


# ---------------------------------------------------------------------------------------------------------------------
# Servidor (proxy)
# ---------------------------------------------------------------------------------------------------------------------

class AuthAndRoutesTests(ProxyTestCase):
    def test_key_required_and_wrong_key_refused(self):
        for headers in ({}, {"Authorization": "Bearer errada"}, {"Authorization": KEY}, {"x-api-key": "errada"}):
            conn, response = request(self.port, "GET", "/v1/models", headers=headers)
            self.assertEqual(response.status, 401, headers)
            self.assertIn("Chave de API", json.loads(response.read())["error"]["message"])
            conn.close()
        for headers in (auth(), {"x-api-key": KEY}):
            conn, response = request(self.port, "GET", "/v1/models", headers=headers)
            self.assertEqual(response.status, 200)
            conn.close()

    def test_health_is_public_but_reveals_no_secrets(self):
        conn, response = request(self.port, "GET", "/healthz")
        body = response.read().decode()
        self.assertEqual(response.status, 200)
        self.assertNotIn(KEY, body)
        self.assertNotIn("modelo-teste", body)
        conn.close()

    def test_engine_routes_are_not_exposed(self):
        for path in ("/api/tags", "/api/pull", "/api/delete", "/v1/embeddings", "/v1/completions", "/../etc/passwd"):
            conn, response = request(self.port, "POST", path, body={}, headers=auth())
            self.assertEqual(response.status, 404, path)
            conn.close()
        self.assertEqual(len(self.engine.seen), 0)

    def test_models_document_tells_what_the_harness_needs(self):
        conn, response = request(self.port, "GET", "/v1/models", headers=auth())
        entry = json.loads(response.read())["data"][0]
        conn.close()
        self.assertEqual(entry["id"], "modelo-teste:9b")
        self.assertEqual(entry["context_length"], 65536)
        self.assertIn("image", entry["architecture"]["input_modalities"])
        self.assertIn("tools", entry["supported_parameters"])
        self.assertEqual(entry["openclod"]["gpu"], "Tesla T4 (15 GB)")

    def test_models_document_without_vision_or_tools(self):
        state = oc.ServerState(KEY, "m:1", "http://x", 32768, False, False)
        entry = oc.models_document(state)["data"][0]
        self.assertEqual(entry["architecture"]["input_modalities"], ["text"])
        self.assertNotIn("tools", entry["supported_parameters"])

    def test_models_reports_503_when_the_engine_is_down(self):
        self.engine.close()
        conn, response = request(self.port, "GET", "/v1/models", headers=auth())
        self.assertEqual(response.status, 503)
        self.assertIn("motor", json.loads(response.read())["error"]["message"])
        conn.close()

    def test_wrong_method_and_invalid_json(self):
        conn, response = request(self.port, "GET", "/v1/chat/completions", headers=auth())
        self.assertEqual(response.status, 405)
        conn.close()
        conn, response = request(self.port, "POST", "/v1/chat/completions", raw=b"isto nao e json", headers=auth())
        self.assertEqual(response.status, 400)
        conn.close()

    def test_body_limit(self):
        oc.MAX_BODY_BYTES = 2000
        conn, response = request(self.port, "POST", "/v1/chat/completions", raw=b"x" * 5000, headers=auth())
        self.assertEqual(response.status, 413)
        conn.close()

    def test_brute_force_is_slowed_down(self):
        for _ in range(21):
            self.state.auth_failures.append(time.time())
        started = time.time()
        conn, response = request(self.port, "GET", "/v1/models", headers={"Authorization": "Bearer errada"})
        self.assertEqual(response.status, 401)
        conn.close()
        self.assertGreater(time.time() - started, 1.0)


class ChatTests(ProxyTestCase):
    def chat(self, body, headers=None):
        return request(self.port, "POST", "/v1/chat/completions", body=body, headers=headers or auth())

    def test_non_stream_goes_to_the_served_model(self):
        conn, response = self.chat({"model": "qualquer-outro", "messages": [{"role": "user", "content": "oi"}]})
        data = json.loads(response.read())
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(data["choices"][0]["message"]["content"], "pong")
        self.assertEqual(self.engine.seen[-1]["model"], "modelo-teste:9b")

    def test_thinking_policy(self):
        self.chat({"messages": [{"role": "user", "content": "oi"}]})[0].close()
        self.assertEqual(self.engine.seen[-1].get("reasoning_effort"), "none")
        self.chat({"messages": [{"role": "user", "content": "oi"}], "reasoning_effort": "high"})[0].close()
        self.assertEqual(self.engine.seen[-1].get("reasoning_effort"), "high")
        self.state.thinking_default = "auto"
        self.chat({"messages": [{"role": "user", "content": "oi"}]})[0].close()
        self.assertNotIn("reasoning_effort", self.engine.seen[-1])
        self.state.thinking_default, self.state.thinking_capable = "off", False
        self.chat({"messages": [{"role": "user", "content": "oi"}]})[0].close()
        self.assertNotIn("reasoning_effort", self.engine.seen[-1])

    def test_stream_arrives_piece_by_piece(self):
        self.engine.chunk_delay = 0.15
        conn, response = self.chat({"stream": True, "messages": [{"role": "user", "content": "Conte de 1 a 12"}]})
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        started, stamps, text = time.time(), [], b""
        while True:
            block = response.read1(4096)
            if not block:
                break
            stamps.append(time.time() - started)
            text += block
        conn.close()
        self.assertGreater(len(stamps), 6)
        self.assertGreater(stamps[-1] - stamps[0], 0.8)  # chegou aos poucos, não de uma vez
        self.assertIn(b"[DONE]", text)
        self.assertTrue(self.engine.seen[-1]["stream_options"]["include_usage"])

    def test_slow_engine_gets_early_headers_and_pings(self):
        oc.EARLY_FLUSH_SECONDS, oc.PING_SECONDS = 0.3, 0.3
        self.engine.header_delay = 1.4
        started = time.time()
        conn, response = self.chat({"stream": True, "messages": [{"role": "user", "content": "oi"}]})
        first_header_at = time.time() - started
        self.assertEqual(response.status, 200)
        self.assertLess(first_header_at, 1.0)  # os cabeçalhos saem antes de o motor responder
        body = response.read()
        conn.close()
        self.assertIn(b": aguardando o modelo", body)
        self.assertGreaterEqual(body.count(b": aguardando o modelo"), 2)
        self.assertIn(b"[DONE]", body)

    def test_error_before_streaming_keeps_the_http_status(self):
        self.engine.fail_status, self.engine.fail_message = 400, "context length exceeded"
        conn, response = self.chat({"stream": True, "messages": [{"role": "user", "content": "oi"}]})
        self.assertEqual(response.status, 400)
        self.assertIn("context length", response.read().decode())
        conn.close()

    def test_error_after_early_headers_becomes_an_sse_event(self):
        oc.EARLY_FLUSH_SECONDS, oc.PING_SECONDS = 0.2, 0.2
        self.engine.header_delay = 0.8
        self.engine.fail_status, self.engine.fail_message = 400, "the prompt is too long"
        conn, response = self.chat({"stream": True, "messages": [{"role": "user", "content": "oi"}]})
        self.assertEqual(response.status, 200)
        body = response.read().decode()
        conn.close()
        self.assertIn('"error"', body)
        self.assertIn("the prompt is too long", body)
        self.assertTrue(body.rstrip().endswith("[DONE]"))
        # The counters are updated by the handler thread right after it writes the last chunk: give it a moment under load.
        deadline = time.time() + 3
        while time.time() < deadline and self.state.snapshot()["errors"] < 1:
            time.sleep(0.02)
        self.assertEqual(self.state.snapshot()["errors"], 1)
        self.assertIn("too long", self.state.snapshot()["last_error"])

    def test_engine_down_returns_502(self):
        self.engine.close()
        conn, response = self.chat({"messages": [{"role": "user", "content": "oi"}]})
        self.assertEqual(response.status, 502)
        self.assertIn("não respondeu", json.loads(response.read())["error"]["message"])
        conn.close()

    def test_client_disconnect_stops_the_engine(self):
        self.engine.chunk_delay = 0.2
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        body = json.dumps({"stream": True, "messages": [{"role": "user", "content": "Conte de 1 a 12"}]}).encode()
        sock.sendall(("POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\n"
                      "Content-Length: %d\r\n\r\n" % (KEY, len(body))).encode() + body)
        sock.recv(512)
        sock.close()  # o usuário apertou "parar"
        self.assertTrue(self.engine.closed_early.wait(5), "o motor continuou gerando depois que o cliente saiu")

    def test_chunked_request_body(self):
        body = json.dumps({"messages": [{"role": "user", "content": "oi"}]}).encode()
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        half = len(body) // 2
        sock.sendall(("POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\n"
                      "Transfer-Encoding: chunked\r\n\r\n" % KEY).encode()
                     + b"%x\r\n%s\r\n%x\r\n%s\r\n0\r\n\r\n" % (half, body[:half], len(body) - half, body[half:]))
        data = b""
        while True:
            block = sock.recv(4096)
            if not block:
                break
            data += block
        sock.close()
        self.assertIn(b"200 OK", data.split(b"\r\n")[0])
        self.assertIn(b"pong", data)

    def test_counters_hold_numbers_not_conversations(self):
        self.chat({"messages": [{"role": "user", "content": "SEGREDO-DA-CONVERSA-XYZ"}]})[0].close()
        snapshot = self.state.snapshot()
        self.assertEqual(snapshot["requests"], 1)
        self.assertEqual(snapshot["prompt_tokens"], 7)
        self.assertEqual(snapshot["images"], 0)
        self.assertNotIn("SEGREDO-DA-CONVERSA", json.dumps(snapshot))

    def test_it_counts_the_images_it_received_but_never_keeps_them(self):
        png = "data:image/png;base64," + base64.b64encode(oc.make_png(16, 16, (220, 30, 30))).decode()
        content = [{"type": "text", "text": "veja"}, {"type": "image_url", "image_url": {"url": png}}, {"type": "image_url", "image_url": {"url": png}}]
        self.chat({"messages": [{"role": "user", "content": content}, {"role": "user", "content": "texto puro"}]})[0].close()
        snapshot = self.state.snapshot()
        self.assertEqual(snapshot["images"], 2)
        self.assertNotIn("base64", json.dumps(snapshot))
        self.assertIn("Imagens recebidas: 2", oc.render_panel(snapshot, "https://x.trycloudflare.com", "Tesla T4 (15 GB)"))


class ClaudeAndCodexRoutesTests(ProxyTestCase):
    """Since 1.3.0 the server also serves the Anthropic Messages API (Claude Desktop, Claude Code) and the OpenAI Responses API
    (Codex), straight from the engine (the Ollama speaks both); the chat route the Openclod uses stays as it was."""

    ANTHROPIC = {"x-api-key": KEY, "anthropic-version": "2023-06-01"}

    def call(self, method, path, body=None, headers=None):
        conn, response = request(self.port, method, path, body=body, headers=headers)
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw.decode() or "null")

    def test_status_lists_every_route(self):
        status, data = self.call("GET", "/openclod/status", headers=auth())
        self.assertEqual(status, 200)
        self.assertEqual(data["routes"], ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens", "/v1/responses"])

    def test_messages_with_x_api_key_and_errors_in_the_anthropic_format(self):
        body = {"model": "claude-sonnet-4-5", "max_tokens": 20, "messages": [{"role": "user", "content": "oi"}]}
        status, data = self.call("POST", "/v1/messages?beta=true", body=body, headers=self.ANTHROPIC)
        self.assertEqual((status, data["type"], data["content"][0]["text"]), (200, "message", "pong"))
        self.assertEqual((self.engine.paths[-1], self.engine.seen[-1]["model"]), ("/v1/messages", "modelo-teste:9b"))
        status, data = self.call("POST", "/v1/messages", body=body, headers={"x-api-key": "errada"})
        self.assertEqual((status, data["type"], data["error"]["type"]), (401, "error", "authentication_error"))

    def test_responses_for_the_codex(self):
        status, data = self.call("POST", "/v1/responses", body={"model": "gpt-5-codex", "input": "oi"}, headers=auth())
        self.assertEqual((status, data["object"], data["output"][0]["content"][0]["text"]), (200, "response", "pong"))
        self.assertEqual((self.engine.paths[-1], self.engine.seen[-1]["model"]), ("/v1/responses", "modelo-teste:9b"))

    def test_count_tokens_is_a_local_estimate(self):
        body = {"model": "x", "messages": [{"role": "user", "content": "uma frase qualquer para contar"}]}
        status, data = self.call("POST", "/v1/messages/count_tokens", body=body, headers=self.ANTHROPIC)
        self.assertEqual(status, 200)
        self.assertGreater(data["input_tokens"], 0)
        self.assertEqual(self.engine.seen, [], "the engine is never asked")

    def test_a_model_without_tools_gets_the_request_without_them(self):
        # the Ollama refuses the WHOLE request when a model without tool support receives tools: the server takes them out
        self.state.tools = False
        tool = {"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}
        body = {"model": "x", "messages": [{"role": "user", "content": "oi"}], "tools": [tool], "tool_choice": "auto"}
        status, _ = self.call("POST", "/v1/chat/completions", body=body, headers=auth())
        self.assertEqual(status, 200)
        self.assertNotIn("tools", self.engine.seen[-1])
        self.assertNotIn("tool_choice", self.engine.seen[-1])

    def test_engine_routes_stay_private(self):
        for path in ("/api/pull", "/api/delete", "/v1/messages/batches", "/v1/responses/resp_1"):
            status, _ = self.call("POST", path, body={}, headers=auth())
            self.assertEqual(status, 404, path)


class SelftestTests(ProxyTestCase):
    # since 1.3.0 the selftest also goes through the Anthropic (Claude) and Responses (Codex) routes
    NEW_CHECKS = ["Anthropic: chave por x-api-key", "Anthropic: erro no formato da Anthropic", "Anthropic: /v1/messages",
                  "Anthropic: /v1/messages em stream (SSE)", "Anthropic: chamada de ferramenta (stream)", "Anthropic: contagem de tokens (estimativa)",
                  "Responses: /v1/responses", "Responses: /v1/responses em stream (SSE)"]

    def run_selftest(self, **kwargs):
        lines = []
        outcome = oc.selftest("http://127.0.0.1:%d/v1" % self.port, kwargs.pop("key", KEY), "modelo-teste:9b", log=lines.append, **kwargs)
        return outcome, lines

    def test_passes_against_a_healthy_server(self):
        outcome, lines = self.run_selftest()
        names = [item["name"] for item in outcome["results"]]
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(len([n for n in names if n.startswith("Imagem")]), 2)
        for name in ["Streaming (SSE)", "Chamada de ferramenta (stream)"] + self.NEW_CHECKS:
            self.assertIn(name, names)
        self.assertFalse(any(KEY in line for line in lines))
        # what the engine saw: /v1/messages (no stream, stream and with a tool) and /v1/responses (no stream and stream)
        seen = list(zip(self.engine.paths, self.engine.seen))
        messages = [body for path, body in seen if path == "/v1/messages"]
        responses = [body for path, body in seen if path == "/v1/responses"]
        self.assertEqual([bool(b.get("stream")) for b in messages], [False, True, True])
        self.assertTrue(any(b.get("tools") for b in messages))
        self.assertEqual([bool(b.get("stream")) for b in responses], [False, True])

    def test_wrong_key_fails_loudly(self):
        outcome, _ = self.run_selftest(key="outra-chave")
        self.assertFalse(outcome["ok"])

    def test_a_model_that_does_not_see_the_image_fails(self):
        self.engine.mode = "blind"
        outcome, _ = self.run_selftest()
        self.assertFalse(outcome["ok"])
        self.assertTrue([i for i in outcome["results"] if i["name"].startswith("Imagem") and not i["ok"]])

    def test_a_model_that_does_not_call_the_tool_fails(self):
        self.engine.mode = "notool"
        outcome, _ = self.run_selftest()
        self.assertFalse(outcome["ok"])
        self.assertEqual([i["name"] for i in outcome["results"] if not i["ok"]],
                         ["Chamada de ferramenta (stream)", "Anthropic: chamada de ferramenta (stream)"])

    def test_vision_and_tools_can_be_skipped(self):
        outcome, _ = self.run_selftest(vision=False, tools=False)
        self.assertTrue(outcome["ok"])
        names = [item["name"] for item in outcome["results"]]
        self.assertEqual(len(names), 4 + len(self.NEW_CHECKS) - 1)   # without the Anthropic tool call
        self.assertNotIn("Anthropic: chamada de ferramenta (stream)", names)

    def test_a_thinking_model_is_asked_not_to_think_during_the_selftest(self):
        # The test proves the path (text, stream, image, tool), not the reasoning: a model that thinks could spend the whole
        # token budget of the test thinking. The server is in "auto" (it adds nothing), so what the engine saw came from the test.
        self.state.thinking_default = "auto"
        outcome, _ = self.run_selftest(think_off=True)
        self.assertTrue(outcome["ok"], outcome)
        for path, field, value in (("/v1/chat/completions", "reasoning_effort", "none"), ("/v1/messages", "thinking", {"type": "disabled"}),
                                   ("/v1/responses", "reasoning", {"effort": "none"})):
            bodies = [body for seen_path, body in zip(self.engine.paths, self.engine.seen) if seen_path == path]
            self.assertGreaterEqual(len(bodies), 2, path)
            self.assertTrue(all(body.get(field) == value for body in bodies), path)
        self.engine.seen.clear()
        self.engine.paths.clear()
        outcome, _ = self.run_selftest(think_off=False)
        self.assertTrue(outcome["ok"])
        self.assertFalse(any({"reasoning_effort", "thinking", "reasoning"} & set(body) for body in self.engine.seen))


class CliAndPathsTests(unittest.TestCase):
    def run_module(self, *args, env=None):
        import subprocess
        merged = dict(os.environ)
        merged.pop("OPENCLOD_COLAB_DIR", None)
        merged.update(env or {})
        return subprocess.run([sys.executable, "-B", "-X", "utf8", "-I", os.path.join(HERE, "..", "..", "resources", "colab", "openclod_llm_server.py"), *args],
                              capture_output=True, text=True, encoding="utf-8", env=merged, timeout=60)

    def test_run_subcommand_is_the_whole_notebook_for_a_linux_gpu_machine(self):
        result = self.run_module("run", "--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("túnel", result.stdout)
        self.assertIn("--thinking", result.stdout)

    def test_work_dir_follows_the_environment_and_never_writes_to_content_outside_colab(self):
        probe = "import openclod_llm_server as oc; print(oc.WORK_DIR)"
        code = ["-c", "import sys; sys.path.insert(0, %r); %s" % (os.path.join(HERE, "..", "..", "resources", "colab"), probe)]
        import subprocess
        custom = subprocess.run([sys.executable, "-B", "-X", "utf8", "-I", *code], capture_output=True, text=True, encoding="utf-8",
                                env=dict(os.environ, OPENCLOD_COLAB_DIR=os.path.join(tempfile.gettempdir(), "meu-openclod")), timeout=60)
        self.assertEqual(custom.stdout.strip(), os.path.join(tempfile.gettempdir(), "meu-openclod"))
        env = {key: value for key, value in os.environ.items() if key != "OPENCLOD_COLAB_DIR"}
        default = subprocess.run([sys.executable, "-B", "-X", "utf8", "-I", *code], capture_output=True, text=True, encoding="utf-8", env=env, timeout=60)
        expected = "/content/openclod" if os.path.isdir("/content") else os.path.join(os.path.expanduser("~"), "openclod-colab")
        self.assertEqual(default.stdout.strip(), expected)


class ModuleHygieneTests(unittest.TestCase):
    def test_module_has_no_triple_single_quotes_so_it_can_be_embedded(self):
        source = pathlib.Path(HERE, "..", "..", "resources", "colab", "openclod_llm_server.py").read_text(encoding="utf-8")
        self.assertNotIn("'''", source)
        self.assertFalse(source.rstrip().endswith("\\"))

    def test_only_documented_hosts_are_downloaded(self):
        for url in (oc.OLLAMA_URL, oc.CLOUDFLARED_URL):
            self.assertTrue(url.startswith("https://github.com/"), url)
        self.assertEqual(len(oc.OLLAMA_SHA256), 64)
        self.assertEqual(len(oc.CLOUDFLARED_SHA256), 64)

    def test_stdlib_only(self):
        source = pathlib.Path(HERE, "..", "..", "resources", "colab", "openclod_llm_server.py").read_text(encoding="utf-8")
        imports = set()
        for line in source.splitlines():
            line = line.strip()
            if line.startswith("import ") and not line.startswith("import zstandard"):
                imports.add(line.split()[1].split(".")[0])
            # IPython and google.colab exist only inside the Colab: they are imported inside functions, guarded, and optional.
            if line.startswith("from ") and " import " in line and not line.startswith("from __future__") and "IPython" not in line \
                    and "google.colab" not in line:
                imports.add(line.split()[1].split(".")[0])
        outside = {name for name in imports if name not in sys.stdlib_module_names} if hasattr(sys, "stdlib_module_names") else set()
        self.assertEqual(outside, set())


if __name__ == "__main__":
    unittest.main(verbosity=1)
