"""Turn the recorded frames and the narration into the finished video.

Reads out/<video>/timeline.json (record-<video>.mjs) and out/<video>/audio/ (tts.py). Writes:
  out/<video>/dugong-<video>.mp4         1920x1080, 30 fps, H.264 + AAC voiceover
  out/<video>/dugong-<video>-silent.mp4  the same picture with no audio (captions are burned in)
  out/<video>/dugong-<video>.srt         the captions, for platforms that take a caption file
  out/<video>/dugong-<video>-web.mp4     a smaller copy (about 5MB a minute and a half) under GitHub's
                                          10MB limit for videos attached to a README or issue

Usage: ~/.venvs/dugong-video/bin/python assemble.py <video> [zh]     (launch | why)
With zh: the Chinese-caption cut from out/<video>-zh/ (recorded with CAPTIONS=zh),
the same voice, and a Chinese .srt; written as dugong-<video>-zh.*
"""
import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
VIDEO = sys.argv[1] if len(sys.argv) > 1 else "launch"
ZH = len(sys.argv) > 2 and sys.argv[2] == "zh"
OUT = HERE / "out" / (f"{VIDEO}-zh" if ZH else VIDEO)
AUDIO = HERE / "out" / VIDEO / "audio"
NAME = f"dugong-{VIDEO}-zh" if ZH else f"dugong-{VIDEO}"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def main() -> None:
    timeline = json.loads((OUT / "timeline.json").read_text())
    cues = json.loads((AUDIO / "cues.json").read_text())
    zh = {line["id"]: line.get("zh", []) for line in json.loads((HERE / f"lines-{VIDEO}.json").read_text())["lines"]}
    frames = timeline["frames"]
    end = timeline["end"]

    # Screencast frames arrive only when the page changes; each one is held
    # until the next, which the concat demuxer expresses as a duration.
    listing = []
    for index, frame in enumerate(frames):
        until = frames[index + 1]["t"] if index + 1 < len(frames) else end
        listing.append(f"file 'frames/{frame['file']}'\nduration {max(until - frame['t'], 0.001):.4f}")
    listing.append(f"file 'frames/{frames[-1]['file']}'")
    (OUT / "frames.txt").write_text("\n".join(listing) + "\n")

    silent = OUT / f"{NAME}-silent.mp4"
    subprocess.run([
        FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(OUT / "frames.txt"),
        "-vf", "fps=30,scale=in_range=pc:out_range=tv,format=yuv420p", "-color_range", "tv",
        "-c:v", "libx264", "-preset", "slow", "-crf", "17",
        "-movflags", "+faststart", str(silent)
    ], check=True)

    # Each line's voice starts where its line started on the recording.
    inputs, filters = [], []
    for index, line in enumerate(timeline["lines"]):
        inputs += ["-i", str(AUDIO / f"{line['id']}.mp3")]
        delay = int(round(line["start"] * 1000))
        filters.append(f"[{index + 1}:a]adelay={delay}|{delay}[a{index}]")
    mix = "".join(f"[a{i}]" for i in range(len(timeline["lines"])))
    filters.append(f"{mix}amix=inputs={len(timeline['lines'])}:normalize=0,apad[aout]")
    subprocess.run([
        FFMPEG, "-y", "-loglevel", "error", "-i", str(silent), *inputs,
        "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart",
        str(OUT / f"{NAME}.mp4")
    ], check=True)

    # Screen recordings compress well: text stays sharp at CRF 28 with the
    # still-image tune, at under half the size.
    subprocess.run([
        FFMPEG, "-y", "-loglevel", "error", "-i", str(OUT / f"{NAME}.mp4"),
        "-c:v", "libx264", "-preset", "veryslow", "-crf", "28", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(OUT / f"{NAME}-web.mp4")
    ], check=True)

    entries = []
    for line in timeline["lines"]:
        chunks = cues[line["id"]]["chunks"]
        for index, chunk in enumerate(chunks):
            start = line["start"] + (0 if index == 0 else chunk["start"])
            stop = line["start"] + (chunks[index + 1]["start"] if index + 1 < len(chunks) else chunk["end"] + 0.4)
            entries.append((start, stop, zh[line["id"]][index] if ZH else chunk["text"]))
    srt = "\n".join(f"{i + 1}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n" for i, (a, b, text) in enumerate(entries))
    (OUT / f"{NAME}.srt").write_text(srt)

    print(f"{OUT / (NAME + '.mp4')}  ({end:.1f}s, {len(frames)} frames)")


main()
