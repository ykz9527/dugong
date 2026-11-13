# dugong CLI

Run Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, or DeepSeek Harness sessions from your terminal and control them remotely through the dugong hub.

## What it does

- Starts Claude Code sessions and registers them with the dugong hub.
- Starts Codex mode for OpenAI-based sessions.
- Starts Cursor Agent mode for Cursor CLI sessions.
- Starts Grok Build locally or via ACP for remote sessions.
- Starts OpenCode mode via ACP and its plugin hook system.
- Starts DeepSeek Harness through an external ACP stdio server.
- Provides an MCP stdio bridge for external tools.
- Manages a background runner for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow

1. Start the hub and set env vars (see ../hub/README.md).
2. Set the same CLI_API_TOKEN on this machine or run `dugong auth login`.
3. Run `dugong` to start a session.
4. Use the web app or Telegram Mini App to monitor and control.

## Commands

### Session commands

- `dugong` - Start a Claude Code session (passes through Claude CLI flags). See `src/index.ts`.
- `dugong codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `dugong codex resume <sessionId>` - Resume existing Codex session.
- `dugong cursor` - Start Cursor Agent mode. See `src/cursor/runCursor.ts`.
  Supports `dugong cursor resume <chatId>`, `dugong cursor --continue`, `--mode plan|ask`, `--yolo`, `--model`.
  Local and remote modes supported; remote uses `agent -p` with stream-json.
- `dugong grok` - Start Grok Build mode. See `src/grok/runGrok.ts`.
- `dugong opencode` - Start OpenCode mode via ACP. See `src/opencode/runOpencode.ts`.
  Note: OpenCode supports local and remote modes; local mode streams via OpenCode plugins.
- `dugong dsh` - Start DeepSeek Harness through ACP. See `src/dsh/runDsh.ts`.
  DSH is remote-only and its ACP server must be configured separately.
- `dugong resume [sessionId]` - List resumable sessions for this machine or resume one locally.
- `dugong ping-peer <session-id-prefix> <message>` - Resume (if needed) and message another session. Prefer this or MCP `ping_peer` / `list_peers` over reinventing JWT+curl. Also `--message-file` / `--list`.
- `dugong inspect-peer <session-id-or-prefix>` - Read-only peer metadata + recent message text (no resume). Prefer this or MCP `inspect_peer` when a user cites `[title](/sessions/<id>)` or Copy-reference `See session "…" (/sessions/<id>) for context`. `/sessions/<id>` is a hub path, not a local file. Optional `--limit`.

### Resume a remote session locally

```bash
dugong resume
dugong resume <session-id>
```

`dugong resume` lists resumable sessions for the current machine. `dugong resume <session-id>` hands off an active remote session and opens the same dugong session in the local terminal.

### Authentication

- `dugong auth status` - Show authentication configuration and token source.
- `dugong auth login` - Interactively enter and save CLI_API_TOKEN.
- `dugong auth logout` - Clear saved credentials.

See `src/commands/auth.ts`.

### Runner management

- `dugong runner start` - Start runner as detached process.
- `dugong runner stop` - Stop runner gracefully.
- `dugong runner status` - Show runner diagnostics.
- `dugong runner list` - List active sessions managed by runner.
- `dugong runner stop-session <sessionId>` - Terminate specific session.
- `dugong runner logs` - Print path to latest runner log file.

Both `start` and `start-sync` accept repeatable `--workspace-root <path>` (or `--workspace-root=<path>`). When set:

- The web `/browse` page surfaces scoped file trees rooted at those paths.
- The runner refuses `list-directory` and `spawn-session` requests for paths outside the configured roots.
- `~` and `~/foo` are expanded.

Omitting the flag keeps the legacy behavior: no scoping, no `/browse` feature.

See `src/runner/run.ts`.

### Diagnostics

- `dugong doctor` - Show full diagnostics (version, runner status, logs, processes).
- `dugong doctor clean` - Kill runaway dugong processes.

See `src/ui/doctor.ts`.

### Other

- `dugong mcp` - Start MCP stdio bridge. See `src/codex/happyMcpStdioBridge.ts`.
- `dugong hub` - Start the bundled hub (single binary workflow).
- `dugong server` - Alias for `dugong hub`.

## Configuration

See `src/configuration.ts` for all options.

DeepSeek Harness ACP uses `dsh-acp-demo` by default. Override the executable or
its arguments without shell parsing:

```bash
export DUGONG_DSH_ACP_COMMAND=dsh-acp-demo
export DUGONG_DSH_ACP_CONFIG=/path/to/deepseek-harness/examples/acp-agent/cordis.yml
dugong dsh
```

For a source checkout, use JSON arguments:

```bash
export DUGONG_DSH_ACP_COMMAND=pnpm
export DUGONG_DSH_ACP_ARGS_JSON='["--dir", "/path/to/deepseek-harness", "run", "demo:acp"]'
```

The official ACP demo is fresh-session-only and does not support native resume,
model switching, MCP injection, or live tool/reasoning telemetry. dugong uses the
standard chat and pending one-shot permission surfaces; the ACP composition
owns the overall permission policy and dugong does not advertise resume or model
controls for DSH.

### Required

- `CLI_API_TOKEN` - Shared secret; must match the hub. Can be set via env or `~/.dugong/settings.json` (env wins).
- `DUGONG_API_URL` - Hub base URL (default: http://localhost:3006).

### Optional

- `DUGONG_HOME` - Config/data directory (default: ~/.dugong).
- `DUGONG_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `DUGONG_EXTRA_HEADERS_JSON` - JSON object of extra headers to send on CLI → hub requests, e.g. `{"Cookie":"CF_Authorization=..."}`. Can also be set as the `extraHeaders` object in `~/.dugong/settings.json` (environment variable wins).
- `DUGONG_CLAUDE_PATH` - Path to a specific `claude` executable.
- `DUGONG_DSH_ACP_COMMAND` - ACP server executable for `dugong dsh` (default: `dsh-acp-demo`).
- `DUGONG_DSH_ACP_CONFIG` - Optional `dsh-acp-demo --config` path.
- `DUGONG_DSH_ACP_ARGS_JSON` - Optional JSON array of ACP server arguments.
- `DUGONG_HTTP_MCP_URL` - Default MCP target for `dugong mcp`.

### Runner

- `DUGONG_RUNNER_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 60000).
- `DUGONG_RUNNER_HTTP_TIMEOUT` - HTTP timeout for runner control in ms (default: 10000).

### Worktree (set by runner)

- `DUGONG_WORKTREE_BASE_PATH` - Base repository path.
- `DUGONG_WORKTREE_BRANCH` - Current branch name.
- `DUGONG_WORKTREE_NAME` - Worktree name.
- `DUGONG_WORKTREE_PATH` - Full worktree path.
- `DUGONG_WORKTREE_CREATED_AT` - Creation timestamp (ms).

### Set for the wrapped agent

- `DUGONG_SESSION_ID` - The hub session id for the current run, exported into the wrapped agent/CLI child environment at spawn for every flavor (claude / codex / copilot / cursor / gemini / opencode / kimi / grok / pi), both runner-spawned and locally started sessions. Agents can read it to self-target "this chat" over the hub REST API or shell helpers without listing `/api/sessions`. Prefer the MCP `display_image` tool for inline media when it is available; use `DUGONG_SESSION_ID` for hub REST / shell tooling where MCP is not. To **list** peers on the same hub/namespace, prefer MCP `list_peers` (works from runner-spawned sessions without sitting on the hub host; excludes the calling session). To **read** another session, prefer MCP `inspect_peer` or `dugong inspect-peer`. To **message** another session, prefer MCP `ping_peer` or `dugong ping-peer` — do not reinvent JWT+curl. User citations look like `[title](/sessions/<id>)` or Copy-reference `See session "…" (/sessions/<id>) for context`; pass that `<id>` as `sessionIdPrefix`. Do not Grep/Glob `/sessions/<id>` as a local filesystem path. On a remote runner, configure matching `DUGONG_API_URL` + `CLI_API_TOKEN` (or `dugong auth login` / `~/.dugong/settings.json`) on the runner host so shell `dugong ping-peer --list` works; session CLI may export an explicit non-default hub URL into child env, but never mirrors `CLI_API_TOKEN` into wrapped agents.

  Lazy Codex (terminal) sessions export the id only after the hub row is materialized, which happens when the MCP bridge starts — before the agent process is spawned — so path-only self-targeting does not race a missing hub row.

  Example (shell fallback when MCP is unavailable) — path-only, self-targets the current session:

  ```bash
  bun scripts/tooling/hapi-display-image.mjs /absolute/path/to/image.png "optional title"
  ```

  Explicit other session (prefix or full uuid) still works; that path may list sessions.

## Storage

Data is stored in `~/.dugong/` (or `$DUGONG_HOME`):

- `settings.json` - User settings (machineId, token, onboarding flag). See `src/persistence.ts`.
- `runner.state.json` - Runner state (pid, port, version, heartbeat).
- `logs/` - Log files.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Cursor Agent CLI installed (`agent` on PATH) for `dugong cursor`. Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux), `irm 'https://cursor.com/install?win32=true' | iex` (Windows).
- Grok Build CLI installed (`grok` on PATH) for `dugong grok`. Authenticate with `grok login --device-auth` on headless runner machines, or set `XAI_API_KEY`.
- OpenCode CLI installed (`opencode` on PATH).
- Bun for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build:cli
bun run build:cli:exe
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

## Source structure

- `src/api/` - Bot communication (Socket.IO + REST).
- `src/claude/` - Claude Code integration.
- `src/codex/` - Codex mode integration.
- `src/cursor/` - Cursor Agent integration.
- `src/grok/` - Grok Build native TUI + ACP integration.
- `src/agent/` - Shared support for ACP-compatible agents.
- `src/opencode/` - OpenCode ACP + hook integration.
- `src/runner/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Related docs

- `../hub/README.md`
- `../web/README.md`
