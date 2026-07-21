# @okf-wiki/web

React + TypeScript UI for open-okf-wiki (Vite). Talks to `@okf-wiki/server` over the local HTTP API.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm --filter @okf-wiki/web dev` | Vite dev server (proxies/expects API on `127.0.0.1:8787`) |
| `pnpm --filter @okf-wiki/web build` | Typecheck + production build |
| `pnpm --filter @okf-wiki/web typecheck` | `tsc -b --noEmit` |
| `pnpm --filter @okf-wiki/web test:e2e` | Playwright e2e suite |
| `pnpm --filter @okf-wiki/web test:e2e:ui` | Playwright UI mode |

## End-to-end tests

Playwright specs live in `e2e/`. The config starts API + Vite via `scripts/e2e-dev.mjs`:

1. Builds `@okf-wiki/core...` (includes contract)
2. Starts `@okf-wiki/server` with a per-run `OKF_WIKI_HOME` temp dir
3. Starts Vite on `127.0.0.1:5173` with `--strictPort`

Workers are fixed at `1` until the app supports concurrent index locking. Artifacts (`test-results/`, `playwright-report/`) are gitignored.

```bash
# from monorepo root (first time: install browsers if needed)
pnpm exec playwright install chromium
pnpm --filter @okf-wiki/web test:e2e
```

Shared helpers live in `e2e/helpers.ts` (`createWorkspaceViaUi`, `addSourceViaUi`, plus dual-mode control helpers `chooseOption`, `setChecked`, `confirmDestructive` for native ↔ shadcn migrations).

### E2E anchors

Specs locate UI through stable `data-testid` values. **Prefer keeping these testids even when the underlying component type changes** (e.g. inline Card → AlertDialog root still `workspace-delete-dialog`; native `<select>` → shadcn Select trigger still carries the same testid).

Key contract surface:

| Area | Testids |
| --- | --- |
| Shell | `app-sidebar`, `sidebar-toggle`, `locale-switch`, `nav-workspaces`, `nav-settings` |
| Workspaces | `workspaces-page`, `workspace-create-form`, `workspace-name-input`, `workspace-root-input`, `workspace-create-submit`, `workspace-list`, `workspace-row`, `workspace-delete`, `workspace-delete-dialog`, `workspace-delete-meta`, `workspace-delete-confirm` |
| Workspace chrome | `workspace-detail`, `workspace-subnav-{overview,sources,session,run,wiki,settings}` |
| Sources | `sources-page`, `source-list`, `source-path-input`, `source-id-input`, `source-add-submit`, `source-remote-input`, `source-clone-submit`, `source-ignore-editor`, `source-ignore-text`, `source-ignore-save`, `source-edit-ignores-*`, `preset-*` |
| Session | `session-chat-page`, `session-conversation`, `session-input`, `session-send`, `session-prompt`, `session-list`, `session-select`, `session-new`, `session-delete`, `session-slash-*`, `session-decision`, `session-choice-*`, `session-plan-*`, `session-composer-locked` |
| Run | `run-page`, `run-start`, `run-start-session`, `run-last-status` (`data-status`), `run-list`, `run-event-log`, `run-publish-actions`, `run-approve`, `run-deny`, `run-cancel`, `run-retry` |
| Wiki | `wiki-page`, `wiki-empty`, `wiki-page-list`, `wiki-page-link`, `wiki-page-content`, `wiki-page-title`, `wiki-markdown` |
| Settings | `settings-page`, `settings-*`, `global-settings-page`, `model-*`, `doctor-*`, `health-*`, `home-skills-panel`, `provider-panel`, `models-table`, `settings-status` |
| Shared | `error-banner` |

When remediating UI (shadcn Field/Select/Checkbox/AlertDialog/Sidebar), put the existing testid on the interactive element e2e already targets (input, trigger, dialog content, confirm button) rather than inventing new anchors.
