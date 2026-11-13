# FAQ

## Using it

### Which agents does it run?

Claude Code, Codex, Cursor Agent, GitHub Copilot, Grok Build, Kimi, OpenCode, Pi, Antigravity and DeepSeek Harness. See [Agents](./agents.md).

### Do I need the runner?

To start tasks from the web app, yes: the runner is what starts agents on a machine. A session you start yourself with `dugong claude` works without it.

### Why is my task still in Running when the agent looks done?

The agent is still waiting on something it started: a subagent, or a background command it declared. The task card shows how many. When they finish, the task moves to Review. See [the six states](./tasks.md#the-six-states).

### Why did my task go to Blocked?

Something outside the task broke: the session died, the runner refused to start it, or the prompt never reached the agent. The usual causes are a runner that isn't running, an agent CLI the runner can't find on its `PATH`, and an agent that isn't logged in.

### What happens if I restart the hub in the middle of a task?

The agent keeps working. The hub keeps its task where it was and picks the session up again when it reconnects. A session only ends if you stop the task, kill the process, reboot, or the agent crashes.

### Can I see what files changed?

Yes. A session has a Files tab with the project's files, its git status and diffs, and a Terminal tab with a shell on the agent's machine.

### Is it free?

Yes. dugong is open source under AGPL-3.0.

## Setup

### How do I reach the hub from my phone?

On the same Wi-Fi, set `DUGONG_LISTEN_HOST=0.0.0.0`, restart the hub, and open `http://<your-computer-ip>:3006`. From anywhere else, start the hub with `dugong hub --relay` and open the address it prints, or use Tailscale or your own tunnel. Push notifications and installing the app need HTTPS, which the relay provides. See [Deployment](./deployment.md#reach-the-hub-from-outside).

### What's the access token for?

It signs you in to the web app, connects runners and agent sessions to the hub, and binds Telegram. The hub generates it on first run and saves it in `~/.dugong/settings.json` as `cliApiToken`.

### Where is my data?

In `~/.dugong`, or wherever `DUGONG_HOME` points: the SQLite database, the settings and the access token. Nothing leaves your machine unless you turn on the relay or a notification channel; see [Privacy](../privacy.md).

### I already use HAPI. Can both run on one machine?

Yes. dugong keeps its data in `~/.dugong` and HAPI in `~/.hapi`. Both use port 3006 by default, so move dugong to another port, for the hub and the runner:

```bash
export DUGONG_LISTEN_PORT=3008
export DUGONG_API_URL=http://localhost:3008
```

A HAPI database can't be imported, because the schemas have diverged. Don't point `DUGONG_HOME` at `~/.hapi`: dugong would migrate the database, and HAPI couldn't open it afterwards. Start fresh; you can resume an old Claude Code conversation with `dugong claude --resume <uuid>` or adopt it as a task.

### Can several people share a hub?

Yes. See [Several people on one hub](./namespace.md).

## Security

### Is it safe to expose the hub?

Every API call needs a token derived from the access token, and the generated token is 256 bits. Anyone who has it can start agents and run commands on your machines, so keep it private. For remote use, the relay (end-to-end encrypted) or a private network such as Tailscale is safer than opening the port. If you do expose it, put HTTPS in front.

## Troubleshooting

Start with `dugong doctor`. It prints the version, the settings with the token redacted, where the token comes from, the runner's state, the dugong processes and the recent log files. It doesn't contact the hub, so it works when the hub is down.

### "Connection refused"

The hub isn't running, or isn't where the CLI looks. Check that `dugong hub` is up, that `DUGONG_API_URL` points at it, and that a firewall isn't blocking the port.

### "Invalid token"

The token the CLI uses doesn't match the hub's. Run `dugong auth status` to see where it comes from, and `dugong auth login` to set it again.

### The runner won't start

```bash
dugong runner status
dugong runner logs        # prints the path of the latest log
dugong doctor clean       # kill stray dugong processes
```

### The relay never gets a certificate

If the hub keeps waiting for a trusted TLS certificate, UDP is probably blocked, often by a local proxy. Start it with `DUGONG_RELAY_FORCE_TCP=true dugong hub --relay`.

### Claude Code not found

Install it, or tell dugong where it is:

```bash
npm install -g @anthropic-ai/claude-code
export DUGONG_CLAUDE_PATH=/path/to/claude
```

Under systemd or launchd, the runner doesn't read your shell profile; set `PATH` in the service. See [Deployment](./deployment.md#start-at-boot).

### Where do I report bugs?

Open an issue on [GitHub](https://github.com/ykz9527/dugong/issues). Run `dugong doctor` and include its output.
