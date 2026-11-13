# How it works

```
 phone / browser ──HTTPS / relay──▶  dugong hub  ◀──socket──  dugong runner ──starts──▶  claude / codex / …
                                    (tasks, chat,               (one per machine,
                                     SQLite, push)               where the repos are)
```

dugong has three parts. The hub serves the web app, stores tasks and chats, and moves tasks between states. A runner on each machine starts agents when the hub asks. Each agent runs inside a small dugong wrapper that sends its messages to the hub and passes yours back.

## The hub

`dugong hub` is one process with a SQLite database. It talks to the wrappers and runners over Socket.IO, and to the web app over a REST API plus a stream of server-sent events. It also keeps the task rules (`hub/src/sync/taskOrchestrator.ts`), runs schedules, and sends push, Telegram and ServerChan notifications.

The hub can run on your laptop or on a server. Your code never has to be on the hub's machine, only on the machines with runners.

## The runner

`dugong runner start` connects a machine to the hub. When you start a task, the hub asks that machine's runner to start an agent in the task's directory, or to create a git worktree first. `--workspace-root` limits the directories the runner will use.

Agents run detached from the runner and from the hub. Restart the hub, stop the runner or close the browser, and the agent keeps working; the hub picks the session up again when it reconnects. A session only ends when you stop the task, kill the process, reboot, or the agent crashes.

## The agent wrapper

Each session is an agent CLI wrapped by dugong: `dugong claude`, `dugong codex`, `dugong cursor` and so on. The wrapper forwards the agent's messages and permission requests to the hub, and your messages and answers back to the agent. It also gives the agent a few MCP tools, such as listing the other sessions on the hub.

A session has two modes:

| Mode | Who drives it | How you get there |
|---|---|---|
| Local | You, in the terminal, with the agent's own interface | Start it with `dugong claude` (or another agent); press space twice to come back from remote |
| Remote | The web app | Send a message from the browser; sessions the runner starts are remote from the beginning |

Either way it's one conversation, with one history.

## A permission request, step by step

1. The agent wants to run a command it hasn't been cleared for.
2. The wrapper sends the request to the hub, and the agent waits.
3. The hub moves the task to Review, sends a push notification to the devices of the person who owns the task, and a Telegram or ServerChan message if those are set up.
4. You tap Allow or Deny, in the web app or in Telegram.
5. The hub passes the answer back to the wrapper, the agent carries on, and the task goes back to Running.

## Reaching the hub from outside

The hub listens on `127.0.0.1:3006` by default. To reach it from elsewhere:

| Way | How |
|---|---|
| Your LAN | Set `DUGONG_LISTEN_HOST=0.0.0.0` and open `http://<your-ip>:3006` |
| The relay | `dugong hub --relay` prints a public HTTPS address and a QR code. Traffic is end-to-end encrypted (WireGuard plus TLS); the relay server is run by the HAPI project |
| Your own tunnel | Tailscale, a Cloudflare named tunnel, or a reverse proxy with HTTPS. See [Deployment](./deployment.md) |

## Where your data lives

Everything the hub keeps is in `~/.dugong` (or `DUGONG_HOME`): the database with tasks and chats, `settings.json` with the access token, and the logs. Your code stays in your repositories. See [Privacy](../privacy.md) for what leaves the machine and when.
