# dugong web design spec

> **Read this before changing any page, component or style under `web/`.** Take colours, type, sizes, radii, spacing and motion only from here. If you need a value that is not here, change this file first (say why), then the code.
>
> Since 2026-11-11.
> Source: the main screen (task list + session chat), restyled after [8bsite accounting-firm-website-template](https://github.com/8bsite/accounting-firm-website-template) (Swiss: black type on white, one red accent, hairline rules).
> Scope: whole web app. Main screen done; other pages go one at a time (§9) and get a line in §11.

## 0. Why

Before (2026-11-10, `web/src`): 311 hex colours, 64 rgba values, 68 Tailwind palette colours, 23 font sizes (down to 8px), 17 radii, a six-hue status palette and a blue accent.

Hard rule from the owner: **restyle only. No control, option or feature may disappear** (the kanban board was removed on purpose; nothing else).

## 1. Principles

1. Black, white, one red. Red marks what needs a human (review, blocked, a permission request, an error) and the hover of a primary button. Nothing else is red.
2. Hierarchy by weight, size and grey, not by hue.
3. Square boxes, round pills. Boxes (cards, panels, inputs, dialogs) have no radius; buttons and chips are full pills; dots are circles.
4. Lines, not shadows. Structure is a 1px black rule; rows are separated by 1px grey hairlines; floating things get a 1px frame.
5. Few words: no sentences that explain the page; short titles.

## 2. Colour

### 2.1 Palette (`index.css` `:root`, `--p-*`)

| Var | Light | Dark | Used for |
|---|---|---|---|
| `--p-white` | `#ffffff` | `#0b0b0b` (OLED `#000`) | page, dialogs |
| `--p-black` | `#0b0b0b` | `#f5f5f5` | text, rules, primary buttons, selected row |
| `--p-grey-1` | `#f2f2f2` | `#1a1a1a` (OLED `#121212`) | grey surfaces: user message, tool card, code, row hover |
| `--p-grey-2` | `#dadada` | `#333333` (OLED `#2a2a2a`) | hairlines, borders, scrollbar |
| `--p-grey-3` | `#8f8f8f` | `#6b6b6b` | quiet dots, offline |
| `--p-grey-4` | `#6b6b6b` | `#9a9a9a` | secondary text (`--app-hint`) |
| `--p-red` | `#d12a1e` | `#e5483c` | the accent (§1.1), focus ring |

Components use the `--app-*` tokens, which map onto `--p-*`. Colour presets (Settings → Display) still override `--app-*` inline; the default preset is this palette.

### 2.2 Meaning colours (allowed exceptions)

Only where colour encodes data the user reads:
- Diff added/removed backgrounds, git status colours (`--app-diff-*`, `--app-git-*`).
- Warning text `--app-badge-warning-text` (amber): context nearly full, "auto" permission mode. Success text `--app-badge-success-text` (green): only in badges that say "passed/merged".
- Tailwind `red-300…700` are remapped to `--p-red` in `@theme`, so legacy `text-red-*` already is the accent.

### 2.3 Tones for status (task columns, session status)

| Tone | Columns / states | Dot | Heading text |
|---|---|---|---|
| red | review, blocked, permission required, error | `--app-accent` | `--app-accent` |
| black | running (pulsing), ready, online, working (pulsing) | `--app-fg` | `--app-hint` |
| grey | backlog, done, offline | `--p-grey-3` | `--app-hint` |

Source: `components/Tasks/StatusDot.tsx`, `components/AssistantChat/StatusBar.tsx`. The old `--c-*` hue variables are folded onto these tones; don't add new uses.

## 3. Type

- Family: **Host Grotesk** (`@fontsource-variable/host-grotesk`), CJK falls back to PingFang / Noto Sans CJK. Mono: system mono.
- Weights: 400 body, 500 titles, 600 labels and buttons.

| Role | Size / weight / tracking | Class |
|---|---|---|
| Sidebar title | 28px / 500 / -0.04em | inline in `SidebarHeader` |
| Page title | 24px / 500 / -0.025em | `.pw-title` |
| Session title | 17px / 500 / -0.02em | `SessionHeader` |
| Row / body | 15px / 400 / -0.005em | `text-[15px]` |
| Chat | 15px / 1.6 | `--app-chat-font-size` |
| Small body | 13–14px | `text-[13px]`, `text-sm` |
| Label | 12px / 600 / 0 | `.pw-eyebrow`, `text-xs font-semibold` |
| Minimum | 10px (counters only) | — |

## 4. Shape, spacing, shadow

- Radius: `0` for every box (Tailwind `--radius-*` are all 0); `rounded-full` for buttons, chips, dots. No arbitrary `rounded-[Npx]`.
- Hairline `1px var(--app-border)` between rows; rule `1px var(--app-rule)` for structure (sidebar edge, header bottom, composer frame, quote bar).
- Shadows: none. Tailwind `shadow-md…2xl` render as a 1px rule frame; `shadow-sm` is nothing.
- Spacing: Tailwind 4px scale; rows 10px vertical / 12px horizontal; group heading 20px above, 8px below.

## 5. Motion

| Var | Value | Use |
|---|---|---|
| `--ease` | `cubic-bezier(0.7, 0, 0.2, 1)` | sweeps, fills, glides, toggles |
| `--ease-out` | `cubic-bezier(0.25, 1, 0.5, 1)` | things appearing |
| `--dur-fast` | 300ms | colour changes |
| `--dur` | 450ms | sweeps, fills, popovers, panels |
| `--dur-slow` | 700ms | long fades |
| `--ease-rule` | `cubic-bezier(0.76, 0, 0.24, 1)`, 1.1s | hairlines and rulers drawing in |
| `--ease-post` | `cubic-bezier(0.2, 0.7, 0.2, 1)`, 0.9s | content sliding in from a rule |

No overshoot, no scale-on-hover, no press shrink, no blur, no fade-up-on-everything.

Two CSS rules (both bit us once):
- Keyframes move things with `transform`, never the individual `translate`/`scale` properties: those would cancel Tailwind's `-translate-x-1/2` centring.
- The interaction classes (`.pw-sweep`, `.pw-ghost-sweep`, `.pw-row-fill`, `.pw-ledger`, `.pw-plus`, entrances) live in `@layer components`, so utilities on the same element (`fixed`, `absolute`) win over their `position: relative`.

| Effect | How | Class |
|---|---|---|
| Primary button hover | red fill opens from 37% across, 500ms `--ease` | `.pw-sweep` |
| Outline icon button hover | text-colour fill opens, glyph inverts | `.pw-ghost-sweep` |
| Row hover | grey wash rises from the bottom, `--dur` `--ease` | `.pw-row-fill` |
| Selected row | black bar glides between rows, `--dur` `--ease` | `.pw-highlight` |
| Text link hover | standing 1px underline, grey fill rises behind | `.pw-underline` |
| Expand / collapse | plus turns into minus, 350ms `--ease` | `.pw-plus` |
| Popover / menu in | fade + 6px up, `--dur` `--ease-out` | `.pw-pop`, radix popper |
| Focus | 2px red outline, 2px offset | `:focus-visible` |
| Ledger row appears | its top hairline draws left→right, 60ms stagger by `--i` | `.pw-ledger` |
| Rule draws | horizontal `.pw-rule-in`, vertical `.pw-rule-down` | template `motion-rule`, `op-draw` |
| Slide from a rule | ∓36–44px → 0 | `.pw-post-in` (`--post-from`) |
| Lifecycle ruler | red fill + marker draw to the current step on open | template "month" ruler |

## 6. Components

| Component | Look | Template source | Code |
|---|---|---|---|
| Settings choice | 1px grey pill, 13px; selected = black fill, white text | — | `HappyComposer.tsx` `SettingsChoices` |
| Primary button | black pill, white 13–15px/600 text, `.pw-sweep` | `.m-btn`, `.m-btn-3` | `components/ui/button.tsx` `default` |
| Outline button | 1px black pill, `.pw-ghost-sweep` | `.m-icon` | `button.tsx` `outline` |
| Round action (`+`) | 36px black circle, `.pw-sweep` | `.m-btn-3` | `router.tsx` |
| Icon toggle | 32px circle, grey glyph; active = black fill | — | `SessionHeader.tsx` `headerToggleClass` |
| Select (user picker) | no box, 1px black underline, 15px | `.m-field__input` | `TaskSwitcher.tsx` |
| Ledger row | hairline above, 15px title, dot left, controls right in 12px/600 grey | services ledger | `TaskSwitcher.tsx` |
| Group heading | 12px/600 label + grey count | column heads | `TaskSwitcher.tsx` |
| Composer | square box, 1px black frame, red frame on focus | `.m-surface-2` | `HappyComposer.tsx` |
| User message | grey square block | `.m-surface` | `--app-chat-user-bg` |
| Tool card | grey square block | `.m-surface` | `ToolCard.tsx` |
| First-use tip | 1px black frame, red 12px label, black pill "Got it" | — | `Fue.tsx` |
| Logo mark | black disc, dugong's three bars in white/red/white | nav mark | `SidebarHeader.tsx` `DugongMark` |
| Task row controls | column select + ⓘ hidden until hover on pointer devices, overlaid on the title's end; always shown on touch and on the open row | — | `TaskSwitcher.tsx` |
| Tool call row | `+` · name · mono gist · status · duration on hairlines; opens in place to times, input, result | FAQ `<details>` + services ledger | `ToolCard/ToolCard.tsx`, `ToolGroupCard.tsx`, `ledger.ts` |
| Lifecycle ruler | Backlog→Done baseline with ticks, red fill/marker at current step; blocked = red label under Running | "A month on the books" | `Tasks/TaskDetail.tsx` `LifecycleRuler` |
| Field | 12px/600 label above, no box, 1px bottom border, 17px text | `.m-field` | `LoginPrompt.tsx` |
| Assistant icon | speech bubble (no sparkles anywhere) | — | `Assistant/icons.tsx` |
| Star button | 1px black pill `☆ Star │ n`, `.pw-ghost-sweep`; star outline draws in, fills red on hover; count rolls up once; no count when the hub can't reach GitHub | GitHub-stars buttons (ReUI, shadcn.io) | `GitHubStar.tsx` |
| Star invite | under the sidebar header once, a week after the first task: black top rule draws in, red 12px label, black pill + grey text button; either retires it | Docusaurus announcement bar | `GitHubStar.tsx` `StarInvite` |

## 7. Layout

- Light by default; dark and OLED are the same design inverted.
- Desktop: sidebar (task list) | 1px black rule | session. Session header ends with a 1px black rule.
- Phone: the task list is the home screen; the session opens full screen.

## 8. Words

- No sentences explaining how to use a page; one word where one word works.
- No greetings, no reassurance ("That is fine", "nothing was lost"), no exclamation marks; sentence case for labels.
- Keep: consequences, warnings, security notes, recovery commands, limits.
- Chinese: no 您, no ！, 请 only for a real request; terms: 任务, 会话, 智能体, 暂存清单.
- Errors are red text; warnings amber text; never a tinted box or a coloured side bar.

## 9. Migration

1. Tokens live in `src/index.css` (`--p-*` palette, `--app-*` roles, motion vars). Done.
2. Replace hard-coded hex / Tailwind hues / arbitrary radii page by page with tokens.
3. Order: main screen → menus and dialogs (new task, task detail, session actions) → files / terminal → settings → assistant panel → login / share.
4. Each page: list kept / removed / changed controls for the owner. **Removed must be empty.**
5. Last: add a lint that flags hex colours, `rounded-[…]`, Tailwind hue classes and font sizes under 10px in `src/**/*.tsx`.

## 10. Open

- ~~Login page blobs and bouncy letters~~ — replaced 2026-11-11 by the template opening.
- Template pieces not used yet: full-screen Menu overlay (could replace the sidebar's icon cluster), red closing rings (could show context usage), sticky stacking sheets, quote weight-on-read.
- README screenshots still show the board.
- Shiki code highlighting is still full colour (changing it means regenerating chat fixtures).
- Some strings are still hard-coded English (terminal page, queued bar, diff summary, iOS install steps).
- `Button` variants `secondary` and `outline` now look alike; merge later.

## 11. Progress

| Page | Route | Status |
|---|---|---|
| Global tokens | all | Done 2026-11-11: palette, Host Grotesk, square radii, no shadows, template motion. Tailwind red remapped to accent. |
| Board | `/board` | Removed 2026-11-10 (owner's decision). PR status moved into task detail. |
| Main screen: task list | `/sessions` | Done 2026-11-11. Kept: user picker, archived toggle, per-row column select and ⓘ, pending count, gliding selection. Changed: six hues → three tones; rows on hairlines; selected row black. Removed: none. |
| Main screen: session header + composer | `/sessions/$id` | Done 2026-11-11. Kept: every header toggle and composer control. Changed: status bar colours → three tones; scratchlist mode amber → red; FUE tips amber → framed/red. Removed: none. |
| Task detail | panel | Done 2026-11-11. Added lifecycle ruler; metadata, PR and runs as ledger rows; pill buttons. Removed: none. |
| Chat tool calls | `/sessions/$id` | Done 2026-11-11. Grey cards → hairline rows with `+`/`−`; timestamps moved into the opened row; clicking a row opens it in place (the details dialog still opens from previews and group children). Removed: none. |
| Task list rows | `/sessions` | 2026-11-11: hairlines draw in; per-row controls on hover (pointer devices). |
| New-task dialog, session menu, rename/export/import/share dialogs, workspace users, toasts, lightbox | dialogs | Done 2026-11-11. Underline fields, pill buttons, 1px frames; dialogs centred without blur. Removed: none. |
| Interface copy (en + zh) | all | Done 2026-11-11: ~190 strings shortened, board wording gone, 8 unused subtitle keys deleted. |
| Files, file, terminal, browse | `/sessions/$id/files`, `/file`, `/terminal`, `/browse` | Done 2026-11-11. Text tabs, hairline rows, three-tone dots; file icons grey. Removed: none. |
| Settings | `/settings/*` | Done 2026-11-11. Ledger rows, page subtitles dropped (facts moved to section hints), square swatches, black switch. Removed: none. |
| Assistant panel | side panel | Done 2026-11-11. Text tabs with underline, ledger memory/questions, no tinted chips. Removed: none. |
| Login | `/` | Done 2026-11-11. Template opening: rule draws down, "pit | wall" hung on it, field-style token input, pill button. Removed: blobs, pill badge, bouncy letters (decoration only). |
| Share | `/share` | Done 2026-11-11 (ledger picker, pills). |
| Banners (offline, reconnecting, syncing, PWA, runner skew, cursor migration) | global | Done 2026-11-11. Black or grey strips, amber text for warnings, no fills. |
| Composer session settings | `/sessions/$id` | 2026-11-24 (owner's decision). The gear sheet is the one entry for model, effort, permission and the Codex/Copilot extras, on desktop and phone; it stays open across picks. Options are pill rows (selected = black fill) under 12px/600 group labels on hairlines. Removed: the separate model / effort / permission buttons beside the gear (and their toolbar-layout entries). 2026-11-26 (owner asked for versions on the choices): Claude pills take Claude Code's own names from the machine ("Default · Opus 5.5", "Opus 5.5 1M"); an alias the machine does not offer is a greyed, unpickable pill, explained in one hint-grey line under the group. The group label's hint-grey "当前：claude-opus-5-5" note appears only when the model the agent reported is not the one the selected pill names. |
| Star on GitHub | `/sessions` sidebar | 2026-11-27 (owner picked from a live demo). Star pill with the hub-cached count in the header and in Settings → About; one-time invite above the task list a week after the first task. Removed: none. |
