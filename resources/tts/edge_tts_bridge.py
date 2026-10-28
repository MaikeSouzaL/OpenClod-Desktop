"""Small JSON bridge between Openclod and Microsoft Edge neural voices."""

import argparse
import asyncio
import base64
import json
import os
import re
import sys

import edge_tts


VOICE_RE = re.compile(r"^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$")


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


async def list_voices():
    voices = await edge_tts.list_voices()
    rows = []
    for voice in voices:
        if voice.get("Status") != "GA":
            continue
        rows.append(
            {
                "id": voice.get("ShortName", ""),
                "name": voice.get("FriendlyName") or voice.get("ShortName", ""),
                "culture": voice.get("Locale", ""),
                "localeName": voice.get("LocaleName", ""),
                "gender": voice.get("Gender", ""),
                "codec": voice.get("SuggestedCodec", ""),
                "categories": (voice.get("VoiceTag") or {}).get("ContentCategories", []),
                "personalities": (voice.get("VoiceTag") or {}).get("VoicePersonalities", []),
            }
        )
    emit(rows)


async def synthesize(output):
    text = base64.b64decode(os.environ.get("OPENCLOD_EDGE_TEXT", "")).decode("utf-8")
    voice = os.environ.get("OPENCLOD_EDGE_VOICE", "pt-BR-FranciscaNeural")
    rate = int(os.environ.get("OPENCLOD_EDGE_RATE", "0"))
    if not text.strip():
        raise ValueError("texto vazio")
    if not VOICE_RE.fullmatch(voice):
        raise ValueError("voz neural invalida")
    rate = max(-50, min(100, rate))
    communicator = edge_tts.Communicate(
        text,
        voice,
        rate=f"{rate:+d}%",
        volume="+0%",
    )
    await communicator.save(output)
    size = os.path.getsize(output)
    if size <= 0:
        raise RuntimeError("servico nao retornou audio")
    emit({"ok": True, "bytes": size, "voice": voice, "rate": rate})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-voices", action="store_true")
    parser.add_argument("--synthesize")
    args = parser.parse_args()
    try:
        if args.list_voices:
            asyncio.run(list_voices())
            return 0
        if args.synthesize:
            asyncio.run(synthesize(os.path.abspath(args.synthesize)))
            return 0
        raise ValueError("informe --list-voices ou --synthesize")
    except Exception as error:
        emit({"ok": False, "error": f"{type(error).__name__}: {error}"[:1000]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
