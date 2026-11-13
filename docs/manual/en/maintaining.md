# Maintaining the illustrated manual

[English](maintaining.md) · [简体中文](../maintaining.md) · [Feature directory](index.md)

## Check interface entry points

Routes live in `web/src/router.tsx` and `web/src/routes/settings/categories.ts`. Task controls live in `web/src/components/Tasks/`, session actions in `SessionActionMenu.tsx`, composer controls in `AssistantChat/ComposerButtons.tsx`, and the assistant in `components/Assistant/`.

When adding a control, update the instructions and feature directory in both languages. Keep chapter filenames and feature anchors aligned. Describe any permission or agent capability restrictions. References at the bottom of each page identify the checked source files.

## Capture screenshots

From the repository root, start a local-only Vite server:

```bash
CHOKIDAR_USEPOLLING=1 bun run --cwd web dev -- --port 5288 --host 127.0.0.1
```

In another terminal, capture the desired language:

```bash
DOCS_LANG=en node design/launch/manual-screenshots.mjs
DOCS_LANG=zh-CN node design/launch/manual-screenshots.mjs
```

Set `PLAYWRIGHT_BROWSERS_PATH` for a custom browser installation. To capture selected screens, set `DOCS_SHOTS=files,directories`. The script only accepts localhost or 127.0.0.1 as the capture host.

Screenshots mount production components. Task scenes use `assistant-panel-demo`; settings and file scenes use `manual-fixture`. The script supplies synthetic responses for every `/api/` request. Terminal scenes show controls and connection state without connecting to a real shell. Never insert actual tokens, private conversations or production data.

English images go in `docs/manual/en/assets/`; Chinese images go in `docs/manual/assets/`. Capture manifests are written to `/tmp/dugong-manual-screenshots-en.json` and `/tmp/dugong-manual-screenshots.json`. Review screenshots for error pages, incomplete loading, clipped labels and mismatches with the instructions.

## Build and validate

```bash
bun run --cwd docs docs:build
```

The documentation site includes local search. Add chapters to `docs/.vitepress/config.ts` and both feature directories. Use relative Markdown links for GitHub. Define feature anchors with standard HTML `<a name="section-id" id="section-id"></a>` and link to `page.md#section-id`. Do not replace these with site-only heading suffix syntax.

Screenshot version labels identify their environment; they do not announce a release. Keep usage documentation separate from unfinished acceptance checks.
