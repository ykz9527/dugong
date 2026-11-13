---
layout: home
title: dugong
titleTemplate: Run your coding agents as tasks

hero:
  name: dugong
  text: Run five coding agents without watching five terminals.
  tagline: One task list for all your agents. Tasks move on their own as the agents work, and your phone tells you when one needs your OK.
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: dugong logo
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: How it works
      link: /guide/how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/ykz9527/dugong
---

## Try it

You need Node.js 18 or later, and an agent CLI that is installed and logged in, such as Claude Code or Codex.

```bash
npm install -g @ykz9527/dugong
dugong hub                                      # web app on http://localhost:3006
dugong runner start --workspace-root ~/code     # second shell: lets the hub start agents under ~/code
```

Open http://localhost:3006, sign in with the access token the hub printed, and press + to write your first task.

## What you get

A task is a prompt, a working directory and an agent. Press Start and dugong starts a session, sends the prompt, and moves the task through Backlog, Ready, Running, Blocked, Review and Done as the agent works. Most of the time you only look at the tasks in Review and Blocked.

Everyone on the hub has an assistant beside the task list. Ask it "can this one merge?" and it reads the task and its history before it answers. It can message, start, stop or answer a task, and asks you first until you allow that for good.

A task can run in a git worktree of its own and open a GitHub pull request when it's done. It can also run on a schedule, for example every weekday at 9:00.

dugong drives Claude Code, Codex and eight other agent CLIs on your own machines. Your code, chats and database stay there, in `~/.dugong`. Read [how it works](./guide/how-it-works.md) for the parts, or [tasks and the assistant](./guide/tasks.md) for the day-to-day.


## 中文功能图文手册

[打开可点击的功能目录](manual/index.md)，按任务、会话、助手、文件与设置查操作步骤和界面截图。
