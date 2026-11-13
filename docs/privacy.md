---
title: Privacy
aside: false
---

# Privacy

dugong is software you run yourself. The dugong project runs no server, has no accounts, and collects nothing: no analytics, no telemetry, no crash reports. Your tasks, chats, settings and access token stay in `~/.dugong` on the machine that runs the hub, and your code stays in your repositories.

Data leaves your machines only in the cases below. All but the last are off until you turn them on.

## The agents

The agents dugong starts, such as Claude Code or Codex, send your prompts and the code they read to their own providers, as they would without dugong. Those providers' privacy policies apply. dugong doesn't add anything to that traffic.

## The relay

`dugong hub --relay` opens a tunnel through `relay.hapi.run`, a relay server run by the [HAPI project](https://github.com/tiann/hapi), not by dugong. The traffic through it is end-to-end encrypted, so the relay sees connection metadata, such as IP addresses and amounts of data, but not your content. Without `--relay` the hub makes no connection to it. To avoid it entirely, use your own tunnel or a private network; see [Deployment](./guide/deployment.md#reach-the-hub-from-outside).

## Push notifications

When you allow notifications in the web app, the hub sends each notification to your browser vendor's push service, which delivers it to your device: Google's for Chrome on Android, Apple's for Safari, Mozilla's for Firefox. A notification carries the session's name, the agent, and a short status line such as the tool waiting for permission, and those services handle it under their own policies. The hub signs these messages with its own keys, generated on your machine.

## Telegram and ServerChan

If you set `TELEGRAM_BOT_TOKEN` or `SERVERCHAN_SENDKEY`, the hub sends notification text, such as a session title and what the agent is waiting for, to Telegram or to ServerChan, which forwards it on to WeChat or wherever you set it up. When you open the web app inside Telegram, it loads Telegram's script from telegram.org.

## GitHub

If you add a token under Settings → Git hosts, the hub calls the GitHub API with it to open pull requests and read their checks. The branch itself is pushed by `git` on the agent's machine, with that machine's own credentials.

## Voice and generated titles

If you add a voice or dictation provider key (ElevenLabs, OpenAI, Deepgram, Groq, Gemini, Qwen, or a server of your own), the audio you record and the session context the voice assistant needs go to that provider. If you set the `DUGONG_TITLE_PROVIDER_*` variables, pressing Generate in the rename dialog sends recent messages from that session to the provider you configured.

## The terminal font

The terminal tab in the web app uses a Nerd Font. If your device doesn't have one installed, the browser downloads one from a public CDN (jsDelivr, or a mirror of it) when you open the terminal.

## Contact

Questions about this page: open an issue on [GitHub](https://github.com/ykz9527/dugong/issues). The source code is at [github.com/ykz9527/dugong](https://github.com/ykz9527/dugong), so you can check every claim above.
