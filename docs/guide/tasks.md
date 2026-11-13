# Tasks and the assistant

A task is a prompt, a working directory and an agent. You write it down, press Start, and dugong starts a session, sends the prompt, and moves the task between six states as the agent works. The task list in the sidebar is grouped by those states.

## The six states

| State | What it means | What you do |
|---|---|---|
| Backlog | Written down, not started | Start it when you're ready |
| Ready | It ran but didn't finish: cancelled, or an ordinary failure | Start it again |
| Running | The agent is working, or finishing background work it started | Nothing |
| Blocked | Something outside the task broke: the session died, the runner refused, the prompt never arrived | Fix that first |
| Review | The turn ended, or the agent is waiting for your OK or an answer | Read it, answer it, or mark it Done |
| Done | You marked it done | Archive it when you like |

Review and Blocked are shown in red, and most of the time they are the only tasks you need to look at. The difference between Ready and Blocked: starting a Ready task again may well work, while a Blocked task will fail the same way until you fix what's outside it.

A task goes to Review when the agent's turn ends, not when its process exits, because a Claude Code session stays alive between turns. If the agent is still waiting on a subagent or a long background command it declared, the task stays in Running until that finishes.

Restarting the hub doesn't interrupt the agent. The hub keeps the task where it was and picks the session up again when it reconnects.

The rules live in one file, `hub/src/sync/taskOrchestrator.ts`, in `columnForLiveSession` and `columnForFinishedRun`, each with a comment saying why.

## Writing a task

Press + above the task list. Write the prompt, then pick the machine, the working directory, the agent and its permission mode. Under Isolation, choose Run in place to work in the directory itself, or Git worktree to give the task a branch and a checkout of its own. Tick Start immediately, or start it later from the task.

Instead of a prompt you can adopt a session: a Claude Code or Codex conversation you already had, on that machine, becomes a task.

## Worktrees and pull requests

With Git worktree isolation, several tasks on one repo never touch each other's files. When a task is done, Open PR pushes its branch and opens a GitHub pull request; the task panel then shows the PR, its CI checks and any conflicts.

Opening a PR needs four things:

- the task runs in a worktree, so it has a branch
- its session is online, because the push runs on the agent's machine
- a token for the Git host, added under Settings → Git hosts (a classic GitHub token needs the `repo` scope)
- at least one commit on the branch; an agent that only answered a question has nothing to push

The token is stored in `~/.dugong/settings.json`, not in the database. `git push` uses the machine's own Git credentials, so both must work.

Separate worktrees stop tasks from overwriting each other, but two tasks can still merge cleanly and break at run time, for example when one renames a function and the other adds a call to the old name. Run the tests again after merging the second one.

## Finishing a task

Mark a task Done from Review, then Archive it. Archiving stops the task's session if it still has one and deletes the worktree checkout to free the disk. The branch and its commits stay, so you can unarchive the task and start it again. If the worktree has uncommitted changes, dugong asks before it deletes them.

Delete removes the task, its worktree, and its branch if that branch is merged. An unmerged branch is kept.

## Schedules

A task can run on a schedule: every few minutes, hourly, daily, weekly, monthly, or a cron expression, in the time zone you choose. Each run either starts fresh, in a new session and a new worktree, or continues the task's last conversation.

A run missed while the hub was down happens once when it comes back. Two runs of one task never overlap: the later one is skipped, or runs once after the earlier one ends, as you choose. A run past its time limit is stopped, and three failures in a row pause the schedule.

## The task assistant

Everyone on the hub gets their own assistant, in a panel next to the task they have open. Pick yourself in the user filter above the task list first; see [Several people on one hub](./namespace.md).

Ask it "can this one merge?" and it reads the task, its history and your earlier notes before it answers. Switch it to all tasks and it answers about the whole list.

It keeps memory you can read, edit and undo, under the Memory tab: notes about you, about a repository, or about one task. Say "remember …" and it writes one down.

It can message, start, stop or answer a task. Each time, it asks you first, until you choose Allow and remember for that kind of action. The Memory tab lists what it may do without asking, and you can revoke any of it there.

When a small decision is unclear, it goes ahead with its best pick and files the question under To answer, with its reason and how to back out. Keep its choice or change it; if you change it, it redoes the work.

The assistant runs on Claude or Codex, and each person picks which.

## Side questions

In a Claude session, `/btw` asks a side question while the agent works, without interrupting its turn.
