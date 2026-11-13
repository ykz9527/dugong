# Why dugong

Running one coding agent is easy: open a terminal and talk to it. Running five is where it goes wrong. One is waiting for permission in a tab you haven't looked at for twenty minutes, one finished an hour ago, one died when its session dropped, and you only find out by clicking through every terminal.

dugong puts all of them in one task list, and moves each task as its agent works. A glance at Review and Blocked tells you which ones need you. When an agent asks for permission, your phone buzzes, and one tap lets it carry on.

## The name

A dugong (儒艮 in Chinese) is a sea cow, a calm animal that grazes on seagrass all day without hurrying. That's the pace dugong is for: your agents keep working, and you only look up when one of them needs you.

## Compared with other tools

Most tools for running agents side by side are a desktop app or a terminal on the machine in front of you, with a worktree per task. dugong has worktrees too. It differs in four ways:

1. It's a server you open from any browser, so your laptop and your phone show the same task list.
2. Every session from every agent reaches your phone, with notifications.
3. It follows the agent's turns, not its process. A Claude Code session stays alive between turns, so a tool that watches the process never sees it finish.
4. It has an assistant that reads the list with you, keeps notes you can edit, and can act on tasks once you allow it.

It doesn't have inline diff review with line comments, or a built-in preview browser. If those matter more to you than stepping away from your desk, a desktop tool may suit you better. If you run one agent at a time, the agent's own CLI is enough.

## dugong and HAPI

dugong is a fork of [HAPI](https://github.com/tiann/hapi), and keeps what HAPI does for driving an agent remotely: wrapping the agent CLIs, switching between terminal and phone, approving permissions from anywhere, the relay, Telegram. It adds the task list and everything around it:

| | Agent CLI alone | HAPI | dugong |
|---|:-:|:-:|:-:|
| Run Claude Code, Codex and others | yes | yes | yes |
| Control from a phone, approve permissions remotely | | yes | yes |
| Native iOS and Android apps | | yes | web app only |
| Tasks that move by themselves | | | yes |
| Task assistant with editable memory | | | yes |
| Scheduled runs | | | yes |
| A worktree per task, and pull requests | | | yes |
| Several people on one hub | | | yes |

The two can run side by side on one machine; see the [FAQ](./faq.md#i-already-use-hapi-can-both-run-on-one-machine). For the full list of changes, see [What dugong changes in HAPI](../divergence.md).
