# dugong web

React PWA for running and reviewing coding agents through a dugong hub: a task list, the agent sessions behind each task, and a task assistant.

## What it does

- Task list grouped by status (backlog, ready, running, blocked, review, done), with a count of tasks waiting on you.
- New task dialog: write a prompt or adopt an existing agent session, pick machine, agent, directory, permission mode and isolation (git worktree or in place).
- Task detail panel: lifecycle, pending approvals, run history, pull request status, schedules, start / stop / archive / delete.
- Session view: streaming chat, composer, permission approval, permission mode and model switches, scratchlist, files, terminal.
- Task assistant: one ongoing conversation per workspace user, with memory and questions it decided on your behalf.
- Folder browser for the roots a runner allows, settings, token usage.
- PWA install prompt and offline banner.

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, you can log in with `CLI_API_TOKEN:<namespace>` (or `CLI_API_TOKEN` for the default namespace), or pass it once as `?token=`.
- The login screen includes a hub picker; if unset, the app uses the same origin it was loaded from.
- The interface is in English or Simplified Chinese. English is the default; the choice is stored in `localStorage['hapi-lang']`.
- Live updates come from the hub via SSE.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to `/sessions`.
- `/sessions` - Task list (left) and, on desktop, the open session (right).
- `/sessions/$sessionId` - Session view.
- `/sessions/$sessionId/files` - Changed files and directory tree, with search.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Remote terminal.
- `/sessions/new` - Session form; only the share flow opens it, everything else starts as a task.
- `/browse` - Browse a machine's allowed workspace roots and start a task in a folder (shown when the runner sets `--workspace-root`).
- `/share` - Share-target landing (Web Share Target POST → `?id=`, or native `/share#url=&text=&title=`).
- `/settings` - Settings category hub (mobile) and responsive master-detail shell.
- `/settings/general` - Language and agent-wide options.
- `/settings/display` - Appearance, typography, colors, and session list preferences.
- `/settings/chat` - Message input, tool card, and conversation color preferences.
- `/settings/voice` - Everyday voice assistant preferences.
- `/settings/voice/voices` - Full-page voice picker.
- `/settings/voice/advanced` - Voice persona, tuning, and diagnostics.
- `/settings/machines` - Online machines; rename them.
- `/settings/git-host` - Git host tokens used to open pull requests.
- `/settings/storage` - Hub database size.
- `/settings/usage` - Cache-aware token usage dashboard for the hub owner.
- `/settings/about` - Application links and version information.

## Features

### Task list (`src/components/Tasks/TaskSwitcher.tsx`)

- Groups by status in the order blocked, review, running, ready, backlog, done; empty groups are hidden.
- A row opens the task's session, or the detail panel if it never started.
- Per-row status select (moving a task never starts or stops an agent) and details button.
- Filter by workspace user; archived tasks behind a toggle.

### New task (`src/components/Tasks/NewTaskDialog.tsx`)

- Prompt, optional title, machine, agent, working directory (picked with `DirectoryPicker.tsx` on that machine).
- Permission mode with a risk hint; git worktree or in-place isolation; base ref.
- Start immediately, or keep the task in backlog.
- Adopt an existing Claude or Codex session instead of writing a prompt (`AdoptSessionPicker.tsx`).

### Task detail (`src/components/Tasks/TaskDetail.tsx`)

- Lifecycle ruler, pending approvals with approve / deny, live permission mode switch.
- Prompt and metadata (agent, directory, branch, worktree, base ref), pull request status, run history, background agents.
- Schedules (`TaskScheduleSection.tsx`): presets or cron, time zone, overlap and catch-up rules, pause / resume / run now.
- Start, stop, open session, create or refresh a pull request, archive (with stop and dirty-worktree confirmations), restore, delete.

### Session view (`src/components/SessionChat.tsx`, `src/components/SessionHeader.tsx`)

- Message thread with infinite scroll, tool cards, and per-turn copy, fork, and share-as-image.
- Composer: send, queue while the agent is busy, abort, attachments, `@` mentions of other sessions, scheduled send.
- Permission mode, model, and effort controls; context size display.
- Permission approval, question, and input footers on tool cards.
- Session actions (`SessionActionMenu.tsx`): rename, copy reference, mark unread, export, archive, delete.
- Per-session scratchlist (`src/components/AssistantChat/ScratchlistPanel.tsx`)
  - Workbench panel for held notes/drafts; **distinct from the queue**.
  - Add/delete/reorder entries; promote to composer (copy) or queue (send).
  - Persists across reloads via `localStorage` keyed per session.
  - Keyboard shortcut: Ctrl/Cmd+Shift+S to focus the add-input.

### File browser and viewer (`src/routes/sessions/files.tsx`, `src/routes/sessions/file.tsx`)

- Changed files (staged / unstaged) and directory tree, with search.
- File content with syntax highlighting; staged / unstaged diff.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js over Socket.IO, with resize handling.

### Task assistant (`src/components/Assistant/`)

- Right-hand column on desktop, full-screen sheet on phones; opened from the task list toolbar.
- Pick yourself (a workspace user) first; each user has their own assistant and memory.
- Chat follows the selected task, or asks about all tasks.
- Memory tab: search, add, edit, delete, undo; standing grants.
- Questions tab: decisions the assistant already made, with its rationale and how to roll back; keep or change them.

### Voice

- Voice assistant and dictation; providers are configured in Settings → Voice.

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Uses CLI_API_TOKEN from the login prompt or `?token=`.
- JWT tokens with auto-refresh.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Tasks, sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Task, session, message and machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components (`Tasks/`, `Assistant/`, `AssistantChat/`, ...).
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.
- `src/lib/locales/` - English and Simplified Chinese strings.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```


If testing in Telegram, set:

- `DUGONG_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Tests

Unit tests run under vitest + jsdom:

```bash
bun run test:web
```

Component-level browser tests (real Chromium) live at the repo root under `e2e/`: scratchlist, composer copy, file preview, history loading, settings layout, share turn, terminal wrapping, typing replay.

```bash
bun run test:e2e          # headless
bun run test:e2e:ui       # Playwright UI mode (debug)
```

The scratchlist specs drive a Vite-served fixture page (`web/e2e-fixtures/scratchlist-fixture.html`)
that mounts the production `ScratchlistPanel` in isolation, so no hub /
auth / socket setup is required.

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by the dugong hub. The single executable can embed these assets.

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any dugong hub:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`DUGONG_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the Hub button on the login screen, and enter the dugong hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.
