# Launch videos

[中文](README.zh-CN.md)

Two videos. Their narration (with Chinese captions) is in `lines-<video>.json`
and what happens on screen is in `record-<video>.mjs`. Each comes with English
captions and a Chinese-caption cut (same English voice, Chinese interface and demo data):

| Video | What | English captions | Chinese captions |
| --- | --- | --- | --- |
| `launch` | What dugong is | `out/launch/dugong-launch.mp4` | `out/launch-zh/dugong-launch-zh.mp4` |
| `why` | What it does differently from the usual setup | `out/why/dugong-why.mp4` | `out/why-zh/dugong-why-zh.mp4` |

Everything on screen is the real web app running on fake data
(`web/e2e-fixtures/assistant-panel-demo.*`) inside a stage page
(`web/e2e-fixtures/launch-video-stage.*`) that adds the terminals, the phone
lock screen, the comparison shots, the end card, captions and a pointer.

| File | Does |
| --- | --- |
| `lines-<video>.json` | The narration, one entry per line, its Chinese captions (`zh`, one per sentence), the voice and rate |
| `tts.py <video>` | Voice for each line with edge-tts; caption timings per sentence |
| `record-<video>.mjs` | Plays the script on the stage with Playwright and saves every frame |
| `stage-driver.mjs` | What both recorders share: open the stage, record, play a line, move the pointer |
| `assemble.py <video> [zh]` | Frames + voice → the `.mp4`, a silent copy, a `-web.mp4` small enough for GitHub (under 10MB), and `.srt` captions |

Each line lasts as long as its voice, or as long as its on-screen actions when
those take longer. Change the words in `lines-<video>.json` (keep one `zh`
entry per English sentence); change what happens on screen in
`record-<video>.mjs`.

```bash
# once: a venv with edge-tts and an ffmpeg that has H.264
uv venv ~/.venvs/dugong-video && VIRTUAL_ENV=~/.venvs/dugong-video uv pip install edge-tts imageio-ffmpeg

cd web && bunx vite --port 5288 --host 127.0.0.1 &          # the stage and the demo
cd design/launch/video
~/.venvs/dugong-video/bin/python tts.py why               # sends the narration text to Microsoft's TTS
node record-why.mjs                                         # 1–2 minutes
~/.venvs/dugong-video/bin/python assemble.py why
CAPTIONS=zh node record-why.mjs                             # the Chinese-caption cut, same voice
~/.venvs/dugong-video/bin/python assemble.py why zh
```

## Publishing

The videos stay out of git: every re-cut would add another full copy to the
history for good. Host them instead:

- **README**: drag `dugong-<video>-web.mp4` into the README editor (or any
  issue comment) on github.com. GitHub stores it and gives a
  `https://github.com/user-attachments/assets/…` link; that link alone on a
  line plays inline. A new cut is a new upload and a one-line README change.
  Free plans take videos up to 10MB, which is what `-web.mp4` is for.
  Upload in this (public) repo: attachments made in a private repo only
  play for people who can see that repo. The current links came from
  [issue #1](https://github.com/ykz9527/dugong/issues/1).
- **Downloads**: attach the full-quality `.mp4` to a GitHub release.
- **Sharing**: YouTube for the English cut, Bilibili for the Chinese one; the
  `.srt` files are there if a platform wants captions as a file.

## Notes

- `stage-driver.mjs` uses Playwright from the repo and the newest Chromium under
  `~/.cache/ms-playwright` (or `CHROME_PATH`).
- Chinese captions need a CJK font; the stage asks for Noto Sans CJK SC.
- If vite fails with `ENOSPC` on `watch`, the machine is out of inotify watchers:
  start it with `CHOKIDAR_USEPOLLING=true`.
- To watch the stage by hand: `http://127.0.0.1:5288/e2e-fixtures/launch-video-stage.html`,
  then call `stage.show('desk')` and friends in the console.
