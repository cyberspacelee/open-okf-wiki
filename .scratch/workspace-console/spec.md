# Workspace Console

Status: ready-for-agent

## Problem Statement

Users currently operate the OKF Knowledge Bundle Producer through configuration files and machine-readable CLI output. That interface is appropriate for CI and automation, but it makes the main human workflows unnecessarily difficult: initializing a product or project, configuring several code and documentation repositories, managing local Git checkouts, configuring the enterprise LLM gateway, understanding a Production Run, reviewing semantic changes, reading the generated Knowledge Bundle, tracing how a Concept formed, and asking grounded questions.

The existing Markdown review report and status payload expose the relevant facts, but users must mentally connect Coverage Obligations, Analysis Tasks, Evidence References, Claims, Verification Findings, Concepts, Bundle pages, and Run Events. This increases cognitive load and makes important exclusions, disputes, stale knowledge, source changes, model costs, and publication blockers easier to miss.

The Producer needs a local graphical interface that improves setup, observation, review, and knowledge consumption without creating a second source of truth, executing repository code, weakening fixed-revision guarantees, exposing credentials, or turning derived Markdown into editable authoritative state.

## Solution

Add a loopback-only Workspace Console for one user-initialized Workspace representing one product or project. One Workspace owns one Producer Project, may combine multiple code, documentation, requirements, and contract repositories, and produces one Knowledge Bundle.

The Console lets users initialize and configure the Workspace, clone or link Source Checkouts, safely pull changes, select follow-branch or pinned-commit revision policies, configure publication, select reusable machine-local Gateway Profiles and model assignments, start and observe Production Runs, review authoritative knowledge changes, render the staged or published Markdown Bundle, replay Concept provenance, and ask grounded questions.

The Python Deterministic Control Plane remains the only authority for configuration validation, Git safety, exact Source Snapshot resolution, state transitions, knowledge acceptance, review, and publication. The Console is a Vite and React client using shadcn Base UI, served as static assets by the Python process. CLI, CI, and the local HTTP interface call the same application use cases.

Ordinary Knowledge Queries use only the fixed Accepted Knowledge Model and return explicit Claim and Evidence citations. When accepted knowledge is insufficient, users may explicitly start a Source Investigation against the fixed Source Snapshot. Source Investigation results are provisional, visibly separated from accepted answers, and cannot affect obligations, review, publication, or authoritative knowledge without a later normal Production Run.

## User Stories

1. As a product owner, I want to initialize a Workspace for one product or project, so that its knowledge-production configuration has a clear home.
2. As a product owner, I want one Workspace to produce one Knowledge Bundle, so that configuration, review, and publication remain unambiguous.
3. As a product owner, I want to name and describe the Producer Project from the Console, so that users understand what the Workspace represents.
4. As a product owner, I want to configure code, documentation, requirements, and contract repositories together, so that one Bundle can represent the complete product context.
5. As a product owner, I want Workspace Definition settings separated from machine-specific settings, so that shared production intent remains portable.
6. As a teammate, I want to reuse a shared Workspace Definition on another machine, so that Sources, roles, policies, and publication intent do not have to be recreated manually.
7. As a teammate, I want local checkout paths and UI preferences kept out of shared configuration, so that another machine's details do not break my Workspace.
8. As an auditor, I want every Production Run to record its fully resolved non-secret configuration, so that later edits to Workspace settings do not change the meaning of a past Run.
9. As a repository maintainer, I want to clone a configured Source through the Console, so that I can start from an empty Workspace.
10. As a repository maintainer, I want managed clones stored under the Workspace, so that their ownership and lifecycle are obvious.
11. As a repository maintainer, I want to link an existing local repository, so that I do not need to duplicate a checkout I already use.
12. As a repository maintainer, I want linked repositories to remain externally owned, so that removing a Workspace cannot delete my existing work.
13. As a repository maintainer, I want every Source to have a stable ID and role, so that Evidence References remain unambiguous across repositories.
14. As a repository maintainer, I want to see each Source's remote, branch, commit, dirty state, and ahead/behind status, so that I understand what a Run would use.
15. As a repository maintainer, I want the Console to use my existing Git, SSH agent, and credential helpers, so that it does not create another Git credential store.
16. As a repository maintainer, I want to pull a clean Source Checkout from the Console, so that keeping Sources current is convenient.
17. As a repository maintainer, I want Pull blocked when tracked or untracked local changes exist, so that the Producer cannot overwrite or hide my work.
18. As a repository maintainer, I want the Console never to stash, reset, clean, force-checkout, or overwrite automatically, so that Git mutations remain predictable.
19. As a repository maintainer, I want removing a Source and deleting its managed clone to be separate actions, so that configuration cleanup cannot accidentally destroy data.
20. As a project owner, I want a Source to follow a named branch by default, so that a new Run can use the latest intentionally pulled revision.
21. As a project owner, I want to pin a Source to an exact commit, so that a Workspace can deliberately remain on a known revision.
22. As an auditor, I want each Production Run to resolve every revision policy to an exact commit, so that branch movement cannot alter an existing Run.
23. As an auditor, I want dirty and untracked content excluded from authoritative Source Snapshots, so that a Run remains reproducible.
24. As an operator, I want invalid repository paths, missing commits, unreachable remotes, and unsupported Git states explained in the Console, so that I can repair them without reading raw exceptions.
25. As an operator, I want reusable Gateway Profiles, so that several Workspaces can use the same enterprise model gateway without copying secrets.
26. As an operator, I want to configure a Gateway Profile's name, endpoint, headers, and credential through a page, so that LLM connectivity is manageable without environment-variable editing.
27. As a security engineer, I want Gateway credentials stored in the operating-system credential store when available, so that secrets receive platform protection.
28. As a security engineer, I want a permission-restricted local fallback when no credential store is available, so that headless machines remain usable without placing keys in shared configuration.
29. As a security engineer, I want credentials excluded from Workspace Definitions, Run snapshots, prompts, traces, logs, diagnostics, and Bundle output, so that repository content and reviewers cannot obtain them.
30. As an operator, I want to test gateway connectivity and required capabilities before a Run, so that tool calling, structured output, concurrency, and error behavior fail early.
31. As a project owner, I want to select a default model for a Workspace, so that ordinary setup remains simple.
32. As an advanced operator, I want optional model overrides by Agent Role, so that Planner, Worker, Verifier, Renderer, and Query Agent routing can evolve when evaluation supports it.
33. As a cost owner, I want to configure model concurrency and budgets in the Console, so that cost and throughput remain bounded.
34. As an auditor, I want each Run to record actual model assignments and non-secret gateway settings, so that semantic results are traceable.
35. As a release owner, I want model and routing changes subject to the Benchmark Corpus, so that a convenient page setting cannot bypass quality gates.
36. As a user, I want an Overview page showing Source health, latest Bundle, active Run, blockers, and quick actions, so that I can understand the Workspace at a glance.
37. As a user, I want dense operational information shown through tables, status badges, progress, and filters, so that the interface remains readable at repository scale.
38. As a user, I want global navigation and command search, so that Sources, Runs, Review, Knowledge, Concepts, Settings, and Connections are quickly reachable.
39. As an operator, I want to start a Production Run from the Console, so that normal use does not require copying CLI commands.
40. As an operator, I want the Run creation view to show the exact Source commits and resolved configuration before starting, so that accidental inputs are visible.
41. As an operator, I want to observe Preparing, Exploring, Verifying, Rendering, Checking, Review Required, and Published phases, so that progress is understandable.
42. As an operator, I want phase timestamps and failures shown in a stepper, so that I can locate where time or failure occurred.
43. As an operator, I want Planner and Worker task lanes with assigned Sources, paths, obligations, and budgets, so that parallel work remains auditable.
44. As an operator, I want Coverage Obligation state changes shown as recorded events, so that coverage closure is not a hidden aggregate.
45. As a cost owner, I want token, tool-call, retry, latency, and failure summaries, so that model quality can be weighed against operating cost.
46. As an operator, I want to cancel an active Run safely, so that no new work starts and no partial Bundle is published.
47. As an operator, I want to recover an interrupted Run from a deterministic checkpoint, so that transient failures do not require starting over.
48. As an auditor, I want a replayable Run Event timeline, so that I can understand the accepted sequence without model conversation history.
49. As a compliance owner, I want the Console to show typed proposals, tool summaries, Findings, and deterministic decisions but never chain-of-thought, so that transparency does not expose private reasoning or create false authority.
50. As a reviewer, I want Review Required Runs listed clearly, so that pending human decisions are not confused with failures.
51. As a reviewer, I want coverage totals split by source, role, priority, and disposition, so that omissions are visible.
52. As a reviewer, I want Major exclusions and Supporting deferrals shown with reasons, so that intentional omissions are auditable.
53. As a reviewer, I want added, changed, removed, stale, disputed, merged, and split Claims and Concepts grouped separately, so that semantic changes are understandable.
54. As a reviewer, I want Verification Findings grouped by perspective and severity, so that evidence, contradiction, Concept-boundary, risk, and rendering concerns remain distinguishable.
55. As a reviewer, I want to open exact Evidence Reference excerpts at their fixed source revision, so that I can verify a Claim without searching manually.
56. As a reviewer, I want a staged-versus-published Bundle diff, so that I understand the user-visible effect of approval.
57. As a reviewer, I want to approve or reject through the Console, so that the primary human workflow is complete without the CLI.
58. As an auditor, I want the review screen tied to an authoritative digest, so that a decision cannot approve state that changed after the page loaded.
59. As a reviewer, I want stale approval attempts rejected with an explanation and refreshed snapshot, so that I never unknowingly approve different knowledge.
60. As a reviewer, I want final deterministic checks repeated after approval, so that review cannot bypass publication gates.
61. As a publisher, I want approval to atomically replace the published Bundle, so that readers never observe a partial update.
62. As a publisher, I want rejection to leave the published Bundle unchanged and return the Run to an actionable state, so that revision remains safe.
63. As a knowledge consumer, I want the current staged or published Bundle rendered in the Console, so that I can read it without a separate Markdown application.
64. As a knowledge consumer, I want headings, lists, tables, task lists, fenced code, links, and images rendered safely, so that ordinary Bundle pages remain useful.
65. As a knowledge consumer, I want syntax highlighting, Mermaid, and mathematical notation, so that technical material is readable.
66. As a security engineer, I want raw HTML, scripts, remote iframes, and MDX execution disabled, so that source repositories cannot execute browser code.
67. As a knowledge consumer, I want a source/rendered toggle, so that I can inspect the exact generated Markdown when needed.
68. As a knowledge consumer, I want frontmatter displayed as structured metadata, so that IDs, type, revision, and Claim associations are understandable.
69. As a knowledge consumer, I want Claim markers and citations to be interactive, so that prose can be traced to accepted knowledge and source evidence.
70. As a knowledge consumer, I want internal links, outlines, backlinks, and search, so that the Bundle is navigable beyond a file tree.
71. As a knowledge consumer, I want unified and split page diffs, so that incremental changes are easy to inspect.
72. As an accessibility user, I want the reader and operational pages keyboard navigable with correct focus and labels, so that the Console is usable without a pointer.
73. As an accessibility user, I want Concept and Run animations to respect reduced-motion preferences, so that visualization does not make the interface unusable.
74. As an architect, I want to inspect a Concept's defining and supporting Claims separately, so that its identity and context are clear.
75. As an architect, I want to trace Source Units through Evidence References, Claims, Verification, Concepts, and Bundle pages, so that knowledge provenance is explicit.
76. As an architect, I want disputed, stale, conflicting, superseded, and rejected nodes visually distinct, so that uncertainty is not hidden.
77. As an auditor, I want Concept formation replayed from recorded events, so that animation represents accepted history rather than decorative inference.
78. As an auditor, I want Claim and Concept events linked to their originating candidate, so that provenance survives after model messages are discarded.
79. As a reviewer, I want incremental impact animated from changed Source Units to affected knowledge and pages, so that refresh behavior is understandable.
80. As a user, I want to pause, scrub, and directly navigate a provenance replay, so that animation remains an inspection tool rather than passive decoration.
81. As a knowledge consumer, I want to ask a question about the current Concept or page, so that the answer remains tightly scoped.
82. As a knowledge consumer, I want to ask a question about the complete accepted Knowledge Bundle, so that I can discover cross-page knowledge.
83. As a knowledge consumer, I want ordinary answers based only on accepted Claims and Evidence References, so that the Ask experience preserves the Bundle's trust model.
84. As a knowledge consumer, I want every answer to cite Claims and exact Evidence References, so that I can verify it.
85. As a knowledge consumer, I want the Console to say when accepted knowledge is insufficient, so that uncertainty is not filled with plausible prose.
86. As a knowledge consumer, I want to see the Run and Source Set digest used for an answer, so that later source changes do not obscure its basis.
87. As a privacy-conscious user, I want disclosure of what question and accepted evidence will be sent to the enterprise gateway, so that model data egress is explicit.
88. As a privacy-conscious user, I want question sessions ephemeral by default, so that exploratory conversations do not become authoritative or permanently stored.
89. As an auditor, I want non-content query metadata such as model, usage, latency, and cited IDs available for evaluation, so that quality and cost can be measured without retaining conversation text by default.
90. As a knowledge consumer, I want an explicit Investigate Source action when the Bundle cannot answer, so that I can explore a real knowledge gap.
91. As a knowledge consumer, I want Source Investigation results clearly marked provisional, so that they cannot be mistaken for accepted Wiki knowledge.
92. As a security engineer, I want Source Investigations constrained to fixed Source Snapshots and bounded read/search tools, so that questions cannot execute repositories or escape scope.
93. As a reviewer, I want provisional Source Investigation results excluded from review resolution and publication, so that they cannot bypass verification.
94. As a knowledge owner, I want provisional findings to enter authoritative knowledge only through a later normal Production Run, so that acceptance remains consistent.
95. As an automation user, I want CLI and CI workflows to remain fully functional without the Console, so that graphical support does not weaken scripting.
96. As an automation user, I want CLI and HTTP adapters to observe the same validation, state transitions, and results, so that behavior does not depend on the chosen interface.
97. As a security engineer, I want the Console bound to loopback by default, so that local state is not unintentionally exposed on the network.
98. As a security engineer, I want an unguessable session token and origin validation on state-changing requests, so that malicious websites cannot operate the local tool.
99. As a security engineer, I want a restrictive Content Security Policy and no CDN assets, analytics, or external fonts, so that the Console can operate locally without hidden network dependencies.
100. As a security engineer, I want Markdown and Mermaid output sanitized, so that repository-controlled content cannot execute active browser behavior.
101. As a security engineer, I want Git and source excerpts constrained to registered checkout, revision, and path scopes, so that UI requests cannot read unrelated files.
102. As a user, I want destructive local actions protected by explicit confirmation, so that deleting a managed clone cannot happen accidentally.
103. As an offline user, I want the Console shell and accepted Bundle reader to load without external assets, so that local review remains available without internet access.
104. As a maintainer, I want the frontend shipped as static assets by the Python process, so that deployment does not require a second server runtime.
105. As a maintainer, I want shadcn Base UI primitives used consistently, so that forms, navigation, overlays, feedback, and accessibility do not become bespoke implementations.
106. As a maintainer, I want custom visual code limited to Run timelines, Concept provenance, and Markdown diff, so that the UI remains maintainable.
107. As a maintainer, I want no Next.js or TanStack Start server, so that the Python control plane remains the single server-side authority.
108. As a release owner, I want browser, security, accessibility, Query Agent, and adapter-contract checks in CI, so that the Console cannot silently weaken Producer guarantees.

## Implementation Decisions

- One Workspace represents one product or project, owns exactly one Producer Project, and produces one Knowledge Bundle. A different audience or Bundle uses a separate Workspace.
- The Workspace Console is a local browser interface and an adapter over the existing Python application interface. It is not an authoritative state owner.
- The frontend uses Vite, React, and shadcn Base UI. It is built to static assets and served by the Python process. Next.js, TanStack Start, and a second server-side JavaScript runtime are not introduced.
- Base UI composition conventions are used consistently. Navigation, data display, forms, overlays, feedback, and loading states use shadcn primitives before custom markup. Custom rendering is reserved for domain-specific timelines, graphs, and diffs.
- CLI, CI, and HTTP adapters call the same application use cases. Validation, transactions, state machines, Git policy, acceptance, review, and publication remain in Python.
- The Workspace Definition is the shareable declaration of Producer Project identity, Sources, roles, remote locations, Source Revision Policies, Producer Profile, and publication intent.
- Local Workspace Settings hold machine-specific checkout bindings, selected Gateway Profile, model assignments, concurrency, budgets, UI preferences, and local server state.
- Production Runs persist a fully resolved non-secret configuration snapshot and exact model assignments.
- A Workspace supports managed Source Checkouts cloned beneath the Workspace and linked Source Checkouts that remain externally owned.
- Git authentication is delegated to the user's existing Git configuration, SSH agent, and credential helpers. The Producer does not create or manage Git credentials.
- Pull is allowed only for clean checkouts. The Producer never automatically stashes, resets, cleans, force-checks out, or overwrites local changes.
- Removing a Source from configuration never deletes a linked checkout. Deleting a managed checkout is a separate destructive operation requiring explicit confirmation.
- Sources support follow-branch and pinned-commit policies. Production Run creation resolves every policy to an exact commit and immutable Source Snapshot.
- Gateway Profiles are reusable machine-local connections containing endpoint metadata, secret references, request headers, and capability-test results.
- Gateway secrets use the operating-system credential store where available, with a permission-restricted local fallback. Secrets never enter shared configuration, Run snapshots, model prompts, traces, diagnostics, or Bundle output.
- A Workspace selects one default model. Optional Agent Role overrides remain advanced settings and must be protected by the existing Benchmark Corpus and Agent Evaluation policy.
- The Console exposes Overview, Sources, Runs, Review, Knowledge, Concepts, Settings, and Connections surfaces.
- Run visualization is derived from persisted states, Analysis Tasks, Coverage Obligations, audit data, and Run Events. It never exposes chain-of-thought or presents simulated model reasoning as fact.
- Claim, Concept, and verification acceptance append sufficient entity events and candidate links to reconstruct Concept provenance after model conversation history is discarded.
- Polling is the initial live-update transport. Streaming is introduced only when measured behavior shows polling is inadequate.
- Review data is presented as an immutable Review Snapshot carrying its authoritative digest. Approve and reject operations require the expected digest and fail if state has changed.
- Approval reruns deterministic validation and uses the existing atomic publication behavior. Rejection preserves the published Bundle and returns the Run to an actionable state.
- The Markdown reader is read-only. It renders CommonMark/GFM, code, Mermaid, and mathematical notation under restrictive policies, presents frontmatter structurally, and links prose to Claims and Evidence References.
- Raw HTML, scripts, remote iframes, MDX execution, and editing of derived Markdown are disabled.
- Ordinary Knowledge Queries are scoped to the current Concept/page or the complete Accepted Knowledge Model. The Query Agent is short-lived, read-only, bounded, and required to return Claim and Evidence citations or an insufficient-support result.
- Query sessions are ephemeral by default. Audit may persist non-content metadata such as Run identity, model assignment, usage, latency, and cited IDs without persisting question or answer text unless explicitly exported.
- Source Investigation is an explicit second mode. It uses bounded read/search tools over a fixed Source Snapshot, labels all output provisional, and cannot mutate knowledge, close obligations, resolve review, or enter publication.
- Initial retrieval reuses deterministic Concept and Claim lookup. SQLite full-text search may be added when measured need exceeds existing lookup. Embeddings and vector databases are not introduced by this feature.
- The local server binds to loopback by default, uses an unguessable session token, validates request origins for mutations, ships no remote UI assets, and applies a restrictive Content Security Policy.
- Markdown, Mermaid, links, source paths, and displayed diagnostics are treated as untrusted inputs and sanitized or constrained at their trust boundaries.
- HTTP contracts expose resolved Workspace inspection and updates, Source Checkout actions, Production Run lifecycle actions, immutable review and knowledge snapshots, digest-checked review decisions, Knowledge Queries, and provisional Source Investigations.
- Transport representations may differ from domain records, but business validation and state transitions are not duplicated in frontend code.
- Existing persisted Workspaces and Production Runs require versioned schema migration rather than ad hoc table creation by each caller.
- The existing local Markdown issue tracker records this spec with `ready-for-agent` status. Implementation tickets may later split the work into tracer-bullet slices without weakening the contracts in this spec.

## Testing Decisions

- A good test observes user-visible or externally durable behavior through the highest useful seam. Tests should not assert React component structure, private helper calls, SQL statement order, animation frame counts, or internal model messages unless those details are themselves contractual.
- The primary deterministic test seam is the Workspace application interface: given a Workspace Definition, Local Workspace Settings, Git fixtures, Gateway fixtures, fixed Source revisions, review decisions, and failure injection, observe resolved configuration, Source safety, Production Run state, review snapshots, Bundle output, and publication.
- The primary browser seam is the local HTTP adapter plus rendered Console: exercise setup, Sources, Connections, Run observation, review, Knowledge reading, Concept provenance, questions, and accessibility as a user would.
- CLI and HTTP adapter contract tests must prove that equivalent actions invoke the same validation and produce equivalent authoritative state and errors. Domain behavior should not be retested independently in both adapters.
- Existing Production Run end-to-end tests are prior art for state transitions, failure recovery, review, publication, and read-only guarantees.
- Existing Scheduler and Worker tests are prior art for Analysis Task states, budgets, bounded tools, audit records, and safe concurrency.
- Existing Accepted Knowledge and Verification tests are prior art for Claim/Concept identity, Evidence resolution, candidate acceptance, Findings, and policy decisions.
- Existing Benchmark and Agent Evaluation tests are prior art for model, prompt, tool, workflow, cost, stability, and quality gates.
- Git tests must cover managed clone, linked checkout, credential delegation, clean pull, dirty pull rejection, missing branches, pinned commits, moved remotes, linked-source removal, managed-source deletion confirmation, and exact revision resolution.
- Configuration tests must cover shared/local layering, unknown fields, removed fields, schema migration, machine-specific path overrides, Gateway Profile selection, secret redaction, and immutable Run snapshots.
- Gateway Profile tests must cover credential-store success, restricted-file fallback, unavailable credentials, headers, capability tests, invalid endpoints, timeouts, and secret-free errors.
- Browser tests must cover Overview state, source tables, form validation, empty/loading/error states, task lanes, coverage filters, review diffs, evidence drawers, approval and rejection, Markdown navigation, Ask, and Source Investigation.
- Review tests must prove stale authoritative digests reject decisions, refreshed snapshots show the changed state, final checks rerun, and failed approval never replaces the published Bundle.
- Run visualization tests assert event ordering, displayed states, and navigable relationships rather than exact animation timing.
- Concept provenance tests must prove every displayed edge is derivable from persisted IDs and events, disputed/stale states remain visible, candidate attribution survives process restart, and reduced-motion mode exposes equivalent information without animation.
- Markdown security fixtures must cover raw HTML, scripts, dangerous URLs, malformed links, Mermaid payloads, oversized content, frontmatter, code fences, and escaping.
- Reader tests must cover CommonMark/GFM structures, syntax highlighting, Mermaid, math, source/rendered toggle, frontmatter metadata, internal links, backlinks, citations, and unified/split diff.
- Local security tests must cover non-loopback binding defaults, missing or invalid session tokens, cross-origin mutation attempts, Content Security Policy, external asset requests, path traversal, arbitrary file reads, and secret leakage.
- Accessibility checks must cover keyboard navigation, focus order and restoration, accessible names, dialog titles, form errors, status announcements, contrast, and reduced motion.
- No-network tests must prove the Console shell and accepted Bundle reader load without CDN resources, external fonts, analytics, or remote JavaScript.
- Query Agent Evaluation is a separate probabilistic seam. It must measure citation completeness, unsupported-answer refusal, scope adherence, prompt-injection resistance, model usage, cost, and latency.
- Source Investigation evaluation must prove fixed-revision scope, source citations, provisional labeling, read-only behavior, and inability to affect obligations, review, Accepted Knowledge, Bundle rendering, or publication.
- End-to-end release tests must include a Workspace with multiple repository roles, a configured Gateway Profile, a full Run, review through the Console, publication, Bundle reading, one grounded question, and one provisional Source Investigation.

## Out of Scope

- A hosted, remotely accessible, or multi-tenant administration platform.
- Human-user accounts, billing, organization management, remote authorization, or collaborative review queues.
- Collaborative Markdown editing, CRDT state, comments, or presence.
- Direct editing of source repositories or generated Bundle pages.
- Running source builds, tests, compilers, package managers, repository scripts, or arbitrary shell commands.
- Recursive Agent hierarchies or a persistent conversational Orchestrator Agent.
- Automatic Git conflict resolution, rebasing, force-pulling, auto-stashing, resetting, or cleaning.
- Managing Git usernames, passwords, SSH keys, or credential-helper configuration.
- Guarded Auto-publish.
- Enabled Web Enrichment or unrestricted browsing from Knowledge Queries or Source Investigations.
- MCP client or server support.
- Embeddings, vector search, graph databases, or GraphRAG infrastructure.
- Next.js, TanStack Start, a separate JavaScript backend, or direct browser access to SQLite.
- Raw HTML execution, MDX execution, remote iframe content, or repository-provided browser scripts.
- Treating question sessions or Source Investigation results as authoritative knowledge.
- Exposing model chain-of-thought or reconstructing unrecorded internal reasoning.
- PostgreSQL, distributed workers, message buses, or multi-node Production Runs.
- Additional source languages beyond the Producer's separately approved language support.

## Further Notes

- Domain language is defined by the project glossary. Workspace is the user-initialized local directory; Producer Project is the knowledge-production scope; Source Checkout is mutable; Source Snapshot is immutable.
- Architectural decisions for Workspace cardinality, Git ownership, configuration layering, local Console authority, Gateway Profiles, and the Knowledge Query/Source Investigation split are recorded in accepted ADRs.
- OpenKnowledge is useful interaction-design prior art for local Markdown reading, agent activity, history, and Ask affordances, but its GPL-3.0 implementation is not copied.
- The installed shadcn skill and Base UI rules guide component composition during implementation.
- The Console should remain useful with deterministic fixtures before live LLM configuration is available, allowing UI, Git, Run, review, and Bundle workflows to be developed and tested independently.
- This spec intentionally preserves CLI and CI as complete interfaces; the GUI improves human workflows rather than replacing automation.

## Comments

