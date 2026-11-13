# 发布视频

[English](README.md)

两个视频。旁白（含中文字幕）在 `lines-<video>.json` 里，画面上发生的事在 `record-<video>.mjs` 里。每个视频有英文字幕版和中文字幕版。两版配音都是英文；中文字幕版的界面和演示数据是中文。

| 视频 | 内容 | 英文字幕 | 中文字幕 |
| --- | --- | --- | --- |
| `launch` | dugong 是什么 | `out/launch/dugong-launch.mp4` | `out/launch-zh/dugong-launch-zh.mp4` |
| `why` | 和常见做法相比有什么不同 | `out/why/dugong-why.mp4` | `out/why-zh/dugong-why-zh.mp4` |

画面上都是真实的 web 应用，跑在假数据上（`web/e2e-fixtures/assistant-panel-demo.*`），外面套一个舞台页（`web/e2e-fixtures/launch-video-stage.*`）。终端、手机锁屏、对比镜头、片尾、字幕和鼠标指针是舞台页自己画的。

| 文件 | 作用 |
| --- | --- |
| `lines-<video>.json` | 旁白，一行一条；`zh` 是这一行的中文字幕，每个英文句子对应一条；还有配音的声音和语速 |
| `tts.py <video>` | 用 edge-tts 给每行生成配音，并算出每句字幕的时间 |
| `record-<video>.mjs` | 用 Playwright 在舞台上演一遍脚本，保存每一帧 |
| `stage-driver.mjs` | 两个录制脚本共用的部分：打开舞台、录制、播一行旁白、移动指针 |
| `assemble.py <video> [zh]` | 把帧和配音合成 `.mp4`，另出无声版、能传到 GitHub 的压缩版 `-web.mp4`（10MB 以内）和 `.srt` 字幕 |

每一行的时长取配音长度和画面动作时长里较长的那个。改词改 `lines-<video>.json`（`zh` 的条数要和英文句子数一致）；改画面上发生的事改 `record-<video>.mjs`。

```bash
# 第一次：建一个装了 edge-tts 和带 H.264 的 ffmpeg 的虚拟环境
uv venv ~/.venvs/dugong-video && VIRTUAL_ENV=~/.venvs/dugong-video uv pip install edge-tts imageio-ffmpeg

cd web && bunx vite --port 5288 --host 127.0.0.1 &          # 舞台页和 demo
cd design/launch/video
~/.venvs/dugong-video/bin/python tts.py why               # 旁白文字会发给微软的 TTS 服务
node record-why.mjs                                         # 1–2 分钟
~/.venvs/dugong-video/bin/python assemble.py why
CAPTIONS=zh node record-why.mjs                             # 中文字幕版，配音相同
~/.venvs/dugong-video/bin/python assemble.py why zh
```

## 发布

视频不进 git：每重出一版，历史里就永久多一份完整文件。放到外面：

- **README 里内嵌播放**：在 github.com 上编辑 README（或者随便一个 issue 的评论框），把 `dugong-<video>-web.mp4` 拖进去。GitHub 会存下来并给一个 `https://github.com/user-attachments/assets/…` 链接，这个链接单独占一行就能直接播放。以后换新版本，就是重新上传一次、改 README 里的一行。免费账号视频上限 10MB，`-web.mp4` 就是为这个压的。要在这个公开仓库里上传：私有仓库里传的附件，只有能看到那个仓库的人才能播放。现在用的链接来自 [issue #1](https://github.com/ykz9527/dugong/issues/1)。
- **下载**：把高清 `.mp4` 挂到 GitHub Release 上。
- **分享**：英文版发 YouTube，中文字幕版发 B 站；平台要单独的字幕文件就用 `.srt`。

## 备注

- `stage-driver.mjs` 用仓库里的 Playwright，以及 `~/.cache/ms-playwright` 下最新的 Chromium（也可以用 `CHROME_PATH` 指定）。
- 中文字幕需要中文字体，舞台页用的是 Noto Sans CJK SC。
- vite 启动时报 `ENOSPC`（`watch`），说明这台机器的 inotify 监听数用完了，加 `CHOKIDAR_USEPOLLING=true` 再启动。
- 想手动看舞台：打开 `http://127.0.0.1:5288/e2e-fixtures/launch-video-stage.html`，在控制台里调 `stage.show('desk')` 等方法。
