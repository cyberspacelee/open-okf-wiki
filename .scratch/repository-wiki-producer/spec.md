# Repository Wiki Producer

Status: ready-for-agent

Supersedes: OKF Knowledge Bundle Producer and Workspace Console specifications

Amended by: Adaptive Repository Wiki Runs for Planning, bounded recursive SubAgents, single-layer DynamicWorkflow, Analysis Receipts, provider transport retry, Manual Retry Runs, and TUI behavior

## Problem Statement

The current product hard-codes repository analysis as a large Python workflow with schedulers, role-specific Agents, state machines, Coverage Obligations, an Accepted Knowledge Model, verification stages, and a deterministic Renderer. Changing how a Wiki is investigated, organized, written, or reviewed therefore requires changing Python orchestration and its persisted domain model.

The user needs a much smaller product whose goal is simply Repository Snapshot Set to source-grounded Wiki. The semantic workflow and Wiki Templates must be versioned, inspectable, and adjustable as a Producer Skill, while Python remains a thin safety and publication harness. The product should use PydanticAI and Pydantic AI Harness capabilities directly instead of rebuilding their Agent loop, filesystem access, retry handling, context management, subagent dispatch, or durable execution.

The result must still protect the source repository, prevent partial publication, bound model usage, and mechanically reject invalid output. It does not need historical compatibility with the existing control-plane implementation, configuration, state, or generated Knowledge Bundles.

## Solution

Build one high-level Wiki Run operation. It accepts a non-empty set of exact read-only named Repository Snapshots, an exact trusted Producer Skill revision, model and provider configuration, an optional Published Wiki for Refresh, and a publication destination. A non-secret YAML file may describe the run; provider credentials remain process environment or secret-manager inputs.

The operation starts one PydanticAI Agent run with Pydantic AI Harness CodeMode. The Agent receives a read-only source mount, a read-only Producer Skill mount, and a read-write Staging Wiki mount. A single repository is mounted directly; multiple repositories appear under stable repository-ID directories. The normal Agent loop and sandboxed model-authored code provide dynamic exploration, branching, loops, batching, aggregation, writing, and self-review.

The Producer Skill contains the Wiki production method, focused generate, refresh, and review guidance, and adaptable Wiki Templates. It decides what to investigate, which pages the repository deserves, how pages are split or merged, how content is cross-linked, where Source Citations are required, how templates are adapted, and when the Wiki is complete.

Python owns only the trust boundary and terminal contract: snapshot preparation, mount permissions, model credentials, PydanticAI usage limits and retries, typed Complete or Needs Input results, mechanical Wiki validation, publication metadata, staging cleanup, and atomic publication. The Agent writes final Markdown directly; there is no Claim ledger, Coverage Obligation inventory, Accepted Knowledge Model, typed page-block representation, deterministic Renderer, or custom workflow engine.

Generate starts with an empty Staging Wiki. Refresh starts with a copy of the current Published Wiki and performs a full semantic re-evaluation against the new Repository Snapshot Set. Successful validation atomically replaces the Published Wiki; failure leaves the previous publication untouched.

## User Stories

1. As a repository owner, I want to generate one Wiki from one or more repository revisions, so that readers can understand the complete codebase without tracing it manually.
2. As a repository owner, I want every repository in a Wiki Run pinned to an exact Git revision, so that its source meaning cannot drift during generation.
3. As a reader, I want an approachable entry page, so that I know what the repository does and where to continue.
4. As a reader, I want architecture, modules, flows, and concepts explained when they are relevant, so that the Wiki reflects the repository rather than a fixed taxonomy.
5. As a reader, I want the Agent to choose an appropriate page set, so that small repositories are not padded and large repositories are not forced into a few pages.
6. As a reader, I want related pages cross-linked, so that I can follow concepts and flows through the Wiki.
7. As a reader, I want factual sections grounded with Source Citations, so that I can verify important statements.
8. As a reader, I want each Source Citation to identify a repository ID when needed, a repository-relative path, and an inclusive line range, so that its evidence is unambiguous.
9. As a repository owner, I want citations checked against the pinned Repository Snapshot Set, so that stale or invented citations cannot publish.
10. As a repository owner, I want broken internal links rejected before publication, so that readers never receive a structurally broken Wiki.
11. As a repository owner, I want invalid frontmatter rejected before publication, so that Wiki consumers can parse pages consistently.
12. As a repository owner, I want a Wiki Manifest listing the produced pages, so that the terminal result can be checked against the filesystem.
13. As a repository owner, I want publication metadata to record every repository ID, revision and ignore set, plus the Producer Skill digest, model identity, and content digest, so that a published result is attributable.
14. As a repository owner, I want a failed Wiki Run to leave the existing Published Wiki unchanged, so that generation cannot damage a working Wiki.
15. As a repository owner, I want publication to replace the Wiki atomically, so that readers observe either the complete old Wiki or the complete new Wiki.
16. As a repository owner, I want an incomplete staging tree discarded or retained only for diagnosis, so that it is never mistaken for published output.
17. As a repository owner, I want a successful run to report whether content actually changed, so that CI can avoid empty updates.
18. As a repository owner, I want a Refresh to start from the current Published Wiki, so that the Agent can preserve useful structure while updating facts.
19. As a repository owner, I want Refresh to reconsider the whole Wiki against the new snapshot, so that correctness does not depend on a custom impact graph.
20. As a repository owner, I want changed, added, and removed pages summarized mechanically, so that I can review the result efficiently.
21. As a repository owner, I want the Agent to perform a final review pass, so that obvious omissions, duplication, broken narrative, and unsupported statements are corrected before completion.
22. As a repository owner, I want the Agent to return Needs Input only for genuinely blocking missing information, so that routine uncertainty does not stop autonomous work.
23. As a repository owner, I want blocking questions returned in a typed result, so that a caller can present them and start a later run with the answers.
24. As a repository owner, I want a failed or interrupted first version to be safely rerunnable, so that a custom checkpoint engine is unnecessary.
25. As a product maintainer, I want the product to ship a default Producer Skill, so that repository owners get a useful Wiki workflow without authoring instructions.
26. As a product maintainer, I want each Producer Skill release immutable and content-addressed, so that a Wiki Run uses an exact known method.
27. As a repository owner, I want to select a specific Skill Version, so that upgrades are deliberate.
28. As a repository owner, I want to create a Skill Fork, so that I can adapt the workflow and Wiki Templates for my audience.
29. As a repository owner, I want to edit Wiki Templates without changing Python, so that page structure and style can evolve cheaply.
30. As a repository owner, I want to adjust generate, refresh, and review guidance independently, so that each workflow branch can improve without duplicating the whole Skill.
31. As a repository owner, I want product upgrades not to overwrite a Skill Fork, so that local intent remains stable.
32. As a product maintainer, I want invalid or incomplete Producer Skill bundles rejected before model execution, so that failures are early and actionable.
33. As a security-conscious user, I want repository-provided Skills and agent instructions treated as source data, so that the target repository cannot change product policy.
34. As a security-conscious user, I want every Repository Snapshot mounted read-only, so that the Agent cannot alter source files.
35. As a security-conscious user, I want the Producer Skill mounted read-only, so that a Wiki Run cannot mutate its own instructions.
36. As a security-conscious user, I want only the Staging Wiki writable, so that model side effects remain contained.
37. As a security-conscious user, I want repository builds, tests, package managers, scripts, plugins, and arbitrary host shell execution unavailable, so that untrusted code is never executed.
38. As a security-conscious user, I want no repository-analysis network tool beyond the configured model connection, so that source content cannot trigger uncontrolled external access.
39. As a security-conscious user, I want symlinks and path traversal unable to escape the approved mounts or publication root, so that filesystem containment is real.
40. As an operator, I want model credentials kept outside YAML, the Producer Skill, Repository Snapshot Set, prompts, traces, and Wiki output, so that secrets are not published.
41. As an operator, I want to select a supported PydanticAI model and provider configuration, so that the same harness can use approved model endpoints.
42. As an operator, I want request, token, tool-call, retry, and wall-clock limits, so that a dynamic Agent loop remains bounded.
43. As an operator, I want PydanticAI validation retries to feed mechanical failures back to the Agent within a bounded budget, so that recoverable output defects can be corrected.
44. As an operator, I want exhausted limits and retries reported as explicit failures, so that runaway work cannot continue silently.
45. As a product maintainer, I want the Agent to use loops, conditions, batching, and aggregation through CodeMode, so that workflow flexibility does not become Python orchestration.
46. As a product maintainer, I want page selection and investigation order left to the Agent and Producer Skill, so that Python does not encode repository semantics.
47. As a product maintainer, I want final Markdown written directly by the Agent, so that the system does not maintain a second page representation and Renderer.
48. As a product maintainer, I want Wiki Templates treated as adaptable guidance, so that a template does not force irrelevant sections or a fixed page count.
49. As a product maintainer, I want the initial system to remain single-Agent, so that complexity is added only after measured need.
50. As a product maintainer, I want official SubAgents considered only when evaluation shows repeatable specialist work, so that delegation solves a demonstrated problem.
51. As a product maintainer, I want DynamicWorkflow considered only when specialist coordination becomes a measured bottleneck, so that it is not used as a generic business workflow engine.
52. As a product maintainer, I want Runtime Authoring excluded, so that model-written host Python never becomes part of repository-to-Wiki generation.
53. As a product maintainer, I want official PydanticAI or Harness facilities used for retry, compaction, delegation, and durability when needed, so that the product does not own parallel implementations.
54. As a product maintainer, I want the Pydantic AI Harness dependency exactly pinned while it remains pre-1.0, so that upstream breaking changes cannot enter unnoticed.
55. As a product maintainer, I want end-to-end evaluation on representative repositories, so that Wiki quality rather than internal architecture drives changes.
56. As a product maintainer, I want evaluation to measure factual grounding, useful coverage, navigation, duplication, cost, and latency, so that trade-offs are visible.
57. As a product maintainer, I want repeated runs evaluated for material stability without requiring identical prose, so that nondeterminism is measured realistically.
58. As a CI user, I want one non-interactive Wiki Run interface, so that repository documentation can be regenerated in automation.
59. As a CLI user, I want generate and refresh operations to invoke the same application seam, so that interactive and automated behavior cannot diverge.
60. As a caller, I want structured terminal output for success, Needs Input, and failure, so that integrations do not parse prose.
61. As a caller, I want progress and model traces treated as diagnostics rather than authoritative workflow state, so that correctness depends only on inputs and published artifacts.
62. As a product maintainer, I want implementation modules from the old control plane deletable, so that historical architecture does not constrain the new design.
63. As a product maintainer, I want no migration layer for old Workspaces, ledgers, Knowledge Bundles, or review state, so that the greenfield harness remains small.
64. As a repository owner, I want the first product to promise source-grounded pages rather than exhaustive knowledge coverage, so that its contract matches what the system can verify.
65. As a future product owner, I want Claim-level provenance introduced only by a new explicit requirement and decision, so that a knowledge ledger is not added speculatively.
66. As a repository owner, I want one YAML file to name multiple local repositories, so that a project-spanning Wiki Run is reproducible without a long CLI command.
67. As a repository owner, I want each configured branch resolved to an exact commit before model work, so that mutable refs cannot change an active run.
68. As a repository owner, I want explicit ignore globs to remove tracked generated or irrelevant files before source quotas and analysis, so that the Agent sees only the intended source boundary.
69. As an operator, I want `.env.example` to document provider variables while real `.env` files remain untracked, so that local setup is clear without committing credentials.
70. As an operator, I want YAML to reject credentials, tokens, and provider headers, so that versioned run configuration remains non-secret.
71. As a reader, I want multi-repository Source Citations to include a repository ID, so that identical paths in different repositories remain unambiguous.

## Implementation Decisions

- The implementation replaces the existing knowledge-bundle control plane. Backward-compatible configuration, state, database, API, and output migrations are not required.
- The primary application seam is one Wiki Run operation used by CLI, CI, and tests.
- A Wiki Run accepts a non-empty Repository Snapshot Set, one exact Skill Version or Skill Fork revision, model and provider settings, usage limits, an optional Published Wiki for Refresh, and a publication destination.
- A versioned YAML configuration may contain only non-secret run settings. Paths resolve relative to the YAML file; provider credentials and headers remain environment or secret-manager inputs.
- Each repository has a stable lowercase repository ID and exactly one local branch or exact revision. The harness resolves a branch to an immutable commit before starting model work. Dirty checkout state cannot enter an active run.
- Explicit ignore entries use standard-library `fnmatch` matching against repository-relative POSIX tracked paths and apply before source count and byte quotas. The first version does not implement Gitignore semantics.
- The target repository is untrusted data. Repository instructions, Skills, plugins, scripts, and generated files cannot grant capabilities or change system instructions.
- One PydanticAI Agent run owns the complete semantic loop. The implementation does not contain a Scheduler, fixed Planner/Worker/Verifier/Renderer pipeline, or pydantic-graph workflow.
- Pydantic AI Harness CodeMode is the dynamic execution capability. It receives separate read-only source and Producer Skill mounts plus one read-write Staging Wiki mount. Multiple repositories are materialized below `/source/<repository-id>`.
- CodeMode sandboxing and mount containment are the execution boundary. The product does not expose arbitrary host shell, package installation, repository execution, or general network tools.
- The first version uses one Agent. SubAgents, DynamicWorkflow, compaction, and durable execution are absent until evaluation demonstrates their need.
- Runtime Authoring is never enabled for repository-to-Wiki generation.
- PydanticAI and Pydantic AI Harness versions are exactly pinned to a mutually compatible released pair. Harness upgrades require contract and end-to-end evaluation because the dependency is pre-1.0.
- The Producer Skill is a trusted versioned bundle with root workflow guidance, focused generate, refresh, and review references, and editable Wiki Templates.
- The built-in Producer Skill may include overview, architecture, module, flow, and concept templates, but the Agent chooses which templates and pages are relevant.
- A Skill Version is immutable. User customization creates an explicit Skill Fork or new version, and every Wiki Run records the exact resolved content digest.
- The Producer Skill owns repository investigation strategy, semantic branching, page selection, page split and merge decisions, cross-linking, citation placement, writing style, diagrams, self-review, and completion criteria.
- Python owns snapshot preparation, mount permissions, model credentials, official usage limits and retries, typed terminal results, mechanical validation, staging lifecycle, publication metadata, and atomic publication.
- Python does not own semantic coverage, repository classification, page taxonomy, content planning, prose composition, Claim acceptance, or Agent scheduling.
- Generate begins with an empty Staging Wiki.
- Refresh begins with a copy of the current Published Wiki and performs a full semantic re-evaluation. The first version does not implement source-impact tracking or partial invalidation.
- The Agent writes final Markdown directly into staging. No typed page-block intermediate representation, Accepted Knowledge Model, Claim database, or deterministic prose Renderer is created.
- The terminal result has two semantic outcomes: Complete with a Wiki Manifest, or Needs Input with bounded blocking questions. Operational exceptions and exhausted limits remain failures rather than semantic outcomes.
- The Wiki Manifest lists every intended published page. Page contents do not travel through the terminal structured-output payload.
- The harness derives the actual file manifest and content hashes independently and rejects disagreement with the Agent-provided Wiki Manifest.
- Mechanical validation checks path containment, allowed output types, required entry content, declared frontmatter, duplicate paths, manifest agreement, internal links, Source Citation grammar, cited path existence, cited inclusive line ranges, and prohibited temporary artifacts.
- Source Citation grammar is a stable harness contract containing a repository ID for multi-repository runs, a repository-relative POSIX path, and a one-based inclusive line range. Wiki Templates may guide placement but cannot redefine the grammar.
- Validation checks citation resolvability, not semantic entailment. The Producer Skill requires the Agent to review factual grounding; real-repository evaluation measures the resulting accuracy.
- Page-level Source Citations are the initial provenance contract. Claim-level records, exhaustive Coverage Obligations, and Knowledge Impact Graphs are deliberately absent.
- Python writes a small machine-readable publication manifest after successful validation. It records every repository ID, exact revision and ignore set, plus the Producer Skill digest, model identity, generated time, page hashes, and complete Wiki content digest.
- The harness compares staged and published file hashes to derive added, changed, removed, and unchanged pages and whether publication would be a no-op.
- Publication occurs only after Complete and successful validation. It atomically replaces the complete Published Wiki or leaves the previous publication unchanged.
- A failed run never records a successful publication cursor or updates the Published Wiki.
- The initial recovery strategy is rerun from a fresh Staging Wiki. Message history, StepPersistence, and durable execution are not production state.
- UsageLimits, PydanticAI retries, and provider-supported timeout controls are configured directly rather than wrapped in a custom retry or budget state machine.
- Model credentials and secret headers remain process environment, secret-manager, or machine configuration and are never accepted from YAML or copied into source, Skill, prompts, traces, staging, or publication metadata.
- Existing installed Markdown and YAML parsers are reused for mechanical validation. Standard-library path, hashing, copy, and atomic filesystem operations are preferred over new abstractions.
- No template engine is introduced. Wiki Templates are Markdown guidance read and adapted by the Agent.
- The implementation may delete obsolete scheduler, state-machine, knowledge-model, coverage, verification, rendering, query, console, and workspace modules when no new public behavior depends on them.

## Testing Decisions

- The primary test seam is the complete Wiki Run application interface: given a fixed Repository Snapshot Set, fixed Producer Skill, deterministic model fixture, optional Published Wiki, and output destination, observe the typed result, staged validation, publication metadata, and final filesystem state.
- This is the highest useful seam and should cover nearly all behavior. Focused lower-level tests are reserved for trust-boundary validation and atomic publication failures that are difficult to localize through the full seam.
- Tests assert observable artifacts and outcomes, not the Agent's private reasoning, exact tool ordering, prompt wording, or number of loop iterations.
- Existing Production Run end-to-end tests provide prior art for filesystem setup, failure injection, and atomic-publication assertions, but their control-plane domain model is not retained.
- Existing package-release tests provide prior art for invoking the installed CLI as a user would.
- Existing security tests provide prior art for path traversal, symlink containment, source writes, credential leakage, and repository-instruction injection.
- A successful Generate test starts from an empty publication, produces a multi-page Wiki, returns Complete, validates the Wiki Manifest, and publishes atomically.
- A successful Refresh test starts from a Published Wiki, changes the Repository Snapshot Set, produces a correct added/changed/removed summary, and atomically replaces the publication.
- A no-op Refresh test leaves the publication content unchanged and reports no content change.
- A Needs Input test returns bounded questions and does not publish.
- Failure tests prove that model errors, exhausted usage limits, invalid structured output, validation failure, interruption, and publication failure leave the old Published Wiki intact.
- Mount tests prove that source and Producer Skill writes fail while Staging Wiki writes succeed.
- Execution tests prove that repository builds, scripts, package managers, plugins, arbitrary host shell, and external network tools are unavailable.
- Path tests attempt absolute paths, parent traversal, symlink escape, duplicate normalized paths, and publication-root escape.
- Producer Skill tests prove that the exact digest is frozen, invalid bundles fail before model work, a Skill Fork changes guidance or templates, and product updates do not mutate the fork.
- Repository-instruction tests place conflicting AGENTS, CLAUDE, Skill, and prompt-like files in the source and prove they are analyzed only as data.
- Manifest tests cover missing files, undeclared files, duplicate pages, unsupported output types, stale hashes, and prohibited temporary artifacts.
- Frontmatter tests cover missing required fields, invalid YAML, duplicate identities where applicable, and values inconsistent with publication metadata.
- Link tests cover valid relative links, fragments, missing pages, missing headings, path normalization, and self-links.
- Source Citation tests cover valid paths and spans, missing files, line zero, reversed ranges, ranges beyond end of file, traversal, binary files, and malformed grammar.
- Atomic-publication tests inject failures before validation, during manifest creation, and during replacement and prove that readers never observe a partial mixture.
- Usage tests prove that request, token, tool-call, retry, and wall-clock limits terminate work with explicit failures.
- Retry tests prove that a mechanically invalid Complete result can be corrected within the configured output retry budget and fails once that budget is exhausted.
- Publication metadata tests prove that all repository revisions and ignore sets, Skill digest, model identity, page hashes, and complete content digest match the actual run inputs and output.
- YAML configuration tests prove relative paths, branch freezing, multiple repository IDs, ignore globs, optional limits, and secret rejection through the installed CLI seam.
- CLI and CI tests invoke the same Wiki Run seam and verify machine-readable Complete, Needs Input, no-op, and failure responses.
- Deterministic tests use PydanticAI-supported test or replay models and do not require live model credentials.
- Live model evaluation is separate from deterministic CI and uses representative small, medium, and large repositories.
- Initial evaluation measures factual grounding, useful topic coverage, navigation, duplication, unsupported statements, cost, latency, and material stability across repeated runs.
- At least two or three real repositories are evaluated before adding SubAgents or DynamicWorkflow.
- A new capability is accepted only when the evaluation identifies a repeatable failure and shows that the capability materially improves results without weakening safety or publication guarantees.
- Documentation-only changes continue to require Markdown link and diff checks; implementation changes require the repository's Python test, lint, format, type, lockfile, and package-release checks.

## Out of Scope

- Historical compatibility with existing Workspaces, SQLite ledgers, Production Runs, Knowledge Bundles, Console APIs, review state, or generated output.
- Remote clone, fetch, pull, branch updates, or repository ownership management.
- Gitignore-compatible negation, directory pruning, or automatic loading of repository `.gitignore` files as product policy.
- Provider credentials, secret headers, or environment interpolation inside Wiki Run YAML.
- Workspace Console, hosted service, multi-user administration, and collaborative editing.
- Knowledge Query and Source Investigation products.
- Claim ledger, Coverage Obligations, Accepted Knowledge Model, Knowledge Impact Graph, exhaustive coverage proof, and deterministic prose Renderer.
- Fixed Planner, Worker, Verifier, Renderer, or specialist role pipelines.
- SubAgents and DynamicWorkflow in the first implementation.
- Runtime Authoring and execution of model-authored host Python.
- Repository builds, tests, package managers, plugins, scripts, and arbitrary shell execution.
- Automatic loading of target-repository Skills, agents, or instruction files.
- Web enrichment, MCP search, or other external knowledge sources.
- Custom workflow DSL, custom filesystem toolset, custom retry engine, custom compactor, and custom durable execution.
- Cross-process resume, long-running human approval waits, exactly-once side effects, and distributed workers.
- Claim-level semantic verification or a guarantee that every implicit repository idea was discovered.
- A fixed universal Wiki taxonomy or mandatory page count.
- A custom Markdown template engine.

## Further Notes

- This specification is the implementation source of truth for the greenfield repository-to-Wiki direction and supersedes the two earlier ready-for-agent specifications.
- The current codebase is useful as prior art for tests and trust-boundary behavior, but its architecture is not a compatibility constraint.
- PydanticAI and Pydantic AI Harness package availability and compatible exact versions must be rechecked immediately before implementation.
- If machine-auditable Claim-level provenance or demonstrable exhaustive coverage becomes a hard product contract, stop and create a separate specification and ADR rather than expanding this harness implicitly.
- Ticket decomposition is intentionally not included here; use the ticketing workflow after this specification is accepted.
