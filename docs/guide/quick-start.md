# Quick start

You need Node.js 18 or later, and an agent CLI that is installed and logged in, such as [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex).

<Steps>

## Install dugong

```bash
npm install -g @ykz9527/dugong
```

The [releases](https://github.com/ykz9527/dugong/releases) also have a single binary for macOS, Linux and Windows. See [Installation](./installation.md) for that and for running from source.

## Start the hub

```bash
dugong hub
```

The hub serves the web app on http://localhost:3006. On first run it prints an access token and saves it to `~/.dugong/settings.json`.

## Start a runner

In a second shell:

```bash
dugong runner start --workspace-root ~/code
```

The runner lets the hub start agents on this machine, in directories under `~/code`. Repeat `--workspace-root` to allow more than one directory.

## Write your first task

Open http://localhost:3006, sign in with the access token, and press +. Write what the agent should do, pick the machine, a working directory and an agent, and press Create with Start immediately ticked. The task moves to Running, and to Review when the agent's turn ends.

</Steps>

## Use it from your phone

Start the hub with `dugong hub --relay`. It prints a public HTTPS address and a QR code; open the address on your phone and sign in with the same token. Traffic through the relay is end-to-end encrypted, and the relay is off unless you pass `--relay`. To put the web app on your home screen, see [Install on your phone](./pwa.md).

## Start from the terminal instead

```bash
dugong claude
```

This runs Claude Code in your terminal and shows the same conversation in the web app. Send a message from the browser and the session switches to remote control; press space twice in the terminal to take it back. `dugong codex`, `dugong cursor` and the other [agents](./agents.md) work the same way.

## Next

- [Tasks and the assistant](./tasks.md): the six task states, worktrees, pull requests and schedules
- [Notifications](./notifications.md): push, Telegram and ServerChan
- [Deployment](./deployment.md): keep the hub and runner running after a reboot
