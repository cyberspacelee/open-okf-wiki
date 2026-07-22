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

## UI architecture

- **shadcn** (`base-nova`, base primitives, Tailwind v4, lucide) under `src/components/ui/`
- **App shell:** `Layout` → `SidebarProvider` + `AppSidebar` + `SidebarInset` (`src/components/Layout.tsx`, `app-sidebar.tsx`)
- **Workspace chrome:** `WorkspaceShell` (Breadcrumb + title + `WorkspaceSubnav` + error slot). Prefer this over hand-rolled headers on every page.
- **Forms:** `FieldGroup` / `Field` / `FieldLabel` / `FieldDescription` + shadcn controls (`Select`, `Switch`, `Checkbox`, `RadioGroup`, `Textarea`)
- **Destructive actions:** `ConfirmDialog` (AlertDialog) — do not use `window.confirm`
- **Toasts:** `sonner` via `<Toaster />` in `main.tsx`
- **Session chat:** AI Elements under `src/components/ai-elements/` + `session/*` (do not rewrite transport for pure UI polish)
  - **Session timeline architecture:** AI Elements for text primitives (`MessageResponse`, `Reasoning`, `Suggestion`); **`SessionCard`** is the single chrome for tools / workflow / phase / batch / subagent (`session/SessionCard.tsx` + `session-card-styles.ts`).
  - Tool bodies: registry in `session/tool-bodies.tsx` (`TOOL_BODY_REGISTRY`); never default JSON wall for known wiki tools (list/read/glob/search/write).
  - Backend projects operator payloads via `@okf-wiki/agent` `ui-projection` (model loop keeps full fidelity). See `packages/agent/docs/ui-projection.md`.
  - **data-\* whitelist** in `MessageParts` only: gate, plan, plan-progress, progress, run, workflow*, tool-agent. Unknown data parts are not rendered.
  - Plan: `PlanViewer` + page checklist; HITL only from `data-gate` / `data-plan`.
  - **Not in product:** web `sources` / `web-preview` / external search; do not install AI Elements `all.json`.
- **Operator CSS leftovers** in `src/index.css` (`.form`, `.kv`, wiki prose, subnav). Prefer utilities / shadcn components for new UI.

### Adding a workspace page

1. Route in `App.tsx`
2. Wrap with `WorkspaceShell` (`workspaceId`, `title`, `breadcrumbLabel`, `testId`)
3. Keep `workspace-subnav-*` navigation via existing `WorkspaceSubnav`
4. Preserve stable `data-testid`s listed below

### Product paths

- **Primary generate path:** Session (`/workspaces/:id/session`)
- **Runs:** audit + headless (`run-start` testid) under Advanced; prefer `run-start-session` for operators
- **Wiki empty CTA:** Session, not Runs

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

Shared helpers live in `e2e/helpers.ts`:

- `createWorkspaceViaUi`, `addSourceViaUi`, `expectVisibleBox`
- Dual-mode control helpers: `chooseOption`, `setChecked`, `confirmDestructive` (native ↔ shadcn)

### E2E anchors

Specs locate UI through stable `data-testid` values. **Prefer keeping these testids even when the underlying component type changes** (e.g. inline Card → AlertDialog root still `workspace-delete-dialog`; native `<select>` → shadcn Select trigger still carries the same testid).

Key contract surface:

| Area | Testids |
| --- | --- |
| Shell | `app-sidebar`, `sidebar-toggle`, `locale-switch`, `nav-workspaces`, `nav-settings` |
| Workspaces | `workspaces-page`, `workspace-create-form`, `workspace-name-input`, `workspace-root-input`, `workspace-create-submit`, `workspace-list`, `workspace-row`, `workspace-delete`, `workspace-delete-dialog`, `workspace-delete-meta`, `workspace-delete-confirm` |
| Workspace chrome | `workspace-detail`, `workspace-breadcrumb`, `workspace-subnav-{overview,sources,session,run,wiki,settings}` |
| Sources | `sources-page`, `source-list`, `source-path-input`, `source-id-input`, `source-add-submit`, `source-remote-input`, `source-clone-submit`, `source-ignore-editor`, `source-ignore-text`, `source-ignore-save`, `source-edit-ignores-*`, `preset-*` |
| Session | `session-chat-page`, `session-conversation`, `session-input`, `session-send`, `session-prompt`, `session-list`, `session-select`, `session-new`, `session-delete`, `session-slash-*`, `session-decision`, `session-choice-*`, `session-plan-*`, `session-plan-pages`, `session-plan-pages-count`, `session-plan-progress`, `session-phase-progress`, `session-tool-part`, `session-tool-batch`, `session-subagent-part`, `session-workflow-progress`, `session-composer-locked` |
| Run | `run-page`, `run-start`, `run-start-session`, `run-last-status` (`data-status`), `run-list`, `run-event-log`, `run-publish-actions`, `run-approve`, `run-deny`, `run-cancel`, `run-retry` |
| Wiki | `wiki-page`, `wiki-empty`, `wiki-page-list`, `wiki-page-link`, `wiki-page-content`, `wiki-page-title`, `wiki-markdown` |
| Workspace settings | `settings-page`, `settings-tab-{general,skill,danger}`, `settings-*`, skill panel / danger zone |
| Global settings | `global-settings-page`, `settings-tab-{models,app,diagnostics}`, `model-*`, `doctor-*`, `health-*`, `home-skills-panel`, `provider-panel`, `models-table`, `settings-status` |
| Shared | `error-banner` |

When remediating UI (shadcn Field/Select/Checkbox/AlertDialog/Sidebar), put the existing testid on the interactive element e2e already targets (input, trigger, dialog content, confirm button) rather than inventing new anchors.

**Note:** Global/workspace settings use Tabs. Default tabs keep primary e2e paths mounted (`models` / `general`). Diagnostics and Skill require clicking `settings-tab-diagnostics` / `settings-tab-skill` first.
