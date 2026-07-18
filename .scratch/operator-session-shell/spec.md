# Operator Session Shell

**Status:** ready-for-agent
**ADR:** [0018](../../docs/adr/0018-operator-session-hitl-publication.md)
**Glossary:** [CONTEXT.md](../../CONTEXT.md)

## Problem Statement

Operators cannot run the product the way they run modern agent CLIs. The default path is a silent one-shot Wiki Run that ends in a single JSON object: progress is invisible, failures often collapse into opaque “provider diagnostics withheld” (including missing API keys), the line-oriented TUI is not a real multi-turn Operator Session, Needs Input does not close the loop, publication is automatic after validation without a clear human gate, and context pressure on root and child agents is only partially managed. Automation (CI) still needs a non-interactive path, but humans need a Session-first, diagnosable, human-in-the-loop experience that still respects frozen Repository Snapshots, Host validation, and atomic publication.

## Solution

Make the **Operator Session** the primary interactive product: an installable conversation shell that streams simplified analysis cards, runs Wiki Runs as bounded jobs inside the Session, uses Pydantic AI deferred tool approval for publication (YOLO / explicit `--yes` only for auto-approve), always offers a single Wiki Reviewer before publish (optional separate model), keeps Staging when publication is declined, extends Wiki Run Record statuses for awaiting/declined publication, applies harness compaction and overflow on every agent (conversation, root, children, reviewer), and surfaces secret-safe, actionable errors with credential preflight. Non-TTY and print modes remain for automation. Wiki Visualization stays a separate static artifact of the Published Wiki.

## Proposed test seams

Prefer **one primary seam** plus the existing Host seam; avoid testing private helpers or terminal escape codes.

| Seam | Role | Why |
|---|---|---|
| **1. Operator Session API (primary)** | Start/continue Session turns; resolve deferred publication approval and Needs Input; return a structured view model (cards, gates, statuses) without requiring a real TTY | Highest product surface; TUI and print are thin adapters over the same API |
| **2. Wiki Host application (existing)** | Wiki Run lifecycle, observer events, Records, Staging vs Published invariants, resource limits | Already the integration seam in existing run tests; keep Host guarantees testable without UI |
| **3. Operator diagnostics (narrow)** | Preflight + secret-safe error message pure functions | Fast unit coverage for the env-withheld class of bugs |

**Not seams:** individual Rich widgets, prompt_toolkit key bindings, internal adaptive roster wiring details, or re-implementing Pydantic AI deferred-tool machinery.

If this seam set is wrong, say so before implementation diverges; default assumption is **Session API first**, Host second, diagnostics third.

## User Stories

1. As an operator, I want to install one command-line product and run it in my project directory, so that I do not need a multi-step developer setup to start work.
2. As an operator, I want the default interactive entry to open an Operator Session, so that I work in a conversation, not a one-shot black box.
3. As an operator, I want to type natural-language goals (generate, refresh, ask), so that I do not memorize dozens of flags for daily use.
4. As an operator, I want slash commands for common controls (usage, yolo, doctor, quit, sessions), so that power actions stay discoverable.
5. As an operator, I want multi-turn history in a Session, so that follow-ups like “expand the auth section” reuse context.
6. As an operator, I want Wiki Runs started from a Session to remain bounded jobs with frozen inputs, so that audit and Manual Retry stay meaningful.
7. As an operator, I want Manual Retry to create a new Wiki Run from a Wiki Run Record, so that I never resume a half-finished Semantic Workflow.
8. As an operator, I want Manual Retry to attach to the same Operator Session when I choose, so that conversation context is not lost.
9. As a CI system, I want a non-interactive print/run path, so that pipelines do not require a TTY.
10. As a CI system, I want missing credentials to fail with a clear message and non-zero exit, so that jobs are debuggable.
11. As a CI system, I want publication auto-approve only when I pass an explicit flag (yolo/yes), so that unattended runs do not surprise-publish without intent.
12. As an operator, I want live simplified progress cards (freeze, plan, children, tools, compaction, validation, review, publish), so that long runs are observable.
13. As an operator, I do not want raw model chain-of-thought or secret-bearing provider bodies in the Session UI, so that the product stays safe and scannable.
14. As an operator, I want tool activity shown as short labels and timings, so that I can see work without drowning in logs.
15. As an operator, I want adaptive child node status in the Session view, so that Domain/Leaf work is visible.
16. As an operator, I want compaction events as compact cards, so that I know when context was reduced.
17. As an operator, I want provider retry wait information when transport retries schedule, so that stalls are explained.
18. As an operator, I want Needs Input questions presented in the Session, so that I can answer without leaving the tool.
19. As an operator, I want answered Needs Input to start a **new** Wiki Run with explicit answers, so that frozen-input semantics stay honest.
20. As an operator, I want publication to require my approval after validation and review by default, so that the Published Wiki never updates silently.
21. As an operator, I want a clear approve/deny publish gate with a defects summary, so that I decide with review context.
22. As an operator, I want denying publication to leave Staging intact and leave the Published Wiki unchanged, so that I can fix and retry without discarding work.
23. As an operator, I want YOLO mode to auto-approve deferred publication approvals only, so that trusted full-speed runs still keep Host guards.
24. As an operator, I want a visible YOLO indicator, so that I never auto-approve by accident.
25. As an operator, I want YOLO to still run Host validation and the Wiki Reviewer, so that quality gates are not skipped.
26. As an operator, I want a single independent Wiki Reviewer before publish, so that staged pages get a second look.
27. As an operator, I want to configure an optional separate reviewer model identity, so that review can use a different provider/model than production writing.
28. As an operator, I want the Reviewer to run on non-adaptive runs too, so that small projects still get review before HITL publish.
29. As an operator, I want to disable the Reviewer when policy allows, so that cost-sensitive runs can opt out.
30. As an operator, I want mechanical Host validation to remain mandatory regardless of Reviewer outcome, so that citations and limits stay enforced.
31. As an operator, I want context compaction applied when the main agent approaches the context budget, so that long Sessions do not die on context overflow.
32. As an operator, I want the same compaction family on subagents and the Reviewer, so that child investigations do not blow the window either.
33. As an operator, I want large tool outputs overflowed or truncated by harness policy, so that one huge tool return does not dominate history.
34. As an operator, I want compaction implemented with pydantic-ai-harness capabilities, so that the product does not maintain a custom summarizer stack.
35. As an operator, I want HITL implemented with Pydantic AI deferred tools, so that approval is not a bespoke protocol.
36. As an operator, I want streaming implemented with Agent iter/stream events, so that the UI tracks the real agent graph.
37. As an operator, I want Session persistence to prefer harness step persistence where practical, so that resume/list does not invent a second checkpoint system.
38. As an operator, I want Wiki Run Records to record `awaiting_publication` when work is ready but not yet approved, so that audit matches reality.
39. As an operator, I want Wiki Run Records to record `publication_declined` when I deny publish, so that declined runs are not marked complete.
40. As an operator, I want `complete` to mean publication succeeded (or a documented successful no-op refresh), so that complete is not ambiguous.
41. As an operator, I want failed and cancelled statuses preserved for true failures and interrupts, so that ops language stays stable.
42. As an operator, I want Ctrl+C to cancel the active Wiki Run safely without publishing partial Staging, so that Published Wiki integrity holds.
43. As an operator, I want missing API keys to tell me which variable to set and how, so that I can fix env without guessing.
44. As an operator, I want provider errors to show redacted useful messages, so that “withheld” is not the default for non-secret failures.
45. As an operator, I want secrets in error text and Session lines redacted, so that keys never appear in stdout/stderr/UI.
46. As an operator, I want optional error dump files that are secret-scrubbed, so that deep debugging is possible without leaking credentials.
47. As an operator, I want a doctor/diagnostics view of credential presence and source (process vs file), so that I can see what the product will use.
48. As an operator, I want preflight before expensive snapshot work when credentials are clearly missing, so that I fail fast.
49. As an operator, I want config validation errors to list fields clearly, so that YAML mistakes are fixable.
50. As an operator, I want Host path/mount errors to stay specific, so that filesystem policy failures are actionable.
51. As an operator, I want usage and limit failures to name the limit, so that I can raise budgets deliberately.
52. As an operator, I want Session list/switch (even if minimal at first), so that multi-session work is possible without multiple ad-hoc terminals.
53. As an operator, I want to start a new Session without deleting project config, so that experiments stay isolated.
54. As an operator, I want ask/plan style turns that do not publish, so that I can explore without mutating the Published Wiki.
55. As an operator, I want build/generate turns that can publish only through the gate, so that production writes stay controlled.
56. As an operator, I want refresh operations to respect existing publication and HITL, so that updates are intentional.
57. As an operator, I want skill digest and snapshot freeze to remain Host-owned, so that the model cannot redefine the source set mid-run.
58. As an operator, I want Analysis Receipts and workspace cleanup behavior unchanged in spirit, so that adaptive evidence stays Host-scoped.
59. As an operator, I want static Wiki Visualization still available after a successful publish, so that browsing stays separate from the run console.
60. As an operator, I want init/config flows to remain usable without calling the model, so that project bootstrap stays cheap.
61. As a package consumer, I want existing automation that calls wiki-run JSON to keep working or have a documented successor flag, so that CI does not break silently.
62. As a developer agent, I want acceptance criteria testable at the Session and Host seams, so that AFK implementation can verify without flaky TTY tests.
63. As an operator, I want declined Staging to be usable for a later approve or a follow-up Run, so that deny is not a dead end.
64. As an operator, I want YOLO off by default, so that the safe path is the default path.
65. As an operator, I want environment or config to set default YOLO only when I opt in, so that shared machines stay safe.
66. As an operator, I want reviewer defects to be bounded and redacted in the UI, so that review output cannot dump secrets or megabytes of text.
67. As an operator, I want concurrent Wiki Runs against the same publication path to still fail closed on the publication lock, so that Host FS policy holds under Session use.
68. As an operator, I want wall-clock and usage limits to still stop runaway Runs, so that Sessions cannot burn unbounded budget.
69. As an operator, I want compaction and summary model usage counted in run usage, so that cost accounting stays honest (framework behavior).
70. As an operator, I want documentation of the Session vs Wiki Run distinction, so that I do not expect chat resume of Staging publication.

## Implementation Decisions

### Product shape
- Operator Session is the default interactive product object; Wiki Run is a job inside it (ADR 0018).
- Print/non-TTY remains the automation path; interactive Session requires a TTY (or an explicit print mode).
- Do not ship generic `clai` / bare `Agent.to_cli` as the product; reuse its interaction patterns (stream + slash + Rich) inside a Host-aware shell.
- Wiki Visualization remains post-publish static output, not the operator run console (ADR 0016).

### Modules (logical)
- **Operator Session runtime:** multi-turn loop, message history, deferred HITL resolution, Needs Input → new Wiki Run, view-model projection for cards/gates.
- **Session adapters:** conversation TUI; print/CI adapter; optional later web is out of scope for this spec’s delivery bar.
- **Wiki Host application:** Snapshot freeze, skill freeze, adaptive orchestration, validation, publication lock/swap, Records, observer events — extended so publication is approval-gated.
- **Diagnostics:** preflight, secret-safe error formatting, doctor/credential summary, optional error dump.
- **Context capability factory:** shared attachment of harness compaction, limit warning, and overflowing tool output for every agent role that issues model requests.
- **Wiki Reviewer wiring:** single independent reviewer agent; optional separate model identity; invoked on adaptive and non-adaptive publish paths unless disabled by policy.

### Publication and HITL
- After Host validation succeeds and Wiki Reviewer has run (unless disabled), publication is exposed as a deferred-approval tool (Pydantic AI `requires_approval` / `ApprovalRequired` / `HandleDeferredToolCalls`), not a silent side effect of structured `Complete` alone.
- Default interactive: human must approve or deny.
- YOLO / explicit non-interactive auto-approve: `DeferredToolResults.build_results(approve_all=True)` (or equivalent handler); never disables validation, mounts, or locks.
- Deny publication: Staging retained; Published Wiki unchanged; Record status `publication_declined` (name may match exactly).
- Ready for human publish decision: Record status `awaiting_publication`.
- `complete` only for successful publication path (including documented no-op refresh success).

### Review
- One Wiki Reviewer role (not a multi-model voting panel).
- Optional `reviewer_model` (or equivalent config key) falls back to the producer model.
- Reviewer remains non-publishing, Staging/source-oriented defects receipt; Host mechanical validation stays separate.

### Context management
- Use pydantic-ai-harness `TieredCompaction` (cheap tiers then summarizing), `LimitWarner`, and `OverflowingToolOutput`.
- Apply via one factory to conversation agent (if any), root, domain, leaf, and reviewer.
- Observable wrappers may emit existing-style public events only; no second compression algorithm.

### Errors
- Redact secrets from all operator-visible surfaces.
- Do not map clean, non-secret provider/env failures to a single withheld string solely because the exception type is outside a narrow allowlist.
- Preflight missing credentials for the configured model family before expensive work when detectably unset.
- Preserve multi-line config validation quality already present for YAML.

### Records and retries
- Extend Wiki Run Record status enum for awaiting and declined publication.
- Manual Retry Run remains a new Wiki Run from a Record (ADR 0012); may attach to the same Operator Session.
- Needs Input remains a terminal Run outcome that does not publish; answers feed a new Run.

### Framework preference
- Streaming: Agent iter / stream events.
- HITL: deferred tools.
- Session continuity: message history + prefer StepPersistence for stored steps/snapshots.
- Orchestration: existing CodeMode / adaptive / DynamicWorkflow paths — extend, do not replace with a new bus.

### Configuration (conceptual)
- Producer model identity (existing).
- Optional reviewer model identity.
- Context target / ratios for compaction (existing limits spirit).
- YOLO default false; flags/env/slash to enable.
- Non-interactive auto-publish only via explicit yes/yolo-class flag.

## Testing Decisions

### What good tests look like
- Assert **external behavior**: Session view models, Host events, Record fields, Staging/Published filesystem outcomes, exit codes, error message content (secret-safe), approval/deny/yolo effects.
- Do **not** assert Rich markup, cursor codes, private method call order, or exact LLM prompt text.
- Prefer fake/function models and injected approval handlers over live network.

### Primary seam tests (Operator Session API)
- Turn streaming produces ordered simplified cards for a scripted fake agent/host event sequence.
- Needs Input → answers → subsequent Run request carries explicit answers and new run identity.
- Publish deferred → approve → Published Wiki updated; Record `complete`.
- Publish deferred → deny → Staging retained; Published unchanged; Record `publication_declined`.
- YOLO/auto-approve path publishes without interactive prompt injection.
- Multi-turn history retained across turns in Session (with fake model).

### Host seam tests (extend existing wiki-run style)
- Observer events still ordered and bounded.
- Validation failure never publishes.
- Cancel/fail leaves Published unchanged.
- New Record statuses written and loadable.
- Publication lock fail-closed still holds.
- Reviewer optional model wiring and non-adaptive review invocation (with fakes).
- Compaction capabilities attached for child roles (presence/policy, not LLM summary quality).

### Diagnostics seam tests (extend existing error tests)
- Missing key / OpenAI-style missing credential message is not collapsed to withheld-only.
- Redaction still strips live secret values from messages and Session projections.
- Preflight fails fast with actionable text.

### Prior art in this repo
- Wiki Run application tests with observer lists and temp directories for Staging/Published.
- TUI projection tests over synthetic Wiki Run events (no real TTY).
- Error/redaction unit tests for validation and safe messages.
- Adaptive orchestration tests for reviewer roster and receipts.

### TTY
- Keep a thin non-TTY rejection or print-mode test; do not require pseudo-TTY for the bulk of coverage.

## Out of Scope

- Multi-model reviewer ensemble / voting.
- Live browser run dashboard or SPA as the primary operator surface (optional later clients via official web/AG-UI/ACP are not required to close this spec).
- Resuming a partial Semantic Workflow, partial receipts, or treating Staging as Published.
- YOLO or any mode that disables Host validation, read-only mounts, or publication locks.
- Replacing Producer Skill / Host Instructions architecture.
- Claim ledger / knowledge graph product (ADR 0008).
- Desktop installers and multi-platform signed binaries as a hard acceptance bar (installable entry via existing Python packaging path is enough unless already standard in-repo).
- Rewriting adaptive topology policy beyond wiring review/compaction/publish gates.

## Further Notes

- Implementation tickets (vertical slices, approved `/to-tickets`): `issues/01`–`07`. Frontier: **01, 02, 05** in parallel; then **03, 04** (after 02); then **06** (after 01–05); then **07** (after 06).
- Domain language must stay aligned with CONTEXT.md: Operator Session, Wiki Run, Wiki Reviewer, Staging Wiki, Published Wiki, Manual Retry Run, Wiki Run Record.
- When framework behavior already defines usage accounting for summarization compaction, do not “fix” it by excluding those tokens from limits.
- If a conflict appears between Session UX and Host safety, Host safety wins.
