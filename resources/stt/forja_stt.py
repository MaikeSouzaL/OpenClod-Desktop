#!/usr/bin/env python
"""Forja streaming speech-to-text sidecar (faster-whisper + Silero VAD).

Protocol: UTF-8, ONE JSON object per line, on stdin (commands) and stdout (events).
stdout carries nothing but protocol lines; every log goes to stderr.

IN  {"type":"start","model":"base","language":"pt"|"auto"|"en"...,"device":"auto"|"cpu"|"cuda",
     "partial_interval_ms":1200,"silence_ms":700,"initial_prompt":null}
    {"type":"audio","pcm":"<base64 of little-endian int16 mono 16 kHz samples>"}
    {"type":"flush"}   finalize whatever is buffered, then answer {"type":"flushed"}
    {"type":"stop"}    exit immediately ({"type":"exit"} is sent first)

OUT {"type":"ready","model","device","compute_type","load_ms", ...}
    {"type":"partial","utterance":N,"text":"..."}     replaces the previous partial of utterance N
    {"type":"final","utterance":N,"text":"...","language":"pt","duration_ms":N,"decode_ms":N}
        text == "" means "utterance discarded": the UI must drop the partial it showed for N
    {"type":"level","rms":0..1,"speech":bool}        about every 100 ms of audio
    {"type":"flushed"}
    {"type":"error","message":"...","fatal":bool}
    {"type":"exit"}

Threads
  reader (main)  parses stdin and never blocks on decoding
  audio          level meter, streaming VAD, utterance segmentation, schedules decodes
  decoder        the only thread that runs Whisper (finals first, partials coalesced)
"""
from __future__ import annotations

import base64
import collections
import json
import os
import queue
import re
import sys
import threading
import time
import unicodedata

PROTOCOL_VERSION = 1
SAMPLE_RATE = 16000
FRAME = 512  # Silero window (32 ms)
FRAME_MS = FRAME * 1000 / SAMPLE_RATE

# Never let anything reach the network or the global HF cache.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


# --------------------------------------------------------------------------------------
# stdio hygiene
# --------------------------------------------------------------------------------------

def _claim_stdout():
    """Keep the real stdout for the protocol; stray prints (ours or native) go to stderr."""
    try:
        fd = os.dup(1)
        os.dup2(2, 1)
        out = os.fdopen(fd, "wb", buffering=0)
    except OSError:
        out = sys.stdout.buffer
    sys.stdout = sys.stderr
    return out


_PROTO_OUT = _claim_stdout()
_EMIT_LOCK = threading.Lock()


def log(msg: str) -> None:
    try:
        sys.stderr.write("[forja_stt] %s\n" % msg)
        sys.stderr.flush()
    except Exception:
        pass


def emit(obj: dict) -> None:
    data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with _EMIT_LOCK:
        try:
            view = memoryview(data)
            while view:
                written = _PROTO_OUT.write(view)
                if not written:
                    raise BrokenPipeError
                view = view[written:]
        except (BrokenPipeError, OSError, ValueError):
            os._exit(0)  # the parent is gone


def emit_error(message: str, fatal: bool = False) -> None:
    emit({"type": "error", "message": message, "fatal": bool(fatal)})


def die(message: str, code: int = 1) -> None:
    emit_error(message, fatal=True)
    emit({"type": "exit"})
    os._exit(code)


def _strip_user_site() -> None:
    """The ._pth file does not disable the user site on Python 3.10: drop it defensively."""
    try:
        import site

        user = os.path.normcase(os.path.abspath(site.getusersitepackages()))
        sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.abspath(p or ".")) != user]
    except Exception:
        pass


_strip_user_site()

try:
    import numpy as np
    import ctranslate2
    from faster_whisper import WhisperModel
    from faster_whisper.vad import VadOptions, get_vad_model
except Exception as exc:  # pragma: no cover - environment problem
    die("Falha ao carregar o motor de voz embarcado: %s: %s" % (type(exc).__name__, exc), 3)


# --------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------

def _clamp(value, low, high, default):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


class Config:
    def __init__(self, msg: dict, models_dir: str):
        model = str(msg.get("model") or "base")
        if not re.fullmatch(r"[A-Za-z0-9._-]+", model):
            die("Nome de modelo invalido: %r" % model, 2)
        self.model = model
        self.model_path = os.path.join(models_dir, model)
        language = str(msg.get("language") or "pt").strip().lower()
        self.language = None if language in ("auto", "") else language
        device = str(msg.get("device") or "auto").lower()
        self.device = device if device in ("auto", "cpu", "cuda") else "auto"
        self.partial_interval_ms = _clamp(msg.get("partial_interval_ms"), 300, 10000, 1200)
        self.silence_ms = _clamp(msg.get("silence_ms"), 200, 5000, 700)
        prompt = msg.get("initial_prompt")
        self.initial_prompt = str(prompt)[:600] if prompt else None
        self.cpu_threads = _clamp(msg.get("cpu_threads"), 1, 32, 4)
        # Segment filters (see _keep_segment). Tunable because they depend on model size / mic quality.
        self.no_speech_max = float(msg.get("no_speech_max", 0.6))
        self.min_avg_logprob = float(msg.get("min_avg_logprob", -1.0))
        self.vad_threshold = float(msg.get("vad_threshold", 0.5))


# --------------------------------------------------------------------------------------
# Voice activity detection (streaming)
# --------------------------------------------------------------------------------------

class StreamingVad:
    """Silero speech probability per 512-sample window of a PCM stream.

    Uses the very session and window layout of faster_whisper.vad (64 samples of context
    in front of every window, zero recurrent state), so streaming decisions match the
    vad_filter applied inside transcribe().
    """

    kind = "silero"

    def __init__(self):
        self._session = get_vad_model().session
        self._tail = np.zeros(0, dtype=np.float32)
        self._ctx = np.zeros(64, dtype=np.float32)
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)

    def reset(self) -> None:
        self._ctx[:] = 0

    def feed(self, x):
        data = np.concatenate([self._tail, x]) if len(self._tail) else x
        n = len(data) // FRAME
        if n == 0:
            self._tail = data
            return np.zeros(0, dtype=np.float32)
        win = data[: n * FRAME].reshape(n, FRAME)
        self._tail = data[n * FRAME :].copy()
        ctx = np.empty((n, 64), dtype=np.float32)
        ctx[0] = self._ctx
        if n > 1:
            ctx[1:] = win[:-1, -64:]
        self._ctx = win[-1, -64:].copy()
        batch = np.concatenate([ctx, win], axis=1)
        out = self._session.run(None, {"input": batch, "h": self._h, "c": self._c})[0]
        return np.asarray(out, dtype=np.float32).reshape(-1)


class EnergyVad:
    """Last-resort VAD (adaptive noise floor) used only if Silero cannot be loaded."""

    kind = "energy"

    def __init__(self):
        self._tail = np.zeros(0, dtype=np.float32)
        self._noise = 0.005

    def reset(self) -> None:
        pass

    def feed(self, x):
        data = np.concatenate([self._tail, x]) if len(self._tail) else x
        n = len(data) // FRAME
        self._tail = data[n * FRAME :].copy()
        probs = np.zeros(n, dtype=np.float32)
        for i in range(n):
            w = data[i * FRAME : (i + 1) * FRAME]
            rms = float(np.sqrt(np.dot(w, w) / FRAME))
            threshold = max(0.012, self._noise * 3.0)
            probs[i] = 1.0 if rms > threshold else 0.0
            if rms < threshold:
                self._noise = 0.97 * self._noise + 0.03 * rms
        return probs


# --------------------------------------------------------------------------------------
# Hallucination filtering
# --------------------------------------------------------------------------------------

def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


_SILENCE_HALLUCINATIONS = [
    "obrigado", "obrigada", "muito obrigado", "muito obrigada", "obrigado por assistir",
    "obrigado por assistirem", "ate a proxima", "ate o proximo video", "tchau", "tchau tchau",
    "inscreva se no canal", "legendas pela comunidade amara org", "legendado por",
    "thank you", "thank you very much", "thanks for watching", "thank you for watching",
    "thanks", "bye", "bye bye", "you", "the end", "subtitles by the amara org community",
    "amara org", "gracias", "merci", "danke", "ok", "hmm", "mm", "uh", "um",
]
_HALLUCINATION_RE = re.compile(
    r"(?:%s)(?:\s+(?:%s))*"
    % (
        "|".join(re.escape(p) for p in sorted(_SILENCE_HALLUCINATIONS, key=len, reverse=True)),
        "|".join(re.escape(p) for p in sorted(_SILENCE_HALLUCINATIONS, key=len, reverse=True)),
    )
)


def is_silence_hallucination(text: str) -> bool:
    return _HALLUCINATION_RE.fullmatch(_norm(text)) is not None


# --------------------------------------------------------------------------------------
# Decoder thread
# --------------------------------------------------------------------------------------

class Job:
    __slots__ = ("kind", "utt", "pcm", "speech_ms", "name")

    def __init__(self, kind, utt=0, pcm=None, speech_ms=0, name=""):
        self.kind = kind  # "partial" | "final" | "marker"
        self.utt = utt
        self.pcm = pcm
        self.speech_ms = speech_ms
        self.name = name


class Decoder(threading.Thread):
    MAX_PENDING = 12  # finals waiting for the decoder (bounded; submit blocks instead of dropping)

    def __init__(self, model, cfg: Config, device: str = "cpu"):
        super().__init__(name="forja-decoder", daemon=True)
        self.model = model
        self.cfg = cfg
        self.device = device
        self._cond = threading.Condition()
        self._fifo = collections.deque()
        self._partial = None
        self._partial_running = False
        self._last_final_utt = 0
        self._partial_text = {}  # utt -> last partial text emitted
        self._lang_lock = {}  # utt -> language detected on its first decode (auto mode)
        self._vad_options = VadOptions(
            threshold=cfg.vad_threshold,
            neg_threshold=max(cfg.vad_threshold - 0.15, 0.01),
            min_silence_duration_ms=500,
            speech_pad_ms=250,
        )

    # ---- submission (audio thread) -------------------------------------------------
    def can_take_partial(self) -> bool:
        with self._cond:
            return self._partial is None and not self._partial_running and not self._fifo

    def reset(self) -> None:
        """Drops pending jobs and per-utterance caches; the loaded model stays."""
        with self._cond:
            self._fifo.clear()
            self._partial = None
            self._partial_text.clear()
            self._lang_lock.clear()
            self._cond.notify_all()

    def submit_partial(self, job: Job) -> None:
        with self._cond:
            self._partial = job
            self._cond.notify_all()

    def submit_final(self, job: Job) -> None:
        warned = False
        with self._cond:
            while len(self._fifo) >= self.MAX_PENDING:
                if not warned:
                    log("decoder queue full (%d finals); applying back-pressure" % len(self._fifo))
                    warned = True
                self._cond.wait(0.5)
            self._fifo.append(job)
            self._last_final_utt = max(self._last_final_utt, job.utt)
            self._partial = None
            self._cond.notify_all()

    def submit_marker(self, name: str) -> None:
        with self._cond:
            self._fifo.append(Job("marker", name=name))
            self._cond.notify_all()

    # ---- worker --------------------------------------------------------------------
    def run(self) -> None:
        while True:
            with self._cond:
                while not self._fifo and self._partial is None:
                    self._cond.wait()
                if self._fifo:
                    job = self._fifo.popleft()
                    self._cond.notify_all()
                else:
                    job = self._partial
                    self._partial = None
                    if job.utt <= self._last_final_utt:
                        continue  # superseded by a final already queued
                    self._partial_running = True
            try:
                if job.kind == "marker":
                    emit({"type": job.name})
                elif job.kind == "final":
                    self._do_final(job)
                else:
                    self._do_partial(job)
            except Exception as exc:  # keep the stream alive
                log("decode failed: %s: %s" % (type(exc).__name__, exc))
                emit_error("Falha ao transcrever o audio: %s" % exc, fatal=False)
            finally:
                with self._cond:
                    self._partial_running = False
                    self._cond.notify_all()

    def _transcribe(self, job: Job, partial: bool):
        audio = job.pcm.astype(np.float32) / 32768.0
        language = self.cfg.language or self._lang_lock.get(job.utt)
        kwargs = dict(
            language=language,
            task="transcribe",
            condition_on_previous_text=False,
            # The streaming VAD already isolated speech for partials; running the
            # VAD again doubles the audio preprocessing without changing the text.
            vad_filter=not partial,
            vad_parameters=self._vad_options,
            initial_prompt=self.cfg.initial_prompt,
        )
        if partial:
            kwargs.update(beam_size=1, best_of=1, temperature=0.0, without_timestamps=True)
        else:
            # CUDA can afford the better beam; CPU dictation needs to finish fast.
            kwargs.update(beam_size=5 if self.device == "cuda" else 1)
        segments, info = self.model.transcribe(audio, **kwargs)
        kept = [seg.text.strip() for seg in segments if self._keep_segment(seg)]
        if self.cfg.language is None and info.language_probability >= 0.5:
            self._lang_lock[job.utt] = info.language
        text = re.sub(r"\s+", " ", " ".join(t for t in kept if t)).strip()
        # Known silence hallucinations ("Obrigado.", "Thank you.") are dropped only when neither
        # the streaming VAD nor the decode-time VAD found real speech in this audio.
        vad_speech_ms = min(job.speech_ms, info.duration_after_vad * 1000.0)
        if text and vad_speech_ms < 300 and is_silence_hallucination(text):
            log("dropped silence hallucination %r (vad speech %.0f ms)" % (text, vad_speech_ms))
            text = ""
        return text, info

    def _keep_segment(self, seg) -> bool:
        if not seg.text.strip():
            return False
        if seg.no_speech_prob > self.cfg.no_speech_max:
            return False
        if seg.avg_logprob < self.cfg.min_avg_logprob:
            return False
        return True

    def _do_partial(self, job: Job) -> None:
        text, _info = self._transcribe(job, partial=True)
        with self._cond:
            stale = job.utt <= self._last_final_utt
        if stale or not text or text == self._partial_text.get(job.utt):
            return
        self._partial_text[job.utt] = text
        emit({"type": "partial", "utterance": job.utt, "text": text})

    def _do_final(self, job: Job) -> None:
        started = time.perf_counter()
        text, info = self._transcribe(job, partial=False)
        decode_ms = int((time.perf_counter() - started) * 1000)
        had_partial = job.utt in self._partial_text
        language = self.cfg.language or self._lang_lock.get(job.utt) or info.language
        self._partial_text.pop(job.utt, None)
        self._lang_lock.pop(job.utt, None)
        if not text and not had_partial:
            return  # nothing was ever shown for this utterance: stay silent
        emit(
            {
                "type": "final",
                "utterance": job.utt,
                "text": text,
                "language": language,
                "duration_ms": int(len(job.pcm) * 1000 / SAMPLE_RATE),
                "decode_ms": decode_ms,
            }
        )


# --------------------------------------------------------------------------------------
# Audio thread: meter, VAD, utterance segmentation
# --------------------------------------------------------------------------------------

PREROLL_SAMPLES = int(0.6 * SAMPLE_RATE)  # audio kept ahead of a speech start
START_FRAMES = 3  # consecutive speech frames (96 ms) that open an utterance
MIN_SPEECH_MS = 250  # shorter bursts (clicks, coughs) never reach the decoder
FIRST_PARTIAL_SPEECH_MS = 400
KEEP_TAIL_MS = 300  # trailing silence kept in the audio sent to the final decode
SOFT_MAX_SAMPLES = 18 * SAMPLE_RATE  # after this, cut at the first short pause
SOFT_PAUSE_MS = 300
HARD_MAX_SAMPLES = 25 * SAMPLE_RATE  # forced final
LEVEL_BLOCK = SAMPLE_RATE // 10  # ~100 ms


class Segmenter(threading.Thread):
    def __init__(self, cfg: Config, vad, decoder: Decoder, audio_q: "queue.Queue"):
        super().__init__(name="forja-audio", daemon=True)
        self.cfg = cfg
        self.vad = vad
        self.decoder = decoder
        self.audio_q = audio_q
        self.partial_interval = cfg.partial_interval_ms * SAMPLE_RATE // 1000
        self.silence_frames_needed = max(1, int(round(cfg.silence_ms / FRAME_MS)))
        self.thr = cfg.vad_threshold
        self.neg_thr = max(cfg.vad_threshold - 0.15, 0.01)
        # stream state
        self.total = 0  # samples received
        self.frames = 0  # VAD frames completed
        self.in_speech = False  # VAD hysteresis state
        self.streak = 0  # consecutive speech frames
        # utterance state
        self.next_id = 1
        self.utt = 0
        self.active = False
        self.chunks = []
        self.buf_len = 0
        self.speech_frames = 0
        self.silence_frames = 0
        self.last_partial_at = 0
        # level meter
        self._lv_sq = 0.0
        self._lv_n = 0

    # ---- thread entry --------------------------------------------------------------
    def run(self) -> None:
        while True:
            item = self.audio_q.get()
            try:
                if isinstance(item, tuple):
                    command = item[0] if item else "flush"
                    if command == "reset":
                        self.reset()
                    else:
                        self.flush()
                else:
                    self.feed(item)
            except Exception as exc:
                log("audio thread error: %s: %s" % (type(exc).__name__, exc))
                emit_error("Falha ao processar o audio: %s" % exc, fatal=False)

    # ---- buffer helpers ------------------------------------------------------------
    def _append(self, pcm) -> None:
        self.chunks.append(pcm)
        self.buf_len += len(pcm)
        if not self.active:
            # Rolling pre-roll: drop whole old chunks only, so a large chunk that carries the
            # speech onset is never cut before the VAD has looked at it.
            while len(self.chunks) > 1 and self.buf_len - len(self.chunks[0]) >= PREROLL_SAMPLES:
                self.buf_len -= len(self.chunks.pop(0))

    def _take_all(self):
        if not self.chunks:
            return np.zeros(0, dtype=np.int16)
        if len(self.chunks) > 1:
            self.chunks = [np.concatenate(self.chunks)]  # consolidate once, later calls are free
        return self.chunks[0]

    # ---- level meter ---------------------------------------------------------------
    def _levels(self, f) -> None:
        pos = 0
        while pos < len(f):
            take = min(LEVEL_BLOCK - self._lv_n, len(f) - pos)
            block = f[pos : pos + take]
            self._lv_sq += float(np.dot(block, block))
            self._lv_n += take
            pos += take
            if self._lv_n >= LEVEL_BLOCK:
                rms = (self._lv_sq / self._lv_n) ** 0.5
                emit({"type": "level", "rms": round(min(1.0, rms), 4), "speech": bool(self.in_speech)})
                self._lv_sq = 0.0
                self._lv_n = 0

    # ---- main per-chunk logic ------------------------------------------------------
    def feed(self, pcm) -> None:
        if len(pcm) == 0:
            return
        f = pcm.astype(np.float32) / 32768.0
        self.total += len(pcm)
        self._append(pcm)
        probs = self.vad.feed(f)
        for p in probs:
            self.frames += 1
            speech = (p >= self.neg_thr) if self.in_speech else (p >= self.thr)
            self.in_speech = bool(speech)
            if speech:
                self.streak += 1
                self.silence_frames = 0
            else:
                self.streak = 0
                if self.active:
                    self.silence_frames += 1
            if not self.active:
                if speech and self.streak >= START_FRAMES:
                    self._start_utterance()
                continue
            if speech:
                self.speech_frames += 1
            if self.silence_frames >= self.silence_frames_needed:
                self._finalize(cut_frames=self.silence_frames, reason="silence")
            elif self.buf_len >= SOFT_MAX_SAMPLES and self.silence_frames * FRAME_MS >= SOFT_PAUSE_MS:
                self._finalize(cut_frames=self.silence_frames, reason="soft-limit")
        self._levels(f)
        if self.active:
            if self.buf_len >= HARD_MAX_SAMPLES:
                self._finalize(cut_frames=0, reason="hard-limit", exact_end=True)
            else:
                self._maybe_partial()

    def _start_utterance(self) -> None:
        self.active = True
        self.utt = self.next_id
        self.next_id += 1
        self.speech_frames = self.streak
        self.silence_frames = 0
        self.last_partial_at = self.buf_len

    def _maybe_partial(self) -> None:
        if self.speech_frames * FRAME_MS < FIRST_PARTIAL_SPEECH_MS:
            return
        if self.buf_len - self.last_partial_at < self.partial_interval:
            return
        if not self.decoder.can_take_partial():
            return
        self.last_partial_at = self.buf_len
        self.decoder.submit_partial(
            Job("partial", self.utt, self._take_all().copy(), int(self.speech_frames * FRAME_MS))
        )

    def _finalize(self, cut_frames: int, reason: str, exact_end: bool = False) -> None:
        """Close the current utterance and hand it to the decoder; keep the rest of the stream."""
        full = self._take_all()
        # Audio that arrived after the frame that closed the utterance belongs to what follows.
        remaining = 0 if exact_end else max(0, self.total - self.frames * FRAME)
        remaining = min(remaining, len(full))
        keep = full[len(full) - remaining :] if remaining else np.zeros(0, dtype=np.int16)
        utter = full[: len(full) - remaining]
        # Trim the trailing silence down to KEEP_TAIL_MS (never into the speech itself).
        trim = max(0, cut_frames * FRAME - int(KEEP_TAIL_MS * SAMPLE_RATE / 1000))
        utter = utter[: max(0, len(utter) - trim)]
        speech_ms = int(self.speech_frames * FRAME_MS)
        utt = self.utt
        self.chunks = [keep] if len(keep) else []
        self.buf_len = len(keep)
        self.active = False
        self.silence_frames = 0
        self.speech_frames = 0
        self.last_partial_at = 0
        self.vad.reset()
        if speech_ms < MIN_SPEECH_MS or len(utter) < SAMPLE_RATE // 5:
            log("utterance %d discarded (%s, speech %d ms)" % (utt, reason, speech_ms))
            return
        log("utterance %d closed (%s): %.2fs audio, %d ms speech" % (utt, reason, len(utter) / SAMPLE_RATE, speech_ms))
        self.decoder.submit_final(Job("final", utt, utter.copy(), speech_ms))

    def flush(self) -> None:
        if self.active:
            self._finalize(cut_frames=0, reason="flush", exact_end=True)
        elif self.streak > 0 and self.buf_len >= SAMPLE_RATE // 5:
            # speech had just begun when the user stopped: treat the pending audio as an utterance
            self._start_utterance()
            self.speech_frames = max(self.speech_frames, MIN_SPEECH_MS // 32 + 1)
            self._finalize(cut_frames=0, reason="flush-early", exact_end=True)
        self.decoder.submit_marker("flushed")

    def reset(self) -> None:
        """Drops the stream state between dictation sessions; the model stays loaded."""
        self.chunks = []
        self.buf_len = 0
        self.total = 0
        self.frames = 0
        self.in_speech = False
        self.streak = 0
        self.active = False
        self.speech_frames = 0
        self.silence_frames = 0
        self.last_partial_at = 0
        self.vad.reset()
        self.decoder.reset()


# --------------------------------------------------------------------------------------
# Model loading
# --------------------------------------------------------------------------------------

def load_model(cfg: Config):
    """Returns (model, device, compute_type). CUDA only if it actually runs; otherwise CPU int8."""
    if not (os.path.isfile(os.path.join(cfg.model_path, "model.bin")) and os.path.isfile(os.path.join(cfg.model_path, "config.json"))):
        die("Modelo de voz '%s' nao encontrado em %s" % (cfg.model, cfg.model_path), 2)

    attempts = []
    if cfg.device in ("auto", "cuda"):
        try:
            cuda_devices = ctranslate2.get_cuda_device_count()
        except Exception:
            cuda_devices = 0
        if cuda_devices > 0:
            attempts.append(("cuda", "float16"))
        elif cfg.device == "cuda":
            emit_error("CUDA solicitada, mas nenhuma GPU compativel foi encontrada; usando CPU.", fatal=False)
    attempts.append(("cpu", "int8"))

    last_error = None
    for device, compute_type in attempts:
        try:
            model = WhisperModel(
                cfg.model_path,
                device=device,
                compute_type=compute_type,
                cpu_threads=cfg.cpu_threads,
                num_workers=1,
                local_files_only=True,
            )
            # Warm-up forces the first real inference: CUDA failures (e.g. missing cuBLAS) only
            # surface here, and the CPU path gets its allocations done before the first utterance.
            segments, _info = model.transcribe(
                np.zeros(SAMPLE_RATE * 2, dtype=np.float32),
                language=cfg.language or "en",
                beam_size=1,
                temperature=0.0,
                vad_filter=False,
                without_timestamps=True,
            )
            list(segments)
            return model, device, compute_type
        except Exception as exc:
            last_error = exc
            log("load on %s/%s failed: %s: %s" % (device, compute_type, type(exc).__name__, exc))
            if device == "cuda" and cfg.device == "cuda":
                emit_error("Falha ao usar a GPU (%s); usando CPU." % exc, fatal=False)
    die("Falha ao carregar o modelo de voz '%s': %s" % (cfg.model, last_error), 2)


# --------------------------------------------------------------------------------------
# Reader / entry point
# --------------------------------------------------------------------------------------

def default_models_dir(argv) -> str:
    for i, arg in enumerate(argv):
        if arg == "--models-dir" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--models-dir="):
            return arg.split("=", 1)[1]
    env = os.environ.get("FORJA_STT_MODELS")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "models", "whisper"))


def main(argv) -> int:
    models_dir = default_models_dir(argv)
    file_path = None
    file_model = os.environ.get("FORJA_STT_MODEL", "base")
    file_language = os.environ.get("FORJA_STT_LANGUAGE", "pt")
    for index, arg in enumerate(argv):
        if arg == "--transcribe-file" and index + 1 < len(argv):
            file_path = argv[index + 1]
        elif arg.startswith("--transcribe-file="):
            file_path = arg.split("=", 1)[1]
        elif arg == "--model" and index + 1 < len(argv):
            file_model = argv[index + 1]
        elif arg.startswith("--model="):
            file_model = arg.split("=", 1)[1]
        elif arg == "--language" and index + 1 < len(argv):
            file_language = argv[index + 1]
        elif arg.startswith("--language="):
            file_language = arg.split("=", 1)[1]
    if file_path:
        if not os.path.isfile(file_path):
            die("Arquivo de midia nao encontrado: %s" % file_path, 2)
        cfg = Config({"model": file_model, "language": file_language, "device": "auto"}, models_dir)
        model, device, compute_type = load_model(cfg)
        segments, info = model.transcribe(
            file_path,
            language=cfg.language,
            task="transcribe",
            beam_size=5,
            vad_filter=True,
            word_timestamps=False,
            condition_on_previous_text=True,
        )
        items = []
        for segment in segments:
            text = (segment.text or "").strip()
            if text:
                items.append({"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": text})
        emit({
            "type": "transcription",
            "text": " ".join(item["text"] for item in items).strip(),
            "segments": items,
            "language": getattr(info, "language", cfg.language or "auto"),
            "language_probability": round(float(getattr(info, "language_probability", 0) or 0), 4),
            "duration": round(float(getattr(info, "duration", 0) or 0), 3),
            "device": device,
            "compute_type": compute_type,
        })
        sys.stdout.flush()
        os._exit(0)
    audio_q: "queue.Queue" = queue.Queue(maxsize=4096)  # ~7 min of 100 ms chunks
    started = threading.Event()

    def excepthook(args):
        log("unhandled error in %s: %r" % (getattr(args.thread, "name", "?"), args.exc_value))
        die("Erro interno do motor de voz: %s" % (args.exc_value,), 4)

    threading.excepthook = excepthook

    def start_session(msg: dict) -> None:
        cfg = Config(msg, models_dir)
        t0 = time.perf_counter()
        model, device, compute_type = load_model(cfg)
        try:
            vad = StreamingVad()
        except Exception as exc:
            log("Silero VAD unavailable (%s: %s); using the energy fallback" % (type(exc).__name__, exc))
            vad = EnergyVad()
        decoder = Decoder(model, cfg, device)
        decoder.start()
        Segmenter(cfg, vad, decoder, audio_q).start()
        load_ms = int((time.perf_counter() - t0) * 1000)
        log("ready: %s on %s/%s in %d ms (vad=%s)" % (cfg.model, device, compute_type, load_ms, vad.kind))
        emit(
            {
                "type": "ready",
                "model": cfg.model,
                "device": device,
                "compute_type": compute_type,
                "load_ms": load_ms,
                "language": cfg.language or "auto",
                "vad": vad.kind,
                "protocol": PROTOCOL_VERSION,
            }
        )

    stdin = sys.stdin.buffer
    while True:
        try:
            line = stdin.readline()
        except (OSError, ValueError):
            break
        if not line:
            break  # parent closed stdin
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            kind = msg.get("type")
        except (ValueError, AttributeError):
            emit_error("Mensagem invalida recebida pelo motor de voz.", fatal=False)
            continue

        if kind == "audio":
            if not started.is_set():
                continue
            try:
                raw = base64.b64decode(msg.get("pcm", ""), validate=False)
            except (ValueError, TypeError):
                emit_error("Bloco de audio invalido (base64).", fatal=False)
                continue
            if len(raw) % 2:
                raw = raw[:-1]
            if not raw:
                continue
            pcm = np.frombuffer(raw, dtype="<i2")
            try:
                audio_q.put(pcm, timeout=30)
            except queue.Full:
                log("audio queue full for 30 s; dropping a chunk")
                emit_error("O motor de voz nao esta acompanhando o audio.", fatal=False)
        elif kind == "flush":
            if started.is_set():
                audio_q.put(("flush",))
        elif kind == "reset":
            if started.is_set():
                audio_q.put(("reset",))
        elif kind == "start":
            if started.is_set():
                emit_error("O motor de voz ja foi iniciado.", fatal=False)
                continue
            started.set()
            threading.Thread(target=start_session, args=(msg,), name="forja-loader", daemon=True).start()
        elif kind == "stop":
            break
        else:
            emit_error("Comando desconhecido: %r" % (kind,), fatal=False)

    emit({"type": "exit"})
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
