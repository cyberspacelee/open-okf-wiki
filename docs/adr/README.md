# Architecture Decision Records

Domain vocabulary: [CONTEXT.md](../../CONTEXT.md). Package map: [packages/README.md](../../packages/README.md).

## Current stack (read these first)

| ADR | Role |
|---|---|
| [0020](0020-typescript-mastra-web-workspace.md) | TypeScript monorepo, Mastra Semantic Workflow, Web UI, Workspace, `@okf-wiki/core` Run Boundary (no Mastra in core) |
| [0021](0021-retire-python-primary-path.md) | Python primary path **removed** |
| [0022](0022-source-clone-into-workspace.md) | Operator-initiated clone; Semantic Workflow never clones |
| [0024](0024-session-as-conversational-workspace.md) | Operator Session = conversational workspace (`useChat` + parts) |
| [0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md) | **Single** wiki-run write path; Session uses `toAISdkStream`; no dual materialize / hand-rolled Session SSE |
| [0026](0026-session-centric-agent-workspace.md) | **Session-centric agent**: sole operate/observe surface; Run = Session-owned job (fg/bg); Run UI read-mostly |
| [0027](0027-framework-first-session-stream.md) | **Framework-first** Session stream/HITL: Mastra + AI SDK only; thin P1 shell; ban parallel converters |
| [0028](0028-wiki-writing-adopts-okf-page-format.md) | **OKF page format** on Wiki trees: concept FM, reserved index/log, dual links, hard gate (not Bundle producer) |

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
| [0003](0003-let-one-pydanticai-agent-own-the-semantic-loop.md) | Framework: Pydantic AI → Mastra (0020/0025) |
| [0004](0004-use-codemode-for-dynamic-repository-work.md) | **Superseded**: no CodeMode; discrete path-policy tools + Mastra subagents |
| [0006](0006-keep-python-as-a-thin-harness.md) | **Superseded** by 0020/0021 |
| [0010](0010-use-dynamic-workflow-for-bounded-leaf-coordination.md) | Historical DynamicWorkflow wording; leaf coordination still optional/adaptive |
| [0014](0014-use-planning-and-bounded-recursive-subagents.md) | Planning/subagents idea remains; stack is Mastra |
| [0023](0023-operator-session-stream-and-plan-confirm.md) | Plan-confirm + HITL still valid; **Session SSE transport superseded** by 0024/0025; **Run-as-primary HITL superseded** by 0026 |

## Reading rules for agents

1. Prefer **CONTEXT.md** for domain terms.
2. Prefer **0020 + 0021 + 0022 + 0024 + 0025 + 0026 + 0027** for “how the product is built today” (0026 wins on Session vs Run center; **0027** wins on framework-first stream/HITL).
3. Prefer **0028** for Wiki **page-format** contract (OKF concept pages, reserved docs, dual links, hard gate). Do not treat title-only frontmatter as current target.
4. Pre-0019 ADRs may say **Host** / **Host Instructions** → map to **Run Boundary** / **Run Instructions**.
5. Pre-0021 ADRs may assume **Python** harness → map duties to `@okf-wiki/core` + `@okf-wiki/agent`.
6. Do **not** reintroduce: dual Staging writers, Session-local materialize, `__choice__:` HITL, hand-rolled Session Mastra→SSE, parallel `toAISdkStream` business wrappers, Mastra dependency inside core; do **not** rename the product deliverable to Knowledge Bundle.
