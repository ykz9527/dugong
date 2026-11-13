"""Synthesize each narration line with edge-tts.

Writes out/<video>/audio/<id>.mp3 and out/<video>/audio/cues.json:
  {id: {"duration": seconds, "chunks": [{"text", "start", "end"}]}}
where chunks are the caption pieces (sentences) with their times inside the line.

Usage: ~/.venvs/dugong-video/bin/python tts.py <video>     (launch | why; reads lines-<video>.json)
Sends the narration text to Microsoft's TTS service.
"""
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

import edge_tts
import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
VIDEO = sys.argv[1] if len(sys.argv) > 1 else "launch"
OUT = HERE / "out" / VIDEO / "audio"


def split_chunks(text: str) -> list[str]:
    # One caption per sentence; a colon also starts a new caption.
    parts = re.split(r"(?<=[.?!:])\s+", text.strip())
    return [p for p in parts if p]


def duration_of(path: Path) -> float:
    proc = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-i", str(path)], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", proc.stderr)
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


async def synth(line: dict, voice: str, rate: str) -> dict:
    path = OUT / f"{line['id']}.mp3"
    words: list[tuple[float, float, str]] = []
    communicate = edge_tts.Communicate(line["text"], voice, rate=rate, boundary="WordBoundary")
    with path.open("wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 1e7
                words.append((start, start + chunk["duration"] / 1e7, chunk["text"]))
    total = duration_of(path)
    chunks = []
    index = 0
    for piece in split_chunks(line["text"]):
        count = len(re.findall(r"[A-Za-z0-9']+", piece))
        own = words[index:index + count]
        index += count
        start = own[0][0] if own else (chunks[-1]["end"] if chunks else 0.0)
        end = own[-1][1] if own else start
        chunks.append({"text": piece, "start": round(start, 3), "end": round(end, 3)})
    return {"duration": round(total, 3), "chunks": chunks}


async def main() -> None:
    spec = json.loads((HERE / f"lines-{VIDEO}.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    cues = {}
    for line in spec["lines"]:
        for attempt in range(4):
            try:
                cues[line["id"]] = await synth(line, spec["voice"], spec["rate"])
                break
            except edge_tts.exceptions.NoAudioReceived:
                if attempt == 3:
                    raise
                await asyncio.sleep(2 + attempt * 2)
        print(f"{line['id']:>10}  {cues[line['id']]['duration']:5.2f}s  {len(cues[line['id']]['chunks'])} captions")
    (OUT / "cues.json").write_text(json.dumps(cues, indent=2))


asyncio.run(main())
