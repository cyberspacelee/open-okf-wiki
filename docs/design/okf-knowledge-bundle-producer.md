# OKF Knowledge Bundle Producer — Overall Design

Status: Accepted design

Decision date: 2026-07-11

## Summary

The OKF Knowledge Bundle Producer derives an auditable Google Open Knowledge Format Knowledge Bundle from one or more fixed source revisions. It uses PydanticAI and an enterprise OpenAI-compatible model gateway for probabilistic source exploration, but keeps source inventory, coverage, evidence acceptance, state transitions, validation, review, and publication in a framework-independent Deterministic Control Plane.

The system does not claim that a probabilistic model can discover every implicit idea. Its enforceable promise is narrower:

> For a fixed Source Set and declared Producer Profile, every Major Obligation is covered or explicitly excluded, and every published Claim has resolvable Evidence References.

Domain vocabulary is defined in [CONTEXT.md](../../CONTEXT.md). Architectural rationale is recorded in [docs/adr](../adr/).

## Goals

- Produce a conformant, navigable OKF Knowledge Bundle from Java and Markdown repositories.
- Support a Producer Project composed of multiple independently versioned repositories.
- Let Agents dynamically choose directories, searches, read tools, and bounded parallel investigations.
- Prevent model context from becoming the system's source of truth.
- Make coverage, provenance, conflicts, deletion, and publication auditable.
- Support initial generation and revision-based incremental refresh.
- Evaluate Agent Roles, tool trajectories, and end-to-end knowledge quality before release.
- Operate entirely through static, read-only source analysis.
- Provide a local Workspace Console for setup, Run observation, review, Bundle reading, Concept provenance, and grounded questions.
- Separate accepted-knowledge questions from explicitly provisional Source Investigations.

## Non-goals for the MVP

- Executing builds, tests, compilers, package managers, repository scripts, or arbitrary shell commands.
- Recursive Agent spawning or a persistent Orchestrator Agent.
- A distributed multi-node Agent platform.
- Guarded Auto-publish.
- Enabled Web Enrichment.
- Pi, Codex, Rust, MCP, vector database, graph database, Temporal, PostgreSQL, Redis, Kafka, or NATS integrations.
- A remote multi-tenant management platform, collaborative Wiki editor, or direct editing of derived Bundle pages.
- Complete language-specific semantic analysis beyond Java and Markdown.
- A universal multi-language Tree-sitter platform.

## Core architecture

```text
CLI / CI / Webhook / Local Workspace Console
                    |
                    v
+-------------------------------+
| Run Worker                    |
|                               |
|  Deterministic Control Plane  |
|  - state machines             |
|  - Source Set / inventory     |
|  - Coverage Obligations       |
|  - acceptance / validation    |
|  - SQLite ledger / event log  |
|  - render / review / publish  |
|             |                 |
|             v                 |
|  Semantic Execution Plane     |
|  - Planner Agent              |
|  - Worker Agents              |
|  - Verifier Agents            |
|  - Renderer Agent             |
|  - Query Agent                |
+-------------+-----------------+
              |
              v
 Enterprise OpenAI-compatible Gateway
              |
              v
 staging/ -> review -> atomic OKF publish
```

### Deterministic Control Plane

The Deterministic Control Plane owns:

- Producer Project and Source Set resolution.
- fixed Source Snapshots and source digests.
- Source Universe inventory and classification.
- Coverage Policy and Coverage Obligations.
- Production Run, Analysis Task, and Coverage Obligation state machines.
- the Accepted Knowledge Model and Knowledge Impact Graph.
- structural validation and Acceptance Policy.
- staging, review, publication, and rollback-safe failure behavior.

Only deterministic code may mutate authoritative state.

### Semantic Execution Plane

The Semantic Execution Plane proposes:

- Analysis Task plans.
- Claims, Concepts, relations, aliases, and dispositions.
- Verification Findings.
- prose derived from accepted Claims.

Agents never directly close Coverage Obligations, edit the Accepted Knowledge Model, write formal bundle files, or publish.

### PydanticAI responsibilities

PydanticAI provides:

- model and OpenAI-compatible provider integration.
- tool execution and argument validation.
- bounded message history and context processing within one Agent task.
- structured outputs and output validation.
- retry, timeout, concurrency, and usage limits.
- role-level instrumentation and `pydantic-evals` integration.

PydanticAI message history is disposable execution context, not durable project state.

## Producer Project and Source Set

A Producer Project combines one or more named repositories into one Knowledge Bundle.

```yaml
project: order-platform

sources:
  - id: order-service
    uri: git@corp/order-service.git
    revision: abc123
    role: implementation

  - id: order-requirements
    uri: git@corp/order-requirements.git
    revision: def456
    role: requirements

  - id: shared-contracts
    uri: git@corp/shared-contracts.git
    revision: 789xyz
    role: contracts
```

A Production Run pins every Source Snapshot in the Source Set. Evidence identity includes source ID, revision, path, and span:

```text
repo://order-service@abc123/src/main/java/.../OrderService.java#L42-L88
```

Rules:

- Coverage and classification may depend on source role.
- Conflicting repositories produce disputed knowledge; source order does not silently resolve conflicts.
- Incremental invalidation begins only from changed Source Snapshots.
- Separate Producer Projects run independently in separate Run Workers.

## Source inventory and classification

### Git source rules

For a fixed revision, Git defines the versioned files:

```bash
git ls-tree -r --name-only <revision>
```

- Untracked ignored files are not part of the revision.
- Tracked files remain in the Source Universe even if a later `.gitignore` pattern matches them.
- Generated or vendor files that are tracked require an explicit exclusion disposition.
- Production Runs do not include dirty or untracked working-tree content by default.

### Source Units

Source Units are stable addressable portions of a Source Snapshot, including:

- Markdown sections.
- manifest declarations.
- Java types and methods.
- public routes, commands, handlers, and schemas.
- configuration, migration, and security declarations.
- tests that express a critical contract or failure mode.

### Java attention policy

The classifier assigns source roles before an Agent sees work.

| Java role | Default classification | Treatment |
|---|---|---|
| Controller, handler, command | Major | Entrypoint, authorization, request/response, flow |
| Service, use case, domain service | Major | Behavior, calls, rules, failure paths |
| Domain entity, aggregate, explicit state machine | Major | Invariants and transitions |
| Repository, DAO | Major or Supporting | Query meaning, transaction and persistence seam |
| Configuration, security | Major | Configuration and permission contract |
| DTO, VO, request, response | Supporting | Aggregate into a Data Contract |
| Mapper, converter | Supporting | Promote when it contains non-trivial transformation rules |
| Exception | Supporting | Aggregate by failure mode |
| Generated source, build output | Excluded | Record exclusion reason |
| Test | Supporting | Promote when it defines critical behavior |

A Data Carrier is promoted when it contains validation, serialization, security, state, domain-interface, or non-trivial behavioral semantics. The Planner Agent receives prioritized Coverage Obligations rather than a flat file list, so DTO volume cannot dominate attention.

The default Producer Profile excludes tracked Java paths matching `generated/**`, `vendor/**`, `**/generated/**`, `**/generated-sources/**`, or `**/vendor/**`. Projects may replace these `java_excluded_paths`; every match records the resolved rule in the exclusion reason.

The MVP begins with manifest, path, name, annotation, and structural rules. A focused Java parser may be introduced when the Benchmark Corpus proves the simpler classifier insufficient; this does not imply a universal AST platform.

## Coverage contract

The Producer Profile classifies Coverage Obligations as Major or Supporting.

### Major Obligations

Every Major Obligation must end as:

```text
COVERED | EXCLUDED(reason)
```

`OPEN`, `BLOCKED`, or `FAILED` Major Obligations prevent publication.

Default Major knowledge includes:

- manifests and top-level modules.
- application, service, and CLI entrypoints.
- public APIs, routes, commands, and event handlers.
- data schemas, configuration contracts, and migrations.
- requirements, acceptance criteria, and normative statements.
- explicit domain terms and load-bearing business flows.
- security, permissions, persistence seams, and critical failure modes.
- ADRs and explicit non-goals.

### Supporting Obligations

Supporting Obligations must be inventoried and may end as:

```text
COVERED | EXCLUDED(reason) | DEFERRED(reason)
```

Deferred knowledge appears in the deterministic coverage report.

## Accepted Knowledge Model

The authoritative intermediate representation is:

```text
Source Unit
  -> Coverage Obligation
  -> Claim
  -> Concept
  -> Page Plan
  -> OKF Markdown
```

### Claim

A Claim is atomic and records at least:

- stable ID.
- subject, predicate, and statement.
- modality and conditions where relevant.
- epistemic status.
- Evidence References.
- conflicts and supersession links.

### Evidence Reference

An Evidence Reference records:

- source ID and revision.
- path and source-unit ID.
- line or structural span.
- quoted-content digest.
- evidence kind and authority.

### Concept

A Concept records:

- stable ID and canonical name.
- aliases.
- defining Claim IDs.
- supporting Claim IDs.
- relations and status.

Source symbols, files, and pages are not automatically Concepts.

## Agent workflow and context discipline

There is no persistent Orchestrator Agent.

```text
Scheduler
  -> fresh Planner Agent
  -> bounded Analysis Tasks
  -> parallel Worker Agents
  -> deterministic acceptance
  -> fresh Verifier Agents
  -> repeat until closure
```

### Planner Agent

Each Planner Agent receives only a bounded control summary:

- Production Run and Producer Profile identifiers.
- Source Set summary.
- coverage totals and prioritized uncovered obligations.
- current tasks and remaining budgets.
- compact receipts from previous work.

It returns a typed `TaskPlan` and exits.

### Worker Agent

Each Worker Agent receives:

- explicit Coverage Obligation IDs.
- allowed source IDs and paths.
- allowed read-only tools.
- token, tool-call, and wall-time budgets.
- expected typed output.

Workers cannot spawn additional Agents. Full results go to deterministic acceptance; the Planner receives only a compact receipt containing accepted IDs, unresolved IDs, and warnings.

### Context storage

Claims, Concepts, Evidence References, Findings, and coverage live in SQLite. Agents query them through bounded tools such as:

```text
next_uncovered(limit)
get_coverage_summary()
find_existing_concepts(query)
get_claims_for_obligation(id)
get_conflicts(concept_id)
```

No Agent receives the entire repository, event log, or Accepted Knowledge Model in one prompt.

## State machines

### Production Run

```text
NEW
 -> PREPARING
 -> EXPLORING <-------------------+
 -> VERIFYING --semantic gap------+
 -> RENDERING
 -> CHECKING
      |--semantic gap--> EXPLORING
      |--render defect-> RENDERING
      |--review--------> REVIEW_REQUIRED
      +--approved------> PUBLISHING
 -> PUBLISHED

Terminal alternatives: FAILED | CANCELLED
```

The MVP defaults to `CHECKING -> REVIEW_REQUIRED`. Only `PUBLISHED` is a successful terminal state.

### Analysis Task

```text
PLANNED -> RUNNING -> SUBMITTED -> ACCEPTED
                              \-> REJECTED
                              \-> FAILED
```

Rejected work reopens or replans the affected Coverage Obligations. A distributed lease state is intentionally absent from the MVP.

### Coverage Obligation

```text
OPEN -> ASSIGNED -> COVERED
                 \-> EXCLUDED
                 \-> DEFERRED   supporting only
                 \-> BLOCKED
```

Agents propose dispositions; deterministic code applies them.

## Transactional events

State tables are authoritative. Every accepted transition appends a Run Event in the same SQLite transaction.

```text
Command
 -> validate
 -> update state
 -> append Run Event
 -> commit
```

Representative events:

```text
RunPrepared
TaskPlanned
TaskStarted
ExtractionSubmitted
ExtractionAccepted
ExtractionRejected
ObligationCovered
VerificationPassed
VerificationFailed
BundleRendered
ReviewApproved
CheckPassed
CheckFailed
BundlePublished
```

The MVP is not fully event sourced and has no message bus. A transactional outbox is added only when distributed workers are introduced.

## Verification and acceptance

### Deterministic validation

The Deterministic Control Plane checks:

- typed schema and state transition validity.
- allowed source scope and tool usage.
- revision, path, span, and digest resolvability.
- evidence presence for every Claim.
- Major Obligation closure.
- Concept and path identity.
- OKF conformance, links, indexes, and reserved files.
- unexplained deletion and source drift.
- security, network, and budget policy.

Deterministic failures cannot be overridden by an Agent.

### Semantic verification

Independent Verifier Agents submit typed Verification Findings from explicit perspectives:

- evidence entailment.
- coverage completeness.
- contradiction detection.
- Concept boundary, merge, split, and alias correctness.
- security and risk semantics.
- rendered knowledge quality.

Verifiers reread Evidence References and do not share Worker Agent message history.

### Acceptance Policy

The Producer Profile declares mandatory verification and review behavior by risk and knowledge type. Verifiers cannot mutate Claims, Concepts, or Coverage Obligations. Disputed or unresolved high-risk knowledge enters Review Required rather than model voting.

## Incremental refresh

The Knowledge Impact Graph records:

```text
Source Unit -> Evidence Reference -> Claim -> Concept -> Page
```

For a new Source Set:

1. compare each old and new source revision.
2. relocate unchanged evidence by digest where possible.
3. invalidate changed or removed evidence.
4. mark affected Claims for reverification.
5. recompute affected Concepts, pages, and Coverage Obligations.
6. analyze new Source Units.
7. run full publication gates before release.

An Agent's failure to mention old knowledge is never a deletion instruction. Removing a Claim or Concept requires loss of defining evidence, no replacement evidence, renewed coverage closure, and verification. Otherwise it remains stale, disputed, or review-required.

Incremental refresh is an optimization; when impact cannot be explained, the Producer falls back to full analysis.

## Read-only security model

Repositories are untrusted Source Snapshots.

- Source Snapshots are immutable and mounted read-only.
- repository instructions, comments, and documentation are data, not system policy.
- only allowlisted list/search/read tools are exposed.
- resolved paths must remain inside the assigned Source Snapshot and task scope.
- Agents cannot execute shell commands or write source or bundle files.
- no builds, tests, compilers, annotation processors, package managers, or repository scripts run.
- model and publication credentials do not enter prompts, traces, or source sandboxes.
- Agents submit typed proposals to the ledger; deterministic code writes staging output.
- publication uses a separate capability from analysis.

## External Knowledge Sources

The data model supports External Knowledge Sources, but Web Enrichment is disabled in the MVP.

When enabled later, each source requires explicit seeds, host/path allowlists, budgets, content digests, truncation records, and an Authority Level. External evidence cannot silently close repository-derived Major Obligations or override conflicting source facts.

## OKF Producer Profile

The default bundle structure is:

```text
index.md
log.md
overview.md
architecture/
modules/
flows/
concepts/
requirements/
decisions/
guides/
references/
reports/
```

Rules:

- `index.md` and `log.md` follow OKF reserved-file rules.
- all other Markdown documents have non-empty `type` frontmatter.
- the top-level taxonomy is fixed by the Producer Profile.
- the Accepted Knowledge Model determines pages inside each category.
- Data Carriers are represented through aggregated Data Contracts.
- frontmatter, IDs, paths, indexes, links, logs, and coverage reports are deterministic.
- prose may be generated by the Renderer Agent only from accepted Claims.
- every factual paragraph maps to one or more Claim IDs.

## Review and publication

The MVP supports Review Mode only.

Reviewers inspect:

- coverage and exclusions.
- new, changed, deleted, stale, and disputed Claims.
- Concept creation, merge, split, rename, and deletion.
- Verification Findings.
- bundle changes from the last published Source Set.

Reviewers resolve authoritative knowledge and Findings, not derived Markdown. Approval triggers a final deterministic check and atomic replacement of the published bundle.

Guarded Auto-publish is deferred. When introduced, it must fall back to review for disputes, high-risk semantic changes, defining-evidence deletion, major exclusions, source conflicts, review findings, and significant model, prompt, tool, schema, or Producer Profile changes.

## Agent Evaluation

Agent Evaluation is part of the MVP.

### Role evaluations

- Planner: valid bounded tasks, priority, duplication, scope, and budget behavior.
- Worker: scope adherence, Claim atomicity, Evidence validity, Data Carrier handling, and unsupported output.
- Verifier: recall and precision over seeded entailment, contradiction, omission, risk, and Concept-boundary defects.
- Renderer: Claim grounding, defining-Claim inclusion, consistency, and readability.

### Trajectory evaluation

Evaluate the sequence from assigned obligations through searches, reads, tools, proposals, retries, and termination. Detect repeated low-value search, DTO attention capture, needless tools, scope violations, retry loops, and budget waste.

### End-to-end evaluation

The Benchmark Corpus covers at least:

- a Java/Spring repository.
- a DTO-heavy Java repository.
- a Markdown requirements repository.
- conflicting code and documentation.
- a multi-module and multi-repository Producer Project.
- incremental histories and Mutation Cases.

Hard publication invariants require complete Major disposition, Evidence resolvability, revision match, valid OKF output, zero broken internal links, zero unexplained deletions, and zero unresolved critical conflicts.

Initial semantic targets:

```text
supported Claim precision       >= 95%
major knowledge recall          >= 95%
Concept precision               >= 90%
Concept recall                  >= 90%
wrong merge/split rate           < 5%
critical unsupported Claims        0
```

Identical Source Sets and configuration run at least three times; Major Obligation closure must remain 100%, critical Finding variance must remain zero, and Major Claim and canonical Concept set Jaccard similarity targets at least 0.90.

Use `pydantic-evals` for role, trajectory, and end-to-end cases. Use pytest for deterministic state, storage, validation, rendering, and security behavior. Production traces are sampled for offline, content-controlled review and never mutate production state.

Changes to models, prompts, tool schemas, classifiers, Coverage Policies, Producer Profiles, the locked PydanticAI version, Agent workflows, or knowledge schemas rerun the release gate.

## Technology baseline

```text
Python 3.14
uv + pyproject.toml + uv.lock
Pydantic 2
PydanticAI 2.8.x
enterprise OpenAI-compatible gateway
stdlib sqlite3
markdown-it-py
PyYAML safe_load / safe_dump
git CLI + ripgrep
pytest + Ruff
ty 0.0.58 (exact-pinned, advisory only)
Bun
Vite + React
shadcn Base UI
```

`pyproject.toml` constrains PydanticAI to the 2.8 series and the committed `uv.lock` fixes the exact resolved version. During development, the rolling official PydanticAI documentation and `llms.txt` may be used for discovery, but claims about framework behavior must be checked against the official release tag matching the lockfile version, initially `v2.8.0`, using that tag's documentation, source, or tests. Enterprise gateway support for tool calling, structured output, retries, streaming, and concurrency is established by local contract tests rather than inferred from the phrase “OpenAI-compatible.” Development-time documentation lookup does not enable Web Enrichment for Production Runs.

Required CI checks are `uv lock --check`, `uv sync --locked`, pytest, `ruff check .`, and `ruff format --check .`. `ty` is exact-pinned and may run locally or in a non-required CI job; it becomes a hard gate only after the pinned version has a clean, accepted baseline and its upgrade policy is explicitly owned.

The first implementation uses one evaluated model for all Agent Roles while keeping role-to-model assignment configurable. Roles use independent prompts and message histories. Role-specific or second-model verification is introduced only when the Benchmark Corpus or high-risk review demonstrates value.

## Run Worker and storage

One Run Worker owns one Production Run:

- one deterministic Scheduler writes authoritative state.
- Planner, Worker, Verifier, and Renderer calls may execute concurrently within controlled limits.
- SQLite stores current state and the transactional Run Event log.
- each Run has an isolated working directory and staging area.
- multiple Producer Projects run in independent Run Workers.

Logical storage includes:

```text
producer_projects
source_snapshots
source_units
production_runs
analysis_tasks
coverage_obligations
claims
evidence_references
concepts
concept_claims
verification_findings
page_plans
run_events
reviews
```

PostgreSQL and a queue are introduced only when a single Production Run must span processes or machines, workers must share a ledger, SQLite contention violates an SLO, or centralized HA and tenant isolation become required.

## Human and automation surfaces

```bash
okf-wiki build <project-config>
okf-wiki status <run-id>
okf-wiki check <run-id-or-bundle>
okf-wiki review <run-id> --approve
okf-wiki review <run-id> --reject
okf-wiki ui [workspace]
```

`build` creates or refreshes a Production Run from the Source Set. The MVP stops successful runs at Review Required; approval performs final checks and publication.

Review produces a human-readable Markdown report, machine-readable status/check output, and a local Workspace Console view with Claim/Concept diffs, Evidence References, Verification Findings, and digest-checked approval or rejection. CLI and CI remain complete automation adapters. Remote multi-user review queues, authentication and authorization, and hosted service workflows remain deferred.

## MVP delivery boundary

The MVP delivers:

- multi-repository Producer Projects and fixed Source Sets.
- Java and Markdown inventory, classification, and coverage.
- PydanticAI Planner, Worker, Verifier, and Renderer roles.
- dynamic single-level Agent task planning with bounded context.
- Accepted Knowledge Model and Knowledge Impact Graph.
- SQLite state machines and transactional Run Events.
- initial generation and revision-based refresh.
- deterministic OKF rendering, review, checks, and atomic publication.
- Benchmark Corpus, Mutation Cases, role/trajectory/end-to-end Agent Evaluation, and upgrade gates.
- local Workspace Console with safe Source Checkout management, Run visualization, read-only Bundle rendering, Concept provenance, and grounded questions.

The MVP deliberately skips every item listed under Non-goals until a benchmark, scale measurement, or real user workflow proves it necessary.

## Related research

- [LLM Wiki landscape and reliability](../research/llm-wiki-landscape.md)
- [2026 technology stack](../research/2026-tech-stack.md)
- [Pi, Rust, and PydanticAI comparison](../research/pi-rust-pydanticai-comparison.md)
- [Development tooling guidance](../research/development-tooling-guidance.md)

## Architectural decisions

- [ADR-0001: Separate deterministic control from semantic execution](../adr/0001-separate-control-and-semantic-planes.md)
- [ADR-0002: Use stateless planning and bounded workers](../adr/0002-use-stateless-planning-and-bounded-workers.md)
- [ADR-0003: Use state machines with a transactional event log](../adr/0003-use-state-machines-with-a-transactional-event-log.md)
- [ADR-0004: Publish only after major coverage closes](../adr/0004-publish-only-after-major-coverage-closes.md)
- [ADR-0005: Classify source before agent attention](../adr/0005-classify-source-before-agent-attention.md)
- [ADR-0006: Render bundles from an accepted knowledge model](../adr/0006-render-bundles-from-an-accepted-knowledge-model.md)
- [ADR-0007: Combine deterministic and semantic verification](../adr/0007-combine-deterministic-and-semantic-verification.md)
- [ADR-0008: Refresh by impact and reverification](../adr/0008-refresh-by-impact-and-reverification.md)
- [ADR-0009: Analyze source without executing it](../adr/0009-analyze-source-without-executing-it.md)
- [ADR-0010: Start with isolated single-run workers](../adr/0010-start-with-isolated-single-run-workers.md)
- [ADR-0011: Make web enrichment explicit and non-authoritative by default](../adr/0011-make-web-enrichment-explicit-and-non-authoritative-by-default.md)
- [ADR-0012: Fix the producer profile taxonomy](../adr/0012-fix-the-producer-profile-taxonomy.md)
- [ADR-0013: Default to reviewed publication](../adr/0013-default-to-reviewed-publication.md)
- [ADR-0014: Gate releases on a versioned benchmark](../adr/0014-gate-releases-on-a-versioned-benchmark.md)
- [ADR-0015: Build one bundle from a versioned source set](../adr/0015-build-one-bundle-from-a-versioned-source-set.md)
- [ADR-0016: Make agent evaluation a release gate](../adr/0016-make-agent-evaluation-a-release-gate.md)
- [ADR-0017: Keep one producer project per workspace](../adr/0017-keep-one-producer-project-per-workspace.md)
- [ADR-0018: Manage Git checkouts without owning credentials](../adr/0018-manage-git-checkouts-without-owning-credentials.md)
- [ADR-0019: Separate shared workspace definition from local settings](../adr/0019-separate-shared-workspace-definition-from-local-settings.md)
- [ADR-0020: Serve a local workspace console from the Python control plane](../adr/0020-serve-a-local-workspace-console-from-the-python-control-plane.md)
- [ADR-0021: Use reusable local gateway profiles](../adr/0021-use-reusable-local-gateway-profiles.md)
- [ADR-0022: Separate knowledge queries from source investigations](../adr/0022-separate-knowledge-queries-from-source-investigations.md)
