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
- **Agent Workspace (primary operate surface, ADR 0030):** `src/agent-workspace/`
  - Live transport: Pi session SSE + product injects (`run_phase` / `gate` / `run_link`) via `useSessionAgent` + `project-agent-events`.
  - Conversation truth: Pi JSONL under `.okf-wiki/pi-sessions/` (not UIMessage Session files).
  - HITL: structured `resume_gate` commands only (no free-text approve).
  - Tool cards use Pi built-in names (`ls`, `read`, `grep`, `find`, `write`, `edit`) — never Host `list_source` / `write_wiki`.
- **Operator CSS leftovers** in `src/index.css` (`.form`, `.kv`, wiki prose, subnav). Prefer utilities / shadcn components for new UI.

### Adding a workspace page

1. Route in `App.tsx`
2. Wrap with `WorkspaceShell` (`workspaceId`, `title`, `breadcrumbLabel`, `testId`)
3. Keep `workspace-subnav-*` navigation via existing `WorkspaceSubnav`
4. Preserve stable `data-testid`s listed below

### Product paths

- **Primary operate surface:** Agent Workspace (`/w/:id`) — chat, tools, subagent spans, plan/publish gates
- **Secondary routes:** Sources / Wiki / Jobs (audit + headless) / Workspace settings under `/workspaces/:id/...`
- **HITL:** only on Agent transcript (`agent-gate-*`); Jobs page is read-mostly + Advanced headless controls
- **Wiki empty CTA:** Agent Workspace, not Jobs console

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
| Workspace chrome | `workspace-breadcrumb`, `workspace-subnav`, `workspace-subnav-{agent,sources,wiki,run,settings}` |
| Sources | `sources-page`, `source-list`, `source-path-input`, `source-id-input`, `source-add-submit`, `source-remote-input`, `source-clone-submit`, `source-ignore-editor`, `source-ignore-text`, `source-ignore-save`, `source-edit-ignores-*`, `preset-*` |
| Agent Workspace | `agent-workspace-page`, `agent-workspace-shell`, `agent-composer`, `agent-composer-input`, `agent-send`, `agent-start-wiki-run`, `agent-abort`, `agent-gate-actions`, `agent-gate-approve`, `agent-gate-revise`, `agent-gate-deny`, `agent-context-panels`, `agent-tree`, `agent-session-list`, `agent-session-new`, `agent-session-item`, `work-run-chip`, `work-run-agent`, `work-unit-drawer`, `waiting-for-events` |
| Jobs (Run audit) | `run-page`, `run-open-agent`, `run-open-wiki`, `run-start` (headless), `run-last-status` (`data-status`), `run-list`, `run-cancel`, `run-retry` |
| Wiki | `wiki-page`, `wiki-empty`, `wiki-open-agent`, `wiki-page-list`, `wiki-page-link`, `wiki-page-content`, `wiki-page-title`, `wiki-markdown` |
| Workspace settings | `settings-page`, `settings-tab-{general,skill,danger}`, `settings-*`, skill panel / danger zone |
| Global settings | `global-settings-page`, `settings-tab-{models,app,diagnostics}`, `model-*`, `doctor-*`, `health-*`, `home-skills-panel`, `provider-panel`, `models-table`, `settings-status` |
| Shared | `error-banner` |

When remediating UI (shadcn Field/Select/Checkbox/AlertDialog/Sidebar), put the existing testid on the interactive element e2e already targets (input, trigger, dialog content, confirm button) rather than inventing new anchors.

**Note:** Global/workspace settings use Tabs. Default tabs keep primary e2e paths mounted (`models` / `general`). Diagnostics and Skill require clicking `settings-tab-diagnostics` / `settings-tab-skill` first.
