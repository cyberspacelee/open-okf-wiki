# Adaptive Repository Wiki Runs

Status: ready-for-agent

Extends: Repository Wiki Producer

Supersedes: the Repository Wiki Producer decisions that require a single Agent and defer Planning, SubAgents, DynamicWorkflow, compaction, and run-local research receipts until a future specialist bottleneck

## Problem Statement

The Repository Wiki Producer safely turns fixed Repository Snapshots into a validated Published Wiki, but its current semantic work is confined to one PydanticAI Agent context. CodeMode can batch filesystem operations, yet it cannot make a model context large enough to semantically understand a 500 MB, 50,000-file, multi-repository input. The Root Agent must remember the global objective while also reading source, discovering boundaries, planning pages, connecting cross-domain flows, writing, reviewing, and deciding when the Wiki is complete. Planning is absent, completed research exists only in message history, and there is no compaction or isolated research context.

The user needs Wiki Runs to scale by dynamically delegating bounded source investigation to independent contexts without turning Python into a semantic scheduler. The model must retain judgment over whether and how to split a source scope, while the Host must enforce a finite topology, permissions, budgets, deadlines, concurrency, and publication safety. Large child results must survive parent compaction without being copied wholesale into every parent context.

Provider rate limits and transient failures also make long Wiki Runs unnecessarily brittle. Current tool/output retries do not retry HTTP `429` or transient provider transport failures. Once bounded automatic retries fail, an operator needs an explicit human-triggered retry that reproduces the failed run's frozen inputs without resuming stale messages or partial evidence.

Finally, the current CLI emits one JSON result only after the complete run. Operators cannot see the Run Plan, delegated branch status, retry waits, receipt publication, or final publication progress. The user wants a terminal experience comparable to OpenWiki's interactive CLI while preserving the deterministic JSON interface used by CI and scripts.

## Solution

Keep `WikiRunApplication.run(request) -> WikiRunResult` as the single application seam and preserve every existing snapshot, security, validation, staging, and atomic-publication guarantee. Add adaptive orchestration inside that seam using Pydantic AI Harness capabilities rather than a custom workflow engine.

The Root Agent owns the global Run Plan, page set, cross-domain synthesis, final writing, review, and Staging Wiki. Small source scopes remain one Agent. Large or multi-domain scopes may use an acyclic `Root → Domain → Leaf` delegation tree. The model decides whether a semantic split is useful and writes self-contained child tasks; the Host enforces maximum depth, fan-out, child concurrency, usage envelopes, wall-clock limits, trusted agent registration, and mount permissions. A Domain may use one non-nested DynamicWorkflow for homogeneous Leaf fan-out/reduce, while recursive decomposition remains the responsibility of SubAgents.

Root and Domain Agents use Planning and TieredCompaction. The Run Plan contains the objective, completion gates, page intentions, evidence gaps, branch states, and receipt references, so it remains visible after compaction. Each research branch publishes an immutable, schema-validated Analysis Receipt through a Host-owned tool into a run-local Analysis Workspace. A short typed control return carries status, summary, and receipt reference; detailed evidence stays in the receipt or an optional bounded Markdown artifact. Root is the only Agent allowed to write `/wiki`.

Add provider transport retries below the Agent loop. Each model request gets at most three total transport attempts. Only explicit transient HTTP responses and transient network failures retry, using `Retry-After` or bounded exponential backoff. Exhaustion fails the current Wiki Run; it never restarts the whole run automatically. A human may then create a Manual Retry Run from a secret-free immutable run record. The new run reuses exact Repository Snapshot revisions, Skill Version or Skill Fork digest, model, limits, and explicit user answers, but receives a new identity, Run Plan, context, Analysis Workspace, and receipts.

Add an explicit Python-native `okf-wiki tui` presentation adapter using prompt-toolkit and Rich. It consumes bounded Host-owned run events from the same application seam and displays the Run Plan, Root/Domain/Leaf status, current tools, receipt publication, compaction, provider retry countdowns, Needs Input, and terminal publication. Existing `wiki-run` remains machine-readable JSON for CI, pipes, and cron. The TUI is an observer and input adapter, not a second workflow implementation.

## User Stories

1. As a repository owner, I want a small repository to remain a single-Agent Wiki Run, so that adaptive orchestration does not add needless latency or cost.
2. As a repository owner, I want a large repository to be investigated across independent model contexts, so that important domains are not dropped when one context fills up.
3. As a repository owner, I want a multi-repository Wiki Run to delegate independent repository or domain scopes, so that each source receives adequate semantic attention.
4. As a reader, I want the final Wiki to synthesize findings across domains, so that it explains the system rather than presenting disconnected child reports.
5. As a reader, I want all published claims to remain grounded in the frozen Repository Snapshot Set, so that delegation does not weaken Source Citation quality.
6. As a reader, I want one coherent page set and voice, so that parallel research does not produce a fragmented Wiki.
7. As a Root Agent, I want a Run Plan containing the objective and completion gates, so that a long Wiki Run does not forget why it is running.
8. As a Root Agent, I want the Run Plan to track page intentions and evidence gaps, so that writing does not begin from incomplete coverage.
9. As a Root Agent, I want the Run Plan to track each delegated branch and its receipt reference, so that completed work remains discoverable after compaction.
10. As a Root Agent, I want the current Run Plan reinjected after compaction, so that old message removal does not erase the remaining work.
11. As a Root Agent, I want to decide whether a source scope needs delegation, so that semantic partitioning remains model-directed.
12. As a Root Agent, I want to define self-contained Domain tasks, so that child contexts do not depend on hidden parent conversation.
13. As a Root Agent, I want to read bounded Domain receipts rather than complete child transcripts, so that aggregation does not recreate the original context problem.
14. As a Root Agent, I want to reopen exact evidence from a receipt on demand, so that synthesis can verify important claims without rereading the whole repository.
15. As a Root Agent, I want exclusive write access to the Staging Wiki, so that parallel Agents cannot race or produce inconsistent pages.
16. As a Domain Agent, I want an isolated context for one repository, package, domain, reader question, or cross-cutting flow, so that I can investigate it deeply.
17. As a Domain Agent, I want my own Run Plan when the scope is long, so that local goals survive compaction.
18. As a Domain Agent, I want to delegate at most one further Leaf layer when independent subscopes remain, so that an oversized domain can still be analyzed safely.
19. As a Domain Agent, I want to reduce Leaf findings into one bounded Domain receipt, so that Root receives a coherent result.
20. As a Domain Agent, I want an optional DynamicWorkflow for homogeneous Leaf fan-out/reduce, so that typed parallel coordination is concise when recursion is no longer needed.
21. As a Leaf Agent, I want a narrow self-contained source scope, so that I can return precise findings within a small context budget.
22. As a Leaf Agent, I want read-only Repository Snapshot and Producer Skill access, so that investigation cannot alter trusted inputs.
23. As a Leaf Agent, I want no Staging Wiki mount, so that I cannot bypass Root's single-writer boundary.
24. As a research Agent, I want to publish a typed Analysis Receipt through a Host-owned tool, so that I never choose arbitrary shared filesystem paths.
25. As a research Agent, I want each receipt to record status, scope, findings, evidence, open questions, child references, and optional artifacts, so that Parent can assess completeness.
26. As a research Agent, I want a short control return after receipt publication, so that Parent can branch on success without loading the entire artifact.
27. As a Parent Agent, I want `partial` and `failed` receipts excluded from critical coverage completion, so that incomplete research cannot silently publish.
28. As a Parent Agent, I want one bounded child retry for a critical failed scope, so that transient child failures can recover without an unbounded retry tree.
29. As a Parent Agent, I want the option to investigate a failed scope directly after child retry exhaustion, so that one child failure does not always abort a recoverable run.
30. As a repository owner, I want a Wiki Run to fail if load-bearing evidence remains incomplete, so that the existing Published Wiki is safer than a misleading replacement.
31. As an operator, I want every delegation tree to have a fixed maximum depth, so that a model cannot recurse indefinitely.
32. As an operator, I want every parent to have an enforced fan-out limit, so that a model cannot create an unbounded number of children.
33. As an operator, I want global child concurrency bounded, so that provider capacity and local resources remain predictable.
34. As an operator, I want the existing total request and token limits treated as one whole-tree envelope, so that child work is not added on top of the Root budget.
35. As an operator, I want each child to have a local hard usage limit and timeout, so that one branch cannot consume the complete run budget.
36. As an operator, I want actual Root and child usage aggregated for diagnostics, so that cost remains observable despite Harness accounting limitations.
37. As an operator, I want new child dispatch rejected when the remaining envelope is insufficient, so that planned reserves remain available for synthesis and recovery.
38. As an operator, I want Analysis Workspace file and byte quotas, so that file communication cannot become an unbounded storage channel.
39. As an operator, I want oversized tool output spilled or bounded before it enters model history, so that one tool return cannot defeat compaction.
40. As an operator, I want compaction to start before the supported model context is nearly full, so that runs fail gracefully rather than at the provider boundary.
41. As an operator, I want compaction waits and summary usage counted against the current Wiki Run, so that context management is not free hidden work.
42. As a security-conscious user, I want child Agents loaded only from an explicit trusted roster, so that repository-local agent files cannot register executable roles.
43. As a security-conscious user, I want target-repository instructions treated only as source evidence, so that they cannot alter Root or child policy.
44. As a security-conscious user, I want receipt free text treated as untrusted data, so that a child cannot smuggle new instructions into Parent policy.
45. As a security-conscious user, I want receipt paths assigned from opaque Host IDs, so that user or repository text cannot cause traversal or collisions.
46. As a security-conscious user, I want receipt schema, size, evidence count, hashes, and artifact paths validated before publication, so that malformed evidence never becomes trusted workspace state.
47. As an operator, I want HTTP `408`, `429`, `500`, `502`, `503`, and `504` model responses retried automatically, so that short provider incidents do not waste a long run.
48. As an operator, I want transient connection, read, and timeout failures retried automatically, so that intermittent network failures are recoverable.
49. As an operator, I want authentication, invalid-request, and other stable `4xx` failures to fail immediately, so that retries do not hide configuration errors.
50. As an operator, I want a valid `Retry-After` header respected within a bound, so that provider rate-limit guidance takes priority over local guesses.
51. As an operator, I want exponential backoff with jitter when no valid `Retry-After` exists, so that repeated attempts spread out and become progressively less aggressive.
52. As an operator, I want provider transport attempts separate from tool and output validation retries, so that retry budgets cannot multiply invisibly.
53. As an operator, I want transport waits included in the Wiki Run wall-clock deadline, so that retries cannot extend a run forever.
54. As an operator, I want an ambiguous network retry marked as possibly duplicated, so that potential duplicate provider billing is observable.
55. As an operator, I want provider retry exhaustion to fail the current Wiki Run without rerunning it, so that automatic recovery remains bounded.
56. As an operator, I want a failed run to produce a secret-free immutable input record, so that I can reproduce it after the process exits.
57. As an operator, I want a Manual Retry Run to reuse the exact failed Repository Snapshot revisions, so that retry does not silently analyze newer code.
58. As an operator, I want a Manual Retry Run to reuse the exact Skill digest, model, limits, and explicit answers, so that retry remains comparable to the failed attempt.
59. As an operator, I want a Manual Retry Run to receive a new run identity, Run Plan, contexts, Analysis Workspace, and receipts, so that stale partial state cannot contaminate it.
60. As an operator, I want following a branch's newest revision to be an explicit new Wiki Run, so that retry and refresh have distinct meanings.
61. As an operator, I want a clear error when a frozen source revision or Skill digest is no longer available, so that the system does not substitute a different input.
62. As a CLI user, I want `wiki-run` to remain non-interactive JSON, so that existing scripts and CI remain stable.
63. As a terminal user, I want an explicit TUI command, so that interactive behavior never appears unexpectedly in automation.
64. As a terminal user, I want to start a Generate or Refresh from an existing run configuration, so that the TUI does not create a second configuration format.
65. As a terminal user, I want to see the current Run Plan, so that I understand what the Agent believes remains to be done.
66. As a terminal user, I want to see Root, Domain, and Leaf status, so that a long recursive run does not appear frozen.
67. As a terminal user, I want to see bounded tool labels and branch summaries, so that I can diagnose progress without exposing raw source or model reasoning.
68. As a terminal user, I want to see provider retry countdowns and causes, so that a rate-limited run does not appear hung.
69. As a terminal user, I want to see compaction and receipt publication events, so that I can distinguish context management from source investigation.
70. As a terminal user, I want Needs Input questions presented clearly, so that I can provide explicit answers in a fresh run.
71. As a terminal user, I want a failed run to offer a Manual Retry Run using frozen inputs, so that recovery is obvious and deliberate.
72. As a terminal user, I want a separate action for starting against newer branch revisions, so that I cannot confuse it with retry.
73. As a terminal user, I want final validation, publication, no-op, and failure states displayed distinctly, so that I know whether the Published Wiki changed.
74. As a terminal user, I want Ctrl+C to cancel the active run without publishing partial staging, so that interactive cancellation is safe.
75. As a terminal user, I want non-TTY invocation to reject or fall back cleanly, so that pipes and cron never attempt raw terminal input.
76. As a security-conscious user, I want the TUI to redact credentials and provider headers, so that interactive diagnostics cannot leak secrets.
77. As a security-conscious user, I want the TUI to omit model chain-of-thought, so that only explicit status, tool, receipt, and terminal output are shown.
78. As a product maintainer, I want prompt-toolkit and Rich reused instead of a Node/Ink sidecar, so that the product remains one Python package.
79. As a product maintainer, I want the TUI to consume the same Host events available to tests and diagnostics, so that presentation cannot invent workflow state.
80. As a product maintainer, I want DynamicWorkflow restricted to one homogeneous coordination layer, so that it cannot become a second recursive workflow engine.
81. As a product maintainer, I want Planning, SubAgents, compaction, and overflow handling configured as Harness capabilities, so that the product does not reimplement them.
82. As a product maintainer, I want no custom scheduler, message queue, file watcher, lock manager, or workflow DSL, so that adaptive orchestration remains small.
83. As an evaluator, I want current CodeMode-only runs compared with Planning/compaction and bounded SubAgents variants, so that each capability's value is measurable.
84. As an evaluator, I want the same model, snapshot, Skill digest, validator, and limits across comparison arms, so that orchestration is the meaningful variable.
85. As an evaluator, I want representative small, medium, large, and multi-repository cases, so that scale triggers are validated rather than assumed.
86. As an evaluator, I want semantic coverage, unsupported claims, Root peak context, whole-tree cost, latency, depth, fan-out, receipt compression, retries, and permission violations measured, so that quality and operational trade-offs are visible.
87. As a product maintainer, I want the adaptive path accepted only when large-case quality improves without weakening grounding or publication safety, so that complexity earns its place.
88. As a product maintainer, I want small cases protected from unnecessary fan-out and latency, so that adaptive behavior remains proportional to the input.

## Implementation Decisions

- This specification extends the existing Repository Wiki Producer. Repository Snapshot freezing, Producer Skill versioning, untrusted-source handling, direct Markdown generation, mechanical validation, staging, and atomic publication remain authoritative.
- The sole application operation remains `WikiRunApplication.run(request) -> WikiRunResult`. CLI, TUI, CI, and tests invoke this same operation.
- Progress observation is optional and Host-owned. A bounded observer/event sink is supplied when constructing the application or its run dependencies; it does not change the `run` method's request or terminal result contract.
- Run events are diagnostics, not workflow state. Correctness is derived from the Run Plan capability state, validated receipts, terminal result, and filesystem/publication invariants.
- Events carry a run ID, monotonically increasing sequence, timestamp, event type, bounded public payload, and optional node ID. They never contain credentials, secret headers, raw prompts, complete source text, full child output, or implicit model reasoning.
- Event types cover run creation, snapshot/Skill freezing, Run Plan updates, node dispatch/start/finish/failure/cancellation, receipt publication, compaction, provider retry scheduling/exhaustion, validation, publication, Needs Input, cancellation, and terminal failure/success.
- The explicit terminal interface is `okf-wiki tui --config <run-config>`. Existing `wiki-run` behavior and JSON output remain unchanged. The first TUI does not duplicate every direct `wiki-run` flag; the versioned YAML configuration is its run input.
- The TUI uses prompt-toolkit for input/history and Rich for live status and Markdown. It does not import Pydantic AI private CLI modules, add Node/React/Ink, or add Textual in the first version.
- If product code imports prompt-toolkit or Rich directly, they become explicit runtime dependencies even though the pinned Pydantic AI distribution currently installs them through its CLI extra.
- The TUI is line-oriented rather than a full-screen pane manager. It may later gain a full-screen tree only if evaluation shows that the line view cannot represent concurrent branches clearly.
- Non-TTY use of the TUI fails with an actionable message. Automation continues to use `wiki-run`; no automatic TTY-based mode switch changes existing CLI output.
- TUI cancellation cancels the active application task, cleans the Analysis Workspace and staging according to existing rules, writes a cancelled run record, and never publishes.
- TUI Needs Input answers create a fresh Wiki Run. The Host assigns each returned question a stable identifier derived from the previous run ID and question position without changing the existing list-of-questions terminal payload. The new request carries a bounded explicit mapping from those identifiers to trusted user answers; old message history is not resumed.
- The Root Agent owns the global Semantic Workflow, Run Plan, page decisions, cross-domain synthesis, final Markdown, review, Wiki Manifest, and completion decision.
- The default recursive topology is acyclic and fixed at maximum depth two: `Root → Domain → Leaf`.
- Root may call at most four Domain Agents. Normal default fan-out is one or two; three or four require inventory evidence of truly independent repositories or domains.
- Each Domain may call at most two Leaf Agents. A separate Reviewer, when enabled as a child, adds at most one further child run but cannot delegate.
- The Host topology therefore permits at most twelve research child runs, or thirteen including one Reviewer. Harness-local `max_calls` supplements but does not define this whole-tree ceiling.
- Global child concurrency starts at four. Each Agent also receives explicit backpressure/concurrency configuration.
- The Producer Skill guides Root to consider delegation for multiple repositories, multiple substantial domains, large text-like scope, independent reader questions or call paths, broad Refresh diffs, or unresolved scopes after compaction. These are semantic guidance, not a Python classification pipeline.
- The Host may deterministically partition an input into fresh sessions only when it cannot fit inside the fixed topology and whole-tree envelope. It does not increase recursive depth.
- Root and Domain Agents have Planning. Leaf Agents use a small fixed task contract and do not require Planning unless evaluation demonstrates long-running Leaf drift.
- A Run Plan records the objective, completion gates, intended pages, evidence gaps, delegated node states, receipt references, unresolved questions, and next actions. It is concise control state, not a transcript or evidence store.
- Planning is per `Agent.run()` memory. It survives message compaction in the same run but is not a durable checkpoint and is not reused by a Manual Retry Run.
- Root and Domain Agents use TieredCompaction. Cheap deterministic tiers run before summarization. Compaction starts near 60% of a configured model context target and aims near 50%; a warning at 70% steers the Agent to close the current scope.
- The model context target comes from an explicit supported-model profile or run limit. The implementation does not confuse cumulative input-token limits with one-request context capacity and does not guess an unknown provider window.
- All load-bearing child output must be published as a receipt before it can be removed or summarized from message history.
- Oversized CodeMode, SubAgent, and DynamicWorkflow returns use bounded truncate/spill behavior before entering visible history. Exact evidence remains in the Analysis Workspace.
- The trusted Agent roster is constructed explicitly. Agent-folder auto-discovery is disabled, inherited tools are disabled by default, and repository-local agent or Skill definitions are never loaded as product capabilities.
- Root receives `/source` and `/skill` read-only, `/wiki` read-write, and Host-mediated Analysis Workspace access.
- Domain and Leaf Agents receive `/source` and `/skill` read-only, Host-mediated access only to assigned/parent receipts, and no `/wiki` mount.
- DynamicWorkflow is optional and may occur only at one Domain-to-Leaf layer for homogeneous fan-out, compare, vote, chain, or reduce work that will not recursively invoke another DynamicWorkflow.
- SubAgents remain the recursive mechanism. DynamicWorkflow direct-call limits do not count grandchildren, so any child SubAgents remain separately constrained by Host topology and budgets.
- The Analysis Workspace is a private run-local temporary directory. It is deleted after success, failure, or cancellation unless the operator explicitly enables diagnostic retention before cleanup.
- Canonical Analysis Receipts are immutable UTF-8 JSON validated by a versioned Pydantic schema. Markdown is allowed only as an optional long artifact. JSONL is reserved for Host-owned append-only diagnostics and is never a completion signal.
- A receipt contains schema version, run/node/parent/attempt identity, assigned scope, terminal status, bounded summary, findings, evidence references, child receipt references, artifact descriptors, and open questions.
- Receipt status is `complete`, `partial`, `failed`, or `cancelled`. Only `complete` satisfies a critical planned scope.
- Evidence identifies repository ID, exact frozen revision, repository-relative path, inclusive one-based line range, supported claim, and SHA-256 of the exact cited materialized bytes. The Host verifies the reference and hash before publishing the receipt.
- A canonical receipt is limited to 128 KiB. An optional artifact is limited to 2 MiB, the Analysis Workspace to 32 MiB and 256 entries by default. These limits are part of `WikiRunLimits` and may be configured explicitly.
- Research Agents call a Host-owned `publish_receipt` tool. The Host assigns opaque paths, checks identity, schema, status, quota, evidence, source revision, path containment, line range, hash and artifact descriptors, writes a same-filesystem temporary file, then publishes it with atomic replacement.
- Parent Agents use a Host-owned `read_receipt` operation keyed by opaque receipt identity. It returns the bounded canonical JSON or paginated artifact slices and never exposes directory listing as a discovery or completion mechanism.
- A short Handoff Ref returns task identity, status, bounded summary and receipt path after publication. Directory scans, file existence, `.done` files, lockfiles, and polling never declare task completion.
- Sibling Agents do not share writable paths. A later attempt creates a new immutable receipt and never overwrites an earlier attempt.
- A critical `partial` or `failed` receipt gets at most one automatic child retry. Parent may then perform one direct fallback investigation within its remaining budget. If the scope remains incomplete, the Wiki Run fails and preserves the previous Published Wiki.
- Non-critical planned work may be explicitly cancelled in the Run Plan. It cannot disappear merely because a budget was exhausted.
- The existing 350,000-token and 50-request defaults remain the whole Wiki Run envelope. They are divided across Root, children, review, compaction, and recovery rather than copied to every Agent.
- The initial evaluation profile allocates Root 18 requests/150,000 tokens; up to two normal Domain runs 6 requests/25,000 tokens/120 seconds each; up to four Leaf runs 3 requests/18,000 tokens/90 seconds each; and one Reviewer 5 requests/30,000 tokens. The remaining request/token reserve covers summarization, response overshoot and failure recovery.
- If Root expands to three or four Domains, the Host must recompute smaller node allocations or require an explicitly larger whole-tree envelope. It cannot reuse the normal per-node allocations unchanged.
- Harness 0.7.0 cannot simultaneously provide strict child limits and exact parent usage aggregation. The first version chooses local hard child budgets, collects actual usage through content-free instrumentation/events, and makes Host dispatch decisions from allocated rather than merely observed budgets.
- Content-bearing instrumentation remains disabled. Metrics include requests, tokens, cost where available, depth, fan-out, child duration, receipt size, compaction, retries and terminal status.
- Provider transport retries are separate from tool, output-validation, CodeMode, child and whole-run retry budgets.
- Every model HTTP request allows at most three total transport attempts: the initial attempt plus two retries.
- Retryable responses are HTTP `408`, `429`, `500`, `502`, `503`, and `504`. Retryable exceptions are transient connection, read and timeout failures. Authentication, invalid-request and other stable `4xx` responses fail immediately.
- The implementation uses Pydantic AI's `AsyncTenacityTransport` and installed Tenacity support rather than a custom retry loop.
- A valid `Retry-After` seconds or HTTP-date value is honored up to 60 seconds. Otherwise backoff starts at one second, grows exponentially with small positive jitter, and is capped at 30 seconds.
- Transport waits count against the Wiki Run wall-clock deadline. Each retry event records attempt, public error category, chosen delay and whether an ambiguous network failure may represent a duplicated provider request.
- Transport exhaustion reraises the final safe provider error and fails the current Wiki Run. There is no automatic whole-run restart.
- Every terminal Wiki Run writes an immutable, secret-free run record outside the temporary Analysis Workspace. The record contains run identity, status, operation, exact Repository Snapshot identities/revisions/ignore sets, Skill path and digest, model identity and non-secret settings, limits, explicit answers, timing, usage summary, retry counters, publication outcome and safe failure category.
- Run records exclude credentials, secret headers, prompts, messages, receipts, source excerpts, artifacts and raw provider error bodies. They are small operational metadata, not durable Agent execution state.
- Run records are bounded UTF-8 JSON stored in a producer-owned operational directory adjacent to the publication root, outside the Published Wiki. The first version keeps these small records until explicit operator cleanup and does not add a retention service or garbage collector.
- Cross-process Manual Retry Runs require a serializable provider/model identifier and non-secret settings. An opaque in-process custom Model object may be retried only by the caller that can reconstruct it and is marked non-replayable in the persisted record.
- A Manual Retry Run is created only by an explicit human action using a failed or cancelled run record. It receives a new run identity and fresh staging, Planning, message histories, Analysis Workspace and receipts.
- Manual retry reuses the exact resolved Repository Snapshot revisions, Skill digest, model, non-secret model settings, limits and explicit answers. Provider credentials are reread from the current trusted environment.
- A Manual Retry Run never reuses partial receipts, old Agent messages, old Run Plan state or a partially written Staging Wiki.
- If an exact repository revision or Skill digest can no longer be resolved, retry fails closed with an actionable error. It never substitutes a branch tip, latest Skill or different model.
- Following newer branch commits is a normal Generate or Refresh Wiki Run, not a Manual Retry Run.
- Durable checkpoint/resume of a partially executed Agent tree remains a separate future design.

## Testing Decisions

- The primary behavioral seam remains the complete Wiki Run application operation. Given fixed snapshots, Skill, model fixtures, limits, optional prior publication and an optional observer, tests assert terminal result, emitted public events, validated receipts, staging cleanup, run record and final publication.
- The application seam is preferred over testing individual capability calls. Lower-level tests are reserved for trust-boundary parsers, receipt publication, retry predicate/backoff and atomic filesystem behavior where failures need precise localization.
- Tests assert externally visible state and safety, not model chain-of-thought, exact prompt text, exact tool order, private Planning implementation, or incidental number of filesystem reads.
- Existing Wiki Run tests are prior art for deterministic model scripting, resource-limit errors, validation retries, symlink/path races, refresh, staging cleanup and atomic publication.
- Existing installed-package tests are prior art for exercising the actual CLI entry point and verifying distribution contents.
- Existing documentation tests remain the gate for local Markdown links and product documentation.
- A small-scope test proves the Agent can complete without SubAgents, Analysis Receipts or DynamicWorkflow and does not pay adaptive fan-out latency.
- A large-scope scripted test proves Root delegates independent Domain tasks, receives bounded receipts, synthesizes one coherent Wiki and remains the only `/wiki` writer.
- A recursive test proves a Domain can delegate two Leaf tasks and reduce them, while a Leaf cannot delegate beyond the fixed topology.
- Depth and fan-out tests attempt a fourth layer, a fifth Domain, a third Leaf and a second Reviewer and prove dispatch is rejected before child execution.
- A concurrency test blocks children and proves no more than four child runs execute simultaneously.
- Trusted-roster tests place agent definitions in target repositories and working directories and prove they are never discovered or loaded.
- Mount tests prove Root can write staging, Domain/Leaf cannot access `/wiki`, and every Agent is unable to alter `/source` or `/skill`.
- Planning tests prove the current objective, completion gates, branch states and receipt references are visible after history compaction.
- Compaction tests prove cheap tiers precede model summarization, thresholds use the configured context target, and load-bearing outputs are in receipts before history removal.
- Overflow tests return a child or CodeMode result larger than the visible limit and prove the parent receives only a bounded preview/reference while exact evidence remains recoverable.
- Receipt schema tests cover every status, required identity, bounded strings, evidence count, child references, artifacts, unknown fields and schema versions.
- Receipt security tests cover traversal, absolute paths, symlink escape, wrong run/node/attempt, repository revision mismatch, invalid line ranges, hash mismatch, artifact quota, workspace quota and concurrent publication.
- Atomic receipt tests inject failures before validation, during temporary write and before replacement and prove no partial final receipt is visible.
- Control-protocol tests prove a valid file without a Handoff Ref does not complete a task, and a Handoff Ref to a missing or invalid receipt is rejected.
- Critical-scope tests prove `partial`, `failed` and `cancelled` receipts cannot satisfy completion; one child retry and one Parent fallback are bounded; unresolved load-bearing work preserves the old Published Wiki.
- Budget tests prove node allocations sum within the whole-tree request/token envelope, dispatch reserves synthesis capacity, and expansion to three or four Domains cannot reuse the normal profile unchanged.
- Harness-accounting tests prove local child limits stop children and content-free usage collection aggregates Root and child metrics without recording source or prompts.
- DynamicWorkflow tests prove one Domain-to-Leaf typed fan-out/reduce succeeds, nested DynamicWorkflow is rejected, direct-call ceilings are enforced and child failure cannot be mistaken for a complete reduce.
- Provider retry tests use an HTTP mock transport and controllable clock. They cover each retryable status, stable `4xx`, `Retry-After` seconds/date, malformed headers, exponential delays, jitter bounds, 30/60-second caps and three total attempts.
- Network retry tests cover connect, read and timeout exceptions, possible-duplicate event marking, wall-clock exhaustion and final safe error propagation.
- Retry-separation tests prove provider attempts do not consume or reset tool/output retry counters and never restart the whole Wiki Run.
- Run-record tests prove success, Needs Input, failure and cancellation write secret-free immutable records with exact resolved inputs and safe terminal metadata.
- Manual-retry tests prove a new run uses the same revisions, Skill digest, model, limits and explicit answers but different IDs, staging, Planning, messages, Analysis Workspace and receipts.
- Manual-retry tests mutate a configured branch and prove retry still selects the old revision, while an explicit Refresh selects the new revision.
- Manual-retry tests remove a frozen revision or change a Skill and prove retry fails rather than substituting another input.
- TUI tests project a deterministic event stream and assert the displayed Plan, tree state, tool labels, receipts, compaction, retry countdown, validation and publication without depending on terminal color escape details.
- Pseudo-TTY tests prove the TUI accepts input, handles Ctrl+C safely, presents Needs Input, starts a Manual Retry Run only after explicit confirmation and distinguishes retry from a new-revision run.
- Non-TTY tests prove `wiki-run` remains identical JSON, `tui` rejects unavailable terminal input cleanly, and no Ink/Node process or web server is required.
- Redaction tests inject credentials, provider headers and secret-like error text and prove neither events, TUI output, run records nor retained diagnostics expose them.
- Evaluation runs three controlled arms: current CodeMode only; CodeMode plus Planning/compaction; and CodeMode plus Planning, bounded recursive SubAgents, receipts and compaction. A fourth variant may enable single-layer DynamicWorkflow only where homogeneous Leaf coordination exists.
- Evaluation uses identical model, provider, Repository Snapshot Set, Skill digest, output validation and whole-tree envelope across arms.
- Evaluation covers representative small, medium, large and multi-repository cases, including the existing OpenWiki, IWE and Open Knowledge snapshots.
- Quality measures include human semantic grounding, expected-topic and boundary/flow coverage, unsupported claims, navigation, duplication, cross-domain synthesis, page-plan/manifest consistency and reviewer defects.
- Orchestration measures include Root peak input, whole-tree tokens/cost, compaction, delegation count, depth, fan-out, concurrency, receipt compression, duplicate scopes, contradictions, re-delegation, timeouts, budget exhaustion and source-span reopening.
- Operational measures include wall time, provider concurrency, retries, scratch usage/cleanup, run-record creation, cancellation and attempted permission violations.
- Acceptance requires clear large/multi-repository quality improvement over CodeMode only, no increase in unsupported claims, lower Root peak context, bounded whole-tree cost/latency, zero privilege violations and no material small-case slowdown from unnecessary delegation.
- Implementation changes run the full Python tests, lint, formatting, type checks, lockfile checks and package-release tests in addition to documentation checks.

## Out of Scope

- Replacing Repository Snapshot, Producer Skill, Source Citation, Markdown validation, Staging Wiki or atomic Published Wiki behavior from the base specification.
- A hosted web UI, Workspace Console, browser frontend, server process or multi-user administration.
- A Node, React or Ink runtime inside the Python product.
- A full-screen Textual dashboard, multiple resizable panes, mouse interaction or terminal image rendering in the first TUI.
- Editing Wiki Run YAML, repositories, Skills, provider credentials or secret environment values inside the TUI.
- Persistent open-ended chat sessions or reusing Agent message history between Wiki Runs.
- Persisting Analysis Receipts or artifacts as a permanent knowledge base by default.
- Crash/redeploy checkpoint resume, exactly-once Agent side effects, distributed workers, Temporal/DBOS/Prefect/Restate integration or StepPersistence recovery.
- Automatic whole-run retry after transport, child, usage, validation or publication failure.
- Updating a branch or selecting a newer Skill/model as part of Manual Retry Run semantics.
- Reusing partial receipts, old staging or old Run Plan state during manual retry.
- Recursion beyond `Root → Domain → Leaf`, self-registering Agents or model-selected topology depth.
- Nested DynamicWorkflow or using DynamicWorkflow as the global Semantic Workflow backbone.
- A custom Python Scheduler, Planner/Worker role framework, graph workflow, message queue, filesystem watcher, lock protocol or workflow DSL.
- Giving research Agents write access to the Staging Wiki or arbitrary Analysis Workspace paths.
- Treating directory scans, file appearance, JSONL events or lockfiles as task-completion signals.
- Exposing model chain-of-thought, raw prompts, raw provider responses, source excerpts or secret-bearing diagnostics in the TUI or run events.
- Executing target-repository code, builds, tests, package managers, plugins, scripts or arbitrary shell commands.
- Loading target-repository AGENTS, CLAUDE, Skills or plugins as trusted instructions.
- Adding external repository-analysis network tools beyond the configured model provider.
- Guaranteeing exact full-tree token enforcement beyond provider response boundaries where the pinned Harness cannot provide it; the design bounds allocation, requests, topology, concurrency and wall time and measures actual usage.

## Further Notes

- This specification is an additive evolution of Repository Wiki Producer and is authoritative wherever the older specification says the first version must remain single-Agent or defer SubAgents, DynamicWorkflow and compaction.
- ADRs covering bounded recursive SubAgents, single-layer DynamicWorkflow, file receipts, Manual Retry Runs and provider transport retries are the architectural record behind this specification.
- The current runtime still implements one Agent plus CodeMode and final JSON output. This specification does not claim the adaptive workflow or TUI already exists.
- The TUI should be implemented after the public run-event projection exists; it must not drive correctness by scraping logs or Analysis Workspace files.
- A run record is deliberately smaller than durable execution state. If future requirements demand resuming active Agent trees after process failure, create a separate specification and ADR.
- If the pinned Pydantic AI or Harness version cannot expose an event or budget behavior assumed here, preserve the application and safety contract, document the exact upstream limitation and prefer the smallest supported capability rather than building a parallel framework silently.
- Ticket decomposition is not included. Use the ticketing workflow after this specification is accepted.
