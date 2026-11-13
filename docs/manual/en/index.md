# Illustrated feature manual

[English](index.md) · [简体中文](../index.md)

Find an interface control and follow its instructions. Every feature link opens the relevant section. Screenshots use real components with synthetic data, without private sessions, server credentials or personal files. English screenshots use the English interface; sample file or conversation content can still contain another language.

This manual covers the interface following the 0.30.0 release. Version 1.0.0 has not been released. Development version labels in screenshots do not indicate an available release. Known history-scrolling acceptance limitations are noted in the relevant chapter.

## Your first task

[Sign in](start.md#connect) → [Create a task](tasks.md#create) → [Send instructions](messages.md#send) → [Approve operations](permissions.md#approve) → [Inspect changes](files.md#changes) → [Review the PR](git.md#pr) → [Finish and archive](tasks.md#archive).

## Find a feature

| Chapter | Feature instructions |
| --- | --- |
| [Getting started and navigation](start.md) | [Connect and sign in](start.md#connect) · [Find your way around the desktop](start.md#layout) · [Use dugong on your phone](start.md#phone) |
| [Tasks, status and lifecycle](tasks.md) | [Browse and filter tasks](tasks.md#browse) · [Create a task](tasks.md#create) · [Adopt an existing session](tasks.md#adopt) · [Start, stop and change status](tasks.md#run) · [Archive, restore and delete](tasks.md#archive) |
| [Worktrees, branches and pull requests](git.md) | [Choose task isolation](git.md#isolation) · [Open and refresh a PR](git.md#pr) · [Read run history](git.md#history) |
| [Recurring tasks and scheduled messages](schedules.md) | [Schedule a recurring task](schedules.md#task) · [Pause, resume and run now](schedules.md#manage) · [Send a message later](schedules.md#message) |
| [Create and manage sessions](sessions.md) | [Create a standalone session](sessions.md#new) · [Switch sessions and resume work](sessions.md#switch) · [Use the session menu](sessions.md#menu) |
| [Write messages and read results](messages.md) | [Write, send and abort](messages.md#send) · [Attach files and reference sessions](messages.md#attachments) · [Choose models, effort and permissions](messages.md#agent-options) · [Read tool output, code and history](messages.md#read) |
| [Approve operations and answer questions](permissions.md) | [Allow or deny a tool operation](permissions.md#approve) · [Answer an agent question](permissions.md#answer) |
| [Scratchlist and message queue](scratchlist.md) | [Add, reorder and remove notes](scratchlist.md#notes) · [Move a note to the composer or queue](scratchlist.md#promote) |
| [Copy, export and share images](sharing.md) | [Share a conversation turn as an image](sharing.md#image) · [Export a whole conversation](sharing.md#export) |
| [Task assistant, memory and questions](assistant.md) | [Open the assistant and select a task scope](assistant.md#chat) · [Read, create and edit memory](assistant.md#memory) · [Handle pending questions](assistant.md#questions) · [Manage operations that no longer ask](assistant.md#grants) |
| [Workspace users and directory scope](users.md) | [Switch the selected user](users.md#switch) · [Add, rename and delete users](users.md#manage) · [Configure a user's directories](users.md#paths) |
| [Browse files, search and inspect diffs](files.md) | [Inspect staged and unstaged changes](files.md#changes) · [Browse directories, search and sort](files.md#browse) · [Read source, Markdown and diffs](files.md#preview) |
| [Remote terminal and command input](terminal.md) | [Open the terminal and check its connection](terminal.md#open) · [Command mode, direct input and paste](terminal.md#input) |
| [Settings: language and session summaries](settings-general.md) | [Change the interface language](settings-general.md#language) · [Configure session summaries](settings-general.md#summary) |
| [Settings: appearance, fonts and session display](settings-display.md) | [Choose appearance and colors](settings-display.md#theme) · [Adjust interface and terminal font sizes](settings-display.md#fonts) · [Customize session lists and headers](settings-display.md#lists) |
| [Settings: input behavior and toolbar](settings-chat.md) | [Choose what Enter does](settings-chat.md#enter) · [Arrange and hide composer tools](settings-chat.md#toolbar) · [Customize tool cards and conversation colors](settings-chat.md#cards) |
| [Settings: dictation and voice assistant](settings-voice.md) | [Choose a voice mode and connect](settings-voice.md#mode) · [Configure voice service credentials](settings-voice.md#credentials) · [Choose and preview a voice](settings-voice.md#voices) · [Adjust persona, delivery and diagnostics](settings-voice.md#advanced) |
| [Settings: machine names and connections](settings-machines.md) | [View and rename a machine](settings-machines.md#name) · [Troubleshoot a missing machine](settings-machines.md#connect) |
| [Settings: Git hosting credentials](settings-git.md) | [Add a host and token](settings-git.md#add) · [Inspect, replace and remove credentials](settings-git.md#remove) |
| [Settings: storage usage](settings-storage.md) | [Inspect database, WAL and shared-memory files](settings-storage.md#read) |
| [Settings: token usage](settings-usage.md) | [Choose a time range](settings-usage.md#range) · [Read cache and source breakdowns](settings-usage.md#breakdown) |
| [Settings: versions and project links](settings-about.md) | [Check versions and open the project](settings-about.md#version) |
| [Notifications and offline use](notifications.md) | [Enable browser notifications](notifications.md#browser) · [Recover a connection and use multiple devices](notifications.md#offline) |

## If you cannot find a control

| Symptom | Check first |
| --- | --- |
| No machine in the new-task form | Is its runner connected to the same hub? |
| The machine needs an update | Does its CLI/runner support the current interface capabilities? |
| A composer button is missing | Hidden tools in Chat settings, and the selected agent's capabilities |
| A task is missing | User directory scope, status and archived tasks |
| Storage or Token usage is absent | Are you signed in as the hub owner? |
| Voice is unavailable | Provider credentials, HTTPS, microphone permission and browser support |
| The phone layout differs | Mobile uses single-column screens and overlays; look for the same control labels |

## Maintain the manual

Verify changes against the real interface and source before updating screenshots. The capture environment uses synthetic API responses and must not use production data. See [Maintaining the manual](maintaining.md) for the source map and capture commands.
