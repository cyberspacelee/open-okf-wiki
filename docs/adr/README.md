# Architecture Decision Records

Domain vocabulary: [CONTEXT.md](../../CONTEXT.md). Package map: [packages/README.md](../../packages/README.md).

## Current stack (read these first)

| ADR | Role |
|---|---|
| [0032](0032-pi-tool-owned-wiki-runs.md) | **Current:** real `wiki_produce` tool; Pi-only Session/events; immutable snapshots and Run Record v2; one Agent Workspace |
| [0031](0031-unidirectional-framework-first-operator-surface.md) | Unidirectional layers and framework-first surface; product-inject clauses superseded by 0032 |
| [0030](0030-pi-agent-harness-for-semantic-workflow.md) | Pi agent harness and built-in tools; WikiRunShell clauses superseded by 0032 |
| [0021](0021-retire-python-primary-path.md) | Python primary path **removed** |
| [0022](0022-source-clone-into-workspace.md) | Operator-initiated clone; Semantic Workflow never clones |
| [0026](0026-session-centric-agent-workspace.md) | **Session-centric intent** (re-read under 0030/0031: Pi session = operator timeline; Run = linked job) |
| [0028](0028-supervisor-tree-and-thin-workflow-shell.md) | Supervisor topology intent; shell implementation superseded by the Pi tool in 0032 |
| [0029](0029-architecture-cleanup-no-compat.md) | No-compat cleanup culture; wipe-not-migrate (session shape again under 0030) |

Still load-bearing domain/ops decisions (map Host → Run Boundary when reading pre-0019 text):

| ADR | Role |
|---|---|
| [0001](0001-scope-the-product-to-repository-wikis.md) | Product scope: repository wikis |
| [0002](0002-treat-the-repository-as-untrusted-data.md) | Untrusted source data |
| [0005](0005-ship-a-versioned-producer-skill-with-templates.md) | Versioned Producer Skill |
| [0007](0007-write-markdown-directly-to-staging.md) | Markdown → Staging (mechanical validation + atomic publish) |
| [0009](0009-configure-a-repository-snapshot-set.md) | Repository Snapshot Set |
| [0012](0012-treat-manual-retry-as-a-new-run.md) | Manual Retry = new run |
| [0015](0015-apply-default-source-ignores-with-explicit-disable.md) | Default source ignores |
| [0016](0016-separate-run-operator-ui-from-wiki-visualization.md) | Operator UI ≠ Wiki Visualization |
| [0017](0017-portable-host-filesystem-and-directory-rename-publication.md) | Portable FS + directory-rename publication |
| [0018](0018-operator-session-hitl-publication.md) | HITL publication (refined by 0024/0025) |
| [0019](0019-prefer-run-boundary-over-host.md) | **Run Boundary** naming (impl: `@okf-wiki/core`) |

## Superseded / historical (do not implement as written)

| ADR | Status |
|---|---|
| [0003](0003-let-one-pydanticai-agent-own-the-semantic-loop.md) | Framework history → Mastra → **Pi (0030)** |
| [0004](0004-use-codemode-for-dynamic-repository-work.md) | **Superseded**: no CodeMode; tools = Pi built-ins (0030) |
| [0006](0006-keep-python-as-a-thin-harness.md) | **Superseded** by 0020/0021 |
| [0010](0010-use-dynamic-workflow-for-bounded-leaf-coordination.md) | Historical DynamicWorkflow; topology via [0028](0028-supervisor-tree-and-thin-workflow-shell.md) / Pi children (0030) |
| [0014](0014-use-planning-and-bounded-recursive-subagents.md) | Planning/subagents idea remains; Pi child sessions (0030) |
| [0020](0020-typescript-mastra-web-workspace.md) | TS monorepo + Workspace + core still valid; **Mastra/AI SDK stack superseded by 0030** |
| [0023](0023-operator-session-stream-and-plan-confirm.md) | Plan-confirm + HITL intent; transport superseded repeatedly → **0030 Pi events** |
| [0024](0024-session-as-conversational-workspace.md) | Conversational workspace intent; **useChat/UIMessage superseded by 0030** |
| [0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) | Single write path intent; **Mastra + toAISdkStream superseded by 0030** |
| [0027](0027-framework-first-session-stream.md) | Framework-first intent; **framework is Pi (0030), not Mastra/AI SDK** |

## Reading rules for agents

1. Prefer **CONTEXT.md** for domain terms.
2. Prefer **0032 + 0031 + 0030 + 0021 + 0022 + 0026 + 0028 + 0029** for “how the product is built” (0032 wins on Run execution, Session authority, events, and operator interfaces; 0031 wins on dependency direction; 0030 wins on Pi/tool stack; 0029 wins on no-compat culture).
3. Pre-0019 ADRs may say **Host** / **Host Instructions** → map to **Run Boundary** / **Run Instructions**.
4. Pre-0021 ADRs may assume **Python** harness → map duties to `@okf-wiki/core` + `@okf-wiki/agent`.
5. Pre-0030 ADRs may assume **Mastra / AI SDK / UIMessage / list_source tools** → map to **Pi AgentSession / JSONL / built-in tools** (0030).
6. Do **not** reintroduce: dual Staging writers, UIMessage Session history, Mastra workflow suspend as product HITL backbone, hand-rolled `list_source`/`write_wiki` tools, `bash` in Semantic Workflow, Session synthesis of business progress, Mastra/Pi inside `@okf-wiki/core`, **parallel operator body true-sources** (client maps / empty product streaming shells racing Pi messages) per 0031.
7. Operator events: [operator-event-contract](../design/operator-event-contract.md).
