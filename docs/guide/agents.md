# Agents

dugong runs ten agent CLIs. Each must be installed and logged in on the machine where its runner is; dugong starts it, it doesn't install it.

| Agent | Command | How dugong drives it | Terminal mode | Permission modes |
|---|---|---|:-:|---|
| Claude Code | `dugong` or `dugong claude` | Its terminal UI locally, the Claude Agent SDK remotely | yes | `default` `acceptEdits` `auto` `bypassPermissions` `plan` |
| Codex | `dugong codex` | Its terminal UI locally, `codex app-server` remotely | yes | `default` `auto` `read-only` `safe-yolo` `yolo`, plus a `plan` collaboration mode |
| Cursor Agent | `dugong cursor` | ACP (`agent acp`) | yes | `default` `plan` `ask` `debug` `autoReview` `yolo` |
| GitHub Copilot | `dugong copilot` | ACP (`copilot --acp --stdio`) | yes | `default` `read-only` `safe-yolo` `yolo` |
| Grok Build | `dugong grok` | ACP (`grok agent stdio`) | yes | `default` `auto` `plan` `bypassPermissions` |
| Kimi | `dugong kimi` | ACP (`kimi acp`) | yes | `default` `read-only` `safe-yolo` `yolo` |
| OpenCode | `dugong opencode` | ACP (`opencode acp`) | yes | `default` `plan` `yolo` |
| Pi | `dugong pi` | `pi --mode rpc` | no | none; Pi approves everything |
| Antigravity | `dugong agy` | ACP (`agy acp`) | no | `request-review` `always-proceed` |
| DeepSeek Harness | `dugong dsh` | ACP (`dsh-acp-demo` or a server you configure) | no | set by the DSH composition |

"Terminal mode" means you can also run the agent in your own terminal through dugong and switch between terminal and browser. The others only run under the web app. Gemini CLI was removed after Google stopped serving it; `dugong gemini` prints an error, and old Gemini sessions stay readable.

## Permission modes

Pick the mode when you write a task or start a session, and change it from the composer while the session runs. From a terminal, use `--permission-mode <mode>`, or `--yolo` where the agent has it.

Claude Code and Codex start in `auto`; the others start in `default`. In `default`, the agent stops at every tool it hasn't been cleared for, which for a task you started from your phone means answering prompts instead of reading results. In `auto` the agent decides, and still asks about what it considers risky. Pick `default` when you want to approve each step; dugong never overrides a mode you chose.

Switching to `auto` or `plan` while a turn is running takes effect when the next turn starts, because both are flags on the agent process. The composer says so when that happens.

## Terminal and browser

```bash
dugong claude               # start Claude Code in this terminal
dugong resume               # pick a session on this machine to continue here
dugong resume <session-id>  # continue a specific one
```

A session started in the terminal shows up in the web app. Send it a message from the browser and it switches to remote control; press space twice in the terminal to take it back. Either way it is one conversation.

`dugong claude --resume <uuid>` picks up a Claude Code conversation that you had without dugong. A conversation you had with plain `claude` or `codex` can also become a task: choose Adopt a session when you write the task.

## Notes per agent

### Claude Code

The default agent, and the one most of dugong's features are tested with. Set `DUGONG_CLAUDE_PATH` if `claude` isn't on the runner's `PATH`. `/btw` asks a side question while Claude works, without interrupting the turn.

### Codex

Remote sessions run `codex app-server` and talk JSON-RPC to it. Codex's `plan` collaboration mode is separate from its permission modes.

### Cursor Agent

Install with `curl https://cursor.com/install -fsS | bash` (Windows: `irm 'https://cursor.com/install?win32=true' | iex`); the command is `agent`.

```bash
dugong cursor --plan                      # or --mode plan / --mode ask
dugong cursor --auto-review
dugong cursor resume <chatId>             # or --continue for the latest chat
dugong cursor --cursor-worktree feature-x # Cursor's own worktree
dugong cursor --cursor-add-dir ../shared  # extra workspace root, repeatable
```

From the web app, `/worktree`, `/apply-worktree`, `/delete-worktree`, `/add-dir`, `/compact`, `/model` and a few others pass through to Cursor. Terminal-only commands such as `/config` and `/mcp` don't work remotely.

### Grok Build

Install with `curl -fsSL https://x.ai/cli/install.sh | bash`. On a headless machine, log in once with `grok login --device-auth`, or set `XAI_API_KEY` in the runner's environment.

```bash
dugong grok --model grok-4.5 --effort low
dugong grok --yolo        # same as --permission-mode bypassPermissions
```

The web app lists Grok's models and effort levels and can switch them between turns. `auto` needs a Grok account and build that offer it; otherwise dugong falls back to `default` and says so in the chat.

### Pi

Runs as `pi --mode rpc`. From the web chat, `/compact`, `/session`, `/model` and `/help` map to Pi's RPC calls; other Pi terminal commands show a notice instead of being sent to the model.

### Antigravity

Runs as `agy acp`. In `request-review`, a tool call that agy's own rules don't already allow shows up as a permission card, the same as with the other ACP agents. Allow it once, or allow it for the rest of the session, and the turn carries on. agy has no "always" option of its own, so dugong remembers session approvals itself and never writes them to agy's `settings.json`. `always-proceed` approves every request. agy decides what to ask from its own `settings.json`: if `toolPermission` there is `always-proceed`, agy asks nothing, even under `request-review`. Sessions started under the earlier `agy -p` transport resume in the same conversation. MCP servers come from agy's own config.

### DeepSeek Harness

`dugong dsh` starts `dsh-acp-demo` by default. Install a pinned version with `npm install -g @deepseek-ai/dsh-acp-demo@0.1.0-rc.7`, or point dugong at another ACP server or a source checkout:

```bash
export DUGONG_DSH_ACP_COMMAND=pnpm
export DUGONG_DSH_ACP_ARGS_JSON='["--dir", "/path/to/deepseek-harness", "run", "demo:acp"]'
dugong dsh
```

DSH sessions start fresh each time and can't be resumed. Model choice and MCP servers are left to the DSH composition.
