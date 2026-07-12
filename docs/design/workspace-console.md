# Workspace Console

Status: Draft from design grilling

## Product principle

The Workspace Console is the local graphical interface for one Workspace, which represents one product or project and produces one Knowledge Bundle from one or more code, documentation, requirements, or contract repositories. CLI and CI remain first-class automation adapters; the Console is the preferred human interface for setup, observation, review, reading, and grounded questions.

The Console never becomes a second source of truth. The Python Deterministic Control Plane owns configuration validation, Git safety, Production Run transitions, knowledge acceptance, review decisions, publication, and question grounding.

## Architecture

```text
CLI / CI                    Workspace Console
   |                        Vite + React + shadcn Base UI
   |                                  |
   +---------------+------------------+
                   |
                   v
          Python application interface
                   |
        +----------+-----------+
        |                      |
        v                      v
Deterministic Control    Semantic Execution
Plane                    Plane
        |                      |
        v                      v
SQLite / Git / Bundle    Gateway Profile
```

The Console is built as static assets and served by the Python process. It does not introduce a Next.js or TanStack Start server, access SQLite directly, or duplicate state-machine rules in TypeScript.

## Configuration ownership

### Workspace Definition

The shareable Workspace Definition contains:

- Producer Project identity and display name.
- Sources, roles, remote URLs, and Source Revision Policies.
- Producer Profile.
- publication destination and Bundle naming.
- non-secret knowledge-production policy.

The canonical file is `workspace.toml` at the Workspace root.

### Local Workspace Settings

Machine-specific settings live under `.okf-wiki/` and are not shareable authority:

- linked Source Checkout paths.
- selected Gateway Profile.
- model IDs, optional Agent Role overrides, concurrency, and budgets.
- UI preferences and recently viewed state.
- local server session metadata.

Every Production Run stores the resolved non-secret configuration snapshot, so audit never depends on later edits to either configuration layer.

### Gateway Profiles

Gateway Profiles are reusable across Workspaces and configured from the Console's Connections page. A profile contains:

- display name and gateway identifier.
- OpenAI-compatible base URL.
- secret reference, never the secret in shared or Run data.
- optional request headers.
- capability-test results for model listing, structured output, tool calling, concurrency, and error mapping.

Secrets use the operating-system credential store when available and a permission-restricted local fallback otherwise. The Workspace selects a default model; advanced settings may override Planner, Worker, Verifier, Renderer, and Query Agent assignments. One model remains the default until the Benchmark Corpus demonstrates value from role-specific routing.

## Source Checkout lifecycle

The Sources page supports:

- managed checkout: clone under `<workspace>/sources/<source-id>/`.
- linked checkout: register an existing local repository without taking ownership.
- clone, fetch, and pull through the user's existing Git credentials.
- follow-branch and pinned-commit Source Revision Policies.
- remote, branch, commit, dirty-state, and ahead/behind inspection.

Pull is blocked when tracked or untracked local changes exist. The Producer never stashes, resets, cleans, force-checkouts, or overwrites user work. Removing a linked Source never deletes its repository. Removing a managed Source removes configuration first; deleting its checkout is a separate explicit destructive action with confirmation.

Starting a Production Run resolves every Source Revision Policy to an exact commit and creates immutable Source Snapshots. Later pulls or branch movement cannot change an existing Run.

## Information architecture

The primary navigation is:

1. **Overview** — Workspace health, configured Sources, latest Bundle, active Run, blockers, and quick actions.
2. **Sources** — clone/link repositories, assign roles, select revisions, inspect Git state, and pull safely.
3. **Runs** — create, observe, cancel, recover, compare, and inspect Production Runs.
4. **Review** — coverage, exclusions, semantic changes, Verification Findings, Evidence, Bundle diff, approve, or reject.
5. **Knowledge** — render and navigate the current staged or published Knowledge Bundle.
6. **Concepts** — inspect the Knowledge Impact Graph and replay Concept provenance.
7. **Settings** — Workspace Definition, publication, Local Workspace Settings, and selected Gateway Profile.
8. **Connections** — create, test, update, and remove reusable Gateway Profiles.

The UI uses shadcn Base UI primitives and semantic tokens. Dense operational information uses tables, badges, progress, tabs, resizable panes, sheets, and command search rather than a dashboard made entirely of cards.

### shadcn Base UI composition

- `Sidebar`, `Breadcrumb`, and `Command` provide global navigation and search.
- `Table`, `Badge`, `Progress`, `Tabs`, `ScrollArea`, and `Resizable` present Sources, Runs, coverage, Findings, and diffs.
- `FieldGroup`, `Field`, `InputGroup`, `Select`, `Switch`, and `ToggleGroup` build Workspace and Gateway Profile forms.
- `Sheet` and `Dialog` show Evidence, Source state, and non-destructive details; `AlertDialog` protects destructive local actions.
- `Alert`, `Empty`, `Skeleton`, `Spinner`, and Sonner provide consistent feedback.
- Base UI composition uses its `render` mechanism rather than Radix `asChild` conventions.

Custom visualization code is limited to the Run timeline, Concept provenance graph, and Markdown diff where no shadcn primitive represents the data. These visualizations still use the shared semantic tokens and accessible controls.

## Production Run visualization

The Run page presents recorded state, not simulated model thought:

```text
Preparing -> Exploring -> Verifying -> Rendering -> Checking -> Review -> Published
                 |             |
                 v             v
          Analysis Tasks   Findings and decisions
```

The page includes:

- a phase stepper with timestamps and failure state.
- Planner and Worker task lanes with bounded scope and budgets.
- Coverage Obligations moving through explicit dispositions.
- retry, timeout, token, tool-call, and latency summaries.
- a replayable Run Event timeline.
- polling first; streaming transport is added only if polling becomes inadequate.

Internal model reasoning and chain-of-thought are never displayed. The Console shows typed inputs, tool activity summaries, proposals, Findings, deterministic decisions, and recorded outcomes.

## Concept provenance

The Concept view explains how authoritative knowledge formed:

```text
Source Unit -> Evidence Reference -> Claim -> Verification -> Concept -> Bundle page
```

Defining Claims converge into the Concept; Supporting Claims remain visibly secondary. Disputed, stale, conflicting, superseded, or rejected knowledge is visually distinct. Selecting any node opens its stable ID, source revision, path, span, digest, decision, and related Run Events.

Animation is a time-based replay of recorded events, not decorative inference. It supports pause, scrub, direct navigation, and `prefers-reduced-motion`. Claim and Concept acceptance must append entity Run Events with candidate IDs so the replay is reconstructible without reading model messages.

Incremental Runs additionally animate impact from changed Source Units through invalidated Evidence References, Claims, Concepts, and rendered pages.

## Markdown reader

The Knowledge page is a read-only Bundle reader, not a Wiki editor. It supports:

- CommonMark and GFM content.
- tables, task lists, fenced code, syntax highlighting, and heading outline.
- Mermaid and mathematical notation under restrictive rendering policies.
- relative Bundle navigation and backlinks.
- frontmatter as a structured metadata panel.
- Claim markers and clickable Evidence References.
- rendered/source toggle and unified/split Bundle diff.

Raw HTML, scripts, remote iframes, MDX execution, and direct editing of derived Markdown are disabled. External links are clearly marked, and source excerpts are read through the existing fixed-revision, path-constrained Git reader.

## Grounded questions

The reader includes an Ask panel with two scopes:

- current Concept or page.
- complete accepted Knowledge Bundle.

A short-lived Query Agent receives only accepted Claims, Evidence References, bounded retrieval tools, the fixed Run identity, and the user's question. Answers must contain Claim and Evidence citations or state that the Bundle lacks sufficient support. Questions never mutate the Accepted Knowledge Model, close obligations, edit Bundle pages, or trigger Web Enrichment.

When accepted knowledge is insufficient, the UI may offer a separate **Investigate Source** action. A Source Investigation uses bounded read/search tools against the fixed Source Snapshot and returns source citations, but the complete result is marked provisional and visually separated from accepted answers. It cannot be used as an accepted Claim, review resolution, or publication input; authoritative adoption requires a later normal Production Run, verification, and review.

Question sessions are ephemeral by default. Run ID, Source Set digest, model assignment, usage, latency, and cited IDs may be audited without persisting user question or answer text unless the user explicitly exports it. The UI discloses that the question and selected accepted evidence are sent to the configured enterprise gateway.

Initial retrieval reuses deterministic Concept and Claim lookup. Full-text indexing may use SQLite FTS5 when measured need exceeds the existing lookup; embeddings and vector databases remain out of scope.

## Review and publication

The Review page shows:

- Major and Supporting coverage.
- exclusions and deferrals with reasons.
- added, changed, removed, stale, disputed, merged, or split Claims and Concepts.
- Verification Findings grouped by perspective and severity.
- exact Evidence Reference excerpts.
- staged-versus-published Bundle diff.

Approve and reject call the same application interface as the CLI. The Review Snapshot carries the authoritative digest shown to the reviewer; a decision is rejected if that digest no longer matches current state. Approval always reruns deterministic checks before atomic publication.

## Local security

- Bind only to loopback by default.
- Use an unguessable session token and validate request origin for state-changing requests.
- Ship no CDN scripts, external fonts, analytics, or remote UI assets.
- Apply a restrictive Content Security Policy.
- Sanitize Markdown and Mermaid output; never execute repository-provided HTML or JavaScript.
- Redact secrets from logs, traces, error messages, prompts, and diagnostic bundles.
- Keep Git and Bundle reads inside registered checkout, revision, and path scopes.
- Require explicit confirmation for destructive local actions and never delete linked checkouts.

## Application interface

CLI and HTTP adapters call the same use cases:

- inspect and update resolved Workspace configuration.
- clone, link, inspect, and pull Source Checkouts.
- create, observe, cancel, and recover Production Runs.
- obtain immutable review and knowledge snapshots.
- approve or reject against an expected authoritative digest.
- answer a bounded Knowledge Query.
- perform an explicitly provisional Source Investigation.

Transport DTOs may differ from domain records, but validation and state transitions stay in the Python modules that already own them.

## Non-goals

- remote or multi-tenant administration.
- authentication and authorization between human users.
- collaborative Markdown editing or CRDT state.
- direct source-code editing.
- direct editing of generated Bundle pages.
- arbitrary repository execution.
- browser access to SQLite or model credentials.
- Next.js, TanStack Start, or a second server-side application runtime.

## Verification

The Console requires:

- browser tests for Workspace setup, Source safety, Run observation, review, Markdown navigation, Concept provenance, and grounded questions.
- contract tests proving CLI and HTTP adapters observe identical application results.
- stale-digest tests for review decisions.
- Markdown and Mermaid security fixtures.
- accessibility checks including keyboard navigation, focus, labels, contrast, and reduced motion.
- no-network tests proving the Console loads without external assets.
- Query Agent evaluations for citation completeness, unsupported-answer refusal, prompt-injection resistance, scope, cost, and latency.
- Source Investigation tests proving provisional results cannot mutate knowledge, resolve review, or enter publication.
