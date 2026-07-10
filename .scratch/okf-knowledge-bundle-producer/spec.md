# OKF Knowledge Bundle Producer

Status: ready-for-agent

## Problem Statement

Enterprise teams keep important knowledge across multiple code and Markdown repositories, but that knowledge is difficult to navigate, frequently inconsistent, and expensive to maintain as a coherent Wiki. Existing LLM Wiki generators can dynamically explore repositories and produce readable pages, but probabilistic exploration alone cannot prove that important content was covered, that a Claim is supported by the cited source, that a Concept was correctly merged or split, or that an incremental refresh did not silently delete knowledge.

The user needs an OKF Knowledge Bundle Producer that can analyze one or more fixed source revisions with an Agentic workflow while retaining deterministic control over the Source Universe, Coverage Obligations, evidence acceptance, state transitions, review, and publication. The system must support Java repositories with large numbers of DTO/VO-style Data Carriers without allowing those files to consume most Agent attention. It must also remain auditable, resumable, testable, and safe for enterprise use without executing source code or repository scripts.

## Solution

Build an OKF Knowledge Bundle Producer with two deliberately separate planes:

- A framework-independent Deterministic Control Plane owns Producer Projects, Source Sets, read-only Source Snapshots, Source Units, Coverage Policies, Production Run state, the Accepted Knowledge Model, verification policy, rendering, review, and atomic publication.
- A PydanticAI-based Semantic Execution Plane uses the enterprise OpenAI-compatible gateway to run short-lived Planner, Worker, Verifier, and Renderer Agent Roles. Agents dynamically choose bounded read/search activity and submit typed proposals, but never mutate authoritative state or write the formal Knowledge Bundle directly.

Each Producer Project may combine multiple repositories, such as implementation, requirements, and shared-contract repositories, into one versioned Source Set and one Knowledge Bundle. A deterministic Scheduler repeatedly selects uncovered knowledge, invokes a fresh Planner Agent, runs bounded single-level Worker Agents in parallel, validates their typed Claim and Concept proposals, invokes independent semantic Verifiers, and advances state until all Major Obligations are closed.

The Accepted Knowledge Model, rather than generated Markdown, is authoritative. It records Claims, Concepts, relations, Evidence References, Verification Findings, and their dependencies. OKF pages, indexes, links, logs, and coverage reports are derived from that model. Incremental refresh uses a Knowledge Impact Graph from Source Units through Evidence References, Claims, Concepts, and rendered pages, preventing silent deletion when an Agent fails to mention existing knowledge.

The MVP uses one isolated Run Worker per Production Run, a local SQLite ledger with transactional Run Events, static read-only source analysis, default human review before publication, and a fixed top-level Producer Profile. Agent Evaluation is part of the product: role-level, tool-trajectory, end-to-end, Mutation Case, repeated-run, and sampled production evaluations gate changes to models, prompts, tools, classifiers, Agent workflows, policies, profiles, and knowledge schemas.

## User Stories

1. As an enterprise developer, I want a Knowledge Bundle generated from the repositories I work in, so that I can understand the system without manually tracing every module.
2. As a developer, I want the Producer to combine implementation and requirements repositories, so that code and intended behavior appear in one knowledge space.
3. As a developer, I want every published Claim to link to exact source evidence, so that I can verify it quickly.
4. As a developer, I want source links pinned to revisions, so that later repository changes do not invalidate the meaning of a citation.
5. As a developer, I want core flows and failure modes to be prioritized over utility classes, so that the generated Bundle focuses on useful knowledge.
6. As a Java developer, I want DTOs, VOs, requests, and responses aggregated into Data Contracts, so that the Bundle does not contain hundreds of low-value class pages.
7. As a Java developer, I want validation and serialization rules in Data Carriers preserved, so that useful API constraints are not discarded with boilerplate.
8. As a Java developer, I want Data Carriers with real behavior promoted for deeper analysis, so that business logic hidden in an apparent DTO is not missed.
9. As a repository maintainer, I want Git to define the versioned Source Universe, so that repository membership is reproducible.
10. As a repository maintainer, I want tracked files to require explicit classification even when `.gitignore` later matches them, so that coverage gaps are not silently hidden.
11. As a repository maintainer, I want generated and vendor sources explicitly excluded with reasons, so that exclusions remain auditable.
12. As a repository maintainer, I want dirty and untracked files excluded from production runs by default, so that a Knowledge Bundle corresponds to a reproducible revision.
13. As a requirements author, I want headings, numbered requirements, acceptance criteria, normative statements, tables, and glossary terms identified as Source Units, so that important requirements are not lost in prose.
14. As a requirements author, I want code and requirements conflicts reported rather than silently resolved, so that teams can address real disagreement.
15. As an architect, I want architecture decisions and explicit non-goals represented as Major Obligations, so that future readers understand why the system has its current shape.
16. As an architect, I want Concepts distinguished from source symbols and files, so that the knowledge model describes the domain rather than mirroring the directory tree.
17. As an architect, I want aliases supported without forced merging, so that uncertain identity relationships remain visible.
18. As an architect, I want Concept merge, split, rename, and deletion reviewed, so that stable knowledge identity is preserved over time.
19. As a knowledge consumer, I want a stable top-level Bundle taxonomy, so that navigation remains familiar across runs.
20. As a knowledge consumer, I want overview, architecture, module, flow, Concept, requirement, decision, guide, reference, and report material separated consistently, so that I can find the right kind of knowledge.
21. As a knowledge consumer, I want progressive indexes generated mechanically, so that all pages are discoverable even when model prose changes.
22. As a knowledge consumer, I want broken internal links rejected before publication, so that navigation remains reliable.
23. As a knowledge consumer, I want disputed and stale knowledge clearly marked, so that uncertainty is not presented as fact.
24. As a knowledge consumer, I want every factual paragraph grounded in accepted Claims, so that fluent prose cannot introduce unsupported facts.
25. As a project owner, I want a Producer Project to declare all participating repositories and roles, so that the knowledge boundary is explicit.
26. As a project owner, I want every repository revision pinned for a Production Run, so that the resulting Bundle can be reproduced.
27. As a project owner, I want implementation, requirements, and contract repositories to have different source roles, so that Coverage Policies can treat them appropriately.
28. As a project owner, I want independent Producer Projects to run concurrently, so that teams can maintain separate Bundles without shared-run interference.
29. As a project owner, I want one unified Bundle from a multi-repository Source Set, so that cross-repository Concepts and flows can be understood together.
30. As a project owner, I want an initial full build and later revision-based refresh, so that the Bundle can be maintained continuously.
31. As a project owner, I want unchanged knowledge to retain stable IDs, so that links and references do not churn.
32. As a project owner, I want file moves with unchanged content to relocate Evidence References where possible, so that harmless refactors do not trigger unnecessary semantic work.
33. As a project owner, I want removed or changed evidence to invalidate downstream Claims, so that outdated knowledge cannot remain silently accepted.
34. As a project owner, I want incremental results checked against full publication gates, so that optimization does not weaken correctness.
35. As a project owner, I want the Producer to fall back to full analysis when impact cannot be explained, so that uncertain invalidation does not cause omissions.
36. As a reviewer, I want to inspect coverage totals and exclusions, so that I can understand what was and was not represented.
37. As a reviewer, I want to inspect new, changed, removed, stale, and disputed Claims, so that review focuses on semantic change.
38. As a reviewer, I want to inspect Verification Findings by perspective, so that evidence, contradiction, Concept-boundary, and risk concerns are distinguishable.
39. As a reviewer, I want to approve or reject authoritative knowledge changes rather than edit generated Markdown, so that the source of truth remains coherent.
40. As a reviewer, I want the first Bundle generation to require review, so that an uncalibrated model cannot publish directly.
41. As a reviewer, I want Major Obligation exclusions to require explicit reasons, so that important omissions cannot be hidden.
42. As a reviewer, I want defining-evidence deletion and Concept deletion to require review, so that knowledge does not disappear accidentally.
43. As a reviewer, I want critical security, permission, and privacy changes to require review, so that high-risk documentation is not automatically accepted.
44. As a reviewer, I want profile, model, and major prompt changes to trigger renewed scrutiny, so that infrastructure changes do not silently alter knowledge quality.
45. As a security engineer, I want repositories treated as untrusted read-only data, so that repository content cannot redefine system policy.
46. As a security engineer, I want repository instructions and comments treated as source data rather than Agent instructions, so that prompt injection has no authority over the Producer.
47. As a security engineer, I want path resolution constrained to assigned Source Snapshots and task scopes, so that an Agent cannot read unrelated files.
48. As a security engineer, I want no shell, build, test, compiler, package-manager, or repository-script execution, so that source analysis cannot execute untrusted code.
49. As a security engineer, I want Agents unable to write source or formal Bundle files, so that model output must pass deterministic acceptance.
50. As a security engineer, I want model and publication credentials excluded from prompts and source workspaces, so that repository content cannot exfiltrate them.
51. As a security engineer, I want publication separated from analysis, so that read-only Agents cannot acquire write authority.
52. As an operator, I want one isolated Run Worker per Production Run, so that failures and staging data are contained.
53. As an operator, I want Production Run state stored outside model context, so that context compaction or loss does not lose durable progress.
54. As an operator, I want state changes and Run Events committed transactionally, so that audit history agrees with current state.
55. As an operator, I want failed runs resumable from deterministic checkpoints, so that transient model or process failures do not require starting over.
56. As an operator, I want Production Runs cancellable without publishing partial output, so that operational intervention is safe.
57. As an operator, I want status and checks available without mutating the run, so that monitoring is safe and scriptable.
58. As an operator, I want multiple Producer Projects to use independent Run Workers, so that SQLite write behavior remains simple.
59. As an operator, I want clear triggers for moving to PostgreSQL and a queue, so that distributed infrastructure is added only when required.
60. As a platform engineer, I want Agent Roles decoupled from model assignments, so that models can be changed per role without changing domain state.
61. As a platform engineer, I want one evaluated model usable for all roles initially, so that the MVP avoids premature model routing complexity.
62. As a platform engineer, I want model, prompt, tool schema, and Producer Profile versions recorded for every result, so that outcomes can be traced and reproduced.
63. As a platform engineer, I want Planner Agents to be short-lived, so that global context cannot grow without bound.
64. As a platform engineer, I want Worker Agents to receive bounded scopes, tools, and budgets, so that dynamic exploration remains controlled.
65. As a platform engineer, I want Worker Agents unable to recursively spawn more Agents, so that cost and authority remain predictable.
66. As a platform engineer, I want full Agent results written to the ledger while Planner Agents receive compact receipts, so that model context is not used as memory.
67. As a platform engineer, I want Agents to query accepted knowledge through bounded tools, so that they can reason globally without loading the entire model.
68. As a platform engineer, I want tool-call concurrency controlled by the Run Worker, so that parallelism does not corrupt authoritative state.
69. As a knowledge-quality engineer, I want deterministic checks separated from semantic verification, so that flexible reasoning cannot override hard invariants.
70. As a knowledge-quality engineer, I want evidence-entailment verification, so that cited text actually supports a Claim.
71. As a knowledge-quality engineer, I want coverage criticism independent of extraction, so that a Worker cannot declare its own work complete.
72. As a knowledge-quality engineer, I want contradiction verification across code, requirements, tests, and decisions, so that disagreement remains visible.
73. As a knowledge-quality engineer, I want Concept-boundary verification, so that symbols are not promoted to Concepts without justification.
74. As a knowledge-quality engineer, I want risk-focused verification for security and failure semantics, so that high-impact knowledge receives stronger scrutiny.
75. As a knowledge-quality engineer, I want rendered-content verification, so that the final prose remains grounded and internally consistent.
76. As a knowledge-quality engineer, I want semantic Verifiers to submit typed Findings rather than mutate knowledge, so that Acceptance Policy remains authoritative.
77. As a knowledge-quality engineer, I want disputed findings to enter human review rather than model majority voting, so that correlated model errors are not mistaken for consensus.
78. As an evaluation engineer, I want separate Planner, Worker, Verifier, and Renderer datasets, so that regressions can be attributed to a role.
79. As an evaluation engineer, I want tool trajectories evaluated, so that wasteful or unsafe behavior is detected even when the final answer looks acceptable.
80. As an evaluation engineer, I want DTO-heavy cases in the Benchmark Corpus, so that attention-allocation regressions are measurable.
81. As an evaluation engineer, I want seeded contradictions and unsupported Claims, so that Verifier recall and false positives can be measured.
82. As an evaluation engineer, I want Mutation Cases for source changes, so that invalidation and preservation behavior is tested.
83. As an evaluation engineer, I want identical configurations run repeatedly, so that probabilistic instability is measured.
84. As an evaluation engineer, I want deterministic tests kept separate from LLM evaluation, so that model judging does not replace software correctness tests.
85. As an evaluation engineer, I want model, prompt, tool, classifier, policy, profile, workflow, and schema changes gated by the Benchmark Corpus, so that upgrades do not silently reduce quality.
86. As an evaluation engineer, I want sampled production traces reviewed offline, so that real-world failures can improve the evaluation corpus without changing live state.
87. As a cost owner, I want token, tool-call, latency, retry, and human-review costs recorded, so that quality improvements can be weighed against operational cost.
88. As a cost owner, I want lower-value Supporting Obligations deferrable with reasons, so that coverage discipline does not force unlimited cost.
89. As a cost owner, I want role-specific model routing added only after evaluation proves value, so that the system remains simple initially.
90. As a compliance owner, I want an immutable record of accepted state transitions, so that production knowledge changes can be audited.
91. As a compliance owner, I want external Web sources disabled by default, so that data residency and provenance remain controlled.
92. As a compliance owner, I want future External Knowledge Sources assigned explicit Authority Levels, so that external information cannot silently override repository facts.
93. As a CLI user, I want to start a build from a Producer Project configuration, so that the complete Source Set is analyzed consistently.
94. As a CLI user, I want to inspect Production Run status, so that I can track progress and failures.
95. As a CLI user, I want to check a run or Bundle without publishing it, so that validation can run in CI.
96. As a CLI user, I want to approve or reject a run, so that Review Required can be resolved without a Web UI.
97. As a CI administrator, I want failed checks to return machine-readable errors and non-zero status, so that pipelines can block invalid Bundles.
98. As a CI administrator, I want no partial Bundle to replace the current published Bundle, so that failed runs cannot damage consumers.
99. As a downstream OKF consumer, I want reserved files and frontmatter to conform to the Producer Profile, so that the Bundle can be parsed consistently.
100. As a downstream OKF consumer, I want unknown domain Concepts represented without requiring a fixed global ontology, so that the format remains extensible.

## Implementation Decisions

- The product is an OKF Knowledge Bundle Producer, not a Wiki Agent. Agent frameworks and models are replaceable implementation details.
- A Producer Project combines one or more named repositories into one Knowledge Bundle. A Production Run pins an exact revision for every Source Snapshot in the Source Set.
- Evidence identity includes source ID, revision, path, Source Unit, span, and content digest.
- The Deterministic Control Plane owns authoritative state, validation, review, and publication. Only deterministic code may apply state transitions.
- PydanticAI is the initial Agent Runner because the enterprise already provides an OpenAI-compatible gateway and PydanticAI supplies tool handling, bounded context, structured output, retries, limits, evaluation, and tracing.
- `pyproject.toml` constrains PydanticAI to the 2.8 series and the committed `uv.lock` fixes the exact resolved version. Rolling official Web documentation is for discovery; version-specific behavior is verified against the official release tag matching the lockfile version, initially `v2.8.0`, and protected by local contract tests.
- Development-time lookup of official PydanticAI documentation does not authorize Production Runs to use Web Enrichment or unrestricted network browsing.
- Agent Roles and model assignments are decoupled. The MVP uses one evaluated model for Planner, Worker, Verifier, and Renderer roles, with independent prompts and message histories.
- The Scheduler is deterministic. It invokes fresh Planner Agents that propose bounded Analysis Tasks and then terminate.
- Worker Agents are single-level, short-lived, read-only, and constrained by Source Snapshot, allowed paths, allowed tools, obligation IDs, token budget, tool-call budget, wall-time budget, and typed output schema.
- Worker Agents cannot spawn other Agents, close obligations, mutate the Accepted Knowledge Model, write Bundle pages, or publish.
- Full Worker results are submitted to deterministic acceptance. Planner Agents receive only compact receipts containing accepted IDs, unresolved IDs, and warnings.
- Claims, Concepts, Evidence References, Verification Findings, Coverage Obligations, and Run Events live outside model context in the ledger.
- Git defines the Source Universe at a fixed revision. Tracked files cannot be silently excluded by later `.gitignore` patterns; generated and vendor files require explicit Coverage Policy dispositions.
- The MVP analyzes static, read-only Source Snapshots and never runs builds, tests, compilers, annotation processors, package managers, repository scripts, or arbitrary shell commands.
- Repository instructions, comments, documentation, and generated output are source data and cannot alter system policy.
- Java and Markdown are the supported semantic inputs for the MVP.
- Java source classification occurs before planning. Controllers, handlers, services, domain entities, state machines, security, configuration, and load-bearing persistence semantics receive higher priority than Data Carriers and utilities.
- DTO, VO, request, and response classes are Data Carriers by default and are aggregated into meaningful Data Contracts rather than individual Concepts or pages.
- Data Carriers are promoted when they contain validation, serialization, security, domain-interface, state, or non-trivial behavioral semantics.
- The initial Java classifier uses manifest, path, name, annotation, and structural signals. A focused Java parser is introduced only if the Benchmark Corpus proves these insufficient.
- A Producer Profile declares Coverage Policy, verification policy, Authority Levels, publication rules, and the fixed top-level Bundle taxonomy.
- Major Obligations must be covered or explicitly excluded before publication. Supporting Obligations may be covered, excluded, or explicitly deferred.
- The Accepted Knowledge Model is authoritative. It contains accepted Claims, Concepts, relations, aliases, Evidence References, conflicts, and statuses.
- A Claim is atomic and grounded by at least one resolvable Evidence Reference. Typed shape does not by itself establish semantic truth.
- A Concept is a stable knowledge identity defined by accepted Claims. Source symbols, files, and pages are not automatically Concepts.
- Worker Agents submit typed Claim and Concept proposals rather than formal Markdown.
- Frontmatter, IDs, paths, reserved files, indexes, links, logs, and coverage reports are generated deterministically.
- Renderer Agents may produce prose only from accepted Claims, and every factual paragraph must map to Claim IDs.
- Production Runs, Analysis Tasks, and Coverage Obligations use deterministic state machines.
- Production Run phases cover preparation, exploration, verification, rendering, checking, review, publication, success, failure, and cancellation. Semantic or rendering defects may route a run back to the appropriate earlier phase.
- Analysis Tasks move through planned, running, submitted, and accepted, rejected, or failed states.
- Major Coverage Obligations cannot publish while open, blocked, or failed. Deferral is available only to Supporting Obligations.
- Current state tables are authoritative. Every accepted state transition appends a Run Event in the same SQLite transaction.
- The MVP is not fully event sourced and has no message bus. A transactional outbox is reserved for a future distributed-worker design.
- Deterministic validation checks schema, scope, state transitions, revision, path, span, digest, evidence presence, coverage closure, identities, OKF structure, links, source drift, unexplained deletion, security, and budgets.
- Independent Verifier Agents assess evidence entailment, coverage completeness, contradictions, Concept boundaries, merge/split decisions, aliases, risk, and rendered quality.
- Verifier Agents reread original Evidence References and do not share Worker message history.
- Verifier Agents submit typed Verification Findings and cannot mutate authoritative knowledge.
- Acceptance Policy combines deterministic results, required Verification Findings, risk, and human-review outcomes. Model majority voting is not authoritative.
- The Knowledge Impact Graph records dependencies from Source Units through Evidence References, Claims, Concepts, and rendered pages.
- Incremental refresh compares Source Snapshot revisions, relocates unchanged evidence by digest where possible, invalidates changed or removed evidence, reverifies impacted knowledge, and runs full publication gates.
- Existing Claims and Concepts cannot be deleted merely because an Agent omits them. Deletion requires loss of defining evidence, no replacement evidence, renewed coverage closure, and verification.
- When impact cannot be explained safely, the Producer falls back to full analysis.
- One isolated Run Worker owns one Production Run, its SQLite ledger, state writer, Agent concurrency, working data, and staging area.
- Multiple Producer Projects run through independent Run Workers. The MVP has no shared distributed control plane.
- PostgreSQL and a queue are introduced only for same-run cross-process execution, shared ledgers, measured SQLite contention, high availability, centralized audit, or tenant isolation.
- Review Mode is the MVP publication mode. Successful checks lead to Review Required, and approval triggers final checks and atomic publication.
- Reviewers resolve Claims, Concepts, exclusions, and Verification Findings rather than editing derived Markdown.
- Guarded Auto-publish is designed but out of scope. Future auto-publish must fall back to review for disputes, high-risk semantic changes, major exclusions, defining-evidence deletion, Concept merge/split/delete, source conflicts, review findings, and significant model, prompt, tool, schema, or Producer Profile changes.
- The default Bundle taxonomy contains overview, architecture, modules, flows, Concepts, requirements, decisions, guides, references, and reports.
- Web Enrichment and other External Knowledge Sources are represented in the domain model but disabled in the MVP. Future sources require explicit seeds, allowlists, budgets, digests, truncation records, and Authority Levels.
- The CLI supports building a Producer Project, inspecting status, checking a run or Bundle, and approving or rejecting Review Required. Review emits a human-readable Markdown report plus machine-readable status/check output.
- The MVP has no frontend. A Web review UI is reconsidered only for measured multi-user review, authentication and authorization, remote service workflows, richer Claim/Concept diffs, or evidence that CLI review reduces review quality.
- Publication always occurs from staging through an atomic replacement after all checks and required review pass.
- Agent Evaluation is part of the MVP and covers role behavior, tool trajectories, end-to-end outcomes, Mutation Cases, repeated-run stability, and sampled production outcomes.
- `pydantic-evals` is used for Agent Evaluation; deterministic state, storage, security, validation, and rendering behavior use ordinary tests.
- Model, prompt, tool schema, classifier, Coverage Policy, Producer Profile, locked PydanticAI version, Agent workflow, and knowledge-schema changes rerun the release gate.
- The initial technology baseline is Python 3.14, uv with a committed lockfile, Pydantic 2, PydanticAI 2.8.x, SQLite, Markdown and YAML parsers, Git, ripgrep, pytest, Ruff, and exact-pinned `ty 0.0.58` as an advisory checker.

## Testing Decisions

- The primary test seam is the Production Run interface: given a Producer Project, fixed Source Set, Producer Profile, model fixtures, and review decisions, observe run states, coverage, accepted knowledge, findings, reports, Bundle output, and publication behavior. Tests should avoid asserting private class structure or internal call ordering unless ordering is itself an external state-machine guarantee.
- The secondary product seam is Agent Evaluation: given an Agent Role case with fixed Source Units, Coverage Obligations, allowed tools, and expected semantic outcomes, observe typed results, tool trajectories, budgets, and evaluator reports.
- The Production Run seam was confirmed during design review as the highest useful seam for deterministic behavior. Agent Role Eval was separately confirmed because probabilistic role behavior cannot be characterized only through implementation-unit tests.
- Producer Project tests must cover one repository, multiple repositories, independent revisions, source roles, cross-repository Concepts, and conflicting sources.
- Source Snapshot tests must prove that fixed Git revisions are reproducible, tracked files remain visible despite later ignore patterns, and dirty or untracked files do not enter production runs by default.
- Inventory tests must cover Markdown sections, manifests, Java roles, public interfaces, configuration, security declarations, persistence seams, and critical behavior expressed in tests.
- Java classification tests must include DTO-heavy repositories and prove that Data Carriers do not dominate Major Obligations while validation, serialization, security, and behavioral exceptions are promoted.
- Coverage tests must prove that unresolved Major Obligations block publication and that Supporting deferrals appear in reports with reasons.
- Knowledge-model tests must exercise Claim atomicity, Evidence Reference resolution, Concept identity, aliases, conflicts, merge/split decisions, and relation integrity through public acceptance behavior.
- State-machine tests must cover every legal transition and reject every illegal transition for Production Runs, Analysis Tasks, and Coverage Obligations.
- Transaction tests must prove that state updates and Run Events commit or roll back together.
- Failure tests must prove that a failed or cancelled run never replaces a published Bundle and can resume only from valid checkpoints.
- Agent workflow tests must prove that Planner Agents receive bounded summaries, Worker Agents receive bounded scope, recursion is impossible, and Planner receipts exclude full artifact content.
- Security tests must attempt path traversal, out-of-scope reads, shell execution, source writes, Bundle writes, repository-instruction injection, and credential exposure, and must observe rejection.
- Deterministic validation tests must cover invalid schemas, missing evidence, stale revisions, bad spans, changed digests, duplicate identities, broken links, malformed reserved files, source drift, and unexplained deletions.
- Semantic verification datasets must contain supported, unsupported, contradicted, incomplete, risk-sensitive, wrongly merged, wrongly split, and alias-ambiguous cases.
- Verifier tests must report critical seeded issues with 100% recall in the Benchmark Corpus and keep the initial semantic false-positive target below 5%.
- Renderer tests must prove that every factual paragraph maps to accepted Claims, defining Claims are represented, deterministic metadata is stable, and rejected or disputed knowledge is not rendered as accepted fact.
- Initial-build tests must produce a complete Review Required result and a conformant staging Bundle.
- Incremental tests must cover unchanged evidence relocation, changed evidence invalidation, evidence deletion, new Source Units, Concept stability, conservative deletion, and fallback to full analysis.
- Mutation Cases must include permission changes, new requirements, removed defining evidence, file moves, Concept renames, injected contradictions, and large DTO additions.
- Incremental Accepted Knowledge Models must be equivalent to full rebuild results for the same final Source Set, apart from explicitly non-semantic metadata.
- Review tests must cover approval, rejection, revised knowledge, mandatory review triggers, and final check failure after review.
- Atomic publication tests must prove that consumers observe either the old complete Bundle or the new complete Bundle, never a partial mixture.
- Required CI gates are `uv lock --check`, `uv sync --locked`, pytest, `ruff check .`, and `ruff format --check .`. `ty` runs as a non-required signal until the exact pinned version has a clean accepted baseline and an owned upgrade policy.
- PydanticAI and enterprise OpenAI-compatible gateway contract tests must cover the exact framework and gateway capabilities the Agent workflow depends on, including tool calling and structured output.
- OKF tests should reuse the conformance rules and representative structures from the local Google reference implementation where possible.
- Link, orphan, and graph-behavior tests should reuse patterns demonstrated by the local IWE and OpenKnowledge references without importing their product-level complexity.
- The Benchmark Corpus must include Java/Spring, DTO-heavy Java, Markdown requirements, conflicting code and docs, multi-module and multi-repository projects, and incremental histories.
- Hard release checks require complete Major disposition, complete published-Claim evidence coverage, complete evidence resolution, exact source revision matching, zero invalid OKF documents, zero broken internal links, zero unexplained knowledge deletions, and zero unresolved critical conflicts.
- Initial semantic targets are at least 95% supported-Claim precision, at least 95% major-knowledge recall, at least 90% Concept precision and recall, under 5% wrong merge/split rate, and zero critical unsupported Claims.
- Identical Source Sets and configuration must run at least three times. Major closure must remain 100%, critical Finding variance must remain zero, and Major Claim and canonical Concept set Jaccard similarity should reach at least 0.90.
- Planner Eval must cover task validity, prioritization, overlap, scope, role choice, concurrency, and budget use.
- Worker Eval must cover scope adherence, Claim quality, Evidence quality, Data Carrier handling, omitted conditions, and unsupported output.
- Verifier Eval must cover issue recall, false positives, independent evidence reading, and resistance to Worker conclusions.
- Renderer Eval must cover grounding, defining-Claim inclusion, consistency, duplication, and readability.
- Trajectory Eval must detect repeated low-value search, excessive DTO attention, needless tools, scope violations, retry loops, and budget waste.
- Production sampling must record content-controlled role, model, prompt, tool, task, outcome, cost, and review-override metadata for offline evaluation without changing production state.
- Good tests assert observable contracts at the Production Run or Agent Evaluation seam. Focused lower-level tests are justified only for parsers, security boundaries, deterministic state transitions, and serializers whose failures cannot be localized reliably at the primary seam.

## Out of Scope

- Running source builds, tests, compilers, annotation processors, package managers, repository scripts, or arbitrary shell commands.
- Recursive Agent hierarchies or a long-lived Orchestrator Agent.
- Pi, Codex, Claude Code, or other terminal-harness adapters.
- Rust Agent runtime or Rust deterministic core.
- Enabled Web Enrichment or unrestricted network browsing.
- MCP client or server support.
- Vector search, embeddings, graph databases, or GraphRAG-style community generation.
- PostgreSQL, Redis, Kafka, NATS, Temporal, distributed worker leases, or multi-node Production Runs.
- Guarded Auto-publish.
- A Web review UI, multi-tenant administration, billing, or account management.
- Complete language-specific semantic support beyond Java and Markdown.
- A universal Tree-sitter or compiler-analysis platform.
- Automatic execution of generated code or active repository behavior verification.
- A fixed global domain ontology beyond the Producer Profile's top-level Bundle taxonomy.
- Mathematical guarantees that every implicit real-world Concept has been discovered.

## Further Notes

- The canonical domain language is maintained in the project glossary.
- Sixteen accepted ADRs record the architectural choices summarized by this spec.
- The overall design document contains the complete state-machine, security, coverage, Agent workflow, incremental, publication, and evaluation rationale.
- The local Google OKF reference implementation is the preferred source for OKF parsing, path, reserved-file, and index behavior.
- OpenKnowledge is useful as workflow design prior art but is GPL-3.0 and is not a source for copied implementation in a non-GPL product.
- IWE is useful as optional future Markdown graph and link-analysis prior art, not as an MVP dependency.
- The strict product promise is relative to a fixed Source Set and Producer Profile; it does not claim universal semantic completeness.
- The MVP should remain a single Run Worker with the minimum dependencies required to satisfy this spec. Distributed infrastructure, new retrieval systems, and additional language adapters require measured evidence before adoption.

## Comments
