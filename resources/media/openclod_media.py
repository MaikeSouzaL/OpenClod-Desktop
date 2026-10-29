#!/usr/bin/env python
"""Openclod media ingestion: an audio file becomes a transcript; a video becomes a transcript plus the frames that matter.

    python -I -X utf8 openclod_media.py ingest <file> --out <dir> [options]
    python -I -X utf8 openclod_media.py probe  <file>
    python -I -X utf8 openclod_media.py make-test-video --out <file.mp4>      (test helper: 4 scenes + a tone)

Protocol: stdout carries nothing but one JSON object per line; every log goes to stderr.
    {"type":"progress","step":"probe|frames|sheets|transcribe","pct":0..100,"message":"..."}
    {"type":"result","manifest":"<dir>/manifest.json","summary":{...}}
    {"type":"error","message":"...","fatal":true}

What it writes into --out (the caller reads manifest.json; everything else is for the model or the user to open):
    frames/frame_001.jpg ...   the kept frames, in time order
    sheets/sheet_01.jpg ...    contact sheets: 3x3 consecutive frames per image, each cell labelled #n and its timestamp
    frames.json                per-frame source-video timestamps and why each was kept
    transcript.json / .txt     segments with start/end seconds
    manifest.json              everything above in one document + the source's identity (size, mtime) for caching

The frame logic is a port of claude-real-video (MIT, Copyright (c) 2026 LeoAido,
https://github.com/HUANGCHIHHUNGLeo/claude-real-video): scene-change detection plus a density floor, a sliding-window
dedup with three detectors (global, small-subject "action", settled-local), the contact sheets and the idea of weaving
frames into the transcript on one clock. It differs where the embedded runtime asks for it: the video is decoded with PyAV
(which carries its own FFmpeg libraries) instead of the ffmpeg command line, images are handled with numpy instead of
Pillow, JPEGs are written with PyAV's MJPEG encoder, and speech goes through the faster-whisper engine that ships with
Openclod (offline, Silero VAD). It never touches the network.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import unicodedata

# Nothing here may reach the network or the user's global caches.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


# ---------------------------------------------------------------------------------------------------------------------
# stdio hygiene: the real stdout is for the protocol only
# ---------------------------------------------------------------------------------------------------------------------

def _claim_stdout():
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


def log(message: str) -> None:
    try:
        sys.stderr.write("[openclod_media] %s\n" % message)
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


_last_progress: dict = {}


def progress(step: str, pct: float, message: str = "", force: bool = False) -> None:
    """At most ~3 lines a second per step, except when `force` is set."""
    now = time.monotonic()
    if not force and now - _last_progress.get(step, 0.0) < 0.35:
        return
    _last_progress[step] = now
    emit({"type": "progress", "step": step, "pct": int(max(0, min(100, pct))), "message": message})


def die(message: str, code: int = 1) -> None:
    emit({"type": "error", "message": message, "fatal": True})
    sys.stderr.flush()
    os._exit(code)


def _strip_user_site() -> None:
    try:
        import site

        user = os.path.normcase(os.path.abspath(site.getusersitepackages()))
        sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.abspath(p or ".")) != user]
    except Exception:
        pass


_strip_user_site()

try:
    import numpy as np
    import av
except Exception as exc:  # pragma: no cover - environment problem
    die("Falha ao carregar o runtime de mídia embutido (PyAV/numpy): %s: %s" % (type(exc).__name__, exc), 3)


# ---------------------------------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------------------------------

def fmt_ts(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    whole = int(seconds)
    h, rem = divmod(whole, 3600)
    m, s = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def write_json_atomic(path: str, obj) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, ensure_ascii=False, indent=1)
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except OSError:
            if attempt == 4:
                raise
            time.sleep(0.05 * (attempt + 1))


def options_signature(opts: dict) -> str:
    return hashlib.sha1(json.dumps(opts, sort_keys=True).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------------------------------------------------
# probing
# ---------------------------------------------------------------------------------------------------------------------

_COVER_CODECS = {"mjpeg", "png", "bmp", "gif", "webp", "tiff"}


def _is_cover_art(stream) -> bool:
    """An mp3/m4a with an embedded picture has a "video" stream that is one still image, not a video."""
    try:
        name = stream.codec_context.name
        rate = float(stream.average_rate) if stream.average_rate else 0.0
        return name in _COVER_CODECS and (stream.frames in (0, 1) or rate < 1.0)
    except Exception:
        return False


def probe(path: str) -> dict:
    with av.open(path) as container:
        video = next((s for s in container.streams.video if not _is_cover_art(s)), None)
        audio = container.streams.audio[0] if container.streams.audio else None
        duration = float(container.duration) / av.time_base if container.duration else 0.0
        if not duration:
            for stream in (video, audio):
                if stream is not None and stream.duration and stream.time_base:
                    duration = max(duration, float(stream.duration * stream.time_base))
        info = {
            "format": container.format.name,
            "duration": round(duration, 3),
            "has_video": video is not None,
            "has_audio": audio is not None,
        }
        if video is not None:
            fps = float(video.average_rate) if video.average_rate else (float(video.guessed_rate) if video.guessed_rate else 25.0)
            info.update({"width": int(video.width), "height": int(video.height), "fps": round(fps, 3), "video_codec": video.codec_context.name})
        if audio is not None:
            info.update({"audio_codec": audio.codec_context.name, "sample_rate": int(audio.rate or 0), "channels": int(audio.channels or 0)})
        return info


# ---------------------------------------------------------------------------------------------------------------------
# images: JPEG out, tiny bitmap font for the labels, rotation
# ---------------------------------------------------------------------------------------------------------------------

def write_jpeg(frame, dest: str, quality: int = 3) -> None:
    """MJPEG through PyAV (no Pillow in the embedded runtime). `quality` is the encoder's qscale: 2 = best, ~5 = small."""
    if frame.format.name != "yuvj420p":
        frame = frame.reformat(format="yuvj420p")
    container = av.open(dest, mode="w", format="image2", options={"update": "1"})
    try:
        stream = container.add_stream("mjpeg")
        stream.width, stream.height = frame.width, frame.height
        stream.pix_fmt = "yuvj420p"
        stream.codec_context.options = {"qscale": str(max(1, min(31, int(quality))))}
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()


def write_jpeg_array(array, dest: str, quality: int = 3) -> None:
    height, width = array.shape[:2]
    array = array[:height - height % 2, :width - width % 2]   # yuv420p wants even dimensions
    write_jpeg(av.VideoFrame.from_ndarray(np.ascontiguousarray(array), format="rgb24"), dest, quality)


def apply_rotation(array, degrees: float):
    """FFmpeg's display-matrix semantics: the angle is the counterclockwise rotation that makes the picture upright."""
    turns = int(round((degrees or 0) / 90.0)) % 4
    return np.rot90(array, turns) if turns else array


_GLYPHS = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    ":": ("00000", "00100", "00100", "00000", "00100", "00100", "00000"),
    "#": ("01010", "01010", "11111", "01010", "11111", "01010", "01010"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    " ": ("00000",) * 7,
}


def draw_text(image, x: int, y: int, text: str, scale: int, color=(255, 255, 255)) -> None:
    height, width = image.shape[:2]
    cursor = x
    for char in text:
        glyph = _GLYPHS.get(char, _GLYPHS[" "])
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == "1":
                    y0, x0 = y + row * scale, cursor + col * scale
                    if 0 <= y0 < height and 0 <= x0 < width:
                        image[y0:min(height, y0 + scale), x0:min(width, x0 + scale)] = color
        cursor += 6 * scale


# ---------------------------------------------------------------------------------------------------------------------
# frame selection (claude-real-video: scene change + density floor, then sliding-window dedup)
# ---------------------------------------------------------------------------------------------------------------------

FINE = 192          # signature size of the settled channel (px); 192 = 16 * 12 = 32 * 6, so the coarse ones are block means
GRID = 16
SOFT_TOL = 80       # per-channel tolerance of the settled mask
HARD_TOL = 105      # stricter pass: soft-contrast drift dies, ink and text survive
MOTION_CEIL = 3.0   # the settled channel is only consulted when the scene is ~static against the previous candidate
BUMP, DECAY = 2.0, 0.7
STRONG_TOL = 45     # action channel: a few cells changing HARD mark a frame as new whatever the percentage
STRONG_MIN = 3


class Candidate:
    __slots__ = ("t", "via", "frame", "coarse", "mid", "fine", "number")

    def __init__(self, t, via, frame, coarse, mid, fine, number):
        self.t, self.via, self.frame, self.coarse, self.mid, self.fine, self.number = t, via, frame, coarse, mid, fine, number


def signatures(frame):
    """16x16, 32x32 and 192x192 RGB signatures of a decoded frame (area-averaged, like the original's BOX resize)."""
    fine = frame.reformat(width=FINE, height=FINE, format="rgb24", interpolation="AREA").to_ndarray()
    mid = fine.reshape(32, 6, 32, 6, 3).mean(axis=(1, 3))
    coarse = fine.reshape(16, 12, 16, 12, 3).mean(axis=(1, 3))
    return coarse.astype(np.float32), mid.astype(np.float32), fine


def pct_diff(a, b, tol: int = 25) -> float:
    return float((np.abs(a - b).max(axis=2) > tol).mean() * 100.0)


def strong_cells(a, b) -> int:
    return int((np.abs(a - b).max(axis=2) > STRONG_TOL).sum())


def _strong_mask(a, b, tol):
    return np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2) > tol


def _minshift_mask(kept, current, tol):
    """A pixel only counts as changed if no pixel within +-1 of the kept frame matches it (jitter, weave, grain)."""
    combined = None
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            mask = _strong_mask(np.roll(kept, (dy, dx), axis=(0, 1)), current, tol)
            combined = mask if combined is None else (combined & mask)
    return combined


def _settled_grid(fine, fine_next, recent_fine, tol):
    """Cells (percent) that changed against EVERY kept frame of the window and are not still changing toward the next one."""
    still_changing = _minshift_mask(fine_next, fine, tol) if fine_next is not None else None
    combined = None
    for kept in recent_fine:
        mask = _minshift_mask(kept, fine, tol)
        if still_changing is not None:
            mask = mask & ~still_changing
        combined = mask if combined is None else (combined & mask)
    return (combined.reshape(GRID, FINE // GRID, GRID, FINE // GRID).mean(axis=(1, 3)) * 100.0).ravel()


class Dedup:
    """Streams candidates in time order; keeps a frame when it is new against the last `window` kept frames.

    Global channel: percent of changed cells on a 16x16 RGB signature. Action channel: a few cells of a 32x32 signature
    changing hard (a small subject can never move 8% of the pixels). Settled-local channel: pixels that differ strongly
    from every kept frame and have stopped moving (thin strokes, caption swaps, UI updates), with a cooldown so a flag
    waving cannot take a frame every time. One candidate of lookahead is needed (settled = "not still changing")."""

    def __init__(self, threshold: float, window: int, write_kept):
        self.threshold, self.window, self.write_kept = threshold, window, write_kept
        self.gate = 0.85 * threshold
        self.hard_gate = 0.4 * self.gate
        self.pending: Candidate | None = None
        self.recent, self.recent_mid, self.recent_fine = [], [], []
        self.records: list[dict] = []
        self.mult, self.prev_coarse = 1.0, None

    def push(self, candidate: Candidate) -> None:
        if self.pending is None:
            self.pending = candidate
            return
        previous, self.pending = self.pending, candidate
        self._decide(previous, candidate, last=False)

    def finish(self) -> None:
        if self.pending is not None:
            self._decide(self.pending, None, last=True)
            self.pending = None

    def _decide(self, c: Candidate, nxt, last: bool) -> None:
        dist = min((pct_diff(c.coarse, k) for k in self.recent), default=None)
        keep = dist is None or dist > self.threshold
        via = "first" if dist is None else ("global" if keep else None)
        settled = None
        if not keep and all(pct_diff(c.coarse, k) > self.threshold or strong_cells(c.mid, k32) >= STRONG_MIN
                            for k, k32 in zip(self.recent, self.recent_mid)):
            keep, via = True, "action"
        if not keep:
            motion = pct_diff(c.coarse, self.prev_coarse) if self.prev_coarse is not None else 100.0
            if motion < MOTION_CEIL or last:
                fine_next = nxt.fine if nxt is not None else None
                soft = _settled_grid(c.fine, fine_next, self.recent_fine, SOFT_TOL)
                settled = float(soft.max())
                if settled > self.gate * self.mult:
                    hard = _settled_grid(c.fine, fine_next, self.recent_fine, HARD_TOL)
                    if any(s > self.gate * self.mult and h > self.hard_gate for s, h in zip(soft, hard)):
                        keep, via = True, "settled"
                        self.mult += BUMP
        self.prev_coarse = c.coarse
        self.mult = max(1.0, self.mult * DECAY)
        record = {"t": c.t, "dist": dist, "settled": settled, "via": via if keep else None, "kept": keep, "selected_by": c.via, "name": None}
        if keep:
            record["name"] = self.write_kept(c)
            self.recent.append(c.coarse)
            self.recent_mid.append(c.mid)
            self.recent_fine.append(c.fine)
            if len(self.recent) > self.window:
                self.recent.pop(0)
                self.recent_mid.pop(0)
                self.recent_fine.pop(0)
        c.frame = None
        self.records.append(record)


def scene_score(small, previous, prev_mafd: float):
    """ffmpeg's `scene` metric on a 64x36 RGB thumbnail: min(mean abs diff, its jump from the previous frame), 0..1."""
    mafd = float(np.abs(small - previous).mean()) / 255.0
    return min(mafd, abs(mafd - prev_mafd)), mafd


def iter_frames(container, stream, damaged: dict):
    """Decoded frames in order. A damaged packet (a download cut short, a bad splice, a bad sector) is skipped and counted:
    the next keyframe recovers, and one bad second must not cost the user the whole video."""
    try:
        for packet in container.demux(stream):
            try:
                frames = packet.decode()
            except av.error.FFmpegError:
                damaged["packets"] += 1
                continue
            for frame in frames:
                yield frame
    except av.error.FFmpegError as error:   # the file ends in the middle of a packet
        damaged["packets"] += 1
        damaged["ended_early"] = str(error)[:120]


def extract_frames(path: str, out_dir: str, info: dict, args) -> dict:
    frames_dir = os.path.join(out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    for old in os.listdir(frames_dir):
        if old.lower().endswith(".jpg"):
            os.remove(os.path.join(frames_dir, old))
    duration = float(info.get("duration") or 0.0)
    limit = float(args.max_seconds or 0.0)
    kept_files: list[str] = []
    started = time.monotonic()

    def write_kept(c: Candidate) -> str:
        name = "kept_%06d.jpg" % len(kept_files)
        frame = c.frame
        rotation = float(getattr(frame, "rotation", 0) or 0)
        width = min(int(args.frame_width), frame.width) if args.frame_width else frame.width
        height = max(2, round(frame.height * width / frame.width))
        if rotation:
            rgb = frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
            write_jpeg_array(apply_rotation(rgb, rotation), os.path.join(frames_dir, name), args.frame_quality)
        else:
            write_jpeg(frame.reformat(width=width - width % 2, height=height - height % 2, format="yuvj420p"), os.path.join(frames_dir, name), args.frame_quality)
        kept_files.append(name)
        return name

    dedup = Dedup(args.dedup, args.window, write_kept)
    decoded = candidates = 0
    previous_small, prev_mafd, last_floor_t, last_t = None, 0.0, -1e9, 0.0
    score_every = 1 if duration <= 1800 else 2     # long videos: score every other frame, decode is the cost anyway
    damaged = {"packets": 0}
    with av.open(path) as container:
        stream = next(s for s in container.streams.video if not _is_cover_art(s))
        stream.thread_type = "AUTO"
        fps = float(stream.average_rate) if stream.average_rate else 25.0
        for frame in iter_frames(container, stream, damaged):
            t = float(frame.time) if frame.time is not None else last_t + 1.0 / fps
            last_t = t
            if limit and t > limit:
                break
            decoded += 1
            via = None
            if decoded % score_every == 0 or previous_small is None:
                small = frame.reformat(width=64, height=36, format="rgb24", interpolation="AREA").to_ndarray().astype(np.int16)
                if previous_small is None:
                    via = "first"
                else:
                    score, prev_mafd = scene_score(small, previous_small, prev_mafd)
                    if score > args.scene:
                        via = "scene"
                previous_small = small
            if via is None and t - last_floor_t >= args.fps_floor - 1e-6:
                via = "floor"
            if via is not None:
                if via in ("first", "floor") or t - last_floor_t >= args.fps_floor:
                    last_floor_t = t
                coarse, mid, fine = signatures(frame)
                candidates += 1
                dedup.push(Candidate(t, via, frame, coarse, mid, fine, candidates))
            if decoded % 15 == 0:
                done = (t / duration) if duration else 0.0
                progress("frames", 100.0 * min(1.0, done), "frames: %s / %s · %d candidatos" % (fmt_ts(t), fmt_ts(duration), candidates))
        dedup.finish()

    # cap: thin uniformly AFTER dedup so the survivors stay spread across the video
    kept_records = [r for r in dedup.records if r["kept"]]
    cap = int(args.max_frames or 0)
    if cap and len(kept_records) > cap:
        step = len(kept_records) / cap
        keep_idx = {int(i * step) for i in range(cap)}
        survivors = []
        for index, record in enumerate(kept_records):
            if index in keep_idx:
                survivors.append(record)
            else:
                try:
                    os.remove(os.path.join(frames_dir, record["name"]))
                except OSError:
                    pass
                record["kept"], record["capped"] = False, True
        kept_records = survivors
    width = max(3, len(str(len(kept_records))))
    for number, record in enumerate(kept_records, 1):
        final = "frame_%0*d.jpg" % (width, number)
        os.replace(os.path.join(frames_dir, record["name"]), os.path.join(frames_dir, "tmp_" + final))
        record["file"] = "frames/" + final
    for record in kept_records:
        os.replace(os.path.join(frames_dir, "tmp_" + os.path.basename(record["file"])), os.path.join(out_dir, record["file"]))
    frames = [
        {"file": r["file"], "t": round(r["t"], 3), "ts": fmt_ts(r["t"]), "via": r["via"] if r["via"] != "first" else "first", "selected_by": r["selected_by"]}
        for r in kept_records
    ]
    write_json_atomic(os.path.join(out_dir, "frames.json"), {"frames": frames})
    return {"frames": frames, "decoded": decoded, "candidates": candidates, "damaged": damaged, "elapsed": round(time.monotonic() - started, 2)}


# ---------------------------------------------------------------------------------------------------------------------
# contact sheets
# ---------------------------------------------------------------------------------------------------------------------

def _load_rgb(path: str, width: int, height: int):
    with av.open(path) as container:
        frame = next(container.decode(video=0))
        return frame.reformat(width=width, height=height, format="rgb24", interpolation="AREA").to_ndarray()


def make_sheets(out_dir: str, frames: list[dict], cols: int, rows: int, cell_width: int, quality: int) -> list[dict]:
    sheets_dir = os.path.join(out_dir, "sheets")
    os.makedirs(sheets_dir, exist_ok=True)
    for old in os.listdir(sheets_dir):
        if old.lower().endswith(".jpg"):
            os.remove(os.path.join(sheets_dir, old))
    if not frames:
        return []
    per = cols * rows
    first = os.path.join(out_dir, frames[0]["file"])
    with av.open(first) as container:
        probe_frame = next(container.decode(video=0))
        src_w, src_h = probe_frame.width, probe_frame.height
    # A cell fits a box (cell_width wide, 4/3 of that tall): 16:9 gives 480x270, a phone video 360x640, so a 3x3 sheet stays
    # around 1440 px wide whatever the orientation and a vision model is not charged for a 2600 px image.
    box_w, box_h = max(64, int(cell_width)), max(64, round(int(cell_width) * 4 / 3))
    fit = min(box_w / src_w, box_h / src_h)
    cw, ch = max(64, round(src_w * fit)), max(36, round(src_h * fit))
    scale = max(1, round(cw / 240))
    label_h = 9 * scale + 4
    pad = max(2, len(str(-(-len(frames) // per))))
    out = []
    for batch_start in range(0, len(frames), per):
        batch = frames[batch_start:batch_start + per]
        sheet = np.zeros((rows * (ch + label_h), cols * cw, 3), dtype=np.uint8)
        names = []
        for i, frame in enumerate(batch):
            x, y = (i % cols) * cw, (i // cols) * (ch + label_h)
            try:
                tile = _load_rgb(os.path.join(out_dir, frame["file"]), cw, ch)
                sheet[y + label_h:y + label_h + ch, x:x + cw] = tile
            except Exception as error:   # a cell that cannot be read stays black; the sheet is still useful
                log("sheet: não consegui ler %s: %s" % (frame["file"], error))
            number = batch_start + i + 1
            draw_text(sheet, x + 4, y + 2, "#%d  %s" % (number, frame["ts"]), scale)
            names.append(frame["file"])
        dest = "sheets/sheet_%0*d.jpg" % (pad, batch_start // per + 1)
        write_jpeg_array(sheet, os.path.join(out_dir, dest), quality)
        out.append({"file": dest, "frames": names, "first": batch_start + 1, "t0": batch[0]["t"], "t1": batch[-1]["t"], "cols": cols, "rows": rows})
        for i, frame in enumerate(batch):
            frame["sheet"], frame["cell"], frame["number"] = dest, i + 1, batch_start + i + 1
    return out


# ---------------------------------------------------------------------------------------------------------------------
# transcription (faster-whisper + Silero VAD, the same engine the dictation uses)
# ---------------------------------------------------------------------------------------------------------------------

def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


_SILENCE_PHRASES = [
    "obrigado", "obrigada", "muito obrigado", "obrigado por assistir", "ate a proxima", "tchau", "inscreva se no canal",
    "legendas pela comunidade amara org", "thank you", "thanks for watching", "thank you for watching", "bye", "you",
    "the end", "subtitles by the amara org community", "amara org", "ok", "hmm",
]
_SILENCE_RE = re.compile("(?:%s)" % "|".join(re.escape(p) for p in sorted(_SILENCE_PHRASES, key=len, reverse=True)))


def is_silence_hallucination(text: str) -> bool:
    return _SILENCE_RE.fullmatch(_norm(text)) is not None


def default_models_dir(args) -> str:
    if args.models_dir:
        return args.models_dir
    env = os.environ.get("OPENCLOD_STT_MODELS")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "models", "whisper"))


def load_whisper(models_dir: str, requested: str, device: str):
    """Returns (model, name, device, compute_type). CUDA only if it actually runs; otherwise CPU int8."""
    import ctranslate2
    from faster_whisper import WhisperModel

    cuda = 0
    try:
        cuda = ctranslate2.get_cuda_device_count() if device in ("auto", "cuda") else 0
    except Exception:
        cuda = 0
    name = requested
    if name == "auto":
        name = "small" if cuda > 0 else "base"
    order = [name] + [m for m in ("small", "base", "tiny") if m != name]
    for candidate in order:
        path = os.path.join(models_dir, candidate)
        if not (os.path.isfile(os.path.join(path, "model.bin")) and os.path.isfile(os.path.join(path, "config.json"))):
            continue
        attempts = ([("cuda", "float16")] if cuda > 0 else []) + [("cpu", "int8")]
        for dev, compute in attempts:
            try:
                model = WhisperModel(path, device=dev, compute_type=compute, cpu_threads=4, num_workers=1, local_files_only=True)
                segments, _ = model.transcribe(np.zeros(16000 * 2, dtype=np.float32), language="en", beam_size=1, temperature=0.0, vad_filter=False, without_timestamps=True)
                list(segments)   # the warm-up: CUDA failures (missing cuBLAS) only show up on the first real inference
                return model, candidate, dev, compute
            except Exception as error:
                log("modelo %s em %s/%s falhou: %s: %s" % (candidate, dev, compute, type(error).__name__, error))
    raise RuntimeError("nenhum modelo Whisper utilizável em %s" % models_dir)


def transcribe(path: str, out_dir: str, info: dict, args) -> dict:
    started = time.monotonic()
    duration = float(info.get("duration") or 0.0)
    progress("transcribe", 0, "carregando o modelo de voz…", force=True)
    model, model_name, device, compute = load_whisper(default_models_dir(args), args.model, args.device)
    language = None if (args.language or "auto") in ("auto", "") else args.language
    progress("transcribe", 1, "transcrevendo (%s, %s)…" % (model_name, device), force=True)
    options = {}
    if float(args.max_seconds or 0.0) > 0:
        options["clip_timestamps"] = [0.0, float(args.max_seconds)]
    segments_iter, meta = model.transcribe(
        path, language=language, task="transcribe", beam_size=5, vad_filter=True, word_timestamps=False, condition_on_previous_text=True, **options
    )
    segments, dropped = [], 0
    for segment in segments_iter:
        text = (segment.text or "").strip()
        no_speech = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
        logprob = float(getattr(segment, "avg_logprob", 0.0) or 0.0)
        if not text or (no_speech > 0.6 and logprob < -1.0) or (is_silence_hallucination(text) and no_speech > 0.3):
            dropped += 1 if text else 0
            continue
        segments.append({"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": text})
        if duration:
            progress("transcribe", 100.0 * min(1.0, float(segment.end) / duration), "transcrição: %s / %s" % (fmt_ts(segment.end), fmt_ts(duration)))
    language_code = getattr(meta, "language", language or "auto")
    note = "" if segments else "nenhuma fala reconhecida (o detector de voz não ouviu fala: silêncio, música ou ruído)"
    result = {
        "language": language_code,
        "language_probability": round(float(getattr(meta, "language_probability", 0) or 0), 4),
        "duration": round(float(getattr(meta, "duration", duration) or duration), 3),
        "model": model_name,
        "device": device,
        "compute_type": compute,
        "dropped_segments": dropped,
        "note": note,
        "segments": segments,
        "elapsed": round(time.monotonic() - started, 2),
    }
    write_json_atomic(os.path.join(out_dir, "transcript.json"), result)
    with open(os.path.join(out_dir, "transcript.txt"), "w", encoding="utf-8") as handle:
        for segment in segments:
            handle.write("[%s-%s] %s\n" % (fmt_ts(segment["start"]), fmt_ts(segment["end"]), segment["text"]))
    return result


# ---------------------------------------------------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------------------------------------------------

def source_identity(path: str) -> dict:
    stat = os.stat(path)
    return {"path": os.path.abspath(path), "name": os.path.basename(path), "size": stat.st_size, "mtime": int(stat.st_mtime)}


def lower_priority() -> None:
    """Processing a long video saturates every core: below-normal keeps the app and the rest of the desktop responsive."""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Without the types ctypes passes the pseudo-handle (-1) as a 32-bit int and the call quietly fails.
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.SetPriorityClass.restype = wintypes.BOOL
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000)  # BELOW_NORMAL_PRIORITY_CLASS
    except Exception:
        pass


def cmd_ingest(args) -> int:
    lower_priority()
    source = os.path.abspath(args.input)
    if not os.path.isfile(source):
        die("Arquivo de mídia não encontrado: %s" % source, 2)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, "manifest.json")
    identity = source_identity(source)
    opts = {
        "scene": args.scene, "fps_floor": args.fps_floor, "dedup": args.dedup, "window": args.window, "max_frames": args.max_frames,
        "frame_width": args.frame_width, "grid": "%dx%d" % (args.cols, args.rows), "cell_width": args.cell_width,
        "model": args.model, "language": args.language, "no_transcribe": args.no_transcribe, "no_frames": args.no_frames,
        "max_seconds": args.max_seconds,
    }
    signature = options_signature(opts)
    if os.path.isfile(manifest_path) and not args.overwrite:
        try:
            with open(manifest_path, encoding="utf-8") as handle:
                previous = json.load(handle)
            same = previous.get("source", {}).get("size") == identity["size"] and previous.get("source", {}).get("mtime") == identity["mtime"]
            if same and previous.get("options_signature") == signature and previous.get("complete"):
                emit({"type": "result", "manifest": manifest_path, "summary": {"cached": True, **_summary(previous)}})
                return 0
        except (OSError, ValueError):
            pass

    progress("probe", 0, "lendo a mídia…", force=True)
    try:
        info = probe(source)
    except Exception as error:
        die("Não consegui abrir a mídia (%s: %s)" % (type(error).__name__, error), 2)
    kind = "video" if info["has_video"] else "audio"
    if not info["has_video"] and not info["has_audio"]:
        die("O arquivo não tem trilha de vídeo nem de áudio.", 2)
    limit = float(args.max_seconds or 0.0)
    if limit and info["duration"] > limit:
        info = {**info, "processed_duration": limit}
    progress("probe", 100, "%s · %s" % (kind, fmt_ts(info["duration"])), force=True)

    warnings: list[str] = []
    transcript_box: dict = {}
    transcript_error: list[str] = []
    want_audio = info["has_audio"] and not args.no_transcribe

    def run_transcript():
        try:
            transcript_box["value"] = transcribe(source, out_dir, info, args)
        except BaseException as error:    # a broken speech engine must not cost the user the frames
            transcript_error.append("%s: %s" % (type(error).__name__, error))
            log("transcrição falhou: %s" % transcript_error[-1])

    thread = None
    if want_audio:
        thread = threading.Thread(target=run_transcript, name="openclod-transcribe", daemon=True)
        thread.start()

    frames_result = {"frames": [], "decoded": 0, "candidates": 0, "damaged": {"packets": 0}, "elapsed": 0.0}
    notes: list[str] = []
    sheets: list[dict] = []
    if info["has_video"] and not args.no_frames:
        try:
            frames_result = extract_frames(source, out_dir, info, args)
            progress("sheets", 0, "montando as folhas de contato…", force=True)
            sheets = make_sheets(out_dir, frames_result["frames"], args.cols, args.rows, args.cell_width, 2)
            progress("sheets", 100, "%d folha(s)" % len(sheets), force=True)
        except Exception as error:
            warnings.append("frames: %s: %s" % (type(error).__name__, error))
            log("frames falharam: %s" % warnings[-1])
    damaged = frames_result.get("damaged") or {}
    if damaged.get("packets"):
        notes.append(
            "o vídeo tem %d trecho(s) danificado(s)%s: os frames desses trechos podem faltar"
            % (damaged["packets"], " e termina antes do fim" if damaged.get("ended_early") else "")
        )
    if thread is not None:
        thread.join()
    if transcript_error:
        warnings.append("transcrição: " + transcript_error[0])

    if "value" in transcript_box:
        transcript = transcript_box["value"]
    else:
        reason = "a mídia não tem trilha de áudio" if not info["has_audio"] else ("transcrição desligada" if args.no_transcribe else "falha na transcrição")
        transcript = {"language": None, "language_probability": 0, "segments": [], "note": reason, "model": None, "device": None}
    manifest = {
        "version": 1,
        "kind": kind,
        "source": identity,
        "info": info,
        "options": opts,
        "options_signature": signature,
        "frames": frames_result["frames"],
        "sheets": sheets,
        "transcript": transcript,
        "stats": {"decoded": frames_result["decoded"], "candidates": frames_result["candidates"], "kept": len(frames_result["frames"]), "frames_seconds": frames_result["elapsed"], "transcribe_seconds": transcript.get("elapsed")},
        "warnings": warnings,
        "notes": notes,
        "complete": not warnings,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    write_json_atomic(manifest_path, manifest)
    emit({"type": "result", "manifest": manifest_path, "summary": _summary(manifest)})
    return 0


def _summary(manifest: dict) -> dict:
    transcript = manifest.get("transcript") or {}
    return {
        "kind": manifest.get("kind"),
        "duration": (manifest.get("info") or {}).get("duration"),
        "frames": len(manifest.get("frames") or []),
        "sheets": len(manifest.get("sheets") or []),
        "segments": len(transcript.get("segments") or []),
        "language": transcript.get("language"),
        "warnings": manifest.get("warnings") or [],
    }


# ---------------------------------------------------------------------------------------------------------------------
# test helper: a small video with known scenes, so the pipeline can be checked without a real file
# ---------------------------------------------------------------------------------------------------------------------

def cmd_make_test_video(args) -> int:
    path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    width, height, fps, seconds = 320, 240, 25, 12
    container = av.open(path, mode="w")
    video = container.add_stream("libx264" if "libx264" in av.codecs_available else "mpeg4", rate=fps)
    video.width, video.height, video.pix_fmt = width, height, "yuv420p"
    audio = container.add_stream("aac", rate=16000)
    audio.layout = "mono"
    colours = [(30, 60, 200), (200, 40, 40), (40, 180, 70), (230, 200, 40)]
    per_scene = fps * seconds // len(colours)
    for i in range(fps * seconds):
        image = np.zeros((height, width, 3), dtype=np.uint8)
        image[:, :] = colours[min(len(colours) - 1, i // per_scene)]
        x = 10 + (i % per_scene) * 2
        image[100:140, x:x + 30] = 255
        if i < per_scene:
            draw_text(image, 20, 30, "2026", 6)   # something for the OCR to read in the first scene
        for packet in video.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
            container.mux(packet)
    for packet in video.encode():
        container.mux(packet)
    samples = np.sin(2 * np.pi * 440 * np.arange(16000 * seconds) / 16000).astype(np.float32) * 0.1
    for start in range(0, len(samples), 1024):
        chunk = samples[start:start + 1024].reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="mono")
        frame.sample_rate = 16000
        for packet in audio.encode(frame):
            container.mux(packet)
    for packet in audio.encode():
        container.mux(packet)
    container.close()
    emit({"type": "result", "file": path, "scenes": len(colours), "seconds": seconds})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="openclod_media", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    probe_cmd = sub.add_parser("probe")
    probe_cmd.add_argument("input")
    make = sub.add_parser("make-test-video")
    make.add_argument("--out", required=True)
    ing = sub.add_parser("ingest")
    ing.add_argument("input")
    ing.add_argument("--out", required=True)
    ing.add_argument("--model", default="auto", help="auto (small on GPU, base on CPU) | tiny | base | small")
    ing.add_argument("--language", default="auto")
    ing.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ing.add_argument("--models-dir", default=None)
    ing.add_argument("--scene", type=float, default=0.30, help="scene-change score that forces a candidate frame (0..1)")
    ing.add_argument("--fps-floor", type=float, default=1.0, help="at least one candidate frame every N seconds")
    ing.add_argument("--dedup", type=float, default=8.0, help="percent of cells that must change for a frame to count as new")
    ing.add_argument("--window", type=int, default=4, help="how many kept frames a candidate is compared with")
    ing.add_argument("--max-frames", type=int, default=150)
    ing.add_argument("--frame-width", type=int, default=1280)
    ing.add_argument("--frame-quality", type=int, default=3)
    ing.add_argument("--grid", default="3x3")
    ing.add_argument("--cell-width", type=int, default=480)
    ing.add_argument("--max-seconds", type=float, default=0.0, help="process only the first N seconds (0 = all)")
    ing.add_argument("--no-transcribe", action="store_true")
    ing.add_argument("--no-frames", action="store_true")
    ing.add_argument("--overwrite", action="store_true")
    return parser


def main(argv) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "probe":
            emit({"type": "result", "info": probe(os.path.abspath(args.input))})
            return 0
        if args.command == "make-test-video":
            return cmd_make_test_video(args)
        match = re.fullmatch(r"(\d{1,2})x(\d{1,2})", args.grid)
        args.cols, args.rows = (int(match.group(1)), int(match.group(2))) if match else (3, 3)
        args.cols, args.rows = max(1, args.cols), max(1, args.rows)
        return cmd_ingest(args)
    except SystemExit:
        raise
    except BaseException as error:
        die("%s: %s" % (type(error).__name__, error), 1)
    return 1


if __name__ == "__main__":
    code = main(sys.argv[1:])
    sys.stderr.flush()
    os._exit(code)
