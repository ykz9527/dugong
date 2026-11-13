# What dugong changes

Everything dugong adds on top of [upstream HAPI](https://github.com/tiann/hapi), and — more usefully when you are syncing — where the two overlap.

Regenerate the numbers with:

```bash
git fetch upstream
git diff --shortstat $(git merge-base upstream/main main) main
```

Fork point: upstream `f5a86a8d` (2026-08-23). Upstream has moved 147 commits past it since; nothing has been merged back yet.

The divergence comes in two layers, and they behave very differently on a sync:

| Layer | Size | Conflict risk |
|---|---|---|
| **Features** (tasks, task assistant, schedules, workspace users, composer permission mode, `/btw`) | 231 files, +23 876 / -486 — 97 new files, 134 upstream files edited | Concentrated in the files listed below |
| **Rebrand** (`dugong` bin and npm package, `DUGONG_*` env vars, `~/.dugong`, web restyle, iOS/Android removed) | Touches ~300 upstream files, mostly one-word renames; deletes `ios/`, `android/` | Wide but mechanical: every upstream hunk that mentions `HAPI_*` will conflict, and resolving it is a rename |

The cheapest way through a sync is usually: merge, accept upstream for the conflicting hunks, then re-run the rename (`HAPI_` → `DUGONG_`, `hapi` → `dugong` in CLI help) over the result.

The size row above was measured before the task assistant and schedules landed; regenerate it with the command at the top.

## The features

### 1. Tasks

Runs agents as tasks that move themselves. A task is a prompt, a working directory, and an agent flavor; the hub spawns a session per run and moves the task through its states (backlog, ready, running, blocked, review, done) as the agent works. The web app lists tasks in the sidebar, grouped by state; the kanban board that used to show them was dropped in 2026-11 (`85bfd3a4`), the state machine behind it was not.

**New, self-contained:**

| Area | Files |
|---|---|
| Types | `shared/src/task.ts` |
| Storage | `hub/src/store/tasks.ts`, `hub/src/store/taskStore.ts` |
| Policy | `hub/src/sync/taskOrchestrator.ts` — the state rules live here and nowhere else |
| Worktrees | `hub/src/sync/taskWorktree.ts` |
| Review / PRs | `hub/src/sync/taskReview.ts`, `hub/src/gitHost/` |
| HTTP | `hub/src/web/routes/tasks.ts`, `hub/src/web/routes/gitHost.ts` |
| UI | `web/src/components/Tasks/`, `web/src/routes/settings/git-host.tsx` |

**Schema:** nine migrations past the fork point, now at v34:

| Step | Adds |
|---|---|
| v25→v26 | `tasks`, `task_runs`, and a `sessions.task_id` back-pointer |
| v26→v27 | the review-column pull request, cached on the task |
| v27→v28 | `workspace_users` — who owns which directories |
| v28→v29 | `workspace_user_id` on push targets, so notifications reach only the owner's devices |
| v29→v30 | the task assistant: `workspace_users.assistant_session_id`, memory and grant tables |
| v30→v31 | `assistant_questions` — the assistant's "to answer" list |
| v31→v32 | `workspace_users.assistant_agent` — Claude or Codex behind the assistant |
| v32→v33 | `task_schedules` and their fire slots |
| v33→v34 | `task_schedules.session_mode` — each run fresh, or continuing the last conversation |

Upstream has since shipped a v26 of its own (an index for the immediate-queue heartbeat). The numbers now mean different things on the two sides, which is why dugong defaults to its own `~/.dugong` and does not import an upstream `~/.hapi`. The next upstream merge has to renumber one ladder — see "Likely to conflict" below.

**API:** new routes under `/api/tasks`, `/api/git-host`, `/api/assistant`, the task schedules, and `POST /api/sessions/:id/btw`. Git host tokens live in `settings.gitHostTokens`, not in the database.

### 2. Schedules

A task can carry a cron schedule in its own time zone. Each fire starts a run, fresh (new worktree, new session) or continuing the task's last conversation. Missed fires run once inside a grace window, overlaps are skipped or queued, a run past its limit is stopped, three failures in a row pause the schedule. Each fire leaves a slot row, unique per task, time and trigger, so a fire never runs twice.

| Area | Files |
|---|---|
| Scheduler | `hub/src/sync/taskScheduler.ts` |
| Storage | `hub/src/store/taskSchedules.ts` |
| HTTP | `hub/src/web/routes/taskSchedules.ts` |
| UI | `web/src/components/Tasks/TaskScheduleSection.tsx` |

### 3. The task assistant

One permanent assistant session per workspace user, beside the task they have open. It keeps memory the person can read and edit (scoped to the user, a repo or a task), can drive other task sessions through MCP tools behind per-tool standing grants, curates its memory before the hub compacts its context, and files uncertain decisions as questions instead of stopping on them. Claude or Codex can sit behind it.

| Area | Files |
|---|---|
| Session and context | `hub/src/sync/assistantService.ts`, `hub/src/sync/assistantCompaction.ts` |
| Storage | `hub/src/store/assistant.ts`, `hub/src/store/assistantStore.ts` |
| HTTP | `hub/src/web/routes/assistant.ts` (web), `hub/src/web/routes/cliAssistant.ts` (the agent's tools) |
| Tools | `cli/src/claude/utils/assistantTools.ts` |
| UI | `web/src/components/Assistant/`, `web/src/components/ToolCard/assistantTools.tsx` |

### 4. Permission mode in the composer

Independent of tasks: switch the agent's permission mode without leaving the conversation, and say when the switch actually binds. `acceptEdits` / `bypassPermissions` take effect on the next tool call; `auto` / `plan` are process flags and only bind at the next turn boundary — which never arrives while a permission request is held open, so the sheet offers to approve them.

Touches `shared/src/modes.ts` plus five files under `web/src/components/`.

### 5. Workspace users

One hub shared by several people. A user owns a set of directories; picking a user filters the task list, the assistant to work under those directories, and push notifications go only to that user's devices. Ownership is decided in one place, `isOwnedByWorkspaceUser` (`shared/src/workspaceUser.ts`).

| Area | Files |
|---|---|
| Rule | `shared/src/workspaceUser.ts` |
| HTTP | `hub/src/web/routes/workspaceUsers.ts`, `hub/src/web/routes/workspaceScope.ts` |
| Push | `workspace_user_id` on push targets (schema v29) |

## Names kept from HAPI

The rebrand renamed what users see, and dugong's own internals: the `dugong` binary and npm package, `DUGONG_*` environment variables, `~/.dugong`, the database file (`dugong.db`; a data directory that still has `pitwall.db` or `hapi.db` gets it renamed when the hub starts), the workspace packages `dugong-hub`, `dugong-web`, `dugong-docs` and `dugong-website`, and the `--dugong-role`, `--dugong-workspace-user` and `--dugong-add-dir` flags the runner passes to an assistant.

dugong was called pitwall until November 2026. The data directory is not moved for you: to keep an old install, stop the hub and the runner, `mv ~/.pitwall ~/.dugong`, and rename any `PITWALL_*` variables to `DUGONG_*`.

Some upstream names stay, on purpose:

| Name | Why it stays |
|---|---|
| `@hapi/protocol` (the `shared` package) | Imported in hundreds of files; renaming it would make every upstream change that touches an import conflict |
| The MCP server id `hapi` (tools are `mcp__hapi__*`) | Users' Claude Code permission rules name these tools; a rename would silently stop matching them |
| `hapi-push-relay` (`relay/`) | It is HAPI's iOS push relay, unchanged |
| `x-hapi-hook-token`, `hapi-hub:scratchlist/…` storage keys and similar wire or data formats | Changing them breaks running sessions and stored data for no visible gain |

## Where we touch upstream code

This is the list that matters when you rebase. Everything else is a new file and cannot conflict.

### Likely to conflict

| File | What we changed | Why it's risky |
|---|---|---|
| `cli/src/claude/utils/OutgoingMessageQueue.ts` | Forward `background_tasks_changed` past the visibility filter | **Already conflicted once.** Upstream actively maintains this gate — it changed from `type !== 'system'` to `isClaudeChatVisibleMessage(...)` in #1655. Our snapshot is deliberately *invisible*, so any upstream rewrite of this condition will drop it and silently break the background-task hold |
| `README.md` | Rewritten | Conflicts on any upstream edit. Always keep ours |
| `hub/src/store/index.ts` | Migration ladder + schema | **Already collided**: upstream's v26 is a different migration from ours. Merging needs a renumbered ladder plus a repair step for databases already at v29 |
| `web/src/lib/locales/{en,zh-CN}.ts` | +116 lines each | Append-only on both sides; conflicts are mechanical |

### Small, additive edits

Extension points rather than rewrites — a callback threaded through, a field added, a route registered:

```
hub/src/startHub.ts            wire the orchestrator
hub/src/sync/syncEngine.ts     background-task count
hub/src/sync/sessionCache.ts   background-task count, snapshot vs delta
hub/src/sync/backgroundTasks.ts  read the snapshot; fix the start counter
hub/src/sync/rpcGateway.ts     worktree + spawn plumbing
hub/src/socket/**              onBackgroundTaskCount callback
hub/src/web/server.ts          mount the new routes
hub/src/store/types.ts         task row types
shared/src/apiTypes.ts         task API types
shared/src/messages.ts         BACKGROUND_TASKS_SNAPSHOT_SUBTYPE
cli/src/runner/worktree.ts     worktree creation
cli/src/runner/run.ts          worktree env
cli/src/api/apiMachine.ts      board spawn params
cli/src/claude/claudeLocalLauncher.ts  same snapshot exemption as the queue
web/src/api/client.ts          16 task methods
web/src/router.tsx             task list in the sidebar
web/src/components/SessionList.tsx  group a task's worktree sessions by repo
web/src/hooks/useSSE.ts        task-updated events
```

## Where tasks deliberately part from agetor

The column rules follow agetor almost literally; the finish flow could not.

agetor's run is one process invocation, so a card in Review has already settled
and archiving it is uncontested. A Claude Code session does not exit between
turns, so *every* reviewable card here still owns a `running` run. agetor's
active-run guard on archive is defence-in-depth; ours would be a wall across the
only way to finish a task.

So `POST /tasks/:id/archive` keeps both of agetor's gates -- Done-only, and no
live run -- and adds `stopRun`, which stops the run the way Cancel does and then
archives. One extra thing happens that agetor leaves undone: cancelling settles
a run into `ready`, which is right for a run the operator stopped and wrong for
one stopped as a step of archiving, so the pre-archive column is restored.
agetor's own comment calls the state it leaves behind "contradictory"; it gets
away with it because an archived card is hidden either way.

Archiving's *teardown* follows agetor closely, because the reasoning behind it
holds here even harder. agetor stops the card's tmux session and its open
terminals, then detaches the worktree, keeping branch, commits, run history and
transcript; its stated reason is that a hidden card is one the user can no
longer reach to close those shells. Here the equivalent is a Claude
Code session that survives its own run, and there is a case agetor does not
have: `orphaned`. A restart settles the run row while the agent keeps going, so
the active-run gate sees nothing and the agent outlives every task affordance
that could stop it. Archive now retires the session unconditionally, gate or no
gate.

Two deliberate differences from agetor's teardown:

- **Teardown is synchronous, not deferred.** agetor queues it per workdir so the
  POST returns in milliseconds; its work is local `spawnSync`. Ours is one RPC
  to the machine holding the repo, and the operator needs its verdict --
  particularly the dirty one -- in the response rather than in a log.
- **Uncommitted work refuses the archive.** agetor detaches regardless. Here the
  card is the only route back to that worktree, so hiding it is precisely what
  must not happen while there is unsaved work in it. `forceWorktree` is the
  override, and the button names the file count before the operator takes it.

## Fixes that are not features

Found by running the thing, worth knowing because they were real bugs:

- **`backgroundTasks.ts` start counter** — only scanned `assistant` envelopes, but Claude Code files a `tool_result` under a `user` envelope. Background work went uncounted, so the hold never engaged.
- **The completion signal** — the hub looked for a `<task-notification>` message the SDK never sends. The real signal is the `background_tasks_changed` system message, which the CLI's queue dropped along with every other system message. That is why `OutgoingMessageQueue.ts` is on the conflict list.
- **`sessions.active` is only ever written `false`** — set on session-end and keep-alive expiry; a live session's `active = true` lives in `sessionCache`'s memory and never reaches the row. Any sweep keyed on that column in SQL declares healthy sessions dead. The boot sweep did exactly that.
- **A task's prompt could be lost to a 50ms race** — delivery is an emit into the session's socket room and nothing replays it, but `startTask` sent as soon as the spawn RPC returned the session id, which the runner reports *before* the CLI finishes connecting. An empty room silently swallowed the prompt; the card then sat in `running` with an agent that had never been told anything. Seen live: one card lost by 49ms while the next won by 2ms, and the abandoned agent eventually invented its own errand from a spec it found in the worktree. `startTask` now waits for the room to have an occupant.
- **The boot sweep moved cards it should not have** — a reviewable card still has a `running` run row behind it (a Claude Code session does not exit between turns), so an unguarded sweep dragged the whole Review column back to `ready` on every hub restart.

## Syncing

```bash
git fetch upstream
git rebase upstream/main
bun install && bun run typecheck
cd hub && bun test && cd ../web && bun run test
git push --force-with-lease origin main
```

`cli`'s `src/claude` suite has ~10 failures on upstream `main` itself — check against `upstream/main` before blaming a merge.
