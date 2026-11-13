# Writing style

These rules cover the docs, the READMEs, the website and the text in the web app. Follow them so every page reads like the same person wrote it.

## Say what it does for the reader

Describe what the reader gets, in the reader's terms. "When an agent asks for permission, your phone gets a notification" tells them something. "Powerful, seamless notifications" does not.

Prefer a concrete scene, a number or a command to a claim. "Three failures in a row pause the schedule" beats "robust error handling". If you can't name the scene, the number or the command, you probably don't have a point yet.

Put the quickest working command near the top of a page. Explanations come after the reader has something running.

## Check it against the code

Every claim about behaviour must be true of the code today. Grep for the flag, the env var or the default before you write it down. If you can't verify something, leave it out. A missing sentence costs less than a wrong one.

## Plain sentences

- No em dashes. Split the sentence, or use a comma or a colon.
- No "not X, but Y", "it's not just X" or "more than just X". Say what it is.
- No lists of three added for rhythm. List as many items as there really are.
- Don't use these words: seamless, effortless, powerful, supercharge, game-changer, unlock, elevate, delve, robust, cutting-edge, blazing fast.
- No "**Bold label:** explanation" bullet lists. If the bullets read like a paragraph, write the paragraph. Use a table when the items have the same few attributes.
- No emoji in headings or list items.
- Headings use sentence case: "Run the hub at boot", not "Run The Hub At Boot".
- Address the reader as "you". Name the thing that acts: "the hub stores", "the runner starts", not "it is stored".

## Product names

Write `dugong` in lower case, even at the start of a sentence. Agent and tool names keep their own spelling: Claude Code, Codex, GitHub. Commands, paths, env vars and settings go in backticks: `dugong hub`, `~/.dugong`, `DUGONG_HOME`.

## Chinese text

Write Chinese text in Chinese from the start. Don't translate the English sentence by sentence: work out what the reader needs to know and say it the way a Chinese developer would.

- Use plain verbs and concrete subjects: "hub 会把任务挪到待审阅", not "任务状态的流转由 hub 负责完成".
- Keep the terms developers really say in English: agent, worktree, PR, hub, runner, token, commit. Don't invent translations for them.
- No "——". Use a comma, a colon or two sentences, the same rule as the English em dash.
- The rules above about adjectives, emoji, bold labels and padding apply to Chinese too.

## Before you submit

Read the page once as a new user who has only the README. Every command should run as written, every claim should match the code, and nothing should need a word from the banned list.
