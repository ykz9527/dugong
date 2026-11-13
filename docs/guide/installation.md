# Installation

```bash
npm install -g @ykz9527/dugong
dugong hub                                      # web app on http://localhost:3006
dugong runner start --workspace-root ~/code     # second shell
```

That is the whole setup on one machine. The rest of this page covers other ways to install, the settings, and hubs that serve more than one machine.

## Before you start

You need Node.js 18 or later for the npm package, and at least one agent CLI that is installed and logged in. Check with the agent's own command:

```bash
claude --version     # Claude Code
codex --version      # Codex
agent --version      # Cursor Agent
```

[Agents](./agents.md) lists all ten and how dugong starts each one.

## Other ways to install

### Prebuilt binary

Each [release](https://github.com/ykz9527/dugong/releases) has a single binary for macOS, Linux and Windows, with the web app built in. Download the archive for your platform, unpack it, and put `dugong` on your `PATH`:

```bash
tar -xzf dugong-linux-x64.tar.gz
chmod +x dugong
mv dugong ~/.local/bin/
```

On macOS, clear the quarantine flag first with `xattr -d com.apple.quarantine ./dugong`.

### From source

With [Bun](https://bun.sh) 1.3 or later:

```bash
git clone https://github.com/ykz9527/dugong.git && cd dugong
bun install
bun run build:single-exe
./cli/dist-exe/<target>/dugong --version
```

`<target>` is the Bun build target for your machine, such as `bun-linux-x64` or `bun-darwin-arm64`. To work on dugong without building a binary, run the hub, runner and web app from source as the [README](https://github.com/ykz9527/dugong#quick-start) shows.

## The three parts

| Part | Command | What it does |
|---|---|---|
| Hub | `dugong hub` | Serves the web app, stores tasks and chats in SQLite, moves tasks between states, sends notifications |
| Runner | `dugong runner start` | Starts agents on its machine when the hub asks. One per machine |
| Agent session | `dugong claude`, `dugong codex`, … | Wraps one agent and syncs it with the hub. The runner starts these for you; you can also start one in a terminal |

See [How it works](./how-it-works.md) for how they talk to each other.

## Hub settings

On first run the hub creates `~/.dugong/`, generates an access token, prints it, and saves it to `~/.dugong/settings.json`. The same directory holds the SQLite database, the runner's state and the logs. Set `DUGONG_HOME` to keep them somewhere else.

Each setting can come from an environment variable or from `settings.json`. An environment variable wins; when it is set and `settings.json` doesn't have the value yet, the hub saves it there.

| Variable | Default | `settings.json` key | What it sets |
|---|---|---|---|
| `CLI_API_TOKEN` | generated | `cliApiToken` | The access token |
| `DUGONG_LISTEN_HOST` | `127.0.0.1` | `listenHost` | Address the hub binds to. Use `0.0.0.0` to reach it from your LAN |
| `DUGONG_LISTEN_PORT` | `3006` | `listenPort` | Hub port |
| `DUGONG_PUBLIC_URL` | | `publicUrl` | Public address of the hub, used in notification links and by Telegram |
| `CORS_ORIGINS` | | `corsOrigins` | Extra allowed origins, comma-separated |
| `DUGONG_HOME` | `~/.dugong` | | Data directory |
| `DB_PATH` | inside `DUGONG_HOME` | | SQLite database file |
| `DUGONG_RELAY_FORCE_TCP` | `false` | | Use TCP for the relay when UDP is blocked |
| `TELEGRAM_BOT_TOKEN` | | `telegramBotToken` | See [Notifications](./notifications.md) |
| `SERVERCHAN_SENDKEY` | | `serverChanSendKey` | See [Notifications](./notifications.md) |
| `VAPID_SUBJECT` | `https://github.com/ykz9527/dugong` | | Contact address sent to browser push services |

The settings file has a [JSON Schema](/schemas/settings.schema.json) for editor completion:

```json
{
  "$schema": "https://raw.githubusercontent.com/ykz9527/dugong/main/docs/public/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "listenPort": 3006
}
```

### Generated session titles

The rename dialog in a session has a Generate button. It works once all three of these are set on the hub:

```bash
export DUGONG_TITLE_PROVIDER_BASE_URL="https://api.openai.com/v1"   # any OpenAI-compatible Chat Completions API
export DUGONG_TITLE_PROVIDER_API_KEY="..."
export DUGONG_TITLE_PROVIDER_MODEL="gpt-4o-mini"
```

The hub calls the provider only when you press Generate, and sends it recent visible messages from that session. The key never reaches the browser.

## Agents on another machine

One hub can drive runners on several machines. Install dugong on each machine, point it at the hub, and start a runner there:

```bash
export DUGONG_API_URL="http://your-hub:3006"
dugong auth login            # asks for the access token and saves it
dugong runner start --workspace-root ~/code
```

Instead of `dugong auth login` you can set `CLI_API_TOKEN`. `dugong auth status` shows where the token comes from, and `dugong auth logout` removes it. If the hub sits behind an access proxy, `DUGONG_EXTRA_HEADERS_JSON` adds headers to every request, for example `'{"Cookie":"CF_Authorization=..."}'`.

Each machine gets its own ID, stored in its `settings.json`. Its runner appears under Settings → Machines, and in the machine picker when you write a task.

## The runner

```bash
dugong runner start --workspace-root ~/code --workspace-root ~/work
dugong runner status
dugong runner logs                    # prints the path of the latest log
dugong runner list                    # sessions this runner started
dugong runner stop-session <id>
dugong runner stop
```

`--workspace-root` sets which directories the web app may browse and start agents in. Without it, you can only type a path by hand. Stopping the runner doesn't stop the agents it started.

`dugong runner start` detaches and returns. Under a service manager use `dugong runner start-sync`, which stays in the foreground; see [Deployment](./deployment.md).

## Diagnostics

```bash
dugong doctor          # version, settings (token redacted), runner state, processes, recent logs
dugong doctor clean    # kill stray dugong processes
```

`dugong doctor` doesn't contact the hub, so it works when the hub is down.

## Security

Every API call needs a token derived from the access token. Anyone with the token can start agents and run commands on your machines, so keep it out of chats, issues and screenshots. For use away from home, prefer the relay or a private network such as Tailscale to opening the port, and put HTTPS in front of any public address.
